import { beforeEach, describe, expect, it, vi } from "vitest";

// runtime.js remembers which endpoints answered 404 for half a minute, in
// module state - so each test gets a fresh copy of the module and a fresh set
// of api spies rather than inheriting the last test's conclusions.
vi.mock("../api", () => ({
  api: {
    queryBatch: vi.fn(),
    runSql: vi.fn(),
    runDashboard: vi.fn(),
    dashboard: vi.fn(),
    dashboards: vi.fn(),
  },
}));

let runtime;
let api;

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  ({ api } = await import("../api"));
  runtime = await import("./runtime");
});

const missing = (status = 404) => Object.assign(new Error(`${status}`), { status });
const aborted = () => Object.assign(new Error("aborted"), { name: "AbortError" });

const rows = (columns, values) => ({ columns, rows: values, row_count: values.length });

describe("runQueries", () => {
  it("answers an empty question without calling the API at all", async () => {
    const answer = await runtime.runQueries([], {});
    expect(answer).toEqual({ results: {}, generation: null, snapshot: null });
    expect(api.queryBatch).not.toHaveBeenCalled();
  });

  it("sends every panel in one batch and returns the snapshot it ran against", async () => {
    api.queryBatch.mockResolvedValue({
      results: { status: rows(["overall_status"], [["healthy"]]) },
      generation: 11,
      snapshot: { generation: 11, built_at: "2026-09-20T20:58:11+00:00" },
    });
    const queries = [{ id: "status", sql: "SELECT overall_status FROM clusters", limit: 50 }];
    const answer = await runtime.runQueries(queries, { hub: "hub-east" });
    expect(api.queryBatch).toHaveBeenCalledWith(queries, { hub: "hub-east" }, undefined);
    expect(answer.generation).toBe(11);
    expect(answer.snapshot.built_at).toBe("2026-09-20T20:58:11+00:00");
    expect(answer.results.status.row_count).toBe(1);
  });

  it("tolerates a batch response that carries no generation or snapshot", async () => {
    api.queryBatch.mockResolvedValue({});
    const answer = await runtime.runQueries([{ id: "a", sql: "SELECT 1" }], {});
    expect(answer).toEqual({ results: {}, generation: null, snapshot: null });
  });

  it("falls back to one query at a time when the batch endpoint is not there", async () => {
    api.queryBatch.mockRejectedValue(missing(404));
    api.runSql.mockResolvedValue({ ...rows(["clusters"], [[4]]), generation: 11 });
    const answer = await runtime.runQueries(
      [{ id: "status", sql: "SELECT count(*) AS clusters FROM clusters WHERE hub_name = {{hub}}" }],
      { hub: "hub-east" });
    expect(api.runSql).toHaveBeenCalledWith(
      "SELECT count(*) AS clusters FROM clusters WHERE hub_name = 'hub-east'", undefined, undefined);
    expect(answer.generation).toBe(11);
    expect(runtime.batchAvailable()).toBe(false);
  });

  it("stops trying the batch endpoint once it has answered 404", async () => {
    api.queryBatch.mockRejectedValue(missing(405));
    api.runSql.mockResolvedValue(rows(["a"], [[1]]));
    await runtime.runQueries([{ id: "a", sql: "SELECT 1" }], {});
    await runtime.runQueries([{ id: "a", sql: "SELECT 1" }], {});
    expect(api.queryBatch).toHaveBeenCalledTimes(1);
    expect(api.runSql).toHaveBeenCalledTimes(2);
  });

  it("passes a real failure of the batch endpoint straight through", async () => {
    api.queryBatch.mockRejectedValue(Object.assign(new Error("500"), { status: 500 }));
    await expect(runtime.runQueries([{ id: "a", sql: "SELECT 1" }], {})).rejects.toThrow("500");
    expect(runtime.batchAvailable()).toBe(true);
  });

  it("lets an abort cancel the run rather than becoming a per-panel error", async () => {
    api.queryBatch.mockRejectedValue(aborted());
    await expect(runtime.runQueries([{ id: "a", sql: "SELECT 1" }], {})).rejects.toThrow("aborted");
  });

  it("makes one failing query that panel's error and still runs the others", async () => {
    api.queryBatch.mockRejectedValue(missing());
    api.runSql
      .mockRejectedValueOnce(new Error("unknown table 'pods'"))
      .mockResolvedValueOnce(rows(["clusters"], [[4]]));
    const answer = await runtime.runQueries([
      { id: "bad", sql: "SELECT * FROM pods" },
      { id: "good", sql: "SELECT count(*) AS clusters FROM clusters" },
    ], {});
    expect(answer.results.bad).toEqual({ error: "unknown table 'pods'", sql: "SELECT * FROM pods" });
    expect(answer.results.good.row_count).toBe(1);
  });

  it("aborts the whole one-at-a-time fallback when the view goes away", async () => {
    api.queryBatch.mockRejectedValue(missing());
    api.runSql.mockRejectedValue(aborted());
    await expect(runtime.runQueries([{ id: "a", sql: "SELECT 1" }], {})).rejects.toThrow("aborted");
  });
});

