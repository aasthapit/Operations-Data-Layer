from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..db import get_session
from ..models import Cluster, HealthSnapshot, Namespace, PodIssue, Resource, Workload
from ..serialize import (
    check_dict,
    cluster_detail,
    cluster_summary,
    namespace_dict,
    node_dict,
    operator_dict,
    pod_issue_dict,
    resource_dict,
    workload_dict,
)

router = APIRouter(prefix="/api/clusters", tags=["clusters"])


def _cluster(db, name) -> Cluster:
    c = db.get(Cluster, name)
    if not c:
        raise HTTPException(404, f"cluster {name} not found")
    return c


@router.get("")
def list_clusters(
    db: Session = Depends(get_session),
    region: str | None = None,
    datacenter: str | None = None,
    environment: str | None = None,
    hub: str | None = None,
    status: str | None = Query(None, description="healthy|warning|critical|unknown"),
    version: str | None = None,
    team: str | None = None,
):
    q = db.query(Cluster)
    if region:
        q = q.filter(Cluster.region == region)
    if datacenter:
        q = q.filter(Cluster.datacenter == datacenter)
    if environment:
        q = q.filter(Cluster.environment == environment)
    if hub:
        q = q.filter(Cluster.hub_name == hub)
    if status:
        q = q.filter(Cluster.overall_status == status)
    if version:
        q = q.filter(Cluster.ocp_version == version)
    clusters = q.order_by(Cluster.name).all()
    items = [cluster_summary(c) for c in clusters]
    if team:
        # filter to clusters running an application owned by `team`
        keep = {n.cluster_name for n in db.query(Namespace)
                .filter(Namespace.team == team, Namespace.ns_class == "application").all()}
        items = [i for i in items if i["name"] in keep]
    return {"count": len(items), "clusters": items}


@router.get("/{name}")
def get_cluster(name: str, db: Session = Depends(get_session)):
    return cluster_detail(_cluster(db, name))


@router.get("/{name}/operators")
def get_operators(name: str, db: Session = Depends(get_session)):
    c = _cluster(db, name)
    return {"cluster": name,
            "operators": [operator_dict(o) for o in sorted(c.operators, key=lambda o: o.name)]}


@router.get("/{name}/health")
def get_health(name: str, db: Session = Depends(get_session)):
    c = _cluster(db, name)
    return {
        "cluster": name,
        "overall_status": c.overall_status,
        "health_score": c.health_score,
        "checks": [check_dict(h) for h in c.health_checks],
    }


@router.get("/{name}/nodes")
def get_nodes(name: str, db: Session = Depends(get_session)):
    c = _cluster(db, name)
    return {"cluster": name, "nodes": [node_dict(n) for n in sorted(c.nodes, key=lambda n: n.name)]}


@router.get("/{name}/namespaces")
def get_namespaces(name: str, db: Session = Depends(get_session),
                   ns_class: str | None = Query(None, alias="class",
                                                description="application|platform"),
                   status: str | None = None):
    _cluster(db, name)
    q = db.query(Namespace).filter(Namespace.cluster_name == name)
    if ns_class:
        q = q.filter(Namespace.ns_class == ns_class)
    if status:
        q = q.filter(Namespace.status == status)
    rows = q.order_by(Namespace.ns_class, Namespace.name).all()
    return {"cluster": name, "count": len(rows), "namespaces": [namespace_dict(n) for n in rows]}


@router.get("/{name}/workloads")
def get_workloads(name: str, db: Session = Depends(get_session),
                  namespace: str | None = None, kind: str | None = None,
                  ns_class: str | None = Query(None, alias="class"),
                  status: str | None = None, detail: bool = False):
    _cluster(db, name)
    q = db.query(Workload).filter(Workload.cluster_name == name)
    if namespace:
        q = q.filter(Workload.namespace == namespace)
    if kind:
        q = q.filter(Workload.kind == kind)
    if ns_class:
        q = q.filter(Workload.ns_class == ns_class)
    if status:
        q = q.filter(Workload.status == status)
    rows = q.order_by(Workload.namespace, Workload.kind, Workload.name).all()
    return {"cluster": name, "count": len(rows),
            "workloads": [workload_dict(w, detail=detail) for w in rows]}


@router.get("/{name}/pod-issues")
def get_pod_issues(name: str, db: Session = Depends(get_session),
                   ns_class: str | None = Query(None, alias="class")):
    _cluster(db, name)
    q = db.query(PodIssue).filter(PodIssue.cluster_name == name)
    if ns_class:
        q = q.filter(PodIssue.ns_class == ns_class)
    rows = q.order_by(PodIssue.ns_class, PodIssue.namespace, PodIssue.name).all()
    return {"cluster": name, "count": len(rows), "pod_issues": [pod_issue_dict(i) for i in rows]}


@router.get("/{name}/resources")
def get_resources(name: str, db: Session = Depends(get_session),
                  kind: str | None = Query(None, description="manifest key, e.g. routes, secrets"),
                  namespace: str | None = None, status: str | None = None,
                  ns_class: str | None = Query(None, alias="class"),
                  limit: int = Query(500, le=5000)):
    _cluster(db, name)
    q = db.query(Resource).filter(Resource.cluster_name == name)
    if kind:
        q = q.filter(Resource.key == kind)
    if namespace:
        q = q.filter(Resource.namespace == namespace)
    if status:
        q = q.filter(Resource.status == status)
    if ns_class:
        q = q.filter(Resource.ns_class == ns_class)
    rows = q.order_by(Resource.key, Resource.namespace, Resource.name).limit(limit).all()
    return {"cluster": name, "count": len(rows), "resources": [resource_dict(r) for r in rows]}


@router.get("/{name}/timeline")
def get_timeline(name: str, limit: int = 100,
                 db: Session = Depends(get_session)):
    rows = (db.query(HealthSnapshot)
            .filter_by(cluster_name=name)
            .order_by(HealthSnapshot.snapshot_at.desc())
            .limit(limit).all())
    rows.reverse()
    return {
        "cluster": name,
        "snapshots": [{
            "at": r.snapshot_at.isoformat() if r.snapshot_at else None,
            "overall_status": r.overall_status,
            "health_score": r.health_score,
            "passed": r.checks_passed,
            "warned": r.checks_warned,
            "failed": r.checks_failed,
            "ocp_version": r.ocp_version,
            "upgrading": r.upgrading,
            "cpu_used_cores": r.cpu_usage,
            "cpu_allocatable_cores": r.cpu_allocatable,
            "memory_used_bytes": r.memory_usage,
            "memory_allocatable_bytes": r.memory_allocatable,
            "pods_running": r.pods_running,
            "pod_issues": r.pod_issues,
        } for r in rows],
    }
