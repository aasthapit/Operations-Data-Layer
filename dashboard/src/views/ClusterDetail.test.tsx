import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ClusterDetail, { summarize } from "./ClusterDetail";
import * as cache from "../cache";
import { answer, fails } from "../test/apiMock";
import type { ApiMock } from "../test/apiMock";
import { closestElement, currentUrl, parentOf, renderView } from "../test/harness";
import {
  CLUSTER_CERTIFICATES, CLUSTER_DETAIL, CLUSTER_EVENTS, CLUSTER_NAME, CLUSTER_RESOURCES,
  CLUSTER_TIMELINE, CLUSTER_WORKLOADS,
} from "../test/fixtures/cluster";
import { CLUSTERS, clustersResponse } from "../test/fixtures/fleet";

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
    cluster: CLUSTER_DETAIL,
    timeline: CLUSTER_TIMELINE,
    clusterWorkloads: CLUSTER_WORKLOADS,
    clusterResources: CLUSTER_RESOURCES,
    certificates: CLUSTER_CERTIFICATES,
    events: CLUSTER_EVENTS,
  });
});

const open = (tab?: string) => renderView(({ nav }) => <ClusterDetail name={CLUSTER_NAME} tab={tab}
  nav={nav} />, { at: `/clusters/${CLUSTER_NAME}${tab ? `/${tab}` : ""}` });

describe("the header", () => {
  it("names the cluster, its status, its hub and its version", async () => {
    open();
    const head = parentOf(await screen.findByRole("heading", { name: CLUSTER_NAME }));
    expect(closestElement(within(head).getByText("warning"), "[data-status]"))
      .toHaveAttribute("data-status", "warning");
    expect(within(head).getByText("hub-east · 4.16.7")).toBeInTheDocument();
  });

  it("counts what is behind each sub-tab", async () => {
    open();
    const namespaces = await screen.findByRole("button", { name: /Namespaces/ });
    expect(namespaces).toHaveTextContent("72");        // 11 application + 61 platform
    expect(screen.getByRole("button", { name: /Nodes/ })).toHaveTextContent("6");
    expect(screen.getByRole("button", { name: /Operators/ })).toHaveTextContent("3");
  });

  it("moves between sub-tabs by URL", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole("button", { name: /Nodes/ }));
    expect(currentUrl()).toBe(`/clusters/${CLUSTER_NAME}/nodes`);
  });

  it("falls back to the overview for a sub-tab this build does not have", async () => {
    open("phase-of-the-moon");
    expect(await screen.findByRole("heading", { name: "Precondition checks" }))
      .toBeInTheDocument();
  });

  it("says a cluster is unreachable and shows the error it last gave", async () => {
    answer(api, { cluster: { ...CLUSTER_DETAIL, reachable: false, upgrading: true,
      desired_version: "4.16.9", upgrade_percent: 40,
      last_error: "the server could not find the requested resource" } });
    open();
    expect(await screen.findByText("unreachable")).toBeInTheDocument();
    expect(screen.getByText("upgrading → 4.16.9 (40%)")).toBeInTheDocument();
    expect(screen.getByText("the server could not find the requested resource"))
      .toBeInTheDocument();
  });

  it("goes back to the list", async () => {
    const user = userEvent.setup();
    const { back } = open();
    await user.click(await screen.findByRole("button", { name: /All clusters/ }));
    expect(back).toHaveBeenCalledWith("/clusters");
  });

  it("paints the header from the cluster list while the detail is still out", async () => {
    answer(api, { cluster: () => new Promise(() => {}) });
    cache.put(api.clusters({}).url, clustersResponse(CLUSTERS));
    open();
    const head = parentOf(await screen.findByRole("heading", { name: CLUSTER_NAME }));
    expect(closestElement(within(head).getByText("warning"), "[data-status]"))
      .toHaveAttribute("data-status", "warning");
  });

  it("shows the failure in place of the whole page", async () => {
    answer(api, { cluster: fails("404 Not Found") });
    open();
    expect(await screen.findByText(/404 Not Found/)).toBeInTheDocument();
  });
});

