// Fleet responses, in the shapes data-layer/app/serialize.py produces.
//
// Typed with `src/api/types.ts`: these annotations are what check the
// hand-written response interfaces, so a fixture that drifts from a handler is
// a type error rather than a test that passes against a shape the API does not
// serve.
//
// Two hubs, five clusters, one of each status and one mid-upgrade: enough for a
// table to sort, a filter to narrow and a status pill to be worth asserting on.
// Names, regions and versions are the ones the sim fleet actually uses, because
// a fixture that says "foo" hides a formatting bug that "ocp-prod-iad-01" finds.

import type {
  BlastRadiusResponse,
  ClusterSummary,
  ClustersResponse,
  InsightsSummaryResponse,
  OperatorVersionsResponse,
  OverviewResponse,
  SummaryResponse,
  VersionsResponse,
} from "../../api/types";

export const HUBS: OverviewResponse["hubs"] = [
  {
    name: "hub-east",
    region: "us-east-1",
    datacenter: "iad1",
    reachable: true,
    managed_count: 4,
    last_synced: "2026-09-20T20:58:02.911312+00:00",
    last_error: null,
  },
  {
    name: "hub-west",
    region: "us-west-2",
    datacenter: "sjc1",
    reachable: false,
    managed_count: 1,
    last_synced: "2026-09-20T20:41:11.002001+00:00",
    last_error: "dial tcp 10.4.2.9:6443: i/o timeout",
  },
];

function clusterSummary(over: Partial<ClusterSummary> = {}): ClusterSummary {
  const base: ClusterSummary = {
    name: "ocp-prod-iad-01",
    hub: "hub-east",
    region: "us-east-1",
    datacenter: "iad1",
    environment: "prod",
    cloud: "aws",
    platform: "AWS",
    ocp_version: "4.16.7",
    desired_version: "4.16.7",
    channel: "stable-4.16",
    upgrading: false,
    upgrade_percent: null,
    overall_status: "healthy",
    health_score: 97,
    checks: { passed: 11, warned: 0, failed: 0 },
    nodes: { ready: 6, total: 6 },
    namespaces: { application: 14, platform: 61 },
    applications: 9,
    workloads: 128,
    pod_issues: 0,
    certs_expiring: 0,
    utilization: { metrics_available: true, cpu_percent: 41.2, memory_percent: 55.8 },
    reachable: true,
    last_synced: "2026-09-20T20:58:02.911312+00:00",
    age_seconds: 42,
    stale: false,
    timings: null,
  };
  return { ...base, ...over };
}

export const CLUSTERS: ClusterSummary[] = [
  clusterSummary(),
  clusterSummary({
    name: "ocp-prod-iad-02",
    overall_status: "warning",
    health_score: 74,
    checks: { passed: 9, warned: 2, failed: 0 },
    nodes: { ready: 5, total: 6 },
    pod_issues: 3,
    certs_expiring: 2,
    applications: 7,
    namespaces: { application: 11, platform: 61 },
    utilization: { metrics_available: true, cpu_percent: 88.4, memory_percent: 79.1 },
  }),
  clusterSummary({
    name: "ocp-stage-iad-01",
    environment: "stage",
    overall_status: "critical",
    health_score: 38,
    ocp_version: "4.15.22",
    channel: "stable-4.15",
    desired_version: "4.16.7",
    upgrading: true,
    upgrade_percent: 62,
    checks: { passed: 6, warned: 2, failed: 3 },
    nodes: { ready: 3, total: 5 },
    pod_issues: 17,
    certs_expiring: 1,
    applications: 4,
    namespaces: { application: 8, platform: 58 },
    utilization: { metrics_available: true, cpu_percent: 96.5, memory_percent: 91.0 },
  }),
  clusterSummary({
    name: "ocp-dev-iad-01",
    environment: "dev",
    overall_status: "unknown",
    health_score: null,
    reachable: false,
    stale: true,
    age_seconds: 5400,
    checks: { passed: 0, warned: 0, failed: 0 },
    nodes: { ready: 0, total: 3 },
    applications: 2,
    namespaces: { application: 5, platform: 54 },
    utilization: { metrics_available: false, cpu_percent: null, memory_percent: null },
  }),
  clusterSummary({
    name: "ocp-prod-sjc-01",
    hub: "hub-west",
    region: "us-west-2",
    datacenter: "sjc1",
    ocp_version: "4.16.4",
    desired_version: "4.16.4",
    health_score: 91,
    applications: 6,
    namespaces: { application: 10, platform: 60 },
    utilization: { metrics_available: true, cpu_percent: 33.0, memory_percent: 48.6 },
  }),
];

