"""
The sweep: discovery feeds targets, gathering feeds documents, and everything
lands in the store.

Discovery and gathering are the only parts that talk to a cluster, so they are
the two seams the tests replace; the rest of `run_collection` (health checks,
persistence, pruning, run bookkeeping) runs for real against fakeredis.
"""
import copy

import fakeredis
import pytest

from app.collector import runner
from app.collector.collect import unreachable
from app.store import set_store
from app.store.redis_store import RedisStore

EAST, WEST = "ocp-east-1", "ocp-west-1"
HUB = "hub-east"


def _document(name, version="4.16.7"):
    """A minimal but complete collector document."""
    return {
        "name": name, "region": "us-east-1", "datacenter": "iad1", "environment": "prod",
        "managed_available": True, "reachable": True, "error": None, "collect_ms": 42,
        "version": version, "resource_status": {},
        "operators": [{"name": "etcd", "version": version, "available": True,
                       "progressing": False, "degraded": False, "critical": False,
                       "message": ""}],
        "nodes": [], "namespaces": [], "workloads": [], "workload_images": [],
        "workload_refs": [], "pod_issues": [], "resources": [],
        "capacity": {}, "nodes_total": 0, "nodes_ready": 0,
    }


@pytest.fixture
def store():
    store = RedisStore(fakeredis.FakeRedis(), prefix="odl", snapshot_retention=10)
    set_store(store)
    yield store
    set_store(None)


@pytest.fixture
def fleet(monkeypatch, store):
    """Discovery and gathering under test control; returns the knobs."""
    state = {"clusters": [EAST, WEST], "hub_reachable": True,
             "documents": {EAST: _document(EAST), WEST: _document(WEST, "4.15.9")},
             "ok": {EAST: True, WEST: True}}

    def fake_discover(st):
        st.upsert_hub(HUB, region="us-east-1", reachable=state["hub_reachable"],
                      managed_count=len(state["clusters"]), last_synced=runner.utcnow())
        targets = [runner.Target(HUB, {"name": name}, lambda: None)
                   for name in state["clusters"]]
        return targets, 1

    def fake_gather(target, manifest):
        name = target.meta["name"]
        return target, copy.deepcopy(state["documents"][name]), state["ok"][name]

    monkeypatch.setattr(runner, "_discover", fake_discover)
    monkeypatch.setattr(runner, "_gather", fake_gather)
    return state


def test_sweep_persists_every_cluster_and_records_the_run(fleet, store):
    result = runner.run_collection("manual")

    assert result["ok"] is True and result["clusters"] == 2
    assert result["clusters_ok"] == 2 and result["clusters_failed"] == 0
    assert result["hubs"] == 1 and result["duration_ms"] >= 0

    assert store.cluster_names() == [EAST, WEST]
    east = store.get_cluster(EAST)
    assert east.hub_name == HUB and east.ocp_version == "4.16.7" and east.reachable is True
    assert east.overall_status in ("healthy", "warning", "critical")
    assert len(store.snapshots(EAST)) == 1
    assert [c.name for c in store.clusters(version="4.15.9")] == [WEST]
    assert set(store.operator_index("etcd")) == {EAST, WEST}
    assert store.operator_names() == ["etcd"]         # finalize_sweep left the live entry

    runs = store.runs()
    assert len(runs) == 1 and runs[0].trigger == "manual"
    assert runs[0].clusters_total == 2 and runs[0].clusters_ok == 2
    assert runs[0].hubs_total == 1 and runs[0].finished_at is not None
    assert store.last_run()["ok"] is True and store.last_run()["trigger"] == "manual"
    assert runner.last_run()["ok"] is True and runner.last_run()["trigger"] == "manual"


def test_sweep_prunes_clusters_that_vanished_from_a_reachable_hub(fleet, store):
    runner.run_collection("scheduled")
    assert store.cluster_names() == [EAST, WEST]

    fleet["clusters"] = [EAST]
    runner.run_collection("scheduled")

    assert store.cluster_names() == [EAST]
    assert store.get_cluster(WEST) is None
    assert set(store.operator_index("etcd")) == {EAST}      # its index members went too
    assert len(store.runs()) == 2


def test_clusters_under_an_unreachable_hub_are_kept(fleet, store):
    runner.run_collection("scheduled")

    fleet["clusters"] = []
    fleet["hub_reachable"] = False
    runner.run_collection("scheduled")

    assert store.cluster_names() == [EAST, WEST]


def test_unreachable_cluster_is_persisted_and_counted_as_failed(fleet, store):
    fleet["documents"][WEST] = unreachable({"name": WEST}, "connect: timed out")
    fleet["ok"][WEST] = False

    result = runner.run_collection("startup")

    assert result["clusters_ok"] == 1 and result["clusters_failed"] == 1
    west = store.get_cluster(WEST)
    assert west.reachable is False and west.last_error == "connect: timed out"
    assert set(store.operator_index("etcd")) == {EAST}
    assert store.runs()[0].clusters_failed == 1


