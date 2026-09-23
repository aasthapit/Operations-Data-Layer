import { beforeEach, describe, expect, it } from "vitest";
import {
  AGGREGATES, BASE_ALIAS, JOIN_TABLE, TREND_EXAMPLES, aggAlias, aggNeedsColumn, aggNumericOnly,
  availableColumns, buildSql, canJoinClusters, clampLimit, clusterContextDefaults,
  clusterContextOn, decodeState, defaultAggAlias, defaultColumns, defaultSorts, defaultState,
  emptyGroup, encodeState, ident, kindOf, lit, loadSaved, maxRowsOf, normalizeState, num,
  operatorInput, operatorLabel, operatorsFor, pruneState, sameState, sortableColumns,
  stateForTable, storeSaved, tableOf, toCsv, toObjects,
} from "./builder";
import type { BuilderState, Filter } from "./builder";
import { QUERY_SCHEMA } from "../test/fixtures/platform";

const schema = QUERY_SCHEMA;
const state = (table = "clusters", over: Partial<BuilderState> = {}): BuilderState =>
  ({ ...stateForTable(schema, table), ...over });

describe("kindOf", () => {
  it("maps the DuckDB types the schema declares onto the four builder kinds", () => {
    expect(kindOf("VARCHAR")).toBe("text");
    expect(kindOf("BIGINT")).toBe("number");
    expect(kindOf("BOOLEAN")).toBe("bool");
    expect(kindOf("TIMESTAMP WITH TIME ZONE")).toBe("time");
    expect(kindOf("DATE")).toBe("time");
    expect(kindOf("JSON")).toBe("json");
    expect(kindOf(undefined)).toBe("text");
  });
});

describe("operators", () => {
  it("offers each kind only the operators it can answer", () => {
    expect(operatorsFor("bool").map(([id]) => id))
      .toEqual(["istrue", "isfalse", "isnull", "notnull"]);
    expect(operatorsFor("time").map(([id]) => id))
      .toEqual(["before", "after", "last_days", "isnull", "notnull"]);
    expect(operatorsFor("json").map(([id]) => id)).toEqual(["contains", "isnull", "notnull"]);
    expect(operatorsFor("unknown kind")).toEqual(operatorsFor("text"));
  });

  it("labels an operator, falling back to its id", () => {
    expect(operatorLabel("last_days")).toBe("within last N days");
    expect(operatorLabel("nope")).toBe("nope");
  });

  it("says how many inputs an operator needs and what each should look like", () => {
    expect(operatorInput("number", "between")).toEqual({ args: 2, type: "number" });
    expect(operatorInput("text", "eq")).toEqual({ args: 1, type: "text" });
    expect(operatorInput("time", "before")).toEqual({ args: 1, type: "date" });
    expect(operatorInput("text", "in")).toEqual({ args: 1, type: "list" });
    expect(operatorInput("bool", "istrue")).toEqual({ args: 0, type: null });
    expect(operatorInput("text", "nope")).toEqual({ args: 0, type: null });
  });
});

describe("identifiers and literals", () => {
  it("always quotes an identifier, so a reserved word is still a column", () => {
    expect(ident("key")).toBe('"key"');
    expect(ident('odd"name')).toBe('"odd""name"');
  });

  it("doubles the quotes inside a literal, so nothing escapes it", () => {
    expect(lit("hub-east")).toBe("'hub-east'");
    expect(lit("o'brien'); DROP TABLE clusters--")).toBe("'o''brien''); DROP TABLE clusters--'");
  });

  it("answers null for anything that is not a number", () => {
    expect(num("4.5")).toBe("4.5");
    expect(num(" 7 ")).toBe("7");
    expect(num("")).toBeNull();
    expect(num("many")).toBeNull();
    expect(num(undefined)).toBeNull();
  });
});

