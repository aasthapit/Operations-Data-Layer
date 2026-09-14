"""What the data layer collects, and what each cluster actually served."""
from collections import defaultdict

from fastapi import APIRouter, Depends

from ..manifest import get_manifest
from ..serialize import _iso
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
    disabled - i.e. what each cluster can actually answer, and how fresh that
    answer is.

    With tiers (`interval` in the manifest) a kind is not re-read every sweep,
    so each entry carries `collected_at`, `cached` (kept from an earlier sweep)
    and the kind's `interval_seconds`, plus what the last fetch cost: how long
    it took, how many objects and bytes it brought back, how long they took to
    parse.
    """
    manifest = get_manifest()
    intervals = {r["key"]: r["interval_seconds"] for r in manifest.describe()["resources"]}
    clusters = store.clusters()
    names = [c.name for c in clusters]
    # One round trip for every cluster's per-resource outcome.
    sections = store.section_across("resource_status", names) if names else {}
    totals = defaultdict(lambda: defaultdict(int))
    rows = []
    for c in clusters:
        resources = {}
        for r in sections.get(c.name, []):
            resources[r.key] = {
                "status": r.status, "count": r.count, "duration_ms": r.duration_ms,
                "error": r.error, "collected_at": r.collected_at, "cached": bool(r.cached),
                # from the manifest, not from the row: the tier in force now
                "interval_seconds": intervals.get(r.key, 0),
                **{f: r[f] for f in ("bytes", "objects", "parse_ms", "requests") if f in r},
            }
            totals[r.key][r.status] += 1
        rows.append({"name": c.name, "reachable": c.reachable, "status": c.overall_status,
                     "last_synced": _iso(c.last_synced), "resources": resources})
    return {
        "resources": [r["key"] for r in manifest.describe()["resources"]],
        "clusters": rows,
        "totals": {k: dict(v) for k, v in totals.items()},
    }
