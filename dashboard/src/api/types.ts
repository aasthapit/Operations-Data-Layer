// Response shapes for every endpoint `src/api.ts` calls.
//
// These are hand-written because the FastAPI routes declare no `response_model`:
// `schema.ts` (generated) therefore knows the paths, the query parameters and
// the request bodies, but nothing about what comes back. ADR-0005 records the
// follow-up that deletes this file - adding `response_model` to the routes makes
// the responses generated too.
//
// Three sources, named per block:
//   - the handler in `data-layer/app/api/*.py` and the serializers it calls
//     (`data-layer/app/serialize.py`), which is what actually goes on the wire;
//   - the fixtures in `src/test/fixtures/`, which are typed with these
//     interfaces - a fixture that drifts from a handler now fails `tsc`;
//   - `docs/nl-query.md` for the query, dashboards and agent shapes.
//
// Convention: a field is optional here only when the handler can leave it out,
// not when a fixture happens not to carry it. `null` is spelled out, because
// the serializers emit nulls rather than omitting keys.

// --------------------------------------------------------------------------- //
// shared
// --------------------------------------------------------------------------- //

/** The fleet rollup vocabulary (`_STATUSES` in `app/api/health.py`). */
export type HealthStatus = "healthy" | "warning" | "critical" | "unknown";

/** `application` or `platform` (`ns_class` throughout the collector). */
export type NamespaceClass = string;

/** A `summary` payload: per-kind and open by design (`serialize.resource_dict`). */
export interface ResourceSummary {
  [field: string]: unknown;
}

// --------------------------------------------------------------------------- //
// fleet - app/api/health.py, app/api/clusters.py, app/api/versions.py,
//         app/api/blast_radius.py, app/api/admin.py
// --------------------------------------------------------------------------- //

/** `serialize.cluster_summary` - one row of `GET /api/clusters`. */
export interface ClusterSummary {
  name: string;
  hub: string | null;
  region: string | null;
  datacenter: string | null;
  environment: string | null;
  cloud: string | null;
  platform: string | null;
  ocp_version: string | null;
  desired_version: string | null;
  channel: string | null;
  upgrading: boolean | null;
  upgrade_percent: number | null;
  overall_status: HealthStatus;
  health_score: number | null;
  checks: { passed: number | null; warned: number | null; failed: number | null };
  nodes: { ready: number | null; total: number | null };
  namespaces: { application: number | null; platform: number | null };
  applications: number | null;
  workloads: number | null;
  pod_issues: number | null;
  certs_expiring: number | null;
  utilization: {
    metrics_available: boolean;
    cpu_percent: number | null;
    memory_percent: number | null;
  };
  reachable: boolean | null;
  last_synced: string | null;
  age_seconds: number | null;
  stale: boolean;
  /** Per-stage collection costs, null until a sweep has written them. */
  timings: Record<string, number> | null;
}

export interface ClustersResponse {
  count: number;
  clusters: ClusterSummary[];
}

/** `serialize.capacity_dict`. */
export interface Capacity {
  metrics_available: boolean;
  cpu: {
    capacity_cores: number | null;
    allocatable_cores: number | null;
    requests_cores: number | null;
    limits_cores: number | null;
    used_cores: number | null;
    used_percent: number | null;
    requests_percent: number | null;
    headroom_cores: number | null;
  };
  memory: {
    capacity_bytes: number | null;
    allocatable_bytes: number | null;
    requests_bytes: number | null;
    limits_bytes: number | null;
    used_bytes: number | null;
    used_percent: number | null;
    requests_percent: number | null;
    headroom_bytes: number | null;
  };
  pods: {
    capacity: number | null;
    total: number | null;
    running: number | null;
    used_percent: number | null;
  };
}

/** `serialize.operator_dict`. */
export interface ClusterOperator {
  name: string;
  version: string | null;
  available: boolean | null;
  progressing: boolean | null;
  degraded: boolean | null;
  critical: boolean | null;
  message: string | null;
}

/** `serialize.node_dict`. */
export interface NodeDetail {
  name: string;
  roles: string[];
  ready: boolean | null;
  schedulable: boolean | null;
  conditions: Record<string, boolean>;
  kubelet_version: string | null;
  os_image: string | null;
  kernel_version: string | null;
  container_runtime: string | null;
  architecture: string | null;
  instance_type: string | null;
  zone: string | null;
  internal_ip: string | null;
  cpu: {
    capacity_cores: number | null;
    allocatable_cores: number | null;
    used_cores: number | null;
    used_percent: number | null;
  };
  memory: {
    capacity_bytes: number | null;
    allocatable_bytes: number | null;
    used_bytes: number | null;
    used_percent: number | null;
  };
  pods: { capacity: number | null; running: number | null };
  images: { count: number | null; bytes: number | null };
  taints: Array<{ key?: string; value?: string; effect?: string }>;
  created_at: string | null;
}

