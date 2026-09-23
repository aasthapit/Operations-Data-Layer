import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Insights from "./Insights";
import * as cache from "../cache";
import { answer, fails } from "../test/apiMock";
import type { ApiMock } from "../test/apiMock";
import { closestElement, currentUrl, renderView } from "../test/harness";
import { clustersResponse } from "../test/fixtures/fleet";
import {
  CERTIFICATES, CLUSTER_ADMINS, EVENTS, IMAGES, MACHINE_CONFIG_POOLS, OLM_OPERATORS,
  POD_ISSUES, QUOTAS, REFERENCES, ROUTES, STORAGE,
} from "../test/fixtures/insights";

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
    clusters: clustersResponse(),
    certificates: CERTIFICATES,
    podIssues: POD_ISSUES,
    quotas: QUOTAS,
    olmOperators: OLM_OPERATORS,
    machineConfigPools: MACHINE_CONFIG_POOLS,
    storage: STORAGE,
    routes: ROUTES,
    events: EVENTS,
    images: IMAGES,
    references: REFERENCES,
    clusterAdmins: CLUSTER_ADMINS,
  });
});

const open = (section: string, at?: string) => renderView(
  ({ route, nav }) => <Insights section={section} route={route} nav={nav} />,
  { at: at || `/insights/${section}` });

describe("the section strip", () => {
  it("offers every section and opens the one that was clicked", async () => {
    const user = userEvent.setup();
    open("certificates");
    await screen.findByText("checkout-tls");
    await user.click(screen.getByRole("button", { name: "Storage" }));
    expect(currentUrl()).toBe("/insights/storage");
  });
});

describe("certificates", () => {
  it("lists what is expiring, worst first, with subject and issuer", async () => {
    open("certificates");
    const row = closestElement(await screen.findByText("router-certs-default"), "tr");
    expect(within(row).getByText("expired")).toBeInTheDocument();
    expect(within(row).getByText("expired 4d ago")).toBeInTheDocument();
    expect(within(row).getByText("CN=*.apps.ocp-stage-iad-01.acme.example")).toBeInTheDocument();
    expect(within(row).getByText("CN=Acme Internal CA")).toBeInTheDocument();
    expect(within(row).getByText("(platform)")).toBeInTheDocument();
  });

  it("says how wide the window is, and how many it found", async () => {
    open("certificates");
    expect(await screen.findByText("Certificates (2)")).toBeInTheDocument();
    expect(screen.getByText(/Window: 30 days/)).toBeInTheDocument();
  });

  it("narrows by cluster, and puts it in the URL", async () => {
    const user = userEvent.setup();
    open("certificates");
    await user.selectOptions(await screen.findByLabelText("Cluster"), "ocp-prod-iad-02");
    expect(currentUrl()).toBe("/insights/certificates?cluster=ocp-prod-iad-02");
    await waitFor(() => expect(api.certificates).toHaveBeenCalledWith(
      expect.objectContaining({ cluster: "ocp-prod-iad-02" })));
  });

  it("includes the valid ones when asked", async () => {
    const user = userEvent.setup();
    open("certificates");
    await user.click(await screen.findByLabelText(/include valid/i));
    await waitFor(() => expect(api.certificates).toHaveBeenLastCalledWith(
      expect.objectContaining({ include_valid: true })));
  });

  it("opens the cluster a certificate is on", async () => {
    const user = userEvent.setup();
    open("certificates");
    const row = closestElement(await screen.findByText("checkout-tls"), "tr");
    await user.click(within(row).getByText("ocp-prod-iad-02"));
    expect(currentUrl()).toBe("/clusters/ocp-prod-iad-02");
  });

  it("shows the failure in place of the table", async () => {
    answer(api, { certificates: fails("503 Service Unavailable") });
    open("certificates");
    expect(await screen.findByText(/503 Service Unavailable/)).toBeInTheDocument();
  });
});

describe("pod issues", () => {
  it("lists the problem pods and summarises them by reason", async () => {
    open("pods");
    expect(await screen.findByText("Pod issues (2)")).toBeInTheDocument();
    expect(screen.getByText("1 CrashLoopBackOff · 1 Unschedulable")).toBeInTheDocument();
    const row = closestElement(screen.getByText("checkout-api-7d9f8b6c4-2xk9p"), "tr");
    expect(within(row).getByText("19")).toBeInTheDocument();
    expect(within(row).getByText("ReplicaSet/checkout-api-7d9f8b6c4")).toBeInTheDocument();
  });

  it("says nothing is wrong rather than leaving the line blank", async () => {
    answer(api, { podIssues: { count: 0, by_reason: {}, pod_issues: [] } });
    open("pods");
    expect(await screen.findByText("Nothing wrong.")).toBeInTheDocument();
  });

  it("narrows by class", async () => {
    const user = userEvent.setup();
    open("pods");
    await user.click(await screen.findByRole("button", { name: "Platform" }));
    expect(currentUrl()).toBe("/insights/pods?class=platform");
    await waitFor(() => expect(api.podIssues).toHaveBeenLastCalledWith(
      { class: "platform", cluster: "" }));
  });
});

