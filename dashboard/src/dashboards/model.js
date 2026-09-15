// The dashboard definition, and everything that is pure about it.
//
// A dashboard is a title, a set of variables and a list of panels; a panel is a
// title, a guarded SELECT, a chart spec and a size on a 12-column grid. The
// server stores exactly this shape, so what the editor writes is what a GET
// gives back - no second, client-only model to keep in step.
//
//   {id, title, description, builtin,
//    variables: [{name, label, type, sql, multi, required, default}],
//    panels:    [{id, title, description, sql, chart, w, h, limit}],
//    updated_at, updated_by}
//
// Variables appear in SQL and in titles as {{name}}. The server substitutes them
// into SQL as escaped literals; the same substitution lives here because two
// things need it client-side: "Open in Query" has to show the query that ran,
// and the one-query-at-a-time fallback has to send real SQL when the batch
// endpoint is not there.
import { emptyChart, normalizeChart } from "../Chart";
import { encodeState, normalizeState } from "../query/builder";

export const ROW_HEIGHT = 150;          // px, matches .db-grid's grid-auto-rows
export const GRID_GAP = 16;             // px, matches .db-grid's gap
export const MAX_W = 12;                // columns, matches .db-grid's template
export const MAX_H = 6;
export const MAX_PANELS = 40;
export const DEFAULT_W = 6;
export const DEFAULT_H = 2;

export const VARIABLE_TYPES = [["select", "Select"], ["text", "Text"], ["number", "Number"]];

// Query-string keys the dashboard view owns, so a variable cannot be named one
// of them and quietly lose its value to the router.
export const RESERVED_QUERY_KEYS = ["fixture", "new"];

const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const NAME_RE = /^[a-z_][a-z0-9_]*$/;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

const asString = (v) => (typeof v === "string" ? v : "");
const asArray = (v) => (Array.isArray(v) ? v : []);

export const hasValue = (v) =>
  v != null && v !== "" && (!Array.isArray(v) || v.length > 0);

const clamp = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

export const clampW = (v) => clamp(v, 1, MAX_W, DEFAULT_W);
export const clampH = (v) => clamp(v, 1, MAX_H, DEFAULT_H);

let seq = 0;
export const newPanelId = () => `p${Date.now().toString(36)}${(seq += 1).toString(36)}`;

// --------------------------------------------------------------------------- //
// normalising what came off the wire (or out of the editor)
// --------------------------------------------------------------------------- //
// The stored `chart` is opaque to the API - the front end owns it - so the
// definitions the data layer ships speak the vocabulary a dashboard author
// writes by hand: {type: table}, {type: bar, x: status, y: clusters}. The Chart
// component's own words are "none" and "bars", and its y is a list, so the two
// are reconciled here, once, on the way in. Anything this build writes back is
// in the component's own words, which this also accepts unchanged.
const CHART_TYPE_ALIASES = { table: "none", bar: "bars", lines: "line", column: "bars" };

export function chartFromWire(raw) {
  if (!raw || typeof raw !== "object") return normalizeChart(raw);
  const type = CHART_TYPE_ALIASES[raw.type] || raw.type;
  const y = typeof raw.y === "string" ? [raw.y] : raw.y;
  return normalizeChart({ ...raw, type, y });
}

export function normalizePanel(raw, index = 0) {
  return {
    id: asString(raw?.id) || `p${index + 1}`,
    title: asString(raw?.title),
    description: asString(raw?.description),
    sql: asString(raw?.sql),
    chart: chartFromWire(raw?.chart),
    w: clampW(raw?.w),
    h: clampH(raw?.h),
    limit: Number.isFinite(Number(raw?.limit)) && Number(raw?.limit) > 0
      ? Math.round(Number(raw.limit)) : null,
  };
}

export function normalizeVariable(raw, index = 0) {
  const type = VARIABLE_TYPES.some(([t]) => t === raw?.type) ? raw.type : "select";
  return {
    name: asString(raw?.name) || `var${index + 1}`,
    label: asString(raw?.label),
    type,
    // Only a select has options, and the API refuses a text or number variable
    // that carries a query - so switching the type drops it rather than saving
    // something that cannot be saved.
    sql: type === "select" ? asString(raw?.sql) : "",
    multi: type === "select" && !!raw?.multi,
    required: !!raw?.required,
    default: raw?.default == null ? "" : raw.default,
  };
}

export function normalizeDefinition(raw, fallbackId = "") {
  return {
    id: asString(raw?.id) || fallbackId,
    title: asString(raw?.title) || asString(raw?.id) || fallbackId,
    description: asString(raw?.description),
    builtin: !!raw?.builtin,
    variables: asArray(raw?.variables).map(normalizeVariable),
    panels: asArray(raw?.panels).map(normalizePanel),
    updated_at: raw?.updated_at || null,
    updated_by: raw?.updated_by || null,
  };
}

// "hub-capacity-review" as a title reads as a file name; "Hub capacity review"
// reads as the thing the user just named, which is what they typed.
export function titleFromId(id) {
  const words = String(id || "").replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "";
}

