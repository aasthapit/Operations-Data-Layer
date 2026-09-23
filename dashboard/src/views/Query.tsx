// The Query page: pick a data set, choose columns, filter, sort, see the rows.
//
// Every control is driven by GET /api/query/schema, so the builder offers
// exactly the tables and columns the running API has - never a hard-coded list.
// The SQL it generates is shown, is editable, and is what runs: the answer and
// the query that produced it are always on screen together.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Alert, Box, Button, Checkbox, Chip, FormControlLabel, IconButton, Link, Paper, Stack,
  TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import { api } from "../api";
import type { ApiError } from "../api";
import type { AskResponse, QueryResult, SnapshotInfo } from "../api/types";
import { useFetch } from "../hooks";
import type { Nav, RouteApi } from "../router";
import {
  Card, Empty, MONO_FONT, Mono, Muted, SectionHead, Tag,
  ErrorBanner, SkeletonLines, SkeletonTable, fmtTime,
} from "../components";
import { TOPBAR_HEIGHT } from "../theme";
import Chart, { inferFields, resolveSpec } from "../Chart";
import ChartControls, { chartNoneText } from "../ChartControls";
import ResultTable from "../ResultTable";
import AddToDashboard from "../dashboards/AddToDashboard";
import {
  AGGREGATES, TREND_EXAMPLES, aggAlias, aggNeedsColumn, aggNumericOnly, availableColumns, buildSql,
  canJoinClusters, clampLimit, clusterContextDefaults, clusterContextOn, decodeState,
  defaultAggAlias, defaultState, encodeState, loadSaved, maxRowsOf, operatorInput, operatorsFor,
  pruneState, sortableColumns, stateForTable, storeSaved, tableOf, toCsv, toObjects,
} from "../query/builder";
import type {
  Aggregate, AggregateFn, BuilderColumn, BuilderState, Filter, FilterOp, Group, QuerySchema,
  SavedQuery, Sort,
} from "../query/builder";
import { download } from "../files";

/** The chart's own vocabulary lives with the chart, so the builder state's own
 * field is what names it here. */
type ChartChoice = BuilderState["chart"];

interface QueryProps {
  nav: Nav;
  route: RouteApi;
}

/** What the "Ask in English" box is doing: the question, the answer, why it is
 * not available on this build, and whether a question is in flight. */
interface AskState {
  question: string;
  answer: AskResponse | null;
  error: ApiError | null;
  /** Set once, when the API says it has no model credentials. */
  unavailable: string;
  busy: boolean;
}

/** One of the ready-made questions: the schema's own examples and the trend
 * queries the builder ships. */
interface Example {
  question: string;
  sql: string;
}

const HASH_PREFIX = "#query=";

