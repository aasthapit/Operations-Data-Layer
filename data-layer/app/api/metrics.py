"""
Utilization endpoints - answered from the OCP API's own metrics
(metrics.k8s.io NodeMetrics / PodMetrics, collected every sweep alongside
inventory), never from Prometheus or any external system.

Fleet-wide top-N comes from the usage sorted sets, so "the ten busiest
namespaces" is a range read rather than a fleet scan.
"""
from collections import defaultdict
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query

from ..serialize import _iso, capacity_dict
from ..store import Store
from .deps import RESOLUTION_DOC, get_store_dep
from .deps import resolution as resolution_of

router = APIRouter(prefix="/api/metrics", tags=["metrics"])


@router.get("/health")
def metrics_health(store: Store = Depends(get_store_dep)):
    clusters = store.clusters()
    total = sum(1 for c in clusters if c.reachable)
    with_metrics = sum(1 for c in clusters if c.metrics_available)
    return {"source": "metrics.k8s.io (via each cluster's API server)",
            "reachable": with_metrics > 0,
            "clusters_with_metrics": with_metrics, "clusters_total": total,
            "without_metrics": [c.name for c in clusters
                                if c.reachable and not c.metrics_available]}


@router.get("/top-namespaces")
def top_namespaces(store: Store = Depends(get_store_dep),
                   by: str = Query("cpu", description="cpu|memory"), limit: int = 10,
                   ns_class: str | None = Query(None, alias="class", description="application|platform")):
    field = "cpu_usage" if by == "cpu" else "memory_usage"
    if ns_class:
        # the usage sorted sets are not split by class, so a class-filtered
        # top-N is ranked in process over that class's namespaces
        rows = [n for n in store.namespaces(ns_class=ns_class) if n.get(field) is not None]
        rows.sort(key=lambda n: (-n[field], n.cluster_name or "", n.name or ""))
        rows = rows[:limit]
    else:
        rows = store.top_namespaces(by, limit)
    return {"by": by, "unit": "cores" if by == "cpu" else "bytes",
            "results": [{"namespace": n.name, "cluster": n.cluster_name, "class": n.ns_class,
                         "app": n.app_name, "team": n.team,
                         "value": n.get(field)}
                        for n in rows]}


@router.get("/top-nodes")
def top_nodes(store: Store = Depends(get_store_dep),
              by: str = Query("cpu", description="cpu|memory"), limit: int = 10):
    return {"by": by, "unit": "percent",
            "results": [{"node": n.name, "cluster": n.cluster_name, "roles": n.roles or [],
                         "value": round(n.value, 1)}
                        for n in store.top_nodes(by, limit)]}


@router.get("/capacity")
def capacity(store: Store = Depends(get_store_dep),
             group_by: str = Query("cluster", description="cluster|hub|region|environment|datacenter")):
    key = group_by if group_by in ("region", "environment", "datacenter", "hub") else "cluster"
    field = {"cluster": "name", "hub": "hub_name"}.get(key, key)
    groups = defaultdict(lambda: {"allocatable_cores": 0.0, "used_cores": 0.0, "requests_cores": 0.0,
                                  "allocatable_bytes": 0, "used_bytes": 0, "requests_bytes": 0,
                                  "clusters": 0, "with_metrics": 0})
    for c in store.clusters():
        if not c.reachable:
            continue
        g = groups[c.get(field) or "unknown"]
        g["clusters"] += 1
        g["with_metrics"] += bool(c.metrics_available)
        g["allocatable_cores"] += c.cpu_allocatable or 0
        g["used_cores"] += c.cpu_usage or 0
        g["requests_cores"] += c.cpu_requests or 0
        g["allocatable_bytes"] += c.memory_allocatable or 0
        g["used_bytes"] += c.memory_usage or 0
        g["requests_bytes"] += c.memory_requests or 0
    rows = []
    for name, g in sorted(groups.items()):
        a, u = g["allocatable_cores"], g["used_cores"]
        ma, mu = g["allocatable_bytes"], g["used_bytes"]
        rows.append({key: name, "clusters": g["clusters"], "with_metrics": g["with_metrics"],
                     "allocatable_cores": round(a, 2), "used_cores": round(u, 2),
                     "requests_cores": round(g["requests_cores"], 2),
                     "headroom_cores": round(a - u, 2),
                     "used_percent": round(100 * u / a, 1) if a else None,
                     "allocatable_bytes": ma, "used_bytes": mu, "requests_bytes": g["requests_bytes"],
                     "headroom_bytes": ma - mu,
                     "memory_used_percent": round(100 * mu / ma, 1) if ma else None})
    return {"group_by": key, "results": rows}


@router.get("/cluster/{name}/utilization")
def cluster_utilization(name: str, store: Store = Depends(get_store_dep)):
    c = store.get_cluster(name)
    if not c:
        raise HTTPException(404, f"cluster {name} not found")
    # one cluster's namespaces live in its own section; no need for the fleet index
    rows = [n for n in store.section(name, "namespaces") if n.cpu_usage is not None]
    top = sorted(rows, key=lambda n: (-n.cpu_usage, n.name or ""))[:5]
    return {"cluster": name, **capacity_dict(c),
            "top_namespaces": [{"namespace": n.name, "class": n.ns_class,
                                "cpu_used_cores": n.cpu_usage, "memory_used_bytes": n.memory_usage}
                               for n in top]}


@router.get("/cluster/{name}/timeline")
def cluster_timeline(name: str, limit: int = 100,
                     resolution: str = Query("sweep", description=RESOLUTION_DOC),
                     since: datetime | None = None, until: datetime | None = None,
                     store: Store = Depends(get_store_dep)):
    """Utilization over time for one cluster, oldest first.

    At `hour` and `day` resolution the usage columns are the mean over the
    bucket and `*_max` is the peak inside it, which is the pair capacity
    planning needs: a mean alone makes every cluster look idle.
    """
    rows = store.snapshots(name, limit, resolution=resolution_of(resolution),
                           since=since, until=until)
    return {"cluster": name, "resolution": resolution, "points": [{
        "at": _iso(r.snapshot_at),
        "samples": r.samples if r.samples is not None else 1,
        "cpu_used_cores": r.cpu_usage, "cpu_used_cores_max": r.cpu_usage_max,
        "cpu_allocatable_cores": r.cpu_allocatable,
        "cpu_percent": _percent(r.cpu_usage, r.cpu_allocatable),
        "memory_used_bytes": r.memory_usage, "memory_used_bytes_max": r.memory_usage_max,
        "memory_allocatable_bytes": r.memory_allocatable,
        "memory_percent": _percent(r.memory_usage, r.memory_allocatable),
        "pods_running": r.pods_running, "pod_issues": r.pod_issues,
    } for r in rows]}


def _percent(used, total):
    return round(100 * used / total, 1) if used is not None and total else None
