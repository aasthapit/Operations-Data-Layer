// The Query page: pick a data set, choose columns, filter, sort, see the rows.
//
// Every control is driven by GET /api/query/schema, so the builder offers
// exactly the tables and columns the running API has - never a hard-coded list.
// The SQL it generates is shown, is editable, and is what runs: the answer and
// the query that produced it are always on screen together.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useFetch } from "../hooks";
import { DataTable, ErrorBanner, Pill, SkeletonLines, SkeletonTable, fmtTime } from "../components";
import Chart, {
  CHART_TYPES, categoryFields, emptyChart, inferFields, normalizeChart, resolveSpec,
} from "../Chart";
import {
  AGGREGATES, TREND_EXAMPLES, aggAlias, aggNeedsColumn, aggNumericOnly, availableColumns, buildSql,
  canJoinClusters, clampLimit, clusterContextDefaults, clusterContextOn, decodeState,
  defaultAggAlias, defaultState, encodeState, loadSaved, maxRowsOf, operatorInput, operatorsFor,
  pruneState, sortableColumns, stateForTable, storeSaved, tableOf, toCsv, toObjects,
} from "../query/builder";

const HASH_PREFIX = "#query=";

// --------------------------------------------------------------------------- //
// browser helpers
// --------------------------------------------------------------------------- //
// A shared query is /query?q=<state>. Links minted before the router put the
// state in the fragment (#query=<state>), and those still open.
function readState(q) {
  try {
    if (q) return decodeState(q);
    const hash = window.location.hash || "";
    return hash.startsWith(HASH_PREFIX) ? decodeState(hash.slice(HASH_PREFIX.length)) : null;
  } catch {
    return null;
  }
}

function download(filename, text, mime) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