// --------------------------------------------------------------------------- //
// browser helpers
// --------------------------------------------------------------------------- //
// A shared query is /query?q=<state>. Links minted before the router put the
// state in the fragment (#query=<state>), and those still open.
function readState(q: string | undefined): BuilderState | null {
  try {
    if (q) return decodeState(q);
    const hash = window.location.hash || "";
    return hash.startsWith(HASH_PREFIX) ? decodeState(hash.slice(HASH_PREFIX.length)) : null;
  } catch {
    return null;
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* no clipboard permission, or an insecure origin - fall back */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
const newId = () => Math.random().toString(36).slice(2, 9);
// The guard re-prints every query it validates, so only a difference that
// survives whitespace is worth showing the user.
const squash = (sql: string | null | undefined) => String(sql || "").replace(/\s+/g, " ").trim();

// Switching into (or out of) an aggregate query can strand a sort on a column
// that is no longer in the output - drop those rather than leave a dead row.
function keepValidSorts(schema: QuerySchema, state: BuilderState): BuilderState {
  const allowed = new Set(sortableColumns(schema, state).map((c) => c.id));
  const sorts = state.sorts.filter((s) => allowed.has(s.column));
  return sorts.length === state.sorts.length ? state : { ...state, sorts };
}

// Turning grouping on with an empty group is a dead end, so it starts from the
// first chosen column and a count(*) - the query people meant nine times in ten.
function startGrouping(state: BuilderState, enabled: boolean): Group {
  if (!enabled) return { ...state.group, enabled: false };
  const by = state.group.by.length ? state.group.by : state.columns.slice(0, 1);
  const aggs: Aggregate[] = state.group.aggs.length
    ? state.group.aggs
    : [{ id: newId(), fn: "count", column: "", alias: "" }];
  return { enabled: true, by, aggs };
}

// --------------------------------------------------------------------------- //
// page
// --------------------------------------------------------------------------- //
export default function Query({ nav, route }: QueryProps) {
  const { data: schema, error: schemaError, loading: schemaLoading } = useFetch(
    () => api.querySchema(), []);

  const [state, setState] = useState<BuilderState | null>(null);   // null until the schema lands
  const [result, setResult] = useState<QueryResult | null>(null);
  const [ranSql, setRanSql] = useState("");
  const [runError, setRunError] = useState<ApiError | null>(null);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState("");              // transient "Copied" style feedback
  const [saved, setSaved] = useState<SavedQuery[]>(() => loadSaved());
  const [saveName, setSaveName] = useState("");
  const [askState, setAskState] = useState<AskState>({ question: "", answer: null, error: null,
    unavailable: "", busy: false });

  const fromUrl = useRef<BuilderState | null>(null);
  const initialised = useRef(false);
  const autoRan = useRef(false);
  if (!initialised.current) {                        // read the link before we rewrite it
    fromUrl.current = readState(route.query.q);
    initialised.current = true;
  }

  // navigate is stable, but the route object is new after every navigation:
  // hold it in a ref so writing the URL does not re-run on unrelated changes.
  const navigate = useRef(route.navigate);
  navigate.current = route.navigate;

  const flash = useCallback((text: string) => {
    setNote(text);
    setTimeout(() => setNote((n) => (n === text ? "" : n)), 1600);
  }, []);

  // --- state lifecycle -----------------------------------------------------
  useEffect(() => {
    if (!schema || state) return;
    const shared = fromUrl.current;
    setState(shared && tableOf(schema, shared.table)
      ? pruneState(schema, shared)
      : defaultState(schema));
  }, [schema, state]);

  // Self-healing: a column that this table (or this join setting) does not have
  // is dropped rather than left dangling in a filter or a sort.
  useEffect(() => {
    if (!schema || !state) return;
    const pruned = pruneState(schema, state);
    if (pruned !== state) setState(pruned);
  }, [schema, state]);

  // The current query lives in the URL, so a query is a link. It replaces
  // rather than pushes: the back button steps off the page, not through every
  // edit of the query.
  useEffect(() => {
    if (!state) return undefined;
    const t = setTimeout(() => {
      const encoded = encodeState(state);
      if (!encoded) return;
      try {
        navigate.current("/query", { q: encoded }, { replace: true });
      } catch {
        /* some embedders block replaceState; the page works without it */
      }
    }, 300);
    return () => clearTimeout(t);
  }, [state]);

  // --- derived -------------------------------------------------------------
  const columns = useMemo(
    () => (schema && state ? availableColumns(schema, state) : []), [schema, state]);
  const built = useMemo(
    () => (schema && state ? buildSql(schema, state) : { sql: "", problems: [], output: [] }),
    [schema, state]);
  // GROUP BY and DISTINCT restrict ORDER BY to the output columns, which is
  // also where the aggregates are: "sort by rows desc" has to be offerable.
  const sortCols = useMemo(
    () => (schema && state ? sortableColumns(schema, state) : []), [schema, state]);
  const custom = state?.mode === "sql";
  const sqlText = custom ? state.sql : built.sql;
  const maxRows = maxRowsOf(schema);

  // The builder state is null until the schema has been read, and every
  // updater below is reachable from a control that is only drawn once it is
  // not - so "no state" is not an update to make, it is nothing to update.
  const patch = useCallback((fields: Partial<BuilderState>) =>
    setState((s) => (s ? { ...s, ...fields } : s)), []);

  const run = useCallback(async (sql: string, limit?: number) => {
    const text = String(sql || "").trim();
    if (!text) return;
    setRunning(true);
    setRunError(null);
    try {
      const res = await api.runSql(text, limit);
      setResult(res);
      setRanSql(text);
    } catch (e) {
      setRunError(e as ApiError);
      setResult(null);
    } finally {
      setRunning(false);
    }
  }, []);

  // In builder mode the limit is already in the SQL; sending it too keeps the
  // guard from lowering it to something else. Custom SQL keeps its own LIMIT.
  const runLimit = state && !custom ? clampLimit(state.limit, schema) : undefined;

  const runCurrent = useCallback(() => {
    if (!state) return;
    run(sqlText, runLimit);
  }, [run, sqlText, runLimit, state]);

  // Ctrl / Cmd + Enter runs from anywhere on the page, including the editor.
  const runRef = useRef(runCurrent);
  runRef.current = runCurrent;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        runRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The page opens on a query that already has an answer.
  useEffect(() => {
    if (!state || autoRan.current || !sqlText) return;
    autoRan.current = true;
    run(sqlText, runLimit);
  }, [state, sqlText, runLimit, run]);

  // --- actions -------------------------------------------------------------
  const setTable = (name: string) => {
    setState((s) => stateForTable(schema, name, { limit: s?.limit }));
    setResult(null);
    setRunError(null);
  };

  const toggleClusterContext = (on: boolean) => {
    setState((s) => {
      if (!s) return s;
      const next = { ...s, clusterContext: on };
      if (!on) return pruneState(schema, next);
      const extra = clusterContextDefaults(schema, next).filter((id) => !s.columns.includes(id));
      return s.group.enabled ? next : { ...next, columns: [...s.columns, ...extra] };
    });
  };

  // Renaming an aggregate renames the output column, and a sort naming the old
  // one would quietly be dropped - so the sort follows the rename.
  const updateAgg = (index: number, fields: Partial<Aggregate>) => setState((s) => {
    if (!s) return s;
    const aggs = s.group.aggs.map((a, j) => (j === index ? { ...a, ...fields } : a));
    const before = aggAlias(s.group.aggs[index]);
    const after = aggAlias(aggs[index]);
    const sorts = before === after
      ? s.sorts
      : s.sorts.map((x) => (x.column === before ? { ...x, column: after } : x));
    return { ...s, group: { ...s.group, aggs }, sorts };
  });

  const toggleColumn = (id: string) => {
    setState((s) => {
      if (!s) return s;
      const has = s.columns.includes(id);
      return { ...s, columns: has ? s.columns.filter((c) => c !== id) : [...s.columns, id] };
    });
  };

  const askQuestion = async () => {
    const question = askState.question.trim();
    if (!question || askState.unavailable) return;
    setAskState((a) => ({ ...a, busy: true, error: null }));
    try {
      const answer = await api.askQuery(question, clampLimit(state?.limit, schema));
      setAskState((a) => ({ ...a, busy: false, answer, error: null }));
      patch({ mode: "sql", sql: answer.sql });
      setResult(answer.result);
      setRanSql(answer.sql);
      setRunError(null);
    } catch (raw) {
      const e = raw as ApiError;
      // 503 is the operator's missing credentials, not the user's mistake: say
      // so once and stop offering the box.
      const unavailable = e.status === 503
        ? (e.message || "the data layer has no model credentials configured.")
        : "";
      // 422 means both generated queries failed; the last one is worth showing.
      // The query plane answers a refusal with {"detail": {...}}, so the SQL it
      // tried is read off the detail rather than parsed out of the message.
      const lastSql = e.status === 422 && e.detail && typeof e.detail === "object"
        ? (e.detail as { sql?: string }).sql : "";
      if (lastSql) patch({ mode: "sql", sql: lastSql });
      setAskState((a) => ({ ...a, busy: false, answer: null,
        error: unavailable ? null : e, unavailable: unavailable || a.unavailable }));
    }
  };

  const loadExample = (example: Example) => {
    patch({ mode: "sql", sql: example.sql });
    setAskState((a) => ({ ...a, answer: null, error: null }));
    run(example.sql);
  };

  const saveQuery = () => {
    const name = saveName.trim();
    if (!name || !state) return;
    const entry = { name, savedAt: new Date().toISOString(), state };
    const next = [entry, ...saved.filter((q) => q.name !== name)];
    setSaved(next);
    setSaveName("");
    flash(storeSaved(next) ? `Saved "${name}"` : "Could not save (storage is unavailable)");
  };

  const loadQuery = (name: string) => {
    const entry = saved.find((q) => q.name === name);
    if (!entry || !schema) return;
    if (!tableOf(schema, entry.state.table)) {
      flash(`"${entry.state.table}" is not in this snapshot`);
      return;
    }
    const restored = pruneState(schema, entry.state);
    setState(restored);
    const sql = restored.mode === "sql" ? restored.sql : buildSql(schema, restored).sql;
    run(sql, restored.mode === "sql" ? undefined : clampLimit(restored.limit, schema));
  };

  const deleteQuery = (name: string) => {
    const next = saved.filter((q) => q.name !== name);
    setSaved(next);
    storeSaved(next);
    flash(`Deleted "${name}"`);
  };

  // --- render --------------------------------------------------------------
  if (schemaError) return <ErrorBanner error={schemaError} />;
  // The whole page is built from the schema, so until it lands there is only
  // the frame - but the frame, at least, is there straight away.
  if (!schema || !state) return schemaLoading ? <QuerySkeleton /> : <ErrorBanner error="No schema." />;

  // An older build answered without a snapshot block, and every read below has
  // its own fallback; the annotation is what keeps those reads off a union.
  const snap: Partial<SnapshotInfo> = schema.snapshot || {};
  const table = tableOf(schema, state.table);

  return (
    <Stack spacing={2}>
      <SectionHead title="Query" description={PAGE_DESCRIPTION}>
        <Muted sx={{ fontSize: 12.5, textAlign: "right" }}>
          snapshot {snap.generation ?? "?"} · built {fmtTime(snap.built_at)}<br />
          {(snap.total_rows ?? 0).toLocaleString()} rows · max {maxRows} per query
        </Muted>
      </SectionHead>

      <AskBox
        state={askState}
        examples={schema.examples || []}
        onChange={(question) => setAskState((a) => ({ ...a, question }))}
        onAsk={askQuestion}
        onExample={loadExample}
        onBuild={() => route.navigate("/generate", { q: askState.question.trim() })}
      />

      <Layout>
        <Rail>
          <Section title="Data set">
            <Picker
              label="Data set"
              hideLabel
              value={state.table}
              onChange={setTable}
              sx={{ width: "100%" }}
            >
              {(schema.tables || []).map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name} ({(snap.rows || {})[t.name] ?? 0})
                </option>
              ))}
            </Picker>
            {table && <Hint>{table.description}</Hint>}
            {/* The tooltip names whatever it is put on, and naming a <label>
                renames the control the label is for - hence the wrapper. */}
            <Tooltip title={canJoinClusters(schema, state.table)
              ? "LEFT JOIN clusters ON clusters.name = cluster_name"
              : "Only for tables with a cluster_name column"}
            >
              <Box component="span" sx={{ display: "block" }}>
                <FormControlLabel
                  disabled={!canJoinClusters(schema, state.table)}
                  control={(
                    <Checkbox
                      checked={clusterContextOn(schema, state)}
                      onChange={(e) => toggleClusterContext(e.target.checked)}
                    />
                  )}
                  label={<>Cluster context <Muted sx={{ fontSize: 10.5 }}>join</Muted></>}
                />
              </Box>
            </Tooltip>
          </Section>

          <Section
            title={state.group.enabled ? "Aggregates" : "Columns"}
            right={state.group.enabled ? null : (
              <>
                <Muted>{state.columns.length}/{columns.length}</Muted>
                <Mini onClick={() => patch({ columns: columns.map((c) => c.id) })}>all</Mini>
                <Mini onClick={() => patch({ columns: [] })}>none</Mini>
              </>
            )}
          >
            <FormControlLabel
              control={(
                <Checkbox
                  checked={state.group.enabled}
                  onChange={(e) => setState((s) => (s ? keepValidSorts(schema,
                    { ...s, group: startGrouping(s, e.target.checked) }) : s))}
                />
              )}
              label="Group rows"
            />

            {state.group.enabled ? (
              <Grouping group={state.group} columns={columns} patch={patch}
                onAggChange={updateAgg} />
            ) : (
              <ColumnPicker columns={columns} selected={state.columns} onToggle={toggleColumn} />
            )}
          </Section>

          <Section
            title="Filters"
            right={state.filters.length > 1 ? (
              <ToggleButtonGroup
                value={state.filterJoin}
                onChange={(_, j: "AND" | "OR" | null) => { if (j) patch({ filterJoin: j }); }}
                sx={{ "& .MuiToggleButton-root": { py: 0.25, px: 1, fontSize: 11.5 } }}
              >
                <ToggleButton value="AND">all of</ToggleButton>
                <ToggleButton value="OR">any of</ToggleButton>
              </ToggleButtonGroup>
            ) : null}
          >
            {state.filters.map((f, i) => (
              <FilterRow
                key={f.id}
                filter={f}
                columns={columns}
                onChange={(next) => patch({
                  filters: state.filters.map((x, j) => (j === i ? next : x)),
                })}
                onRemove={() => patch({ filters: state.filters.filter((_, j) => j !== i) })}
              />
            ))}
            <AddButton
              disabled={!columns.length}
              onClick={() => patch({
                filters: [...state.filters,
                  { id: newId(), column: columns[0]?.id || "", op: "eq", value: "", value2: "" }],
              })}
            >
              filter
            </AddButton>
          </Section>

          <Section title="Sort">
            {state.sorts.map((s, i) => (
              <Row key={`${s.column}-${i}`}>
                <Picker
                  label="Sort column"
                  value={s.column}
                  grow
                  onChange={(v) => patch({
                    sorts: state.sorts.map((x, j) => (j === i ? { ...x, column: v } : x)),
                  })}
                >
                  <ColumnOptions columns={sortCols} />
                </Picker>
                <Picker
                  label="Sort direction"
                  sx={{ minWidth: 118 }}
                  value={s.dir}
                  // The only two options the control offers are the two
                  // directions a sort has.
                  onChange={(v) => patch({
                    sorts: state.sorts.map((x, j) => (j === i ? { ...x, dir: v as Sort["dir"] } : x)),
                  })}
                >
                  <option value="asc">asc</option>
                  <option value="desc">desc</option>
                </Picker>
                <RemoveButton
                  label="Remove sort"
                  onClick={() => patch({ sorts: state.sorts.filter((_, j) => j !== i) })}
                />
              </Row>
            ))}
            <AddButton
              disabled={!sortCols.length}
              onClick={() => patch({
                sorts: [...state.sorts, { column: sortCols[0]?.id || "", dir: "asc" }],
              })}
            >
              sort
            </AddButton>
          </Section>

          <Section title="Options">
            <FormControlLabel
              control={(
                <Checkbox
                  checked={state.distinct}
                  onChange={(e) => setState((s) => (s ? keepValidSorts(schema,
                    { ...s, distinct: e.target.checked }) : s))}
                />
              )}
              label="Distinct rows"
            />
            <Row>
              <TextField
                type="number"
                label={`Row limit (max ${maxRows})`}
                value={state.limit}
                onChange={(e) => patch({ limit: e.target.value })}
                onBlur={(e) => patch({ limit: clampLimit(e.target.value, schema) })}
                slotProps={{ htmlInput: { min: 1, max: maxRows }, inputLabel: { shrink: true } }}
                sx={{ flex: 1 }}
              />
            </Row>
          </Section>

          <Section title="Saved queries">
            {saved.length > 0 ? (
              <Row>
                <Picker label="Load a saved query" value="" grow
                  onChange={(v) => v && loadQuery(v)}>
                  <option value="">load…</option>
                  {saved.map((q) => <option key={q.name} value={q.name}>{q.name}</option>)}
                </Picker>
                <Picker label="Delete a saved query" value="" grow
                  onChange={(v) => v && deleteQuery(v)}>
                  <option value="">delete…</option>
                  {saved.map((q) => <option key={q.name} value={q.name}>{q.name}</option>)}
                </Picker>
              </Row>
            ) : (
              <Hint>Nothing saved yet. Saved queries live in this browser.</Hint>
            )}
            <Row>
              <TextField
                placeholder="name this query"
                aria-label="Name this query"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") saveQuery(); }}
                sx={{ flex: 1, minWidth: 0 }}
              />
              <Button variant="outlined" color="inherit" disabled={!saveName.trim()}
                onClick={saveQuery}>Save</Button>
            </Row>
            {note && <Hint>{note}</Hint>}
          </Section>
        </Rail>

        <Box sx={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 2, minWidth: 0 }}>
          <Card
            title={<>SQL {custom && <Tag>custom SQL</Tag>}</>}
            action={(
              <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: "wrap" }}>
                <Button variant="outlined" color="inherit"
                  onClick={async () => flash(await copyText(sqlText) ? "SQL copied" : "Copy failed")}>
                  Copy
                </Button>
                {custom ? (
                  <Button variant="outlined" color="inherit"
                    onClick={() => patch({ mode: "builder", sql: "" })}>
                    Back to builder
                  </Button>
                ) : (
                  <Button variant="outlined" color="inherit"
                    onClick={() => patch({ mode: "sql", sql: built.sql })}>
                    Edit SQL
                  </Button>
                )}
                <Tooltip title="Run the query (Ctrl / Cmd + Enter)">
                  <span>
                    <Button variant="contained" disabled={running || !sqlText.trim()} onClick={runCurrent}>
                      {running ? "Running…" : "Run"}
                    </Button>
                  </span>
                </Tooltip>
              </Stack>
            )}
          >
            {custom ? (
              <TextField
                multiline
                fullWidth
                value={state.sql}
                onChange={(e) => patch({ sql: e.target.value })}
                minRows={Math.min(20, Math.max(6, state.sql.split("\n").length + 1))}
                slotProps={{ htmlInput: { spellCheck: false, "aria-label": "SQL" } }}
                sx={{ "& .MuiInputBase-root": { fontFamily: MONO_FONT, fontSize: 12.5, lineHeight: 1.55 } }}
              />
            ) : (
              <Sql>{built.sql || "-- nothing to run yet"}</Sql>
            )}

            {!custom && built.problems.length > 0 && (
              <Box component="ul" sx={{ m: "10px 0 0", pl: 2.25, color: "warning.main", fontSize: 12.5 }}>
                {built.problems.map((p, i) => <li key={i}>{p}</li>)}
              </Box>
            )}
            {custom && (
              <Hint>The builder no longer writes this query. &quot;Back to builder&quot; regenerates it.</Hint>
            )}

            {runError && (
              <Alert severity="error" sx={{ mt: 1.5, mb: 0 }}>
                {runError.status === 400 ? "Rejected: " : runError.status === 504 ? "Timed out: " : ""}
                {String(runError.message || runError)}
              </Alert>
            )}

            {result && !runError && (
              <Muted sx={{ display: "block", mt: 1.5, fontSize: 12.5 }}>
                {result.row_count.toLocaleString()} rows · {result.elapsed_ms} ms ·
                {" "}snapshot generation {result.generation}
                {result.truncated && (
                  <Tag tone="critical" sx={{ ml: 1 }}>truncated at {result.row_count}</Tag>
                )}
                {result.sql && squash(result.sql) !== squash(ranSql) && (
                  <Box component="details" sx={{
                    mt: 1, "& summary": { cursor: "pointer", color: "text.secondary" },
                  }}>
                    <summary>SQL that ran</summary>
                    <Sql sx={{ mt: 1 }}>{result.sql}</Sql>
                  </Box>
                )}
              </Muted>
            )}
          </Card>

          <Results
            result={result}
            running={running}
            mode={state.mode}
            table={state.table}
            nav={nav}
            onFlash={flash}
            chart={state.chart}
            onChart={(chart) => patch({ chart })}
            sql={ranSql || sqlText}
            panelTitle={askState.answer ? askState.question : state.table}
            onAdded={(dashboardId) => nav.goDashboard(dashboardId)}
          />
        </Box>
      </Layout>
    </Stack>
  );
}