describe("the overview tab", () => {
  it("shows the cluster's placement, platform and network", async () => {
    open();
    expect(await screen.findByText("OVNKubernetes")).toBeInTheDocument();
    expect(screen.getByText("us-east-1 / iad1")).toBeInTheDocument();
    expect(screen.getByText("https://api.ocp-prod-iad-02.acme.example:6443")).toBeInTheDocument();
    expect(screen.getByText(/pods 10.128.0.0\/14 · services 172.30.0.0\/16/)).toBeInTheDocument();
    expect(screen.getByText("4.16.9, 4.17.1")).toBeInTheDocument();
    expect(screen.getByText("74/100")).toBeInTheDocument();
  });

  it("reads capacity as used against allocatable, with what is requested marked", async () => {
    open();
    const capacity = await screen.findByRole("region", { name: "Capacity" });
    expect(within(capacity).getByText("· live usage from metrics.k8s.io")).toBeInTheDocument();
    expect(within(capacity).getByText("80.90 cores used")).toBeInTheDocument();
    expect(within(capacity).getByText(/54.25 cores requested \(59%\)/)).toBeInTheDocument();
    expect(within(capacity).getByText(/91.50 cores allocatable/)).toBeInTheDocument();
    expect(within(capacity).getByText("726 used")).toBeInTheDocument();
  });

  it("says metrics are unavailable rather than showing usage as zero", async () => {
    answer(api, { cluster: { ...CLUSTER_DETAIL, capacity: { ...CLUSTER_DETAIL.capacity,
      metrics_available: false,
      cpu: { ...CLUSTER_DETAIL.capacity.cpu, used_cores: null, used_percent: null } } } });
    open();
    expect(await screen.findByText("metrics.k8s.io unavailable")).toBeInTheDocument();
    expect(screen.getAllByText("usage n/a").length).toBeGreaterThan(0);
  });

  it("draws the history as a line over the sweeps it has", async () => {
    const { container } = open();
    await screen.findByRole("heading", { name: "History" });
    expect(await screen.findByText("3 sweeps · health score and CPU % of allocatable"))
      .toBeInTheDocument();
    // the chart is an <svg> the library hides from assistive tech, inside the
    // labelled image the app wraps round it
    expect(screen.getByRole("img", { name: /health_score/ })).toBeInTheDocument();
  });

  it("says there is not enough history rather than drawing one point", async () => {
    answer(api, { timeline: { cluster: CLUSTER_NAME,
      snapshots: [CLUSTER_TIMELINE.snapshots[0]] } });
    open();
    expect(await screen.findByText("Not enough sweeps yet for a trend.")).toBeInTheDocument();
  });

  it("says history is unavailable when the timeline itself failed", async () => {
    answer(api, { timeline: fails("404 Not Found") });
    open();
    expect(await screen.findByText("History is unavailable.")).toBeInTheDocument();
  });

  it("lists every precondition check with its status and message", async () => {
    open();
    const checks = await screen.findByRole("region", { name: "Precondition checks" });
    expect(within(checks).getByText("All nodes ready")).toBeInTheDocument();
    expect(within(checks).getByText("5 of 6 nodes ready")).toBeInTheDocument();
    expect(within(checks).getByText("· critical")).toBeInTheDocument();
  });

  it("asks for the blast radius of this cluster's version", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole("button", { name: /Blast radius for OCP 4.16.7/ }));
    expect(currentUrl()).toBe("/blast?ocp_version=4.16.7");
  });
});

describe("the namespaces tab", () => {
  it("separates the application namespaces from the platform ones", async () => {
    open("namespaces");
    expect(await screen.findByText("Applications (1)")).toBeInTheDocument();
    expect(screen.getByText("OpenShift platform namespaces (1)")).toBeInTheDocument();
  });

  it("shows ownership only on the application table", async () => {
    open("namespaces");
    const apps = await screen.findByRole("region", { name: "Applications (1)" });
    expect(within(apps).getByRole("gridcell", { name: "payments" })).toBeInTheDocument();
    expect(within(apps).getByRole("columnheader", { name: /Tier/ })).toBeInTheDocument();
    const platform = screen.getByRole("region", { name: "OpenShift platform namespaces (1)" });
    expect(within(platform).queryByRole("columnheader", { name: /Team/ })).toBeNull();
    expect(within(platform).queryByRole("columnheader", { name: /Tier/ })).toBeNull();
  });

  it("reads a namespace's pods, restarts, usage and resource counts", async () => {
    open("namespaces");
    const row = closestElement(await screen.findByText("checkout-prod"), GRID_ROW);
    expect(within(row).getByText("+2 pending")).toBeInTheDocument();
    expect(within(row).getByText("31")).toBeInTheDocument();
    expect(within(row).getByText("6.02 cores")).toBeInTheDocument();
    expect(within(row).getByText("2 routes · 4 services · 7 configmaps · 5 secrets"))
      .toBeInTheDocument();
  });

  it("opens the application a namespace belongs to", async () => {
    const user = userEvent.setup();
    open("namespaces");
    await user.click(await screen.findByText("checkout-prod"));
    expect(currentUrl()).toBe("/applications/checkout");
  });
});

