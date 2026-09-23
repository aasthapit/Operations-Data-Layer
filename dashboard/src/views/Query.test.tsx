import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Query from "./Query";
import * as cache from "../cache";
import { answer, fails } from "../test/apiMock";
import type { ApiMock } from "../test/apiMock";
import { currentUrl, renderView } from "../test/harness";
import { QUERY_SCHEMA, queryResult } from "../test/fixtures/platform";
import { DASHBOARD_LIST } from "../test/fixtures/dashboards";

vi.mock("../api", async () => {
  const { createApiMock } = await import("../test/apiMock");
  return { api: createApiMock(), BASE: "" };
});
// why: `vi.mock` above replaced the module, so what this hands back is the
// table-backed stand-in rather than the real client.
const { api } = await import("../api") as unknown as { api: ApiMock };

beforeEach(() => {
  vi.clearAllMocks();
  cache.invalidate();
  answer(api, {
    querySchema: QUERY_SCHEMA,
    runSql: queryResult(),
    dashboards: DASHBOARD_LIST,
  });
});

// The page replaces the URL with its own state after a short debounce, and the
// view is only rendered on /query, exactly as App does it.
const open = (at = "/query") => renderView(
  ({ route, nav }) => (route.path === "/query" ? <Query route={route} nav={nav} /> : null),
  { at });

// The SQL the page is about to run, which it shows as text rather than in a
// control - so there is no role or label to ask for.
const sql = () => (document.querySelector("[data-sql]") as HTMLElement | null)?.textContent;

describe("opening the page", () => {
  it("starts on clusters, with the columns people came for, already run", async () => {
    open();
    await screen.findByLabelText("Data set");
    await waitFor(() => expect(sql()).toContain('FROM "clusters" AS t'));
    expect(sql()).toContain('t."overall_status" AS "overall_status"');
    expect(await screen.findByText(/3 rows · 7 ms/)).toBeInTheDocument();
    expect(screen.getByText("ocp-prod-iad-01")).toBeInTheDocument();
  });

  it("says which snapshot it is querying", async () => {
    open();
    expect(await screen.findByText(/snapshot 11/)).toBeInTheDocument();
    expect(screen.getByText(/31 rows · max 500 per query/)).toBeInTheDocument();
  });

  it("offers every table the running API has, with its row count", async () => {
    open();
    const tables = await screen.findByLabelText<HTMLSelectElement>("Data set");
    expect([...tables.options].map((o) => o.textContent))
      .toEqual(["clusters (5)", "pod_issues (24)", "hubs (2)"]);
  });

  it("stands the page in while the schema is on the wire", () => {
    answer(api, { querySchema: () => new Promise(() => {}) });
    const { container } = open();
    expect(screen.getByRole("region", { name: "Query builder" })).toBeInTheDocument();
    expect(container.querySelector("[data-placeholder]")).toBeInTheDocument();
  });

  it("shows nothing but the error when the schema cannot be read", async () => {
    answer(api, { querySchema: fails("503 Service Unavailable") });
    open();
    expect(await screen.findByText(/503 Service Unavailable/)).toBeInTheDocument();
  });
});

