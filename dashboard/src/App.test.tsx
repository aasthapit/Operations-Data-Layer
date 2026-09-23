import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as cache from "./cache";
import { answer, fails } from "./test/apiMock";
import type { ApiMock } from "./test/apiMock";
import { currentUrl, renderThemed } from "./test/harness";
import {
  INSIGHTS_SUMMARY, OPERATOR_VERSIONS, OVERVIEW, SUMMARY_BY_HUB, VERSIONS, clustersResponse,
} from "./test/fixtures/fleet";
import { CLUSTER_DETAIL, CLUSTER_TIMELINE } from "./test/fixtures/cluster";
import {
  APPLICATIONS, APPLICATION_DETAIL, CERTIFICATES, OLM_OPERATORS,
} from "./test/fixtures/insights";
import {
  CAPACITY_BY_CLUSTER, COLLECTOR_TIMINGS, MANIFEST, MANIFEST_AVAILABILITY, METRICS_HEALTH,
  PATCH_JOBS, PATCH_REPORT, QUERY_SCHEMA, TOP_NAMESPACES, TOP_NODES, queryResult,
} from "./test/fixtures/platform";
import { DASHBOARD_LIST } from "./test/fixtures/dashboards";

vi.mock("./api", async () => {
  const { createApiMock } = await import("./test/apiMock");
  return { api: createApiMock(), BASE: "" };
});
// why: `vi.mock` above replaced the module, so what this hands back is the
// table-backed stand-in rather than the real client.
const { api } = await import("./api") as unknown as { api: ApiMock };

beforeEach(() => {
  vi.clearAllMocks();
  cache.invalidate();
  answer(api, {
    overview: OVERVIEW,
    summary: SUMMARY_BY_HUB,
    insightsSummary: INSIGHTS_SUMMARY,
    clusters: clustersResponse(),
    cluster: CLUSTER_DETAIL,
    timeline: CLUSTER_TIMELINE,
    applications: APPLICATIONS,
    application: APPLICATION_DETAIL,
    versions: VERSIONS,
    operatorVersions: OPERATOR_VERSIONS,
    olmOperators: OLM_OPERATORS,
    certificates: CERTIFICATES,
    metricsHealth: METRICS_HEALTH,
    topNamespaces: TOP_NAMESPACES,
    topNodes: TOP_NODES,
    capacity: CAPACITY_BY_CLUSTER,
    querySchema: QUERY_SCHEMA,
    runSql: queryResult(),
    dashboards: DASHBOARD_LIST,
    manifest: MANIFEST,
    manifestAvailability: MANIFEST_AVAILABILITY,
    collectorTimings: COLLECTOR_TIMINGS,
    patchReport: PATCH_REPORT,
    patchJobs: PATCH_JOBS,
    agent: { available: true, model: "claude-opus-5" },
    refresh: { mode: "queued" },
  });
});

const open = (at = "/") => {
  window.history.replaceState({ odl: 0 }, "", at);
  return { user: userEvent.setup(), ...renderThemed(<App />) };
};

