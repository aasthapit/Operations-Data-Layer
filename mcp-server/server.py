"""
Operations Data Layer - MCP server.

Wraps the data layer's REST API as MCP tools so an agent can ask about fleet
health, inventory, applications, utilization, insights and blast radius in
natural language. Everything the data layer knows was read from the clusters'
own API servers; ConfigMap / Secret values, certificates and env values are
never collected, so nothing here can leak them.

Most tools answer one known question. `ask_fleet`, `run_fleet_sql` and
`fleet_schema` answer the questions nobody anticipated, by running SQL over a
snapshot of the same data, and `list_dashboards` / `run_dashboard` answer the
rounded ones - a dashboard is several of those queries answered together
against one snapshot. See docs/nl-query.md.

Transport is selectable via MCP_TRANSPORT (stdio | sse | streamable-http).
stdio is the default and is what Claude Code / Claude Desktop use locally.

Config:
  MCP_API_BASE   base URL of the data layer API (default http://localhost:18000)
  MCP_TRANSPORT  stdio (default) | sse | streamable-http
"""
import json
import os

import httpx
from mcp.server.fastmcp import FastMCP

API_BASE = os.environ.get("MCP_API_BASE", "http://localhost:18000").rstrip("/")
TRANSPORT = os.environ.get("MCP_TRANSPORT", "stdio")

# host/port only matter for the http/sse transports.
mcp = FastMCP(
    "operations-data-layer",
    host=os.environ.get("MCP_HOST", "127.0.0.1"),
    port=int(os.environ.get("MCP_PORT", "8000")),
)
_client = httpx.Client(base_url=API_BASE, timeout=60.0)


def _get(path: str, params: dict | None = None):
    try:
        r = _client.get(path, params={k: v for k, v in (params or {}).items()
                                      if v not in (None, "", False)})
        r.raise_for_status()
        return r.json()
    except httpx.HTTPStatusError as e:
        return {"error": f"{e.response.status_code} {e.response.text}"}
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


def _post(path: str):
    try:
        r = _client.post(path)
        r.raise_for_status()
        return r.json()
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


def _post_json(path: str, body: dict):
    """POST a JSON body. The API's 4xx bodies explain themselves, so they are
    returned as the error rather than swallowed."""
    try:
        r = _client.post(path, json=body)
        r.raise_for_status()
        return r.json()
    except httpx.HTTPStatusError as e:
        try:
            detail = e.response.json().get("detail")
        except Exception:  # noqa: BLE001
            detail = e.response.text
        return {"error": detail or f"{e.response.status_code}", "status": e.response.status_code}
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


# --------------------------------------------------------------------------- #
# fleet health
# --------------------------------------------------------------------------- #
@mcp.tool()
def fleet_overview() -> dict:
    """Fleet-wide health summary: total clusters, counts by status
    (healthy/warning/critical/unknown), how many are upgrading, hub status, and
    info about the last collection sweep. Start here for "how is the fleet?"."""
    return _get("/api/health/overview")


@mcp.tool()
def insights_summary() -> dict:
    """Fleet-wide problem counters in one call: expired / expiring certificates,
    platform vs application pod issues, quotas near their limit, degraded or
    updating machine config pools, unhealthy OLM operators and pending OLM
    upgrades, pending PVCs, rejected routes, warning events, application count,
    and clusters without metrics. Use for "what needs attention right now?"."""
    return _get("/api/insights/summary")


@mcp.tool()
def health_summary(group_by: str = "region") -> dict:
    """Health rolled up by a dimension. group_by is one of:
    region, datacenter, environment, hub, version. Returns per-group counts and
    a rollup status. Use for "which regions/environments are unhealthy?"."""
    return _get("/api/health/summary", {"group_by": group_by})


@mcp.tool()
def list_clusters(region: str = "", environment: str = "", status: str = "",
                  version: str = "", team: str = "", hub: str = "") -> dict:
    """List clusters, optionally filtered. status is
    healthy|warning|critical|unknown. team filters to clusters running an
    application owned by that team. Each cluster summary includes version,
    checks, node counts, namespace counts, pod issues, expiring certs and live
    CPU / memory utilization percentages."""
    return _get("/api/clusters", {
        "region": region, "environment": environment, "status": status,
        "version": version, "team": team, "hub": hub})


@mcp.tool()
def get_cluster(name: str) -> dict:
    """Full detail for one cluster: version/upgrade state, platform config
    (network type, CIDRs, apps domain, topology), capacity and live
    utilization, every cluster operator, nodes, all namespaces (application
    and platform) with pod counts and usage, pod issues, which manifest
    resources this cluster served, and all precondition health checks."""
    return _get(f"/api/clusters/{name}")


