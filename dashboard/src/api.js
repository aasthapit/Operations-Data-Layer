// Typed-ish fetch helpers for the Operations Data Layer API.
// Exported because the agent stream is a fetch of its own: it reads a response
// body rather than a JSON document, so it cannot go through fetchJson - but it
// must reach the same API as everything else.
export const BASE = import.meta.env.VITE_API_BASE || "";

function qs(params = {}) {
  const q = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== "" && v !== false && v != null)
  ).toString();
  return q ? `?${q}` : "";
}

async function fetchJson(path, signal) {
  const res = await fetch(`${BASE}${path}`, signal ? { signal } : undefined);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // The status is part of the answer, not decoration: a 404 from an endpoint
    // this build of the API does not serve is a different thing to tell the
    // user than a 500, and a view can only say which if it is carried along.
    const error = new Error(`${res.status} ${res.statusText}: ${body}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

// A GET is handed back as a small request descriptor rather than a bare
// promise. The descriptor carries the URL, which is what the cache is keyed on,
// and takes an AbortSignal so a view that went away can cancel its fetch. It is
// still thenable, so `await api.blastRadius(q)` reads exactly as it did - and
// awaiting it twice reuses the one request rather than issuing a second.
function get(path) {
  let pending = null;
  const run = () => (pending || (pending = fetchJson(path)));
  return {
    url: path,
    load: (signal) => fetchJson(path, signal),
    then: (ok, fail) => run().then(ok, fail),
    catch: (fail) => run().catch(fail),
    finally: (done) => run().finally(done),
  };
}

async function post(path) {
  const res = await fetch(`${BASE}${path}`, { method: "POST" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// A request with a JSON body (POST / PUT), or a bare DELETE. The query plane
// answers a refusal with a reason the user is meant to read ({"detail": "only
// SELECT queries are allowed"}), and the dashboard plane answers a bad
// definition with a field path - so the error carries the status and the parsed
// detail rather than a formatted blob.
async function sendJson(method, path, body, signal) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  if (signal) init.signal = signal;
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON: keep the text */ }
  if (res.ok) return data;

  const detail = data && typeof data === "object" ? data.detail : null;
  const message =
    typeof detail === "string" ? detail
      : detail && typeof detail === "object" ? (detail.error || JSON.stringify(detail))
        : text || `${res.status} ${res.statusText}`;
  const error = new Error(message);
  error.status = res.status;
  error.detail = detail;
  throw error;
}

const postJson = (path, body, signal) => sendJson("POST", path, body, signal);

// A POST that is really a read: running a dashboard changes nothing, so it goes
// through the same stale-while-revalidate cache the GETs use. The descriptor
// looks exactly like get()'s, except the cache key spells out the body - what
// changes the answer is the parameters, not the path.
function postGet(key, path, body) {
  let pending = null;
  const run = () => (pending || (pending = postJson(path, body)));
  return {
    url: key,
    load: (signal) => postJson(path, body, signal),
    then: (ok, fail) => run().then(ok, fail),
    catch: (fail) => run().catch(fail),
    finally: (done) => run().finally(done),
  };
}

const enc = encodeURIComponent;

// Key order must not change the cache key: {hub: "a", days: 7} and
// {days: 7, hub: "a"} are the same dashboard.
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export const api = {
  // fleet
  overview: () => get("/api/health/overview"),
  summary: (groupBy) => get(`/api/health/summary?group_by=${groupBy}`),
  clusters: (params = {}) => get(`/api/clusters${qs(params)}`),
  cluster: (name) => get(`/api/clusters/${name}`),
  clusterNodes: (name) => get(`/api/clusters/${name}/nodes`),
  clusterNamespaces: (name, params = {}) => get(`/api/clusters/${name}/namespaces${qs(params)}`),
  clusterWorkloads: (name, params = {}) => get(`/api/clusters/${name}/workloads${qs(params)}`),
  clusterPodIssues: (name, params = {}) => get(`/api/clusters/${name}/pod-issues${qs(params)}`),
  clusterResources: (name, params = {}) => get(`/api/clusters/${name}/resources${qs(params)}`),
  timeline: (name) => get(`/api/clusters/${name}/timeline`),
  versions: () => get("/api/versions"),
  operatorVersions: () => get("/api/versions/operators"),
  blastRadius: (params = {}) => get(`/api/blast-radius${qs(params)}`),
  refresh: () => post("/api/refresh"),

  // applications
  applications: (params = {}) => get(`/api/applications${qs(params)}`),
  application: (app) => get(`/api/applications/${encodeURIComponent(app)}`),

  // insights
  insightsSummary: () => get("/api/insights/summary"),
  certificates: (params = {}) => get(`/api/insights/certificates${qs(params)}`),
  podIssues: (params = {}) => get(`/api/insights/pod-issues${qs(params)}`),
  quotas: (params = {}) => get(`/api/insights/quotas${qs(params)}`),
  olmOperators: (params = {}) => get(`/api/insights/olm-operators${qs(params)}`),
  machineConfigPools: (params = {}) => get(`/api/insights/machine-config-pools${qs(params)}`),
  storage: (params = {}) => get(`/api/insights/storage${qs(params)}`),
  routes: (params = {}) => get(`/api/insights/routes${qs(params)}`),
  events: (params = {}) => get(`/api/insights/events${qs(params)}`),
  images: (params = {}) => get(`/api/insights/images${qs(params)}`),
  references: (params = {}) => get(`/api/insights/references${qs(params)}`),
  clusterAdmins: (params = {}) => get(`/api/insights/cluster-admins${qs(params)}`),
  inventory: (params = {}) => get(`/api/insights/resources${qs(params)}`),

  // query plane (guarded SQL over the in-process DuckDB snapshot)
  querySchema: () => get("/api/query/schema"),
  runSql: (sql, limit, signal) =>
    postJson("/api/query/sql", limit ? { sql, limit } : { sql }, signal),
  askQuery: (question, limit) =>
    postJson("/api/query/ask", limit ? { question, limit } : { question }),
  // Several panels in one round trip. `params` are the dashboard's variables;
  // the server substitutes {{name}} as an escaped literal.
  queryBatch: (queries, params = {}, signal) =>
    postJson("/api/query/batch", { queries, params }, signal),

  // dashboards (multi-panel views over the query plane)
  dashboards: () => get("/api/dashboards"),
  dashboard: (id) => get(`/api/dashboards/${enc(id)}`),
  saveDashboard: (id, definition) => sendJson("PUT", `/api/dashboards/${enc(id)}`, definition),
  deleteDashboard: (id) => sendJson("DELETE", `/api/dashboards/${enc(id)}`),
  // A read, so it is a descriptor the SWR cache can key: the same dashboard with
  // the same variables paints from cache the moment the user navigates back.
  runDashboard: (id, params = {}) => postGet(
    `/api/dashboards/${enc(id)}/run?params=${enc(stableJson(params))}`,
    `/api/dashboards/${enc(id)}/run`,
    { params },
  ),

  // generative dashboards (AG-UI). The run itself is a stream, so it lives in
  // agent/client.js; this is only "is the feature there, and with what model".
  agent: () => get("/api/agent"),

  // manifest
  manifest: () => get("/api/manifest"),
  manifestAvailability: () => get("/api/manifest/availability"),
  // Where the collector's time goes: per-cluster stage breakdown plus fleet
  // aggregates and the last sweep, in one call.
  collectorTimings: (limit) => get(`/api/collector/timings${qs({ limit })}`),

  // utilization (metrics.k8s.io, collected with the inventory)
  metricsHealth: () => get("/api/metrics/health"),
  topNamespaces: (by, limit = 10, cls = "") => get(`/api/metrics/top-namespaces${qs({ by, limit, class: cls })}`),
  topNodes: (by, limit = 10) => get(`/api/metrics/top-nodes?by=${by}&limit=${limit}`),
  capacity: (groupBy = "cluster") => get(`/api/metrics/capacity?group_by=${groupBy}`),
  clusterUtilization: (name) => get(`/api/metrics/cluster/${name}/utilization`),
  utilizationTimeline: (name) => get(`/api/metrics/cluster/${name}/timeline`),

  // Patching system of record (separate service, proxied under /api/patching).
  // Everything the dashboard fetches lives under /api, which leaves every other
  // path to the router: /patching/<job id> is a page, not an API call.
  patchReport: () => get("/api/patching/report"),
  patchJobs: (params = {}) => get(`/api/patching/jobs${qs(params)}`),
  patchJob: (id) => get(`/api/patching/jobs/${id}`),
};
