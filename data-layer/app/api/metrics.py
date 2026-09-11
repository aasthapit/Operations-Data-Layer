"""
Utilization endpoints - answered from the OCP API's own metrics
(metrics.k8s.io NodeMetrics / PodMetrics, collected every sweep alongside
inventory), never from Prometheus or any external system.
"""
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..db import get_session
from ..models import Cluster, HealthSnapshot, Namespace, Node
from ..serialize import capacity_dict

router = APIRouter(prefix="/api/metrics", tags=["metrics"])


@router.get("/health")
def metrics_health(db: Session = Depends(get_session)):
    total = db.query(Cluster).filter(Cluster.reachable.is_(True)).count()
    with_metrics = db.query(Cluster).filter(Cluster.metrics_available.is_(True)).count()
    return {"source": "metrics.k8s.io (via each cluster's API server)",
            "reachable": with_metrics > 0,
            "clusters_with_metrics": with_metrics, "clusters_total": total,
            "without_metrics": [c.name for c in db.query(Cluster)
                                .filter(Cluster.reachable.is_(True), Cluster.metrics_available.is_(False))
                                .order_by(Cluster.name).all()]}


@router.get("/top-namespaces")
def top_namespaces(db: Session = Depends(get_session),
                   by: str = Query("cpu", description="cpu|memory"), limit: int = 10,
                   ns_class: str | None = Query(None, alias="class", description="application|platform")):
    col = Namespace.cpu_usage if by == "cpu" else Namespace.memory_usage
    q = db.query(Namespace).filter(col.isnot(None))
    if ns_class:
        q = q.filter(Namespace.ns_class == ns_class)
    rows = q.order_by(col.desc()).limit(limit).all()
    return {"by": by, "unit": "cores" if by == "cpu" else "bytes",
            "results": [{"namespace": n.name, "cluster": n.cluster_name, "class": n.ns_class,
                         "app": n.app_name, "team": n.team,
                         "value": n.cpu_usage if by == "cpu" else n.memory_usage}
                        for n in rows]}


@router.get("/top-nodes")
def top_nodes(db: Session = Depends(get_session),
              by: str = Query("cpu", description="cpu|memory"), limit: int = 10):
    rows = []
    for n in db.query(Node).all():
        used, alloc = ((n.cpu_usage, n.cpu_allocatable) if by == "cpu"
                       else (n.memory_usage, n.memory_allocatable))
        if used is None or not alloc:
            continue
        rows.append({"node": n.name, "cluster": n.cluster_name, "roles": n.roles or [],
                     "value": round(100.0 * used / alloc, 1)})
    rows.sort(key=lambda r: -r["value"])
    return {"by": by, "unit": "percent", "results": rows[:limit]}


@router.get("/capacity")
def capacity(db: Session = Depends(get_session),
             group_by: str = Query("cluster", description="cluster|region|environment|datacenter")):
    key = group_by if group_by in ("region", "environment", "datacenter") else "cluster"
    groups = defaultdict(lambda: {"allocatable_cores": 0.0, "used_cores": 0.0, "requests_cores": 0.0,
                                  "allocatable_bytes": 0, "used_bytes": 0, "requests_bytes": 0,
                                  "clusters": 0, "with_metrics": 0})
    for c in db.query(Cluster).filter(Cluster.reachable.is_(True)).all():
        g = groups[getattr(c, "name" if key == "cluster" else key) or "unknown"]
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
def cluster_utilization(name: str, db: Session = Depends(get_session)):
    c = db.get(Cluster, name)
    if not c:
        raise HTTPException(404, f"cluster {name} not found")
    top = (db.query(Namespace).filter(Namespace.cluster_name == name, Namespace.cpu_usage.isnot(None))
           .order_by(Namespace.cpu_usage.desc()).limit(5).all())
    return {"cluster": name, **capacity_dict(c),
            "top_namespaces": [{"namespace": n.name, "class": n.ns_class,
                                "cpu_used_cores": n.cpu_usage, "memory_used_bytes": n.memory_usage}
                               for n in top]}


@router.get("/cluster/{name}/timeline")
def cluster_timeline(name: str, limit: int = 100, db: Session = Depends(get_session)):
    rows = (db.query(HealthSnapshot).filter_by(cluster_name=name)
            .order_by(HealthSnapshot.snapshot_at.desc()).limit(limit).all())
    rows.reverse()
    return {"cluster": name, "points": [{
        "at": r.snapshot_at.isoformat() if r.snapshot_at else None,
        "cpu_used_cores": r.cpu_usage, "cpu_allocatable_cores": r.cpu_allocatable,
        "cpu_percent": round(100 * r.cpu_usage / r.cpu_allocatable, 1)
        if r.cpu_usage is not None and r.cpu_allocatable else None,
        "memory_used_bytes": r.memory_usage, "memory_allocatable_bytes": r.memory_allocatable,
        "memory_percent": round(100 * r.memory_usage / r.memory_allocatable, 1)
        if r.memory_usage is not None and r.memory_allocatable else None,
        "pods_running": r.pods_running, "pod_issues": r.pod_issues,
    } for r in rows]}