@mcp.tool()
def cluster_health(name: str) -> dict:
    """Just the precondition health checks and overall status/score for one
    cluster (lighter than get_cluster)."""
    return _get(f"/api/clusters/{name}/health")


@mcp.tool()
def cluster_timeline(name: str, resolution: str = "sweep", since: str = "",
                     until: str = "") -> dict:
    """History for one cluster: health score, CPU / memory usage, running pods,
    and what was going wrong (crash loops, image pull errors, OOM kills,
    pending pods, restarts, warning events, which checks were failing). Use to
    see whether a cluster is improving, degrading, mid-upgrade, or trending
    towards capacity. resolution = sweep (every collection, the last 48 hours)
    | hour (the last 90 days) | day (the last 2 years); pick it from the span
    you care about. since / until are ISO 8601 instants. At hour and day
    resolution the usage numbers are the mean over the bucket with the peak
    beside them (cpu_used_cores_max), and the counters are the worst value
    inside it."""
    return _get(f"/api/clusters/{name}/timeline", {
        "resolution": resolution, "since": since, "until": until})


@mcp.tool()
def recent_changes(cluster: str = "", kind: str = "", since: str = "") -> dict:
    """What has CHANGED across the fleet, newest first - the log a timeline
    cannot show. One record per event, with the value before and after and a
    sentence describing it: version (a cluster was upgraded), status (its
    health rolled over), check (a precondition check started failing or
    recovered, named), operator (a cluster operator degraded or recovered),
    nodes (node count or readiness moved), namespace (an application namespace
    appeared or disappeared), application (the application count moved),
    upgrade (one started or finished), reachability (the collector lost or
    regained a cluster). Use for "what happened to this cluster?", "what
    changed last night?", "when did X break?". cluster limits it to one
    cluster, kind to one of the kinds above, since is an ISO 8601 instant
    (default: the last 24 hours)."""
    return _get("/api/insights/changes", {
        "cluster": cluster, "kind": kind, "since": since})


# --------------------------------------------------------------------------- #
# inventory
# --------------------------------------------------------------------------- #
@mcp.tool()
def cluster_nodes(name: str) -> dict:
    """Nodes of one cluster: roles, readiness, pressure conditions, cordoned,
    kubelet / OS / runtime versions, capacity vs allocatable vs live usage,
    pods per node, cached images, taints."""
    return _get(f"/api/clusters/{name}/nodes")


@mcp.tool()
def cluster_namespaces(name: str, ns_class: str = "", status: str = "") -> dict:
    """Namespaces of one cluster with pod counts / restarts / issues, replicas,
    requests / limits / live usage, ownership (app, team, tier) and resource
    counts. ns_class = application | platform groups OpenShift's own
    namespaces separately from application namespaces."""
    return _get(f"/api/clusters/{name}/namespaces", {"class": ns_class, "status": status})


@mcp.tool()
def cluster_workloads(name: str, namespace: str = "", kind: str = "", ns_class: str = "",
                      status: str = "", detail: bool = False) -> dict:
    """Deployments / StatefulSets / DaemonSets on one cluster with replica
    state, images and status (healthy | progressing | degraded). detail=true adds
    containers (env var NAMES and their Secret/ConfigMap sources - never values),
    config references, selectors and conditions."""
    return _get(f"/api/clusters/{name}/workloads", {
        "namespace": namespace, "kind": kind, "class": ns_class, "status": status,
        "detail": detail})


@mcp.tool()
def inventory(kind: str, cluster: str = "", namespace: str = "", name: str = "",
              status: str = "", ns_class: str = "", limit: int = 200) -> dict:
    """Generic fleet-wide inventory query over any collected kind. kind is a
    manifest key: routes, services, ingresses, networkpolicies, configmaps,
    secrets, persistentvolumeclaims, persistentvolumes, storageclasses,
    resourcequotas, events, cronjobs, horizontalpodautoscalers,
    clusterserviceversions, subscriptions, machineconfigpools,
    clusterrolebindings. Rows are scrubbed summaries (secrets/configmaps show
    key names, sizes and certificate facts only)."""
    return _get("/api/insights/resources", {
        "kind": kind, "cluster": cluster, "namespace": namespace, "name": name,
        "status": status, "class": ns_class, "limit": limit})


@mcp.tool()
def what_is_collected() -> dict:
    """The OCP API manifest: every resource the collector knows about, whether
    it is enabled, the scrub policy (what is never collected), how platform vs
    application namespaces are classified, ownership label keys, and health
    thresholds. Use to answer "can the data layer tell me X?"."""
    return _get("/api/manifest")


