from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..db import get_session
from ..models import Cluster, HealthSnapshot
from ..serialize import cluster_detail, cluster_summary, check_dict, operator_dict

router = APIRouter(prefix="/api/clusters", tags=["clusters"])


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
        # filter to clusters running an app owned by `team`
        keep = {a.cluster_name for c in clusters for a in c.applications
                if a.team == team}
        items = [i for i in items if i["name"] in keep]
    return {"count": len(items), "clusters": items}


@router.get("/{name}")
def get_cluster(name: str, db: Session = Depends(get_session)):
    c = db.get(Cluster, name)
    if not c:
        raise HTTPException(404, f"cluster {name} not found")
    return cluster_detail(c)


@router.get("/{name}/operators")
def get_operators(name: str, db: Session = Depends(get_session)):
    c = db.get(Cluster, name)
    if not c:
        raise HTTPException(404, f"cluster {name} not found")
    return {"cluster": name,
            "operators": [operator_dict(o) for o in
                          sorted(c.operators, key=lambda o: o.name)]}


@router.get("/{name}/health")
def get_health(name: str, db: Session = Depends(get_session)):
    c = db.get(Cluster, name)
    if not c:
        raise HTTPException(404, f"cluster {name} not found")
    return {
        "cluster": name,
        "overall_status": c.overall_status,
        "health_score": c.health_score,
        "checks": [check_dict(h) for h in c.health_checks],
    }


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
        } for r in rows],
    }
