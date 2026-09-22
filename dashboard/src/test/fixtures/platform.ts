// Utilization, the patching system of record, the collection manifest and the
// query plane's schema - the four responses the remaining pages are built from.

import type {
  CapacityResponse,
  CollectorTimingsResponse,
  ManifestAvailabilityResponse,
  ManifestResponse,
  MetricsHealthResponse,
  PatchJobResponse,
  PatchJobsResponse,
  PatchReportResponse,
  QueryResult,
  QuerySchemaResponse,
  TopNamespacesResponse,
  TopNodesResponse,
} from "../../api/types";

export const METRICS_HEALTH: MetricsHealthResponse = {
  source: "metrics.k8s.io (via each cluster's API server)",
  reachable: true,
  clusters_with_metrics: 4,
  clusters_total: 5,
  without_metrics: ["ocp-dev-iad-01"],
};

export const METRICS_HEALTH_DOWN: MetricsHealthResponse = {
  ...METRICS_HEALTH,
  reachable: false,
  clusters_with_metrics: 0,
  without_metrics: [],
};

export const TOP_NAMESPACES: TopNamespacesResponse = {
  by: "cpu",
  unit: "cores",
  results: [
    { namespace: "checkout-prod", cluster: "ocp-prod-iad-02", class: "application",
      app: "checkout", team: "payments", value: 6.02 },
    { namespace: "openshift-monitoring", cluster: "ocp-prod-iad-02", class: "platform",
      app: null, team: null, value: 3.41 },
    { namespace: "catalog-prod", cluster: "ocp-prod-iad-01", class: "application",
      app: "catalog", team: "retail", value: 1.44 },
  ],
};

export const TOP_NODES: TopNodesResponse = {
  by: "cpu",
  unit: "percent",
  results: [
    { node: "ip-10-4-1-21.ec2.internal", cluster: "ocp-prod-iad-02",
      roles: ["control-plane", "master"], value: 92.4 },
    { node: "ip-10-4-3-12.ec2.internal", cluster: "ocp-stage-iad-01",
      roles: ["worker"], value: 78.1 },
    { node: "ip-10-6-1-4.ec2.internal", cluster: "ocp-prod-sjc-01",
      roles: ["worker"], value: 33.0 },
  ],
};

export const CAPACITY_BY_CLUSTER: CapacityResponse = {
  group_by: "cluster",
  results: [
    { cluster: "ocp-prod-iad-02", clusters: 1, with_metrics: 1, used_cores: 80.9,
      allocatable_cores: 91.5, requests_cores: 54.25, headroom_cores: 10.6,
      used_percent: 88.4, used_bytes: 312613868339, allocatable_bytes: 395136991232,
      headroom_bytes: 82523122893, memory_used_percent: 79.1 },
    { cluster: "ocp-prod-sjc-01", clusters: 1, with_metrics: 1, used_cores: 20.1,
      allocatable_cores: 61.0, requests_cores: 30.5, headroom_cores: 40.9,
      used_percent: 33.0, used_bytes: 128849018880, allocatable_bytes: 265214230528,
      headroom_bytes: 136365211648, memory_used_percent: 48.6 },
  ],
};

export const CAPACITY_BY_HUB: CapacityResponse = {
  group_by: "hub",
  results: [
    { hub: "hub-east", clusters: 4, with_metrics: 3, used_cores: 150.3,
      allocatable_cores: 280.0, requests_cores: 170.0, headroom_cores: 129.7,
      used_percent: 53.7, used_bytes: 601295421440, allocatable_bytes: 1099511627776,
      headroom_bytes: 498216206336, memory_used_percent: 54.7 },
    { hub: "hub-west", clusters: 1, with_metrics: 1, used_cores: 20.1,
      allocatable_cores: 61.0, requests_cores: 30.5, headroom_cores: 40.9,
      used_percent: 33.0, used_bytes: 128849018880, allocatable_bytes: 265214230528,
      headroom_bytes: 136365211648, memory_used_percent: 48.6 },
  ],
};

// --------------------------------------------------------------------------- //
// patching
// --------------------------------------------------------------------------- //
export const PATCH_REPORT: PatchReportResponse = {
  jobs_total: 5,
  jobs_by_status: { completed: 2, running: 1, paused: 1, failed: 1 },
  avg_success_pct: 86,
  clusters: { succeeded: 11, failed: 2, pending: 3 },
};