@mcp.tool()
def resource_availability() -> dict:
    """Per cluster, per resource: collected / unavailable (API not served) /
    forbidden (RBAC) / error / disabled. Use to explain why a cluster lacks
    some insight (e.g. no OLM, no metrics.k8s.io)."""
    return _get("/api/manifest/availability")


# --------------------------------------------------------------------------- #
# applications
# --------------------------------------------------------------------------- #
@mcp.tool()
def list_applications(team: str = "", tier: str = "", environment: str = "",
                      region: str = "", cluster: str = "", status: str = "") -> dict:
    """Applications across the fleet. An application is an application-class
    namespace (every namespace that is not an OpenShift / Kubernetes platform
    namespace), identified by its app label or name, with team / tier from
    labels. Grouped per application with its placements (cluster, namespace,
    status, replicas, pod issues, live usage)."""
    return _get("/api/applications", {
        "team": team, "tier": tier, "environment": environment, "region": region,
        "cluster": cluster, "status": status})


@mcp.tool()
def applications_summary(group_by: str = "hub") -> dict:
    """How many applications run on each cluster, hub, region, datacenter,
    environment or OCP version: distinct applications (not namespaces), with
    teams, namespaces and namespaces under no application alongside, plus
    fleet totals. group_by = cluster | hub | region | datacenter | environment
    | version. Use for "how many apps are on cluster X / hub Y?"."""
    return _get("/api/applications/summary", {"group_by": group_by})


@mcp.tool()
def get_application(app: str) -> dict:
    """One application everywhere it runs: placements, per-cluster namespace
    detail, and every workload with scrubbed container detail."""
    return _get(f"/api/applications/{app}")


# --------------------------------------------------------------------------- #
# versions + blast radius
# --------------------------------------------------------------------------- #
@mcp.tool()
def version_distribution() -> dict:
    """How OCP versions are spread across the fleet, with the clusters on each
    version and the channels in use. Use for "what versions are we running?"."""
    return _get("/api/versions")


@mcp.tool()
def operator_versions(name: str = "") -> dict:
    """Version spread per cluster operator across the fleet (optionally one
    operator by name). Operators reporting more than one version are drifting -
    usually a partial rollout."""
    return _get("/api/versions/operators", {"name": name})


@mcp.tool()
def olm_operators(name: str = "", cluster: str = "") -> dict:
    """OLM-installed operators (ClusterServiceVersions) across the fleet:
    version spread per package, install phase per cluster, unhealthy installs,
    and pending upgrades from Subscriptions. name filters to one package."""
    return _get("/api/insights/olm-operators", {"name": name, "cluster": cluster})


@mcp.tool()
def blast_radius(operator: str = "", operator_version: str = "",
                 ocp_version: str = "", degraded_only: bool = False,
                 olm_operator: str = "", olm_version: str = "", image: str = "") -> dict:
    """Impact analysis. Given something bad - an OCP version, a cluster
    operator (optionally at a version), an OLM operator package (optionally at
    a version), or a container image substring - return the clusters carrying
    it, the applications + teams riding on top, and (for images) the exact
    workloads. Supply at least one of operator / ocp_version / olm_operator /
    image. Use for "if X is buggy, what's affected?"."""
    return _get("/api/blast-radius", {
        "operator": operator, "operator_version": operator_version,
        "ocp_version": ocp_version, "degraded_only": degraded_only,
        "olm_operator": olm_operator, "olm_version": olm_version, "image": image})


# --------------------------------------------------------------------------- #
# insights
# --------------------------------------------------------------------------- #
@mcp.tool()
def expiring_certificates(within_days: int = 0, include_valid: bool = False,
                          cluster: str = "", ns_class: str = "") -> dict:
    """Certificates in Secrets and ConfigMaps ordered by soonest expiry, with
    subject / issuer / not-after (the certificate material itself is never
    collected). within_days defaults to the manifest threshold (30)."""
    return _get("/api/insights/certificates", {
        "within_days": within_days or None, "include_valid": include_valid,
        "cluster": cluster, "class": ns_class})


@mcp.tool()
def pod_issues(cluster: str = "", ns_class: str = "", reason: str = "", namespace: str = "") -> dict:
    """Pods that are currently unhealthy across the fleet: CrashLoopBackOff,
    ImagePullBackOff, Unschedulable, Pending, OOMKilled, HighRestarts,
    NotReady, Failed, Evicted - with owner workload and node. ns_class =
    platform | application separates OpenShift's own pods from app pods."""
    return _get("/api/insights/pod-issues", {
        "cluster": cluster, "class": ns_class, "reason": reason, "namespace": namespace})


