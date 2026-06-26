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
};