/** `serialize.namespace_dict`. */
export interface NamespaceDetail {
  name: string;
  class: NamespaceClass;
  app: string | null;
  team: string | null;
  tier: string | null;
  environment: string | null;
  assigned: boolean;
  ownership_source: string | null;
  status: string | null;
  phase: string | null;
  requester: string | null;
  display_name: string | null;
  labels: Record<string, string>;
  workloads: number | null;
  replicas_desired: number | null;
  replicas_ready: number | null;
  pods: {
    total: number | null;
    running: number | null;
    pending: number | null;
    failed: number | null;
    succeeded: number | null;
    restarts: number | null;
    issues: number | null;
  };
  cpu: { requests_cores: number | null; limits_cores: number | null; used_cores: number | null };
  memory: {
    requests_bytes: number | null;
    limits_bytes: number | null;
    used_bytes: number | null;
  };
  resource_counts: Record<string, number>;
  images: string[];
  created_at: string | null;
}

/** `serialize.application_dict` - an application namespace on one cluster. */
export interface ApplicationNamespace {
  name: string;
  namespace: string;
  team: string | null;
  tier: string | null;
  environment: string | null;
  assigned: boolean;
  status: string | null;
  replicas_desired: number | null;
  replicas_ready: number | null;
  pod_issues: number | null;
  cpu_used_cores: number | null;
  memory_used_bytes: number | null;
}

/** One container of a workload, from the collector's parser (`detail=true` only). */
export interface WorkloadContainer {
  name: string;
  image?: string | null;
  requests?: Record<string, string>;
  limits?: Record<string, string>;
  env?: Array<{
    name: string;
    /** Where the value comes from; the value itself is never collected. */
    from?: { kind: string; name?: string; key?: string; path?: string };
  }>;
  env_from?: Array<{ kind: string; name: string }>;
}

/** `serialize.workload_dict`; the last five fields only with `detail=true`. */
export interface Workload {
  cluster: string;
  namespace: string;
  class: NamespaceClass;
  kind: string;
  name: string;
  status: string | null;
  replicas: {
    desired: number | null;
    ready: number | null;
    available: number | null;
    updated: number | null;
  };
  images: string[];
  service_account: string | null;
  strategy: string | null;
  created_at: string | null;
  containers?: WorkloadContainer[];
  config_refs?: Array<{ kind: string; name: string; via: string }>;
  node_selector?: Record<string, string>;
  labels?: Record<string, string>;
  conditions?: Record<string, boolean>;
}

/** `serialize.pod_issue_dict`. */
export interface PodIssue {
  cluster: string;
  namespace: string;
  class: NamespaceClass;
  name: string;
  node: string | null;
  phase: string | null;
  reason: string | null;
  message: string | null;
  restarts: number | null;
  /** `"<kind>/<name>"`, or null when the pod has no owner. */
  owner: string | null;
  containers_ready: string | null;
  started_at: string | null;
}

/** `serialize.resource_dict` - one inventory object. */
export interface ResourceRow {
  cluster: string;
  key: string;
  kind: string;
  api_group: string | null;
  namespace: string | null;
  class: NamespaceClass | null;
  name: string;
  status: string | null;
  expires_at: string | null;
  labels: Record<string, string>;
  summary: ResourceSummary;
  created_at: string | null;
}

/** `serialize.resource_status_dict`; the tiering fields only when recorded. */
export interface ResourceStatus {
  key: string;
  status: string;
  count: number | null;
  duration_ms: number | null;
  error: string | null;
  collected_at?: string;
  cached?: boolean;
  bytes?: number;
  objects?: number;
  parse_ms?: number;
  requests?: number;
  interval_seconds?: number;
}

/** `serialize.check_dict`. */
export interface HealthCheckResult {
  name: string;
  title: string;
  status: string;
  severity: string;
  message: string | null;
  /** What the check measured, keyed by unit. */
  value: Record<string, number | string>;
  /** The warn / fail levels that applied. */
  levels: Record<string, number | string>;
}