// --------------------------------------------------------------------------- //
// builder pieces
// --------------------------------------------------------------------------- //
function QuerySkeleton() {
  return (
    <Stack spacing={2}>
      <SectionHead title="Query" description={PAGE_DESCRIPTION} />
      <Layout>
        <Rail><Section title="Data set"><SkeletonLines rows={9} /></Section></Rail>
        <Box sx={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 2, minWidth: 0 }}>
          <Card><SkeletonLines rows={5} /></Card>
          <Card flush><SkeletonTable columns={6} rows={6} /></Card>
        </Box>
      </Layout>
    </Stack>
  );
}

// --------------------------------------------------------------------------- //
// the page's own furniture
// --------------------------------------------------------------------------- //
const PAGE_DESCRIPTION = "Every table the collector fills, queried directly. The builder writes the"
  + " SQL, the SQL is what runs, and both stay on screen.";

/** A left rail of controls that stays put, and the SQL plus the rows it
 * produced filling the rest of the width. Below the breakpoint the rail becomes
 * the first thing on the page and the result follows it. */
function Layout({ children }: { children?: ReactNode }) {
  return (
    <Box sx={{
      display: "grid", gap: 2, alignItems: "start",
      // the second column must be capped, or a wide result table sizes it to
      // its own max-content and the page scrolls sideways
      gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "340px minmax(0, 1fr)" },
    }}>
      {children}
    </Box>
  );
}

