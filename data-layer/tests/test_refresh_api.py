"""
What the refresh endpoints do on each half of a split deployment.

The same two routes mean different things depending on whether the process
they land on collects. Where one does, they sweep and tell the other
collectors. Where one does not - an API pod beside collector pods - they can
only queue, and only while somebody is listening: with no collector alive the
request is refused rather than accepted into a void.
"""
import fakeredis
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import admin, clusters
from app.collector import coordination, runner
from app.settings import settings
from app.store import set_store
from app.store.redis_store import RedisStore

EAST = "ocp-east-1"


def _document(name):
    return {"name": name, "region": "us-east-1", "environment": "prod", "version": "4.16.7",
            "reachable": True, "capacity": {}, "resource_status": {},
            "nodes_total": 0, "nodes_ready": 0}


@pytest.fixture
def store():
    st = RedisStore(fakeredis.FakeRedis(), prefix="odl", snapshot_retention=10)
    st.upsert_hub("hub-east", reachable=True)
    st.persist_cluster("hub-east", _document(EAST), [], "healthy", 100,
                       {"passed": 1, "warned": 0, "failed": 0})
    set_store(st)
    yield st
    set_store(None)


@pytest.fixture
def client(store):
    app = FastAPI()
    app.include_router(admin.router)
    app.include_router(clusters.router)
    return TestClient(app)


@pytest.fixture(autouse=True)
def no_real_sweeps(monkeypatch):
    """The endpoints under test decide what to run, not how a sweep goes."""
    ran = []
    monkeypatch.setattr(runner, "run_collection",
                        lambda trigger="manual", full=False: ran.append((trigger, full)) or {})
    monkeypatch.setattr(runner, "refresh_cluster",
                        lambda name, full=False: {"ok": True, "cluster": name})
    monkeypatch.setattr(settings, "collect_hubs", ())
    monkeypatch.setattr(settings, "collect_shard", "")
    return ran


def _queued(store, start="0-0"):
    return store.refresh_requests(start)


# --------------------------------------------------------------------------- #
# a process that collects
# --------------------------------------------------------------------------- #
def test_a_collecting_process_sweeps_and_tells_the_others(client, store, monkeypatch):
    monkeypatch.setattr(settings, "collector_enabled", True)
    answer = client.post("/api/refresh?full=true")
    assert answer.status_code == 200
    assert answer.json() == {"accepted": True, "mode": "background", "full": True}

    queued = _queued(store)
    assert len(queued) == 1
    assert queued[0]["full"] is True and queued[0]["cluster"] is None
    # Its own entry, so its own consumer will skip it rather than sweep twice.
    assert queued[0]["origin"] == runner.instance_name()


def test_a_collecting_process_refreshes_one_cluster_synchronously(client, monkeypatch):
    monkeypatch.setattr(settings, "collector_enabled", True)
    answer = client.post(f"/api/clusters/{EAST}/refresh")
    assert answer.status_code == 200 and answer.json()["cluster"] == EAST


def test_a_store_that_cannot_be_written_does_not_fail_the_sweep(client, store, monkeypatch):
    monkeypatch.setattr(settings, "collector_enabled", True)
    monkeypatch.setattr(store, "request_refresh", lambda **_k: (_ for _ in ()).throw(
        ConnectionError("redis is gone")))
    assert client.post("/api/refresh").status_code == 200


# --------------------------------------------------------------------------- #
# a process that does not
# --------------------------------------------------------------------------- #
def test_without_a_collector_a_refresh_is_refused(client, store, monkeypatch):
    monkeypatch.setattr(settings, "collector_enabled", False)
    answer = client.post("/api/refresh")
    assert answer.status_code == 409
    assert "no collector" in answer.json()["detail"]
    assert _queued(store) == []

    cluster = client.post(f"/api/clusters/{EAST}/refresh")
    assert cluster.status_code == 409


def test_with_a_collector_a_refresh_is_queued(client, store, monkeypatch):
    monkeypatch.setattr(settings, "collector_enabled", False)
    coordination.publish_presence(store, role="worker")

    answer = client.post("/api/refresh?full=true")
    assert answer.status_code == 200
    assert answer.json() == {"accepted": True, "mode": "queued", "full": True, "collectors": 1}

    queued = _queued(store)
    assert len(queued) == 1 and queued[0]["full"] is True and queued[0]["cluster"] is None


def test_a_queued_cluster_refresh_is_accepted_not_answered(client, store, monkeypatch):
    monkeypatch.setattr(settings, "collector_enabled", False)
    coordination.publish_presence(store, role="worker")

    answer = client.post(f"/api/clusters/{EAST}/refresh")
    assert answer.status_code == 202
    assert answer.json() == {"accepted": True, "mode": "queued", "full": False,
                             "collectors": 1, "cluster": EAST}
    assert [r["cluster"] for r in _queued(store)] == [EAST]


def test_an_unknown_cluster_is_still_a_404(client, store, monkeypatch):
    monkeypatch.setattr(settings, "collector_enabled", False)
    coordination.publish_presence(store, role="worker")
    answer = client.post("/api/clusters/ocp-ghost-9/refresh")
    assert answer.status_code == 404
    assert _queued(store) == []


# --------------------------------------------------------------------------- #
# who is collecting
# --------------------------------------------------------------------------- #
def test_status_lists_the_live_collectors(client, store, monkeypatch):
    assert client.get("/api/status").json()["collectors"] == []

    monkeypatch.setattr(settings, "collect_hubs", ("hub-east",))
    coordination.publish_presence(store, role="worker")
    listed = client.get("/api/status").json()["collectors"]
    assert len(listed) == 1
    assert listed[0]["role"] == "worker" and listed[0]["hubs"] == ["hub-east"]
    assert listed[0]["instance"] == runner.instance_name() and listed[0]["at"]

    coordination.clear_presence(store)
    assert client.get("/api/status").json()["collectors"] == []