export function emptyDefinition(id, title) {
  return {
    id,
    title: title || titleFromId(id),
    description: "",
    builtin: false,
    variables: [],
    panels: [],
    updated_at: null,
    updated_by: null,
  };
}

export function emptyPanel(title = "New panel") {
  return {
    id: newPanelId(),
    title,
    description: "",
    sql: "",
    chart: emptyChart(),
    w: DEFAULT_W,
    h: DEFAULT_H,
    limit: null,
  };
}

// What is sent back on a PUT: the stored shape, without the fields the server
// owns (a clone must not claim to be built in, or to have been saved already).
export function forSave(def) {
  return {
    id: def.id,
    title: def.title,
    description: def.description,
    variables: def.variables.map((v) => ({
      name: v.name,
      label: v.label || v.name,
      type: v.type,
      ...(v.sql ? { sql: v.sql } : {}),
      ...(v.multi ? { multi: true } : {}),
      ...(v.required ? { required: true } : {}),
      ...(hasValue(v.default) ? { default: v.default } : {}),
    })),
    panels: def.panels.map((p) => ({
      id: p.id,
      title: p.title,
      ...(p.description ? { description: p.description } : {}),
      sql: p.sql,
      chart: p.chart,
      w: clampW(p.w),
      h: clampH(p.h),
      ...(p.limit ? { limit: p.limit } : {}),
    })),
  };
}

export function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export const isSlug = (id) => SLUG_RE.test(String(id || ""));

// --------------------------------------------------------------------------- //
// variables
// --------------------------------------------------------------------------- //
export function variablesIn(sql) {
  const out = [];
  const text = String(sql || "");
  VAR_RE.lastIndex = 0;
  let m = VAR_RE.exec(text);
  while (m) {
    if (!out.includes(m[1])) out.push(m[1]);
    m = VAR_RE.exec(text);
  }
  return out;
}

