"""
The collector timing plane: /api/collector/timings, and the timings that ride
along on /api/runs and /api/status.

Built the way tests/test_api.py builds its fixture - a real store over
fake-Redis, written through `persist_cluster` and then `update_summary` the
way the runner writes timings after a cluster is persisted - so what the
endpoint returns is what a sweep would actually have left behind, not a
hand-made dict.

The numbers below are chosen to make the interesting relations visible:
ocp-east-1 is network-bound (a long fetch, little CPU), ocp-west-1 is
CPU-bound (a short fetch, expensive parse and assemble), and ocp-quiet-1 was
collected by a collector that measured nothing, so it must be counted but not
averaged in.
"""
from datetime import UTC, datetime

import fakeredis
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import store as store_module
from app.api import admin, clusters
from app.store.redis_store import RedisStore

EAST_TIMINGS = {
    "fetch_ms": 8000, "parse_ms": 400, "assemble_ms": 600, "health_ms": 50,
    "persist_ms": 950, "bytes": 120_000_000, "objects": 20_000, "requests": 60,
    "kinds_fetched": 24, "kinds_cached": 6,
}
WEST_TIMINGS = {
    "fetch_ms": 1000, "parse_ms": 900, "assemble_ms": 2400, "health_ms": 100,
    "persist_ms": 1500, "bytes": 40_000_000, "objects": 9_000, "requests": 18,
    "kinds_fetched": 30, "kinds_cached": 0,
}


def _document(name, **fields):
    """The little a cluster document needs to be persisted; the sections are
    empty because this test is about the summary's timings, not the inventory."""
    return {"name": name, "region": "us-east-1", "environment": "prod",
            "version": "4.16.7", "nodes_total": 3, "nodes_ready": 3,
            "capacity": {}, "resource_status": {}, "reachable": True, **fields}


def _persist(store, hub, name, collect_ms=None, timings=None, **fields):
    store.persist_cluster(hub, _document(name, collect_ms=collect_ms, **fields), [],
                          "healthy", 100, {"passed": 1, "warned": 0, "failed": 0})
    if timings is not None:
        # exactly what runner._persist does once the write has landed
        store.update_summary(name, timings=timings)


@pytest.fixture(scope="module")
def store():
    st = RedisStore(fakeredis.FakeRedis())
    st.upsert_hub("hub-east", region="us-east-1", managed_count=2, reachable=True,
                  last_synced=datetime.now(UTC))
    run_id = st.begin_run("test")
    _persist(st, "hub-east", "ocp-east-1", collect_ms=9200, timings=EAST_TIMINGS)
    _persist(st, "hub-east", "ocp-west-1", collect_ms=4900, timings=WEST_TIMINGS)
    _persist(st, "hub-east", "ocp-quiet-1", collect_ms=1000)       # never measured
    st.finish_run(run_id, duration_ms=15_000, hubs_total=1, clusters_total=3,
                  clusters_ok=3, clusters_failed=0, error=None,
                  timings={"clusters": 2,
                           "fetch_ms": {"sum": 9000, "p95": 8000},
                           "assemble_ms": {"sum": 3000, "p95": 2400},
                           "health_ms": {"sum": 150, "p95": 100},
                           "persist_ms": {"sum": 2450, "p95": 1500},
                           "parse_ms": 1300, "bytes": 160_000_000, "objects": 29_000,
                           "kinds_fetched": 54, "kinds_cached": 6})
    st.finalize_sweep()
    return st


@pytest.fixture()
def client(store):
    app = FastAPI()
    for module in (clusters, admin):
        app.include_router(module.router)
    store_module.set_store(store)
    try:
        yield TestClient(app)
    finally:
        store_module.set_store(None)


def _get(client, path, **params):
    res = client.get(path, params=params)
    assert res.status_code == 200, f"{path} -> {res.status_code} {res.text}"
    return res.json()


# --------------------------------------------------------------------------- #
# per cluster
# --------------------------------------------------------------------------- #
def test_timings_list_the_slowest_clusters_first_with_every_stage(client):
    d = _get(client, "/api/collector/timings")

    assert [c["cluster"] for c in d["clusters"]] == ["ocp-east-1", "ocp-west-1"]
    east = d["clusters"][0]
    assert east["hub"] == "hub-east" and east["collect_ms"] == 9200
    assert east["fetch_ms"] == 8000 and east["parse_ms"] == 400
    assert east["assemble_ms"] == 600 and east["health_ms"] == 50 and east["persist_ms"] == 950
    # the wall clock is the stages that do not overlap: parse happens inside fetch
    assert east["total_ms"] == 8000 + 600 + 50 + 950
    # and the CPU half is what a collector in another language would attack
    assert east["cpu_ms"] == 400 + 600 + 50 + 950
    assert east["bytes"] == 120_000_000 and east["objects"] == 20_000
    assert east["kinds_fetched"] == 24 and east["kinds_cached"] == 6
    assert east["requests"] == 60


def test_a_cluster_that_reported_nothing_is_counted_but_not_averaged(client):
    d = _get(client, "/api/collector/timings")
    assert [c["cluster"] for c in d["clusters"]] == ["ocp-east-1", "ocp-west-1"]
    assert d["fleet"]["clusters"] == 2 and d["fleet"]["clusters_total"] == 3