describe("runLocally", () => {
  const definition = {
    id: "hub-review",
    title: "Hub review",
    variables: [{ name: "hub", type: "select", required: true,
      sql: "SELECT DISTINCT hub_name AS value FROM clusters ORDER BY 1" }],
    panels: [
      { id: "status", title: "Clusters on {{hub}}",
        sql: "SELECT overall_status FROM clusters WHERE hub_name = {{hub}}" },
      { id: "fleet", title: "Whole fleet", sql: "SELECT count(*) AS clusters FROM clusters" },
    ],
  };

  it("runs the options query and the panels, and answers in the run endpoint's shape", async () => {
    api.queryBatch
      .mockResolvedValueOnce({ results: {
        "var:hub": rows(["value"], [["hub-east"], ["hub-west"]]),
      } })
      .mockResolvedValueOnce({ results: {
        status: rows(["overall_status"], [["healthy"]]),
        fleet: rows(["clusters"], [[5]]),
      }, generation: 11 });

    const answer = await runtime.runLocally(definition, { hub: "hub-east" });
    expect(answer.local).toBe(true);
    expect(answer.params).toEqual({ hub: "hub-east" });
    expect(answer.variables.hub.options).toEqual([
      { value: "hub-east", label: "hub-east" },
      { value: "hub-west", label: "hub-west" },
    ]);
    expect(Object.keys(answer.results).sort()).toEqual(["fleet", "status"]);
    expect(answer.generation).toBe(11);
  });

  it("turns a panel waiting on a variable into the run endpoint's own refusal", async () => {
    api.queryBatch
      .mockResolvedValueOnce({ results: { "var:hub": rows(["value"], [["hub-east"]]) } })
      .mockResolvedValueOnce({ results: { fleet: rows(["clusters"], [[5]]) } });

    const answer = await runtime.runLocally(definition, {});
    expect(answer.results.status.error).toBe("variable hub is not set");
    expect(answer.results.fleet.row_count).toBe(1);
    // The unrunnable panel is not sent, so only the other one is asked for.
    expect(api.queryBatch.mock.calls[1][0].map((q) => q.id)).toEqual(["fleet"]);
  });

  it("refuses a panel whose title names an unset variable, even when its SQL does not", async () => {
    const titled = { ...definition, variables: [{ name: "hub", type: "text" }],
      panels: [{ id: "p", title: "On {{hub}}", sql: "SELECT 1" }] };
    api.queryBatch.mockResolvedValue({ results: {} });
    const answer = await runtime.runLocally(titled, {});
    expect(answer.results.p.error).toBe("variable hub is not set");
  });

  it("fills a variable's default in before the panels are run", async () => {
    const withDefault = { ...definition,
      variables: [{ name: "hub", type: "text", default: "hub-west" }] };
    api.queryBatch.mockResolvedValue({ results: { status: rows(["a"], [[1]]),
      fleet: rows(["a"], [[1]]) } });
    const answer = await runtime.runLocally(withDefault, {});
    expect(answer.params).toEqual({ hub: "hub-west" });
  });

  it("reads label as well as value, drops blanks and keeps the first of a duplicate", async () => {
    api.queryBatch
      .mockResolvedValueOnce({ results: { "var:hub": {
        columns: ["value", "label"],
        rows: [["hub-east", "Hub east"], ["hub-east", "again"], [null, "skip"], ["", "skip"]],
      } } })
      .mockResolvedValueOnce({ results: {} });
    const answer = await runtime.runLocally(definition, { hub: "hub-east" });
    expect(answer.variables.hub.options).toEqual([{ value: "hub-east", label: "Hub east" }]);
  });

  it("says why a variable has no options rather than drawing an empty fleet", async () => {
    api.queryBatch
      .mockResolvedValueOnce({ results: { "var:hub": { error: "unknown table 'hubz'" } } })
      .mockResolvedValueOnce({ results: {} });
    const answer = await runtime.runLocally(definition, { hub: "hub-east" });
    expect(answer.variables.hub).toEqual({ options: [], error: "unknown table 'hubz'" });
  });

  it("names the column an options query has to return when it did not", async () => {
    api.queryBatch
      .mockResolvedValueOnce({ results: { "var:hub": rows(["hub_name"], [["hub-east"]]) } })
      .mockResolvedValueOnce({ results: {} });
    const answer = await runtime.runLocally(definition, { hub: "hub-east" });
    expect(answer.variables.hub.error)
      .toBe("the options query must return a column named 'value'");
  });

  it("gives a variable with no options query an empty list without asking for one", async () => {
    const plain = { ...definition, variables: [{ name: "days", type: "number", default: 7 }],
      panels: [{ id: "p", title: "t", sql: "SELECT 1" }] };
    api.queryBatch.mockResolvedValue({ results: { p: rows(["a"], [[1]]) } });
    const answer = await runtime.runLocally(plain, {});
    expect(answer.variables.days).toEqual({ options: [] });
    // One batch, for the panels: an empty set of options queries is not asked.
    expect(api.queryBatch).toHaveBeenCalledTimes(1);
    expect(api.queryBatch.mock.calls[0][0].map((q) => q.id)).toEqual(["p"]);
  });
});