describe("the builder", () => {
  it("writes the query as columns are chosen", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByLabelText("Data set");
    await user.click(screen.getByRole("button", { name: "none" }));
    await waitFor(() => expect(sql()).toBe("-- nothing to run yet"));
    expect(screen.getByText("Choose at least one column.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "all" }));
    await waitFor(() => expect(sql()).toContain('t."labels" AS "labels"'));
  });

  it("switches data set, and starts that table on its own columns", async () => {
    const user = userEvent.setup();
    open();
    await user.selectOptions(await screen.findByLabelText("Data set"), "pod_issues");
    await waitFor(() => expect(sql()).toContain('FROM "pod_issues" AS t'));
    expect(screen.getByText(/One row per pod that is not running cleanly/)).toBeInTheDocument();
  });

  it("offers the cluster join only where the table carries a cluster name", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByLabelText("Data set");
    expect(screen.getByRole("checkbox", { name: /Cluster context/ })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText("Data set"), "pod_issues");
    const join = await screen.findByRole("checkbox", { name: /Cluster context/ });
    expect(join).toBeEnabled();
    await user.click(join);
    await waitFor(() => expect(sql()).toContain('LEFT JOIN "clusters" AS c'));
    expect(sql()).toContain('c."hub_name" AS "cluster_hub_name"');
  });

  it("adds a filter and writes it into the WHERE clause", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByLabelText("Data set");
    await user.click(screen.getByRole("button", { name: "+ filter" }));
    await user.selectOptions(screen.getByLabelText("Filter column"), "overall_status");
    await user.type(screen.getByLabelText("Filter value"), "critical");
    await waitFor(() => expect(sql()).toContain('WHERE t."overall_status" = \'critical\''));
  });

  it("offers only the operators the column's type can answer", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByLabelText("Data set");
    await user.click(screen.getByRole("button", { name: "+ filter" }));
    await user.selectOptions(screen.getByLabelText("Filter column"), "upgrading");
    expect([...screen.getByLabelText<HTMLSelectElement>("Filter operator").options].map((o) => o.value))
      .toEqual(["istrue", "isfalse", "isnull", "notnull"]);
    await waitFor(() => expect(sql()).toContain('t."upgrading" IS TRUE'));
  });

  it("keeps a filter's operator when the new column can still answer it", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByLabelText("Data set");
    await user.click(screen.getByRole("button", { name: "+ filter" }));
    await user.selectOptions(screen.getByLabelText("Filter column"), "region");
    await user.type(screen.getByLabelText("Filter value"), "us-east-1");
    await user.selectOptions(screen.getByLabelText("Filter column"), "environment");
    expect(screen.getByLabelText("Filter operator")).toHaveValue("eq");
    await waitFor(() => expect(sql()).toContain('t."environment" = \'us-east-1\''));
  });

  it("takes two values for between, and says what is missing until both are there", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByLabelText("Data set");
    await user.click(screen.getByRole("button", { name: "+ filter" }));
    await user.selectOptions(screen.getByLabelText("Filter column"), "health_score");
    await user.selectOptions(screen.getByLabelText("Filter operator"), "between");
    const values = screen.getAllByLabelText("Filter value");
    expect(values).toHaveLength(2);
    await user.type(values[0], "80");
    await waitFor(() => expect(screen.getByText("Filter 1: enter a value.")).toBeInTheDocument());
    await user.type(values[1], "95");
    await waitFor(() => expect(sql()).toContain('BETWEEN 80 AND 95'));
  });

  it("removes a filter", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByLabelText("Data set");
    await user.click(screen.getByRole("button", { name: "+ filter" }));
    await user.click(screen.getByRole("button", { name: "Remove filter" }));
    expect(screen.queryByLabelText("Filter column")).toBeNull();
  });

  it("joins several filters with all-of or any-of", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByLabelText("Data set");
    await user.click(screen.getByRole("button", { name: "+ filter" }));
    await user.type(screen.getByLabelText("Filter value"), "prod");
    await user.click(screen.getByRole("button", { name: "+ filter" }));
    await user.type(screen.getAllByLabelText("Filter value")[1], "stage");
    await waitFor(() => expect(sql()).toContain("\n  AND "));
    await user.click(screen.getByRole("button", { name: "any of" }));
    await waitFor(() => expect(sql()).toContain("\n   OR "));
  });

  it("sorts, and drops a sort that is no longer in the output", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByLabelText("Data set");
    await user.selectOptions(screen.getByLabelText("Sort direction"), "desc");
    await waitFor(() => expect(sql()).toContain('ORDER BY "name" DESC'));
    await user.click(screen.getByRole("button", { name: "Remove sort" }));
    await waitFor(() => expect(sql()).not.toContain("ORDER BY"));
    await user.click(screen.getByRole("button", { name: "+ sort" }));
    await waitFor(() => expect(sql()).toContain("ORDER BY"));
  });

  it("groups rows, starting from the first column and a count", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByLabelText("Data set");
    await user.click(screen.getByRole("checkbox", { name: "Group rows" }));
    await waitFor(() => expect(sql()).toContain('GROUP BY t."name"'));
    expect(sql()).toContain('count(*) AS "rows"');
  });

  it("takes a column for an aggregate that needs one, and renames its output", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByLabelText("Data set");
    await user.click(screen.getByRole("checkbox", { name: "Group rows" }));
    await user.selectOptions(await screen.findByLabelText("Aggregate function"), "avg");
    await user.selectOptions(screen.getByLabelText("Aggregate column"), "health_score");
    await waitFor(() => expect(sql()).toContain('avg(t."health_score") AS "avg_health_score"'));
    await user.type(screen.getByLabelText("Aggregate name"), "mean_score");
    await waitFor(() => expect(sql()).toContain('AS "mean_score"'));
  });

  it("offers only numeric columns to an aggregate that needs one", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByLabelText("Data set");
    await user.click(screen.getByRole("checkbox", { name: "Group rows" }));
    await user.selectOptions(await screen.findByLabelText("Aggregate function"), "sum");
    expect([...screen.getByLabelText<HTMLSelectElement>("Aggregate column").options].map((o) => o.value))
      .toEqual(["", "health_score", "nodes_total"]);
  });

  it("adds and removes a group-by column and an aggregate", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByLabelText("Data set");
    await user.click(screen.getByRole("checkbox", { name: "Group rows" }));
    await user.click(await screen.findByRole("button", { name: "+ group by" }));
    expect(screen.getAllByLabelText("Group by column")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "+ aggregate" }));
    expect(screen.getAllByLabelText("Aggregate function")).toHaveLength(2);
  });

  it("writes DISTINCT and clamps the row limit to what the API allows", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByLabelText("Data set");
    await user.click(screen.getByRole("checkbox", { name: "Distinct rows" }));
    await waitFor(() => expect(sql()).toContain("SELECT DISTINCT"));

    const limit = screen.getByLabelText(/Row limit/);
    await user.clear(limit);
    await user.type(limit, "9000");
    await user.tab();
    await waitFor(() => expect(sql()).toContain("LIMIT 500"));
  });
});