export const clustersResponse = (rows: ClusterSummary[] = CLUSTERS): ClustersResponse =>
  ({ count: rows.length, clusters: rows });

export const OVERVIEW: OverviewResponse = {
  primary_dimension: "hub",
  clusters_total: CLUSTERS.length,
  counts: { healthy: 2, warning: 1, critical: 1, unknown: 1 },
  upgrading: 1,
  hubs: HUBS,
  sweep: { running: false, trigger: "scheduled", started_at: "2026-09-20T20:58:02.931736+00:00",
    total: 5, done: 5, ok: 4, failed: 1, collectors: [] },
  last_run: { at: "2026-09-20T20:58:02.931736+00:00", ok: true, trigger: "scheduled" },
  last_collection: { duration_ms: 8421, clusters_ok: 4, clusters_failed: 1,
    finished_at: "2026-09-20T20:58:11.352001+00:00" },
};

// The same document mid-sweep: the banner, the progress bar and the per-
// collector breakdown all come off this one.
export const OVERVIEW_SWEEPING: OverviewResponse = {
  ...OVERVIEW,
  sweep: {
    running: true,
    trigger: "manual",
    started_at: "2026-09-20T21:02:00.000000+00:00",
    total: 5,
    done: 2,
    ok: 2,
    failed: 1,
    collectors: [
      { hubs: ["hub-east"], shard: "0/2", done: 2, total: 4, running: true },
      { hubs: ["hub-west"], shard: "1/2", done: 0, total: 1, running: false },
    ],
  },
};

export const SUMMARY_BY_HUB: SummaryResponse = {
  group_by: "hub",
  groups: [
    { key: "hub-east", total: 4, rollup_status: "critical",
      counts: { healthy: 1, warning: 1, critical: 1, unknown: 1 },
      applications: 22, namespaces: 38, unassigned_namespaces: 3 },
    { key: "hub-west", total: 1, rollup_status: "healthy",
      counts: { healthy: 1, warning: 0, critical: 0, unknown: 0 },
      applications: 6, namespaces: 10, unassigned_namespaces: 0 },
  ],
};

export const SUMMARY_BY_REGION: SummaryResponse = {
  group_by: "region",
  groups: [
    { key: "us-east-1", total: 4, rollup_status: "critical",
      counts: { healthy: 1, warning: 1, critical: 1, unknown: 1 },
      applications: 22, namespaces: 38, unassigned_namespaces: 3 },
    { key: "us-west-2", total: 1, rollup_status: "healthy",
      counts: { healthy: 1, warning: 0, critical: 0, unknown: 0 },
      applications: 6, namespaces: 10, unassigned_namespaces: 0 },
  ],
};

export const INSIGHTS_SUMMARY: InsightsSummaryResponse = {
  certificates: { expired: 1, expiring: 5 },
  pod_issues: { platform: 22, application: 2 },
  quotas_near_limit: 2,
  machine_config_pools: { degraded: 1, updating: 1 },
  olm_operators_unhealthy: 2,
  olm_upgrades_pending: 1,
  pvcs_pending: 5,
  routes_rejected: 0,
  warning_events: 144,
  applications: 8,
  clusters_without_metrics: 1,
};

