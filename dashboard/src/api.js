// Typed-ish fetch helpers for the Operations Data Layer API.
const BASE = import.meta.env.VITE_API_BASE || "";

function qs(params = {}) {
  const q = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== "" && v !== false && v != null)
  ).toString();
  return q ? `?${q}` : "";
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json();
}

async function post(path) {
  const res = await fetch(`${BASE}${path}`, { method: "POST" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// POST with a JSON body. The query plane answers a refusal with a reason the
// user is meant to read ({"detail": "only SELECT queries are allowed"}), so the
// error carries the status and the parsed detail rather than a formatted blob.
async function postJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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
  runSql: (sql, limit) => postJson("/api/query/sql", limit ? { sql, limit } : { sql }),
  askQuery: (question, limit) =>
    postJson("/api/query/ask", limit ? { question, limit } : { question }),

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

  // Patching system of record (separate service via the /patching proxy).
  patchReport: () => get("/patching/report"),
  patchJobs: (params = {}) => get(`/patching/jobs${qs(params)}`),
  patchJob: (id) => get(`/patching/jobs/${id}`),
};