describe("running it", () => {
  it("runs the SQL on the button and shows what came back", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText(/3 rows · 7 ms/);
    answer(api, { runSql: queryResult({ rows: [["ocp-prod-sjc-01", "healthy", 91]],
      row_count: 1 }) });
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText(/1 rows · 7 ms/)).toBeInTheDocument();
  });

  it("runs on Ctrl + Enter from anywhere on the page", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText(/3 rows · 7 ms/);
    const before = api.runSql.mock.calls.length;
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(api.runSql.mock.calls.length).toBeGreaterThan(before));
  });

  it("says a query was rejected rather than that it failed", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText(/3 rows · 7 ms/);
    answer(api, { runSql: fails("only SELECT queries are allowed", 400) });
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText(/Rejected: only SELECT queries are allowed/))
      .toBeInTheDocument();
  });

  it("says a query timed out", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText(/3 rows · 7 ms/);
    answer(api, { runSql: fails("the query took too long", 504) });
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText(/Timed out: the query took too long/)).toBeInTheDocument();
  });

  it("flags a truncated answer and shows the SQL the guard actually ran", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText(/3 rows · 7 ms/);
    answer(api, { runSql: queryResult({ truncated: true,
      sql: "SELECT name FROM clusters LIMIT 500" }) });
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("truncated at 3")).toBeInTheDocument();
    expect(screen.getByText("SQL that ran")).toBeInTheDocument();
  });
});

describe("custom SQL", () => {
  it("hands the builder's query to an editor, and goes back again", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByLabelText("Data set");
    await user.click(screen.getByRole("button", { name: "Edit SQL" }));
    const editor = await screen.findByLabelText<HTMLTextAreaElement>("SQL");
    expect(editor.value).toContain('FROM "clusters" AS t');
    expect(screen.getByText("custom SQL")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back to builder" }));
    await waitFor(() => expect(screen.queryByLabelText("SQL")).toBeNull());
  });

  it("runs what was typed rather than what the builder would write", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByLabelText("Data set");
    await user.click(screen.getByRole("button", { name: "Edit SQL" }));
    const editor = await screen.findByLabelText<HTMLTextAreaElement>("SQL");
    await user.clear(editor);
    await user.type(editor, "SELECT 1");
    await user.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(api.runSql).toHaveBeenLastCalledWith("SELECT 1", undefined));
  });
});

