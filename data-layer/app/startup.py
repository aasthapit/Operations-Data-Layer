"""
The startup every process shares, so the API and the headless worker cannot
drift apart.

Both come up the same way and must fail the same way: a manifest that does not
parse, a Redis that never answers, a fleet config that is not mounted, a
`COLLECT_HUBS` typo or a missing application registry are startup errors that
name the fix, not a process that runs and quietly collects nothing. The API
adds HTTP to this; the worker (`python -m app.worker`) adds nothing but its
heartbeat loop.
"""
import logging
import os
import threading
import time

from .collector.runner import run_collection, validate_hub_selection
from .scheduler import start_scheduler
from .settings import settings
from .store import get_store

log = logging.getLogger("odl.startup")

LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"


def configure_logging() -> None:
    """One format for every process, so pod logs read alike."""
    logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)


def wait_for_redis(retries: int = 30, delay: float = 2) -> None:
    """Every read is served from Redis, so refuse to come up without it."""
    store = get_store()
    for i in range(retries):
        try:
            store.ping()
            return
        except Exception as e:  # noqa: BLE001
            log.info("waiting for redis (%d/%d): %s", i + 1, retries, e)
            time.sleep(delay)
    raise RuntimeError("redis never became reachable")


def require_fleet_config() -> None:
    """Fail at startup, not at the first sweep, when there is nothing to collect from."""
    path = settings.config_path
    if os.path.isfile(path):
        return
    raise RuntimeError(
        f"fleet config not found: {path!r} (ODL_CONFIG). Copy data-layer/config/acm.example.yaml "
        "to config/acm.yaml (a static list of ACM hubs) or clusters.example.yaml to "
        "config/clusters.yaml (a direct list of endpoints), fill it in, and set ODL_CONFIG; "
        "or set COLLECTOR_ENABLED=false to serve Redis read-only.")


def require_application_mapping(manifest) -> None:
    """When ownership comes from a mapping file, it must be there at startup."""
    from .appmap import get_appmap, resolve_path
    if manifest.applications.get("source") != "mapping":
        return
    try:
        appmap = get_appmap(manifest)
    except FileNotFoundError as e:
        raise RuntimeError(
            f"application mapping not found: {resolve_path(manifest)!r}. The manifest sets "
            "applications.source: mapping; provide the file (see config/app-map.example.json), "
            "set ODL_APP_MAP, or switch applications.source back to labels.") from e
    log.info("application mapping: %s", appmap.describe())


def start_collecting(manifest, consume_refresh_queue: bool = True) -> None:
    """Everything a process that collects does at startup: check that it can
    collect at all, sweep once if asked, and start the scheduler.

    `consume_refresh_queue` starts the small thread that publishes presence and
    drains the refresh queue. The API in `all` mode wants it; the headless
    worker does not, because its own main loop is that thread.
    """
    require_fleet_config()
    # A typo in COLLECT_HUBS would otherwise be a collector that quietly
    # collects nothing at all.
    validate_hub_selection()
    require_application_mapping(manifest)
    if settings.refresh_on_startup:
        threading.Thread(target=run_collection, args=("startup",),
                         name="odl-startup-sweep", daemon=True).start()
    start_scheduler()
    if consume_refresh_queue:
        from .collector.coordination import start_background
        start_background()
