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

from . import __version__
from .api import (
    admin,
    agent,
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
from .collector.coordination import stop_background
from .manifest import get_manifest
from .query.dashboards import builtin_dashboards
from .scheduler import stop_scheduler
from .settings import settings
from .startup import configure_logging, start_collecting, wait_for_redis

configure_logging()
log = logging.getLogger("odl")


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
    wait_for_redis()
    if not settings.collector_enabled:
        log.info("collector disabled (COLLECTOR_ENABLED=false): serving Redis read-only; "
                 "a refresh is queued to the collectors")
    else:
        start_collecting(m)
    # Warm the SQL snapshot in the background so the first Query page visit
    # does not pay for the build; a later fleet change rebuilds it the same way.
    threading.Thread(target=_warm_query_snapshot, name="odl-query-warm", daemon=True).start()
    yield
    if settings.collector_enabled:
        stop_scheduler()
        stop_background()


app = FastAPI(
    title="Operations Data Layer",
    description="Fleet health, inventory, utilization, insights and blast radius "
                "over a multi-hub OpenShift estate - everything sourced from the "
                "OCP API, values scrubbed.",
    version=__version__,
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
app.include_router(agent.router)


@app.get("/healthz", tags=["meta"])
def healthz():
    return {"status": "ok"}


# Static dashboard (built assets), if present. Mounted last so it doesn't shadow
# the API routes.
_STATIC = os.environ.get("STATIC_DIR", "/app/static")
if os.path.isdir(_STATIC):
    app.mount("/", StaticFiles(directory=_STATIC, html=True), name="dashboard")
