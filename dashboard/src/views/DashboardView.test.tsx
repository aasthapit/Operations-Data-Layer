import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DashboardView from "./DashboardView";
import * as cache from "../cache";
import { answer, fails, notFound } from "../test/apiMock";
import type { ApiMock } from "../test/apiMock";
import { currentUrl, renderView } from "../test/harness";
import {
  CAPACITY_WATCH, DASHBOARD_LIST, HUB_REVIEW, HUB_REVIEW_RUN,
} from "../test/fixtures/dashboards";
import type { DashboardDefinition } from "../api/types";
import type { Params } from "../dashboards/model";

vi.mock("../api", async () => {
  const { createApiMock } = await import("../test/apiMock");
  return { api: createApiMock(), BASE: "" };
});
// why: `vi.mock` above replaced the module, so what this hands back is the
// table-backed stand-in rather than the real client.
const { api } = await import("../api") as unknown as { api: ApiMock };

const stored: Record<string, DashboardDefinition> =
  { "hub-review": HUB_REVIEW, "capacity-watch": CAPACITY_WATCH };

beforeEach(() => {
  vi.clearAllMocks();
  cache.invalidate();
  answer(api, {
    dashboards: DASHBOARD_LIST,
    dashboard: (id: string) => {
      const def = stored[id];
      if (!def) throw Object.assign(new Error("404 Not Found"), { status: 404 });
      return def;
    },
    runDashboard: (id: string, params: Params) => ({ ...HUB_REVIEW_RUN,
      dashboard: stored[id] || HUB_REVIEW,
      params: { hub: "hub-east", ...params } }),
    saveDashboard: { ok: true },
    deleteDashboard: null,
    queryBatch: { results: {} },
  });
});

const open = (id = "hub-review", at = `/dashboards/${id}`) => renderView(
  ({ route, nav }) => <DashboardView id={id} route={route} nav={nav} />, { at });

describe("running a dashboard", () => {
  it("shows the title with its variables filled in, and the snapshot it ran against",
    async () => {
      open();
      expect(await screen.findByText("Hub review - hub-east")).toBeInTheDocument();
      expect(screen.getByText(/snapshot 11/)).toBeInTheDocument();
      expect(screen.getByText("built in")).toBeInTheDocument();
    });

  it("draws every panel from the one run", async () => {
    const { container } = open();
    // The second panel's title carries a variable, so it is only itself once
    // the run has said what the parameters ended up being.
    expect(await screen.findByRole("region", { name: "Clusters on hub-east" }))
      .toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Clusters by status" })).toBeInTheDocument();
    // The panel's frame is drawn from the definition and its chart from the
    // run, so the bars land a tick after the title they sit under.
    await waitFor(() => expect(container.querySelectorAll("path.chart-bar")).toHaveLength(3));
    expect(screen.getByText("ocp-prod-iad-01")).toBeInTheDocument();
  });

  it("offers the variable's options from the run that just finished", async () => {
    open();
    // The control is drawn from the definition; its options come from the run.
    const select = await screen.findByRole<HTMLSelectElement>("combobox");
    await waitFor(() => expect([...select.options].map((o) => o.value))
      .toEqual(["", "hub-east", "hub-west"]));
    expect(select).toHaveValue("hub-east");
  });

  it("puts a variable change in the URL without stacking up history", async () => {
    const user = userEvent.setup();
    open();
    const depth = window.history.state.odl;
    // The options come from the run, so the control is on screen before them.
    await screen.findByRole("option", { name: "hub-west" });
    await user.selectOptions(screen.getByRole<HTMLSelectElement>("combobox"), "hub-west");
    expect(currentUrl()).toBe("/dashboards/hub-review?hub=hub-west");
    expect(window.history.state.odl).toBe(depth);
  });

  it("opens on the variables the link carried", async () => {
    open("hub-review", "/dashboards/hub-review?hub=hub-west");
    expect(await screen.findByRole("region", { name: "Clusters on hub-west" }))
      .toBeInTheDocument();
    expect(api.runDashboard).toHaveBeenCalledWith("hub-review", { hub: "hub-west" });
  });

  it("says a dashboard has no panels rather than drawing an empty grid", async () => {
    // The grid is drawn from the stored definition, not from the run.
    answer(api, { dashboard: () => ({ ...HUB_REVIEW, panels: [] }) });
    open();
    expect(await screen.findByText("This dashboard has no panels.")).toBeInTheDocument();
  });

  it("re-reads the definition and the run on demand", async () => {
    const user = userEvent.setup();
    const runs = vi.fn((id, params) => ({ ...HUB_REVIEW_RUN, params }));
    answer(api, { runDashboard: runs });
    open();
    await screen.findByRole("region", { name: "Clusters by status" });
    await user.click(screen.getByRole("button", { name: "↻ Refresh" }));
    await waitFor(() => expect(runs.mock.calls.length).toBeGreaterThan(1));
  });

  it("shows the run's failure above the panels", async () => {
    answer(api, { runDashboard: fails("503 Service Unavailable") });
    open();
    expect(await screen.findByText(/503 Service Unavailable/)).toBeInTheDocument();
  });

  it("goes back to the list", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByText("← All dashboards"));
    expect(currentUrl()).toBe("/dashboards");
  });

  it("hands a panel to the Query page as the SQL that actually ran", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole("region", { name: "Clusters on hub-east" });
    const panel = screen.getByRole("region", { name: "Clusters on hub-east" });
    await user.click(within(panel).getByRole("button", { name: "⋯" }));
    await user.click(screen.getByRole("menuitem", { name: "Open in Query" }));
    expect(currentUrl()).toMatch(/^\/query\?q=/);
  });
});