@mcp.tool()
def quota_pressure(cluster: str = "", min_percent: float = 0) -> dict:
    """ResourceQuotas across the fleet with hard vs used per resource and the
    worst usage percentage, highest first. min_percent filters to quotas at or
    above that usage."""
    return _get("/api/insights/quotas", {"cluster": cluster, "min_percent": min_percent or None})


@mcp.tool()
def machine_config_pools(cluster: str = "", status: str = "") -> dict:
    """MachineConfigPool rollout state across the fleet: degraded / updating /
    paused / updated with machine counts. The patching signal for node-level
    config rollouts. status filters, e.g. degraded."""
    return _get("/api/insights/machine-config-pools", {"cluster": cluster, "status": status})


@mcp.tool()
def storage_summary(cluster: str = "", storage_class: str = "") -> dict:
    """Storage graph: storage classes and provisioners per cluster, PVCs
    (pending first) with what mounts them, and PVs with CSI driver and bound
    claim. Use for "if storage provider X has a problem, what is impacted?"."""
    return _get("/api/insights/storage", {"cluster": cluster, "storage_class": storage_class})


@mcp.tool()
def find_routes(host: str = "", cluster: str = "", namespace: str = "", status: str = "") -> dict:
    """OpenShift Routes across the fleet: host, target service, TLS
    termination, admitted / rejected. host does a substring match - use to find
    which cluster and namespace serves a URL."""
    return _get("/api/insights/routes", {
        "host": host, "cluster": cluster, "namespace": namespace, "status": status})


@mcp.tool()
def warning_events(cluster: str = "", namespace: str = "", ns_class: str = "",
                   reason: str = "", limit: int = 100) -> dict:
    """Most recent Kubernetes Warning events across the fleet (what is going
    wrong right now), newest first, with counts by reason."""
    return _get("/api/insights/events", {
        "cluster": cluster, "namespace": namespace, "class": ns_class, "reason": reason,
        "limit": limit})


@mcp.tool()
def image_usage(image: str = "", registry: str = "", cluster: str = "",
                group_by: str = "image") -> dict:
    """Which workloads run which container images across the fleet. image is a
    substring match; group_by = image | registry | repository. The input to a
    CVE blast radius ("who runs nginx:1.19?")."""
    return _get("/api/insights/images", {
        "image": image, "registry": registry, "cluster": cluster, "group_by": group_by})


@mcp.tool()
def config_references(kind: str, name: str = "", cluster: str = "", namespace: str = "") -> dict:
    """Which workloads reference a Secret / ConfigMap / PersistentVolumeClaim /
    ServiceAccount (via env, envFrom, volume, imagePullSecret, serviceAccount).
    The blast radius of rotating a secret or changing a config map. kind is
    one of Secret, ConfigMap, PersistentVolumeClaim, ServiceAccount."""
    return _get("/api/insights/references", {
        "kind": kind, "name": name, "cluster": cluster, "namespace": namespace})


@mcp.tool()
def cluster_admins(cluster: str = "") -> dict:
    """Users / groups / service accounts bound to cluster-admin across the
    fleet, with the clusters each holds it on."""
    return _get("/api/insights/cluster-admins", {"cluster": cluster})


# --------------------------------------------------------------------------- #
# utilization (from metrics.k8s.io via each cluster's API server)
# --------------------------------------------------------------------------- #
@mcp.tool()
def top_namespaces_by_usage(by: str = "cpu", limit: int = 10, ns_class: str = "") -> dict:
    """Namespaces using the most CPU or memory across the fleet (by = cpu |
    memory), from the Kubernetes metrics API on each cluster. ns_class =
    application | platform. Use for noisy-neighbour / hot-namespace questions."""
    return _get("/api/metrics/top-namespaces", {"by": by, "limit": limit, "class": ns_class})


@mcp.tool()
def top_nodes_by_usage(by: str = "cpu", limit: int = 10) -> dict:
    """Nodes with the highest CPU or memory utilization percentage across the
    fleet. by = cpu | memory."""
    return _get("/api/metrics/top-nodes", {"by": by, "limit": limit})


@mcp.tool()
def cluster_utilization(name: str) -> dict:
    """CPU / memory / pods: capacity, allocatable, requests, limits, live usage,
    headroom and percentages for one cluster, plus its top namespaces. Use for
    capacity questions and as a patch pre-check signal."""
    return _get(f"/api/metrics/cluster/{name}/utilization")


