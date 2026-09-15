// Running a dashboard, and what to do when the API cannot.
//
// The happy path is one call: POST /api/dashboards/{id}/run returns every
// panel's rows and every select variable's options together, so a page with
// nine panels is one round trip and one snapshot.
//
// Two fallbacks sit under it, because a dashboard is only ever a definition plus
// the query plane:
//
//   - no /run          : fetch the definition and run it here (which is also how
//                        an unsaved draft is previewed while it is being edited)
//   - no /query/batch  : run the panels one at a time through /query/sql, with
//                        the variable substitution done client-side
//
// A missing endpoint is remembered for half a minute rather than forever, so a
// data layer that gains the endpoints mid-session is picked up without a reload.
import { api } from "../api";
import {
  effectiveParams, hasValue, normalizeDefinition, substituteSql, variablesIn,
} from "./model";
import { fixtureDefinition, fixtureList } from "./fixture";

const RETRY_MS = 30000;
const missingUntil = new Map();

const isMissing = (e) => !!e && (e.status === 404 || e.status === 405 || e.status === 501);
const isDown = (key) => (missingUntil.get(key) || 0) > Date.now();
const markDown = (key) => missingUntil.set(key, Date.now() + RETRY_MS);
const markUp = (key) => missingUntil.delete(key);

export const batchAvailable = () => !isDown("batch");

// --------------------------------------------------------------------------- //
// queries
// --------------------------------------------------------------------------- //
// queries: [{id, sql, limit}] -> {results: {id: result | {error, sql}}, generation, snapshot}
//
// One failing query is that panel's error, not the page's: the others still
// render. A cancelled request is the exception - it means the view went away.
export async function runQueries(queries, params, signal) {
  if (!queries.length) return { results: {}, generation: null, snapshot: null };

  if (!isDown("batch")) {
    try {
      const res = await api.queryBatch(queries, params, signal);
      markUp("batch");
      return {
        results: res?.results || {},
        generation: res?.generation ?? null,
        snapshot: res?.snapshot || null,
      };
    } catch (e) {
      if (e?.name === "AbortError" || !isMissing(e)) throw e;
      markDown("batch");
    }
  }

  const results = {};
  let generation = null;
  for (const q of queries) {
    const sql = substituteSql(q.sql, params);
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await api.runSql(sql, q.limit || undefined, signal);
      results[q.id] = r;
      if (r && r.generation != null) generation = r.generation;
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      results[q.id] = { error: String(e?.message || e), sql };
    }
  }
  return { results, generation, snapshot: null };
}

// An options query returns a column called `value` and, optionally, one called
// `label` - the same rule the API applies, so a query that works here works
// there. The answer is {options} or {options: [], error} rather than a throw:
// a variable whose options failed still draws its selector, empty, next to the
// reason it is empty.
function optionsFrom(result) {
  if (!result) return { options: [] };
  if (result.error) return { options: [], error: String(result.error) };
  const columns = result.columns || [];
  const valueAt = columns.indexOf("value");
  if (valueAt < 0) {
    return { options: [], error: "the options query must return a column named 'value'" };
  }
  const labelAt = columns.indexOf("label") >= 0 ? columns.indexOf("label") : valueAt;
  const seen = new Set();
  const options = [];
  for (const row of result.rows || []) {
    const value = row[valueAt];
    if (value == null || value === "") continue;
    const key = String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    const label = row[labelAt];
    options.push({ value: key, label: label == null ? key : String(label) });
  }
  return { options };
}