describe("quotas", () => {
  it("shows every resource in a quota against its hard limit", async () => {
    open("quotas");
    const row = closestElement(await screen.findByText("checkout-quota"), "tr");
    expect(within(row).getByText("94%")).toBeInTheDocument();
    expect(within(row).getByText("requests.cpu")).toBeInTheDocument();
    expect(within(row).getByText("8500m / 9 (94%)")).toBeInTheDocument();
    expect(within(row).getByText("16Gi / 32Gi (50%)")).toBeInTheDocument();
  });
});

describe("OLM operators", () => {
  it("shows version drift, unhealthy installs and pending upgrades per package", async () => {
    open("olm");
    const row = closestElement(await screen.findByText("elasticsearch-operator"), "tr");
    expect(within(row).getByText("OpenShift Elasticsearch Operator")).toBeInTheDocument();
    expect(within(row).getByText("5.8.6 (1), 5.8.4 (1)")).toBeInTheDocument();
    expect(within(row).getByText("warning")).toBeInTheDocument();
    expect(await screen.findByText("OLM operators (1 packages)")).toBeInTheDocument();
  });

  it("opens a package to show where each version is installed", async () => {
    const user = userEvent.setup();
    open("olm");
    await user.click(await screen.findByText("elasticsearch-operator"));
    expect(await screen.findByText("elasticsearch-operator.v5.8.4")).toBeInTheDocument();
    const install = closestElement(screen.getByText("elasticsearch-operator.v5.8.4"), "tr");
    expect(within(install).getByText("Failed · InstallCheckFailed")).toBeInTheDocument();
    expect(within(install).getByText("5.8.6")).toBeInTheDocument();
  });

  it("asks for the blast radius of a package", async () => {
    const user = userEvent.setup();
    open("olm");
    await user.click(await screen.findByText("blast radius →"));
    expect(currentUrl()).toBe("/blast?olm_operator=elasticsearch-operator");
  });
});

describe("machine config pools", () => {
  it("lists the pools that are not settled, worst first", async () => {
    open("mcp");
    const row = closestElement(await screen.findByText("rendered-worker-6b2c1a"), "tr");
    expect(within(row).getByText("degraded")).toBeInTheDocument();
    expect(within(row).getByText(/unexpected on-disk state/)).toBeInTheDocument();
    expect(await screen.findByText("Machine config pools (2)")).toBeInTheDocument();
  });
});

describe("storage", () => {
  it("shows each class with the claims riding on it", async () => {
    open("storage");
    const classes = closestElement(
      await screen.findByRole("heading", { name: "Storage classes" }), ".card");
    // The name cell also carries the "default" tag when the class is the
    // cluster's default one, which gp3-csi is in the fixture.
    const row = closestElement(
      within(classes).getByRole("cell", { name: "gp3-csi default" }), "tr");
    expect(within(row).getByText("ebs.csi.aws.com")).toBeInTheDocument();
    expect(within(row).getByText("1024.0 GiB")).toBeInTheDocument();
    // clusters, pvcs, bound, pending
    expect(within(row).getAllByRole("cell").slice(2, 6).map((c) => c.textContent))
      .toEqual(["1", "12", "11", "1"]);
  });

  it("puts the pending claims first and says what is not mounted", async () => {
    open("storage");
    const row = closestElement(await screen.findByText("checkout-data"), "tr");
    expect(within(row).getByText("pending")).toBeInTheDocument();
    expect(within(row).getByText("not mounted")).toBeInTheDocument();
    expect(screen.getByText("Persistent volume claims (2)")).toBeInTheDocument();
  });
});

describe("routes", () => {
  it("shows which cluster and namespace serves a hostname", async () => {
    open("routes");
    const row = closestElement(
      await screen.findByText("checkout.apps.ocp-prod-iad-02.acme.example/"), "tr");
    expect(within(row).getByText("checkout:8080")).toBeInTheDocument();
    expect(within(row).getByText("edge · Redirect")).toBeInTheDocument();
    expect(within(row).getByText("admitted")).toBeInTheDocument();
  });

  it("says none where a route terminates no TLS", async () => {
    open("routes");
    const row = closestElement(
      await screen.findByText("checkout.apps.ocp-stage-iad-01.acme.example"), "tr");
    expect(within(row).getByText("none")).toBeInTheDocument();
    expect(within(row).getByText("rejected")).toBeInTheDocument();
  });

  it("filters by host through the URL", async () => {
    const user = userEvent.setup();
    open("routes");
    await user.type(await screen.findByPlaceholderText(/host/i), "checkout");
    await waitFor(() => expect(currentUrl()).toBe("/insights/routes?host=checkout"));
  });
});