export const PATCH_JOBS: PatchJobsResponse = {
  count: 2,
  jobs: [
    {
      id: "patch-2026-09-20-a",
      change_record: "CHG0041233",
      requested_by: "a.sthapit",
      approved_by: "m.okafor",
      approval_status: "approved",
      target_version: "4.16.9",
      status: "paused",
      source: "n8n",
      threshold_pct: 80,
      totals: { total: 5, succeeded: 3, skipped: 1, failed: 1, success_pct: 60 },
      created_at: "2026-09-20T14:02:00+00:00",
    },
    {
      id: "patch-2026-09-18-b",
      change_record: "CHG0041120",
      requested_by: "a.sthapit",
      approved_by: null,
      approval_status: "pending",
      target_version: "4.16.7",
      status: "completed",
      source: "n8n",
      threshold_pct: 80,
      totals: { total: 4, succeeded: 4, skipped: 0, failed: 0, success_pct: 100 },
      created_at: "2026-09-18T09:30:00+00:00",
    },
  ],
};

export const PATCH_JOB: PatchJobResponse = {
  ...PATCH_JOBS.jobs[0],
  started_at: "2026-09-20T14:10:00+00:00",
  finished_at: null,
  tasks: [
    { cluster: "ocp-prod-iad-01", phase: "upgrade", outcome: "passed",
      version_from: "4.16.7", version_to: "4.16.9", health_before: 97, health_after: 96 },
    { cluster: "ocp-prod-iad-02", phase: "precheck", outcome: "failed",
      version_from: "4.16.7", version_to: null, health_before: 74, health_after: null },
    { cluster: "ocp-dev-iad-01", phase: "precheck", outcome: "skipped",
      version_from: null, version_to: null, health_before: null, health_after: null },
  ],
  audit: [
    { ts: "2026-09-20T14:02:00+00:00", actor: "a.sthapit", action: "submitted",
      cluster: null, message: "CHG0041233" },
    { ts: "2026-09-20T14:05:00+00:00", actor: "m.okafor", action: "approved",
      cluster: null, message: "" },
    { ts: "2026-09-20T14:22:00+00:00", actor: "pipeline", action: "paused",
      cluster: "ocp-prod-iad-02", message: "health check below threshold" },
  ],
};

// --------------------------------------------------------------------------- //
// the collection manifest
// --------------------------------------------------------------------------- //
export const MANIFEST: ManifestResponse = {
  source: "/app/config/ocp-api-manifest.yaml",
  resources: [
    { key: "clusterversion", kind: "ClusterVersion", api_group: "config.openshift.io",
      version: "v1", scope: "cluster", domain: "platform", enabled: true,
      namespace_class: null, limit: null, interval_seconds: 0,
      description: "Current / desired OCP version, upgrade progress, available updates." },
    { key: "routes", kind: "Route", api_group: "route.openshift.io", version: "v1",
      scope: "namespaced", domain: "networking", enabled: true, namespace_class: null,
      limit: 2000, interval_seconds: 300,
      description: "Which hostname each namespace serves, and how TLS terminates." },
    { key: "clusterserviceversions", kind: "ClusterServiceVersion",
      api_group: "operators.coreos.com", version: "v1alpha1", scope: "namespaced",
      domain: "olm", enabled: false, namespace_class: null, limit: null,
      interval_seconds: 900, description: "Installed operators and their phase." },
  ],
  scrub_policy: [
    { what: "ConfigMap values", kept: "key names, byte sizes, certificate facts for PEM keys" },
    { what: "Secret values", kept: "key names, byte sizes, certificate subject and validity" },
  ],
  namespaces: {
    platform_names: ["default", "kube-node-lease", "kube-public", "kube-system", "openshift"],
    platform_prefixes: ["openshift-", "kube-", "open-cluster-management"],
    platform_label_keys: ["openshift.io/run-level"],
    ownership: {
      app: ["odl.io/app", "app.kubernetes.io/part-of"],
      team: ["odl.io/team"],
      tier: ["odl.io/tier"],
    },
  },
  keep_annotations: [
    "openshift.io/requester",
    "openshift.io/display-name",
    "deployment.kubernetes.io/revision",
  ],
  thresholds: {
    certificate_expiry_days: 30,
    pod_restart_threshold: 5,
    capacity_warning_percent: 85,
    cluster_admin_roles: ["cluster-admin"],
  },
  threshold_scope: {
    certificate_expiry_days: "collection+evaluation",
    pod_restart_threshold: "collection",
    capacity_warning_percent: "evaluation",
    cluster_admin_roles: "collection",
  },
  health_checks: [
    { name: "cluster-reachable", title: "Cluster reachable", enabled: true,
      severity: "critical", units: [], warn: {}, fail: {},
      description: "Whether the collector could connect to the cluster at all." },
    { name: "cpu-headroom", title: "CPU headroom", enabled: true, severity: "warning",
      units: ["percent"], warn: { percent: 85 }, fail: { percent: 95 },
      description: "How much of the fleet's allocatable CPU is already requested." },
  ],
  applications: {
    source: "labels",
    mapping: null,
    platform_apps: [],
  },
};