@mcp.tool()
def capacity_headroom(group_by: str = "cluster") -> dict:
    """Capacity headroom (allocatable - used, CPU and memory) grouped by
    cluster, region, environment, or datacenter. Use for capacity planning."""
    return _get("/api/metrics/capacity", {"group_by": group_by})


# --------------------------------------------------------------------------- #
# ad-hoc questions (SQL over a snapshot of the fleet state)
# --------------------------------------------------------------------------- #
@mcp.tool()
def ask_fleet(question: str) -> dict:
    """Answer an ad-hoc question by writing and running SQL over the whole
    fleet. Use this when no tool above fits: arbitrary joins, aggregations,
    groupings and correlations ("which teams run an image on clusters still on
    4.15 in eu-west?", "how many application namespaces per team per
    environment?", "which clusters have both a degraded operator and a
    certificate expiring this month?"). Prefer the purpose-built tools above
    for the questions they already answer - they are cheaper and their shapes
    are stable. Returns the SQL that ran, a one-sentence explanation, the
    assumptions made, and the rows. ALWAYS show the user the SQL along with the
    answer so they can check it."""
    return _post_json("/api/query/ask", {"question": question})


@mcp.tool()
def run_fleet_sql(sql: str, limit: int = 200) -> dict:
    """Run one read-only SELECT yourself against the fleet snapshot (DuckDB
    SQL). Use this when you already know the query - to re-run or refine what
    ask_fleet produced, or when you want exact control over the joins and
    columns. Call fleet_schema() first for the tables, columns and semantics.
    Only a single SELECT (or WITH ... SELECT) over the listed tables is
    allowed; anything that writes, reads files or calls catalog functions is
    rejected, and every query is capped and time limited. Show the user the SQL
    with the answer."""
    return _post_json("/api/query/sql", {"sql": sql, "limit": limit})


@mcp.tool()
def fleet_schema() -> dict:
    """The relational schema behind ask_fleet / run_fleet_sql: every table and
    column with a description, the notes that give them meaning (what an
    application is, how to join across clusters, what lives inside the JSON
    summary column), worked example queries, and what the current snapshot
    holds (row counts, when it was built). Read this before writing SQL."""
    return _get("/api/query/schema")


# --------------------------------------------------------------------------- #
# dashboards (saved multi-panel queries)
# --------------------------------------------------------------------------- #
@mcp.tool()
def list_dashboards() -> dict:
    """The saved query dashboards: id, title, description, how many panels and
    which variables each one takes. A dashboard is several guarded SQL queries
    answered together against one snapshot, so `run_dashboard` is the cheapest
    way to get a rounded picture of a hub, an application, a cluster or the
    fleet's trends - one call instead of a dozen. Built-in dashboards ship with
    the data layer; the rest were written by people."""
    return _get("/api/dashboards")


@mcp.tool()
def run_dashboard(id: str, params_json: str = "") -> dict:
    """Run one dashboard and return every panel's rows. `id` comes from
    list_dashboards; `params_json` is a JSON object of its variables, e.g.
    '{"hub": "man01paa"}' or '{"days": 30}' (omit it to use the defaults).
    Returns the definition, the effective parameters, the options for each
    variable (so you can see the valid values and re-run with one), and a
    result or an error per panel - a panel that fails does not fail the rest.
    A variable with no value is not an error: its panels come back saying it is
    not set, and the options tell you what to pick. Every panel carries the SQL
    that produced it; show it with the numbers."""
    if params_json.strip():
        try:
            params = json.loads(params_json)
        except ValueError as e:
            return {"error": f"params_json is not valid JSON: {e}"}
        if not isinstance(params, dict):
            return {"error": "params_json must be a JSON object of variable values"}
    else:
        params = {}
    return _post_json(f"/api/dashboards/{id}/run", {"params": params})


@mcp.tool()
def refresh_data() -> dict:
    """Trigger an on-demand collection sweep of the fleet (runs in the
    background). Use when you want the freshest data before answering."""
    return _post("/api/refresh")


@mcp.tool()
def refresh_cluster(name: str) -> dict:
    """Re-collect ONE cluster right now and wait for it (typically well under a
    second on a small cluster; seconds on a large one). The data layer is a
    pull cache, so this is how to get a fresh picture of a single cluster
    before answering about it without sweeping the whole fleet. Returns 404 if
    the cluster is not discovered, 409 if a refresh of it is already running."""
    try:
        r = _client.post(f"/api/clusters/{name}/refresh")
        r.raise_for_status()
        return r.json()
    except httpx.HTTPStatusError as e:
        return {"error": f"{e.response.status_code} {e.response.text}"}
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


if __name__ == "__main__":
    mcp.run(transport=TRANSPORT)
