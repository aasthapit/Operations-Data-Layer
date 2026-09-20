"""
Operating the data layer itself: trigger a sweep, see how sweeps went, and see
where a sweep spent its time.

The timing plane exists to answer one question with numbers instead of
opinion: *is the collector network-bound or CPU-bound?* ADR-0003 Finding 1
says a 900-cluster fleet pulls ~120 MB of Kubernetes JSON per cluster per
sweep and models the parsing cost, but a model is not a measurement. The
collector now measures every stage per cluster (`kube.ApiBundle.stats` for the
HTTP and decode halves, wall clocks around the rest) and writes them to the
cluster's summary row; `GET /api/collector/timings` turns that into one answer
for the whole fleet.

Read it as: `fetch_ms` is network plus API-server time, so it shrinks with
tiering, watches and metadata-only lists, not with a faster language.
`parse_ms`, `assemble_ms`, `health_ms` and `persist_ms` are CPU in Python -
they are what a Go collector would shrink. If the CPU share is small, a
rewrite buys little.

One subtlety the shapes here encode: `parse_ms` happens *inside* the fetch
phase (the response is decoded as it arrives, on the fetch worker's thread,
and the kinds of a cluster are fetched concurrently). So a cluster's wall
clock is fetch + assemble + health + persist, and `parse_ms` is how much of
that fetch window was Python burning CPU rather than waiting on a socket.
`share_percent` therefore covers the wall stages and sums to 100; `cpu_ms`
and `cpu_percent` count parsing and can exceed the fetch window when several
kinds are decoded at once - which is itself the signal that the collector is
CPU-bound.
"""
import logging
import math
import threading

from fastapi import APIRouter, Depends, HTTPException

from ..collector import runner
from ..serialize import _iso
from ..settings import settings
from ..store import Store
from .deps import get_store_dep

router = APIRouter(prefix="/api", tags=["admin"])

log = logging.getLogger("odl.api.admin")

NO_COLLECTORS = ("this instance does not collect (COLLECTOR_ENABLED=false) and no collector "
                 "is alive to take the request: start a collector (ODL_ROLE=worker) or run "
                 "this process with COLLECTOR_ENABLED=true")

# The stages of collecting one cluster, in the order they happen.
STAGES = ("fetch_ms", "parse_ms", "assemble_ms", "health_ms", "persist_ms")
# The stages that partition the cluster's wall clock. `parse_ms` is not one of
# them: it is measured inside the fetch phase (see the module docstring), so
# adding it here would count the same milliseconds twice.
WALL_STAGES = ("fetch_ms", "assemble_ms", "health_ms", "persist_ms")
# Everything that is CPU in the collector process: what a collector in another
# language would change. `fetch_ms` is not here - that is the network and the
# API server, and no language makes those faster.
CPU_STAGES = ("parse_ms", "assemble_ms", "health_ms", "persist_ms")
# Volume counters that go with the stages. Reported per cluster only when the
# collector recorded them, so a counter it does not keep reads as absent rather
# than as a confident zero.
VOLUMES = ("bytes", "objects", "requests", "kinds_fetched", "kinds_cached")


def queue_refresh(store: Store, full: bool = False, cluster: str | None = None) -> dict:
    """Hand a refresh to whoever is collecting, from a process that is not.

    The API and the collector can be separate pods, so this endpoint routinely
    runs where a sweep is impossible. Queueing is only an answer while somebody
    is listening, which is what the presence keys say; with nobody there the
    honest answer is 409 rather than an accepted request nothing acts on.
    """
    live = store.collectors()
    if not live:
        raise HTTPException(409, NO_COLLECTORS)
    store.request_refresh(full=full, cluster=cluster, origin=runner.instance_name())
    answer = {"accepted": True, "mode": "queued", "full": full, "collectors": len(live)}
    return {**answer, "cluster": cluster} if cluster else answer


