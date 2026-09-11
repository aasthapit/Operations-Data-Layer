"""Patching service - the durable system of record for patching jobs."""
import logging
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


app = FastAPI(
    title="Patching Service",
    description="System of record for fleet patching: jobs, approvals, "
                "per-cluster task results, and an append-only audit trail.",
    version="0.1.0",
    lifespan=lifespan,
)
app.add_middleware(CORSMiddleware, allow_origins=["*"],
                   allow_methods=["*"], allow_headers=["*"])
app.include_router(router)


@app.get("/healthz", tags=["meta"])
def healthz():
    return {"status": "ok"}
