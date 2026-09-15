"""
Operations Data Layer - API + collector entrypoint.

Serves the REST API over the collected fleet state, runs the periodic collector,
and serves the static dashboard. Reads are always from Redis; the collector
keeps Redis fresh in the background.
"""
import logging
import os
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from .api import (
    admin,
    applications,
    blast_radius,
    clusters,
    dashboards,
    health,
    insights,
    manifest,
    metrics,
    query,
    versions,
)
from .collector.runner import run_collection, validate_hub_selection
from .manifest import get_manifest
from .query.dashboards import builtin_dashboards
from .scheduler import start_scheduler, stop_scheduler
from .settings import settings
from .store import get_store

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("odl")


def _wait_for_redis(retries=30, delay=2):
    """Every read is served from Redis, so refuse to come up without it."""
    import time

    store = get_store()
    for i in range(retries):
        try:
            store.ping()
            return
        except Exception as e:  # noqa: BLE001
            log.info("waiting for redis (%d/%d): %s", i + 1, retries, e)
            time.sleep(delay)
    raise RuntimeError("redis never became reachable")


def _require_fleet_config():
    """Fail at startup, not at the first sweep, when there is nothing to collect from."""
    path = settings.config_path
    if os.path.isfile(path):
        return
    raise RuntimeError(
        f"fleet config not found: {path!r} (ODL_CONFIG). Copy data-layer/config/acm.example.yaml "
        "to config/acm.yaml (a static list of ACM hubs) or clusters.example.yaml to "
        "config/clusters.yaml (a direct list of endpoints), fill it in, and set ODL_CONFIG; "
        "or set COLLECTOR_ENABLED=false to serve Redis read-only.")


def _require_application_mapping(manifest):
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


def _warm_query_snapshot() -> None:
    import time

    from .query.snapshot import get_snapshot
    time.sleep(5)          # let the startup sweep write something first
    try:
        get_snapshot()
    except Exception as e:  # noqa: BLE001 - warming is a courtesy
        log.info("query snapshot warm-up skipped: %s", e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    m = get_manifest()      # fail fast on a bad manifest
    log.info("manifest %s: %d resources enabled", m.source, len(m.enabled_keys()))
    # Built-in dashboards are part of the image: a broken one is a startup
    # error naming the file, not a 500 at somebody's first request.
    log.info("%d built-in dashboards", len(builtin_dashboards()))
    _wait_for_redis()
    if not settings.collector_enabled:
        log.info("collector disabled (COLLECTOR_ENABLED=false): serving Redis read-only")
    else:
        _require_fleet_config()
        # A typo in COLLECT_HUBS would otherwise be a collector that quietly
        # collects nothing at all.
        validate_hub_selection()
        _require_application_mapping(m)
        if settings.refresh_on_startup:
            threading.Thread(target=run_collection, args=("startup",),
                             daemon=True).start()
        start_scheduler()
    # Warm the SQL snapshot in the background so the first Query page visit
    # does not pay for the build; a later fleet change rebuilds it the same way.
    threading.Thread(target=_warm_query_snapshot, name="odl-query-warm", daemon=True).start()
    yield
    if settings.collector_enabled:
        stop_scheduler()


app = FastAPI(
    title="Operations Data Layer",
    description="Fleet health, inventory, utilization, insights and blast radius "
                "over a multi-hub OpenShift estate - everything sourced from the "
                "OCP API, values scrubbed.",
    version="0.2.0",
    lifespan=lifespan,
)
# Fleet-wide JSON compresses 5 to 10x; the dashboard's fetches are the win.
app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

app.include_router(clusters.router)
app.include_router(applications.router)
app.include_router(health.router)
app.include_router(versions.router)
app.include_router(blast_radius.router)
app.include_router(insights.router)
app.include_router(metrics.router)
app.include_router(manifest.router)
app.include_router(admin.router)
app.include_router(query.router)
app.include_router(dashboards.router)


@app.get("/healthz", tags=["meta"])
def healthz():
    return {"status": "ok"}


# Static dashboard (built assets), if present. Mounted last so it doesn't shadow
# the API routes.
_STATIC = os.environ.get("STATIC_DIR", "/app/static")
if os.path.isdir(_STATIC):
    app.mount("/", StaticFiles(directory=_STATIC, html=True), name="dashboard")
