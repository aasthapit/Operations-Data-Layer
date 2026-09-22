// Builder state -> DuckDB SQL, plus the small state helpers the Query page needs.
//
// Everything here is pure and schema-driven: nothing hard-codes a table or a
// column. The page reads GET /api/query/schema and hands the response in, so a
// column the running API does not have simply is not offered.
//
// Values the user types become SQL literals in exactly one place (`lit`, `num`,
// `likeLiteral`), which is why the view never builds a fragment itself. The
// server-side guard is still the security boundary - this is about producing
// correct SQL, not about trusting the browser.
//
// The one piece of state here that is not about SQL is `chart`: which picture
// the result is drawn as. It rides along so that a shared link and a saved
// query restore the chart the author was looking at, not just its rows. The
// chart's own vocabulary lives with the chart.
import { emptyChart, normalizeChart } from "../Chart";
import type { QuerySchemaResponse } from "../api/types";

// --------------------------------------------------------------------------- //
// the vocabulary
// --------------------------------------------------------------------------- //

// The builder's view of `GET /api/query/schema`. It is deliberately looser than
// `QuerySchemaResponse`: every helper here answers sensibly before the schema
// has arrived, and an API older than this build may not carry every field - so
// what is read is optional and the fallbacks are the documented behaviour.
// `_SchemaIsCompatible` is the compile-time link back to the real response.
export interface SchemaColumn {
  name: string;
  type?: string;
  description?: string | null;
}

export interface SchemaTable {
  name: string;
  description?: string | null;
  columns: SchemaColumn[];
}

export interface QuerySchemaLike {
  tables?: SchemaTable[];
  limits?: { max_rows?: number; timeout_seconds?: number };
}

type _SchemaIsCompatible = QuerySchemaResponse extends QuerySchemaLike ? true : never;

export type QuerySchema = QuerySchemaLike | null | undefined;

/** The four things an operator list can be built from, plus `json`. */
export type ColumnKind = "text" | "number" | "bool" | "time" | "json";

/** One column the builder may reference: a base-table column, or a cluster
 * fact borrowed through the join. `expr` is what goes in the SQL. */
export interface BuilderColumn {
  id: string;
  label: string;
  column: string;
  type: string;
  kind: ColumnKind;
  description: string;
  source: "base" | "cluster";
  expr: string;
}

export type FilterOp = keyof typeof OPS;

export interface Filter {
  id: string;
  column: string;
  op: FilterOp;
  value: string;
  value2: string;
}

export interface Sort {
  column: string;
  dir: "asc" | "desc";
}

export type AggregateFn = "count" | "count_distinct" | "sum" | "avg" | "min" | "max";

export interface Aggregate {
  id: string;
  fn: AggregateFn;
  column: string;
  alias: string;
}

export interface Group {
  enabled: boolean;
  by: string[];
  aggs: Aggregate[];
}

/** Everything the Query page holds: what is being asked, and how it is drawn.
 * It round-trips through a URL and through localStorage, so `normalizeState`
 * is what stands between an old or hand-edited copy and the rest of this file. */
export interface BuilderState {
  v: number;
  table: string;
  clusterContext: boolean;
  columns: string[];
  filters: Filter[];
  filterJoin: "AND" | "OR";
  sorts: Sort[];
  group: Group;
  distinct: boolean;
  /** The row cap. Everything that puts state together (`stateForTable`,
   * `normalizeState`) makes it a number; while the user is editing the box it
   * holds whatever they have typed, which `clampLimit` settles on blur - so the
   * field is honest about both. */
  limit: number | string;
  mode: "builder" | "sql";
  sql: string;
  /** The chart's own vocabulary lives with the chart (`Chart.jsx`). */
  chart: ReturnType<typeof emptyChart>;
}

/** What `buildSql` answers with: the statement, why it is not runnable yet,
 * and the names its columns will come back under. */
export interface BuiltSql {
  sql: string;
  problems: string[];
  output: string[];
}

/** A query the user pressed Save on. */
export interface SavedQuery {
  name: string;
  savedAt: string | null;
  state: BuilderState;
}

