"""What the data layer collects, and what each cluster actually served."""
from collections import defaultdict

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..db import get_session
from ..manifest import get_manifest
from ..models import Cluster, ResourceStatus

router = APIRouter(prefix="/api/manifest", tags=["manifest"])


@router.get("")
def manifest():
    """The OCP API manifest: every resource the collector knows, whether it is
    enabled, the scrub policy, namespace classification and thresholds."""
    return get_manifest().describe()


@router.get("/availability")
def availability(db: Session = Depends(get_session)):
    """Per cluster, per resource: collected / unavailable / forbidden / error /
    disabled - i.e. what each cluster can actually answer."""
    clusters = db.query(Cluster).order_by(Cluster.name).all()
    rows = db.query(ResourceStatus).all()
    by_cluster = defaultdict(dict)
    totals = defaultdict(lambda: defaultdict(int))
    for r in rows:
        by_cluster[r.cluster_name][r.key] = {
            "status": r.status, "count": r.count, "duration_ms": r.duration_ms, "error": r.error}
        totals[r.key][r.status] += 1
    return {
        "resources": [r["key"] for r in get_manifest().describe()["resources"]],
        "clusters": [{"name": c.name, "reachable": c.reachable, "status": c.overall_status,
                      "resources": by_cluster.get(c.name, {})} for c in clusters],
        "totals": {k: dict(v) for k, v in totals.items()},
    }