/** `serialize.cluster_detail` - `GET /api/clusters/{name}`.
 *
 * `applications` is overwritten by the detail document: a count in the summary
 * row, the application namespaces themselves here, which is why the summary's
 * own `applications` is omitted rather than extended. */
export interface ClusterDetail extends Omit<ClusterSummary, "applications"> {
  cluster_id: string | null;
  infrastructure_name: string | null;
  vendor: string | null;
  kube_version: string | null;
  available_updates: string[];
  managed_available: boolean | null;
  last_error: string | null;
  collect_ms: number | null;
  platform_config: {
    api_url: string | null;
    control_plane_topology: string | null;
    infrastructure_topology: string | null;
    network_type: string | null;
    cluster_network: string[];
    service_network: string[];
    apps_domain: string | null;
  };
  capacity: Capacity;
  operators: ClusterOperator[];
  nodes_detail: NodeDetail[];
  namespaces_detail: NamespaceDetail[];
  applications: ApplicationNamespace[];
  pod_issues_detail: PodIssue[];
  resource_status: ResourceStatus[];
  health_checks: HealthCheckResult[];
}

export interface ClusterNodesResponse {
  cluster: string;
  nodes: NodeDetail[];
}

export interface ClusterNamespacesResponse {
  cluster: string;
  count: number;
  namespaces: NamespaceDetail[];
}

export interface ClusterWorkloadsResponse {
  cluster: string;
  count: number;
  workloads: Workload[];
}

export interface ClusterPodIssuesResponse {
  cluster: string;
  count: number;
  pod_issues: PodIssue[];
}

export interface ClusterResourcesResponse {
  cluster: string;
  count: number;
  resources: ResourceRow[];
}

/** `serialize.snapshot_dict`. Every measurement is null on a sweep that could
 * not reach the cluster, so the whole row past `at` is nullable. */
export interface Snapshot {
  at: string | null;
  resolution: string;
  samples: number;
  overall_status: HealthStatus | null;
  health_score: number | null;
  passed: number | null;
  warned: number | null;
  failed: number | null;
  failed_checks: string[];
  warned_checks: string[];
  operators_degraded: number | null;
  ocp_version: string | null;
  upgrading: boolean | null;
  cpu_used_cores: number | null;
  cpu_used_cores_max: number | null;
  cpu_allocatable_cores: number | null;
  memory_used_bytes: number | null;
  memory_used_bytes_max: number | null;
  memory_allocatable_bytes: number | null;
  pods_running: number | null;
  pod_issues: number | null;
  pod_issues_platform: number | null;
  pod_issues_application: number | null;
  crashloops: number | null;
  image_pull_errors: number | null;
  oom_killed: number | null;
  pending_pods: number | null;
  restarts_total: number | null;
  warning_events: number | null;
  events_by_reason: Record<string, number>;
  nodes_total: number | null;
  nodes_ready: number | null;
  namespaces_application: number | null;
  applications_total: number | null;
  workloads_total: number | null;
  certs_expiring_total: number | null;
}

/** `GET /api/clusters/{name}/timeline`. The fixtures carry the subset of
 * `Snapshot` a chart reads, so the rows are partial here on purpose. */
export interface ClusterTimelineResponse {
  cluster: string;
  resolution?: string;
  count?: number;
  snapshots: Array<Partial<Snapshot> & { at: string | null }>;
}

/** `GET /api/health/overview` (`app/api/health.py:overview`). */
export interface OverviewResponse {
  primary_dimension: string;
  clusters_total: number;
  counts: Record<HealthStatus, number>;
  upgrading: number;
  hubs: Array<{
    name: string;
    region: string | null;
    datacenter: string | null;
    reachable: boolean | null;
    managed_count: number | null;
    last_synced: string | null;
    last_error: string | null;
  }>;
  /** `runner.progress()` plus an ISO `started_at`. */
  sweep: {
    running: boolean;
    trigger?: string | null;
    started_at: string | null;
    total?: number;
    done?: number;
    ok?: number;
    failed?: number;
    collectors?: Array<{
      hubs: string[];
      shard: string | null;
      done: number;
      total: number;
      running: boolean;
    }>;
  };
  last_run: { at: string | null; ok: boolean; trigger: string } | null;
  last_collection: {
    duration_ms: number | null;
    clusters_ok: number | null;
    clusters_failed: number | null;
    finished_at: string | null;
  } | null;
}

/** `GET /api/health/summary` (`app/api/health.py:_summary`). */
export interface SummaryResponse {
  group_by: string;
  groups: Array<{
    key: string;
    total: number;
    counts: Record<HealthStatus, number>;
    rollup_status: HealthStatus;
    applications: number;
    namespaces: number;
    unassigned_namespaces: number;
  }>;
}

