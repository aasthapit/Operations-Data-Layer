// Typed fetch helpers for the Operations Data Layer API.
//
// Two type sources meet here (ADR-0005):
//   - `api/schema.ts` is generated from the data layer's OpenAPI document, so
//     the paths and the query / body parameters below are the ones FastAPI
//     actually declares. Rename a parameter in a handler, re-export, and the
//     call site that still uses the old name stops compiling.
//   - `api/types.ts` is hand-written, because the routes declare no
//     `response_model` and the document therefore says `unknown` about every
//     response body.
//
// BASE is exported because the agent stream is a fetch of its own: it reads a
// response body rather than a JSON document, so it cannot go through fetchJson -
// but it must reach the same API as everything else.
import type { paths } from "./api/schema";
import type {
  AgentAvailabilityResponse,
  ApplicationDetail,
  ApplicationsResponse,
  AskResponse,
  BlastRadiusResponse,
  CapacityResponse,
  CertificatesResponse,
  ClusterAdminsResponse,
  ClusterDetail,
  ClusterNamespacesResponse,
  ClusterNodesResponse,
  ClusterPodIssuesResponse,
  ClusterResourcesResponse,
  ClusterTimelineResponse,
  ClusterUtilizationResponse,
  ClusterWorkloadsResponse,
  ClustersResponse,
  CollectorTimingsResponse,
  DashboardDefinition,
  DashboardDeletedResponse,
  DashboardRunResponse,
  DashboardsResponse,
  EventsResponse,
  ImagesResponse,
  InsightsSummaryResponse,
  InventoryResponse,
  MachineConfigPoolsResponse,
  ManifestAvailabilityResponse,
  ManifestResponse,
  MetricsHealthResponse,
  OlmOperatorsResponse,
  OperatorVersionsResponse,
  OverviewResponse,
  PatchJobResponse,
  PatchJobsResponse,
  PatchReportResponse,
  PodIssuesResponse,
  QueryBatchResponse,
  QueryResult,
  QuerySchemaResponse,
  QueryValue,
  QuotasResponse,
  ReferencesResponse,
  RefreshResponse,
  RoutesResponse,
  StorageResponse,
  SummaryResponse,
  TopNamespacesResponse,
  TopNodesResponse,
  UtilizationTimelineResponse,
  VersionsResponse,
} from "./api/types";

export const BASE = import.meta.env.VITE_API_BASE || "";

// --------------------------------------------------------------------------- //
// what the generated document says about a path
// --------------------------------------------------------------------------- //

/** The query parameters a GET on `P` declares, as `api/schema.ts` has them. */
export type QueryParams<P extends keyof paths> =
  paths[P] extends { get: { parameters: { query?: infer Q } } } ? NonNullable<Q> : never;

/** The JSON body a POST on `P` declares. */
export type PostBody<P extends keyof paths> =
  paths[P] extends { post: { requestBody?: { content: { "application/json": infer B } } } }
    ? NonNullable<B>
    : never;

/** A failed request. The status rides on the error because a refusal is often
 * something the user is meant to read: a 409 from /api/refresh means no
 * collector is running, which is a different thing to say than "failed". */
export interface ApiError extends Error {
  status?: number;
  /** The parsed `detail` of the body, when there was one. The query plane
   * answers with a string, the dashboards plane with a list of field errors. */
  detail?: unknown;
}

/** Anything that can go in a query string; `false`, `""` and null drop out. */
type ParamValue = string | number | boolean | null | undefined;

function qs(params: Record<string, ParamValue> = {}): string {
  const q = new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== "" && v !== false && v != null)
      .map(([k, v]) => [k, String(v)])
  ).toString();
  return q ? `?${q}` : "";
}

async function fetchJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, signal ? { signal } : undefined);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // The status is part of the answer, not decoration: a 404 from an endpoint
    // this build of the API does not serve is a different thing to tell the
    // user than a 500, and a view can only say which if it is carried along.
    const error: ApiError = new Error(`${res.status} ${res.statusText}: ${body}`);
    error.status = res.status;
    throw error;
  }
  return res.json() as Promise<T>;
}

