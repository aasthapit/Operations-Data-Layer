"""Periodic collection via APScheduler."""
import logging

from apscheduler.schedulers.background import BackgroundScheduler

from .collector.runner import run_collection
from .settings import settings

log = logging.getLogger("odl.scheduler")
_scheduler: BackgroundScheduler | None = None


def start_scheduler():
    global _scheduler
    if _scheduler:
        return _scheduler
    _scheduler = BackgroundScheduler(timezone="UTC")
    _scheduler.add_job(
        lambda: run_collection("scheduled"),
        "interval",
        seconds=settings.refresh_interval_seconds,
        id="collect",
        max_instances=1,
        coalesce=True,
    )
    _scheduler.start()
    log.info("scheduler started (every %ss)", settings.refresh_interval_seconds)
    return _scheduler


def stop_scheduler():
    global _scheduler
    if _scheduler:
        _scheduler.shutdown(wait=False)
        _scheduler = None
