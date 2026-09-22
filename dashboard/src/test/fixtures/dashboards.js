// The dashboard plane's three responses: the list, one definition, and a run.
// The definition is written in the vocabulary the API stores ({type: "bar"},
// a scalar `y`), because reconciling that with the Chart component's own words
// is exactly what chartFromWire is for.

export const DASHBOARD_LIST = {
  dashboards: [
    { id: "hub-review", title: "Hub review - {{hub}}",
      description: "Every cluster one hub manages.", builtin: true, panels: 2,
      variables: ["hub"], updated_at: null },
    { id: "capacity-watch", title: "Capacity watch",
      description: "", builtin: false, panels: 1, variables: [],
      updated_at: "2026-09-19T08:00:00+00:00" },
  ],
};

export const HUB_REVIEW = {
  id: "hub-review",
  title: "Hub review - {{hub}}",
  description: "Every cluster one hub manages.",
  builtin: true,
  variables: [
    { name: "hub", label: "Hub", type: "select", required: true,
      sql: "SELECT DISTINCT hub_name AS value FROM clusters ORDER BY 1" },
  ],
  panels: [
    { id: "status", title: "Clusters by status", description: "Overall status on {{hub}}.",
      sql: "SELECT overall_status, count(*) AS clusters FROM clusters WHERE hub_name = {{hub}} GROUP BY 1",
      chart: { type: "bar", x: "overall_status", y: "clusters" }, w: 4, h: 2 },
    { id: "clusters", title: "Clusters on {{hub}}",
      sql: "SELECT name, overall_status, health_score FROM clusters WHERE hub_name = {{hub}}",
      chart: { type: "table" }, w: 8, h: 3 },
  ],
  updated_at: "2026-09-19T08:00:00+00:00",
  updated_by: "a.sthapit",
};

export const CAPACITY_WATCH = {
  id: "capacity-watch",
  title: "Capacity watch",
  description: "",
  builtin: false,
  variables: [],
  panels: [
    { id: "headroom", title: "CPU headroom by cluster",
      sql: "SELECT name, cpu_allocatable - cpu_usage AS headroom_cores FROM clusters ORDER BY 2",
      chart: { type: "table" }, w: 12, h: 3 },
  ],
  updated_at: "2026-09-19T08:00:00+00:00",
  updated_by: "a.sthapit",
};

// What POST /api/dashboards/{id}/run answers with: the definition, the
// parameters it actually used, every select variable's options, and one result
// per panel - including a panel that could not run.
export const HUB_REVIEW_RUN = {
  dashboard: HUB_REVIEW,
  params: { hub: "hub-east" },
  variables: {
    hub: { options: [{ value: "hub-east", label: "hub-east" },
      { value: "hub-west", label: "hub-west" }] },
  },
  results: {
    status: {
      columns: ["overall_status", "clusters"],
      column_types: ["VARCHAR", "BIGINT"],
      rows: [["healthy", 2], ["warning", 1], ["critical", 1]],
      row_count: 3,
      elapsed_ms: 4,
    },
    clusters: {
      columns: ["name", "overall_status", "health_score"],
      column_types: ["VARCHAR", "VARCHAR", "INTEGER"],
      rows: [["ocp-prod-iad-01", "healthy", 97], ["ocp-prod-iad-02", "warning", 74]],
      row_count: 2,
      elapsed_ms: 3,
    },
  },
  generation: 11,
  snapshot: { generation: 11, built_at: "2026-09-20T20:58:11+00:00" },
};