describe("schema helpers", () => {
  it("finds a table and answers null for one this snapshot does not have", () => {
    expect(tableOf(schema, "clusters")?.name).toBe("clusters");
    expect(tableOf(schema, "pods")).toBeNull();
    expect(tableOf(null, "clusters")).toBeNull();
  });

  it("reads the row cap off the schema and falls back when it says nothing", () => {
    expect(maxRowsOf(schema)).toBe(500);
    expect(maxRowsOf({})).toBe(500);
    expect(maxRowsOf({ limits: { max_rows: 2000 } })).toBe(2000);
  });

  it("clamps a limit to the cap, and a nonsense limit to a usable default", () => {
    expect(clampLimit(50, schema)).toBe(50);
    expect(clampLimit(5000, schema)).toBe(500);
    expect(clampLimit(0, schema)).toBe(200);
    expect(clampLimit("lots", schema)).toBe(200);
    expect(clampLimit(1000, { limits: { max_rows: 100 } })).toBe(100);
  });

  it("offers the cluster join only for a table that carries a cluster_name", () => {
    expect(canJoinClusters(schema, "pod_issues")).toBe(true);
    expect(canJoinClusters(schema, "hubs")).toBe(false);
    expect(canJoinClusters(schema, JOIN_TABLE)).toBe(false);
    expect(canJoinClusters(schema, "")).toBe(false);
  });

  it("reports the join as off for a table that cannot have it, whatever the state says", () => {
    expect(clusterContextOn(schema, state("hubs", { clusterContext: true }))).toBe(false);
    expect(clusterContextOn(schema, state("pod_issues", { clusterContext: true }))).toBe(true);
  });
});

describe("availableColumns", () => {
  it("lists the base table's own columns with the expressions they compile to", () => {
    const columns = availableColumns(schema, state("pod_issues"));
    expect(columns.map((c) => c.id))
      .toEqual(["cluster_name", "namespace", "name", "reason", "restarts", "started_at"]);
    expect(columns[0].expr).toBe(`${BASE_ALIAS}."cluster_name"`);
    expect(columns[0].source).toBe("base");
  });

  it("adds the joined cluster columns under a prefix, leaving out clusters.name", () => {
    const columns = availableColumns(schema, state("pod_issues", { clusterContext: true }));
    const cluster = columns.filter((c) => c.source === "cluster").map((c) => c.id);
    expect(cluster).toContain("cluster_hub_name");
    expect(cluster).not.toContain("cluster_name");     // that is the base table's own column
    expect(columns.find((c) => c.id === "cluster_hub_name")?.expr).toBe('c."hub_name"');
  });

  it("answers nothing for a table this snapshot does not have", () => {
    expect(availableColumns(schema, state("clusters", { table: "pods" }))).toEqual([]);
  });

  it("names the five cluster facts worth carrying, and only the ones on offer", () => {
    const joined = state("pod_issues", { clusterContext: true });
    expect(clusterContextDefaults(schema, joined))
      .toEqual(["cluster_hub_name", "cluster_region", "cluster_environment",
        "cluster_ocp_version", "cluster_overall_status"]);
    expect(clusterContextDefaults(schema, state("pod_issues"))).toEqual([]);
  });
});

describe("defaults", () => {
  it("opens a known table on the columns people came for", () => {
    expect(defaultColumns(schema, "clusters"))
      .toEqual(["name", "hub_name", "region", "environment", "ocp_version", "overall_status",
        "nodes_total", "last_synced"]);
  });

  it("falls back to the first columns of a table it has no opinion about", () => {
    expect(defaultColumns(schema, "hubs"))
      .toEqual(["name", "region", "managed_count", "reachable"]);
    expect(defaultColumns(schema, "pods")).toEqual([]);
  });

  it("sorts by the first chosen column unless the table has a better default", () => {
    expect(defaultSorts(schema, "clusters")).toEqual([{ column: "name", dir: "asc" }]);
    expect(defaultSorts(schema, "pods")).toEqual([]);
  });

  it("opens the page on clusters when the snapshot has them", () => {
    expect(defaultState(schema).table).toBe("clusters");
    expect(defaultState({ tables: [{ name: "hubs", columns: [] }] }).table).toBe("hubs");
    expect(defaultState({}).table).toBe("");
  });

  it("starts a table's state runnable: columns chosen, a sort, and a limit in range", () => {
    const fresh = stateForTable(schema, "clusters", { limit: 9000 });
    expect(fresh.mode).toBe("builder");
    expect(fresh.limit).toBe(500);
    expect(fresh.group).toEqual(emptyGroup());
    expect(fresh.chart.type).toBe("auto");
  });
});