def test_limit_bounds_the_rows_not_the_aggregates(client):
    d = _get(client, "/api/collector/timings", limit=1)
    assert d["limit"] == 1 and d["count"] == 1
    assert [c["cluster"] for c in d["clusters"]] == ["ocp-east-1"]
    # the fleet answer still covers both measured clusters
    assert d["fleet"]["clusters"] == 2
    assert d["fleet"]["totals"]["fetch_ms"] == 9000


# --------------------------------------------------------------------------- #
# fleet aggregates
# --------------------------------------------------------------------------- #
def test_fleet_aggregates_sum_and_rank_every_stage(client):
    fleet = _get(client, "/api/collector/timings")["fleet"]

    assert fleet["totals"]["fetch_ms"] == 9000
    assert fleet["totals"]["parse_ms"] == 1300
    assert fleet["totals"]["assemble_ms"] == 3000
    assert fleet["totals"]["persist_ms"] == 2450
    assert fleet["totals"]["bytes"] == 160_000_000
    assert fleet["totals"]["objects"] == 29_000
    assert fleet["totals"]["kinds_fetched"] == 54 and fleet["totals"]["kinds_cached"] == 6
    # total is the two clusters' wall clocks; cpu_ms includes the parsing
    assert fleet["totals"]["total_ms"] == 9600 + 5000
    assert fleet["totals"]["cpu_ms"] == 2000 + 4900

    # nearest rank over two clusters: p50 is the lower, p95 the higher
    assert fleet["p50"]["fetch_ms"] == 1000 and fleet["p95"]["fetch_ms"] == 8000
    assert fleet["p50"]["total_ms"] == 5000 and fleet["p95"]["total_ms"] == 9600


def test_fleet_shares_answer_network_or_cpu_in_one_line(client):
    fleet = _get(client, "/api/collector/timings")["fleet"]

    share = fleet["share_percent"]
    assert set(share) == {"fetch_ms", "assemble_ms", "health_ms", "persist_ms"}
    # a partition of the wall clock, to within the rounding of four shares
    assert abs(sum(share.values()) - 100.0) <= 0.2
    assert share["fetch_ms"] == round(100 * 9000 / 14600, 1)
    # 6900 ms of CPU against 14600 ms of wall clock
    assert fleet["cpu_percent"] == round(100 * 6900 / 14600, 1)
    # and how much of the fetch window was decoding rather than waiting
    assert fleet["parse_percent_of_fetch"] == round(100 * 1300 / 9000, 1)
    assert fleet["bytes_per_fetch_second"] == round(160_000_000 / 9.0)
    assert fleet["objects_per_parse_second"] == round(29_000 / 1.3)


def test_the_endpoint_carries_the_last_sweep_so_one_call_is_enough(client):
    d = _get(client, "/api/collector/timings")
    last = d["last_run"]
    assert last["duration_ms"] == 15_000 and last["clusters_total"] == 3
    assert last["timings"]["fetch_ms"] == {"sum": 9000, "p95": 8000}
    assert d["stages"] == ["fetch_ms", "parse_ms", "assemble_ms", "health_ms", "persist_ms"]
    assert d["cpu_stages"] == ["parse_ms", "assemble_ms", "health_ms", "persist_ms"]


def test_an_unmeasured_fleet_answers_with_empty_aggregates_not_an_error():
    st = RedisStore(fakeredis.FakeRedis())
    _persist(st, "hub-east", "ocp-old-1", collect_ms=1000)
    app = FastAPI()
    app.include_router(admin.router)
    store_module.set_store(st)
    try:
        d = TestClient(app).get("/api/collector/timings").json()
    finally:
        store_module.set_store(None)
    assert d["clusters"] == [] and d["count"] == 0
    assert d["fleet"]["clusters"] == 0 and d["fleet"]["clusters_total"] == 1
    assert d["fleet"]["totals"]["total_ms"] == 0
    assert d["fleet"]["p95"]["fetch_ms"] is None
    assert d["fleet"]["cpu_percent"] is None and d["last_run"] is None


# --------------------------------------------------------------------------- #
# the timings that ride along on the existing endpoints
# --------------------------------------------------------------------------- #
def test_runs_and_status_carry_the_sweep_aggregates(client):
    run = _get(client, "/api/runs")["runs"][0]
    assert run["duration_ms"] == 15_000
    assert run["timings"]["clusters"] == 2
    assert run["timings"]["assemble_ms"]["sum"] == 3000
    assert run["timings"]["bytes"] == 160_000_000

    status = _get(client, "/api/status")["last_run"]
    assert status["trigger"] == "test"
    assert status["timings"]["persist_ms"]["p95"] == 1500


def test_cluster_summary_and_detail_expose_the_clusters_own_timings(client):
    listed = {c["name"]: c for c in _get(client, "/api/clusters")["clusters"]}
    assert listed["ocp-east-1"]["timings"] == EAST_TIMINGS
    assert listed["ocp-quiet-1"]["timings"] is None

    detail = _get(client, "/api/clusters/ocp-west-1")
    assert detail["timings"] == WEST_TIMINGS