export const MANIFEST_AVAILABILITY: ManifestAvailabilityResponse = {
  resources: ["clusterversion", "routes", "clusterserviceversions"],
  clusters: [
    {
      name: "ocp-prod-iad-02",
      reachable: true,
      status: "warning",
      last_synced: "2026-09-20T20:58:02.911312+00:00",
      resources: {
        clusterversion: { status: "collected", count: 1, duration_ms: 12, error: null,
          collected_at: "2026-09-20T20:58:02+00:00", cached: false, interval_seconds: 0 },
        routes: { status: "collected", count: 24, duration_ms: 61, error: null,
          collected_at: "2026-09-20T20:58:02+00:00", cached: false, interval_seconds: 300,
          bytes: 81920, objects: 24, parse_ms: 4, requests: 1 },
        clusterserviceversions: { status: "forbidden", count: 0, duration_ms: 3,
          error: "clusterserviceversions.operators.coreos.com is forbidden",
          collected_at: "2026-09-20T20:58:02+00:00", cached: false, interval_seconds: 900 },
      },
    },
    {
      name: "ocp-stage-iad-01",
      reachable: true,
      status: "critical",
      last_synced: "2026-09-20T20:57:40.221000+00:00",
      resources: {
        clusterversion: { status: "collected", count: 1, duration_ms: 14, error: null,
          collected_at: "2026-09-20T20:57:40+00:00", cached: false, interval_seconds: 0 },
        routes: { status: "unavailable", count: 0, duration_ms: 2,
          error: "the server could not find the requested resource",
          collected_at: "2026-09-20T20:57:40+00:00", cached: true, interval_seconds: 300 },
      },
    },
  ],
  totals: {
    clusterversion: { collected: 2 },
    routes: { collected: 1, unavailable: 1 },
    clusterserviceversions: { forbidden: 1 },
  },
};

export const COLLECTOR_TIMINGS: CollectorTimingsResponse = {
  stages: ["fetch_ms", "parse_ms", "assemble_ms", "health_ms", "persist_ms"],
  fleet: {
    clusters: 2,
    clusters_total: 5,
    cpu_percent: 38.2,
    parse_percent_of_fetch: 21,
    bytes_per_fetch_second: 5242880,
    totals: { total_ms: 4210, fetch_ms: 2600, parse_ms: 540, assemble_ms: 410,
      health_ms: 120, persist_ms: 480, cpu_ms: 1550, bytes: 13631488 },
    share_percent: { fetch_ms: 61.7, parse_ms: 12.8, assemble_ms: 9.7, health_ms: 2.9,
      persist_ms: 11.4 },
    p50: { total_ms: 2105, fetch_ms: 1300, parse_ms: 270, assemble_ms: 205, health_ms: 60,
      persist_ms: 240 },
    p95: { total_ms: 2980, fetch_ms: 1810, parse_ms: 390, assemble_ms: 280, health_ms: 90,
      persist_ms: 330 },
  },
  last_run: { duration_ms: 8421, trigger: "scheduled", clusters_total: 5 },
  clusters: [
    { cluster: "ocp-prod-iad-02", hub: "hub-east", total_ms: 2980, cpu_ms: 990,
      fetch_ms: 1810, parse_ms: 390, assemble_ms: 280, health_ms: 90, persist_ms: 330,
      bytes: 9437184, objects: 1842, kinds_fetched: 21, kinds_cached: 9 },
    { cluster: "ocp-prod-sjc-01", hub: "hub-west", total_ms: 1230, cpu_ms: 560,
      fetch_ms: 790, parse_ms: 150, assemble_ms: 130, health_ms: 30, persist_ms: 150,
      bytes: 4194304, objects: 901, kinds_fetched: 21, kinds_cached: 9 },
  ],
};

