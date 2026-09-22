import { describe, expect, it } from "vitest";
import {
  DEFAULT_H, DEFAULT_W, MAX_PANELS, chartFromWire, clampH, clampW, effectiveParams,
  emptyDefinition, emptyPanel, errorAt, fieldErrors, forSave, hasValue, interpolateText,
  isSlug, normalizeDefinition, normalizePanel, normalizeVariable, panelChartHeight,
  panelHeight, paramsFromQuery, queryLinkState, queryValue, slugify, sqlLiteral,
  substituteSql, titleFromId, unsetVariableIn, validateDefinition, variableByName,
  variableLabel, variablesIn,
} from "./model";
import { decodeState } from "../query/builder";

describe("hasValue", () => {
  it("treats null, undefined, the empty string and the empty list as unset", () => {
    [null, undefined, "", []].forEach((v) => expect(hasValue(v)).toBe(false));
  });

  it("treats zero and false as values, because a variable may legitimately be either", () => {
    expect(hasValue(0)).toBe(true);
    expect(hasValue(false)).toBe(true);
    expect(hasValue(["hub-east"])).toBe(true);
  });
});

describe("chartFromWire", () => {
  it("translates the vocabulary a dashboard author writes into the chart's own", () => {
    expect(chartFromWire({ type: "table" }).type).toBe("none");
    expect(chartFromWire({ type: "bar", x: "status", y: "clusters" }))
      .toEqual({ type: "bars", x: "status", series: null, y: ["clusters"], stack: false });
    expect(chartFromWire({ type: "lines" }).type).toBe("line");
    expect(chartFromWire({ type: "column" }).type).toBe("bars");
  });

  it("accepts what this build writes back unchanged", () => {
    const own = { type: "line", x: "hour", series: "cluster", y: ["health_score"], stack: true };
    expect(chartFromWire(own)).toEqual(own);
  });

  it("falls back to auto for a missing or unrecognised chart", () => {
    expect(chartFromWire(null)).toEqual({ type: "auto", x: "", series: null, y: [], stack: false });
    expect(chartFromWire({ type: "sankey" }).type).toBe("auto");
  });
});

describe("normalizePanel", () => {
  it("names an unnamed panel after its position and clamps its size to the grid", () => {
    const panel = normalizePanel({ sql: "SELECT 1", w: 99, h: 0 }, 2);
    expect(panel.id).toBe("p3");
    expect(panel.w).toBe(12);
    expect(panel.h).toBe(1);
  });

  it("keeps a positive row limit and drops anything else", () => {
    expect(normalizePanel({ limit: "50" }).limit).toBe(50);
    expect(normalizePanel({ limit: 0 }).limit).toBeNull();
    expect(normalizePanel({ limit: "lots" }).limit).toBeNull();
  });

  it("gives a panel with nothing set the grid's defaults", () => {
    const panel = normalizePanel({});
    expect([panel.w, panel.h]).toEqual([DEFAULT_W, DEFAULT_H]);
    expect(panel.title).toBe("");
  });
});

describe("normalizeVariable", () => {
  it("drops the options query when the type cannot have one", () => {
    const variable = normalizeVariable({ name: "days", type: "number", sql: "SELECT 1", multi: true });
    expect(variable.sql).toBe("");
    expect(variable.multi).toBe(false);
  });

  it("falls back to a select for an unknown type and names an unnamed variable", () => {
    const variable = normalizeVariable({ type: "slider" }, 1);
    expect(variable.type).toBe("select");
    expect(variable.name).toBe("var2");
  });

  it("keeps a default of zero rather than turning it into the empty string", () => {
    expect(normalizeVariable({ name: "days", type: "number", default: 0 }).default).toBe(0);
    expect(normalizeVariable({ name: "hub" }).default).toBe("");
  });
});

describe("normalizeDefinition", () => {
  it("falls back to the id for a definition the API answered without a title", () => {
    expect(normalizeDefinition({ id: "hub-review" }).title).toBe("hub-review");
    expect(normalizeDefinition({}, "capacity-watch").title).toBe("capacity-watch");
  });

  it("survives a definition whose panels and variables are missing or not lists", () => {
    const def = normalizeDefinition({ id: "x", panels: "nope", variables: null });
    expect(def.panels).toEqual([]);
    expect(def.variables).toEqual([]);
  });
});

describe("titleFromId and slugify", () => {
  it("turns an id into a sentence and a sentence back into an id", () => {
    expect(titleFromId("hub-capacity-review")).toBe("Hub capacity review");
    expect(slugify("Hub capacity review!")).toBe("hub-capacity-review");
  });

  it("caps a slug at 60 characters and trims the dashes off both ends", () => {
    expect(slugify("  --Hub review--  ")).toBe("hub-review");
    expect(slugify("x".repeat(80))).toHaveLength(60);
  });

  it("accepts only a lower-case slug as an id", () => {
    expect(isSlug("hub-review_2")).toBe(true);
    expect(isSlug("Hub-Review")).toBe(false);
    expect(isSlug("-hub")).toBe(false);
    expect(isSlug("")).toBe(false);
  });
});

