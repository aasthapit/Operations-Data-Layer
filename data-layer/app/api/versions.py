from collections import defaultdict

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..db import get_session
from ..models import Cluster, ClusterOperator

router = APIRouter(prefix="/api/versions", tags=["versions"])


@router.get("")
def version_distribution(db: Session = Depends(get_session)):
    """OCP version spread across the fleet, with the clusters on each."""
    by_version = defaultdict(list)
    channels = defaultdict(int)
    for c in db.query(Cluster).all():
        by_version[c.ocp_version or "unknown"].append({
            "name": c.name, "region": c.region, "environment": c.environment,
            "status": c.overall_status, "upgrading": c.upgrading})
        channels[c.channel or "unknown"] += 1

    versions = [{"version": v, "count": len(cs), "clusters": cs}
                for v, cs in sorted(by_version.items(), reverse=True)]
    return {
        "versions": versions,
        "channels": [{"channel": k, "count": v}
                     for k, v in sorted(channels.items())],
        "distinct_versions": len(by_version),
    }


@router.get("/operators")
def operator_versions(name: str | None = None,
                      db: Session = Depends(get_session)):
    """Version spread per operator across the fleet (optionally one operator)."""
    q = db.query(ClusterOperator)
    if name:
        q = q.filter(ClusterOperator.name == name)
    spread = defaultdict(lambda: defaultdict(int))
    for o in q.all():
        spread[o.name][o.version or "unknown"] += 1
    out = []
    for op_name, versions in sorted(spread.items()):
        out.append({
            "operator": op_name,
            "versions": [{"version": v, "count": n}
                         for v, n in sorted(versions.items(), reverse=True)],
            "distinct": len(versions),
        })
    return {"operators": out}