export const VERSIONS: VersionsResponse = {
  versions: [
    { version: "4.16.7", count: 3,
      clusters: [
        { name: "ocp-prod-iad-01", hub: "hub-east", region: "us-east-1",
          environment: "prod", status: "healthy", upgrading: false },
        { name: "ocp-prod-iad-02", hub: "hub-east", region: "us-east-1",
          environment: "prod", status: "warning", upgrading: false },
        { name: "ocp-dev-iad-01", hub: "hub-east", region: "us-east-1",
          environment: "dev", status: "unknown", upgrading: false },
      ] },
    { version: "4.16.4", count: 1,
      clusters: [{ name: "ocp-prod-sjc-01", hub: "hub-west", region: "us-west-2",
        environment: "prod", status: "healthy", upgrading: false }] },
    { version: "4.15.22", count: 1,
      clusters: [{ name: "ocp-stage-iad-01", hub: "hub-east", region: "us-east-1",
        environment: "stage", status: "critical", upgrading: true }] },
  ],
  channels: [{ channel: "stable-4.15", count: 1 }, { channel: "stable-4.16", count: 4 }],
  distinct_versions: 3,
};

export const OPERATOR_VERSIONS: OperatorVersionsResponse = {
  operators: [
    { operator: "ingress", distinct: 2,
      versions: [{ version: "4.16.7", count: 4 }, { version: "4.15.22", count: 1 }] },
    { operator: "network", distinct: 2,
      versions: [{ version: "4.16.7", count: 3 }, { version: "4.16.4", count: 2 }] },
    { operator: "authentication", distinct: 1, versions: [{ version: "4.16.7", count: 5 }] },
  ],
};

export const BLAST_RADIUS: BlastRadiusResponse = {
  query: {
    operator: null, operator_version: null, ocp_version: "4.16.7", degraded_only: false,
    olm_operator: null, olm_version: null, image: null,
  },
  summary: {
    clusters_impacted: 2,
    applications_impacted: 3,
    critical_applications: 1,
    teams_impacted: 2,
    workloads_impacted: 2,
    by_environment: { prod: 1, stage: 1 },
    by_hub: { "hub-east": 2 },
    by_region: { "us-east-1": 2 },
    platform_namespaces_impacted: ["openshift-ingress"],
  },
  clusters: [
    { name: "ocp-prod-iad-02", hub: "hub-east", region: "us-east-1", datacenter: "iad1",
      environment: "prod", ocp_version: "4.16.7",
      reason: "ocp_version 4.16.7", status: "warning" },
    { name: "ocp-stage-iad-01", hub: "hub-east", region: "us-east-1", datacenter: "iad1",
      environment: "stage", ocp_version: "4.16.7",
      reason: "ocp_version 4.16.7", status: "critical" },
  ],
  applications: [
    { app: "checkout", assigned: true, team: "payments", tier: "critical",
      namespace: "checkout-prod", cluster_count: 2,
      clusters: [
        { cluster: "ocp-prod-iad-02", hub: "hub-east", region: "us-east-1",
          environment: "prod", status: "warning", app_status: "warning" },
        { cluster: "ocp-stage-iad-01", hub: "hub-east", region: "us-east-1",
          environment: "stage", status: "critical", app_status: "healthy" },
      ] },
    { app: "catalog", assigned: true, team: "retail", tier: "standard",
      namespace: "catalog-prod", cluster_count: 1,
      clusters: [
        { cluster: "ocp-prod-iad-02", hub: "hub-east", region: "us-east-1",
          environment: "prod", status: "warning", app_status: "healthy" },
      ] },
    { app: "search", assigned: true, team: "retail", tier: "standard",
      namespace: "search-stage", cluster_count: 1,
      clusters: [
        { cluster: "ocp-stage-iad-01", hub: "hub-east", region: "us-east-1",
          environment: "stage", status: "critical", app_status: "healthy" },
      ] },
  ],
  workloads: [
    { cluster: "ocp-prod-iad-02", namespace: "checkout-prod", kind: "Deployment",
      name: "checkout-api", container: "api", image: "quay.io/acme/checkout:1.9.2" },
    { cluster: "ocp-stage-iad-01", namespace: "checkout-stage", kind: "Deployment",
      name: "checkout-api", container: "api", image: "quay.io/acme/checkout:1.9.2" },
  ],
};