describe("the workloads tab", () => {
  it("fetches for itself, so a deep link does not wait on the cluster document", async () => {
    answer(api, { cluster: () => new Promise(() => {}) });
    open("workloads");
    expect(await screen.findByText("checkout-api")).toBeInTheDocument();
  });

  it("shows replicas, images and the age of each workload", async () => {
    open("workloads");
    const row = closestElement(await screen.findByText("checkout-api"), GRID_ROW);
    expect(within(row).getByText("degraded")).toBeInTheDocument();
    expect(within(row).getByText(/4\/6/)).toBeInTheDocument();
    expect(within(row).getByText("quay.io/acme/checkout:1.9.2")).toBeInTheDocument();
  });

  it("opens a row to show the containers, their env names and their sources", async () => {
    const user = userEvent.setup();
    open("workloads");
    await user.click(await screen.findByText("checkout-api"));
    expect(await screen.findByText("container api")).toBeInTheDocument();
    expect(screen.getByText("cpu=500m memory=1Gi")).toBeInTheDocument();
    expect(screen.getByText("= (value scrubbed)")).toBeInTheDocument();
    expect(screen.getByText("← Secret checkout-db/password")).toBeInTheDocument();
    expect(screen.getByText("← field status.podIP")).toBeInTheDocument();
    expect(screen.getByText("envFrom ← ConfigMap checkout-config")).toBeInTheDocument();
    expect(screen.getByText("via env")).toBeInTheDocument();
  });

  it("says none where a container has no env and a workload no references", async () => {
    const user = userEvent.setup();
    open("workloads");
    await user.click(await screen.findByText("router-default"));
    expect(await screen.findByText("container router")).toBeInTheDocument();
    expect(screen.getAllByText("none").length).toBeGreaterThan(0);
  });

  it("narrows to one class and to one namespace", async () => {
    const user = userEvent.setup();
    open("workloads");
    await user.click(await screen.findByRole("button", { name: "Platform" }));
    expect(api.clusterWorkloads).toHaveBeenCalledWith(CLUSTER_NAME,
      { class: "platform", namespace: "", detail: true });
    await user.selectOptions(screen.getByLabelText("Namespace"), "checkout-prod");
    expect(api.clusterWorkloads).toHaveBeenLastCalledWith(CLUSTER_NAME,
      { class: "platform", namespace: "checkout-prod", detail: true });
  });

  it("shows the workload failure in place of the table", async () => {
    answer(api, { clusterWorkloads: fails("503 Service Unavailable") });
    open("workloads");
    expect(await screen.findByText(/503 Service Unavailable/)).toBeInTheDocument();
  });
});

describe("the nodes tab", () => {
  it("draws a row per node with its state, usage and identity", async () => {
    open("nodes");
    const row = closestElement(await screen.findByText("ip-10-4-1-21.ec2.internal"), GRID_ROW);
    expect(within(row).getByText("healthy")).toBeInTheDocument();
    expect(within(row).getByText("control-plane")).toBeInTheDocument();
    expect(within(row).getByText("40%")).toBeInTheDocument();
    expect(within(row).getByText("us-east-1a · m6i.4xlarge")).toBeInTheDocument();
    expect(within(row).getByText("84 · 20.0 GiB")).toBeInTheDocument();
  });

  it("says a node is cordoned and under pressure", async () => {
    open("nodes");
    const row = closestElement(await screen.findByText("ip-10-4-2-44.ec2.internal"), GRID_ROW);
    expect(within(row).getByText("critical")).toBeInTheDocument();
    expect(within(row).getByText("cordoned")).toBeInTheDocument();
    expect(within(row).getByText("MemoryPressure")).toBeInTheDocument();
  });

  it("counts the nodes in the heading", async () => {
    open("nodes");
    expect(await screen.findByText("Nodes (2)")).toBeInTheDocument();
  });
});