/** `GET /api/versions` (`app/api/versions.py:_distribution`). */
export interface VersionsResponse {
  versions: Array<{
    version: string;
    count: number;
    clusters: Array<{
      name: string;
      hub: string | null;
      region: string | null;
      environment: string | null;
      status: HealthStatus;
      upgrading: boolean | null;
    }>;
  }>;
  channels: Array<{ channel: string; count: number }>;
  distinct_versions: number;
}

/** `GET /api/versions/operators`. */
export interface OperatorVersionsResponse {
  operators: Array<{
    operator: string;
    versions: Array<{ version: string; count: number }>;
    distinct: number;
  }>;
}

/** `GET /api/blast-radius` (`app/api/blast_radius.py:blast_radius`). */
export interface BlastRadiusResponse {
  /** The query echoed back, so a saved result says what produced it. */
  query: {
    operator: string | null;
    operator_version: string | null;
    ocp_version: string | null;
    degraded_only: boolean;
    olm_operator: string | null;
    olm_version: string | null;
    image: string | null;
  };
  summary: {
    clusters_impacted: number;
    applications_impacted: number;
    critical_applications: number;
    teams_impacted: number;
    workloads_impacted: number;
    platform_namespaces_impacted: string[];
    by_environment: Record<string, number>;
    by_hub: Record<string, number>;
    by_region: Record<string, number>;
  };
  clusters: Array<{
    name: string;
    hub: string | null;
    region: string | null;
    datacenter: string | null;
    environment: string | null;
    ocp_version: string | null;
    status: HealthStatus;
    /** Why it matched, already joined ("image x (x3); OCP 4.16"). */
    reason: string;
  }>;
  applications: Array<{
    app: string;
    assigned: boolean;
    team: string | null;
    tier: string | null;
    namespace: string | null;
    cluster_count: number;
    clusters: Array<{
      cluster: string;
      hub: string | null;
      region: string | null;
      environment: string | null;
      status: HealthStatus;
      app_status: string | null;
    }>;
  }>;
  workloads: Array<{
    cluster: string;
    namespace: string;
    kind: string;
    name: string;
    container: string;
    image: string;
  }>;
}

/** `POST /api/refresh` (`app/api/admin.py:refresh`, `queue_refresh`). A sweep
 * run in the foreground answers with the runner's own result instead, which is
 * why everything past `accepted` is optional. */
export interface RefreshResponse {
  accepted?: boolean;
  mode?: "background" | "queued";
  full?: boolean;
  collectors?: number;
  cluster?: string;
  [field: string]: unknown;
}

// --------------------------------------------------------------------------- //
// applications - app/api/applications.py
// --------------------------------------------------------------------------- //

/** One cluster an application runs on (`applications.py:_group`). */
export interface ApplicationPlacement {
  cluster: string;
  namespace: string;
  hub: string | null;
  region: string | null;
  environment: string | null;
  cluster_status: HealthStatus | null;
  ocp_version: string | null;
  status: string | null;
  workloads: number | null;
  replicas_desired: number | null;
  replicas_ready: number | null;
  pod_issues: number | null;
  cpu_used_cores: number | null;
  memory_used_bytes: number | null;
  namespace_environment: string | null;
}

/** One grouped application. `placements` is dropped from the list response
 * unless `placements=true`; the detail endpoint always carries it. */
export interface Application {
  app: string;
  assigned: boolean;
  team: string | null;
  tier: string | null;
  status: HealthStatus;
  cluster_count: number;
  environments: string[];
  namespace_environments: string[];
  hubs: string[];
  regions: string[];
  workloads: number;
  replicas_desired: number;
  replicas_ready: number;
  pod_issues: number;
  cpu_used_cores: number | null;
  memory_used_bytes: number | null;
  clusters: string[];
  placements?: ApplicationPlacement[];
}

export interface ApplicationsResponse {
  count: number;
  total: number;
  offset: number;
  teams: string[];
  /** Where ownership comes from: `labels` or a mapping file. */
  source: string;
  applications: Application[];
}

/** `GET /api/applications/{app}` - the grouped row plus its detail sections. */
export interface ApplicationDetail extends Application {
  placements: ApplicationPlacement[];
  namespaces: NamespaceDetail[];
  workloads_detail: Workload[];
}

// --------------------------------------------------------------------------- //
// insights - app/api/insights.py
// --------------------------------------------------------------------------- //

