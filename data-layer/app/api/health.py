from collections import defaultdict

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ..collector.runner import last_run
from ..db import get_session
from ..models import Cluster, CollectionRun, Hub

router = APIRouter(prefix="/api/health", tags=["health"])

_STATUSES = ["healthy", "warning", "critical", "unknown"]

_GROUP_FIELDS = {
    "region": Cluster.region,
    "datacenter": Cluster.datacenter,
    "environment": Cluster.environment,
    "hub": Cluster.hub_name,
    "version": Cluster.ocp_version,
}


def _empty_counts():
    return {s: 0 for s in _STATUSES}


@router.get("/summary")
def summary(group_by: str = Query("region", description="region|datacenter|environment|hub|version"),
            db: Session = Depends(get_session)):
    if group_by not in _GROUP_FIELDS:
        group_by = "region"
    field = _GROUP_FIELDS[group_by]
    groups = defaultdict(_empty_counts)
    for c in db.query(Cluster).all():
        key = getattr(c, field.key) or "unknown"
        status = c.overall_status if c.overall_status in _STATUSES else "unknown"
        groups[key][status] += 1

    out = []
    for key, counts in sorted(groups.items()):
        total = sum(counts.values())
        worst = ("critical" if counts["critical"] else
                 "warning" if counts["warning"] else
                 "unknown" if counts["unknown"] and not (counts["healthy"]) else
                 "healthy")
        out.append({"key": key, "total": total, "counts": counts,
                    "rollup_status": worst})
    return {"group_by": group_by, "groups": out}


@router.get("/overview")
def overview(db: Session = Depends(get_session)):
    counts = _empty_counts()
    total = 0
    upgrading = 0
    for c in db.query(Cluster).all():
        total += 1
        status = c.overall_status if c.overall_status in _STATUSES else "unknown"
        counts[status] += 1
        if c.upgrading:
            upgrading += 1

    hubs = db.query(Hub).all()
    recent = (db.query(CollectionRun)
              .order_by(CollectionRun.started_at.desc()).first())
    return {
        "clusters_total": total,
        "counts": counts,
        "upgrading": upgrading,
        "hubs": [{"name": h.name, "region": h.region,
                  "datacenter": h.datacenter, "reachable": h.reachable,
                  "managed_count": h.managed_count,
                  "last_synced": h.last_synced.isoformat() if h.last_synced else None}
                 for h in hubs],
        "last_run": last_run() and {
            "at": last_run()["at"].isoformat() if last_run()["at"] else None,
            "ok": last_run()["ok"],
            "trigger": last_run()["trigger"],
        },
        "last_collection": recent and {
            "duration_ms": recent.duration_ms,
            "clusters_ok": recent.clusters_ok,
            "clusters_failed": recent.clusters_failed,
            "finished_at": recent.finished_at.isoformat() if recent.finished_at else None,
        },
    }
