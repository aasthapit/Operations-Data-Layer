"""Operating the data layer itself: trigger a sweep, see how sweeps went."""
import threading

from fastapi import APIRouter, Depends, HTTPException

from ..collector import runner
from ..serialize import _iso
from ..settings import settings
from ..store import Store
from .deps import get_store_dep

router = APIRouter(prefix="/api", tags=["admin"])

COLLECTOR_DISABLED = ("the collector is disabled on this instance (COLLECTOR_ENABLED=false); "
                      "refresh through the collecting instance")


def require_collector() -> None:
    """Refresh endpoints only make sense where a collector runs."""
    if not settings.collector_enabled:
        raise HTTPException(409, COLLECTOR_DISABLED)


@router.post("/refresh")
def refresh(background: bool = True):
    """Trigger an on-demand collection sweep."""
    require_collector()
    if background:
        threading.Thread(target=runner.run_collection, args=("manual",),
                         daemon=True).start()
        return {"accepted": True, "mode": "background"}
    return runner.run_collection("manual")


@router.get("/status")
def status():
    last = runner.last_run()
    prog = runner.progress()
    return {"last_run": last and {
        "at": _iso(last["at"]), "ok": last["ok"], "trigger": last["trigger"]},
        "sweep": {**prog, "started_at": _iso(prog["started_at"])}}


@router.get("/runs")
def runs(limit: int = 20, store: Store = Depends(get_store_dep)):
    return {"runs": [{
        "id": r.id,
        "trigger": r.trigger,
        "started_at": _iso(r.started_at),
        "finished_at": _iso(r.finished_at),
        "duration_ms": r.duration_ms,
        "hubs_total": r.hubs_total,
        "clusters_total": r.clusters_total,
        "clusters_ok": r.clusters_ok,
        "clusters_failed": r.clusters_failed,
        "error": r.error,
    } for r in store.runs(limit)]}
