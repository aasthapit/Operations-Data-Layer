"""
Collector presence and the refresh queue: how an API pod that cannot sweep
reaches the collector pods that can.

Everything runs against fakeredis through the real store, so the queue under
test is the Redis stream the collectors really read. Collection itself is the
one seam replaced: `coordination._collect` records what it was asked to run
instead of spawning a sweep.
"""
import time

import fakeredis
import pytest

from app.collector import coordination, runner
from app.settings import settings
from app.store import set_store
from app.store.redis_store import RedisStore

EAST, WEST = "ocp-east-1", "ocp-west-1"


def _document(name):
    return {"name": name, "region": "us-east-1", "environment": "prod", "version": "4.16.7",
            "reachable": True, "capacity": {}, "resource_status": {},
            "nodes_total": 0, "nodes_ready": 0}


@pytest.fixture
def store():
    st = RedisStore(fakeredis.FakeRedis(), prefix="odl", snapshot_retention=10)
    set_store(st)
    yield st
    set_store(None)


@pytest.fixture
def fleet(store):
    """Two clusters on two hubs, the way a sweep would have left them."""
    for hub, name in (("hub-east", EAST), ("hub-west", WEST)):
        store.upsert_hub(hub, reachable=True)
        store.persist_cluster(hub, _document(name), [], "healthy", 100,
                              {"passed": 1, "warned": 0, "failed": 0})
    return store


@pytest.fixture
def collected(monkeypatch):
    """What the consumer decided to collect, instead of collecting it."""
    calls = []

    def record(fn, what):
        calls.append(what)

    monkeypatch.setattr(coordination, "_collect", record)
    return calls


@pytest.fixture(autouse=True)
def whole_fleet(monkeypatch):
    """Default: this instance owns every hub and is not sharded."""
    monkeypatch.setattr(settings, "collect_hubs", ())
    monkeypatch.setattr(settings, "collect_shard", "")


# --------------------------------------------------------------------------- #
# the queue itself
# --------------------------------------------------------------------------- #
def test_requests_come_back_in_order_with_their_fields(store):
    start = store.refresh_cursor()
    store.request_refresh(full=False, cluster=None, origin="api-1")
    store.request_refresh(full=True, cluster=EAST, origin="api-2")

    rows = store.refresh_requests(start)
    assert [(r["full"], r["cluster"], r["origin"]) for r in rows] == [
        (False, None, "api-1"), (True, EAST, "api-2")]
    assert rows[0]["at"] is not None
    # The cursor is exclusive: reading again from the last id yields nothing.
    assert store.refresh_requests(rows[-1]["id"]) == []


def test_a_consumer_starts_from_now_and_never_replays(store, collected):
    store.request_refresh(origin="somebody-else")        # before this consumer existed
    consumer = coordination.RefreshConsumer(store, instance="worker-1")
    assert consumer.consume(store) == 0 and collected == []

    store.request_refresh(origin="somebody-else")
    assert consumer.consume(store) == 1 and collected == ["sweep"]

    # A restart is a new consumer, and it starts from now all over again.
    store.request_refresh(origin="somebody-else")
    restarted = coordination.RefreshConsumer(store, instance="worker-1")
    assert restarted.consume(store) == 0


def test_an_empty_queue_has_a_usable_cursor(store):
    assert store.refresh_cursor() == "0-0"
    assert store.refresh_requests("0-0") == []


def test_the_queue_is_capped(store):
    for _ in range(260):
        store.request_refresh(origin="api-1")
    # MAXLEN ~ trims on whole stream nodes, so the length drifts a little above
    # the cap; what matters is that it stops growing.
    assert store.r.xlen(store.keys.refresh) < 500


# --------------------------------------------------------------------------- #
# what a consumer does with it
# --------------------------------------------------------------------------- #
def test_a_consumer_skips_what_it_published_itself(store, collected):
    consumer = coordination.RefreshConsumer(store, instance="worker-1")
    store.request_refresh(origin="worker-1")
    assert consumer.consume(store) == 0 and collected == []


