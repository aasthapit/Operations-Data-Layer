"""OCP and cluster-operator version spread across the fleet."""
from collections import defaultdict

from fastapi import APIRouter, Depends

from ..store import Store
from .deps import get_store_dep

router = APIRouter(prefix="/api/versions", tags=["versions"])


@router.get("")
def version_distribution(store: Store = Depends(get_store_dep)):
    """OCP version spread across the fleet, with the clusters on each."""
    by_version = defaultdict(list)
    channels = defaultdict(int)
    for c in store.clusters():
        by_version[c.ocp_version or "unknown"].append({
            "name": c.name, "region": c.region, "environment": c.environment,
            "status": c.overall_status, "upgrading": c.upgrading})
        channels[c.channel or "unknown"] += 1

    versions = [{"version": v, "count": len(cs), "clusters": cs}
                for v, cs in sorted(by_version.items(), reverse=True)]
    return {
        "versions": versions,
        "channels": [{"channel": k, "count": v}
                     for k, v in sorted(channels.items())],
        "distinct_versions": len(by_version),
    }


@router.get("/operators")
def operator_versions(name: str | None = None,
                      store: Store = Depends(get_store_dep)):
    """Version spread per operator across the fleet (optionally one operator).

    Each operator has its own fleet index (cluster -> its copy of that operator),
    so this reads one index per operator instead of walking the clusters.
    """
    names = [name] if name else store.operator_names()
    out = []
    for op_name in sorted(names):
        versions = defaultdict(int)
        for row in store.operator_index(op_name).values():
            versions[row.version or "unknown"] += 1
        if not versions:
            continue        # an operator nobody reports is not part of the spread
        out.append({
            "operator": op_name,
            "versions": [{"version": v, "count": n}
                         for v, n in sorted(versions.items(), reverse=True)],
            "distinct": len(versions),
        })
    return {"operators": out}