describe("buildSql", () => {
  it("writes a plain select in schema order, whatever order the user clicked in", () => {
    const { sql, problems } = buildSql(schema,
      state("clusters", { columns: ["overall_status", "name"], sorts: [] }));
    expect(problems).toEqual([]);
    expect(sql).toBe([
      "SELECT",
      '  t."name" AS "name",',
      '  t."overall_status" AS "overall_status"',
      'FROM "clusters" AS t',
      "LIMIT 200",
    ].join("\n"));
  });

  it("says what is missing rather than writing a query that cannot run", () => {
    expect(buildSql(schema, state("clusters", { table: "pods" })).problems).toEqual(["Pick a data set."]);
    expect(buildSql(schema, state("clusters", { columns: [] })).problems)
      .toEqual(["Choose at least one column."]);
  });

  it("writes the cluster join when the context is on", () => {
    const { sql } = buildSql(schema, state("pod_issues", {
      clusterContext: true, columns: ["name", "cluster_hub_name"], sorts: [],
    }));
    expect(sql).toContain('LEFT JOIN "clusters" AS c ON c."name" = t."cluster_name"');
    expect(sql).toContain('c."hub_name" AS "cluster_hub_name"');
  });

  it("disambiguates two output columns that would land on the same alias", () => {
    // A grouped query can name the same column twice: min and max of restarts.
    const { sql } = buildSql(schema, state("pod_issues", {
      group: { enabled: true, by: [],
        aggs: [{ id: "a1", fn: "min", column: "restarts", alias: "restarts" },
          { id: "a2", fn: "max", column: "restarts", alias: "restarts" }] },
      sorts: [],
    }));
    expect(sql).toContain('AS "restarts"');
    expect(sql).toContain('AS "restarts_2"');
  });

  it("writes DISTINCT and the row limit the state carries", () => {
    const { sql } = buildSql(schema,
      state("clusters", { columns: ["region"], distinct: true, limit: 25, sorts: [] }));
    expect(sql.startsWith("SELECT DISTINCT")).toBe(true);
    expect(sql.endsWith("LIMIT 25")).toBe(true);
  });

  it("joins several filters with the chosen connective", () => {
    const filters: Filter[] = [
      { id: "f1", column: "region", op: "eq", value: "us-east-1", value2: "" },
      { id: "f2", column: "environment", op: "eq", value: "prod", value2: "" },
    ];
    expect(buildSql(schema, state("clusters", { filters, sorts: [] })).sql)
      .toContain('WHERE t."region" = \'us-east-1\'\n  AND t."environment" = \'prod\'');
    expect(buildSql(schema, state("clusters", { filters, filterJoin: "OR", sorts: [] })).sql)
      .toContain("\n   OR ");
  });

  it("sorts on an output alias where there is one, and on the expression otherwise", () => {
    const withAlias = buildSql(schema, state("clusters",
      { columns: ["name"], sorts: [{ column: "name", dir: "desc" }] }));
    expect(withAlias.sql).toContain('ORDER BY "name" DESC');

    const offOutput = buildSql(schema, state("clusters",
      { columns: ["name"], sorts: [{ column: "health_score", dir: "asc" }] }));
    expect(offOutput.sql).toContain('ORDER BY t."health_score" ASC');
    expect(offOutput.problems).toEqual([]);
  });

  it("refuses to sort off the output once grouping or DISTINCT restricts it", () => {
    const { problems } = buildSql(schema, state("clusters", {
      columns: ["name"], distinct: true, sorts: [{ column: "health_score", dir: "asc" }],
    }));
    expect(problems).toEqual(['Sort 1: "health_score" is not one of the output columns.']);
  });

  it("writes a GROUP BY with its aggregates and sorts by the aggregate's alias", () => {
    const { sql, output } = buildSql(schema, state("clusters", {
      group: { enabled: true, by: ["hub_name"],
        aggs: [{ id: "a1", fn: "count", column: "", alias: "" },
          { id: "a2", fn: "avg", column: "health_score", alias: "" }] },
      sorts: [{ column: "rows", dir: "desc" }],
    }));
    expect(sql).toContain("count(*) AS \"rows\"");
    expect(sql).toContain('avg(t."health_score") AS "avg_health_score"');
    expect(sql).toContain('GROUP BY t."hub_name"');
    expect(sql).toContain('ORDER BY "rows" DESC');
    expect(output).toEqual(["hub_name", "rows", "avg_health_score"]);
  });

  it("counts distinct values of a column", () => {
    const { sql } = buildSql(schema, state("clusters", {
      group: { enabled: true, by: [],
        aggs: [{ id: "a1", fn: "count_distinct", column: "region", alias: "" }] },
      sorts: [],
    }));
    expect(sql).toContain('count(DISTINCT t."region") AS "distinct_region"');
  });

  it("names the aggregate that has no column to work on", () => {
    const { problems } = buildSql(schema, state("clusters", {
      group: { enabled: true, by: ["hub_name"],
        aggs: [{ id: "a1", fn: "avg", column: "", alias: "" }] },
      sorts: [],
    }));
    expect(problems).toContain("Aggregate 1: pick a column for avg.");
  });

  it("refuses a group with neither a column to group by nor an aggregate", () => {
    const { problems } = buildSql(schema, state("clusters", {
      group: { enabled: true, by: [], aggs: [] }, sorts: [],
    }));
    expect(problems).toContain("Add a group-by column or an aggregate.");
  });

  it("names the filter that is not finished rather than writing half a condition", () => {
    // The last case names an operator this build does not have, so the entries
    // are plain string maps rather than Filters and are cast at the use site.
    const cases: Array<[Record<string, string>, string]> = [
      [{ column: "", op: "eq", value: "" }, "Filter 1: pick a column."],
      [{ column: "gone", op: "eq", value: "x" }, 'Filter 1: "gone" is not in this data set.'],
      [{ column: "region", op: "eq", value: "  " }, "Filter 1: enter a value."],
      [{ column: "health_score", op: "eq", value: "high" }, 'Filter 1: "high" is not a number.'],
      [{ column: "health_score", op: "between", value: "1", value2: "x" },
        'Filter 1: "x" is not a number.'],
      [{ column: "name", op: "in", value: " , " }, "Filter 1: the list is empty."],
      [{ column: "last_synced", op: "before", value: "yesterday" },
        "Filter 1: use YYYY-MM-DD or YYYY-MM-DD HH:MM."],
      [{ column: "last_synced", op: "last_days", value: "0" },
        "Filter 1: days must be a whole number above zero."],
      [{ column: "region", op: "nope", value: "x" }, "Filter 1: unknown operator."],
    ];
    cases.forEach(([filter, message]) => {
      const built = buildSql(schema,
        state("clusters", {
          filters: [{ id: "f1", value2: "", ...filter } as unknown as Filter],
          sorts: [],
        }));
      expect(built.problems).toContain(message);
    });
  });

  it("writes each operator the way DuckDB reads it", () => {
    // Every call names a column and an operator; the rest of the filter is
    // whatever the case needs.
    const where = (filter: Pick<Filter, "column" | "op"> & Partial<Filter>) =>
      buildSql(schema, state("clusters", {
        filters: [{ id: "f1", value: "", value2: "", ...filter }], sorts: [],
      })).sql.split("WHERE ")[1].split("\n")[0];

    expect(where({ column: "region", op: "isnull" })).toBe('t."region" IS NULL');
    expect(where({ column: "region", op: "notnull" })).toBe('t."region" IS NOT NULL');
    expect(where({ column: "upgrading", op: "istrue" })).toBe('t."upgrading" IS TRUE');
    expect(where({ column: "upgrading", op: "isfalse" })).toBe('t."upgrading" IS FALSE');
    expect(where({ column: "region", op: "ne", value: "us-east-1" }))
      .toBe('t."region" <> \'us-east-1\'');
    expect(where({ column: "health_score", op: "gte", value: "90" }))
      .toBe('t."health_score" >= 90');
    expect(where({ column: "health_score", op: "between", value: "80", value2: "95" }))
      .toBe('t."health_score" BETWEEN 80 AND 95');
    expect(where({ column: "name", op: "starts", value: "ocp-prod" }))
      .toBe('t."name" ILIKE \'ocp-prod%\'');
    expect(where({ column: "name", op: "in", value: " a , b " }))
      .toBe('t."name" IN (\'a\', \'b\')');
    expect(where({ column: "nodes_total", op: "in", value: "3,6" }))
      .toBe('t."nodes_total" IN (3, 6)');
    expect(where({ column: "last_synced", op: "after", value: "2026-09-20 12:00" }))
      .toBe('t."last_synced" > TIMESTAMP \'2026-09-20 12:00\'');
    expect(where({ column: "last_synced", op: "last_days", value: "7" }))
      .toBe('t."last_synced" >= now() - INTERVAL 7 DAY');
  });

  it("escapes the wildcards a user typed, so they match as text", () => {
    const where = (value: string) => buildSql(schema, state("clusters", {
      filters: [{ id: "f1", column: "name", op: "contains", value, value2: "" }], sorts: [],
    })).sql;
    expect(where("checkout")).toContain("ILIKE '%checkout%'");
    expect(where("50%_off")).toContain("ILIKE '%50\\%\\_off%' ESCAPE '\\'");
  });

  it("casts a JSON column before matching it as text", () => {
    const { sql } = buildSql(schema, state("clusters", {
      filters: [{ id: "f1", column: "labels", op: "contains", value: "payments", value2: "" }],
      sorts: [],
    }));
    expect(sql).toContain('CAST(t."labels" AS VARCHAR) ILIKE');
  });
});