/** The part of a descriptor the cache and `useFetch` need: a key to store the
 * answer under, and a way to load it that a going-away view can abort. Named on
 * its own because that is all `useFetch` ever touches - a test may hand it a
 * two-field stand-in rather than a whole thenable. */
export interface Loadable<T> {
  url: string;
  load: (signal?: AbortSignal) => Promise<T>;
}

/** A GET, as a descriptor rather than a bare promise: the URL is what the cache
 * is keyed on, and the descriptor is still thenable, so `await api.blastRadius(q)`
 * reads exactly as it did. */
export interface Request<T> extends Loadable<T>, PromiseLike<T> {
  then: <R1 = T, R2 = never>(
    ok?: ((value: T) => R1 | PromiseLike<R1>) | null,
    fail?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ) => Promise<R1 | R2>;
  catch: <R = never>(fail?: ((reason: unknown) => R | PromiseLike<R>) | null) => Promise<T | R>;
  finally: (done?: (() => void) | null) => Promise<T>;
}

// Awaiting a descriptor twice reuses the one request rather than issuing a
// second, which is what `pending` is for.
function get<T>(path: string): Request<T> {
  let pending: Promise<T> | null = null;
  const run = () => (pending || (pending = fetchJson<T>(path)));
  return {
    url: path,
    load: (signal?: AbortSignal) => fetchJson<T>(path, signal),
    then: (ok, fail) => run().then(ok, fail),
    catch: (fail) => run().catch(fail),
    finally: (done) => run().finally(done),
  };
}

// A POST with no body. The status rides along on the error because a refusal
// here is something the user is meant to read: a 409 from /api/refresh means
// no collector is running, which is a different thing to say than "failed".
async function post<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: "POST" });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON: keep the text */ }
  if (res.ok) return data as T;
  const detail = data && typeof data === "object" ? (data as { detail?: unknown }).detail : null;
  const error: ApiError = new Error(
    typeof detail === "string" ? detail : text || `${res.status} ${res.statusText}`);
  error.status = res.status;
  throw error;
}

// A request with a JSON body (POST / PUT), or a bare DELETE. The query plane
// answers a refusal with a reason the user is meant to read ({"detail": "only
// SELECT queries are allowed"}), and the dashboard plane answers a bad
// definition with a field path - so the error carries the status and the parsed
// detail rather than a formatted blob.
async function sendJson<T>(method: string, path: string, body?: unknown,
  signal?: AbortSignal): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  if (signal) init.signal = signal;
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON: keep the text */ }
  if (res.ok) return data as T;

  const detail = data && typeof data === "object" ? (data as { detail?: unknown }).detail : null;
  const message =
    typeof detail === "string" ? detail
      : detail && typeof detail === "object"
        ? ((detail as { error?: string }).error || JSON.stringify(detail))
        : text || `${res.status} ${res.statusText}`;
  const error: ApiError = new Error(message);
  error.status = res.status;
  error.detail = detail;
  throw error;
}

const postJson = <T>(path: string, body?: unknown, signal?: AbortSignal) =>
  sendJson<T>("POST", path, body, signal);

// A POST that is really a read: running a dashboard changes nothing, so it goes
// through the same stale-while-revalidate cache the GETs use. The descriptor
// looks exactly like get()'s, except the cache key spells out the body - what
// changes the answer is the parameters, not the path.
function postGet<T>(key: string, path: string, body: unknown): Request<T> {
  let pending: Promise<T> | null = null;
  const run = () => (pending || (pending = postJson<T>(path, body)));
  return {
    url: key,
    load: (signal?: AbortSignal) => postJson<T>(path, body, signal),
    then: (ok, fail) => run().then(ok, fail),
    catch: (fail) => run().catch(fail),
    finally: (done) => run().finally(done),
  };
}

const enc = encodeURIComponent;

// Key order must not change the cache key: {hub: "a", days: 7} and
// {days: 7, hub: "a"} are the same dashboard.
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** A value a dashboard variable can be set to. The UI only ever sets scalars
 * and lists (docs/nl-query.md), but `params` is `dict[str, Any]` on the wire and
 * `stableJson` keys the cache on whatever it is handed, nesting included. */
export type ParamJson = QueryValue | ParamJson[] | { [field: string]: ParamJson };

