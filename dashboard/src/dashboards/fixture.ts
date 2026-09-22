// Sample dashboards for developing the page without the dashboard API.
//
// /dashboards?fixture=1 lists these instead of calling GET /api/dashboards, and
// /dashboards/<id>?fixture=1 runs one of them through the query plane directly.
// Every query here is real SQL against the collector's tables, so the fixture
// exercises the same code path a stored dashboard does - only the definition
// comes from this file rather than from the server.
//
// They are a development aid, not a fallback: nothing reaches them unless the
// URL asks for them by name.
import { normalizeDefinition } from "./model";
import type { Definition } from "./model";
import type { DashboardListEntry } from "../api/types";

// Written the way a dashboard author writes one by hand (a scalar `y`, a bare
// `{type: bars}`), which is exactly what normalizeDefinition is for - so they
// are documents on the way in, not Definitions.
const DEFINITIONS: unknown[] = [
  {
    id: "fixture-hub",
    title: "Hub overview - {{hub}}",
    description: "Every cluster one hub manages, how healthy it is, and what is failing.",
    variables: [
      {
        name: "hub",
        label: "Hub",
        type: "select",
        required: true,
        sql: "SELECT DISTINCT hub_name AS value FROM clusters WHERE hub_name IS NOT NULL ORDER BY 1",
      },
    ],
    panels: [
      {
        id: "status",
        title: "Clusters by status",
        description: "Overall status of every cluster on this hub.",
        sql: `SELECT overall_status, count(*) AS clusters
FROM clusters
WHERE hub_name = {{hub}}
GROUP BY 1
ORDER BY 2 DESC`,
        chart: { type: "bars" },
        w: 4,
        h: 2,
      },
      {
        id: "health",
        title: "Health score, last 24 hours",
        description: "Hourly health score per cluster, from the snapshot history.",
        sql: `SELECT date_trunc('hour', s.snapshot_at) AS hour,
       s.cluster_name AS cluster,
       avg(s.health_score) AS health_score
FROM health_snapshots s
JOIN clusters c ON c.name = s.cluster_name
WHERE c.hub_name = {{hub}}
  AND s.resolution = 'hour'
  AND s.snapshot_at >= now() - INTERVAL 1 DAY
GROUP BY 1, 2
ORDER BY 1, 2`,
        chart: { type: "line" },
        w: 8,
        h: 2,
      },
      {
        id: "clusters",
        title: "Clusters on {{hub}}",
        sql: `SELECT name, overall_status, ocp_version, region, environment, health_score
FROM clusters
WHERE hub_name = {{hub}}
ORDER BY health_score`,
        chart: { type: "none" },
        w: 6,
        h: 3,
      },
      {
        id: "checks",
        title: "Failing checks",
        description: "Every health check on this hub that is not passing.",
        sql: `SELECT h.cluster_name AS cluster, h.title AS check_title, h.status, h.message
FROM health_checks h
JOIN clusters c ON c.name = h.cluster_name
WHERE c.hub_name = {{hub}}
  AND h.status IN ('fail', 'warn')
ORDER BY h.status, 1`,
        chart: { type: "none" },
        w: 6,
        h: 3,
      },
    ],
  },
  {
    id: "fixture-fleet",
    title: "Fleet trends",
    description: "Versions and changes across the whole fleet.",
    variables: [
      { name: "days", label: "Days", type: "number", default: 7, required: true },
    ],
    panels: [
      {
        id: "versions",
        title: "Clusters per OCP version",
        sql: `SELECT ocp_version, count(*) AS clusters
FROM clusters
GROUP BY 1
ORDER BY 1`,
        chart: { type: "bars" },
        w: 6,
        h: 2,
      },
      {
        id: "changes",
        title: "Changes per day, last {{days}} days",
        sql: `SELECT date_trunc('day', changed_at) AS day, kind, count(*) AS changes
FROM changes
WHERE changed_at >= now() - INTERVAL ({{days}}) DAY
GROUP BY 1, 2
ORDER BY 1, 2`,
        chart: { type: "line" },
        w: 6,
        h: 2,
      },
      {
        id: "worst",
        title: "Lowest health scores",
        sql: `SELECT name, hub_name, overall_status, health_score, ocp_version
FROM clusters
ORDER BY health_score
LIMIT 20`,
        chart: { type: "none" },
        w: 12,
        h: 3,
      },
    ],
  },
];

const byId = new Map<string, Definition>(
  DEFINITIONS.map((d) => {
    const def = normalizeDefinition(d);
    return [def.id, def];
  }));

// A deep copy, so a page that edits a fixture cannot change the next reader's.
export const fixtureDefinition = (id: string): Definition | null => {
  const def = byId.get(id);
  return def ? (JSON.parse(JSON.stringify(def)) as Definition) : null;
};

export const fixtureList = (): DashboardListEntry[] => [...byId.values()].map((d) => ({
  id: d.id,
  title: d.title,
  description: d.description,
  builtin: false,
  panels: d.panels.length,
  variables: d.variables.map((v) => v.name),
  updated_at: null,
}));