// The same escaping the server does: a string is a quoted literal, a list is a
// parenthesised tuple for IN (...), a number is itself. Nothing the user types
// can leave the literal, so a variable cannot become syntax.
export function sqlLiteral(value) {
  if (value == null || value === "") return "NULL";
  if (Array.isArray(value)) {
    return value.length ? `(${value.map(sqlLiteral).join(", ")})` : "(NULL)";
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return `'${String(value).replace(/'/g, "''")}'`;
}

// A name with no value is left as {{name}} rather than replaced with NULL: the
// caller checks first, and a query that still has a placeholder in it is a bug
// worth seeing rather than a query that quietly matches nothing.
export function substituteSql(sql, params = {}) {
  return String(sql || "").replace(VAR_RE, (whole, name) =>
    (hasValue(params[name]) ? sqlLiteral(params[name]) : whole));
}

// Titles read as text, not as SQL: "Clusters on {{hub}}" becomes "Clusters on
// hub-east", and an unset variable leaves a visible gap rather than a literal.
export function interpolateText(text, params = {}) {
  return String(text || "").replace(VAR_RE, (whole, name) => {
    const value = params[name];
    if (Array.isArray(value)) return value.length ? value.join(", ") : "…";
    return hasValue(value) ? String(value) : "…";
  });
}

function coerce(variable, value) {
  if (variable.multi) {
    const list = Array.isArray(value) ? value : String(value).split(",");
    return list.map((v) => String(v).trim()).filter(Boolean);
  }
  if (Array.isArray(value)) return coerce({ ...variable, multi: true }, value)[0] ?? "";
  if (variable.type === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? n : String(value);
  }
  return String(value);
}

// The variable values carried by the URL, read through the dashboard's own
// declarations: a multi-select is comma separated, a number is a number, and a
// key the dashboard does not declare is not a variable.
export function paramsFromQuery(def, query = {}) {
  const out = {};
  for (const v of def.variables || []) {
    const raw = query[v.name];
    if (!hasValue(raw)) continue;
    out[v.name] = coerce(v, raw);
  }
  return out;
}

// What a run is actually given: the URL's values, with each variable's default
// standing in where the URL is silent.
export function effectiveParams(def, given = {}) {
  const out = {};
  for (const v of def.variables || []) {
    const value = hasValue(given[v.name]) ? given[v.name] : v.default;
    if (!hasValue(value)) continue;
    out[v.name] = coerce(v, value);
  }
  return out;
}

// How a variable's value is written into the query string.
export const queryValue = (value) =>
  (Array.isArray(value) ? value.join(",") : value == null ? "" : String(value));

export const variableLabel = (variable) => variable.label || variable.name;

export function variableByName(def, name) {
  return (def.variables || []).find((v) => v.name === name) || null;
}

// A run answers a panel it could not substitute with "variable hub is not set".
// That is not an error the user made - it is an invitation to pick a hub - so
// the panel says so in the variable's own words.
const UNSET_RE = /variable\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?\s+is not set/i;

export function unsetVariableIn(message) {
  const m = UNSET_RE.exec(String(message || ""));
  return m ? m[1] : null;
}

// --------------------------------------------------------------------------- //
// validation
// --------------------------------------------------------------------------- //
// Errors are keyed by the same path the API answers with ("panels.0.sql"), so a
// 400 from the server and a check made here land in the same place on screen.
export function validateDefinition(def) {
  const errors = [];
  const add = (path, message) => errors.push({ path, message });

  if (!isSlug(def.id)) add("id", "An id is lower case letters, digits and dashes.");
  if (!def.title.trim()) add("title", "A dashboard needs a title.");

  const names = new Set();
  (def.variables || []).forEach((v, i) => {
    if (!NAME_RE.test(v.name)) {
      add(`variables.${i}.name`, "A name is lower case letters, digits and underscores.");
    } else if (names.has(v.name)) {
      add(`variables.${i}.name`, `Two variables are both called "${v.name}".`);
    } else if (RESERVED_QUERY_KEYS.includes(v.name)) {
      add(`variables.${i}.name`, `"${v.name}" is reserved by the page itself.`);
    }
    names.add(v.name);
    if (v.type === "select" && !v.sql.trim()) {
      add(`variables.${i}.sql`, "A select variable needs a query for its options.");
    }
    // Options and panels are resolved in one batch, so an options query cannot
    // depend on another variable - the API refuses it, and so does this.
    const used = variablesIn(v.sql);
    if (used.length) {
      add(`variables.${i}.sql`,
        `An options query may not use variables (found {{${used[0]}}}).`);
    }
  });

  const panels = def.panels || [];
  if (!panels.length) add("panels", "A dashboard needs at least one panel.");
  if (panels.length > MAX_PANELS) add("panels", `A dashboard holds at most ${MAX_PANELS} panels.`);
  const ids = new Set();
  panels.forEach((p, i) => {
    if (!isSlug(p.id)) add(`panels.${i}.id`, "A panel id is lower case letters, digits, - and _.");
    else if (ids.has(p.id)) add(`panels.${i}.id`, `Two panels are both called "${p.id}".`);
    ids.add(p.id);
    if (!p.title.trim()) add(`panels.${i}.title`, "A panel needs a title.");
    if (!p.sql.trim()) add(`panels.${i}.sql`, "A panel needs a query.");
    // A title's variables count too: the API will not run a panel whose title
    // it cannot fill in either.
    for (const field of ["sql", "title"]) {
      variablesIn(p[field]).forEach((name) => {
        if (!names.has(name)) {
          add(`panels.${i}.${field}`, `{{${name}}} is not a variable of this dashboard.`);
        }
      });
    }
  });
  return errors;
}

// A 400 from the API, flattened to the same {path, message} shape. The dashboard
// plane answers with a field path; FastAPI's own validation answers with a loc
// array. Both are understood, and anything else becomes one unkeyed error.
export function fieldErrors(error) {
  const detail = error?.detail;
  const out = [];
  const push = (path, message) => {
    if (message) out.push({ path: String(path ?? ""), message: String(message) });
  };
  if (Array.isArray(detail)) {
    for (const d of detail) {
      if (!d || typeof d !== "object") continue;
      const path = Array.isArray(d.loc)
        ? d.loc.filter((x) => x !== "body").join(".")
        : (d.field ?? d.path ?? "");
      push(path, d.msg || d.message || d.error);
    }
  } else if (detail && typeof detail === "object") {
    if (detail.field || detail.path) push(detail.field || detail.path, detail.error || detail.message || detail.msg);
    else for (const [k, v] of Object.entries(detail)) if (typeof v === "string") push(k, v);
  }
  if (!out.length && error) push("", error.message || String(error));
  return out;
}

export const errorAt = (errors, path) =>
  (errors || []).filter((e) => e.path === path).map((e) => e.message).join(" ");

// --------------------------------------------------------------------------- //
// geometry
// --------------------------------------------------------------------------- //
// A panel's height in pixels is fixed by the grid, so the chart inside it can be
// sized without measuring: h rows of ROW_HEIGHT plus the gaps between them, less
// the header, the padding and the chart's own legend.
const PANEL_CHROME = 84;

export const panelHeight = (h) => clampH(h) * ROW_HEIGHT + (clampH(h) - 1) * GRID_GAP;
export const panelChartHeight = (h) => Math.max(110, panelHeight(h) - PANEL_CHROME);

// --------------------------------------------------------------------------- //
// handing a panel to the Query page
// --------------------------------------------------------------------------- //
// The Query page reads its whole state from ?q=, and only accepts a state whose
// table it knows - so a panel opens there as custom SQL over `clusters`, with
// the variables already substituted. What the user sees is the query that ran.
export function queryLinkState(sql, chart) {
  return encodeState(normalizeState({
    table: "clusters",
    mode: "sql",
    sql: String(sql || ""),
    chart: normalizeChart(chart),
    limit: 200,
  }));
}