export const STATE_VERSION = 1;
export const JOIN_TABLE = "clusters";          // the one join the builder offers
export const CLUSTER_PREFIX = "cluster_";
export const BASE_ALIAS = "t";
export const JOIN_ALIAS = "c";
const SAVED_KEY = "odl.queries";
const MAX_SAVED = 50;

// --------------------------------------------------------------------------- //
// column kinds
// --------------------------------------------------------------------------- //
const NUMBER_TYPES = new Set([
  "INTEGER", "BIGINT", "DOUBLE", "FLOAT", "REAL", "DECIMAL", "SMALLINT", "TINYINT",
  "HUGEINT", "UBIGINT", "UINTEGER", "USMALLINT", "UTINYINT", "NUMERIC",
]);

// The four things an operator list can be built from. `json` is separate from
// `text` because a JSON column has to be cast before it can be matched.
export function kindOf(type: unknown): ColumnKind {
  const t = String(type || "").toUpperCase();
  if (t === "JSON") return "json";
  if (t === "BOOLEAN" || t === "BOOL") return "bool";
  if (t === "TIMESTAMP" || t === "DATE" || t.startsWith("TIMESTAMP")) return "time";
  if (NUMBER_TYPES.has(t)) return "number";
  return "text";
}

// op id -> [label, argument count, input type]
const OPS = {
  eq: ["equals", 1, "value"],
  ne: ["not equals", 1, "value"],
  contains: ["contains", 1, "text"],
  starts: ["starts with", 1, "text"],
  in: ["in list", 1, "list"],
  lt: ["<", 1, "value"],
  lte: ["<=", 1, "value"],
  gt: [">", 1, "value"],
  gte: [">=", 1, "value"],
  between: ["between", 2, "value"],
  istrue: ["is true", 0, null],
  isfalse: ["is false", 0, null],
  before: ["before", 1, "date"],
  after: ["after", 1, "date"],
  last_days: ["within last N days", 1, "days"],
  isnull: ["is null", 0, null],
  notnull: ["is not null", 0, null],
};

const OPS_BY_KIND = {
  text: ["eq", "ne", "contains", "starts", "in", "isnull", "notnull"],
  number: ["eq", "ne", "lt", "lte", "gt", "gte", "between", "isnull", "notnull"],
  bool: ["istrue", "isfalse", "isnull", "notnull"],
  time: ["before", "after", "last_days", "isnull", "notnull"],
  json: ["contains", "isnull", "notnull"],
};

// `kind` is whatever `kindOf` answered, but an older saved query can name a
// kind this build no longer has, so anything unknown falls back to text.
export function operatorsFor(kind: string): Array<[FilterOp, string]> {
  const ops = (OPS_BY_KIND[kind as ColumnKind] || OPS_BY_KIND.text) as FilterOp[];
  return ops.map((id) => [id, OPS[id][0] as string]);
}
export function operatorLabel(op: string): string {
  return OPS[op as FilterOp] ? (OPS[op as FilterOp][0] as string) : op;
}
// How many value inputs this operator needs, and what they should look like.
export function operatorInput(kind: ColumnKind, op: string): { args: number; type: string | null } {
  const spec = OPS[op as FilterOp];
  if (!spec) return { args: 0, type: null };
  const [, args, type] = spec as [string, number, string | null];
  if (type === "value") return { args, type: kind === "number" ? "number" : "text" };
  return { args, type };
}

// --------------------------------------------------------------------------- //
// literals and identifiers
// --------------------------------------------------------------------------- //
// Identifiers are always quoted: it costs three characters in the preview and
// removes every reserved-word question ("key", "status", "count" are all real
// column names in this schema).
export function ident(name: unknown): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

