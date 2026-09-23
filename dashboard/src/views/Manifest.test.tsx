import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Manifest from "./Manifest";
import * as cache from "../cache";
import { answer, fails } from "../test/apiMock";
import type { ApiMock } from "../test/apiMock";
import {
  COLLECTOR_TIMINGS, MANIFEST, MANIFEST_AVAILABILITY,
} from "../test/fixtures/platform";
import { closestElement, renderThemed } from "../test/harness";

/** A data row of a table. The grid draws divs, so a row is what carries the
 * role rather than a `<tr>`. */
const GRID_ROW = '[role="row"]';

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
    manifest: MANIFEST,
    manifestAvailability: MANIFEST_AVAILABILITY,
    collectorTimings: COLLECTOR_TIMINGS,
  });
});

function open() {
  const onOpen = vi.fn();
  const user = userEvent.setup();
  const view = renderThemed(<Manifest onOpen={onOpen} />);
  return { onOpen, user, ...view };
}

// Three tables on this page carry a row per resource kind, so every lookup is
// scoped to the card it belongs to. Each card is a landmark named after its
// own heading, which is what makes that scoping a query rather than a walk.
const card = (heading: string) => screen.findByRole("region", { name: heading });

describe("what the manifest declares", () => {
  it("counts the resources that are switched on, and names the file they come from", async () => {
    open();
    expect(await screen.findByText(/2 of 3 resources/)).toBeInTheDocument();
    expect(screen.getByText("/app/config/ocp-api-manifest.yaml")).toBeInTheDocument();
  });

  it("lists what is never collected and what is kept instead", async () => {
    open();
    expect(await screen.findByText("ConfigMap values")).toBeInTheDocument();
    expect(screen.getByText("kept: key names, byte sizes, certificate subject and validity"))
      .toBeInTheDocument();
  });

  it("shows how a namespace is classified and who owns it", async () => {
    open();
    expect(await screen.findByText(/openshift-, kube-, open-cluster-management/))
      .toBeInTheDocument();
    expect(screen.getByText("odl.io/app, app.kubernetes.io/part-of")).toBeInTheDocument();
    expect(screen.getByText("openshift.io/run-level")).toBeInTheDocument();
  });

  it("shows the thresholds, including one that is a list", async () => {
    open();
    expect(await screen.findByText("certificate_expiry_days")).toBeInTheDocument();
    expect(screen.getByText("30")).toBeInTheDocument();
    expect(screen.getByText("cluster-admin")).toBeInTheDocument();
  });

  it("draws a row per declared resource, saying what each one is for", async () => {
    open();
    const row = closestElement(
      within(await card("Resources")).getByRole("gridcell", { name: "routes" }), GRID_ROW);
    expect(within(row).getByText("Route")).toBeInTheDocument();
    expect(within(row).getByText("route.openshift.io/v1")).toBeInTheDocument();
    expect(within(row).getByText("namespaced · limit 2000")).toBeInTheDocument();
    expect(within(row).getByText("enabled").closest("[data-status]"))
      .toHaveAttribute("data-status", "enabled");
    expect(within(row).getByText(/Which hostname each namespace serves/)).toBeInTheDocument();
  });

  it("says which resources are switched off", async () => {
    open();
    const row = closestElement(
      within(await card("Resources")).getByRole("gridcell", { name: "clusterserviceversions" }), GRID_ROW);
    expect(within(row).getByText("disabled").closest("[data-status]"))
      .toHaveAttribute("data-status", "disabled");
  });

  it("shows nothing but the error when the manifest cannot be read", async () => {
    answer(api, { manifest: fails("503 Service Unavailable") });
    open();
    expect(await screen.findByText(/503 Service Unavailable/)).toBeInTheDocument();
    expect(screen.queryByText("Resources")).toBeNull();
  });
});

describe("availability per cluster", () => {
  it("draws a column per cluster and a row per resource", async () => {
    open();
    const row = closestElement(
      within(await card("Availability per cluster")).getByRole("gridcell", { name: "routes" }), GRID_ROW);
    expect(within(row).getByText("24")).toBeInTheDocument();
    expect(within(row).getByText("n/a")).toBeInTheDocument();
  });

  it("says 403 where RBAC denied the read, with the reason in the title", async () => {
    open();
    const row = closestElement(within(await card("Availability per cluster"))
      .getByRole("gridcell", { name: "clusterserviceversions" }), GRID_ROW);
    const denied = within(row).getByText("403");
    expect(denied).toHaveAttribute("title",
      "clusterserviceversions.operators.coreos.com is forbidden");
    expect(within(row).getByText("—")).toBeInTheDocument();
  });

  it("opens a cluster from its column header", async () => {
    const { onOpen, user } = open();
    const matrix = await card("Availability per cluster");
    await user.click(within(matrix).getByText("ocp-prod-iad-02"));
    expect(onOpen).toHaveBeenCalledWith("ocp-prod-iad-02");
  });

  it("shows the availability failure without losing the manifest", async () => {
    answer(api, { manifestAvailability: fails("404 Not Found") });
    open();
    expect(await screen.findByText(/404 Not Found/)).toBeInTheDocument();
    expect(screen.getByText("Resources")).toBeInTheDocument();
  });
});

describe("where the collector's time goes", () => {
  it("shows what a sweep cost, and how much of it was the network", async () => {
    open();
    expect(await screen.findByText("Collection time")).toBeInTheDocument();
    expect(screen.getByText("2 of 5 clusters measured")).toBeInTheDocument();
    expect(screen.getByText("61.7%")).toBeInTheDocument();
    expect(screen.getByText("38.2%")).toBeInTheDocument();
    expect(screen.getByText(/parsing is 21% of the fetch window/)).toBeInTheDocument();
    expect(screen.getByText(/scheduled · 5 clusters · 13 MiB pulled/)).toBeInTheDocument();
  });

  it("names each stage with its p50 and p95", async () => {
    const { container } = open();
    await screen.findByText("Collection time");
    const line = container.querySelector(".muted[style]");
    expect(container.textContent).toContain("Per cluster, p50 / p95");
    expect(container.textContent).toContain("fetch");
    expect(line).toBeTruthy();
  });

  it("draws a row per cluster with what its collection cost", async () => {
    open();
    const row = closestElement(
      within(await card("Collector timing")).getByRole("gridcell", { name: "ocp-prod-sjc-01" }), GRID_ROW);
    expect(within(row).getByText("hub-west")).toBeInTheDocument();
    expect(within(row).getByText("901")).toBeInTheDocument();
    expect(within(row).getByText("21 / 9")).toBeInTheDocument();
  });

  it("says timings arrive after the next sweep when no cluster has reported any", async () => {
    answer(api, { collectorTimings: { stages: [], fleet: {}, last_run: null, clusters: [] } });
    open();
    expect(await screen.findByText(/No cluster has reported collection timings yet - they appear/))
      .toBeInTheDocument();
  });

  it("shows the timing failure without losing the rest of the page", async () => {
    answer(api, { collectorTimings: fails("404 Not Found") });
    open();
    expect(await screen.findByText(/404 Not Found/)).toBeInTheDocument();
    expect(screen.getByText("Availability per cluster")).toBeInTheDocument();
  });
});