def announce_refresh(store: Store, full: bool = False, cluster: str | None = None) -> None:
    """Pass a refresh this process is already running on to the other
    collectors. Best effort: the local sweep is the answer to the caller, and
    a store that cannot be written to is the tick's problem, not this request's."""
    try:
        store.request_refresh(full=full, cluster=cluster, origin=runner.instance_name())
    except Exception as e:  # noqa: BLE001
        log.debug("queueing the refresh for the other collectors failed: %s", e)


@router.post("/refresh")
def refresh(background: bool = True, full: bool = False,
            store: Store = Depends(get_store_dep)):
    """Trigger an on-demand collection sweep.

    By default the sweep collects what is due: kinds with an `interval` in the
    manifest are fetched only when their tier says so, and the rest of the
    document is kept from the last collection. `full=true` forces every enabled
    kind on every cluster, which is what to ask for after changing the manifest.

    A process that collects sweeps its own share of the fleet and queues the
    same request for the other collectors, which each skip the entry they
    published themselves. A process that does not collect can only queue it.
    """
    if not settings.collector_enabled:
        return queue_refresh(store, full=full)
    announce_refresh(store, full=full)
    if background:
        threading.Thread(target=runner.run_collection, args=("manual", full),
                         daemon=True).start()
        return {"accepted": True, "mode": "background", "full": full}
    return runner.run_collection("manual", full)


@router.get("/status")
def status(store: Store = Depends(get_store_dep)):
    last = runner.last_run()
    prog = runner.progress()
    return {"last_run": last and {
        "at": _iso(last["at"]), "ok": last["ok"], "trigger": last["trigger"],
        # What that sweep cost, per stage, summed over its clusters.
        "timings": _last_finished_run(store).get("timings")},
        "sweep": {**prog, "started_at": _iso(prog.get("started_at"))},
        # Who is collecting right now. Empty on a read-only API whose
        # collectors are all down, which is what makes a refusal to refresh
        # explainable rather than mysterious.
        "collectors": _collectors(store)}


def _collectors(store: Store) -> list[dict]:
    rows = store.collectors()
    return [{"instance": r.get("instance"), "role": r.get("role"),
             "hubs": r.get("hubs") or [], "shard": r.get("shard"),
             "version": r.get("version"), "started_at": _iso(r.get("started_at")),
             "at": _iso(r.get("at"))}
            for r in sorted(rows, key=lambda r: str(r.get("instance")))]


@router.get("/runs")
def runs(limit: int = 20, store: Store = Depends(get_store_dep)):
    return {"runs": [{
        "id": r.id,
        "trigger": r.trigger,
        "started_at": _iso(r.started_at),
        "finished_at": _iso(r.finished_at),
        "duration_ms": r.duration_ms,
        "hubs_total": r.hubs_total,
        "clusters_total": r.clusters_total,
        "clusters_ok": r.clusters_ok,
        "clusters_failed": r.clusters_failed,
        "error": r.error,
        # Per-stage aggregates the runner writes when the sweep finishes.
        "timings": r.timings or None,
    } for r in store.runs(limit)]}


# --------------------------------------------------------------------------- #
# collector timings
# --------------------------------------------------------------------------- #
def _num(value) -> float:
    """A stored counter as a number (a JSON store can hand back a string)."""
    if value is None or isinstance(value, bool):
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _percentile(values: list[float], q: float) -> float | None:
    """Nearest-rank percentile. With a handful of clusters the interpolating
    definitions disagree with each other; this one always names a real
    cluster's measurement, which is what an operator is looking for."""
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, math.ceil(q * len(ordered)) - 1)
    return round(ordered[index], 1)


