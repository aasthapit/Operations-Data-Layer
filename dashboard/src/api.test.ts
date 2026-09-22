import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

// Every helper in api.js goes through one fetch, so the tests read that call
// and answer it: what is asserted is the URL that was built, the body that was
// sent and the error that comes back out.
let calls;

function answer(status, body, { text = false } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: { 200: "OK", 400: "Bad Request", 404: "Not Found", 409: "Conflict",
      503: "Service Unavailable" }[status] || "",
    json: async () => body,
    text: async () => (text ? body : JSON.stringify(body)),
  };
}

function respond(handler) {
  vi.stubGlobal("fetch", vi.fn((url, init) => {
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  }));
}

beforeEach(() => { calls = []; });

describe("query strings", () => {
  it("drops empty, false and null parameters so an unset filter is not sent", async () => {
    respond(() => answer(200, { count: 0, clusters: [] }));
    await api.clusters({ hub: "hub-east", region: "", upgrading: false, team: null });
    expect(calls[0].url).toBe("/api/clusters?hub=hub-east");
  });

  it("keeps a zero, and encodes a value that would otherwise be syntax", async () => {
    respond(() => answer(200, {}));
    await api.topNamespaces("cpu", 0, "application");
    expect(calls[0].url).toBe("/api/metrics/top-namespaces?by=cpu&limit=0&class=application");
    await api.images({ image: "quay.io/acme/checkout:1.9.2" });
    expect(calls[1].url).toBe("/api/insights/images?image=quay.io%2Facme%2Fcheckout%3A1.9.2");
  });

  it("leaves the query off entirely when no parameter has a value", async () => {
    respond(() => answer(200, {}));
    await api.clusters();
    expect(calls[0].url).toBe("/api/clusters");
  });

  it("encodes a path segment, so an application named with a slash still resolves", async () => {
    respond(() => answer(200, {}));
    await api.application("checkout/prod");
    expect(calls[0].url).toBe("/api/applications/checkout%2Fprod");
  });
});

