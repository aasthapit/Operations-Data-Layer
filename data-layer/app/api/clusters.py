"""
One cluster at a time: the fleet list, the full detail document, each detail
section on its own, the health/utilization history, and the change log.

Every section is a separate key in the store, so an endpoint reads only the
section it answers from (`/nodes` never decompresses the inventory) and filters
in process.
"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse

from ..collector import runner
from ..serialize import (
    change_dict,
    check_dict,
    cluster_detail,
    cluster_summary,
    namespace_dict,
    node_dict,
    operator_dict,
    pod_issue_dict,
    resource_dict,
    snapshot_dict,
    workload_dict,
)
from ..settings import settings
from ..store import Row, Store
from .admin import queue_refresh
from .applications import application_rows
from .deps import (
    KIND_DOC,
    RESOLUTION_DOC,
    get_store_dep,
    order_key,
)
from .deps import (
    resolution as resolution_of,
)

router = APIRouter(prefix="/api/clusters", tags=["clusters"])

# The sections the detail document is composed from, read in one round trip.
_DETAIL_SECTIONS = ("operators", "nodes", "namespaces", "pod_issues",
                    "resource_status", "health_checks")


def _cluster(store: Store, name: str) -> Row:
    c = store.get_cluster(name)
    if not c:
        raise HTTPException(404, f"cluster {name} not found")
    return c


@router.get("")
def list_clusters(
    store: Store = Depends(get_store_dep),
    region: str | None = None,
    datacenter: str | None = None,
    environment: str | None = None,
    hub: str | None = None,
    status: str | None = Query(None, description="healthy|warning|critical|unknown"),
    version: str | None = None,
    team: str | None = None,
    upgrading: bool | None = Query(None, description="only clusters mid-upgrade (true) or not (false)"),
):
    # Every one of these is a cluster dimension the store indexes, so the
    # filtering is an intersection of sets rather than a scan.
    filters = {"region": region, "datacenter": datacenter, "environment": environment,
               "hub": hub, "status": status, "version": version}
    clusters = store.clusters(**{k: v for k, v in filters.items() if v})
    items = [cluster_summary(c) for c in clusters]
    if team:
        # filter to clusters running an application owned by `team`
        keep = {n.cluster_name for n in application_rows(store, team=team)}
        items = [i for i in items if i["name"] in keep]
    if upgrading is not None:
        items = [i for i in items if bool(i["upgrading"]) == upgrading]
    return {"count": len(items), "clusters": items}


@router.get("/{name}")
def get_cluster(name: str, store: Store = Depends(get_store_dep)):
    c = _cluster(store, name)
    sections = store.sections(name, _DETAIL_SECTIONS)
    return cluster_detail(c, **{key: sections.get(key) or [] for key in _DETAIL_SECTIONS})


@router.post("/{name}/refresh")
def refresh(name: str, full: bool = False, store: Store = Depends(get_store_dep)):
    """Collect this one cluster now, without waiting for the next sweep.
    `full` fetches every enabled kind; otherwise only the kinds that are due.

    Where a collector runs this is synchronous and answers with what the
    collection cost. Where one does not (an API pod beside collector pods) the
    request is queued to the collector that owns the cluster and answered 202,
    because nothing here can say when that collector will get to it.
    """
    if not settings.collector_enabled:
        _cluster(store, name)          # 404 rather than a request nobody can serve
        return JSONResponse(status_code=202, content=queue_refresh(store, full=full, cluster=name))
    result = runner.refresh_cluster(name, full)
    if result.get("error") == "unknown cluster":
        raise HTTPException(404, f"cluster {name} not found")
    if result.get("skipped"):
        # someone else is already refreshing it; the single-flight lock held
        raise HTTPException(409, result.get("reason") or "a refresh of this cluster is already running")
    return result


@router.get("/{name}/operators")
def get_operators(name: str, store: Store = Depends(get_store_dep)):
    _cluster(store, name)
    rows = store.section(name, "operators")
    return {"cluster": name,
            "operators": [operator_dict(o) for o in sorted(rows, key=lambda o: o.name)]}


@router.get("/{name}/health")
def get_health(name: str, store: Store = Depends(get_store_dep)):
    c = _cluster(store, name)
    return {
        "cluster": name,
        "overall_status": c.overall_status,
        "health_score": c.health_score,
        "checks": [check_dict(h) for h in store.section(name, "health_checks")],
    }


@router.get("/{name}/nodes")
def get_nodes(name: str, store: Store = Depends(get_store_dep)):
    _cluster(store, name)
    rows = store.section(name, "nodes")
    return {"cluster": name, "nodes": [node_dict(n) for n in sorted(rows, key=lambda n: n.name)]}


@router.get("/{name}/namespaces")
def get_namespaces(name: str, store: Store = Depends(get_store_dep),
                   ns_class: str | None = Query(None, alias="class",
                                                description="application|platform"),
                   status: str | None = None):
    _cluster(store, name)
    rows = store.section(name, "namespaces")
    if ns_class:
        rows = [n for n in rows if n.ns_class == ns_class]
    if status:
        rows = [n for n in rows if n.status == status]
    rows = sorted(rows, key=lambda n: order_key(n.ns_class, n.name))
    return {"cluster": name, "count": len(rows), "namespaces": [namespace_dict(n) for n in rows]}


@router.get("/{name}/workloads")
def get_workloads(name: str, store: Store = Depends(get_store_dep),
                  namespace: str | None = None, kind: str | None = None,
                  ns_class: str | None = Query(None, alias="class"),
                  status: str | None = None, detail: bool = False):
    _cluster(store, name)
    rows = store.section(name, "workloads")
    if namespace:
        rows = [w for w in rows if w.namespace == namespace]
    if kind:
        rows = [w for w in rows if w.kind == kind]
    if ns_class:
        rows = [w for w in rows if w.ns_class == ns_class]
    if status:
        rows = [w for w in rows if w.status == status]
    rows = sorted(rows, key=lambda w: order_key(w.namespace, w.kind, w.name))
    return {"cluster": name, "count": len(rows),
            "workloads": [workload_dict(w, detail=detail) for w in rows]}


@router.get("/{name}/pod-issues")
def get_pod_issues(name: str, store: Store = Depends(get_store_dep),
                   ns_class: str | None = Query(None, alias="class")):
    _cluster(store, name)
    rows = store.section(name, "pod_issues")
    if ns_class:
        rows = [i for i in rows if i.ns_class == ns_class]
    rows = sorted(rows, key=lambda i: order_key(i.ns_class, i.namespace, i.name))
    return {"cluster": name, "count": len(rows), "pod_issues": [pod_issue_dict(i) for i in rows]}


@router.get("/{name}/resources")
def get_resources(name: str, store: Store = Depends(get_store_dep),
                  kind: str | None = Query(None, description="manifest key, e.g. routes, secrets"),
                  namespace: str | None = None, status: str | None = None,
                  ns_class: str | None = Query(None, alias="class"),
                  limit: int = Query(500, le=5000)):
    _cluster(store, name)
    rows = store.section(name, "resources")
    if kind:
        rows = [r for r in rows if r.key == kind]
    if namespace:
        rows = [r for r in rows if r.namespace == namespace]
    if status:
        rows = [r for r in rows if r.status == status]
    if ns_class:
        rows = [r for r in rows if r.ns_class == ns_class]
    rows = sorted(rows, key=lambda r: order_key(r.key, r.namespace, r.name))[:limit]
    return {"cluster": name, "count": len(rows), "resources": [resource_dict(r) for r in rows]}


@router.get("/{name}/timeline")
def get_timeline(name: str, limit: int = 100,
                 resolution: str = Query("sweep", description=RESOLUTION_DOC),
                 since: datetime | None = None, until: datetime | None = None,
                 store: Store = Depends(get_store_dep)):
    """One cluster's history, oldest first (the order a chart wants).

    `resolution` picks the tier: every sweep for the last couple of days, one
    row per hour for months, one row per day for years. `since` / `until` are
    ISO 8601 instants; without them the last `limit` rows come back.
    """
    rows = store.snapshots(name, limit, resolution=resolution_of(resolution),
                           since=since, until=until)
    return {"cluster": name, "resolution": resolution, "count": len(rows),
            "snapshots": [snapshot_dict(r) for r in rows]}


@router.get("/{name}/changes")
def get_changes(name: str, limit: int = Query(200, le=2000),
                since: datetime | None = None,
                kind: str | None = Query(None, description=KIND_DOC),
                store: Store = Depends(get_store_dep)):
    """What changed on this cluster, newest first: version and status moves,
    checks that started failing or recovered, operators that degraded, nodes
    and namespaces coming and going, upgrades, reachability."""
    rows = store.changes(name, limit=limit, since=since)
    if kind:
        rows = [r for r in rows if r.kind == kind]
    return {"cluster": name, "count": len(rows),
            "changes": [change_dict(r) for r in rows]}