def test_the_api_beside_a_collector_in_one_pod_is_not_the_collector(store, collected, monkeypatch):
    """Containers of a pod share a hostname and both run as PID 1. Found by
    running the real pod: with host:pid alone the read-only API and the
    collector had one name, and the collector threw away every refresh the
    API queued for it as "its own"."""
    monkeypatch.setattr(runner.socket, "gethostname", lambda: "odl-pod")
    monkeypatch.setattr(runner.os, "getpid", lambda: 1)
    monkeypatch.setattr(settings, "role", "worker")
    consumer = coordination.RefreshConsumer(store)
    monkeypatch.setattr(settings, "role", "api")
    assert runner.instance_name() != consumer.instance
    store.request_refresh(origin=runner.instance_name())
    assert consumer.consume(store) == 1 and collected == ["sweep"]


def test_several_fleet_requests_in_one_tick_become_one_sweep(store, collected):
    consumer = coordination.RefreshConsumer(store, instance="worker-1")
    store.request_refresh(full=False, origin="api-1")
    store.request_refresh(full=False, origin="api-2")
    store.request_refresh(full=True, origin="api-3")
    # Three requests answered, one sweep run, and it is full because one of
    # them asked for full.
    assert consumer.consume(store) == 3
    assert collected == ["sweep"]


def test_a_cluster_request_is_taken_by_the_collector_that_owns_it(fleet, collected, monkeypatch):
    consumer = coordination.RefreshConsumer(fleet, instance="worker-east")
    monkeypatch.setattr(settings, "collect_hubs", ("hub-east",))

    fleet.request_refresh(cluster=EAST, origin="api-1")
    fleet.request_refresh(cluster=WEST, origin="api-1")          # another hub's cluster
    fleet.request_refresh(cluster="ocp-ghost-9", origin="api-1")  # never collected
    assert consumer.consume(fleet) == 1
    assert collected == [EAST]


def test_a_cluster_request_outside_this_shard_is_left_to_its_shard(fleet, collected, monkeypatch):
    consumer = coordination.RefreshConsumer(fleet, instance="worker-1")
    shard = runner.in_shard(EAST, (0, 2)) and "0/2" or "1/2"
    monkeypatch.setattr(settings, "collect_shard", shard)
    fleet.request_refresh(cluster=EAST, origin="api-1")
    assert consumer.consume(fleet) == 1 and collected == [EAST]

    other = "1/2" if shard == "0/2" else "0/2"
    monkeypatch.setattr(settings, "collect_shard", other)
    fleet.request_refresh(cluster=EAST, origin="api-1")
    assert consumer.consume(fleet) == 0


def test_a_store_that_is_down_does_not_take_the_loop_with_it(store, collected, monkeypatch):
    consumer = coordination.RefreshConsumer(store, instance="worker-1")

    def boom(*_a, **_k):
        raise ConnectionError("redis is gone")

    monkeypatch.setattr(store, "refresh_requests", boom)
    assert consumer.consume(store) == 0 and collected == []


# --------------------------------------------------------------------------- #
# presence
# --------------------------------------------------------------------------- #
def test_presence_says_who_is_collecting_and_expires(store, monkeypatch):
    monkeypatch.setattr(settings, "collect_hubs", ("hub-east",))
    monkeypatch.setattr(settings, "role", "worker")
    assert store.collectors() == []

    coordination.publish_presence(store)
    live = store.collectors()
    assert len(live) == 1
    entry = live[0]
    assert entry["instance"] == runner.instance_name()
    assert entry["role"] == "worker" and entry["hubs"] == ["hub-east"]
    assert entry["version"] and entry["started_at"] and entry["at"]

    ttl = store.r.ttl(store.keys.collector(runner.instance_name()))
    assert 0 < ttl <= coordination.presence_ttl()
    assert coordination.presence_ttl() >= 3 * settings.worker_tick_seconds

    coordination.clear_presence(store)
    assert store.collectors() == []


def test_presence_is_republished_with_a_fresh_ttl(store):
    coordination.publish_presence(store)
    first = store.r.ttl(store.keys.collector(runner.instance_name()))
    time.sleep(1.1)
    assert store.r.ttl(store.keys.collector(runner.instance_name())) < first
    coordination.publish_presence(store)
    assert store.r.ttl(store.keys.collector(runner.instance_name())) >= first - 1


def test_a_tick_publishes_presence_and_drains_the_queue(store, collected):
    consumer = coordination.RefreshConsumer(store, instance="worker-1")
    store.request_refresh(origin="api-1")
    coordination.tick(store, consumer)
    assert len(store.collectors()) == 1
    assert collected == ["sweep"]