/** The values a dashboard's variables are set to. */
export type DashboardParams = Record<string, ParamJson>;

/** One entry of a `/api/query/batch` request. */
export type BatchQuery = PostBody<"/api/query/batch">["queries"][number];

export const api = {
  // fleet
  overview: () => get<OverviewResponse>("/api/health/overview"),
  summary: (groupBy: string) => get<SummaryResponse>(`/api/health/summary?group_by=${groupBy}`),
  clusters: (params: QueryParams<"/api/clusters"> = {}) =>
    get<ClustersResponse>(`/api/clusters${qs(params)}`),
  cluster: (name: string) => get<ClusterDetail>(`/api/clusters/${name}`),
  clusterNodes: (name: string) => get<ClusterNodesResponse>(`/api/clusters/${name}/nodes`),
  clusterNamespaces: (name: string, params: QueryParams<"/api/clusters/{name}/namespaces"> = {}) =>
    get<ClusterNamespacesResponse>(`/api/clusters/${name}/namespaces${qs(params)}`),
  clusterWorkloads: (name: string, params: QueryParams<"/api/clusters/{name}/workloads"> = {}) =>
    get<ClusterWorkloadsResponse>(`/api/clusters/${name}/workloads${qs(params)}`),
  clusterPodIssues: (name: string, params: QueryParams<"/api/clusters/{name}/pod-issues"> = {}) =>
    get<ClusterPodIssuesResponse>(`/api/clusters/${name}/pod-issues${qs(params)}`),
  clusterResources: (name: string, params: QueryParams<"/api/clusters/{name}/resources"> = {}) =>
    get<ClusterResourcesResponse>(`/api/clusters/${name}/resources${qs(params)}`),
  timeline: (name: string) => get<ClusterTimelineResponse>(`/api/clusters/${name}/timeline`),
  versions: () => get<VersionsResponse>("/api/versions"),
  operatorVersions: () => get<OperatorVersionsResponse>("/api/versions/operators"),
  blastRadius: (params: QueryParams<"/api/blast-radius"> = {}) =>
    get<BlastRadiusResponse>(`/api/blast-radius${qs(params)}`),
  refresh: () => post<RefreshResponse>("/api/refresh"),

  // applications
  applications: (params: QueryParams<"/api/applications"> = {}) =>
    get<ApplicationsResponse>(`/api/applications${qs(params)}`),
  application: (app: string) => get<ApplicationDetail>(`/api/applications/${encodeURIComponent(app)}`),

  // insights
  insightsSummary: () => get<InsightsSummaryResponse>("/api/insights/summary"),
  certificates: (params: QueryParams<"/api/insights/certificates"> = {}) =>
    get<CertificatesResponse>(`/api/insights/certificates${qs(params)}`),
  podIssues: (params: QueryParams<"/api/insights/pod-issues"> = {}) =>
    get<PodIssuesResponse>(`/api/insights/pod-issues${qs(params)}`),
  quotas: (params: QueryParams<"/api/insights/quotas"> = {}) =>
    get<QuotasResponse>(`/api/insights/quotas${qs(params)}`),
  olmOperators: (params: QueryParams<"/api/insights/olm-operators"> = {}) =>
    get<OlmOperatorsResponse>(`/api/insights/olm-operators${qs(params)}`),
  machineConfigPools: (params: QueryParams<"/api/insights/machine-config-pools"> = {}) =>
    get<MachineConfigPoolsResponse>(`/api/insights/machine-config-pools${qs(params)}`),
  storage: (params: QueryParams<"/api/insights/storage"> = {}) =>
    get<StorageResponse>(`/api/insights/storage${qs(params)}`),
  routes: (params: QueryParams<"/api/insights/routes"> = {}) =>
    get<RoutesResponse>(`/api/insights/routes${qs(params)}`),
  events: (params: QueryParams<"/api/insights/events"> = {}) =>
    get<EventsResponse>(`/api/insights/events${qs(params)}`),
  images: (params: QueryParams<"/api/insights/images"> = {}) =>
    get<ImagesResponse>(`/api/insights/images${qs(params)}`),
  references: (params: QueryParams<"/api/insights/references">) =>
    get<ReferencesResponse>(`/api/insights/references${qs(params)}`),
  clusterAdmins: (params: QueryParams<"/api/insights/cluster-admins"> = {}) =>
    get<ClusterAdminsResponse>(`/api/insights/cluster-admins${qs(params)}`),
  inventory: (params: QueryParams<"/api/insights/resources">) =>
    get<InventoryResponse>(`/api/insights/resources${qs(params)}`),

  // query plane (guarded SQL over the in-process DuckDB snapshot)
  querySchema: () => get<QuerySchemaResponse>("/api/query/schema"),
  runSql: (sql: string, limit?: number | null, signal?: AbortSignal) =>
    postJson<QueryResult>("/api/query/sql", limit ? { sql, limit } : { sql }, signal),
  askQuery: (question: string, limit?: number | null) =>
    postJson<AskResponse>("/api/query/ask", limit ? { question, limit } : { question }),
  // Several panels in one round trip. `params` are the dashboard's variables;
  // the server substitutes {{name}} as an escaped literal.
  queryBatch: (queries: BatchQuery[], params: DashboardParams = {}, signal?: AbortSignal) =>
    postJson<QueryBatchResponse>("/api/query/batch", { queries, params }, signal),

  // dashboards (multi-panel views over the query plane)
  dashboards: () => get<DashboardsResponse>("/api/dashboards"),
  dashboard: (id: string) => get<DashboardDefinition>(`/api/dashboards/${enc(id)}`),
  saveDashboard: (id: string, definition: unknown) =>
    sendJson<DashboardDefinition>("PUT", `/api/dashboards/${enc(id)}`, definition),
  deleteDashboard: (id: string) =>
    sendJson<DashboardDeletedResponse>("DELETE", `/api/dashboards/${enc(id)}`),
  // A read, so it is a descriptor the SWR cache can key: the same dashboard with
  // the same variables paints from cache the moment the user navigates back.
  runDashboard: (id: string, params: DashboardParams = {}) => postGet<DashboardRunResponse>(
    `/api/dashboards/${enc(id)}/run?params=${enc(stableJson(params))}`,
    `/api/dashboards/${enc(id)}/run`,
    { params },
  ),

  // generative dashboards (AG-UI). The run itself is a stream, so it lives in
  // agent/client.ts; this is only "is the feature there, and with what model".
  agent: () => get<AgentAvailabilityResponse>("/api/agent"),

  // manifest
  manifest: () => get<ManifestResponse>("/api/manifest"),
  manifestAvailability: () => get<ManifestAvailabilityResponse>("/api/manifest/availability"),
  // Where the collector's time goes: per-cluster stage breakdown plus fleet
  // aggregates and the last sweep, in one call.
  collectorTimings: (limit?: number) =>
    get<CollectorTimingsResponse>(`/api/collector/timings${qs({ limit })}`),

  // utilization (metrics.k8s.io, collected with the inventory)
  metricsHealth: () => get<MetricsHealthResponse>("/api/metrics/health"),
  topNamespaces: (by: string, limit = 10, cls = "") =>
    get<TopNamespacesResponse>(`/api/metrics/top-namespaces${qs({ by, limit, class: cls })}`),
  topNodes: (by: string, limit = 10) =>
    get<TopNodesResponse>(`/api/metrics/top-nodes?by=${by}&limit=${limit}`),
  capacity: (groupBy = "cluster") =>
    get<CapacityResponse>(`/api/metrics/capacity?group_by=${groupBy}`),
  clusterUtilization: (name: string) =>
    get<ClusterUtilizationResponse>(`/api/metrics/cluster/${name}/utilization`),
  utilizationTimeline: (name: string) =>
    get<UtilizationTimelineResponse>(`/api/metrics/cluster/${name}/timeline`),

  // Patching system of record (separate service, proxied under /api/patching).
  // Everything the dashboard fetches lives under /api, which leaves every other
  // path to the router: /patching/<job id> is a page, not an API call.
  patchReport: () => get<PatchReportResponse>("/api/patching/report"),
  patchJobs: (params: Record<string, ParamValue> = {}) =>
    get<PatchJobsResponse>(`/api/patching/jobs${qs(params)}`),
  patchJob: (id: string) => get<PatchJobResponse>(`/api/patching/jobs/${id}`),
};