def _cluster_timing(c) -> dict | None:
    """One cluster's row for the timing table, or None if it never reported."""
    timings = c.timings
    if not isinstance(timings, dict) or not timings:
        return None
    row = {"cluster": c.name, "hub": c.hub_name, "last_synced": _iso(c.last_synced),
           "collect_ms": c.collect_ms, "reachable": c.reachable}
    for stage in STAGES:
        row[stage] = round(_num(timings.get(stage)), 1)
    for volume in VOLUMES:
        if timings.get(volume) is not None:
            row[volume] = int(_num(timings[volume]))
    # `total_ms` is what the collector measured end to end when it recorded it;
    # otherwise the wall stages summed, which is the best we can say.
    total = timings.get("total_ms")
    row["total_ms"] = round(_num(total) if total is not None
                            else sum(row[s] for s in WALL_STAGES), 1)
    row["cpu_ms"] = round(sum(row[s] for s in CPU_STAGES), 1)
    return row


def _ratio(numerator: float, denominator: float) -> float | None:
    return round(100.0 * numerator / denominator, 1) if denominator else None


def _aggregate(rows: list[dict]) -> dict:
    """Fleet totals, percentiles and shares over the per-cluster rows."""
    fields = ("total_ms", "cpu_ms", *STAGES)
    totals = {f: round(sum(r[f] for r in rows), 1) for f in fields}
    # A volume no collector recorded stays out of the answer entirely.
    totals.update({v: sum(r[v] for r in rows if v in r)
                   for v in VOLUMES if any(v in r for r in rows)})
    grand = totals["total_ms"]
    return {
        "clusters": len(rows),
        "totals": totals,
        "p50": {f: _percentile([r[f] for r in rows], 0.50) for f in fields},
        "p95": {f: _percentile([r[f] for r in rows], 0.95) for f in fields},
        # How the fleet's wall clock divides between the stages: sums to 100.
        "share_percent": {f: _ratio(totals[f], grand) for f in WALL_STAGES},
        # What is CPU in Python, and how much of the fetch window is decoding.
        # Both can pass 100% of their denominator when kinds are fetched
        # concurrently: that is the CPU-bound signal, not an error.
        "cpu_percent": _ratio(totals["cpu_ms"], grand),
        "parse_percent_of_fetch": _ratio(totals["parse_ms"], totals["fetch_ms"]),
        "bytes_per_fetch_second": (round(totals["bytes"] / (totals["fetch_ms"] / 1000))
                                   if totals.get("bytes") and totals["fetch_ms"] else None),
        "objects_per_parse_second": (round(totals["objects"] / (totals["parse_ms"] / 1000))
                                     if totals.get("objects") and totals["parse_ms"] else None),
    }


def _last_finished_run(store: Store) -> dict:
    """The most recent sweep that completed (the newest entry may still be
    running, and an in-flight sweep has no aggregates yet)."""
    for r in store.runs(5):
        if r.finished_at:
            return {"id": r.id, "trigger": r.trigger, "finished_at": _iso(r.finished_at),
                    "duration_ms": r.duration_ms, "clusters_total": r.clusters_total,
                    "timings": r.timings or None}
    return {}


@router.get("/collector/timings")
def collector_timings(limit: int = 50, store: Store = Depends(get_store_dep)):
    """Where the collector's time goes, per cluster and fleet-wide.

    One call so that "is this network or CPU?" needs no correlation work:
    every cluster's stage breakdown sorted by total time descending (the
    slowest clusters are the ones worth looking at), the fleet sums and p50 /
    p95 per stage, and the last sweep's own aggregates. `limit` bounds the
    per-cluster list only - the aggregates always cover every cluster that
    reported.

    A cluster appears once the collector has written timings to its summary; a
    cluster collected by an older collector is counted in `clusters_total` and
    left out of the rows, so the numbers never mix measured with assumed.
    """
    clusters = store.clusters()
    rows = [row for row in (_cluster_timing(c) for c in clusters) if row]
    rows.sort(key=lambda r: r["total_ms"], reverse=True)
    fleet = _aggregate(rows)
    fleet["clusters_total"] = len(clusters)
    return {
        "limit": limit,
        "count": min(limit, len(rows)),
        "stages": list(STAGES),
        "cpu_stages": list(CPU_STAGES),
        "clusters": rows[:limit],
        "fleet": fleet,
        "last_run": _last_finished_run(store) or None,
    }
