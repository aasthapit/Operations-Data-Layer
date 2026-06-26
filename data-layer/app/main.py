"""
Operations Data Layer - API + collector entrypoint.

Serves the REST API over the collected fleet state, runs the periodic collector,
and serves the static dashboard. Reads are always from Postgres; the collector
keeps Postgres fresh in the background.
"""
import logging
import os
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .api import admin, blast_radius, clusters, health, versions
from .collector.runner import run_collection
from .db import engine, init_db
from .scheduler import start_scheduler, stop_scheduler
from .settings import settings

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("odl")


def _wait_for_db(retries=30, delay=2):
    import time
    from sqlalchemy import text
    for i in range(retries):
        try:
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            return
        except Exception as e:  # noqa: BLE001
            log.info("waiting for database (%d/%d): %s", i + 1, retries, e)
            time.sleep(delay)
    raise RuntimeError("database never became reachable")


@asynccontextmanager
async def lifespan(app: FastAPI):
    _wait_for_db()
    init_db()
    if settings.refresh_on_startup:
        threading.Thread(target=run_collection, args=("startup",),
                         daemon=True).start()
    start_scheduler()
    yield
    stop_scheduler()


app = FastAPI(
    title="Operations Data Layer",
    description="Fleet health, versions, and blast-radius over a multi-hub "
                "OpenShift estate.",
    version="0.1.0",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

app.include_router(clusters.router)
app.include_router(health.router)
app.include_router(versions.router)
app.include_router(blast_radius.router)
app.include_router(admin.router)


@app.get("/healthz", tags=["meta"])
def healthz():
    return {"status": "ok"}


# Static dashboard (built assets), if present. Mounted last so it doesn't shadow
# the API routes.
_STATIC = os.environ.get("STATIC_DIR", "/app/static")
if os.path.isdir(_STATIC):
    app.mount("/", StaticFiles(directory=_STATIC, html=True), name="dashboard")