describe("sortableColumns", () => {
  it("offers every column while nothing restricts the sort", () => {
    expect(sortableColumns(schema, state("clusters")).map((c) => c.id))
      .toEqual(availableColumns(schema, state("clusters")).map((c) => c.id));
  });

  it("offers the output columns, aggregates included, once grouping restricts it", () => {
    const grouped = state("clusters", {
      group: { enabled: true, by: ["hub_name"],
        aggs: [{ id: "a1", fn: "count", column: "", alias: "" }] },
    });
    const columns = sortableColumns(schema, grouped);
    expect(columns.map((c) => c.id)).toEqual(["hub_name", "rows"]);
    expect(columns[1]).toMatchObject({ kind: "number", description: "aggregate", expr: '"rows"' });
  });
});

describe("aggregates", () => {
  it("knows which functions need a column and which need a numeric one", () => {
    expect(aggNeedsColumn("count")).toBe(false);
    expect(aggNeedsColumn("sum")).toBe(true);
    expect(aggNumericOnly("sum")).toBe(true);
    expect(aggNumericOnly("min")).toBe(false);
    expect(aggNumericOnly("nope")).toBe(false);
    expect(AGGREGATES.map(([id]) => id))
      .toEqual(["count", "count_distinct", "sum", "avg", "min", "max"]);
  });

  it("names the output column the same way the builder and the sort both read it", () => {
    expect(defaultAggAlias("count", "")).toBe("rows");
    expect(defaultAggAlias("count_distinct", "region")).toBe("distinct_region");
    expect(defaultAggAlias("avg", "health_score")).toBe("avg_health_score");
    expect(defaultAggAlias("avg", "")).toBe("avg");
    expect(aggAlias({ fn: "avg", column: "health_score", alias: "mean" })).toBe("mean");
    expect(aggAlias({ fn: "avg", column: "health_score", alias: "" })).toBe("avg_health_score");
  });
});

