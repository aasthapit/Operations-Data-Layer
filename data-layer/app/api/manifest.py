"""What the data layer collects, and what each cluster actually served."""
from collections import defaultdict

from fastapi import APIRouter, Depends

from ..manifest import get_manifest
from ..store import Store
from .deps import get_store_dep

router = APIRouter(prefix="/api/manifest", tags=["manifest"])


@router.get("")
def manifest():
    """The OCP API manifest: every resource the collector knows, whether it is
    enabled, the scrub policy, namespace classification, the thresholds (with
    the scope each acts at) and the effective configuration of every health
    check - its title, whether it runs, its severity, its units and levels."""
    return get_manifest().describe()


@router.get("/availability")
def availability(store: Store = Depends(get_store_dep)):
    """Per cluster, per resource: collected / unavailable / forbidden / error /
    disabled - i.e. what each cluster can actually answer."""
    clusters = store.clusters()
    names = [c.name for c in clusters]
    # One round trip for every cluster's per-resource outcome.
    sections = store.section_across("resource_status", names) if names else {}
    totals = defaultdict(lambda: defaultdict(int))
    rows = []
    for c in clusters:
        resources = {}
        for r in sections.get(c.name, []):
            resources[r.key] = {"status": r.status, "count": r.count,
                                "duration_ms": r.duration_ms, "error": r.error}
            totals[r.key][r.status] += 1
        rows.append({"name": c.name, "reachable": c.reachable, "status": c.overall_status,
                     "resources": resources})
    return {
        "resources": [r["key"] for r in get_manifest().describe()["resources"]],
        "clusters": rows,
        "totals": {k: dict(v) for k, v in totals.items()},
    }
