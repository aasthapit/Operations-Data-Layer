"""Patching service - the durable system of record for patching jobs."""
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import router
from .db import ensure_database, init_db

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_database()
    init_db()
    yield



def cors_origins(raw: str | None = None) -> list[str]:
    """ODL_CORS_ORIGINS as a list: comma-separated origins, or "*" (the default)."""
    value = os.environ.get("ODL_CORS_ORIGINS", "*") if raw is None else raw
    origins = [o.strip() for o in value.split(",") if o.strip()]
    return origins or ["*"]

app = FastAPI(
    title="Patching Service",
    description="System of record for fleet patching: jobs, approvals, "
                "per-cluster task results, and an append-only audit trail.",
    version="0.1.0",
    lifespan=lifespan,
)
# Open by default for the development setup where the dashboard is served from
# another origin; production narrows it with ODL_CORS_ORIGINS (comma-separated).
app.add_middleware(CORSMiddleware, allow_origins=cors_origins(),
                   allow_methods=["*"], allow_headers=["*"])
app.include_router(router)


@app.get("/healthz", tags=["meta"])
def healthz():
    return {"status": "ok"}