describe("normalizeState", () => {
  it("refuses anything that is not a state with a table in it", () => {
    expect(normalizeState(null)).toBeNull();
    expect(normalizeState("clusters")).toBeNull();
    expect(normalizeState({ table: "" })).toBeNull();
  });

  it("repairs a filter and an aggregate whose op or function this build does not know", () => {
    const normalized = normalizeState({
      table: "clusters",
      filters: [{ column: "region", op: "regex", value: 7 }],
      group: { enabled: true, by: ["region"], aggs: [{ fn: "median", column: "health_score" }] },
    });
    expect(normalized?.filters[0]).toEqual({ id: "f0", column: "region", op: "eq", value: "", value2: "" });
    expect(normalized?.group.aggs[0]).toEqual({ id: "a0", fn: "count", column: "health_score", alias: "" });
  });

  it("keeps only the fields it understands and falls back for the rest", () => {
    const normalized = normalizeState({
      table: "clusters", columns: ["name", 7], sorts: [{ column: "name", dir: "sideways" },
        { dir: "asc" }], filterJoin: "XOR", mode: "sideways", limit: "not a number",
      chart: { type: "sankey" },
    });
    expect(normalized?.columns).toEqual(["name"]);
    expect(normalized?.sorts).toEqual([{ column: "name", dir: "asc" }]);
    expect(normalized?.filterJoin).toBe("AND");
    expect(normalized?.mode).toBe("builder");
    expect(normalized?.limit).toBe(200);
    expect(normalized?.chart.type).toBe("auto");
  });

  it("keeps a state that is already in this build's shape", () => {
    const original = state("clusters", { mode: "sql", sql: "SELECT 1", filterJoin: "OR",
      distinct: true, clusterContext: false });
    expect(normalizeState(original)).toMatchObject({ mode: "sql", sql: "SELECT 1",
      filterJoin: "OR", distinct: true });
  });
});