// --------------------------------------------------------------------------- //
// running a definition here
// --------------------------------------------------------------------------- //
// Same response shape as POST /run, so the view does not know which path it got.
export async function runLocally(definition, given, signal) {
  const def = normalizeDefinition(definition);
  const params = effectiveParams(def, given);

  const varQueries = def.variables
    .filter((v) => v.sql)
    .map((v) => ({ id: `var:${v.name}`, sql: v.sql, limit: 500 }));
  const varRun = await runQueries(varQueries, params, signal);

  const variables = {};
  for (const v of def.variables) {
    variables[v.name] = v.sql ? optionsFrom(varRun.results[`var:${v.name}`]) : { options: [] };
  }

  // A panel naming a variable with no value cannot be substituted - in its SQL
  // or in its title, which is also filled in server-side. The server words that
  // the same way, and the view turns it into "Choose a hub above".
  const results = {};
  const runnable = [];
  for (const panel of def.panels) {
    const used = [...variablesIn(panel.sql), ...variablesIn(panel.title)];
    const unset = used.find((name) => !hasValue(params[name]));
    if (unset) results[panel.id] = { error: `variable ${unset} is not set`, sql: panel.sql };
    else runnable.push({ id: panel.id, sql: panel.sql, limit: panel.limit || undefined });
  }
  const panelRun = await runQueries(runnable, params, signal);
  Object.assign(results, panelRun.results);

  return {
    dashboard: def,
    params,
    variables,
    results,
    generation: panelRun.generation ?? varRun.generation ?? null,
    snapshot: panelRun.snapshot || varRun.snapshot || null,
    local: true,
  };
}

async function runViaApi(id, params, signal) {
  if (!isDown(`run:${id}`)) {
    try {
      const res = await api.runDashboard(id, params).load(signal);
      markUp(`run:${id}`);
      return { ...res, dashboard: normalizeDefinition(res?.dashboard, id) };
    } catch (e) {
      if (e?.name === "AbortError" || !isMissing(e)) throw e;
      markDown(`run:${id}`);
    }
  }
  const def = await api.dashboard(id).load(signal);   // a 404 here is the real answer
  return runLocally(def, params, signal);
}

// --------------------------------------------------------------------------- //
// descriptors (what the SWR cache is keyed on)
// --------------------------------------------------------------------------- //
const key = (params) => {
  try {
    return Object.keys(params || {}).sort()
      .map((k) => `${k}=${Array.isArray(params[k]) ? params[k].join("|") : params[k]}`)
      .join("&");
  } catch {
    return "";
  }
};

export function listDescriptor({ fixture } = {}) {
  if (fixture) {
    return { url: "fixture:/api/dashboards", load: async () => ({ dashboards: fixtureList() }) };
  }
  return api.dashboards();
}

export function definitionDescriptor(id, { fixture } = {}) {
  if (fixture) {
    return {
      url: `fixture:/api/dashboards/${id}`,
      load: async () => {
        const def = fixtureDefinition(id);
        if (!def) throw new Error(`No fixture dashboard called "${id}".`);
        return def;
      },
    };
  }
  return api.dashboard(id);
}

export function runDescriptor(id, params, { fixture } = {}) {
  const suffix = `?params=${key(params)}`;
  if (fixture) {
    return {
      url: `fixture:/api/dashboards/${id}/run${suffix}`,
      load: (signal) => {
        const def = fixtureDefinition(id);
        if (!def) throw new Error(`No fixture dashboard called "${id}".`);
        return runLocally(def, params, signal);
      },
    };
  }
  return {
    url: `/api/dashboards/${encodeURIComponent(id)}/run${suffix}`,
    load: (signal) => runViaApi(id, params, signal),
  };
}

// A draft being edited is not saved anywhere, so it runs here. The cache key
// spells out only what changes the rows - retitling a panel does not re-query.
export function draftRunDescriptor(draft, params) {
  const shape = JSON.stringify({
    p: (draft.panels || []).map((p) => [p.id, p.sql, p.limit]),
    v: (draft.variables || []).map((v) => [v.name, v.sql, v.default, v.multi]),
  });
  let hash = 0;
  for (let i = 0; i < shape.length; i += 1) hash = ((hash * 31) + shape.charCodeAt(i)) | 0;
  return {
    url: `draft:${draft.id}/${(hash >>> 0).toString(36)}?params=${key(params)}`,
    load: (signal) => runLocally(draft, params, signal),
  };
}
