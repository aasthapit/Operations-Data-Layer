import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Metrics from "./Metrics";
import * as cache from "../cache";
import { answer, fails } from "../test/apiMock";
import { currentUrl, renderView } from "../test/harness";
import {
  CAPACITY_BY_CLUSTER, CAPACITY_BY_HUB, METRICS_HEALTH, METRICS_HEALTH_DOWN, TOP_NAMESPACES,
  TOP_NODES,
} from "../test/fixtures/platform";

vi.mock("../api", async () => {
  const { createApiMock } = await import("../test/apiMock");
  return { api: createApiMock(), BASE: "" };
});
const { api } = await import("../api");

const memoryNamespaces = {
  by: "memory", unit: "bytes",
  results: [{ namespace: "checkout-prod", cluster: "ocp-prod-iad-02", class: "application",
    team: "payments", value: 12884901888 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  cache.invalidate();
  answer(api, {
    metricsHealth: METRICS_HEALTH,
    topNamespaces: (by) => (by === "memory" ? memoryNamespaces : TOP_NAMESPACES),
    topNodes: TOP_NODES,
    capacity: (groupBy) => (groupBy === "hub" ? CAPACITY_BY_HUB : CAPACITY_BY_CLUSTER),
  });
});

const open = (at = "/utilization", onOpen = vi.fn()) => ({
  onOpen,
  ...renderView(({ route }) => <Metrics route={route} onOpen={onOpen} />, { at }),
});

describe("metrics availability", () => {
  it("names the clusters that are not serving metrics", async () => {
    open();
    expect(await screen.findByText(/Metrics available on 4\/5 clusters/)).toBeInTheDocument();
    expect(screen.getByText(/missing on: ocp-dev-iad-01/)).toBeInTheDocument();
  });

  it("says usage is unknown when no cluster serves metrics at all", async () => {
    answer(api, { metricsHealth: METRICS_HEALTH_DOWN });
    open();
    expect(await screen.findByText(/No cluster is serving metrics.k8s.io yet/)).toBeInTheDocument();
  });
});

describe("the top lists", () => {
  it("names each namespace with the cluster and the team behind it", async () => {
    open();
    expect(await screen.findByText("checkout-prod")).toBeInTheDocument();
    expect(screen.getByText("· ocp-prod-iad-02 · payments")).toBeInTheDocument();
    expect(screen.getByText("· ocp-prod-iad-02 · platform")).toBeInTheDocument();
    expect(screen.getByText("6.02 cores")).toBeInTheDocument();
  });

  it("reads nodes as a percentage of what they can hold", async () => {
    open();
    expect(await screen.findByText("ip-10-4-1-21.ec2.internal")).toBeInTheDocument();
    expect(screen.getByText("92.4%")).toBeInTheDocument();
  });

  it("opens the cluster a row is about", async () => {
    const user = userEvent.setup();
    const { onOpen } = open();
    await user.click(await screen.findByText("checkout-prod"));
    expect(onOpen).toHaveBeenCalledWith("ocp-prod-iad-02");
  });

  it("switches to memory, in bytes, and puts that in the URL", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole("button", { name: "Memory" }));
    expect(currentUrl()).toBe("/utilization?by=memory");
    expect(await screen.findByText("12.0 GiB")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Top namespaces by memory" })).toBeInTheDocument();
  });

  it("narrows the namespaces to one class", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole("button", { name: "Platform" }));
    expect(currentUrl()).toBe("/utilization?class=platform");
    expect(api.topNamespaces).toHaveBeenCalledWith("cpu", 10, "platform");
  });

  it("says there is no usage yet rather than drawing an empty list", async () => {
    answer(api, { topNamespaces: { by: "cpu", unit: "cores", results: [] },
      topNodes: { by: "cpu", unit: "percent", results: [] } });
    open();
    expect(await screen.findAllByText("No usage data yet.")).toHaveLength(2);
  });

  it("shows a failed top list without losing the other one", async () => {
    answer(api, { topNodes: fails("500 Internal Server Error") });
    open();
    expect(await screen.findByText(/500 Internal Server Error/)).toBeInTheDocument();
    expect(screen.getByText("checkout-prod")).toBeInTheDocument();
  });
});

describe("capacity headroom", () => {
  it("shows used against allocatable, and the headroom left, per cluster", async () => {
    open();
    const row = (await screen.findByText("ocp-prod-iad-02")).closest("tr");
    expect(within(row).getByText("80.9")).toBeInTheDocument();
    expect(within(row).getByText(/\/ 91.5 · 88.4%/)).toBeInTheDocument();
    expect(within(row).getByText("10.6")).toBeInTheDocument();
    expect(within(row).getByText("76.9 GiB")).toBeInTheDocument();   // headroom
  });

  it("regroups, and says so in the URL", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole("button", { name: "Hub" }));
    expect(currentUrl()).toBe("/utilization?group=hub");
    expect(await screen.findByRole("cell", { name: "hub-east" })).toBeInTheDocument();
    expect(screen.getByText("(3 w/ metrics)")).toBeInTheDocument();
  });

  it("opens a cluster from the capacity table, but a hub is not a page", async () => {
    const user = userEvent.setup();
    const { onOpen } = open();
    await user.click(await screen.findByRole("cell", { name: "ocp-prod-sjc-01" }));
    expect(onOpen).toHaveBeenCalledWith("ocp-prod-sjc-01");

    onOpen.mockClear();
    await user.click(screen.getByRole("button", { name: "Hub" }));
    await user.click(await screen.findByRole("cell", { name: "hub-west" }));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("opens on the grouping the link carried, falling back for one it does not know", async () => {
    open("/utilization?group=galaxy");
    await screen.findByRole("cell", { name: "ocp-prod-iad-02" });
    await waitFor(() => expect(api.capacity).toHaveBeenCalledWith("cluster"));
  });

  it("shows the capacity failure in place of the table", async () => {
    answer(api, { capacity: fails("503 Service Unavailable") });
    open();
    expect(await screen.findByText(/503 Service Unavailable/)).toBeInTheDocument();
  });
});