describe("a dashboard that will not load", () => {
  it("says there is no dashboard with that id on a 404", async () => {
    open("gone");
    expect(await screen.findByText("No dashboard called that")).toBeInTheDocument();
    expect(screen.getByText(/has no dashboard with the id "gone"/)).toBeInTheDocument();
    expect(screen.getByText(/\?fixture=1/)).toBeInTheDocument();
  });

  it("shows any other failure as it came", async () => {
    answer(api, { dashboard: fails("503 Service Unavailable"),
      runDashboard: fails("503 Service Unavailable") });
    open();
    expect(await screen.findByText("This dashboard could not be loaded")).toBeInTheDocument();
  });
});

describe("the fixture dashboard", () => {
  it("runs a sample definition through the query plane alone", async () => {
    answer(api, { queryBatch: { results: {
      "var:hub": { columns: ["value"], rows: [["hub-east"]], row_count: 1 },
      status: { columns: ["overall_status", "clusters"], column_types: ["VARCHAR", "BIGINT"],
        rows: [["healthy", 2], ["warning", 1], ["critical", 1]], row_count: 3 },
    } } });
    open("fixture-hub", "/dashboards/fixture-hub?fixture=1&hub=hub-east");
    expect(await screen.findByText("Hub overview - hub-east")).toBeInTheDocument();
    expect(screen.getByText("fixture")).toHaveClass("db-tag");
    expect(api.runDashboard).not.toHaveBeenCalled();
  });
});

