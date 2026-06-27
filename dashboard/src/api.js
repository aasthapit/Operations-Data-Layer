// Typed-ish fetch helpers for the Operations Data Layer API.
const BASE = import.meta.env.VITE_API_BASE || "";

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

export const api = {
  overview: () => get("/api/health/overview"),
  summary: (groupBy) => get(`/api/health/summary?group_by=${groupBy}`),
  clusters: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v)
    ).toString();
    return get(`/api/clusters${qs ? `?${qs}` : ""}`);
  },
  cluster: (name) => get(`/api/clusters/${name}`),
  timeline: (name) => get(`/api/clusters/${name}/timeline`),
  versions: () => get("/api/versions"),
  operatorVersions: () => get("/api/versions/operators"),
  blastRadius: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== "" && v !== false && v != null)
    ).toString();
    return get(`/api/blast-radius?${qs}`);
  },
  refresh: () => post("/api/refresh"),

  metricsHealth: () => get("/api/metrics/health"),
  topNamespaces: (by, limit = 10) => get(`/api/metrics/top-namespaces?by=${by}&limit=${limit}`),
  topNodes: (by, limit = 10) => get(`/api/metrics/top-nodes?by=${by}&limit=${limit}`),
  capacity: (groupBy = "cluster") => get(`/api/metrics/capacity?group_by=${groupBy}`),

  // Patching system of record (separate service via the /patching proxy).
  patchReport: () => get("/patching/report"),
  patchJobs: (params = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return get(`/patching/jobs${qs ? `?${qs}` : ""}`);
  },
  patchJob: (id) => get(`/patching/jobs/${id}`),
};