/** `GET /api/insights/summary` - the counters behind the Insights tiles. */
export interface InsightsSummaryResponse {
  certificates: { expired: number; expiring: number };
  pod_issues: { platform: number; application: number };
  quotas_near_limit: number;
  machine_config_pools: { degraded: number; updating: number };
  olm_operators_unhealthy: number;
  olm_upgrades_pending: number;
  pvcs_pending: number;
  routes_rejected: number;
  warning_events: number;
  applications: number;
  clusters_without_metrics: number;
}

/** The placement fields `insights.py:_placement` mixes into a row. They are
 * absent when the cluster has aged out of the store, hence optional. */
export interface Placement {
  hub?: string | null;
  region?: string | null;
  environment?: string | null;
}

export interface CertificatesResponse {
  within_days: number;
  count: number;
  certificates: Array<Placement & {
    cluster: string;
    namespace: string | null;
    class: NamespaceClass | null;
    kind: string;
    name: string;
    secret_type: string | null;
    status: string;
    expires_at: string;
    days_left: number;
    /** What was read off the PEM; never the material itself. */
    certificates: Array<{
      subject?: string;
      issuer?: string;
      not_after?: string;
      [field: string]: unknown;
    }>;
  }>;
}

export interface PodIssuesResponse {
  count: number;
  by_reason: Record<string, number>;
  pod_issues: PodIssue[];
}

export interface QuotasResponse {
  count: number;
  quotas: Array<{
    cluster: string;
    namespace: string | null;
    name: string;
    status: string | null;
    max_percent: number | null;
    resources: Array<{
      resource: string;
      used: string | number | null;
      hard: string | number | null;
      percent: number | null;
    }>;
  }>;
}

export interface OlmOperatorsResponse {
  operators: Array<{
    package: string;
    display_name: string;
    provider: string | null;
    versions: Array<{ version: string; count: number }>;
    distinct: number;
    clusters: number;
    unhealthy: number;
    upgrades_pending: number;
    installs: Array<{
      cluster: string;
      namespace: string | null;
      csv: string;
      version: string | null;
      phase: string | null;
      reason: string | null;
      unhealthy: boolean;
      upgrade_to: string | null;
    }>;
  }>;
}

/** `pool` and `status` are the router's; everything else is the stored
 * `summary` spread over the row, so the extra keys are per-kind. */
export interface MachineConfigPoolsResponse {
  count: number;
  pools: Array<Placement & ResourceSummary & {
    cluster: string;
    pool: string;
    status: string;
  }>;
}

export interface StorageResponse {
  storage_classes: Array<{
    name: string;
    clusters: string[];
    provisioners: string[];
    default: boolean;
    pvcs: number;
    bound: number;
    pending: number;
    requested_bytes: number;
  }>;
  pvcs: Array<{
    cluster: string;
    namespace: string | null;
    class: NamespaceClass | null;
    name: string;
    status: string | null;
    storage_class: string;
    requested_bytes: number | null;
    capacity_bytes: number | null;
    volume: string | null;
    mounted_by: string[];
  }>;
  /** `{cluster, name, status}` plus the PV's own summary. */
  pvs: Array<ResourceSummary & { cluster: string; name: string; status: string | null }>;
}

export interface RoutesResponse {
  count: number;
  routes: Array<ResourceSummary & {
    cluster: string;
    namespace: string | null;
    class: NamespaceClass | null;
    name: string;
    status: string | null;
  }>;
}

export interface EventsResponse {
  count: number;
  by_reason: Record<string, number>;
  events: Array<ResourceSummary & {
    cluster: string;
    namespace: string | null;
    class: NamespaceClass | null;
    name: string;
  }>;
}

/** One workload that runs an image (`insights.py:images`, `blast_radius`). */
export interface ImageUsage {
  cluster: string;
  namespace: string | null;
  kind: string;
  name: string;
  container: string;
  image: string;
  tag?: string | null;
  digest?: string | null;
}

/** `GET /api/insights/images`. The grouping key is the value of `group_by`,
 * which is why it is an index signature rather than a named field. */
export interface ImagesResponse {
  group_by: string;
  count: number;
  images: Array<{
    cluster_count: number;
    workload_count: number;
    workloads: ImageUsage[];
    [groupKey: string]: unknown;
  }>;
}

export interface ReferencesResponse {
  count: number;
  references: Array<{
    cluster: string;
    namespace: string | null;
    kind: string;
    name: string;
    workloads: Array<{ kind: string; name: string; via: string }>;
  }>;
}