function Rail({ children }: { children?: ReactNode }) {
  return (
    <Paper
      component="section"
      aria-label="Query builder"
      sx={{
        p: 0,
        position: { xs: "static", lg: "sticky" },
        top: { lg: `${TOPBAR_HEIGHT + 24}px` },
        maxHeight: { xs: "none", lg: `calc(100vh - ${TOPBAR_HEIGHT + 48}px)` },
        overflow: "auto",
      }}
    >
      {children}
    </Paper>
  );
}

interface SectionProps {
  title: string;
  right?: ReactNode;
  children?: ReactNode;
}

function Section({ title, right, children }: SectionProps) {
  return (
    <Box sx={{ p: "12px 14px", borderBottom: 1, borderColor: "border.soft", "&:last-child": { borderBottom: 0 } }}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1, mb: 1 }}>
        <Typography variant="subtitle2" color="text.secondary">{title}</Typography>
        {right && (
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, flex: "none" }}>{right}</Box>
        )}
      </Box>
      {children}
    </Box>
  );
}

/** A line of guidance under a control. */
function Hint({ children }: { children?: ReactNode }) {
  return <Muted sx={{ display: "block", fontSize: 11.5, mt: 0.75 }}>{children}</Muted>;
}

/** One line of controls inside a section. */
function Row({ children }: { children?: ReactNode }) {
  return (
    <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 0.75, mb: 0.75 }}>
      {children}
    </Box>
  );
}