export function lit(value: unknown): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// A number, or null when what the user typed is not one.
export function num(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (text === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? String(n) : null;
}

// A positive integer (for "within last N days" and the row limit).
function positiveInt(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n > 0 ? String(n) : null;
}

// ILIKE pattern: the wildcards the user typed are data, not syntax, so they are
// escaped - and the ESCAPE clause is only added when something needed escaping.
function likeLiteral(value: unknown, wrap: (escaped: string) => string): string {
  const raw = String(value);
  const escaped = raw.replace(/([\\%_])/g, "\\$1");
  const suffix = /[\\%_]/.test(raw) ? " ESCAPE '\\'" : "";
  return `${lit(wrap(escaped))}${suffix}`;
}

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/;

// --------------------------------------------------------------------------- //
// schema helpers
// --------------------------------------------------------------------------- //
export function tableOf(schema: QuerySchema, name: string): SchemaTable | null {
  return (schema?.tables || []).find((t) => t.name === name) || null;
}

export function maxRowsOf(schema: QuerySchema): number {
  const n = Number(schema?.limits?.max_rows);
  return Number.isFinite(n) && n > 0 ? n : 500;
}

export function clampLimit(value: unknown, schema: QuerySchema): number {
  const max = maxRowsOf(schema);
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return Math.min(200, max);
  return Math.min(n, max);
}

// The cluster-context join is offered for any table that carries a cluster_name
// - which is every per-cluster table, and not clusters, hubs or collection_runs.
export function canJoinClusters(schema: QuerySchema, tableName: string): boolean {
  if (!tableName || tableName === JOIN_TABLE) return false;
  const t = tableOf(schema, tableName);
  return !!t && !!tableOf(schema, JOIN_TABLE) && t.columns.some((c) => c.name === "cluster_name");
}

export function clusterContextOn(schema: QuerySchema, state: BuilderState): boolean {
  return !!state.clusterContext && canJoinClusters(schema, state.table);
}

// Every column the builder may reference, in schema order, base table first.
// A cluster-context column is `cluster_<name>`; clusters.name is left out
// because the base table's own cluster_name already carries exactly that value.
export function availableColumns(schema: QuerySchema, state: BuilderState): BuilderColumn[] {
  const table = tableOf(schema, state.table);
  if (!table) return [];
  const out: BuilderColumn[] = table.columns.map((c) => ({
    id: c.name,
    label: c.name,
    column: c.name,
    type: c.type,
    kind: kindOf(c.type),
    description: c.description || "",
    source: "base",
    expr: `${BASE_ALIAS}.${ident(c.name)}`,
  }));
  if (!clusterContextOn(schema, state)) return out;

  const seen = new Set(out.map((c) => c.id));
  for (const c of (tableOf(schema, JOIN_TABLE) as SchemaTable).columns) {
    if (c.name === "name") continue;                       // == base cluster_name
    const id = `${CLUSTER_PREFIX}${c.name}`;
    if (seen.has(id)) continue;                            // never shadow a real column
    seen.add(id);
    out.push({
      id,
      label: id,
      column: c.name,
      type: c.type,
      kind: kindOf(c.type),
      description: c.description || "",
      source: "cluster",
      expr: `${JOIN_ALIAS}.${ident(c.name)}`,
    });
  }
  return out;
}

// --------------------------------------------------------------------------- //
// defaults
// --------------------------------------------------------------------------- //
// Identifying columns first, then the two or three facts people actually came
// for. Anything the running API does not have is dropped, so an older build
// still opens on a sensible set.
const DEFAULT_COLUMNS: Record<string, string[]> = {
  clusters: ["name", "hub_name", "region", "environment", "ocp_version", "overall_status",
    "nodes_total", "pod_issues_total", "last_synced"],
  hubs: ["name", "region", "datacenter", "managed_count", "reachable", "last_synced"],
  cluster_operators: ["cluster_name", "name", "version", "available", "degraded", "message"],
  nodes: ["cluster_name", "name", "roles", "ready", "schedulable", "kubelet_version",
    "cpu_allocatable", "pods_running"],
  namespaces: ["cluster_name", "name", "ns_class", "app_name", "team", "tier", "pods_total",
    "pod_issues"],
  workloads: ["cluster_name", "namespace", "kind", "name", "replicas_desired", "replicas_ready",
    "status"],
  workload_images: ["cluster_name", "namespace", "workload_name", "container", "registry",
    "repository", "tag"],
  workload_refs: ["cluster_name", "namespace", "workload_kind", "workload_name", "ref_kind",
    "ref_name", "via"],
  pod_issues: ["cluster_name", "namespace", "name", "phase", "reason", "restarts", "message"],
  resources: ["cluster_name", "key", "kind", "namespace", "name", "status", "expires_at"],
  resource_status: ["cluster_name", "key", "status", "count", "error"],
  health_checks: ["cluster_name", "name", "title", "status", "severity", "message"],
  health_snapshots: ["cluster_name", "snapshot_at", "overall_status", "health_score",
    "cpu_usage", "memory_usage", "pods_running", "pod_issues"],
  collection_runs: ["id", "started_at", "finished_at", "duration_ms", "clusters_total",
    "clusters_ok", "clusters_failed", "trigger"],
};

// Newest first is the only useful default for the two append-only tables.
const DEFAULT_SORT: Record<string, Sort> = {
  health_snapshots: { column: "snapshot_at", dir: "desc" },
  collection_runs: { column: "started_at", dir: "desc" },
};

export function defaultColumns(schema: QuerySchema, tableName: string): string[] {
  const table = tableOf(schema, tableName);
  if (!table) return [];
  const names = new Set(table.columns.map((c) => c.name));
  const wanted = (DEFAULT_COLUMNS[tableName] || []).filter((n) => names.has(n));
  return wanted.length ? wanted : table.columns.slice(0, 8).map((c) => c.name);
}

export function defaultSorts(schema: QuerySchema, tableName: string): Sort[] {
  const columns = defaultColumns(schema, tableName);
  const preferred = DEFAULT_SORT[tableName];
  if (preferred && columns.includes(preferred.column)) return [{ ...preferred }];
  return columns.length ? [{ column: columns[0], dir: "asc" }] : [];
}

// The five cluster facts worth carrying into a per-cluster table.
const CLUSTER_CONTEXT_DEFAULTS = ["hub_name", "region", "environment", "ocp_version",
  "overall_status"];

export function clusterContextDefaults(schema: QuerySchema, state: BuilderState): string[] {
  const ids = new Set(availableColumns(schema, state).map((c) => c.id));
  return CLUSTER_CONTEXT_DEFAULTS.map((n) => `${CLUSTER_PREFIX}${n}`).filter((id) => ids.has(id));
}

export function emptyGroup(): Group {
  return { enabled: false, by: [], aggs: [] };
}

export function stateForTable(schema: QuerySchema, tableName: string,
  base: Partial<BuilderState> = {}): BuilderState {
  return {
    v: STATE_VERSION,
    table: tableName,
    clusterContext: false,
    columns: defaultColumns(schema, tableName),
    filters: [],
    filterJoin: "AND",
    sorts: defaultSorts(schema, tableName),
    group: emptyGroup(),
    distinct: false,
    limit: clampLimit(base.limit ?? 200, schema),
    mode: "builder",
    sql: "",
    chart: emptyChart(),
  };
}

// The page opens on clusters: the main columns, sorted by name, already run.
export function defaultState(schema: QuerySchema): BuilderState {
  const first = tableOf(schema, "clusters") ? "clusters" : (schema?.tables?.[0]?.name || "");
  return stateForTable(schema, first);
}

// --------------------------------------------------------------------------- //
// ready-made trend queries
// --------------------------------------------------------------------------- //
// The questions people ask of history, written out. They are plain SQL rather
// than builder state because a trend is a date_trunc and a GROUP BY, which the
// builder does not write - and because they then run without needing a model.
// Each one returns a shape the chart reads on its own: a time column plus a
// measure (and often a category, which becomes one line per hub or cluster).
export const TREND_EXAMPLES: Array<{ question: string; sql: string }> = [
  {
    question: "Crash loops per hub per hour, last 24 hours",
    sql: `SELECT date_trunc('hour', s.snapshot_at) AS hour,
       c.hub_name AS hub,
       sum(s.crashloops) AS crashloops
FROM health_snapshots s
JOIN clusters c ON c.name = s.cluster_name
WHERE s.resolution = 'hour'
  AND s.snapshot_at >= now() - INTERVAL 1 DAY
GROUP BY 1, 2
ORDER BY 1, 2`,
  },
  {
    question: "Warning events per day, last 30 days",
    sql: `SELECT date_trunc('day', snapshot_at) AS day,
       sum(warning_events) AS warning_events
FROM health_snapshots
WHERE resolution = 'day'
  AND snapshot_at >= now() - INTERVAL 30 DAY
GROUP BY 1
ORDER BY 1`,
  },
  {
    question: "Which checks fail most often",
    sql: `SELECT title AS check_title,
       count(*) FILTER (WHERE status = 'fail') AS failing,
       count(*) FILTER (WHERE status = 'warn') AS warning
FROM health_checks
WHERE status IN ('fail', 'warn')
GROUP BY 1
ORDER BY failing DESC, warning DESC
LIMIT 12`,
  },
  {
    question: "Version changes in the last 7 days",
    sql: `SELECT date_trunc('day', changed_at) AS day,
       kind,
       count(*) AS changes
FROM changes
WHERE kind LIKE '%version%'
  AND changed_at >= now() - INTERVAL 7 DAY
GROUP BY 1, 2
ORDER BY 1, 2`,
  },
  {
    question: "Top 10 clusters by restarts today",
    sql: `SELECT cluster_name AS cluster,
       max(restarts_total) - min(restarts_total) AS restarts
FROM health_snapshots
WHERE resolution = 'hour'
  AND snapshot_at >= now() - INTERVAL 1 DAY
GROUP BY 1
ORDER BY restarts DESC
LIMIT 10`,
  },
];

// --------------------------------------------------------------------------- //
// normalising untrusted state (a shared link, a saved query, an old format)
// --------------------------------------------------------------------------- //
const asString = (v: unknown): string => (typeof v === "string" ? v : "");
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// why: `raw` is whatever came out of a URL, of localStorage or of an older
// build of this page - untrusted by construction, which is the whole point of
// this function. Every field is read through asString / asArray / a coercion,
// so nothing untyped escapes past the return.
export function normalizeState(raw: any): BuilderState | null {
  if (!raw || typeof raw !== "object") return null;
  const table = asString(raw.table);
  if (!table) return null;
  return {
    v: STATE_VERSION,
    table,
    clusterContext: !!raw.clusterContext,
    columns: asArray(raw.columns).filter((c): c is string => typeof c === "string"),
    filters: asArray(raw.filters).map((f: any, i) => ({
      id: typeof f?.id === "string" ? f.id : `f${i}`,
      column: asString(f?.column),
      op: OPS[asString(f?.op)] ? f.op : "eq",
      value: asString(f?.value),
      value2: asString(f?.value2),
    })),
    filterJoin: raw.filterJoin === "OR" ? "OR" : "AND",
    sorts: asArray(raw.sorts)
      .filter((s: any) => s && typeof s.column === "string")
      .map((s: any): Sort => ({ column: s.column, dir: s.dir === "desc" ? "desc" : "asc" })),
    group: {
      enabled: !!raw.group?.enabled,
      by: asArray(raw.group?.by).filter((c): c is string => typeof c === "string"),
      aggs: asArray(raw.group?.aggs).map((a: any, i) => ({
        id: typeof a?.id === "string" ? a.id : `a${i}`,
        fn: AGG_BY_ID[asString(a?.fn)] ? a.fn : "count",
        column: asString(a?.column),
        alias: asString(a?.alias),
      })),
    },
    distinct: !!raw.distinct,
    limit: Number.isFinite(Number(raw.limit)) ? Number(raw.limit) : 200,
    mode: raw.mode === "sql" ? "sql" : "builder",
    sql: asString(raw.sql),
    // a link minted before charts existed, or one with a chart type this build
    // does not know, simply comes back as Auto
    chart: normalizeChart(raw.chart),
  };
}

// Drop references to columns this table (or this join setting) does not have,
// so switching the data set or turning the join off cannot leave a dangling id.
export function pruneState(schema: QuerySchema, state: BuilderState): BuilderState {
  if (!tableOf(schema, state.table)) return state;
  const ids = new Set(availableColumns(schema, state).map((c) => c.id));
  const keep = (id) => ids.has(id);
  // A sort may name an aggregate ("rows"), which is not a table column, so it
  // is judged against what ORDER BY can actually name for this query.
  const sortable = new Set(sortableColumns(schema, state).map((c) => c.id));
  const next = {
    ...state,
    columns: state.columns.filter(keep),
    filters: state.filters.filter((f) => !f.column || keep(f.column)),
    sorts: state.sorts.filter((s) => sortable.has(s.column)),
    group: {
      ...state.group,
      by: state.group.by.filter(keep),
      aggs: state.group.aggs.filter((a) => !a.column || keep(a.column)),
    },
    // the limit is deliberately not touched here: clamping it on every state
    // change would fight the user while they are typing into the field
  };
  return sameState(next, state) ? state : next;
}

export function sameState(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------- //
// aggregates
// --------------------------------------------------------------------------- //
// id -> [label, needs a column, numeric only]
export const AGGREGATES: Array<[AggregateFn, string, boolean, boolean]> = [
  ["count", "count(*)", false, false],
  ["count_distinct", "count distinct", true, false],
  ["sum", "sum", true, true],
  ["avg", "avg", true, true],
  ["min", "min", true, false],
  ["max", "max", true, false],
];
const AGG_BY_ID = Object.fromEntries(AGGREGATES.map((a) => [a[0], a]));

export function aggNeedsColumn(fn: string): boolean {
  return !!AGG_BY_ID[fn]?.[2];
}
export function aggNumericOnly(fn: string): boolean {
  return !!AGG_BY_ID[fn]?.[3];
}
// What this aggregate is called in the output - the typed alias, or the one the
// builder would have generated. Sorting and pruning both need the same answer.
export function aggAlias(agg: Pick<Aggregate, "fn" | "column" | "alias">): string {
  return agg.alias || defaultAggAlias(agg.fn, agg.column);
}

export function defaultAggAlias(fn: string, column: string): string {
  if (fn === "count") return "rows";
  if (!column) return fn;
  return fn === "count_distinct" ? `distinct_${column}` : `${fn}_${column}`;
}

function aggregateSql(agg: Aggregate, byId: Map<string, BuilderColumn>, problems: string[],
  index: number): { alias: string; sql: string } | null {
  if (agg.fn === "count") {
    return { alias: agg.alias || "rows", sql: "count(*)" };
  }
  const col = agg.column ? byId.get(agg.column) : null;
  if (!col) {
    problems.push(`Aggregate ${index}: pick a column for ${agg.fn}.`);
    return null;
  }
  const alias = aggAlias(agg);
  if (agg.fn === "count_distinct") return { alias, sql: `count(DISTINCT ${col.expr})` };
  return { alias, sql: `${agg.fn}(${col.expr})` };
}

// --------------------------------------------------------------------------- //
// WHERE
// --------------------------------------------------------------------------- //
function conditionSql(col: BuilderColumn, filter: Filter, problems: string[],
  index: number): string | null {
  const { op } = filter;
  const e = col.expr;
  const needValue = (v: unknown) => {
    if (String(v ?? "").trim() === "") {
      problems.push(`Filter ${index}: enter a value.`);
      return false;
    }
    return true;
  };
  const numberOr = (v: unknown) => {
    const n = num(v);
    if (n === null) problems.push(`Filter ${index}: "${v}" is not a number.`);
    return n;
  };
  const scalar = (v: unknown) => (col.kind === "number" ? numberOr(v) : lit(v));

  switch (op) {
    case "isnull": return `${e} IS NULL`;
    case "notnull": return `${e} IS NOT NULL`;
    case "istrue": return `${e} IS TRUE`;
    case "isfalse": return `${e} IS FALSE`;

    case "eq": case "ne": case "lt": case "lte": case "gt": case "gte": {
      if (!needValue(filter.value)) return null;
      const v = scalar(filter.value);
      if (v === null) return null;
      const sign = { eq: "=", ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" }[
        op as "eq" | "ne" | "lt" | "lte" | "gt" | "gte"];
      return `${e} ${sign} ${v}`;
    }

    case "between": {
      if (!needValue(filter.value) || !needValue(filter.value2)) return null;
      const lo = numberOr(filter.value);
      const hi = numberOr(filter.value2);
      if (lo === null || hi === null) return null;
      return `${e} BETWEEN ${lo} AND ${hi}`;
    }

    case "contains": {
      if (!needValue(filter.value)) return null;
      const target = col.kind === "json" ? `CAST(${e} AS VARCHAR)` : e;
      return `${target} ILIKE ${likeLiteral(filter.value, (s) => `%${s}%`)}`;
    }

    case "starts": {
      if (!needValue(filter.value)) return null;
      return `${e} ILIKE ${likeLiteral(filter.value, (s) => `${s}%`)}`;
    }

    case "in": {
      if (!needValue(filter.value)) return null;
      const items = String(filter.value).split(",").map((s) => s.trim()).filter(Boolean);
      if (!items.length) {
        problems.push(`Filter ${index}: the list is empty.`);
        return null;
      }
      const values = col.kind === "number" ? items.map(numberOr) : items.map(lit);
      if (values.some((v) => v === null)) return null;
      return `${e} IN (${values.join(", ")})`;
    }

    case "before": case "after": {
      if (!needValue(filter.value)) return null;
      const text = String(filter.value).trim();
      if (!TIMESTAMP_RE.test(text)) {
        problems.push(`Filter ${index}: use YYYY-MM-DD or YYYY-MM-DD HH:MM.`);
        return null;
      }
      return `${e} ${op === "before" ? "<" : ">"} TIMESTAMP ${lit(text)}`;
    }

    case "last_days": {
      if (!needValue(filter.value)) return null;
      const days = positiveInt(filter.value);
      if (days === null) {
        problems.push(`Filter ${index}: days must be a whole number above zero.`);
        return null;
      }
      return `${e} >= now() - INTERVAL ${days} DAY`;
    }

    default:
      problems.push(`Filter ${index}: unknown operator.`);
      return null;
  }
}

// --------------------------------------------------------------------------- //
// the generator
// --------------------------------------------------------------------------- //
export function buildSql(schema: QuerySchema, state: BuilderState): BuiltSql {
  const problems: string[] = [];
  const table = tableOf(schema, state.table);
  if (!table) return { sql: "", problems: ["Pick a data set."], output: [] };

  const columns = availableColumns(schema, state);
  const byId = new Map(columns.map((c) => [c.id, c]));
  const joined = clusterContextOn(schema, state);
  const grouping = !!state.group.enabled;

  // --- SELECT ---
  const select: Array<{ alias: string; sql: string }> = [];
  const taken = new Set<string>();
  const push = (entry: { alias: string; sql: string } | null) => {
    if (!entry) return;
    let alias = entry.alias;
    if (taken.has(alias)) {
      let n = 2;
      while (taken.has(`${alias}_${n}`)) n += 1;
      alias = `${alias}_${n}`;
    }
    taken.add(alias);
    select.push({ alias, sql: `${entry.sql} AS ${ident(alias)}` });
  };

  if (grouping) {
    for (const id of state.group.by) {
      const col = byId.get(id);
      if (col) push({ alias: col.id, sql: col.expr });
    }
    state.group.aggs.forEach((agg, i) => push(aggregateSql(agg, byId, problems, i + 1)));
    if (!select.length) problems.push("Add a group-by column or an aggregate.");
  } else {
    // Schema order, not click order: the same set of columns always produces
    // the same query, and the result reads like the table does.
    const chosen = new Set(state.columns);
    for (const col of columns) {
      if (chosen.has(col.id)) push({ alias: col.id, sql: col.expr });
    }
    if (!select.length) problems.push("Choose at least one column.");
  }

  // --- WHERE ---
  const conditions: string[] = [];
  state.filters.forEach((f, i) => {
    if (!f.column) {
      problems.push(`Filter ${i + 1}: pick a column.`);
      return;
    }
    const col = byId.get(f.column);
    if (!col) {
      problems.push(`Filter ${i + 1}: "${f.column}" is not in this data set.`);
      return;
    }
    const cond = conditionSql(col, f, problems, i + 1);
    if (cond) conditions.push(cond);
  });

  // --- ORDER BY ---
  // DuckDB resolves an output alias before a table column, so sorting on
  // something that is selected always means the column on screen. Sorting on a
  // column that is not in the output is only legal without GROUP BY / DISTINCT.
  const selected = new Set(select.map((s) => s.alias));
  const restricted = grouping || state.distinct;
  const order: string[] = [];
  state.sorts.forEach((s, i) => {
    const dir = s.dir === "desc" ? "DESC" : "ASC";
    if (selected.has(s.column)) {
      order.push(`${ident(s.column)} ${dir}`);
      return;
    }
    const col = byId.get(s.column);
    if (col && !restricted) order.push(`${col.expr} ${dir}`);
    else problems.push(`Sort ${i + 1}: "${s.column}" is not one of the output columns.`);
  });

  const output = select.map((s) => s.alias);
  if (!select.length) return { sql: "", problems, output };

  // --- assemble ---
  const lines: string[] = [];
  lines.push(`SELECT${state.distinct ? " DISTINCT" : ""}`);
  lines.push(select.map((s) => `  ${s.sql}`).join(",\n"));
  lines.push(`FROM ${ident(table.name)} AS ${BASE_ALIAS}`);
  if (joined) {
    lines.push(`LEFT JOIN ${ident(JOIN_TABLE)} AS ${JOIN_ALIAS}`
      + ` ON ${JOIN_ALIAS}.${ident("name")} = ${BASE_ALIAS}.${ident("cluster_name")}`);
  }
  if (conditions.length) {
    const joiner = state.filterJoin === "OR" ? "\n   OR " : "\n  AND ";
    lines.push(`WHERE ${conditions.join(joiner)}`);
  }
  if (grouping && state.group.by.length) {
    lines.push(`GROUP BY ${state.group.by
      .map((id) => (byId.get(id) as BuilderColumn).expr).join(", ")}`);
  }
  if (order.length) lines.push(`ORDER BY ${order.join(", ")}`);
  lines.push(`LIMIT ${clampLimit(state.limit, schema)}`);

  return { sql: lines.join("\n"), problems, output };
}

// What the Sort list may offer. GROUP BY and DISTINCT restrict ORDER BY to the
// output, which is also where an aggregate ("rows", "avg_cpu_usage") lives - and
// sorting by the aggregate is usually the point of grouping.
export function sortableColumns(schema: QuerySchema, state: BuilderState): BuilderColumn[] {
  const columns = availableColumns(schema, state);
  if (!state.group.enabled && !state.distinct) return columns;
  const byId = new Map(columns.map((c) => [c.id, c]));
  return buildSql(schema, state).output.map((alias) => byId.get(alias)
    || { id: alias, label: alias, column: alias, type: "", kind: "number",
         description: "aggregate", source: "base", expr: ident(alias) });
}

// --------------------------------------------------------------------------- //
// sharing and saving
// --------------------------------------------------------------------------- //
export function encodeState(state: BuilderState): string {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(state));
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch {
    return "";
  }
}

export function decodeState(text: unknown): BuilderState | null {
  try {
    const padded = String(text).replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return normalizeState(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;                        // a truncated or hand-edited link
  }
}

export function loadSaved(): SavedQuery[] {
  try {
    const raw = window.localStorage.getItem(SAVED_KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list
      .filter((q: any) => q && typeof q.name === "string" && q.state)
      .map((q: any) => ({ name: q.name, savedAt: q.savedAt || null, state: normalizeState(q.state) }))
      .filter((q): q is SavedQuery => !!q.state);   // an entry from an older shape is dropped
  } catch {
    return [];                          // storage disabled, or somebody else's key
  }
}

export function storeSaved(list: SavedQuery[]): boolean {
  try {
    window.localStorage.setItem(SAVED_KEY, JSON.stringify(list.slice(0, MAX_SAVED)));
    return true;
  } catch {
    return false;                       // quota or private mode: saving is a bonus
  }
}

// --------------------------------------------------------------------------- //
// results
// --------------------------------------------------------------------------- //
// A cell can be an object: DuckDB's JSON columns come back as one, and the CSV
// carries the JSON text rather than "[object Object]".
export function toCsv(columns: string[], rows: unknown[][]): string {
  const cell = (v: unknown) => {
    if (v == null) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns, ...rows].map((row) => row.map(cell).join(",")).join("\r\n");
}

export function toObjects(columns: string[], rows: unknown[][]): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    columns.forEach((name, i) => {
      // duplicate column names in one result would otherwise silently collapse
      const key = out[name] === undefined ? name : `${name}_${i}`;
      out[key] = row[i];
    });
    return out;
  });
}