describe("events", () => {
  it("lists the warning events and summarises them by reason", async () => {
    open("events");
    expect(await screen.findByText("Warning events (2)")).toBeInTheDocument();
    expect(screen.getByText("1 FailedScheduling · 1 BackOff")).toBeInTheDocument();
    const row = closestElement(screen.getByText("Pod/prometheus-k8s-1"), "tr");
    expect(within(row).getByText("default-scheduler")).toBeInTheDocument();
    expect(within(row).getByText("18")).toBeInTheDocument();
  });

  it("asks for a wide window, because this is the fleet view", async () => {
    open("events");
    await screen.findByText("Warning events (2)");
    await waitFor(() => expect(api.events).toHaveBeenCalledWith({ cluster: "", class: "", limit: 300 }));
  });
});

describe("images", () => {
  it("groups by image and counts the workloads carrying each one", async () => {
    open("images");
    const row = closestElement(
      await screen.findByRole("cell", { name: "quay.io/acme/checkout:1.9.2" }), "tr");
    const cells = within(row).getAllByRole("cell").map((c) => c.textContent);
    expect(cells.slice(0, 3)).toEqual(["quay.io/acme/checkout:1.9.2", "2", "2"]);
    expect(await screen.findByText("Images (2)")).toBeInTheDocument();
  });

  it("opens an image to show the exact workloads running it", async () => {
    const user = userEvent.setup();
    open("images");
    await user.click(await screen.findByRole("cell", { name: "quay.io/acme/checkout:1.9.2" }));
    expect(await screen.findAllByText("Deployment/checkout-api")).toHaveLength(2);
  });

  it("regroups by repository and by registry", async () => {
    const user = userEvent.setup();
    open("images");
    await user.click(await screen.findByRole("button", { name: "Registry" }));
    expect(currentUrl()).toBe("/insights/images?group=registry");
    await waitFor(() => expect(api.images).toHaveBeenLastCalledWith(
      expect.objectContaining({ group_by: "registry" })));
  });

  it("asks for the blast radius of an image, without opening the row", async () => {
    const user = userEvent.setup();
    open("images");
    await user.click((await screen.findAllByText("blast radius →"))[0]);
    expect(currentUrl()).toContain("/blast?image=");
    expect(screen.queryByText("Deployment/checkout-api")).toBeNull();
  });
});

describe("config references", () => {
  it("shows which workloads reference a secret, and how", async () => {
    open("references");
    const row = closestElement(await screen.findByText("checkout-db"), "tr");
    expect(within(row).getByText("Deployment/checkout-api")).toBeInTheDocument();
    expect(within(row).getByText("CronJob/checkout-reconcile")).toBeInTheDocument();
    expect(within(row).getByText("via envFrom")).toBeInTheDocument();
  });

  it("switches the kind being asked about", async () => {
    const user = userEvent.setup();
    open("references");
    await user.click(await screen.findByRole("button", { name: "ConfigMaps" }));
    expect(currentUrl()).toBe("/insights/references?kind=ConfigMap");
    await waitFor(() => expect(api.references).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "ConfigMap" })));
  });

  it("falls back to secrets for a kind this build does not offer", async () => {
    open("references", "/insights/references?kind=Pod");
    await screen.findByText("checkout-db");
    await waitFor(() => expect(api.references).toHaveBeenCalledWith({ kind: "Secret", name: "" }));
  });
});

describe("cluster admins", () => {
  it("names every subject holding cluster-admin and where", async () => {
    open("access");
    const row = closestElement(await screen.findByText("sre-oncall"), "tr");
    expect(within(row).getByText("Group")).toBeInTheDocument();
    expect(within(row).getByText("sre-oncall-admin")).toBeInTheDocument();
    expect(within(row).getByText("ocp-stage-iad-01")).toBeInTheDocument();
    expect(await screen.findByText("Cluster admins (2 subjects)")).toBeInTheDocument();
  });

  it("names the namespace a service account lives in", async () => {
    open("access");
    const row = closestElement(await screen.findByText("pipeline"), "tr");
    expect(within(row).getByText("(openshift-gitops)")).toBeInTheDocument();
  });

  it("opens a cluster from the list a subject holds it on", async () => {
    const user = userEvent.setup();
    open("access");
    await user.click(await screen.findByText("ocp-stage-iad-01"));
    expect(currentUrl()).toBe("/clusters/ocp-stage-iad-01");
  });
});