/** A word-sized button beside a section's title. */
function Mini({ children, onClick }: { children?: ReactNode; onClick: () => void }) {
  return (
    <Button
      variant="outlined"
      color="inherit"
      onClick={onClick}
      sx={{ minWidth: 0, px: 0.875, py: 0.125, fontSize: 11, lineHeight: 1.5 }}
    >
      {children}
    </Button>
  );
}

/** The dashed "+ filter" / "+ sort" button that ends a section. */
function AddButton({ children, disabled, onClick }: {
  children?: ReactNode; disabled?: boolean; onClick: () => void;
}) {
  return (
    <Button
      fullWidth
      disabled={disabled}
      onClick={onClick}
      sx={{
        mt: 0.5, color: "text.secondary", fontSize: 11.5,
        border: 1, borderStyle: "dashed", borderColor: "divider",
        "&:hover": { borderStyle: "dashed", borderColor: "primary.main", color: "text.primary" },
      }}
    >
      + {children}
    </Button>
  );
}

/** The × that takes one row out of a list. Its name says what it removes, so
 * three of them on one page are three different buttons. */
function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tooltip title={label}>
      <IconButton
        aria-label={label}
        onClick={onClick}
        sx={{ flex: "none", border: 1, borderColor: "divider", borderRadius: "6px", p: 0.25 }}
      >
        <CloseIcon sx={{ fontSize: 14 }} />
      </IconButton>
    </Tooltip>
  );
}

