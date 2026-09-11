import threading

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..collector.runner import last_run, run_collection
from ..db import get_session
from ..models import CollectionRun

router = APIRouter(prefix="/api", tags=["admin"])


@router.post("/refresh")
def refresh(background: bool = True):
    """Trigger an on-demand collection sweep."""
    if background:
        threading.Thread(target=run_collection, args=("manual",),
                         daemon=True).start()
        return {"accepted": True, "mode": "background"}
    return run_collection("manual")


@router.get("/status")
def status():
    return {"last_run": last_run() and {
        "at": last_run()["at"].isoformat() if last_run()["at"] else None,
        "ok": last_run()["ok"], "trigger": last_run()["trigger"]}}


@router.get("/runs")
def runs(limit: int = 20, db: Session = Depends(get_session)):
    rows = (db.query(CollectionRun)
            .order_by(CollectionRun.started_at.desc()).limit(limit).all())
    return {"runs": [{
        "id": r.id,
        "trigger": r.trigger,
        "started_at": r.started_at.isoformat() if r.started_at else None,
        "finished_at": r.finished_at.isoformat() if r.finished_at else None,
        "duration_ms": r.duration_ms,
        "hubs_total": r.hubs_total,
        "clusters_total": r.clusters_total,
        "clusters_ok": r.clusters_ok,
        "clusters_failed": r.clusters_failed,
        "error": r.error,
    } for r in rows]}