describe("a GET descriptor", () => {
  it("carries the url the cache is keyed on without fetching anything", () => {
    respond(() => answer(200, {}));
    expect(api.overview().url).toBe("/api/health/overview");
    expect(calls).toHaveLength(0);
  });

  it("issues one request however many times it is awaited", async () => {
    respond(() => answer(200, { clusters_total: 5 }));
    const descriptor = api.overview();
    await Promise.all([descriptor, descriptor, descriptor.catch(() => null)]);
    expect(calls).toHaveLength(1);
  });

  it("load passes the abort signal through to fetch", async () => {
    respond(() => answer(200, {}));
    const controller = new AbortController();
    await api.overview().load(controller.signal);
    expect(calls[0].init).toEqual({ signal: controller.signal });
  });

  it("runs the finally handler once the request settles", async () => {
    respond(() => answer(200, {}));
    const done = vi.fn();
    await api.overview().finally(done);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("throws an error carrying the status, so a 404 can be told from a 500", async () => {
    respond(() => answer(404, "no such endpoint", { text: true }));
    const error = await api.agent().then(() => null, (e) => e);
    expect(error.status).toBe(404);
    expect(error.message).toContain("404 Not Found");
    expect(error.message).toContain("no such endpoint");
  });
});

describe("post", () => {
  it("returns the parsed body of a successful refresh", async () => {
    respond(() => answer(200, { mode: "queued" }));
    await expect(api.refresh()).resolves.toEqual({ mode: "queued" });
    expect(calls[0].init).toEqual({ method: "POST" });
  });

  it("raises the API's own reason and status when a sweep is refused", async () => {
    respond(() => answer(409, { detail: "no collector is running" }));
    const error = await api.refresh().then(() => null, (e) => e);
    expect(error.status).toBe(409);
    expect(error.message).toBe("no collector is running");
  });

  it("falls back to the response text when the failure is not JSON", async () => {
    respond(() => answer(503, "upstream is down", { text: true }));
    const error = await api.refresh().then(() => null, (e) => e);
    expect(error.message).toBe("upstream is down");
  });
});

describe("sendJson", () => {
  it("sends the body as JSON with a content type", async () => {
    respond(() => answer(200, { ok: true }));
    await api.saveDashboard("hub review", { id: "hub-review", panels: [] });
    expect(calls[0].url).toBe("/api/dashboards/hub%20review");
    expect(calls[0].init.method).toBe("PUT");
    expect(calls[0].init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(calls[0].init.body)).toEqual({ id: "hub-review", panels: [] });
  });

  it("sends a DELETE with no body at all", async () => {
    respond(() => answer(200, null));
    await api.deleteDashboard("capacity-watch");
    expect(calls[0].init).toEqual({ method: "DELETE" });
  });

  it("surfaces a string detail as the message", async () => {
    respond(() => answer(400, { detail: "only SELECT queries are allowed" }));
    const error = await api.runSql("DROP TABLE clusters").then(() => null, (e) => e);
    expect(error.status).toBe(400);
    expect(error.message).toBe("only SELECT queries are allowed");
  });

  it("keeps a structured detail on the error and reads its error field", async () => {
    respond(() => answer(422, { detail: { error: "both attempts failed", sql: "SELECT 1" } }));
    const error = await api.askQuery("how many clusters?").then(() => null, (e) => e);
    expect(error.message).toBe("both attempts failed");
    expect(error.detail.sql).toBe("SELECT 1");
  });

  it("keeps FastAPI's own loc-array detail for the field errors to unpack", async () => {
    respond(() => answer(400, { detail: [{ loc: ["body", "panels", 0, "sql"], msg: "required" }] }));
    const error = await api.saveDashboard("x", {}).then(() => null, (e) => e);
    expect(error.detail).toEqual([{ loc: ["body", "panels", 0, "sql"], msg: "required" }]);
  });

  it("omits the row limit when none was asked for", async () => {
    respond(() => answer(200, {}));
    await api.runSql("SELECT 1");
    expect(JSON.parse(calls[0].init.body)).toEqual({ sql: "SELECT 1" });
    await api.runSql("SELECT 1", 50);
    expect(JSON.parse(calls[1].init.body)).toEqual({ sql: "SELECT 1", limit: 50 });
  });
});

describe("runDashboard", () => {
  it("keys the cache on the parameters rather than only on the path", () => {
    const one = api.runDashboard("hub-review", { hub: "hub-east", days: 7 });
    const other = api.runDashboard("hub-review", { days: 7, hub: "hub-east" });
    expect(one.url).toBe(other.url);
    expect(one.url).not.toBe(api.runDashboard("hub-review", { hub: "hub-west" }).url);
  });

  it("posts the parameters to the run endpoint, not to the cache key", async () => {
    respond(() => answer(200, { results: {} }));
    await api.runDashboard("hub-review", { hub: "hub-east" }).load();
    expect(calls[0].url).toBe("/api/dashboards/hub-review/run");
    expect(JSON.parse(calls[0].init.body)).toEqual({ params: { hub: "hub-east" } });
  });

  it("spells an array and a nested object into the key in a stable order", () => {
    const url = api.runDashboard("d", { envs: ["prod", "stage"], opts: { b: 1, a: 2 } }).url;
    expect(decodeURIComponent(url)).toContain('{"envs":["prod","stage"],"opts":{"a":2,"b":1}}');
  });

  it("issues one request however many times the descriptor is awaited", async () => {
    respond(() => answer(200, { results: {} }));
    const descriptor = api.runDashboard("hub-review", {});
    await Promise.all([descriptor, descriptor]);
    expect(calls).toHaveLength(1);
  });
});

describe("the endpoint table", () => {
  // Every read the dashboard can make, and the URL it asks for. The urls are
  // what the SWR cache keys on, so a change here is a change to the cache.
  // Each entry is [the call, the url it must key on]; the annotation is what
  // makes it a tuple rather than an array of unions, so `it.each` can spread it.
  const READS: Array<[() => { url: string; load: () => Promise<unknown> }, string]> = [
    [() => api.overview(), "/api/health/overview"],
    [() => api.summary("region"), "/api/health/summary?group_by=region"],
    [() => api.clusters({ hub: "hub-east" }), "/api/clusters?hub=hub-east"],
    [() => api.cluster("ocp-prod-iad-01"), "/api/clusters/ocp-prod-iad-01"],
    [() => api.clusterNodes("ocp-prod-iad-01"), "/api/clusters/ocp-prod-iad-01/nodes"],
    [() => api.clusterNamespaces("c", { class: "application" }),
      "/api/clusters/c/namespaces?class=application"],
    [() => api.clusterWorkloads("c", { detail: true }), "/api/clusters/c/workloads?detail=true"],
    [() => api.clusterPodIssues("c", {}), "/api/clusters/c/pod-issues"],
    [() => api.clusterResources("c", { kind: "routes" }), "/api/clusters/c/resources?kind=routes"],
    [() => api.timeline("c"), "/api/clusters/c/timeline"],
    [() => api.versions(), "/api/versions"],
    [() => api.operatorVersions(), "/api/versions/operators"],
    [() => api.blastRadius({ ocp_version: "4.16.7" }), "/api/blast-radius?ocp_version=4.16.7"],
    [() => api.applications({ team: "payments" }), "/api/applications?team=payments"],
    [() => api.application("checkout"), "/api/applications/checkout"],
    [() => api.insightsSummary(), "/api/insights/summary"],
    [() => api.certificates({ include_valid: true }),
      "/api/insights/certificates?include_valid=true"],
    [() => api.podIssues({ class: "platform" }), "/api/insights/pod-issues?class=platform"],
    [() => api.quotas(), "/api/insights/quotas"],
    [() => api.olmOperators(), "/api/insights/olm-operators"],
    [() => api.machineConfigPools(), "/api/insights/machine-config-pools"],
    [() => api.storage(), "/api/insights/storage"],
    [() => api.routes({ host: "checkout" }), "/api/insights/routes?host=checkout"],
    [() => api.events({ cluster: "c", limit: 50 }), "/api/insights/events?cluster=c&limit=50"],
    [() => api.images({ group_by: "registry" }), "/api/insights/images?group_by=registry"],
    [() => api.references({ kind: "Secret" }), "/api/insights/references?kind=Secret"],
    [() => api.clusterAdmins(), "/api/insights/cluster-admins"],
    [() => api.inventory({ kind: "routes" }), "/api/insights/resources?kind=routes"],
    [() => api.querySchema(), "/api/query/schema"],
    [() => api.dashboards(), "/api/dashboards"],
    [() => api.dashboard("hub review"), "/api/dashboards/hub%20review"],
    [() => api.agent(), "/api/agent"],
    [() => api.manifest(), "/api/manifest"],
    [() => api.manifestAvailability(), "/api/manifest/availability"],
    [() => api.collectorTimings(20), "/api/collector/timings?limit=20"],
    [() => api.metricsHealth(), "/api/metrics/health"],
    [() => api.topNamespaces("cpu", 10, "application"),
      "/api/metrics/top-namespaces?by=cpu&limit=10&class=application"],
    [() => api.topNodes("memory", 5), "/api/metrics/top-nodes?by=memory&limit=5"],
    [() => api.capacity("hub"), "/api/metrics/capacity?group_by=hub"],
    [() => api.clusterUtilization("c"), "/api/metrics/cluster/c/utilization"],
    [() => api.utilizationTimeline("c"), "/api/metrics/cluster/c/timeline"],
    [() => api.patchReport(), "/api/patching/report"],
    [() => api.patchJobs({ status: "paused" }), "/api/patching/jobs?status=paused"],
    [() => api.patchJob("patch-2026-09-20-a"), "/api/patching/jobs/patch-2026-09-20-a"],
  ];

  it.each(READS)("asks for %#: the url the cache keys on", (build, url) => {
    expect(build().url).toBe(url);
  });

  it("fetches each read from the url it carries", async () => {
    respond(() => answer(200, { ok: true }));
    await Promise.all(READS.map(([build]) => build().load()));
    expect(calls.map((c) => c.url)).toEqual(READS.map(([, url]) => url));
  });

  it("sends each write to its own endpoint", async () => {
    respond(() => answer(200, { ok: true }));
    await api.queryBatch([{ id: "p", sql: "SELECT 1" }], { hub: "hub-east" });
    expect(calls[0].url).toBe("/api/query/batch");
    expect(JSON.parse(calls[0].init.body))
      .toEqual({ queries: [{ id: "p", sql: "SELECT 1" }], params: { hub: "hub-east" } });

    await api.askQuery("how many clusters?", 50);
    expect(calls[1].url).toBe("/api/query/ask");
    expect(JSON.parse(calls[1].init.body))
      .toEqual({ question: "how many clusters?", limit: 50 });
  });
});