async function copyText(text) {
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
const squash = (sql) => String(sql || "").replace(/\s+/g, " ").trim();

// Switching into (or out of) an aggregate query can strand a sort on a column
// that is no longer in the output - drop those rather than leave a dead row.
function keepValidSorts(schema, state) {
  const allowed = new Set(sortableColumns(schema, state).map((c) => c.id));
  const sorts = state.sorts.filter((s) => allowed.has(s.column));
  return sorts.length === state.sorts.length ? state : { ...state, sorts };
}

// Turning grouping on with an empty group is a dead end, so it starts from the
// first chosen column and a count(*) - the query people meant nine times in ten.
function startGrouping(state, enabled) {
  if (!enabled) return { ...state.group, enabled: false };
  const by = state.group.by.length ? state.group.by : state.columns.slice(0, 1);
  const aggs = state.group.aggs.length
    ? state.group.aggs
    : [{ id: newId(), fn: "count", column: "", alias: "" }];
  return { enabled: true, by, aggs };
}

// --------------------------------------------------------------------------- //
// page
// --------------------------------------------------------------------------- //
export default function Query({ nav, route }) {
  const { data: schema, error: schemaError, loading: schemaLoading } = useFetch(
    () => api.querySchema(), []);

  const [state, setState] = useState(null);          // null until the schema lands
  const [result, setResult] = useState(null);
  const [ranSql, setRanSql] = useState("");
  const [runError, setRunError] = useState(null);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState("");              // transient "Copied" style feedback
  const [saved, setSaved] = useState(() => loadSaved());
  const [saveName, setSaveName] = useState("");
  const [askState, setAskState] = useState({ question: "", answer: null, error: null,
    unavailable: "", busy: false });

  const fromUrl = useRef(null);
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

  const flash = useCallback((text) => {
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

  const patch = useCallback((fields) => setState((s) => ({ ...s, ...fields })), []);

  const run = useCallback(async (sql, limit) => {
    const text = String(sql || "").trim();
    if (!text) return;
    setRunning(true);
    setRunError(null);
    try {
      const res = await api.runSql(text, limit);
      setResult(res);
      setRanSql(text);
    } catch (e) {
      setRunError(e);
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
    const onKey = (e) => {
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
  const setTable = (name) => {
    setState((s) => stateForTable(schema, name, { limit: s.limit }));
    setResult(null);
    setRunError(null);
  };

  const toggleClusterContext = (on) => {
    setState((s) => {
      const next = { ...s, clusterContext: on };
      if (!on) return pruneState(schema, next);
      const extra = clusterContextDefaults(schema, next).filter((id) => !s.columns.includes(id));
      return s.group.enabled ? next : { ...next, columns: [...s.columns, ...extra] };
    });
  };

  // Renaming an aggregate renames the output column, and a sort naming the old
  // one would quietly be dropped - so the sort follows the rename.
  const updateAgg = (index, fields) => setState((s) => {
    const aggs = s.group.aggs.map((a, j) => (j === index ? { ...a, ...fields } : a));
    const before = aggAlias(s.group.aggs[index]);
    const after = aggAlias(aggs[index]);
    const sorts = before === after
      ? s.sorts
      : s.sorts.map((x) => (x.column === before ? { ...x, column: after } : x));
    return { ...s, group: { ...s.group, aggs }, sorts };
  });

  const toggleColumn = (id) => {
    setState((s) => {
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
    } catch (e) {
      // 503 is the operator's missing credentials, not the user's mistake: say
      // so once and stop offering the box.
      const unavailable = e.status === 503
        ? (e.message || "the data layer has no model credentials configured.")
        : "";
      // 422 means both generated queries failed; the last one is worth showing.
      const lastSql = e.status === 422 && e.detail && typeof e.detail === "object"
        ? e.detail.sql : "";
      if (lastSql) patch({ mode: "sql", sql: lastSql });
      setAskState((a) => ({ ...a, busy: false, answer: null,
        error: unavailable ? null : e, unavailable: unavailable || a.unavailable }));
    }
  };

  const loadExample = (example) => {
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

  const loadQuery = (name) => {
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

  const deleteQuery = (name) => {
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

  const snap = schema.snapshot || {};
  const table = tableOf(schema, state.table);

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="section-head">
        <div>
          <div className="section-title" style={{ margin: 0 }}>Query</div>
          <div className="desc">
            Every table the collector fills, queried directly. The builder writes the SQL, the
            SQL is what runs, and both stay on screen.
          </div>
        </div>
        <div className="muted" style={{ fontSize: 12.5, textAlign: "right" }}>
          snapshot {snap.generation ?? "?"} · built {fmtTime(snap.built_at)}<br />
          {(snap.total_rows ?? 0).toLocaleString()} rows · max {maxRows} per query
        </div>
      </div>

      <AskBox
        state={askState}
        examples={schema.examples || []}
        onChange={(question) => setAskState((a) => ({ ...a, question }))}
        onAsk={askQuestion}
        onExample={loadExample}
      />

      <div className="q-layout">
        <div className="card q-rail">
          <Section title="Data set">
            <select
              className="q-full"
              value={state.table}
              onChange={(e) => setTable(e.target.value)}
              aria-label="Data set"
            >
              {(schema.tables || []).map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name} ({(snap.rows || {})[t.name] ?? 0})
                </option>
              ))}
            </select>
            {table && <div className="q-desc">{table.description}</div>}
            <label
              className={`q-check${canJoinClusters(schema, state.table) ? "" : " q-off"}`}
              title={canJoinClusters(schema, state.table)
                ? "LEFT JOIN clusters ON clusters.name = cluster_name"
                : "Only for tables with a cluster_name column"}
            >
              <input
                type="checkbox"
                checked={clusterContextOn(schema, state)}
                disabled={!canJoinClusters(schema, state.table)}
                onChange={(e) => toggleClusterContext(e.target.checked)}
              />
              <span>Cluster context</span>
              <span className="q-type">join</span>
            </label>
          </Section>

          <Section
            title={state.group.enabled ? "Aggregates" : "Columns"}
            right={state.group.enabled ? null : (
              <>
                <span className="muted">{state.columns.length}/{columns.length}</span>
                <button type="button" className="q-mini"
                  onClick={() => patch({ columns: columns.map((c) => c.id) })}>all</button>
                <button type="button" className="q-mini"
                  onClick={() => patch({ columns: [] })}>none</button>
              </>
            )}
          >
            <label className="q-check">
              <input
                type="checkbox"
                checked={state.group.enabled}
                onChange={(e) => setState((s) => keepValidSorts(schema,
                  { ...s, group: startGrouping(s, e.target.checked) }))}
              />
              <span>Group rows</span>
            </label>

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
              <div className="toggle-group q-tiny">
                {["AND", "OR"].map((j) => (
                  <button key={j} type="button" className={state.filterJoin === j ? "active" : ""}
                    onClick={() => patch({ filterJoin: j })}>
                    {j === "AND" ? "all of" : "any of"}
                  </button>
                ))}
              </div>
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
            <button
              type="button"
              className="q-add"
              disabled={!columns.length}
              onClick={() => patch({
                filters: [...state.filters,
                  { id: newId(), column: columns[0]?.id || "", op: "eq", value: "", value2: "" }],
              })}
            >
              + filter
            </button>
          </Section>

          <Section title="Sort">
            {state.sorts.map((s, i) => (
              <div className="q-row" key={`${s.column}-${i}`}>
                <select
                  className="q-grow"
                  value={s.column}
                  aria-label="Sort column"
                  onChange={(e) => patch({
                    sorts: state.sorts.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)),
                  })}
                >
                  <ColumnOptions columns={sortCols} />
                </select>
                <select
                  value={s.dir}
                  aria-label="Sort direction"
                  onChange={(e) => patch({
                    sorts: state.sorts.map((x, j) => (j === i ? { ...x, dir: e.target.value } : x)),
                  })}
                >
                  <option value="asc">asc</option>
                  <option value="desc">desc</option>
                </select>
                <button type="button" className="q-x" title="Remove"
                  onClick={() => patch({ sorts: state.sorts.filter((_, j) => j !== i) })}>×</button>
              </div>
            ))}
            <button
              type="button"
              className="q-add"
              disabled={!sortCols.length}
              onClick={() => patch({
                sorts: [...state.sorts, { column: sortCols[0]?.id || "", dir: "asc" }],
              })}
            >
              + sort
            </button>
          </Section>

          <Section title="Options">
            <label className="q-check">
              <input type="checkbox" checked={state.distinct}
                onChange={(e) => setState((s) => keepValidSorts(schema,
                  { ...s, distinct: e.target.checked }))} />
              <span>Distinct rows</span>
            </label>
            <div className="q-row">
              <label className="fld q-grow">
                Row limit (max {maxRows})
                <input
                  type="number"
                  min="1"
                  max={maxRows}
                  value={state.limit}
                  onChange={(e) => patch({ limit: e.target.value })}
                  onBlur={(e) => patch({ limit: clampLimit(e.target.value, schema) })}
                />
              </label>
            </div>
          </Section>

          <Section title="Saved queries">
            {saved.length > 0 ? (
              <div className="q-row">
                <select className="q-grow" value="" aria-label="Load a saved query"
                  onChange={(e) => e.target.value && loadQuery(e.target.value)}>
                  <option value="">load…</option>
                  {saved.map((q) => <option key={q.name} value={q.name}>{q.name}</option>)}
                </select>
                <select className="q-grow" value="" aria-label="Delete a saved query"
                  onChange={(e) => e.target.value && deleteQuery(e.target.value)}>
                  <option value="">delete…</option>
                  {saved.map((q) => <option key={q.name} value={q.name}>{q.name}</option>)}
                </select>
              </div>
            ) : (
              <div className="q-desc">Nothing saved yet. Saved queries live in this browser.</div>
            )}
            <div className="q-row">
              <input
                className="q-grow"
                type="text"
                placeholder="name this query"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") saveQuery(); }}
              />
              <button type="button" className="btn" disabled={!saveName.trim()}
                onClick={saveQuery}>Save</button>
            </div>
            {note && <div className="q-desc">{note}</div>}
          </Section>
        </div>

        <div className="q-main">
          <div className="card">
            <div className="section-head" style={{ marginBottom: 10 }}>
              <h3 style={{ margin: 0 }}>
                SQL {custom && <span className="tag">custom SQL</span>}
              </h3>
              <div className="q-actions">
                <button type="button" className="btn"
                  onClick={async () => flash(await copyText(sqlText) ? "SQL copied" : "Copy failed")}>
                  Copy
                </button>
                {custom ? (
                  <button type="button" className="btn"
                    onClick={() => patch({ mode: "builder", sql: "" })}>
                    Back to builder
                  </button>
                ) : (
                  <button type="button" className="btn"
                    onClick={() => patch({ mode: "sql", sql: built.sql })}>
                    Edit SQL
                  </button>
                )}
                <button type="button" className="btn primary" disabled={running || !sqlText.trim()}
                  onClick={runCurrent} title="Run the query (Ctrl / Cmd + Enter)">
                  {running ? "Running…" : "Run"}
                </button>
              </div>
            </div>

            {custom ? (
              <textarea
                className="q-sql q-sql-edit mono"
                spellCheck="false"
                value={state.sql}
                onChange={(e) => patch({ sql: e.target.value })}
                rows={Math.min(20, Math.max(6, state.sql.split("\n").length + 1))}
                aria-label="SQL"
              />
            ) : (
              <pre className="q-sql mono">{built.sql || "-- nothing to run yet"}</pre>
            )}

            {!custom && built.problems.length > 0 && (
              <ul className="q-problems">
                {built.problems.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            )}
            {custom && (
              <div className="q-desc">
                The builder no longer writes this query. "Back to builder" regenerates it.
              </div>
            )}

            {runError && (
              <div className="banner" style={{ marginTop: 12, marginBottom: 0 }}>
                {runError.status === 400 ? "Rejected: " : runError.status === 504 ? "Timed out: " : ""}
                {String(runError.message || runError)}
              </div>
            )}

            {result && !runError && (
              <div className="q-meta">
                {result.row_count.toLocaleString()} rows · {result.elapsed_ms} ms ·
                {" "}snapshot generation {result.generation}
                {result.truncated && (
                  <span className="tag critical" style={{ marginLeft: 8 }}>
                    truncated at {result.row_count}
                  </span>
                )}
                {result.sql && squash(result.sql) !== squash(ranSql) && (
                  <details className="q-ran">
                    <summary>SQL that ran</summary>
                    <pre className="q-sql mono">{result.sql}</pre>
                  </details>
                )}
              </div>
            )}
          </div>

          <Results
            result={result}
            running={running}
            mode={state.mode}
            table={state.table}
            nav={nav}
            onFlash={flash}
            chart={state.chart}
            onChart={(chart) => patch({ chart })}
          />
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// builder pieces
// --------------------------------------------------------------------------- //
function QuerySkeleton() {
  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="section-head">
        <div>
          <div className="section-title" style={{ margin: 0 }}>Query</div>
          <div className="desc">
            Every table the collector fills, queried directly. The builder writes the SQL, the
            SQL is what runs, and both stay on screen.
          </div>
        </div>
      </div>
      <div className="q-layout">
        <div className="card q-rail"><div className="q-sec"><SkeletonLines rows={9} /></div></div>
        <div className="q-main">
          <div className="card"><SkeletonLines rows={5} /></div>
          <div className="card flush"><SkeletonTable columns={6} rows={6} /></div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, right, children }) {
  return (
    <div className="q-sec">
      <div className="q-head">
        <span className="q-title">{title}</span>
        {right && <span className="q-actions">{right}</span>}
      </div>
      {children}
    </div>
  );
}

// Base columns first, then the joined cluster columns, both in schema order.
function ColumnOptions({ columns, placeholder }) {
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

function ColumnPicker({ columns, selected, onToggle }) {
  const chosen = new Set(selected);
  const base = columns.filter((c) => c.source === "base");
  const ctx = columns.filter((c) => c.source === "cluster");
  const check = (c) => (
    <label className="q-check" key={c.id} title={c.description}>
      <input type="checkbox" checked={chosen.has(c.id)} onChange={() => onToggle(c.id)} />
      <span className="mono q-name">{c.label}</span>
      <span className="q-type">{c.type}</span>
    </label>
  );
  return (
    <div className="q-list">
      {base.map(check)}
      {ctx.length > 0 && <div className="q-subhead">Cluster context</div>}
      {ctx.map(check)}
    </div>
  );
}

function Grouping({ group, columns, patch, onAggChange }) {
  const setGroup = (fields) => patch({ group: { ...group, ...fields } });

  return (
    <>
      <div className="q-subhead">Group by</div>
      {group.by.map((id, i) => (
        <div className="q-row" key={`${id}-${i}`}>
          <select className="q-grow" value={id} aria-label="Group by column"
            onChange={(e) => setGroup({ by: group.by.map((x, j) => (j === i ? e.target.value : x)) })}>
            <ColumnOptions columns={columns} />
          </select>
          <button type="button" className="q-x" title="Remove"
            onClick={() => setGroup({ by: group.by.filter((_, j) => j !== i) })}>×</button>
        </div>
      ))}
      <button type="button" className="q-add" disabled={!columns.length}
        onClick={() => setGroup({ by: [...group.by, columns[0]?.id || ""] })}>
        + group by
      </button>

      <div className="q-subhead">Aggregates</div>
      {group.aggs.map((agg, i) => {
        const usable = aggNumericOnly(agg.fn) ? columns.filter((c) => c.kind === "number") : columns;
        const update = (fields) => onAggChange(i, fields);
        return (
          <div className="q-agg" key={agg.id}>
            <div className="q-row">
              <select className="q-grow" value={agg.fn} aria-label="Aggregate function"
                onChange={(e) => {
                  const fn = e.target.value;
                  const column = aggNeedsColumn(fn)
                    ? (usable.some((c) => c.id === agg.column) ? agg.column : "")
                    : "";
                  update({ fn, column, alias: "" });
                }}>
                {AGGREGATES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
              {aggNeedsColumn(agg.fn) && (
                <select className="q-grow" value={agg.column} aria-label="Aggregate column"
                  onChange={(e) => update({ column: e.target.value, alias: "" })}>
                  <ColumnOptions columns={usable} placeholder="column…" />
                </select>
              )}
              <button type="button" className="q-x" title="Remove"
                onClick={() => setGroup({ aggs: group.aggs.filter((_, j) => j !== i) })}>×</button>
            </div>
            <input
              className="q-full"
              type="text"
              value={agg.alias}
              placeholder={`as ${defaultAggAlias(agg.fn, agg.column)}`}
              aria-label="Aggregate name"
              onChange={(e) => update({ alias: e.target.value })}
            />
          </div>
        );
      })}
      <button type="button" className="q-add"
        onClick={() => setGroup({ aggs: [...group.aggs, { id: newId(), fn: "count", column: "", alias: "" }] })}>
        + aggregate
      </button>
    </>
  );
}

function FilterRow({ filter, columns, onChange, onRemove }) {
  const col = columns.find((c) => c.id === filter.column);
  const kind = col ? col.kind : "text";
  const ops = operatorsFor(kind);
  const op = ops.some(([id]) => id === filter.op) ? filter.op : ops[0][0];
  const { args, type } = operatorInput(kind, op);

  const changeColumn = (id) => {
    const next = columns.find((c) => c.id === id);
    const nextOps = operatorsFor(next ? next.kind : "text");
    const keep = nextOps.some(([o]) => o === filter.op);
    onChange({ ...filter, column: id, op: keep ? filter.op : nextOps[0][0],
      value: keep ? filter.value : "", value2: keep ? filter.value2 : "" });
  };

  const input = (key, placeholder) => (
    <input
      className="q-grow"
      type={type === "date" ? "date" : type === "number" || type === "days" ? "number" : "text"}
      min={type === "days" ? "1" : undefined}
      value={filter[key] || ""}
      placeholder={placeholder}
      aria-label="Filter value"
      onChange={(e) => onChange({ ...filter, [key]: e.target.value })}
    />
  );

  return (
    <div className="q-filter">
      <div className="q-row">
        <select className="q-full" value={filter.column} aria-label="Filter column"
          onChange={(e) => changeColumn(e.target.value)}>
          <ColumnOptions columns={columns} placeholder="column…" />
        </select>
      </div>
      <div className="q-row">
        <select className="q-grow" value={op} aria-label="Filter operator"
          onChange={(e) => onChange({ ...filter, op: e.target.value, value: "", value2: "" })}>
          {ops.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        {args >= 1 && input("value", type === "list" ? "a, b, c" : type === "days" ? "7" : "value")}
        {args >= 2 && input("value2", "and")}
        <button type="button" className="q-x" title="Remove filter" onClick={onRemove}>×</button>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// ask
// --------------------------------------------------------------------------- //
function AskBox({ state, examples, onChange, onAsk, onExample }) {
  const disabled = !!state.unavailable || state.busy;
  const answer = state.answer;
  return (
    <div className="card">
      <div className="section-head" style={{ marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Ask in English</h3>
        {answer && (
          <span className="tag">confidence {Math.round((answer.confidence || 0) * 100)}%
            {answer.attempts > 1 ? ` · ${answer.attempts} attempts` : ""}</span>
        )}
      </div>
      <div className="q-row">
        <input
          className="q-grow"
          type="text"
          placeholder="How many application namespaces per team and environment?"
          value={state.question}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onAsk(); }}
          aria-label="Ask a question about the fleet"
        />
        <button type="button" className="btn" disabled={disabled || !state.question.trim()}
          onClick={onAsk}>
          {state.busy ? "Asking…" : "Ask"}
        </button>
      </div>

      {state.unavailable && (
        <div className="q-desc">
          Not available: {state.unavailable} - the SQL builder below works without it.
        </div>
      )}
      {state.error && (
        <div className="banner" style={{ marginTop: 12, marginBottom: 0 }}>
          {String(state.error.message || state.error)}
        </div>
      )}
      {answer && (
        <div className="q-answer">
          <div>{answer.explanation}</div>
          {(answer.assumptions || []).length > 0 && (
            <ul className="q-assumptions">
              {answer.assumptions.map((a, i) => <li key={i}>{a}</li>)}
            </ul>
          )}
        </div>
      )}

      {examples.length > 0 && (
        <div className="q-examples">
          <span className="muted">Examples:</span>
          {examples.slice(0, 5).map((ex, i) => (
            <button type="button" className="tag q-example" key={i}
              title="Load this example query" onClick={() => onExample(ex)}>
              {ex.question}
            </button>
          ))}
        </div>
      )}

      {/* History questions, written out as SQL. They run without a model, and
          each one comes back in a shape the chart under the table picks up. */}
      <div className="q-examples">
        <span className="muted">Trends:</span>
        {TREND_EXAMPLES.map((ex) => (
          <button type="button" className="tag q-example" key={ex.question}
            title="Run this query - the result charts itself" onClick={() => onExample(ex)}>
            {ex.question}
          </button>
        ))}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// results
// --------------------------------------------------------------------------- //
const STATUS_WORD = /^[a-z][a-z-]{1,19}$/;

// A cluster name is always worth a link; a bare `name` only when the builder
// knows the query is over clusters (custom SQL can call anything `name`).
function linkKindFor(name, mode, table) {
  if (name === "cluster_name" || name === "cluster") return "cluster";
  if (name === "name" && mode === "builder" && table === "clusters") return "cluster";
  if (name === "app_name" || name === "application") return "app";
  return null;
}

function Cell({ name, value, link, nav }) {
  if (value == null) return <span className="muted">—</span>;
  if (typeof value === "boolean") {
    return <span className={`mono${value ? "" : " muted"}`}>{String(value)}</span>;
  }
  if (typeof value === "number") return <span className="mono">{value}</span>;
  if (typeof value === "object") {
    const text = JSON.stringify(value);
    return <span className="mono q-trunc" title={text}>{text}</span>;
  }
  const text = String(value);
  if (link === "cluster" && text) {
    return <span className="link mono" onClick={() => nav.openCluster(text)}>{text}</span>;
  }
  if (link === "app" && text) {
    return <span className="link" onClick={() => nav.openApp(text)}>{text}</span>;
  }
  if (/(^|_)overall_status$/.test(name)) return <Pill status={text} />;
  if (/(^|_)status$/.test(name) && STATUS_WORD.test(text)) {
    return <span className={`chip ${text}`}>{text}</span>;
  }
  if (text.length > 48) return <span className="q-trunc" title={text}>{text}</span>;
  return text;
}

// --------------------------------------------------------------------------- //
// the chart above the table
// --------------------------------------------------------------------------- //
// The shape is inferred from the result - a time axis makes a line, one
// category makes bars, anything else makes no chart at all - and every part of
// that inference is overridable here. The controls sit in one row above the
// chart, and the table below is unchanged: it is still the whole answer.
function ChartPanel({ result, chart, onChange }) {
  const fields = useMemo(
    () => inferFields(result.columns, result.column_types, result.rows),
    [result]);
  const spec = useMemo(() => resolveSpec(fields, result.rows, chart), [fields, result.rows, chart]);
  const choice = normalizeChart(chart);

  if (!result.row_count) return null;

  const numbers = fields.filter((f) => f.kind === "number");
  const cats = categoryFields(fields);
  const times = fields.filter((f) => f.kind === "time");
  const line = spec?.type === "line";
  const xOptions = line ? times : [...cats, ...times];
  const yOptions = numbers.filter((f) => f.name !== spec?.x);
  const seriesOptions = cats.filter((f) => f.name !== spec?.x);

  const set = (fragment) => onChange({ ...choice, ...fragment });
  // Switching the type starts the picks over, which is also the way back to
  // "let the chart decide".
  const setType = (type) => onChange({ ...emptyChart(), type });
  const toggleY = (name) => {
    if (!spec) return;
    // one measure per line when a series column already owns the colours
    if (line && spec.series) { set({ y: [name] }); return; }
    const on = spec.y.includes(name);
    const next = on ? spec.y.filter((n) => n !== name) : [...spec.y, name];
    if (next.length) set({ y: next });
  };

  return (
    <div className="chart-panel">
      <div className="chart-controls">
        <label className="chart-ctl">
          <span>Chart</span>
          <select value={choice.type} onChange={(e) => setType(e.target.value)}>
            {CHART_TYPES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>

        {spec && (
          <>
            <label className="chart-ctl">
              <span>{line ? "Time" : "Category"}</span>
              <select value={spec.x} onChange={(e) => set({ x: e.target.value })}>
                {xOptions.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
              </select>
            </label>

            {line && (
              <label className="chart-ctl">
                <span>Series</span>
                <select
                  value={spec.series}
                  onChange={(e) => set({ series: e.target.value, y: spec.y.slice(0, 1) })}
                >
                  <option value="">none</option>
                  {seriesOptions.map((f) => (
                    <option key={f.name} value={f.name}>{f.name} ({f.distinct})</option>
                  ))}
                </select>
              </label>
            )}

            <div className="chart-ctl">
              <span>{line && spec.series ? "Measure" : "Measures"}</span>
              <div className="chart-ys">
                {yOptions.map((f) => (
                  <button
                    key={f.name}
                    type="button"
                    className={`q-mini${spec.y.includes(f.name) ? " active" : ""}`}
                    aria-pressed={spec.y.includes(f.name)}
                    onClick={() => toggleY(f.name)}
                  >
                    {f.name}
                  </button>
                ))}
              </div>
            </div>

            {line && (
              <label className="q-check chart-ctl-check"
                title="Stack the series into a running total - for counts, not for scores">
                <input type="checkbox" checked={spec.stack}
                  onChange={(e) => set({ stack: e.target.checked })} />
                <span>Stack</span>
              </label>
            )}
          </>
        )}
      </div>

      {spec ? (
        <Chart fields={fields} rows={result.rows} spec={spec} height={280} />
      ) : choice.type === "none" ? null : (
        <div className="chart-none">
          {choice.type === "auto"
            ? "No chart for this result - it has no time axis and no single category to group by."
            : `A ${choice.type === "line" ? "line needs a time column and a number" : "bar chart needs a category and a number"}; this result has neither.`}
        </div>
      )}
    </div>
  );
}

function Results({ result, running, mode, table, nav, onFlash, chart, onChart }) {
  const rows = useMemo(
    () => (result ? result.rows.map((values, i) => ({ i, values })) : []), [result]);

  const columns = useMemo(() => {
    if (!result) return [];
    return result.columns.map((name, i) => {
      // A column whose every present value is a number is a measure: right-align
      // it and sort it as a number rather than as text.
      let numeric = false;
      for (const row of result.rows) {
        const v = row[i];
        if (v == null) continue;
        if (typeof v !== "number") { numeric = false; break; }
        numeric = true;
      }
      const link = linkKindFor(name, mode, table);
      return {
        key: `${i}:${name}`,
        label: name,
        filter: "text",
        // A result cell never wraps: short values stay on one line and long
        // ones are truncated with the full text in the title, so the table
        // scrolls sideways instead of growing rows three lines tall.
        className: "nowrap",
        align: numeric ? "right" : undefined,
        sortValue: (r) => r.values[i],
        filterValue: (r) => {
          const v = r.values[i];
          if (v == null) return "";
          return typeof v === "object" ? JSON.stringify(v) : String(v);
        },
        render: (r) => <Cell name={name} value={r.values[i]} link={link} nav={nav} />,
      };
    });
  }, [result, mode, table, nav]);

  if (!result) {
    return (
      <div className="card">
        {running ? <SkeletonLines rows={4} /> : <div className="empty">Run a query to see rows.</div>}
      </div>
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
    <div className="card flush">
      <div className="card-head">
        <div className="section-head" style={{ marginBottom: 4 }}>
          <h3 style={{ margin: 0 }}>
            Results <span className="muted">{result.row_count.toLocaleString()} rows ·
              {" "}{result.columns.length} columns</span>
          </h3>
          <div className="q-actions">
            <button type="button" className="btn" disabled={!result.row_count} onClick={csv}>
              Download CSV
            </button>
            <button type="button" className="btn" disabled={!result.row_count} onClick={json}>
              Copy as JSON
            </button>
          </div>
        </div>
      </div>
      <ChartPanel result={result} chart={chart} onChange={onChart} />
      <DataTable
        id="query.results"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.i}
        dense
        scroll
        empty="The query ran and returned no rows."
        searchPlaceholder="Search results"
      />
    </div>
  );
}