describe("the tab strip", () => {
  it("opens the page each tab stands for", async () => {
    const { user } = open();
    await screen.findByText("Hubs (ACM)");

    await user.click(screen.getByRole("tab", { name: "Clusters" }));
    expect(currentUrl()).toBe("/clusters");
    expect(await screen.findByText("ocp-prod-iad-01")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Versions" }));
    expect(await screen.findByText("OCP version distribution")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Utilization" }));
    expect(await screen.findByRole("heading", { name: /Top nodes by cpu/ }))
      .toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Insights" }));
    expect(currentUrl()).toBe("/insights/certificates");
    expect(await screen.findByText(/Certificates \(2\)/)).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Patching" }));
    expect(await screen.findByRole("heading", { name: "Jobs" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Collected" }));
    expect(await screen.findByText("What is collected")).toBeInTheDocument();
  });

  it("marks the tab the page belongs to", async () => {
    const { user } = open();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: "Applications" }));
    expect(screen.getByRole("tab", { name: "Applications" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "false");
  });

  it("falls back to the overview for a path nothing serves", async () => {
    open("/nowhere");
    expect(await screen.findByText("Hubs (ACM)")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("the document title", () => {
  it("names the page, so a bookmark says where it goes", async () => {
    const { user } = open();
    await waitFor(() => expect(document.title).toBe("Overview · Operations Data Layer"));
    await user.click(screen.getByRole("tab", { name: "Blast radius" }));
    await waitFor(() => expect(document.title).toBe("Blast radius · Operations Data Layer"));
  });

  it("names the thing a detail page is about", async () => {
    open("/clusters/ocp-prod-iad-02/nodes");
    await waitFor(() => expect(document.title)
      .toBe("ocp-prod-iad-02 · nodes · Operations Data Layer"));
  });

  it("names the section an insights page is on", async () => {
    open("/insights/storage");
    await waitFor(() => expect(document.title)
      .toBe("Insights · storage · Operations Data Layer"));
  });

  it("names the dashboard and the patch job a page is about", async () => {
    open("/dashboards/hub-review");
    await waitFor(() => expect(document.title)
      .toBe("Dashboards · hub-review · Operations Data Layer"));
  });
});

describe("routing to a view", () => {
  it("opens a cluster from the list and comes back", async () => {
    const { user } = open("/clusters");
    await user.click(await screen.findByText("ocp-prod-iad-02"));
    expect(currentUrl()).toBe("/clusters/ocp-prod-iad-02");
    expect(await screen.findByRole("heading", { name: "ocp-prod-iad-02" })).toBeInTheDocument();
  });

  it("opens an application, the query page and the generate page", async () => {
    const { user } = open("/applications");
    await user.click(await screen.findByText("catalog"));
    expect(await screen.findByText(/Placements/)).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Query" }));
    expect(await screen.findByLabelText("Data set")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Generate" }));
    expect(await screen.findByLabelText("Ask for a dashboard")).toBeInTheDocument();
  });

  it("opens the dashboards list and one dashboard", async () => {
    const { user } = open("/dashboards");
    await user.click(await screen.findByText("Capacity watch"));
    expect(currentUrl()).toBe("/dashboards/capacity-watch");
  });
});

describe("refreshing the fleet", () => {
  it("asks for a sweep, says it was queued, and re-reads every view in place", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    window.history.replaceState({ odl: 0 }, "", "/");
    renderThemed(<App />);
    await vi.waitFor(() => expect(screen.getByText("Hubs (ACM)")).toBeInTheDocument());

    const reads = vi.fn(() => OVERVIEW);
    answer(api, { overview: reads });
    await user.click(screen.getByRole("button", { name: /Refresh data/ }));
    await vi.waitFor(() => expect(screen.getByText("Refresh requested")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Refreshing…" })).toBeDisabled();

    await vi.advanceTimersByTimeAsync(4000);
    await vi.waitFor(() => expect(reads).toHaveBeenCalled());
    expect(screen.queryByText("Refresh requested")).toBeNull();
    vi.useRealTimers();
  });

  it("says plainly when no collector is running", async () => {
    answer(api, { refresh: fails("no collector is running", 409) });
    const { user } = open();
    await screen.findByText("Hubs (ACM)");
    await user.click(screen.getByRole("button", { name: /Refresh data/ }));
    expect(await screen.findByText("No collector is running")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Refresh data/ })).toBeEnabled();
  });

  it("says a refresh failed for any other reason", async () => {
    answer(api, { refresh: fails("503 Service Unavailable") });
    const { user } = open();
    await screen.findByText("Hubs (ACM)");
    await user.click(screen.getByRole("button", { name: /Refresh data/ }));
    expect(await screen.findByText("Refresh failed")).toBeInTheDocument();
  });
});

describe("the colour theme", () => {
  // The two palettes, read back off the page rather than off the theme object:
  // what matters is that a component ends up painted in the mode's own colour.
  const barColour = () => getComputedStyle(screen.getByRole("banner")).backgroundColor;

  it("opens in the mode the document was already in", async () => {
    // index.html resolves the mode before React mounts and writes it here, so
    // this is what the app finds when it starts.
    document.documentElement.setAttribute("data-theme", "light");
    open();
    await screen.findByText("Hubs (ACM)");
    expect(barColour()).toBe("rgb(255, 255, 255)");      // the light card surface
  });

  it("switches to the other palette, and says so in the document", async () => {
    document.documentElement.setAttribute("data-theme", "dark");
    const { user } = open();
    await screen.findByText("Hubs (ACM)");
    expect(barColour()).toBe("rgb(22, 27, 34)");         // the dark card surface

    await user.click(screen.getByRole("button", { name: "Switch to the light theme" }));
    expect(barColour()).toBe("rgb(255, 255, 255)");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("remembers the choice, so a reload opens on it", async () => {
    document.documentElement.setAttribute("data-theme", "dark");
    const { user } = open();
    await screen.findByText("Hubs (ACM)");
    await user.click(screen.getByRole("button", { name: "Switch to the light theme" }));
    expect(window.localStorage.getItem("odl.color-mode")).toBe("light");
  });
});

describe("a view that crashes", () => {
  it("shows what broke instead of blanking the app", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const swallow = (e: ErrorEvent) => e.preventDefault();
    window.addEventListener("error", swallow);
    // A response the Overview reads straight into: no counts at all.
    answer(api, { overview: { hubs: [] } });
    open();
    expect(await screen.findByText("This view failed to render")).toBeInTheDocument();
    // The chrome is still there, so there is a way out.
    expect(screen.getByRole("tab", { name: "Clusters" })).toBeInTheDocument();
    window.removeEventListener("error", swallow);
    error.mockRestore();
  });
});