// --------------------------------------------------------------------------- //
// the query plane
// --------------------------------------------------------------------------- //
// Three tables is enough for every builder rule: `clusters` is the join target,
// `pod_issues` carries a cluster_name so the join is offered, and `hubs` does
// not so it is refused.
export const QUERY_SCHEMA: QuerySchemaResponse = {
  tables: [
    {
      name: "clusters",
      description: "One row per managed OpenShift cluster.",
      columns: [
        { name: "name", type: "VARCHAR", description: "Cluster name. Primary key." },
        { name: "hub_name", type: "VARCHAR", description: "Hub that manages this cluster." },
        { name: "region", type: "VARCHAR", description: "Placement region." },
        { name: "environment", type: "VARCHAR", description: "Environment label." },
        { name: "ocp_version", type: "VARCHAR", description: "Current OCP version." },
        { name: "overall_status", type: "VARCHAR", description: "Rollup status." },
        { name: "health_score", type: "INTEGER", description: "0-100." },
        { name: "nodes_total", type: "INTEGER", description: "Nodes in the cluster." },
        { name: "upgrading", type: "BOOLEAN", description: "An upgrade is in progress." },
        { name: "last_synced", type: "TIMESTAMP", description: "Last collection." },
        { name: "labels", type: "JSON", description: "Cluster labels from ACM." },
      ],
    },
    {
      name: "pod_issues",
      description: "One row per pod that is not running cleanly.",
      columns: [
        { name: "cluster_name", type: "VARCHAR", description: "Cluster this pod is on." },
        { name: "namespace", type: "VARCHAR", description: "Namespace." },
        { name: "name", type: "VARCHAR", description: "Pod name." },
        { name: "reason", type: "VARCHAR", description: "Why it is unhealthy." },
        { name: "restarts", type: "INTEGER", description: "Restart count." },
        { name: "started_at", type: "TIMESTAMP", description: "When the pod started." },
      ],
    },
    {
      name: "hubs",
      description: "One row per ACM hub.",
      columns: [
        { name: "name", type: "VARCHAR", description: "Hub name." },
        { name: "region", type: "VARCHAR", description: "Hub region." },
        { name: "managed_count", type: "INTEGER", description: "Clusters managed." },
        { name: "reachable", type: "BOOLEAN", description: "The hub answered." },
      ],
    },
  ],
  notes: [],
  enumerations: {},
  examples: [
    { question: "Which regions have unhealthy clusters?",
      sql: "SELECT region, count(*) AS clusters\nFROM clusters\nWHERE overall_status <> 'healthy'\nGROUP BY region" },
  ],
  snapshot: {
    generation: 11,
    built_at: "2026-09-20T20:58:11+00:00",
    age_seconds: 42,
    build_ms: 107,
    stale: false,
    rebuilding: false,
    rows: { clusters: 5, pod_issues: 24, hubs: 2 },
    total_rows: 31,
  },
  limits: { max_rows: 500, timeout_seconds: 10.0 },
};

// A result in the wire shape POST /api/query/sql answers with.
export const queryResult = (over: Partial<QueryResult> = {}): QueryResult => ({
  columns: ["name", "overall_status", "health_score"],
  column_types: ["VARCHAR", "VARCHAR", "INTEGER"],
  rows: [
    ["ocp-prod-iad-01", "healthy", 97],
    ["ocp-prod-iad-02", "warning", 74],
    ["ocp-stage-iad-01", "critical", 38],
  ],
  row_count: 3,
  elapsed_ms: 7,
  generation: 11,
  truncated: false,
  sql: "SELECT name, overall_status, health_score FROM clusters",
  ...over,
});