describe("forSave", () => {
  it("sends the stored shape without the fields the server owns", () => {
    const def = normalizeDefinition({
      id: "hub-review", title: "Hub review", description: "", builtin: true,
      updated_at: "2026-09-19T08:00:00+00:00",
      variables: [{ name: "hub", type: "select", sql: "SELECT 1", required: true }],
      panels: [{ id: "status", title: "Status", sql: "SELECT 1", w: 4, h: 2 }],
    });
    const body = forSave(def);
    expect(body).not.toHaveProperty("builtin");
    expect(body).not.toHaveProperty("updated_at");
    expect(body.variables[0]).toEqual({ name: "hub", label: "hub", type: "select",
      sql: "SELECT 1", required: true });
    expect(body.panels[0].description).toBeUndefined();
  });

  it("keeps a default of zero, which hasValue calls a value", () => {
    const def = normalizeDefinition({ id: "d",
      variables: [{ name: "days", type: "number", default: 0 }] });
    expect(forSave(def).variables[0].default).toBe(0);
  });
});

describe("variablesIn", () => {
  it("finds each distinct placeholder once, in the order it appears", () => {
    expect(variablesIn("SELECT * FROM t WHERE hub = {{hub}} AND env = {{ env }} AND h = {{hub}}"))
      .toEqual(["hub", "env"]);
  });

  it("ignores a placeholder that is not a name and text with none at all", () => {
    expect(variablesIn("SELECT {{1bad}}")).toEqual([]);
    expect(variablesIn(null)).toEqual([]);
  });
});

describe("sqlLiteral", () => {
  it("quotes a string and doubles the quotes inside it, so nothing escapes the literal", () => {
    expect(sqlLiteral("hub-east")).toBe("'hub-east'");
    expect(sqlLiteral("o'brien'; DROP TABLE clusters--")).toBe("'o''brien''; DROP TABLE clusters--'");
  });

  it("writes a list as a tuple for IN, and an empty list as one that matches nothing", () => {
    expect(sqlLiteral(["prod", "stage"])).toBe("('prod', 'stage')");
    expect(sqlLiteral([])).toBe("(NULL)");
  });

  it("writes numbers, booleans and nothing-at-all as themselves", () => {
    expect(sqlLiteral(7)).toBe("7");
    expect(sqlLiteral(true)).toBe("TRUE");
    expect(sqlLiteral(false)).toBe("FALSE");
    expect(sqlLiteral(null)).toBe("NULL");
    expect(sqlLiteral(Number.NaN)).toBe("'NaN'");
  });
});

describe("substituteSql", () => {
  it("replaces a set variable with its escaped literal", () => {
    expect(substituteSql("WHERE hub_name = {{hub}}", { hub: "hub-east" }))
      .toBe("WHERE hub_name = 'hub-east'");
  });

  it("leaves a placeholder with no value visible rather than quietly matching nothing", () => {
    expect(substituteSql("WHERE hub_name = {{hub}}", {})).toBe("WHERE hub_name = {{hub}}");
  });
});

describe("interpolateText", () => {
  it("reads a title as text, joining a multi-select with commas", () => {
    expect(interpolateText("Clusters on {{hub}}", { hub: "hub-east" })).toBe("Clusters on hub-east");
    expect(interpolateText("Clusters in {{envs}}", { envs: ["prod", "stage"] }))
      .toBe("Clusters in prod, stage");
  });

  it("leaves a visible gap for an unset variable rather than a literal placeholder", () => {
    expect(interpolateText("Clusters on {{hub}}", {})).toBe("Clusters on …");
    expect(interpolateText("Clusters in {{envs}}", { envs: [] })).toBe("Clusters in …");
  });
});