export interface ClusterAdminsResponse {
  count: number;
  subjects: Array<{
    kind: string | null;
    name: string | null;
    namespace: string | null;
    role: string | null;
    cluster_count: number;
    clusters: string[];
    bindings: string[];
  }>;
}

/** `GET /api/insights/resources` (`insights.py:inventory`). No fixture covers
 * this one; the shape is the handler's. */
export interface InventoryResponse {
  kind: string;
  total: number;
  count: number;
  resources: ResourceRow[];
}

// --------------------------------------------------------------------------- //
// the query plane - app/api/query.py, docs/nl-query.md
// --------------------------------------------------------------------------- //

/** A cell. DuckDB types survive as JSON, so a TIMESTAMP arrives as a string;
 * `column_types` is what says which. */
export type QueryValue = string | number | boolean | null;

/** `QueryResult.as_dict()` in `app/query/service.py`. */
export interface QueryResult {
  sql: string;
  columns: string[];
  /** DuckDB's own names: VARCHAR, BIGINT, DOUBLE, TIMESTAMP, BOOLEAN. */
  column_types: string[];
  rows: QueryValue[][];
  row_count: number;
  truncated: boolean;
  elapsed_ms: number;
  generation: number;
}

/** What a panel or a batch entry answers with: a result, or a refusal that
 * carries the SQL it tried (`service.py:run_batch`). */
export type BatchEntry = Partial<QueryResult> & { error?: string; sql?: string };

/** `manager.info().as_dict()` in `app/query/snapshot.py`. */
export interface SnapshotInfo {
  generation: number;
  built_at: string | null;
  age_seconds: number | null;
  build_ms: number | null;
  stale: boolean;
  rebuilding: boolean;
  rows: Record<string, number>;
  total_rows: number;
  source_run?: string | null;
}

/** `GET /api/query/schema` - `query_schema.describe()` plus the snapshot. */
export interface QuerySchemaResponse {
  tables: Array<{
    name: string;
    description: string | null;
    source?: string | null;
    columns: Array<{ name: string; type: string; description: string | null }>;
  }>;
  notes: string[];
  enumerations: Record<string, string[]>;
  examples: Array<{ question: string; sql: string }>;
  snapshot: SnapshotInfo;
  limits: { max_rows: number; timeout_seconds: number };
}

/** `POST /api/query/ask` - `Answer.as_dict()` in `app/query/service.py`. */
export interface AskResponse {
  question: string;
  sql: string;
  explanation: string | null;
  assumptions: string[];
  /** 0 to 1, as `AskResult.confidence` (a float) sends it - the Query page
   * draws it as a percentage. */
  confidence: number;
  /** How many tries the model needed. */
  attempts: number;
  failed_attempts: Array<{ sql: string; error: string }>;
  result: QueryResult;
}

/** `POST /api/query/batch`. */
export interface QueryBatchResponse {
  generation: number;
  snapshot: SnapshotInfo;
  results: Record<string, BatchEntry>;
}

// --------------------------------------------------------------------------- //
// dashboards - app/query/dashboards.py, docs/nl-query.md
// --------------------------------------------------------------------------- //

/** The `chart` object is opaque to the API: stored and handed back untouched.
 * `dashboards/model.ts` is what reads it. */
export interface PanelChart {
  type?: string;
  x?: string;
  y?: string | string[];
  series?: string;
  stack?: boolean;
  [field: string]: unknown;
}

export interface DashboardVariable {
  name: string;
  label?: string | null;
  type?: "select" | "text" | "number";
  /** For a select: a query returning a `value` column and an optional `label`. */
  sql?: string | null;
  multi?: boolean;
  required?: boolean;
  default?: QueryValue | QueryValue[];
}

export interface DashboardPanel {
  id: string;
  title: string;
  sql: string;
  description?: string | null;
  chart?: PanelChart;
  /** Grid columns (1-12) and rows (1-6). */
  w?: number;
  h?: number;
  limit?: number | null;
}

export interface DashboardDefinition {
  id: string;
  title: string;
  description?: string | null;
  builtin?: boolean;
  variables: DashboardVariable[];
  panels: DashboardPanel[];
  updated_at?: string | null;
  updated_by?: string | null;
}

/** `Dashboard.summary()` - the row the picker draws. */
export interface DashboardListEntry {
  id: string;
  title: string;
  description: string | null;
  builtin: boolean;
  panels: number;
  variables: string[];
  updated_at: string | null;
}

