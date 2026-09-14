"""Fleet health: the overview tiles and the roll-up by placement dimension."""
from collections import defaultdict

from fastapi import APIRouter, Depends, Query

from ..collector import runner
from ..serialize import _iso
from ..settings import settings
from ..store import Store
from .deps import get_store_dep

router = APIRouter(prefix="/api/health", tags=["health"])

_STATUSES = ["healthy", "warning", "critical", "unknown"]

# group_by value -> the summary-row field it groups on
_GROUP_FIELDS = {
    "region": "region",
    "datacenter": "datacenter",
    "environment": "environment",
    "hub": "hub_name",
    "version": "ocp_version",
}


def _empty_counts():
    return {s: 0 for s in _STATUSES}


@router.get("/summary")
def summary(group_by: str | None = Query(None, description="region|datacenter|environment|hub|version "
                                                        "(default: ODL_PRIMARY_DIMENSION)"),
            store: Store = Depends(get_store_dep)):
    if group_by not in _GROUP_FIELDS:
        group_by = settings.primary_dimension
    field = _GROUP_FIELDS[group_by]
    groups = defaultdict(_empty_counts)
    for c in store.clusters():
        key = c.get(field) or "unknown"
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
def overview(store: Store = Depends(get_store_dep)):
    counts = _empty_counts()
    total = 0
    upgrading = 0
    for c in store.clusters():
        total += 1
        status = c.overall_status if c.overall_status in _STATUSES else "unknown"
        counts[status] += 1
        if c.upgrading:
            upgrading += 1

    last = runner.last_run()
    recent_runs = store.runs(1)
    recent = recent_runs[0] if recent_runs else None
    return {
        "primary_dimension": settings.primary_dimension,
        "clusters_total": total,
        "counts": counts,
        "upgrading": upgrading,
        "hubs": [{"name": h.name, "region": h.region,
                  "datacenter": h.datacenter, "reachable": h.reachable,
                  "managed_count": h.managed_count,
                  "last_synced": _iso(h.last_synced),
                  "last_error": h.last_error}
                 # the hub hash has no order of its own; name order keeps the
                 # overview stable between refreshes
                 for h in sorted(store.hubs(), key=lambda h: h.name or "")],
        "last_run": last and {
            "at": _iso(last["at"]),
            "ok": last["ok"],
            "trigger": last["trigger"],
        },
        "last_collection": recent and {
            "duration_ms": recent.duration_ms,
            "clusters_ok": recent.clusters_ok,
            "clusters_failed": recent.clusters_failed,
            "finished_at": _iso(recent.finished_at),
        },
    }