describe("paramsFromQuery and effectiveParams", () => {
  const def = normalizeDefinition({
    id: "d",
    variables: [
      { name: "hub", type: "select" },
      { name: "envs", type: "select", multi: true, default: "prod" },
      { name: "days", type: "number", default: 7 },
    ],
  });

  it("reads a multi-select as a list and a number as a number", () => {
    expect(paramsFromQuery(def, { hub: "hub-east", envs: "prod,stage", days: "14" }))
      .toEqual({ hub: "hub-east", envs: ["prod", "stage"], days: 14 });
  });

  it("ignores a query key the dashboard does not declare", () => {
    expect(paramsFromQuery(def, { fixture: "1" })).toEqual({});
  });

  it("keeps a number variable the user typed words into as the words", () => {
    expect(paramsFromQuery(def, { days: "lots" })).toEqual({ days: "lots" });
  });

  it("fills in each declared default where the URL is silent", () => {
    expect(effectiveParams(def, { hub: "hub-west" }))
      .toEqual({ hub: "hub-west", envs: ["prod"], days: 7 });
  });

  it("drops the empty strings the URL carries for a cleared variable", () => {
    expect(effectiveParams(def, { hub: "" }).hub).toBeUndefined();
  });

  it("takes the first value when a list arrives for a single-value variable", () => {
    expect(effectiveParams(def, { hub: ["hub-east", "hub-west"] }).hub).toBe("hub-east");
  });
});

describe("queryValue and the variable helpers", () => {
  it("writes a list into the query string as a comma-separated value", () => {
    expect(queryValue(["prod", "stage"])).toBe("prod,stage");
    expect(queryValue(null)).toBe("");
    expect(queryValue(7)).toBe("7");
  });

  it("labels a variable by its label, falling back to its name", () => {
    expect(variableLabel({ name: "hub", label: "Hub" })).toBe("Hub");
    expect(variableLabel({ name: "hub", label: "" })).toBe("hub");
  });

  it("finds a variable by name and answers null for one that is not declared", () => {
    const def = normalizeDefinition({ id: "d", variables: [{ name: "hub" }] });
    expect(variableByName(def, "hub").name).toBe("hub");
    expect(variableByName(def, "region")).toBeNull();
  });
});

describe("unsetVariableIn", () => {
  it("reads the variable's name out of the run's own refusal", () => {
    expect(unsetVariableIn("variable hub is not set")).toBe("hub");
    expect(unsetVariableIn('variable "envs" is not set')).toBe("envs");
  });

  it("answers null for any other message", () => {
    expect(unsetVariableIn("Binder Error: no such column")).toBeNull();
    expect(unsetVariableIn(null)).toBeNull();
  });
});

describe("validateDefinition", () => {
  const valid = () => normalizeDefinition({
    id: "hub-review",
    title: "Hub review",
    variables: [{ name: "hub", type: "select", sql: "SELECT DISTINCT hub_name AS value FROM clusters" }],
    panels: [{ id: "status", title: "Clusters on {{hub}}",
      sql: "SELECT overall_status FROM clusters WHERE hub_name = {{hub}}" }],
  });

  it("passes a definition whose panels only name variables it declares", () => {
    expect(validateDefinition(valid())).toEqual([]);
  });

  it("refuses an id or a title that cannot be saved", () => {
    const def = { ...valid(), id: "Hub Review", title: "  " };
    const paths = validateDefinition(def).map((e) => e.path);
    expect(paths).toContain("id");
    expect(paths).toContain("title");
  });

  it("names the variable position when two variables share a name", () => {
    const def = normalizeDefinition({ ...valid(),
      variables: [{ name: "hub", type: "text" }, { name: "hub", type: "text" }] });
    expect(errorAt(validateDefinition(def), "variables.1.name"))
      .toBe('Two variables are both called "hub".');
  });

  it("refuses a variable named after a query-string key the page owns", () => {
    const def = normalizeDefinition({ ...valid(), variables: [{ name: "fixture", type: "text" }] });
    expect(errorAt(validateDefinition(def), "variables.0.name"))
      .toBe('"fixture" is reserved by the page itself.');
  });

  it("refuses a name that is not a lower-case identifier", () => {
    const def = normalizeDefinition({ ...valid(), variables: [{ name: "Hub Name", type: "text" }] });
    expect(errorAt(validateDefinition(def), "variables.0.name")).toContain("lower case letters");
  });

  it("requires a select variable to say where its options come from", () => {
    const def = normalizeDefinition({ ...valid(), variables: [{ name: "hub", type: "select" }] });
    expect(errorAt(validateDefinition(def), "variables.0.sql"))
      .toBe("A select variable needs a query for its options.");
  });

  it("refuses an options query that depends on another variable", () => {
    const def = normalizeDefinition({ ...valid(),
      variables: [{ name: "hub", type: "select", sql: "SELECT value FROM t WHERE env = {{env}}" }] });
    expect(errorAt(validateDefinition(def), "variables.0.sql"))
      .toBe("An options query may not use variables (found {{env}}).");
  });

  it("requires at least one panel and caps how many there can be", () => {
    expect(errorAt(validateDefinition(normalizeDefinition({ ...valid(), panels: [] })), "panels"))
      .toBe("A dashboard needs at least one panel.");
    const many = normalizeDefinition({ ...valid(),
      panels: Array.from({ length: MAX_PANELS + 1 }, (_, i) => ({ id: `p${i}`, title: "t", sql: "SELECT 1" })) });
    expect(errorAt(validateDefinition(many), "panels")).toContain(`at most ${MAX_PANELS} panels`);
  });

  it("names the field that carries a placeholder the dashboard does not declare", () => {
    const def = normalizeDefinition({ ...valid(), variables: [],
      panels: [{ id: "p1", title: "On {{hub}}", sql: "SELECT 1 WHERE h = {{region}}" }] });
    const errors = validateDefinition(def);
    expect(errorAt(errors, "panels.0.sql")).toBe("{{region}} is not a variable of this dashboard.");
    expect(errorAt(errors, "panels.0.title")).toBe("{{hub}} is not a variable of this dashboard.");
  });

  it("refuses two panels under one id, and a panel with no query", () => {
    const def = normalizeDefinition({ ...valid(), variables: [],
      panels: [{ id: "status", title: "A", sql: "SELECT 1" },
        { id: "status", title: "", sql: "  " }] });
    const errors = validateDefinition(def);
    expect(errorAt(errors, "panels.1.id")).toBe('Two panels are both called "status".');
    expect(errorAt(errors, "panels.1.title")).toBe("A panel needs a title.");
    expect(errorAt(errors, "panels.1.sql")).toBe("A panel needs a query.");
  });
});