/** A block of SQL, as text rather than as a control. */
function Sql({ children, sx }: { children?: ReactNode; sx?: object }) {
  return (
    <Box
      component="pre"
      data-sql=""
      sx={{
        m: 0, p: "12px 14px", bgcolor: "background.default",
        border: 1, borderColor: "border.soft", borderRadius: "8px",
        fontFamily: MONO_FONT, fontSize: 12.5, lineHeight: 1.55,
        whiteSpace: "pre-wrap", wordBreak: "break-word", overflowX: "auto",
        ...sx,
      }}
    >
      {children}
    </Box>
  );
}

interface PickerProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children?: ReactNode;
  /** True when the control should take the width the row has left. */
  grow?: boolean;
  /** True when the section it sits in is already called this, so showing the
   * label again would say the same word twice. The control keeps the name. */
  hideLabel?: boolean;
  sx?: object;
}

/** A native dropdown, named by its own label. The builder's lists are short and
 * there are a dozen of them on one rail, so a native select is what stays
 * legible and quick to operate. */
function Picker({ label, value, onChange, children, grow, hideLabel, sx }: PickerProps) {
  return (
    <TextField
      select
      label={hideLabel ? undefined : label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      slotProps={{
        select: { native: true, ...(hideLabel ? { "aria-label": label } : {}) },
        inputLabel: { shrink: true },
      }}
      sx={{ minWidth: 0, ...(grow ? { flex: "1 1 110px" } : {}), ...sx }}
    >
      {children}
    </TextField>
  );
}

// Base columns first, then the joined cluster columns, both in schema order.
function ColumnOptions({ columns, placeholder }: { columns: BuilderColumn[]; placeholder?: string }) {
  const base = columns.filter((c) => c.source === "base");
  const ctx = columns.filter((c) => c.source === "cluster");
  return (
    <>
      {placeholder && <option value="">{placeholder}</option>}
      {base.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
      {ctx.length > 0 && (
        <optgroup label="Cluster context">
          {ctx.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </optgroup>
      )}
    </>
  );
}

interface ColumnPickerProps {
  columns: BuilderColumn[];
  selected: string[];
  onToggle: (id: string) => void;
}

function ColumnPicker({ columns, selected, onToggle }: ColumnPickerProps) {
  const chosen = new Set(selected);
  const base = columns.filter((c) => c.source === "base");
  const ctx = columns.filter((c) => c.source === "cluster");
  const check = (c: BuilderColumn) => (
    <Tooltip title={c.description || ""} key={c.id}>
      <Box component="span" sx={{ display: "block" }}>
      <FormControlLabel
        control={<Checkbox checked={chosen.has(c.id)} onChange={() => onToggle(c.id)} />}
        label={(
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.875, minWidth: 0 }}>
            <Mono sx={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {c.label}
            </Mono>
            <Muted sx={{ fontSize: 10.5, flex: "none" }}>{c.type}</Muted>
          </Box>
        )}
        sx={{ display: "flex", mr: 0, "& .MuiFormControlLabel-label": { flex: 1, minWidth: 0 } }}
      />
      </Box>
    </Tooltip>
  );
  return (
    <Box sx={{ maxHeight: 260, overflow: "auto", mx: -0.5, px: 0.5 }}>
      {base.map(check)}
      {ctx.length > 0 && <Subhead>Cluster context</Subhead>}
      {ctx.map(check)}
    </Box>
  );
}

/** A caption inside a section, over a group of controls. */
function Subhead({ children }: { children?: ReactNode }) {
  return (
    <Muted sx={{
      display: "block", fontSize: 10.5, textTransform: "uppercase",
      letterSpacing: "0.05em", m: "10px 0 4px",
    }}>
      {children}
    </Muted>
  );
}

interface GroupingProps {
  group: Group;
  columns: BuilderColumn[];
  patch: (fields: Partial<BuilderState>) => void;
  onAggChange: (index: number, fields: Partial<Aggregate>) => void;
}

function Grouping({ group, columns, patch, onAggChange }: GroupingProps) {
  const setGroup = (fields: Partial<Group>) => patch({ group: { ...group, ...fields } });

  return (
    <>
      <Subhead>Group by</Subhead>
      {group.by.map((id, i) => (
        <Row key={`${id}-${i}`}>
          <Picker label="Group by column" value={id} grow
            onChange={(v) => setGroup({ by: group.by.map((x, j) => (j === i ? v : x)) })}>
            <ColumnOptions columns={columns} />
          </Picker>
          <RemoveButton label="Remove group" onClick={() => setGroup({ by: group.by.filter((_, j) => j !== i) })} />
        </Row>
      ))}
      <AddButton disabled={!columns.length}
        onClick={() => setGroup({ by: [...group.by, columns[0]?.id || ""] })}>
        group by
      </AddButton>

      <Subhead>Aggregates</Subhead>
      {group.aggs.map((agg, i) => {
        const usable = aggNumericOnly(agg.fn) ? columns.filter((c) => c.kind === "number") : columns;
        const update = (fields: Partial<Aggregate>) => onAggChange(i, fields);
        return (
          <Box key={agg.id} sx={{ borderLeft: 2, borderColor: "divider", pl: 1, mb: 1.25 }}>
            <Row>
              <Picker label="Aggregate function" value={agg.fn} grow
                onChange={(v) => {
                  // The options are AGGREGATES' own ids.
                  const fn = v as AggregateFn;
                  const column = aggNeedsColumn(fn)
                    ? (usable.some((c) => c.id === agg.column) ? agg.column : "")
                    : "";
                  update({ fn, column, alias: "" });
                }}>
                {AGGREGATES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </Picker>
              {aggNeedsColumn(agg.fn) && (
                <Picker label="Aggregate column" value={agg.column} grow
                  onChange={(v) => update({ column: v, alias: "" })}>
                  <ColumnOptions columns={usable} placeholder="column…" />
                </Picker>
              )}
              <RemoveButton label="Remove aggregate"
                onClick={() => setGroup({ aggs: group.aggs.filter((_, j) => j !== i) })} />
            </Row>
            <TextField
              fullWidth
              value={agg.alias}
              placeholder={`as ${defaultAggAlias(agg.fn, agg.column)}`}
              onChange={(e) => update({ alias: e.target.value })}
              slotProps={{ htmlInput: { "aria-label": "Aggregate name" } }}
            />
          </Box>
        );
      })}
      <AddButton
        onClick={() => setGroup({ aggs: [...group.aggs, { id: newId(), fn: "count", column: "", alias: "" }] })}>
        aggregate
      </AddButton>
    </>
  );
}

interface FilterRowProps {
  filter: Filter;
  columns: BuilderColumn[];
  onChange: (next: Filter) => void;
  onRemove: () => void;
}

function FilterRow({ filter, columns, onChange, onRemove }: FilterRowProps) {
  const col = columns.find((c) => c.id === filter.column);
  const kind = col ? col.kind : "text";
  const ops = operatorsFor(kind);
  const op = ops.some(([id]) => id === filter.op) ? filter.op : ops[0][0];
  const { args, type } = operatorInput(kind, op);

  const changeColumn = (id: string) => {
    const next = columns.find((c) => c.id === id);
    const nextOps = operatorsFor(next ? next.kind : "text");
    const keep = nextOps.some(([o]) => o === filter.op);
    onChange({ ...filter, column: id, op: keep ? filter.op : nextOps[0][0],
      value: keep ? filter.value : "", value2: keep ? filter.value2 : "" });
  };

  const input = (key: "value" | "value2", placeholder: string) => (
    <TextField
      type={type === "date" ? "date" : type === "number" || type === "days" ? "number" : "text"}
      value={filter[key] || ""}
      placeholder={placeholder}
      onChange={(e) => onChange({ ...filter, [key]: e.target.value })}
      slotProps={{
        htmlInput: { "aria-label": "Filter value", min: type === "days" ? 1 : undefined },
      }}
      sx={{ flex: "1 1 110px", minWidth: 0 }}
    />
  );

  return (
    <Box sx={{ borderLeft: 2, borderColor: "divider", pl: 1, mb: 1.25 }}>
      <Row>
        <Picker label="Filter column" value={filter.column} onChange={changeColumn} sx={{ width: "100%" }}>
          <ColumnOptions columns={columns} placeholder="column…" />
        </Picker>
      </Row>
      <Row>
        {/* The options are the operator list built for this column's kind. */}
        <Picker label="Filter operator" value={op} grow
          onChange={(v) => onChange({ ...filter, op: v as FilterOp, value: "", value2: "" })}>
          {ops.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </Picker>
        {args >= 1 && input("value", type === "list" ? "a, b, c" : type === "days" ? "7" : "value")}
        {args >= 2 && input("value2", "and")}
        <RemoveButton label="Remove filter" onClick={onRemove} />
      </Row>
    </Box>
  );
}

// --------------------------------------------------------------------------- //
// ask
// --------------------------------------------------------------------------- //
interface AskBoxProps {
  state: AskState;
  examples: Example[];
  onChange: (question: string) => void;
  onAsk: () => void;
  onExample: (example: Example) => void;
  onBuild: () => void;
}

function AskBox({ state, examples, onChange, onAsk, onExample, onBuild }: AskBoxProps) {
  const disabled = !!state.unavailable || state.busy;
  const answer = state.answer;
  return (
    <Card
      title="Ask in English"
      action={answer && (
        <Tag>
          confidence {Math.round((answer.confidence || 0) * 100)}%
          {answer.attempts > 1 ? ` · ${answer.attempts} attempts` : ""}
        </Tag>
      )}
    >
      <Row>
        <TextField
          placeholder="How many application namespaces per team and environment?"
          value={state.question}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onAsk(); }}
          slotProps={{ htmlInput: { "aria-label": "Ask a question about the fleet" } }}
          sx={{ flex: "1 1 260px", minWidth: 0 }}
        />
        <Button variant="outlined" color="inherit" disabled={disabled || !state.question.trim()}
          onClick={onAsk}>
          {state.busy ? "Asking…" : "Ask"}
        </Button>
      </Row>

      {/* Some questions are a dashboard rather than a row - the same words, and
          the agent composes several panels out of them. */}
      {state.question.trim() && (
        <Hint>
          <Link component="button" type="button" onClick={onBuild}>Build a dashboard from this question</Link>
          {" "}- several panels instead of one answer.
        </Hint>
      )}

      {state.unavailable && (
        <Hint>Not available: {state.unavailable} - the SQL builder below works without it.</Hint>
      )}
      {state.error && (
        <Alert severity="error" sx={{ mt: 1.5, mb: 0 }}>
          {String(state.error.message || state.error)}
        </Alert>
      )}
      {answer && (
        <Box sx={{ mt: 1.5, fontSize: 13 }}>
          <div>{answer.explanation}</div>
          {(answer.assumptions || []).length > 0 && (
            <Box component="ul" sx={{ m: "6px 0 0", pl: 2.25, color: "text.secondary", fontSize: 12.5 }}>
              {answer.assumptions.map((a, i) => <li key={i}>{a}</li>)}
            </Box>
          )}
        </Box>
      )}

      {examples.length > 0 && (
        <ExampleRow label="Examples:">
          {examples.slice(0, 5).map((ex, i) => (
            <Chip key={i} variant="outlined" clickable label={ex.question}
              title="Load this example query" onClick={() => onExample(ex)} sx={EXAMPLE_SX} />
          ))}
        </ExampleRow>
      )}

      {/* History questions, written out as SQL. They run without a model, and
          each one comes back in a shape the chart under the table picks up. */}
      <ExampleRow label="Trends:">
        {TREND_EXAMPLES.map((ex) => (
          <Chip key={ex.question} variant="outlined" clickable label={ex.question}
            title="Run this query - the result charts itself" onClick={() => onExample(ex)} sx={EXAMPLE_SX} />
        ))}
      </ExampleRow>
    </Card>
  );
}

const EXAMPLE_SX = { borderRadius: "5px", fontWeight: 400, fontSize: 11.5, height: "auto", py: 0.5 };

/** A row of ready-made questions, behind the word that says what they are. */
function ExampleRow({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <Box sx={{
      display: "flex", flexWrap: "wrap", alignItems: "center", gap: 0.75, mt: 1.5, fontSize: 12,
    }}>
      <Muted>{label}</Muted>
      {children}
    </Box>
  );
}

// --------------------------------------------------------------------------- //
// results
// --------------------------------------------------------------------------- //
// --------------------------------------------------------------------------- //
// the chart above the table
// --------------------------------------------------------------------------- //
// The shape is inferred from the result - a time axis makes a line, one
// category makes bars, anything else makes no chart at all - and every part of
// that inference is overridable here. The controls sit in one row above the
// chart, and the table below is unchanged: it is still the whole answer.
interface ChartPanelProps {
  result: QueryResult;
  chart: ChartChoice;
  onChange: (chart: ChartChoice) => void;
}

function ChartPanel({ result, chart, onChange }: ChartPanelProps) {
  const fields = useMemo(
    () => inferFields(result.columns, result.column_types, result.rows),
    [result]);
  const spec = useMemo(() => resolveSpec(fields, result.rows, chart), [fields, result.rows, chart]);

  if (!result.row_count) return null;
  const none = chartNoneText(chart);

  return (
    <Box sx={{ p: "2px 18px 16px", borderBottom: 1, borderColor: "border.soft" }}>
      <ChartControls fields={fields} spec={spec} chart={chart} onChange={onChange} />
      {spec ? (
        <Chart fields={fields} rows={result.rows} spec={spec} height={280} />
      ) : none ? (
        <Muted sx={{ display: "block", fontSize: 12.5, p: "2px 0 4px" }}>{none}</Muted>
      ) : null}
    </Box>
  );
}

interface ResultsProps {
  result: QueryResult | null;
  running: boolean;
  /** Which of the two the rows came from: the builder knows what a column is
   * over, custom SQL does not. */
  mode: BuilderState["mode"];
  table: string;
  nav: Nav;
  onFlash: (text: string) => void;
  chart: ChartChoice;
  onChart: (chart: ChartChoice) => void;
  sql: string;
  panelTitle: string;
  onAdded: (dashboardId: string) => void;
}

function Results({ result, running, mode, table, nav, onFlash, chart, onChart, sql, panelTitle, onAdded }: ResultsProps) {
  const [adding, setAdding] = useState(false);

  if (!result) {
    return (
      <Card>
        {running ? <SkeletonLines rows={4} /> : <Empty>Run a query to see rows.</Empty>}
      </Card>
    );
  }

  const csv = () => {
    const ok = download(`odl-query-${stamp()}.csv`, toCsv(result.columns, result.rows),
      "text/csv;charset=utf-8");
    onFlash(ok ? "CSV downloaded" : "Download failed");
  };
  const json = async () => {
    const text = JSON.stringify(toObjects(result.columns, result.rows), null, 2);
    onFlash(await copyText(text) ? `${result.row_count} rows copied as JSON` : "Copy failed");
  };

  return (
    <Card
      flush
      label="Results"
      title={(
        <>
          Results <Muted>{result.row_count.toLocaleString()} rows ·
            {" "}{result.columns.length} columns</Muted>
        </>
      )}
      action={(
        <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: "wrap" }}>
          <Button variant="outlined" color="inherit" disabled={!sql.trim()} onClick={() => setAdding(true)}>
            Add to dashboard
          </Button>
          <Button variant="outlined" color="inherit" disabled={!result.row_count} onClick={csv}>
            Download CSV
          </Button>
          <Button variant="outlined" color="inherit" disabled={!result.row_count} onClick={json}>
            Copy as JSON
          </Button>
        </Stack>
      )}
    >
      <ChartPanel result={result} chart={chart} onChange={onChart} />
      <ResultTable
        id="query.results"
        result={result}
        nav={nav}
        mode={mode}
        table={table}
        dense
        scroll
      />
      {adding && (
        <AddToDashboard
          sql={sql}
          chart={chart}
          defaultTitle={panelTitle}
          onClose={() => setAdding(false)}
          onAdded={(id) => { setAdding(false); onAdded(id); }}
        />
      )}
    </Card>
  );
}
