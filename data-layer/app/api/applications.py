"""
Applications = application-class namespaces, viewed fleet-wide.

An application is identified by its `app` label (or namespace name) and may
run on many clusters; these endpoints group the per-cluster namespace rows
into one entity per application with ownership, placement and health.

The namespace rows come from the fleet namespace index, so nothing here walks
the clusters; only the workload detail of one application reads sections.
"""
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Query

from ..manifest import get_manifest
from ..serialize import UNASSIGNED, namespace_dict, workload_dict
from ..store import Store
from .cache import cache_key, cached
from .deps import get_store_dep, order_key

router = APIRouter(prefix="/api/applications", tags=["applications"])

_WORST = {"critical": 3, "warning": 2, "unknown": 1, "healthy": 0}


def _rollup(statuses):
    if not statuses:
        return "unknown"
    return max(statuses, key=lambda s: _WORST.get(s, 1))


def _by_placement(rows):
    """Namespace rows in a stable order, so ownership fields resolve the same way twice."""
    return sorted(rows, key=lambda n: order_key(n.cluster_name, n.name))


def _app_key(n) -> str:
    """Which application a namespace row belongs to. With a mapping file a
    namespace can be under none (app_name NULL); those group as UNASSIGNED."""
    if n.app_name:
        return n.app_name
    return n.name if n.assigned is None else UNASSIGNED


def _group(rows, clusters_by_name):
    apps = defaultdict(list)
    for n in rows:
        apps[_app_key(n)].append(n)
    out = []
    for app, nss in sorted(apps.items()):
        placements = []
        for n in nss:
            c = clusters_by_name.get(n.cluster_name)
            placements.append({
                "cluster": n.cluster_name,
                "namespace": n.name,
                "hub": c.hub_name if c else None,
                "region": c.region if c else None,
                "environment": c.environment if c else None,
                "cluster_status": c.overall_status if c else None,
                "ocp_version": c.ocp_version if c else None,
                "status": n.status,
                "workloads": n.workloads_total,
                "replicas_desired": n.replicas_desired,
                "replicas_ready": n.replicas_ready,
                "pod_issues": n.pod_issues,
                "cpu_used_cores": n.cpu_usage,
                "memory_used_bytes": n.memory_usage,
                "namespace_environment": n.environment,
            })
        cpu = [n.cpu_usage for n in nss if n.cpu_usage is not None]
        mem = [n.memory_usage for n in nss if n.memory_usage is not None]
        out.append({
            "app": app,
            "assigned": app != UNASSIGNED,
            "team": next((n.team for n in nss if n.team), None),
            "tier": next((n.tier for n in nss if n.tier), None),
            "status": _rollup([n.status for n in nss]),
            "cluster_count": len(nss),
            "environments": sorted({p["environment"] for p in placements if p["environment"]}),
            "namespace_environments": sorted({p["namespace_environment"] for p in placements
                                              if p["namespace_environment"]}),
            "hubs": sorted({p["hub"] for p in placements if p["hub"]}),
            "regions": sorted({p["region"] for p in placements if p["region"]}),
            "workloads": sum(n.workloads_total or 0 for n in nss),
            "replicas_desired": sum(n.replicas_desired or 0 for n in nss),
            "replicas_ready": sum(n.replicas_ready or 0 for n in nss),
            "pod_issues": sum(n.pod_issues or 0 for n in nss),
            "cpu_used_cores": round(sum(cpu), 3) if cpu else None,
            "memory_used_bytes": int(sum(mem)) if mem else None,
            "clusters": sorted({p["cluster"] for p in placements}),
            "placements": sorted(placements, key=lambda p: p["cluster"]),
        })
    return out


GROUP_FIELDS = {"cluster": "name", "hub": "hub_name", "region": "region", "datacenter": "datacenter",
                "environment": "environment", "version": "ocp_version"}


def application_counts(store: Store, group_by: str) -> tuple[list[dict], dict]:
    """Distinct applications (and teams, namespaces) per cluster or per group
    of clusters. The unit is the application, not the namespace: with a
    mapping one application spans several namespaces and an unassigned
    namespace counts for none."""
    field = GROUP_FIELDS[group_by]
    clusters = store.clusters()
    key_of = {c.name: (c.get(field) or "unknown") for c in clusters}
    groups: dict[str, dict] = defaultdict(lambda: {"applications": set(), "teams": set(), "clusters": set(),
                                                   "namespaces": 0, "unassigned_namespaces": 0})
    for c in clusters:
        groups[key_of[c.name]]["clusters"].add(c.name)
    all_apps: set[str] = set()
    all_teams: set[str] = set()
    for n in store.namespaces(ns_class="application"):
        g = groups[key_of.get(n.cluster_name, "unknown")]
        g["namespaces"] += 1
        if n.app_name and (n.assigned is None or n.assigned):
            g["applications"].add(n.app_name)
            all_apps.add(n.app_name)
            if n.team:
                g["teams"].add(n.team)
                all_teams.add(n.team)
        else:
            g["unassigned_namespaces"] += 1
    rows = [{"key": key, "clusters": len(g["clusters"]), "applications": len(g["applications"]),
             "teams": len(g["teams"]), "namespaces": g["namespaces"],
             "unassigned_namespaces": g["unassigned_namespaces"]}
            for key, g in sorted(groups.items())]
    totals = {"clusters": len(clusters), "applications": len(all_apps), "teams": len(all_teams),
              "namespaces": sum(r["namespaces"] for r in rows),
              "unassigned_namespaces": sum(r["unassigned_namespaces"] for r in rows)}
    return rows, totals


