import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Overview from "./Overview";
import * as cache from "../cache";
import { answer, fails } from "../test/apiMock";
import type { ApiMock } from "../test/apiMock";
import { closestElement, currentUrl, renderView } from "../test/harness";
import {
  INSIGHTS_SUMMARY, OVERVIEW, OVERVIEW_SWEEPING, SUMMARY_BY_HUB, SUMMARY_BY_REGION,
} from "../test/fixtures/fleet";

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
    overview: OVERVIEW,
    summary: (groupBy: string) => (groupBy === "region" ? SUMMARY_BY_REGION : SUMMARY_BY_HUB),
    insightsSummary: INSIGHTS_SUMMARY,
  });
});

const open = (at = "/") => renderView(({ route, nav }) => <Overview route={route} nav={nav} />,
  { at });

describe("the fleet numbers", () => {
  it("shows what the overview counted, and the application count from insights", async () => {
    open();
    const stats = await screen.findByText("Clusters");
    const row = closestElement(stats, ".stats");
    expect(within(row).getByText("5")).toBeInTheDocument();       // clusters_total
    expect(within(row).getByText("Healthy").nextSibling).toHaveTextContent("2");
    expect(within(row).getByText("Critical").nextSibling).toHaveTextContent("1");
    expect(within(row).getByText("Upgrading").nextSibling).toHaveTextContent("1");
    await waitFor(() => expect(within(row).getByText("Applications").nextSibling)
      .toHaveTextContent("8"));
  });

  it("narrows the cluster list from a stat", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByText("Critical"));
    expect(currentUrl()).toBe("/clusters?status=critical");
  });

  it("stands the numbers in while they are on the wire", () => {
    answer(api, { overview: () => new Promise(() => {}) });
    const { container } = open();
    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
  });

  it("shows nothing but the error when the overview itself cannot be read", async () => {
    answer(api, { overview: fails("503 Service Unavailable") });
    open();
    expect(await screen.findByText(/503 Service Unavailable/)).toBeInTheDocument();
    expect(screen.queryByText("Hubs (ACM)")).toBeNull();
  });
});

describe("needs attention", () => {
  it("counts what is wrong across the fleet and opens the section it came from", async () => {
    const user = userEvent.setup();
    open();
    expect(await screen.findByText("Expired certificates")).toBeInTheDocument();
    expect(screen.getByText("MCPs degraded").parentElement).toHaveTextContent("1 updating");
    expect(screen.getByText("OLM operators unhealthy").parentElement)
      .toHaveTextContent("1 upgrades pending");
    await user.click(screen.getByText("Platform pod issues"));
    expect(currentUrl()).toBe("/insights/pods");
  });

  it("shows the insights failure in place of the counts", async () => {
    answer(api, { insightsSummary: fails("404 Not Found") });
    open();
    expect(await screen.findByText(/404 Not Found/)).toBeInTheDocument();
    expect(screen.getByText("Clusters")).toBeInTheDocument();     // the rest still renders
  });
});

describe("the hubs table", () => {
  it("draws a row per hub with its status and its last error", async () => {
    open();
    const east = closestElement(await screen.findByRole("cell", { name: "hub-east" }), "tr");
    expect(within(east).getByText("healthy")).toBeInTheDocument();
    expect(within(east).getByText("4")).toBeInTheDocument();
    const west = closestElement(screen.getByRole("cell", { name: "hub-west" }), "tr");
    expect(within(west).getByText("critical")).toBeInTheDocument();
    expect(within(west).getByText(/i\/o timeout/)).toBeInTheDocument();
  });

  it("says what the last sweep did", async () => {
    open();
    expect(await screen.findByText("Last sweep: 4 ok / 1 failed in 8421 ms")).toBeInTheDocument();
  });
});

describe("fleet health", () => {
  it("draws a card per group with its rollup and its counts", async () => {
    open();
    const east = closestElement(
      await screen.findByText("hub-east", { selector: ".gc-name" }), ".group-card");
    expect(within(east).getByText("critical")).toBeInTheDocument();
    expect(within(east).getByText("4")).toBeInTheDocument();
    expect(within(east).getByText("clusters")).toBeInTheDocument();
    expect(within(east).getByText(/\+3 ns unassigned/)).toBeInTheDocument();
  });

  it("says cluster rather than clusters for a group of one", async () => {
    open();
    const west = closestElement(
      await screen.findByText("hub-west", { selector: ".gc-name" }), ".group-card");
    expect(within(west).getByText("cluster")).toBeInTheDocument();
    expect(within(west).getByText("applications")).toBeInTheDocument();
    expect(within(west).queryByText(/ns unassigned/)).toBeNull();
  });

  it("regroups from the URL, and puts the grouping back in it", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole("button", { name: "Region" }));
    expect(currentUrl()).toBe("/?group=region");
    expect(await screen.findByText("us-east-1", { selector: ".gc-name" })).toBeInTheDocument();
  });

  it("opens on the grouping the link carried", async () => {
    open("/?group=region");
    expect(await screen.findByText("us-west-2", { selector: ".gc-name" })).toBeInTheDocument();
    expect(api.summary).toHaveBeenCalledWith("region");
  });

  it("falls back to hubs for a grouping this build does not have", async () => {
    open("/?group=phase-of-the-moon");
    await screen.findByText("hub-east", { selector: ".gc-name" });
    await waitFor(() => expect(api.summary).toHaveBeenCalledWith("hub"));
  });

  it("narrows the cluster list from a group card", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByText("hub-west", { selector: ".gc-name" }));
    expect(currentUrl()).toBe("/clusters?hub=hub-west");
  });

  it("shows the summary failure without losing the rest of the page", async () => {
    answer(api, { summary: fails("500 Internal Server Error") });
    open();
    expect(await screen.findByText(/500 Internal Server Error/)).toBeInTheDocument();
    expect(screen.getByText("Hubs (ACM)")).toBeInTheDocument();
  });
});

describe("while a sweep is running", () => {
  it("says how far it has got and which collectors are doing it", async () => {
    answer(api, { overview: OVERVIEW_SWEEPING });
    open();
    expect(await screen.findByText("sweep in progress")).toBeInTheDocument();
    expect(screen.getByText("2 of 5 clusters collected, 1 failed")).toBeInTheDocument();
    expect(screen.getByText(/hub-east 0\/2 2\/4 · hub-west 1\/2 0\/1 done/)).toBeInTheDocument();
  });

  it("re-reads itself until the sweep is done", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    answer(api, { overview: OVERVIEW_SWEEPING });
    open();
    await vi.waitFor(() => expect(screen.getByText("sweep in progress")).toBeInTheDocument());
    const before = api.overview.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => expect(api.overview.mock.calls.length).toBeGreaterThan(before));
    vi.useRealTimers();
  });

  it("says nothing at all when no sweep is running", async () => {
    open();
    await screen.findByText("Hubs (ACM)");
    expect(screen.queryByText("sweep in progress")).toBeNull();
  });
});