describe("asking in English", () => {
  it("runs the SQL the model wrote and explains what it assumed", async () => {
    const user = userEvent.setup();
    answer(api, { askQuery: {
      sql: "SELECT team, count(*) AS namespaces FROM namespaces GROUP BY 1",
      explanation: "Counts application namespaces per team.",
      assumptions: ["Only namespaces with a team label are counted."],
      confidence: 0.82,
      attempts: 2,
      result: queryResult({ columns: ["team", "namespaces"], rows: [["payments", 4]],
        row_count: 1 }),
    } });
    open();
    await screen.findByLabelText("Ask a question about the fleet");
    await user.type(screen.getByLabelText("Ask a question about the fleet"),
      "How many namespaces per team?");
    await user.click(screen.getByRole("button", { name: "Ask" }));

    expect(await screen.findByText("Counts application namespaces per team.")).toBeInTheDocument();
    expect(screen.getByText("Only namespaces with a team label are counted.")).toBeInTheDocument();
    expect(screen.getByText(/confidence 82%/)).toBeInTheDocument();
    expect(screen.getByText(/2 attempts/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("SQL"))
      .toHaveValue("SELECT team, count(*) AS namespaces FROM namespaces GROUP BY 1"));
  });

  it("says once that the box is unavailable, and stops offering it", async () => {
    const user = userEvent.setup();
    answer(api, { askQuery: fails("the data layer has no model credentials configured.", 503) });
    open();
    await screen.findByLabelText("Ask a question about the fleet");
    await user.type(screen.getByLabelText("Ask a question about the fleet"), "how many?");
    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText(/Not available: the data layer has no model credentials/))
      .toBeInTheDocument();
    expect(screen.getByLabelText("Ask a question about the fleet")).toBeDisabled();
  });

  it("shows the last query it tried when both attempts failed", async () => {
    const user = userEvent.setup();
    // A 422 from the query plane carries the SQL it tried in the detail.
    const error = Object.assign(new Error("both attempts failed"),
      { status: 422, detail: { error: "both attempts failed", sql: "SELECT * FROM pods" } });
    answer(api, { askQuery: () => { throw error; } });
    open();
    await screen.findByLabelText("Ask a question about the fleet");
    await user.type(screen.getByLabelText("Ask a question about the fleet"), "how many pods?");
    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText("both attempts failed")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("SQL"))
      .toHaveValue("SELECT * FROM pods"));
  });

  it("sends a dashboard-sized question to the agent instead", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByLabelText("Ask a question about the fleet");
    await user.type(screen.getByLabelText("Ask a question about the fleet"), "Review production");
    await user.click(screen.getByText("Build a dashboard from this question"));
    expect(currentUrl()).toBe("/generate?q=Review+production");
  });

  it("runs a ready-made trend query", async () => {
    const user = userEvent.setup();
    open();
    const examples = await screen.findAllByTitle(/the result charts itself/);
    await user.click(examples[0]);
    await waitFor(() => expect(screen.getByLabelText<HTMLTextAreaElement>("SQL").value).toContain("date_trunc"));
  });

  it("runs an example the schema shipped", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByTitle("Load this example query"));
    await waitFor(() => expect(screen.getByLabelText<HTMLTextAreaElement>("SQL").value)
      .toContain("WHERE overall_status <> 'healthy'"));
  });
});

describe("saved queries", () => {
  it("saves the current query under a name and loads it back", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByLabelText("Data set");
    await user.type(screen.getByPlaceholderText("name this query"), "Prod clusters");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText('Saved "Prod clusters"')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Load a saved query"), "Prod clusters");
    await waitFor(() => expect(api.runSql).toHaveBeenCalled());
  });

  it("deletes a saved query", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByLabelText("Data set");
    await user.type(screen.getByPlaceholderText("name this query"), "Prod clusters");
    await user.keyboard("{Enter}");
    await user.selectOptions(await screen.findByLabelText("Delete a saved query"),
      "Prod clusters");
    expect(await screen.findByText('Deleted "Prod clusters"')).toBeInTheDocument();
  });

  it("says nothing is saved yet", async () => {
    open();
    expect(await screen.findByText(/Nothing saved yet/)).toBeInTheDocument();
  });

  it("refuses to load a query over a table this snapshot does not have", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("odl.queries", JSON.stringify([
      { name: "Old", savedAt: null, state: { v: 1, table: "pods", columns: ["name"] } },
    ]));
    open();
    await user.selectOptions(await screen.findByLabelText("Load a saved query"), "Old");
    expect(await screen.findByText('"pods" is not in this snapshot')).toBeInTheDocument();
  });
});