export interface DashboardsResponse {
  dashboards: DashboardListEntry[];
}

/** `POST /api/dashboards/{id}/run` (`app/query/dashboards.py:run`). */
export interface DashboardRunResponse {
  dashboard: DashboardDefinition;
  /** The values the run actually used, defaults filled in. */
  params: Record<string, QueryValue | QueryValue[]>;
  variables: Record<string, { options: Array<{ value: QueryValue; label: QueryValue }> }>;
  results: Record<string, BatchEntry>;
  generation: number;
  snapshot: SnapshotInfo;
}

export interface DashboardDeletedResponse {
  deleted: string;
}

/** A 400 from the dashboards plane: the field path and what is wrong with it
 * (`DashboardInvalid.errors`). */
export interface DashboardFieldError {
  field: string;
  error: string;
}

// --------------------------------------------------------------------------- //
// the generative agent - app/api/agent.py, docs/nl-query.md
// --------------------------------------------------------------------------- //

/** `GET /api/agent` - is the feature there, and under what caps. */
export interface AgentAvailabilityResponse {
  available: boolean;
  model: string | null;
  /** Why not, when `available` is false. */
  reason: string | null;
  limits: { max_turns: number; max_panels: number; timeout_seconds: number };
}

// --------------------------------------------------------------------------- //
// the collection manifest - app/manifest.py, app/api/manifest.py
// --------------------------------------------------------------------------- //

/** `GET /api/manifest` - `Manifest.describe()`. */
export interface ManifestResponse {
  source: string;
  resources: Array<{
    key: string;
    kind: string;
    api_group: string | null;
    version: string;
    scope: "cluster" | "namespaced";
    domain: string;
    enabled: boolean;
    namespace_class: NamespaceClass | null;
    limit: number | null;
    /** 0 = collected every sweep; otherwise the kind's own tier. */
    interval_seconds: number;
    description: string;
  }>;
  scrub_policy: Array<{ what: string; kept: string }>;
  namespaces: {
    platform_names: string[];
    platform_prefixes: string[];
    platform_label_keys: string[];
    ownership: { app: string[]; team: string[]; tier: string[] };
  };
  keep_annotations: string[];
  thresholds: Record<string, number | string[]>;
  /** Which thresholds act while a cluster is read, and which while it is graded. */
  threshold_scope: Record<string, string>;
  health_checks: Array<{
    name: string;
    title: string;
    enabled: boolean;
    severity: string;
    description: string;
    units: string[];
    warn: Record<string, number | string>;
    fail: Record<string, number | string>;
  }>;
  applications: {
    source: string;
    mapping?: Record<string, unknown> | null;
    platform_apps?: unknown[];
    [field: string]: unknown;
  };
}

/** What one cluster answered for one manifest key (`api/manifest.py:availability`).
 *
 * Close to `ResourceStatus` but not the same shape: the manifest key is the
 * dictionary key rather than a field, and `interval_seconds` comes from the
 * manifest in force now rather than from the stored row. */
export interface ResourceAvailability {
  status: string;
  count: number | null;
  duration_ms: number | null;
  error: string | null;
  collected_at: string | null;
  /** Kept from an earlier sweep instead of re-fetched (tiered intervals). */
  cached: boolean;
  interval_seconds: number;
  bytes?: number;
  objects?: number;
  parse_ms?: number;
  requests?: number;
}

/** `GET /api/manifest/availability`. */
export interface ManifestAvailabilityResponse {
  resources: string[];
  clusters: Array<{
    name: string;
    reachable: boolean | null;
    status: HealthStatus | null;
    last_synced: string | null;
    /** manifest key -> what that cluster answered for it. */
    resources: Record<string, ResourceAvailability>;
  }>;
  /** manifest key -> status -> how many clusters answered with that status. */
  totals: Record<string, Record<string, number>>;
}

/** One cluster's row in the timing table (`admin.py:_cluster_timing`). The
 * volume counters are only there when the collector recorded them. */
export interface CollectorClusterTiming {
  cluster: string;
  hub: string | null;
  last_synced?: string | null;
  collect_ms?: number | null;
  reachable?: boolean | null;
  fetch_ms: number;
  parse_ms: number;
  assemble_ms: number;
  health_ms: number;
  persist_ms: number;
  total_ms: number;
  cpu_ms: number;
  bytes?: number;
  objects?: number;
  requests?: number;
  kinds_fetched?: number;
  kinds_cached?: number;
}

