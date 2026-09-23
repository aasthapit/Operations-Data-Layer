import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Clusters from "./Clusters";
import * as cache from "../cache";
import { answer, fails } from "../test/apiMock";
import type { ApiMock } from "../test/apiMock";
import { closestElement, currentUrl, renderView } from "../test/harness";
import { CLUSTERS, clustersResponse } from "../test/fixtures/fleet";

vi.mock("../api", async () => {
  const { createApiMock } = await import("../test/apiMock");
  return { api: createApiMock(), BASE: "" };
});
// why: `vi.mock` above replaced the module, so what this hands back is the
// table-backed stand-in rather than the real client.
const { api } = await import("../api") as unknown as { api: ApiMock };

// The list asks twice: once with the filters, once without, for the dropdowns.
// The view hands over whatever is in the query string, so the stand-in reads
// the three keys these tests narrow on.
interface ClusterFilters {
  hub?: string;
  status?: string;
  environment?: string;
}

const filtered = (params: ClusterFilters = {}) => {
  const keep = CLUSTERS.filter((c) => (!params.hub || c.hub === params.hub)
    && (!params.status || c.overall_status === params.status)
    && (!params.environment || c.environment === params.environment));
  return clustersResponse(keep);
};

beforeEach(() => {
  vi.clearAllMocks();
  cache.invalidate();
  answer(api, { clusters: filtered });
});

const open = (at = "/clusters", onOpen = vi.fn()) => ({
  onOpen,
  ...renderView(({ route }) => <Clusters route={route} onOpen={onOpen} />, { at }),
});

describe("the table", () => {
  it("draws a row per cluster with what the fleet view is about", async () => {
    open();
    const row = closestElement(await screen.findByText("ocp-prod-iad-02"), "tr");
    expect(within(row).getByText("warning")).toBeInTheDocument();
    expect(within(row).getByText("hub-east")).toBeInTheDocument();
    expect(within(row).getByText("us-east-1 / iad1")).toBeInTheDocument();
    expect(within(row).getByText("5/6")).toBeInTheDocument();      // nodes ready / total
    expect(within(row).getByText("88%")).toBeInTheDocument();      // cpu
    expect(within(row).getByText("3")).toBeInTheDocument();        // pod issues
  });

  it("shows where a cluster is upgrading to", async () => {
    open();
    const row = closestElement(await screen.findByText("ocp-stage-iad-01"), "tr");
    expect(within(row).getByText("→ 4.16.7 (62%)")).toBeInTheDocument();
  });

  it("says usage is not available for a cluster serving no metrics", async () => {
    open();
    const row = closestElement(await screen.findByText("ocp-dev-iad-01"), "tr");
    expect(within(row).getAllByText("n/a")).toHaveLength(2);
  });

  it("counts the clusters in the footer", async () => {
    open();
    expect(await screen.findByText("5 clusters")).toBeInTheDocument();
  });

  it("opens a cluster from its row", async () => {
    const user = userEvent.setup();
    const { onOpen } = open();
    await user.click(await screen.findByText("ocp-prod-sjc-01"));
    expect(onOpen).toHaveBeenCalledWith("ocp-prod-sjc-01");
  });

  it("stands the table in while it is on the wire", () => {
    answer(api, { clusters: () => new Promise(() => {}) });
    const { container } = open();
    expect(container.querySelector(".skeleton-table")).toBeInTheDocument();
  });

  it("shows the failure in place of the table", async () => {
    answer(api, { clusters: fails("503 Service Unavailable") });
    open();
    expect(await screen.findByText(/503 Service Unavailable/)).toBeInTheDocument();
  });
});

describe("the filters", () => {
  it("builds each dropdown from the whole fleet, not from what is on screen", async () => {
    open("/clusters?hub=hub-west");
    await screen.findByText("ocp-prod-sjc-01");
    expect([...screen.getByLabelText<HTMLSelectElement>("Hub").options].map((o) => o.value))
      .toEqual(["", "hub-east", "hub-west"]);
    expect([...screen.getByLabelText<HTMLSelectElement>("OCP version").options].map((o) => o.value))
      .toEqual(["", "4.15.22", "4.16.4", "4.16.7"]);
  });

  it("narrows the query and writes the filter into the URL", async () => {
    const user = userEvent.setup();
    open();
    await user.selectOptions(await screen.findByLabelText("Hub"), "hub-west");
    expect(currentUrl()).toBe("/clusters?hub=hub-west");
    await waitFor(() => expect(screen.queryByText("ocp-prod-iad-01")).toBeNull());
    await waitFor(() => expect(api.clusters).toHaveBeenCalledWith(expect.objectContaining({ hub: "hub-west" })));
  });

  it("opens already narrowed when the link carried a filter", async () => {
    open("/clusters?status=critical");
    expect(await screen.findByText("ocp-stage-iad-01")).toBeInTheDocument();
    expect(screen.queryByText("ocp-prod-iad-01")).toBeNull();
    expect(screen.getByLabelText("Status")).toHaveValue("critical");
  });

  it("shows a filter with no dropdown of its own as a chip that can be cleared", async () => {
    const user = userEvent.setup();
    open("/clusters?team=payments&upgrading=true");
    expect(await screen.findByText(/team: payments/)).toBeInTheDocument();
    expect(screen.getByText(/upgrading: true/)).toBeInTheDocument();
    await user.click(screen.getByTitle("Clear team"));
    expect(currentUrl()).toBe("/clusters?upgrading=true");
  });

  it("clears every filter at once", async () => {
    const user = userEvent.setup();
    open("/clusters?hub=hub-east&environment=prod");
    await user.click(await screen.findByRole("button", { name: "Clear" }));
    expect(currentUrl()).toBe("/clusters");
  });

  it("offers no clear button while nothing is filtered", async () => {
    open();
    await screen.findByText("ocp-prod-iad-01");
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("says so when the filters match nothing", async () => {
    answer(api, { clusters: (params: { hub?: string }) => (params && params.hub === "hub-east"
      ? clustersResponse(CLUSTERS) : clustersResponse([])) });
    open("/clusters?hub=hub-nowhere");
    expect(await screen.findByText("No clusters match these filters.")).toBeInTheDocument();
  });
});

describe("sorting the list client-side", () => {
  it("sorts on the value a column stands for rather than on what it shows", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText("ocp-prod-iad-01");
    const names = () => screen.getAllByRole("row").slice(2)
      .map((row) => within(row).getAllByRole("cell")[0].textContent);

    await user.click(screen.getByRole("button", { name: "Nodes" }));
    expect(names()[0]).toBe("ocp-dev-iad-01");          // 0/3, the fewest nodes

    await user.click(screen.getByRole("button", { name: "CPU" }));
    // A cluster with no metrics has no percentage, so it sorts last either way.
    expect(names().at(-1)).toBe("ocp-dev-iad-01");

    await user.click(screen.getByRole("button", { name: "Checks" }));
    expect(names()[0]).toBe("ocp-prod-iad-01");         // nothing failed or warned

    await user.click(screen.getByRole("button", { name: "Apps" }));
    expect(names()[0]).toBe("ocp-dev-iad-01");          // 2 applications
  });

  it("searches the table on the text a rendered cell shows", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText("ocp-prod-iad-01");
    await user.type(screen.getByLabelText("Search this table"), "us-west-2");
    await waitFor(() => expect(screen.getAllByRole("row").slice(2)).toHaveLength(1));
    expect(screen.getByText("ocp-prod-sjc-01")).toBeInTheDocument();
  });
});
