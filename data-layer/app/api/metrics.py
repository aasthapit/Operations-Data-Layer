"""Metrics-plane endpoints - utilization/capacity answered from Thanos by query."""
from fastapi import APIRouter, HTTPException, Query

from .. import metrics

router = APIRouter(prefix="/api/metrics", tags=["metrics"])


def _guard(fn):
    try:
        return fn()
    except metrics.MetricsUnavailable as e:
        raise HTTPException(503, f"metrics plane unavailable: {e}")


@router.get("/health")
def metrics_health():
    return {"thanos_url": metrics.settings.thanos_url, "reachable": metrics.healthy()}


@router.get("/top-namespaces")
def top_namespaces(by: str = Query("cpu", description="cpu|memory"), limit: int = 10):
    return _guard(lambda: metrics.top_namespaces(by, limit))


@router.get("/top-nodes")
def top_nodes(by: str = Query("cpu", description="cpu|memory"), limit: int = 10):
    return _guard(lambda: metrics.top_nodes(by, limit))


@router.get("/capacity")
def capacity(group_by: str = Query("cluster", description="cluster|region|environment")):
    return _guard(lambda: metrics.capacity(group_by))


@router.get("/cluster/{name}/utilization")
def cluster_utilization(name: str):
    data = _guard(lambda: metrics.cluster_utilization(name))
    if not data:
        raise HTTPException(404, f"no metrics for cluster {name}")
    return data


@router.get("/query")
def raw_query(promql: str = Query(..., description="instant PromQL expression")):
    return {"query": promql, "results": _guard(lambda: metrics.raw_query(promql))}