/** `GET /api/collector/timings` (`admin.py:collector_timings`). */
export interface CollectorTimingsResponse {
  limit?: number;
  count?: number;
  stages: string[];
  cpu_stages?: string[];
  clusters: CollectorClusterTiming[];
  fleet: {
    clusters: number;
    clusters_total: number;
    totals: Record<string, number>;
    p50: Record<string, number | null>;
    p95: Record<string, number | null>;
    share_percent: Record<string, number | null>;
    cpu_percent: number | null;
    parse_percent_of_fetch: number | null;
    bytes_per_fetch_second: number | null;
    objects_per_parse_second?: number | null;
  };
  last_run: {
    id?: string;
    trigger: string | null;
    finished_at?: string | null;
    duration_ms: number | null;
    clusters_total: number | null;
    timings?: Record<string, number> | null;
  } | null;
}

// --------------------------------------------------------------------------- //
// utilization - app/api/metrics.py
// --------------------------------------------------------------------------- //

export interface MetricsHealthResponse {
  source: string;
  reachable: boolean;
  clusters_with_metrics: number;
  clusters_total: number;
  without_metrics: string[];
}

export interface TopNamespacesResponse {
  by: string;
  unit: "cores" | "bytes";
  results: Array<{
    namespace: string;
    cluster: string;
    class: NamespaceClass;
    app: string | null;
    team: string | null;
    value: number | null;
  }>;
}

export interface TopNodesResponse {
  by: string;
  unit: "percent";
  results: Array<{ node: string; cluster: string; roles: string[]; value: number }>;
}

/** `GET /api/metrics/capacity`. The group's name is keyed by `group_by`
 * (`cluster`, `hub`, `region`, ...), so it is an index signature. */
export interface CapacityResponse {
  group_by: string;
  results: Array<{
    clusters: number;
    with_metrics: number;
    allocatable_cores: number;
    used_cores: number;
    requests_cores: number;
    headroom_cores: number;
    used_percent: number | null;
    allocatable_bytes: number;
    used_bytes: number;
    requests_bytes?: number;
    headroom_bytes: number;
    memory_used_percent: number | null;
    [groupKey: string]: unknown;
  }>;
}

/** `GET /api/metrics/cluster/{name}/utilization` - `capacity_dict` plus the
 * cluster's five busiest namespaces. */
export interface ClusterUtilizationResponse extends Capacity {
  cluster: string;
  top_namespaces: Array<{
    namespace: string;
    class: NamespaceClass;
    cpu_used_cores: number | null;
    memory_used_bytes: number | null;
  }>;
}

/** `GET /api/metrics/cluster/{name}/timeline`. */
export interface UtilizationTimelineResponse {
  cluster: string;
  resolution: string;
  points: Array<{
    at: string | null;
    samples: number;
    cpu_used_cores: number | null;
    cpu_used_cores_max: number | null;
    cpu_allocatable_cores: number | null;
    cpu_percent: number | null;
    memory_used_bytes: number | null;
    memory_used_bytes_max: number | null;
    memory_allocatable_bytes: number | null;
    memory_percent: number | null;
    pods_running: number | null;
    pod_issues: number | null;
  }>;
}

// --------------------------------------------------------------------------- //
// patching - a separate service, proxied under /api/patching
// --------------------------------------------------------------------------- //
// It is not part of the data layer's OpenAPI document, so these come from the
// fixtures in `src/test/fixtures/platform.js` and what `views/Patching.jsx`
// reads.

export interface PatchReportResponse {
  jobs_total: number;
  jobs_by_status: Record<string, number>;
  avg_success_pct: number;
  clusters: { succeeded: number; failed: number; pending: number };
}

export interface PatchJobSummary {
  id: string;
  change_record: string | null;
  requested_by: string | null;
  approved_by: string | null;
  approval_status: string;
  target_version: string | null;
  status: string;
  source: string | null;
  threshold_pct: number | null;
  totals: {
    total: number;
    succeeded: number;
    skipped: number;
    failed: number;
    success_pct: number;
  };
  created_at: string | null;
}

export interface PatchJobsResponse {
  count: number;
  jobs: PatchJobSummary[];
}

export interface PatchJobResponse extends PatchJobSummary {
  started_at: string | null;
  finished_at: string | null;
  tasks: Array<{
    cluster: string;
    phase: string;
    outcome: string;
    version_from: string | null;
    version_to: string | null;
    health_before: number | null;
    health_after: number | null;
  }>;
  audit: Array<{
    ts: string;
    actor: string;
    action: string;
    cluster: string | null;
    message: string;
  }>;
}