describe("fieldErrors", () => {
  it("flattens FastAPI's loc array onto the same path the editor keys on", () => {
    const error = { detail: [{ loc: ["body", "panels", 0, "sql"], msg: "field required" }] };
    expect(fieldErrors(error)).toEqual([{ path: "panels.0.sql", message: "field required" }]);
  });

  it("reads the dashboard plane's own field-and-error object", () => {
    expect(fieldErrors({ detail: { field: "panels.1.sql", error: "unknown table 'pods'" } }))
      .toEqual([{ path: "panels.1.sql", message: "unknown table 'pods'" }]);
  });

  it("reads a flat map of field to message", () => {
    expect(fieldErrors({ detail: { id: "already taken", title: "too long" } }))
      .toEqual([{ path: "id", message: "already taken" }, { path: "title", message: "too long" }]);
  });

  it("falls back to one unkeyed error when the detail says nothing useful", () => {
    expect(fieldErrors(new Error("503 Service Unavailable")))
      .toEqual([{ path: "", message: "503 Service Unavailable" }]);
    expect(fieldErrors(null)).toEqual([]);
  });

  it("errorAt joins every message on one path and answers empty for the rest", () => {
    const errors = [{ path: "id", message: "one." }, { path: "id", message: "two." }];
    expect(errorAt(errors, "id")).toBe("one. two.");
    expect(errorAt(errors, "title")).toBe("");
    expect(errorAt(null, "id")).toBe("");
  });
});

describe("geometry", () => {
  it("clamps a panel's size to the grid's own limits", () => {
    expect([clampW(0), clampW(13), clampW("3"), clampW("wide")]).toEqual([1, 12, 3, DEFAULT_W]);
    expect([clampH(0), clampH(7), clampH(2.4)]).toEqual([1, 6, 2]);
  });

  it("works a panel's pixel height out of its rows and the gaps between them", () => {
    expect(panelHeight(1)).toBe(150);
    expect(panelHeight(3)).toBe(3 * 150 + 2 * 16);
  });

  it("leaves the chart the panel minus its chrome, and never less than a chart can use", () => {
    expect(panelChartHeight(3)).toBe(panelHeight(3) - 84);
    expect(panelChartHeight(1)).toBe(110);
  });
});

describe("emptyDefinition and emptyPanel", () => {
  it("names a new dashboard after its id when the user typed no title", () => {
    expect(emptyDefinition("hub-review").title).toBe("Hub review");
    expect(emptyDefinition("hub-review", "Mine").title).toBe("Mine");
  });

  it("mints a fresh panel id every time, so two new panels are not the same panel", () => {
    expect(emptyPanel().id).not.toBe(emptyPanel().id);
    expect(emptyPanel().title).toBe("New panel");
  });
});

describe("queryLinkState", () => {
  it("hands the Query page custom SQL over clusters with the chart already chosen", () => {
    const encoded = queryLinkState("SELECT name FROM clusters WHERE hub_name = 'hub-east'",
      { type: "bars", x: "name", y: ["health_score"] });
    const state = decodeState(encoded);
    expect(state.mode).toBe("sql");
    expect(state.table).toBe("clusters");
    expect(state.sql).toBe("SELECT name FROM clusters WHERE hub_name = 'hub-east'");
    expect(state.chart.type).toBe("bars");
    expect(state.limit).toBe(200);
  });
});