describe("editing", () => {
  const openSaved = () => open("capacity-watch");

  it("offers Edit for a saved dashboard and Clone for a built-in", async () => {
    open();
    expect(await screen.findByRole("button", { name: "Clone to edit" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("turns the title and description into fields, and keeps the rows on screen", async () => {
    const user = userEvent.setup();
    openSaved();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Dashboard title")).toHaveValue("Capacity watch");
    await user.type(screen.getByLabelText("Dashboard title"), " 2026");
    expect(screen.getByLabelText("Dashboard title")).toHaveValue("Capacity watch 2026");
  });

  it("saves what was edited and says so", async () => {
    const user = userEvent.setup();
    openSaved();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.type(screen.getByLabelText("Dashboard description"), "Headroom by cluster");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.saveDashboard).toHaveBeenCalled());
    const [id, body] = api.saveDashboard.mock.calls[0];
    expect(id).toBe("capacity-watch");
    expect(body.description).toBe("Headroom by cluster");
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("refuses locally what the API would refuse, without sending it", async () => {
    const user = userEvent.setup();
    openSaved();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const panel = screen.getByRole("region", { name: "CPU headroom by cluster" });
    await user.click(within(panel).getByRole("button", { name: "⋯" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("A dashboard needs at least one panel.")).toBeInTheDocument();
    expect(api.saveDashboard).not.toHaveBeenCalled();
  });

  it("falls back to the id when the title is emptied, rather than saving a nameless one",
    async () => {
      const user = userEvent.setup();
      openSaved();
      await user.click(await screen.findByRole("button", { name: "Edit" }));
      await user.clear(screen.getByLabelText("Dashboard title"));
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(api.saveDashboard).toHaveBeenCalled());
      // The API stores the empty title and answers with the id in its place.
      expect(api.saveDashboard.mock.calls[0][1].title).toBe("");
      expect(await screen.findByText("Saved")).toBeInTheDocument();
    });

  it("puts the API's own refusal on the page", async () => {
    const user = userEvent.setup();
    answer(api, { saveDashboard: fails("only SELECT queries are allowed") });
    openSaved();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("only SELECT queries are allowed")).toBeInTheDocument();
  });

  it("leaves edit mode without saving", async () => {
    const user = userEvent.setup();
    openSaved();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Dashboard title")).toBeNull();
    expect(api.saveDashboard).not.toHaveBeenCalled();
  });

  it("opens the panel drawer, and the variables drawer, from edit mode", async () => {
    const user = userEvent.setup();
    openSaved();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Add panel" }));
    const drawer = await screen.findByRole("dialog", { name: "Add a panel" });
    await user.click(within(drawer).getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: "Variables" }));
    expect(await screen.findByRole("dialog", { name: "Variables" })).toBeInTheDocument();
  });

  it("removes a panel from the draft", async () => {
    const user = userEvent.setup();
    openSaved();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const panel = screen.getByRole("region", { name: "CPU headroom by cluster" });
    await user.click(within(panel).getByRole("button", { name: "⋯" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove" }));
    expect(await screen.findByText(/No panels yet/)).toBeInTheDocument();
  });

  it("saves under a new id from Save as", async () => {
    const user = userEvent.setup();
    openSaved();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Save as…" }));
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await waitFor(() => expect(currentUrl()).toBe("/dashboards/capacity-watch-copy"));
    expect(api.saveDashboard.mock.calls[0][0]).toBe("capacity-watch-copy");
  });

  it("clones a built-in into a dashboard of one's own", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole("button", { name: "Clone to edit" }));
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await waitFor(() => expect(currentUrl()).toBe("/dashboards/hub-review-copy"));
    const [, body] = api.saveDashboard.mock.calls[0];
    expect(body.title).toBe("Hub review - {{hub}} (copy)");
  });

  it("deletes a saved dashboard after asking, and goes back to the list", async () => {
    const user = userEvent.setup();
    openSaved();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete this dashboard" });
    expect(within(dialog).getByText(/and its 1 panels are removed for/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteDashboard).toHaveBeenCalledWith("capacity-watch"));
    expect(currentUrl()).toBe("/dashboards");
  });

  it("does not offer Delete for a built-in being cloned into a draft", async () => {
    open("hub-review", "/dashboards/hub-review?new=1");
    expect(await screen.findByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });
});

describe("a brand new dashboard", () => {
  it("starts as an empty draft rather than fetching anything", async () => {
    open("hub-capacity-review", "/dashboards/hub-capacity-review?new=1");
    expect(await screen.findByLabelText("Dashboard title")).toHaveValue("Hub capacity review");
    expect(screen.getByText(/No panels yet/)).toBeInTheDocument();
    expect(api.dashboard).not.toHaveBeenCalled();
  });

  it("leaves for the list when the draft is abandoned", async () => {
    const user = userEvent.setup();
    open("hub-capacity-review", "/dashboards/hub-capacity-review?new=1");
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(currentUrl()).toBe("/dashboards");
  });

  it("refuses to save a dashboard with no panels", async () => {
    const user = userEvent.setup();
    open("hub-capacity-review", "/dashboards/hub-capacity-review?new=1");
    await user.click(await screen.findByRole("button", { name: "Save" }));
    expect(await screen.findByText("A dashboard needs at least one panel.")).toBeInTheDocument();
  });
});

describe("a data layer without the dashboard plane", () => {
  it("falls back to fetching the definition and running it here", async () => {
    answer(api, {
      runDashboard: notFound(),
      queryBatch: { results: {
        "var:hub": { columns: ["value"], rows: [["hub-east"]], row_count: 1 },
        status: { columns: ["overall_status", "clusters"], column_types: ["VARCHAR", "BIGINT"],
          rows: [["healthy", 2], ["warning", 1]], row_count: 2 },
        clusters: { columns: ["name"], column_types: ["VARCHAR"],
          rows: [["ocp-prod-iad-01"]], row_count: 1 },
      } },
    });
    open("hub-review", "/dashboards/hub-review?hub=hub-east");
    expect(await screen.findByText("Hub review - hub-east")).toBeInTheDocument();
    expect(screen.getByText("ocp-prod-iad-01")).toBeInTheDocument();
  });
});