describe("the issues tab", () => {
  it("lists the problem pods with what is wrong", async () => {
    open("issues");
    const row = closestElement(await screen.findByText("checkout-api-7d9f8b6c4-2xk9p"), GRID_ROW);
    expect(within(row).getByText("CrashLoopBackOff")).toBeInTheDocument();
    expect(within(row).getByText("ReplicaSet/checkout-api-7d9f8b6c4")).toBeInTheDocument();
    expect(within(row).getByText("19")).toBeInTheDocument();
    expect(await screen.findByText("Pod issues (2)")).toBeInTheDocument();
  });

  it("says a pending pod has no node yet rather than leaving the cell blank", async () => {
    open("issues");
    const row = closestElement(await screen.findByText("prometheus-k8s-1"), GRID_ROW);
    expect(within(row).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("lists the certificates expiring on this cluster", async () => {
    open("issues");
    expect(await screen.findByText("Certificates expiring (1)")).toBeInTheDocument();
    expect(screen.getByText("checkout-tls")).toBeInTheDocument();
    expect(screen.getByText("CN=checkout.acme.example")).toBeInTheDocument();
  });

  it("lists the recent warning events", async () => {
    open("issues");
    const row = closestElement(await screen.findByText("Pod/prometheus-k8s-1"), GRID_ROW);
    expect(within(row).getByText("FailedScheduling").closest("[data-tone]"))
      .toHaveAttribute("data-tone", "warning");
    expect(within(row).getByText("18")).toBeInTheDocument();
    expect(api.events).toHaveBeenCalledWith({ cluster: CLUSTER_NAME, limit: 50 });
  });

  it("shows each sub-request's failure without losing the pod issues", async () => {
    answer(api, { certificates: fails("404 Not Found"), events: fails("500 Server Error") });
    open("issues");
    expect(await screen.findByText(/404 Not Found/)).toBeInTheDocument();
    expect(screen.getByText(/500 Server Error/)).toBeInTheDocument();
    expect(screen.getByText("checkout-api-7d9f8b6c4-2xk9p")).toBeInTheDocument();
  });
});

describe("the operators tab", () => {
  it("reads each operator's state out of its conditions", async () => {
    open("operators");
    const state = async (name: string) =>
      within(closestElement(
        await screen.findByText(name), GRID_ROW)).getAllByRole("gridcell")[2].textContent;
    expect(await state("authentication")).toBe("Available");
    expect(await state("ingress")).toBe("Progressing");
    expect(await state("monitoring")).toBe("Degraded");
  });

  it("marks the operators an upgrade cannot proceed without", async () => {
    open("operators");
    const row = closestElement(await screen.findByText("authentication"), GRID_ROW);
    expect(within(row).getByText("critical").closest("[data-tone]"))
      .toHaveAttribute("data-tone", "critical");
  });

  it("asks for the blast radius of one operator version", async () => {
    const user = userEvent.setup();
    open("operators");
    const row = closestElement(await screen.findByText("ingress"), GRID_ROW);
    await user.click(within(row).getByText("blast radius →"));
    expect(currentUrl()).toBe("/blast?operator=ingress&operator_version=4.16.7");
  });

  it("says an unavailable operator is unavailable", async () => {
    answer(api, { cluster: { ...CLUSTER_DETAIL, operators: [{ name: "dns", version: "4.16.7",
      available: false, progressing: false, degraded: false, critical: false, message: "" }] } });
    open("operators");
    const row = closestElement(await screen.findByText("dns"), GRID_ROW);
    expect(within(row).getAllByRole("gridcell")[2]).toHaveTextContent("Unavailable");
  });
});

describe("the resources tab", () => {
  it("says what the cluster served, and what it did not", async () => {
    open("resources");
    const served = await screen.findByRole("region", { name: "What this cluster served" });
    expect(within(served).getByText("24")).toBeInTheDocument();
    expect(within(served).getByText("312")).toBeInTheDocument();
    expect(within(served).getByText("unavailable")).toBeInTheDocument();
    // why a kind is not there is the chip's tooltip, and the tooltip is the
    // accessible name of the thing it is on
    expect(closestElement(within(served).getByText(/clusterserviceversions/), "[aria-label]"))
      .toHaveAttribute("aria-label", "the server could not find the requested resource");
  });

  it("opens on routes and says how many were collected", async () => {
    open("resources");
    expect(await screen.findByText(/24 collected/)).toBeInTheDocument();
    expect(api.clusterResources).toHaveBeenCalledWith(CLUSTER_NAME,
      { kind: "routes", namespace: "" });
  });

  it("summarises a route the way the inventory reads it", async () => {
    open("resources");
    const row = closestElement(await screen.findByText("checkout"), GRID_ROW);
    expect(within(row).getByText(
      "checkout.apps.ocp-prod-iad-02.acme.example/ → checkout · tls edge")).toBeInTheDocument();
    expect(within(row).getByText("admitted")).toBeInTheDocument();
  });

  it("says cluster where a resource has no namespace", async () => {
    answer(api, { clusterResources: { ...CLUSTER_RESOURCES,
      resources: [{ ...CLUSTER_RESOURCES.resources[0], namespace: null, status: null }] } });
    open("resources");
    expect(await screen.findByText("cluster")).toBeInTheDocument();
  });

  it("changes the kind being listed", async () => {
    const user = userEvent.setup();
    open("resources");
    await user.selectOptions(await screen.findByLabelText("Kind"), "secrets");
    expect(api.clusterResources).toHaveBeenLastCalledWith(CLUSTER_NAME,
      { kind: "secrets", namespace: "" });
    expect(await screen.findByText(/312 collected/)).toBeInTheDocument();
  });

  it("says a kind was not collected rather than showing an empty table as a fact", async () => {
    const user = userEvent.setup();
    answer(api, { clusterResources: { ...CLUSTER_RESOURCES, resources: [] } });
    open("resources");
    await user.selectOptions(await screen.findByLabelText("Kind"), "cronjobs");
    expect(await screen.findByText(/not collected: disabled/)).toBeInTheDocument();
  });

  it("shows the inventory failure in place of the table", async () => {
    answer(api, { clusterResources: fails("503 Service Unavailable") });
    open("resources");
    expect(await screen.findByText(/503 Service Unavailable/)).toBeInTheDocument();
  });
});

// The inventory's one-line summary per resource kind. It is a wide switch over
// what each kind's `summary` carries, so it is read here directly rather than
// through nineteen renders of the same table.
describe("summarize", () => {
  const line = (key: string, summary: Record<string, unknown>) => summarize({ key, summary });

  it("reads a route as where it is served and how TLS ends", () => {
    expect(line("routes", { host: "checkout.apps.example", path: "/api", service: "checkout",
      tls_termination: "edge" })).toBe("checkout.apps.example/api → checkout · tls edge");
    expect(line("routes", { host: "h", service: "s" })).toContain("tls none");
  });

  it("reads a service as its type, address and ports", () => {
    expect(line("services", { type: "ClusterIP", cluster_ip: "172.30.1.9",
      ports: [{ port: 8080, target: 8080 }], load_balancer: [] }))
      .toBe("ClusterIP 172.30.1.9 · 8080→8080");
    expect(line("services", { type: "LoadBalancer", ports: [],
      load_balancer: ["a.elb.amazonaws.com"] })).toContain("lb a.elb.amazonaws.com");
  });

  it("reads a ConfigMap and a Secret as key names and sizes, never values", () => {
    expect(line("configmaps", { key_count: 2, keys: [{ key: "app.conf" }, { key: "log.conf" }],
      total_bytes: 4096 })).toBe("2 keys (app.conf, log.conf) · 4 KiB");
    expect(line("secrets", { type: "kubernetes.io/tls", key_count: 2,
      keys: [{ key: "tls.crt" }, { key: "tls.key" }], total_bytes: 3072,
      certificates: [{ subject: "CN=checkout", not_after: "2026-10-02T00:00:00+00:00" }] }))
      .toContain("cert CN=checkout exp");
  });

  it("reads a claim as its class, size and what mounts it", () => {
    expect(line("persistentvolumeclaims", { storage_class: "gp3-csi",
      requested_bytes: 107374182400, capacity_bytes: 107374182400,
      access_modes: ["ReadWriteOnce"], mounted_by: ["checkout-api"] }))
      .toBe("gp3-csi · 100.0 GiB (100.0 GiB bound) · ReadWriteOnce · mounted by checkout-api");
    expect(line("persistentvolumeclaims", { requested_bytes: 1024, access_modes: [],
      mounted_by: [] })).toBe("(no class) · 1 KiB ·  · not mounted");
  });

  it("reads a volume, a quota and a network policy", () => {
    expect(line("persistentvolumes", { storage_class: "gp3-csi", capacity_bytes: 1073741824,
      csi_driver: "ebs.csi.aws.com", claim: "checkout/data", reclaim_policy: "Delete" }))
      .toBe("gp3-csi · 1.0 GiB · ebs.csi.aws.com · claim checkout/data · Delete");
    expect(line("resourcequotas", { resources: [
      { resource: "requests.cpu", used: "8500m", hard: "9", percent: 94 }] }))
      .toBe("requests.cpu 8500m/9 (94%)");
    expect(line("networkpolicies", { policy_types: ["Ingress"], ingress_rules: 2,
      egress_rules: 0 })).toBe("Ingress · 2 ingress / 0 egress rules");
  });

  it("reads an autoscaler, a cron job and an ingress", () => {
    expect(line("horizontalpodautoscalers", { target: "Deployment/checkout-api",
      current_replicas: 4, min_replicas: 2, max_replicas: 10,
      metrics: [{ resource: "cpu", target_percent: 70 }] }))
      .toBe("Deployment/checkout-api · 4 of 2-10 · cpu 70");
    expect(line("horizontalpodautoscalers", { target: "t", min_replicas: 1, max_replicas: 3,
      metrics: [] })).toContain("? of 1-3");
    expect(line("cronjobs", { schedule: "*/5 * * * *", suspended: false, last_schedule: null,
      images: ["quay.io/acme/reconcile:1.0"] }))
      .toBe("*/5 * * * * · active · last never · quay.io/acme/reconcile:1.0");
    expect(line("ingresses", { hosts: ["checkout.example"], class: "nginx" }))
      .toBe("checkout.example · class nginx");
  });

  it("reads the OLM kinds and a machine config pool", () => {
    expect(line("clusterserviceversions", { package: "elasticsearch-operator", version: "5.8.6",
      phase: "Succeeded", provider: "Red Hat" }))
      .toBe("elasticsearch-operator 5.8.6 · Succeeded · Red Hat");
    expect(line("subscriptions", { package: "elasticsearch-operator", channel: "stable-5.8",
      installed_csv: "v5.8.4", current_csv: "v5.8.6", upgrade_pending: true }))
      .toBe("elasticsearch-operator · stable-5.8 · installed v5.8.4 → v5.8.6");
    expect(line("machineconfigpools", { updated: 1, machine_count: 3, ready: 1, degraded: 1,
      paused: true, message: "on-disk state" }))
      .toBe("1/3 updated · 1 ready · 1 degraded · paused · on-disk state");
  });

  it("reads a storage class, a cluster-admin binding and an event", () => {
    expect(line("storageclasses", { provisioner: "ebs.csi.aws.com",
      binding_mode: "WaitForFirstConsumer", reclaim_policy: "Delete", default: true }))
      .toBe("ebs.csi.aws.com · WaitForFirstConsumer · Delete · default");
    expect(line("clusterrolebindings", { role: "cluster-admin",
      subjects: [{ kind: "Group", name: "sre-oncall" }] }))
      .toBe("cluster-admin → Group/sre-oncall");
    expect(line("events", { reason: "FailedScheduling", involved: { kind: "Pod", name: "p" },
      count: 18, message: "0/6 nodes are available" }))
      .toBe("FailedScheduling: Pod/p ×18 · 0/6 nodes are available");
  });

  it("falls back to the raw summary for a kind it has no words for", () => {
    expect(line("somethingnew", { a: 1 })).toBe('{"a":1}');
    expect(summarize({ key: "routes" })).toContain("undefined");
  });
});