def test_a_second_sweep_is_skipped_while_one_runs(fleet, store):
    assert runner._lock.acquire(blocking=False)
    try:
        assert runner.run_collection("manual") == {
            "skipped": True, "reason": "a collection is already running"}
    finally:
        runner._lock.release()


def test_refresh_cluster_is_single_flight(fleet, store):
    assert store.try_lock(EAST, 60_000) is True
    assert runner.refresh_cluster(EAST) == {
        "ok": False, "skipped": True, "reason": "refresh already running"}
    assert store.get_cluster(EAST) is None            # nothing was written
    store.unlock(EAST)

    result = runner.refresh_cluster(EAST)
    assert result["ok"] is True and result["cluster"] == EAST
    assert result["collect_ms"] >= 0
    assert store.cluster_names() == [EAST]            # only the refreshed cluster
    assert store.get_cluster(EAST).ocp_version == "4.16.7"
    assert store.try_lock(EAST, 1000) is True         # the lock was released


def test_refresh_cluster_releases_the_lock_when_persisting_fails(monkeypatch, fleet, store):
    def boom(*args, **kwargs):
        raise RuntimeError("redis is down")

    monkeypatch.setattr(runner, "_persist", boom)
    with pytest.raises(RuntimeError):
        runner.refresh_cluster(EAST)
    assert store.try_lock(EAST, 1000) is True


def test_refresh_cluster_rejects_an_unknown_cluster(fleet, store):
    assert runner.refresh_cluster("ocp-nowhere") == {"ok": False, "error": "unknown cluster"}


# --------------------------------------------------------------------------- #
# ACM hubs reached by api_url + auth; managed clusters by secret or shared auth
# --------------------------------------------------------------------------- #
def _managed(name, url=None):
    mc = {"metadata": {"name": name, "labels": {"region": "us-east-1"}},
          "status": {"conditions": [{"type": "ManagedClusterConditionAvailable", "status": "True"}]}}
    if url:
        mc["spec"] = {"managedClusterClientConfigs": [{"url": url, "caBundle": ""}]}
    return mc


def test_hub_by_api_url_reaches_managed_clusters_by_secret_or_shared_auth(store, monkeypatch):
    from app.config_loader import FleetConfig, HubConfig

    hub = HubConfig(name="acm-east", region="us-east-1", api_url="https://api.acm-east:6443",
                    auth={"type": "password", "username": "svc", "password": "pw"})
    monkeypatch.setattr(runner, "load_config", lambda: FleetConfig({}, [hub], []))
    calls = []
    monkeypatch.setattr(runner, "resolve_bearer_token",
                        lambda url, auth, verify=True: calls.append(("token", url)) or "tok")
    monkeypatch.setattr(runner.kube, "bundle_from_endpoint",
                        lambda url, token, verify=True, ca_cert=None: ("endpoint", url))
    monkeypatch.setattr(runner.kube, "list_managedclusters",
                        lambda hb: [_managed("hive-1"), _managed("imported-1", "https://api.imported-1:6443")])

    def read_secret(hb, ns, name):
        if ns == "hive-1" and name == "hive-1-admin-kubeconfig":
            return "kubeconfig-of-hive-1"
        raise KeyError(f"{ns}/{name} not found")
    monkeypatch.setattr(runner.kube, "read_kubeconfig_secret", read_secret)
    monkeypatch.setattr(runner.kube, "bundle_from_kubeconfig_str", lambda kc: ("secret", kc))

    targets, hubs_total = runner._discover(store)
    assert hubs_total == 1 and [t.meta["name"] for t in targets] == ["hive-1", "imported-1"]
    assert calls == [("token", "https://api.acm-east:6443")]        # the hub login
    assert targets[0].connect() == ("secret", "kubeconfig-of-hive-1")
    assert targets[1].connect() == ("endpoint", "https://api.imported-1:6443")
    assert ("token", "https://api.imported-1:6443") in calls        # shared auth for the import
    assert store.hubs()[0].reachable is True and store.hubs()[0].managed_count == 2


def test_managed_cluster_without_secret_or_url_fails_clearly(store, monkeypatch):
    from app.config_loader import FleetConfig, HubConfig

    hub = HubConfig(name="hub", kubeconfig="/x.kubeconfig")
    monkeypatch.setattr(runner, "load_config", lambda: FleetConfig({}, [hub], []))
    monkeypatch.setattr(runner.kube, "bundle_from_file", lambda path: "hub-bundle")
    monkeypatch.setattr(runner.kube, "list_managedclusters", lambda hb: [_managed("orphan")])
    monkeypatch.setattr(runner.kube, "read_kubeconfig_secret",
                        lambda hb, ns, name: (_ for _ in ()).throw(KeyError(name)))

    (target,), _ = runner._discover(store)
    with pytest.raises(RuntimeError, match="no kubeconfig secret on hub hub"):
        target.connect()