@router.get("/summary")
def applications_summary(store: Store = Depends(get_store_dep),
                         group_by: str = Query("hub", description="cluster|hub|region|datacenter|"
                                                                  "environment|version")):
    """How many applications run on each cluster, hub, region, datacenter,
    environment or OCP version (distinct applications, with teams and
    namespaces alongside)."""
    if group_by not in GROUP_FIELDS:
        group_by = "hub"
    return cached(store, cache_key("applications-summary", group_by=group_by),
                  lambda: dict(zip(("groups", "totals"), application_counts(store, group_by),
                                   strict=True), group_by=group_by))


@router.get("")
def list_applications(
    store: Store = Depends(get_store_dep),
    team: str | None = None,
    tier: str | None = None,
    environment: str | None = None,
    region: str | None = None,
    cluster: str | None = None,
    status: str | None = Query(None, description="healthy|warning|critical"),
    assigned: bool | None = Query(None, description="false: namespaces under no business application"),
    placements: bool = Query(False, description="include per-cluster placements in every row "
                                                "(the detail endpoint always does)"),
    limit: int | None = Query(None, ge=1), offset: int = Query(0, ge=0),
):
    """Applications fleet-wide. The grouped list is computed once per fleet
    generation and cached; rows carry `clusters` (names) and, only on request,
    the full `placements`, which is what makes the list heavy at scale."""
    def compute():
        rows = store.namespaces(ns_class="application", team=team,
                                clusters=[cluster] if cluster else None)
        clusters = {c.name: c for c in store.clusters()}
        if tier:
            rows = [n for n in rows if n.tier == tier]
        # environment and region are cluster properties, so they are resolved
        # through the cluster index rather than the namespace index
        if environment:
            rows = [n for n in rows if clusters.get(n.cluster_name) and
                    clusters[n.cluster_name].environment == environment]
        if region:
            rows = [n for n in rows if clusters.get(n.cluster_name) and
                    clusters[n.cluster_name].region == region]
        apps = _group(_by_placement(rows), clusters)
        if status:
            apps = [a for a in apps if a["status"] == status]
        if assigned is not None:
            apps = [a for a in apps if a["assigned"] == assigned]
        return {"teams": sorted({a["team"] for a in apps if a["team"]}), "applications": apps}

    key = cache_key("applications", team=team, tier=tier, environment=environment, region=region,
                    cluster=cluster, status=status, assigned=assigned)
    full = cached(store, key, compute)
    apps = full["applications"]
    total = len(apps)
    page = apps[offset:offset + limit] if limit else apps[offset:]
    if not placements:
        page = [{k: v for k, v in a.items() if k != "placements"} for a in page]
    return {"count": len(page), "total": total, "offset": offset, "teams": full["teams"],
            "source": get_manifest().applications["source"], "applications": page}


@router.get("/{app}")
def get_application(app: str, store: Store = Depends(get_store_dep)):
    if app == UNASSIGNED:
        rows = [n for n in store.namespaces(ns_class="application") if not n.app_name]
    else:
        rows = store.namespaces(ns_class="application", app_name=app)
    if not rows:
        # an application whose namespaces carry no app label is known by its
        # namespace name; that has no index of its own, hence the scan
        rows = [n for n in store.namespaces(ns_class="application") if n.name == app]
    if not rows:
        raise HTTPException(404, f"application {app} not found")
    rows = _by_placement(rows)
    clusters = {c.name: c for c in store.clusters()}
    grouped = _group(rows, clusters)[0]

    ns_names = {n.name for n in rows}
    cluster_names = sorted({n.cluster_name for n in rows})
    sections = store.section_across("workloads", cluster_names)
    workloads = [w for name in cluster_names for w in sections.get(name, [])
                 if w.namespace in ns_names]
    workloads.sort(key=lambda w: order_key(w.cluster_name, w.kind, w.name))

    grouped["namespaces"] = [namespace_dict(n) for n in sorted(rows, key=lambda n: n.cluster_name)]
    grouped["workloads_detail"] = [workload_dict(w, detail=True) for w in workloads]
    return grouped