describe("descriptors", () => {
  it("lists the fixture dashboards without touching the API", async () => {
    const descriptor = runtime.listDescriptor({ fixture: true });
    expect(descriptor.url).toBe("fixture:/api/dashboards");
    const answer = await descriptor.load();
    expect(answer.dashboards.map((d) => d.id)).toEqual(["fixture-hub", "fixture-fleet"]);
    expect(api.dashboards).not.toHaveBeenCalled();
  });

  it("hands the list straight to the API when the fixture was not asked for", () => {
    api.dashboards.mockReturnValue({ url: "/api/dashboards" });
    expect(runtime.listDescriptor().url).toBe("/api/dashboards");
  });

  it("loads a fixture definition by id and says so when there is no such fixture", async () => {
    const found = await runtime.definitionDescriptor("fixture-hub", { fixture: true }).load();
    expect(found.title).toBe("Hub overview - {{hub}}");
    await expect(runtime.definitionDescriptor("nope", { fixture: true }).load())
      .rejects.toThrow('No fixture dashboard called "nope".');
  });

  it("asks the API for a stored definition", () => {
    api.dashboard.mockReturnValue({ url: "/api/dashboards/hub-review" });
    expect(runtime.definitionDescriptor("hub-review").url).toBe("/api/dashboards/hub-review");
  });

  it("keys a run on the dashboard and its parameters, in a stable order", () => {
    const one = runtime.runDescriptor("hub-review", { hub: "hub-east", envs: ["prod", "stage"] });
    const other = runtime.runDescriptor("hub-review", { envs: ["prod", "stage"], hub: "hub-east" });
    expect(one.url).toBe(other.url);
    expect(one.url).toBe("/api/dashboards/hub-review/run?params=envs=prod|stage&hub=hub-east");
  });

  it("runs a dashboard through the API and normalises the definition it answers with", async () => {
    api.runDashboard.mockReturnValue({ load: async () => ({
      dashboard: { id: "hub-review", panels: [{ id: "p", sql: "SELECT 1", w: 40 }] },
      results: {},
    }) });
    const answer = await runtime.runDescriptor("hub-review", { hub: "hub-east" }).load();
    expect(answer.dashboard.panels[0].w).toBe(12);
    expect(api.runDashboard).toHaveBeenCalledWith("hub-review", { hub: "hub-east" });
  });

  it("fetches the definition and runs it here when the run endpoint is not there", async () => {
    api.runDashboard.mockReturnValue({ load: async () => { throw missing(404); } });
    api.dashboard.mockReturnValue({ load: async () => ({
      id: "hub-review", title: "Hub review",
      panels: [{ id: "p", title: "t", sql: "SELECT count(*) AS clusters FROM clusters" }],
    }) });
    api.queryBatch.mockResolvedValue({ results: { p: rows(["clusters"], [[5]]) } });

    const answer = await runtime.runDescriptor("hub-review", {}).load();
    expect(answer.local).toBe(true);
    expect(answer.results.p.row_count).toBe(1);
  });

  it("lets a 404 on the definition itself be the answer", async () => {
    api.runDashboard.mockReturnValue({ load: async () => { throw missing(404); } });
    api.dashboard.mockReturnValue({ load: async () => { throw missing(404); } });
    await expect(runtime.runDescriptor("nope", {}).load()).rejects.toMatchObject({ status: 404 });
  });

  it("runs a fixture dashboard locally and refuses one that does not exist", async () => {
    api.queryBatch.mockResolvedValue({ results: {} });
    const answer = await runtime.runDescriptor("fixture-fleet", { days: 7 }, { fixture: true }).load();
    expect(answer.dashboard.id).toBe("fixture-fleet");
    expect(() => runtime.runDescriptor("nope", {}, { fixture: true }).load())
      .toThrow('No fixture dashboard called "nope".');
  });

  it("keys a draft on what changes its rows, so retitling a panel does not re-query", () => {
    const draft = { id: "draft", panels: [{ id: "p", sql: "SELECT 1", limit: 50, title: "One" }],
      variables: [] };
    const retitled = { ...draft, panels: [{ ...draft.panels[0], title: "Two" }] };
    const rewritten = { ...draft, panels: [{ ...draft.panels[0], sql: "SELECT 2" }] };
    expect(runtime.draftRunDescriptor(draft, {}).url)
      .toBe(runtime.draftRunDescriptor(retitled, {}).url);
    expect(runtime.draftRunDescriptor(draft, {}).url)
      .not.toBe(runtime.draftRunDescriptor(rewritten, {}).url);
  });

  it("runs a draft here, because an unsaved dashboard is nowhere to ask for", async () => {
    api.queryBatch.mockResolvedValue({ results: { p: rows(["a"], [[1]]) } });
    const draft = { id: "draft", title: "Draft",
      panels: [{ id: "p", title: "t", sql: "SELECT 1" }], variables: [] };
    const answer = await runtime.draftRunDescriptor(draft, {}).load();
    expect(answer.local).toBe(true);
    expect(api.runDashboard).not.toHaveBeenCalled();
  });
});