describe("pruneState", () => {
  it("drops a column, filter and sort the current table does not have", () => {
    const stale = state("hubs", {
      columns: ["name", "ocp_version"],
      filters: [{ id: "f1", column: "ocp_version", op: "eq", value: "4.16.7", value2: "" }],
      sorts: [{ column: "ocp_version", dir: "asc" }],
      group: { enabled: false, by: ["ocp_version"],
        aggs: [{ id: "a1", fn: "avg", column: "ocp_version", alias: "" }] },
    });
    const pruned = pruneState(schema, stale);
    expect(pruned.columns).toEqual(["name"]);
    expect(pruned.filters).toEqual([]);
    expect(pruned.sorts).toEqual([]);
    expect(pruned.group.by).toEqual([]);
    expect(pruned.group.aggs).toEqual([]);
  });

  it("drops the joined columns when the cluster context is switched off", () => {
    const joined = state("pod_issues", { clusterContext: false,
      columns: ["name", "cluster_hub_name"] });
    expect(pruneState(schema, joined).columns).toEqual(["name"]);
  });

  it("keeps a filter that has no column yet, because the user is still writing it", () => {
    const half = state("clusters", {
      filters: [{ id: "f1", column: "", op: "eq", value: "", value2: "" }] });
    expect(pruneState(schema, half).filters).toHaveLength(1);
  });

  it("returns the same object when there is nothing to prune", () => {
    const clean = state("clusters");
    expect(pruneState(schema, clean)).toBe(clean);
    const unknownTable = state("clusters", { table: "pods" });
    expect(pruneState(schema, unknownTable)).toBe(unknownTable);
  });

  it("does not touch the limit, which the user may still be typing", () => {
    expect(pruneState(schema, state("clusters", { limit: 9000, columns: ["name", "gone"] })).limit)
      .toBe(9000);
  });

  it("sameState compares by value and survives something it cannot serialise", () => {
    expect(sameState({ a: 1 }, { a: 1 })).toBe(true);
    expect(sameState({ a: 1 }, { a: 2 })).toBe(false);
    // why: a value JSON.stringify cannot walk is the case under test, and
    // TypeScript has no type for "an object that points at itself".
    const cyclic: any = {};
    cyclic.self = cyclic;
    expect(sameState(cyclic, cyclic)).toBe(false);
  });
});