describe("the results", () => {
  it("draws a chart above the table when the result can carry one", async () => {
    const user = userEvent.setup();
    answer(api, { runSql: queryResult({
      columns: ["overall_status", "clusters"], column_types: ["VARCHAR", "BIGINT"],
      rows: [["healthy", 2], ["warning", 1], ["critical", 1]], row_count: 3 }) });
    const { container } = open();
    await screen.findByText(/3 rows · 7 ms/);
    expect(await screen.findByLabelText("Chart")).toBeInTheDocument();
    await waitFor(() => expect(container.querySelectorAll("rect.MuiBarChart-element")).toHaveLength(3));
    // the chart picker is a MUI Select: it opens a listbox rather than being a
    // native <select> with options to pick from
    await user.click(screen.getByLabelText("Chart"));
    await user.click(await screen.findByRole("option", { name: "Table only" }));
    await waitFor(() => expect(container.querySelectorAll("rect.MuiBarChart-element")).toHaveLength(0));
  });

  it("says why there is no chart for a result that cannot carry one", async () => {
    open();
    expect(await screen.findByText(/No chart for this result/)).toBeInTheDocument();
  });

  it("copies the result as JSON", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    open();
    await screen.findByText(/3 rows · 7 ms/);
    await user.click(screen.getByRole("button", { name: "Copy as JSON" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(JSON.parse(writeText.mock.calls[0][0])[0].name).toBe("ocp-prod-iad-01");
    expect(await screen.findByText("3 rows copied as JSON")).toBeInTheDocument();
  });

  it("downloads the result as CSV", async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => "blob:odl-test");
    vi.stubGlobal("URL", Object.assign(Object.create(URL), URL,
      { createObjectURL, revokeObjectURL: vi.fn() }));
    // jsdom cannot follow the link the download goes through, and says so on
    // stderr in the middle of a passing run.
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    open();
    await screen.findByText(/3 rows · 7 ms/);
    await user.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(await screen.findByText("CSV downloaded")).toBeInTheDocument();
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it("copies the SQL", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    open();
    await screen.findByLabelText("Data set");
    await user.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0][0]).toContain('FROM "clusters" AS t');
  });

  it("offers the result as a panel on a dashboard", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText(/3 rows · 7 ms/);
    await user.click(screen.getByRole("button", { name: "Add to dashboard" }));
    expect(await screen.findByRole("dialog", { name: "Add to dashboard" })).toBeInTheDocument();
    const dialog = screen.getByRole("dialog", { name: "Add to dashboard" });
    expect(within(dialog).getByDisplayValue("clusters")).toBeInTheDocument();
  });

  it("says to run something when there is nothing to show", async () => {
    answer(api, { runSql: fails("only SELECT queries are allowed", 400) });
    open();
    // The page runs itself on open, so the empty state is what is left once
    // that run has come back with nothing.
    await screen.findByText(/Rejected: only SELECT queries are allowed/);
    await waitFor(() =>
      expect(screen.getByText("Run a query to see rows.")).toBeInTheDocument());
  });
});

describe("a shared link", () => {
  it("opens on the query the link carries and runs it", async () => {
    // A link minted by the page itself: custom SQL over clusters.
    const { encodeState, normalizeState } = await import("../query/builder");
    const state = normalizeState({
      table: "clusters", mode: "sql", sql: "SELECT name FROM clusters LIMIT 5", limit: 200 });
    // normalizeState refuses a state with no table, and this one names one.
    if (!state) throw new Error("the builder refused the state this link is made of");
    const encoded = encodeState(state);
    open(`/query?q=${encodeURIComponent(encoded)}`);
    await waitFor(() => expect(screen.getByLabelText("SQL"))
      .toHaveValue("SELECT name FROM clusters LIMIT 5"));
    // The field fills before the run fires (the run waits for the schema), so
    // the call is awaited rather than asserted on the spot: on a slow runner
    // the spot assertion raced it once.
    await waitFor(() =>
      expect(api.runSql).toHaveBeenCalledWith("SELECT name FROM clusters LIMIT 5", undefined));
  });

  it("falls back to the default query for a link it cannot read", async () => {
    open("/query?q=not-a-real-link");
    await waitFor(() => expect(sql()).toContain('FROM "clusters" AS t'));
  });

  it("writes the current query back into the URL", async () => {
    open();
    await screen.findByLabelText("Data set");
    await waitFor(() => expect(currentUrl()).toMatch(/^\/query\?q=/));
  });
});