describe("sharing a query", () => {
  it("round-trips a state through the link it is shared as", () => {
    const original = state("clusters", { mode: "sql", sql: "SELECT name FROM clusters" });
    const decoded = decodeState(encodeState(original));
    expect(decoded?.table).toBe("clusters");
    expect(decoded?.sql).toBe("SELECT name FROM clusters");
  });

  it("produces a link that is safe in a query string", () => {
    expect(encodeState(state("clusters"))).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it("survives text that is not a link this build minted", () => {
    expect(decodeState("not base64 at all!!")).toBeNull();
    expect(decodeState("")).toBeNull();
  });

  it("answers an empty string rather than throwing for a state it cannot encode", () => {
    // why: as above - the point of the test is a state that cannot be encoded.
    const cyclic: any = { table: "clusters" };
    cyclic.self = cyclic;
    expect(encodeState(cyclic)).toBe("");
  });
});

describe("saved queries", () => {
  beforeEach(() => window.localStorage.clear());

  it("stores and reads back what the user named", () => {
    const entry = { name: "Prod clusters", savedAt: "2026-09-20T21:00:00+00:00",
      state: state("clusters") };
    expect(storeSaved([entry])).toBe(true);
    const loaded = loadSaved();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe("Prod clusters");
    expect(loaded[0].state.table).toBe("clusters");
  });

  it("returns nothing when there is nothing saved, or what is saved is not a list", () => {
    expect(loadSaved()).toEqual([]);
    window.localStorage.setItem("odl.queries", '{"not": "a list"}');
    expect(loadSaved()).toEqual([]);
    window.localStorage.setItem("odl.queries", "{ not json");
    expect(loadSaved()).toEqual([]);
  });

  it("drops an entry written in an older shape rather than loading half of one", () => {
    window.localStorage.setItem("odl.queries", JSON.stringify([
      { name: "ok", state: { table: "clusters" } },
      { name: "no state" },
      { state: { table: "clusters" } },
      { name: "stateless", state: { noTable: true } },
    ]));
    expect(loadSaved().map((q) => q.name)).toEqual(["ok"]);
  });

  it("keeps at most fifty queries, newest first", () => {
    const many = Array.from({ length: 60 },
      (_, i) => ({ name: `q${i}`, savedAt: null, state: state("clusters") }));
    storeSaved(many);
    expect(loadSaved()).toHaveLength(50);
    expect(loadSaved()[0].name).toBe("q0");
  });
});

describe("exporting a result", () => {
  it("writes CSV with CRLF rows and quotes only the cells that need it", () => {
    const csv = toCsv(["name", "message", "score"], [
      ["ocp-prod-iad-01", 'said "hello", loudly', 97],
      ["ocp-prod-iad-02", null, 74],
    ]);
    expect(csv).toBe([
      "name,message,score",
      'ocp-prod-iad-01,"said ""hello"", loudly",97',
      "ocp-prod-iad-02,,74",
    ].join("\r\n"));
  });

  it("writes an object column as JSON inside the cell", () => {
    expect(toCsv(["labels"], [[{ team: "payments" }]])).toContain('"{""team"":""payments""}"');
  });

  it("turns rows into objects and keeps a duplicate column instead of losing it", () => {
    expect(toObjects(["name", "score"], [["ocp-prod-iad-01", 97]]))
      .toEqual([{ name: "ocp-prod-iad-01", score: 97 }]);
    expect(toObjects(["name", "name"], [["a", "b"]])).toEqual([{ name: "a", name_1: "b" }]);
  });
});

describe("the trend examples", () => {
  it("ships questions with real SQL behind them", () => {
    expect(TREND_EXAMPLES.length).toBeGreaterThan(0);
    TREND_EXAMPLES.forEach((example) => {
      expect(example.question).toBeTruthy();
      expect(example.sql.trim().toUpperCase().startsWith("SELECT")).toBe(true);
    });
  });
});
