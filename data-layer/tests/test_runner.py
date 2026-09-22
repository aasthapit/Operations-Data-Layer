"""
The sweep: discovery feeds targets, gathering feeds documents, and everything
lands in the store.

Discovery and gathering are the only parts that talk to a cluster, so they are
the two seams the tests replace; the rest of `run_collection` (health checks,
persistence, pruning, run bookkeeping) runs for real against fakeredis.
"""
import copy
import pathlib
from datetime import datetime, timedelta

import fakeredis
import pytest

from app.collector import runner
from app.collector.collect import unreachable
from app.store import set_store
from app.store.redis_store import RedisStore

EAST, WEST = "ocp-east-1", "ocp-west-1"
HUB = "hub-east"


def _parse(iso: str) -> datetime:
    return datetime.fromisoformat(iso)


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
             "ok": {EAST: True, WEST: True}, "gathered": []}

    def fake_discover(st):
        st.upsert_hub(HUB, region="us-east-1", reachable=state["hub_reachable"],
                      managed_count=len(state["clusters"]), last_synced=runner.utcnow())
        targets = [runner.Target(HUB, {"name": name}, lambda: None)
                   for name in state["clusters"]]
        return targets, 1

    def fake_gather(target, manifest, previous=None, full=False):
        name = target.meta["name"]
        state["gathered"].append({"cluster": name, "previous": previous, "full": full})
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


def test_login_verifies_against_the_configured_ca(store, monkeypatch):
    """A corporate CA must reach the OAuth login too, not only the API client."""
    from app.config_loader import FleetConfig, HubConfig

    hub = HubConfig(name="acm", api_url="https://api.acm:6443", ca_cert="/etc/odl/corp-ca.crt",
                    auth={"type": "password", "username": "svc", "password": "pw"})
    monkeypatch.setattr(runner, "load_config", lambda: FleetConfig({}, [hub], []))
    seen = {}
    monkeypatch.setattr(runner, "resolve_bearer_token",
                        lambda url, auth, verify=True: seen.setdefault(url, verify) and "tok")
    monkeypatch.setattr(
        runner.kube, "bundle_from_endpoint",
        lambda url, token, verify=True, ca_cert=None: seen.setdefault("client", (verify, ca_cert)))
    monkeypatch.setattr(runner.kube, "list_managedclusters", lambda hb: [])

    runner._discover(store)
    assert seen["https://api.acm:6443"] == "/etc/odl/corp-ca.crt"
    assert seen["client"] == (True, "/etc/odl/corp-ca.crt")
    assert runner._tls_verify(True, "/etc/odl/corp-ca.crt") is False
    assert runner._tls_verify(False, None) is True


def test_managed_api_url_prefers_acm_then_template_then_console_claim():
    from app.config_loader import HubConfig

    plain = HubConfig(name="h", api_url="https://h")
    templated = HubConfig(name="h", api_url="https://h",
                          managed_api_url="https://api.{name}.ocp.example.net:6443")
    recorded = {"name": "c1", "client_url": "https://api.c1.recorded:6443",
                "console_url": "https://console-openshift-console.apps.c1.example.net"}
    assert runner.managed_api_url(templated, recorded) == "https://api.c1.recorded:6443"
    assert runner.managed_api_url(templated, {"name": "c2"}) == "https://api.c2.ocp.example.net:6443"
    assert runner.managed_api_url(
        plain, {"name": "c3", "console_url": "https://console-openshift-console.apps.c3.example.net/"}
    ) == "https://api.c3.example.net:6443"
    assert runner.managed_api_url(plain, {"name": "c4"}) is None


def test_shared_access_never_reads_hub_secrets(store, monkeypatch):
    from app.config_loader import FleetConfig, HubConfig

    hub = HubConfig(name="acm", api_url="https://api.acm:6443", managed_access="shared",
                    auth={"type": "password", "username": "svc", "password": "pw"},
                    managed_api_url="https://api.{name}.ocp.example.net:6443")
    monkeypatch.setattr(runner, "load_config", lambda: FleetConfig({}, [hub], []))
    monkeypatch.setattr(runner, "resolve_bearer_token", lambda url, auth, verify=True: "tok")
    monkeypatch.setattr(runner.kube, "bundle_from_endpoint",
                        lambda url, token, verify=True, ca_cert=None: ("endpoint", url))
    monkeypatch.setattr(runner.kube, "list_managedclusters", lambda hb: [_managed("imported-2")])
    monkeypatch.setattr(runner.kube, "read_kubeconfig_secret",
                        lambda hb, ns, name: (_ for _ in ()).throw(AssertionError("must not read secrets")))

    (target,), _ = runner._discover(store)
    assert target.connect() == ("endpoint", "https://api.imported-2.ocp.example.net:6443")


def test_shards_partition_the_fleet_stably():
    names = [f"cluster-{i}" for i in range(200)]
    parts = [[n for n in names if runner.in_shard(n, (i, 4))] for i in range(4)]
    assert sorted(sum(parts, [])) == sorted(names)          # every cluster exactly once
    assert all(30 < len(p) < 70 for p in parts)               # roughly even
    assert [n for n in names if runner.in_shard(n, (2, 4))] == parts[2]   # stable
    assert all(runner.in_shard(n, None) for n in names)


def test_a_shard_collects_only_its_clusters_but_prunes_against_the_whole_fleet(fleet, store, monkeypatch):
    runner.run_collection("manual")
    assert store.cluster_names() == [EAST, WEST]
    # pick a shard count that separates the two fixture clusters
    n = next(n for n in range(2, 12)
             if any(runner.in_shard(EAST, (i, n)) != runner.in_shard(WEST, (i, n)) for i in range(n)))
    shard_of_east = next(i for i in range(n) if runner.in_shard(EAST, (i, n)))
    for entry in store.progress_all():          # the unsharded run's entry, under another instance name
        store.clear_progress(entry["instance"])
    monkeypatch.setattr(runner.settings, "collect_shard", f"{shard_of_east}/{n}")
    before = store.get_cluster(WEST).last_synced
    result = runner.run_collection("manual")
    assert result["clusters"] == 1                            # only EAST was collected
    assert store.cluster_names() == [EAST, WEST]              # WEST was not pruned
    assert store.get_cluster(WEST).last_synced == before
    assert runner.progress()["running"] is False and runner.progress()["total"] == 1


# --------------------------------------------------------------------------- #
# COLLECT_HUBS: one collector owns whole hubs
# --------------------------------------------------------------------------- #
def test_collect_hubs_discovers_only_the_hubs_this_instance_owns(store, monkeypatch):
    from app.config_loader import FleetConfig, HubConfig

    hubs = [HubConfig(name="hub-a", region="us-east-1", kubeconfig="/a.kubeconfig"),
            HubConfig(name="hub-b", region="us-west-2", kubeconfig="/b.kubeconfig")]
    monkeypatch.setattr(runner, "load_config", lambda: FleetConfig({}, hubs, []))
    monkeypatch.setattr(runner.kube, "bundle_from_file", lambda path: path)
    connected = []

    def list_managedclusters(hb):
        connected.append(hb)
        return [_managed("c-a")] if hb == "/a.kubeconfig" else [_managed("c-b")]

    monkeypatch.setattr(runner.kube, "list_managedclusters", list_managedclusters)
    monkeypatch.setattr(runner.settings, "collect_hubs", ("hub-a",))

    targets, hubs_total = runner._discover(store)

    assert [t.meta["name"] for t in targets] == ["c-a"]
    assert hubs_total == 2                       # the estate is still two hubs
    assert connected == ["/a.kubeconfig"]        # hub-b was never even connected to
    by_name = {h.name: h for h in store.hubs()}
    assert set(by_name) == {"hub-a", "hub-b"}    # both are recorded
    assert by_name["hub-a"].reachable is True and by_name["hub-a"].managed_count == 1
    assert by_name["hub-b"].reachable is None    # its state belongs to its own collector
    assert by_name["hub-b"].region == "us-west-2"

    # and a typo is a startup error that names the hubs there are
    monkeypatch.setattr(runner.settings, "collect_hubs", ("hub-c",))
    with pytest.raises(ValueError, match="unknown hub"):
        runner.validate_hub_selection()
    monkeypatch.setattr(runner.settings, "collect_hubs", ())
    assert runner.validate_hub_selection() == ()


def test_prune_leaves_the_clusters_of_another_collectors_hub_alone(fleet, store, monkeypatch):
    runner.run_collection("manual")
    # another collector owns hub-west and has written its cluster there
    store.upsert_hub("hub-west", reachable=True, managed_count=1, last_synced=runner.utcnow())
    store.persist_cluster("hub-west", _document("ocp-other"), [], "healthy", 100,
                          {"passed": 1, "warned": 0, "failed": 0})
    assert store.cluster_names() == [EAST, "ocp-other", WEST]

    monkeypatch.setattr(runner.settings, "collect_hubs", (HUB,))
    fleet["clusters"] = [EAST]                   # WEST vanished from OUR hub
    runner.run_collection("manual")

    assert store.cluster_names() == [EAST, "ocp-other"]
    assert store.get_cluster("ocp-other").hub_name == "hub-west"


# --------------------------------------------------------------------------- #
# tiers: a sweep collects what is due
# --------------------------------------------------------------------------- #
def _tiered_objects():
    return {
        "nodes": [{"metadata": {"name": "n1"}, "status": {
            "capacity": {"cpu": "4", "memory": "16Gi", "pods": "110"},
            "allocatable": {"cpu": "4", "memory": "16Gi", "pods": "110"},
            "conditions": [{"type": "Ready", "status": "True"}], "nodeInfo": {}}}],
        "namespaces": [{"metadata": {"name": "payments"}, "status": {"phase": "Active"}}],
        "pods": [{"metadata": {"name": "api-1", "namespace": "payments"},
                  "spec": {"nodeName": "n1", "containers": [{"name": "app"}]},
                  "status": {"phase": "Running", "containerStatuses": []}}],
        "deployments": [{"metadata": {"name": "api", "namespace": "payments"},
                         "spec": {"replicas": 2, "template": {"spec": {"containers": [
                             {"name": "app", "image": "quay.io/acme/api:1.0"}]}}},
                         "status": {"readyReplicas": 2}}],
        "secrets": [{"metadata": {"name": "api-secret", "namespace": "payments"},
                     "type": "Opaque", "data": {"k": "c2VjcmV0"}}],
    }


@pytest.fixture
def tiered(monkeypatch, store):
    """The real collect path against a fake cluster API: one cluster, a manifest
    with tiers, and a record of every kind actually fetched."""
    from app import kube
    from app.manifest import parse_manifest

    manifest = parse_manifest({"resources": {
        "nodes": True, "namespaces": True, "pods": True,          # every sweep
        "deployments": {"enabled": True, "interval": "15m"},
        "secrets": {"enabled": True, "interval": "1h"},
    }}, source="tiered-test")
    objects = _tiered_objects()
    asked: list[str] = []

    def fake_list(b, base_path, plural, namespace=None, field_selector=None,
                  label_selector=None, page_size=None, stat_key=None):
        asked.append(stat_key)
        b.record(stat_key, nbytes=100, objects=len(objects.get(stat_key) or []), parse_ms=1.0)
        return objects.get(stat_key) or []

    monkeypatch.setattr(kube, "list_resource", fake_list)
    monkeypatch.setattr(runner, "get_manifest", lambda: manifest)

    def fake_discover(st):
        st.upsert_hub(HUB, reachable=True, managed_count=1, last_synced=runner.utcnow())
        return [runner.Target(HUB, {"name": EAST}, lambda: kube.ApiBundle(None))], 1

    monkeypatch.setattr(runner, "_discover", fake_discover)
    return {"asked": asked, "manifest": manifest, "objects": objects}


def _status_of(store, cluster=EAST):
    return {r.key: r for r in store.section(cluster, "resource_status")}


def test_a_second_sweep_fetches_only_what_is_due(tiered, store, monkeypatch):
    # per-kind tiers are the subject here, so every cluster must count as due
    monkeypatch.setattr(runner.settings, "refresh_interval_seconds", 0)
    runner.run_collection("scheduled")
    assert sorted(tiered["asked"]) == ["deployments", "namespaces", "nodes", "pods", "secrets"]
    tiered["asked"].clear()

    runner.run_collection("scheduled")           # straight away: the tiers are not up

    assert sorted(tiered["asked"]) == ["namespaces", "nodes", "pods"]
    status = _status_of(store)
    assert status["deployments"].cached is True and status["secrets"].cached is True
    assert status["pods"].cached is False
    assert status["deployments"].status == "collected"      # the outcome is kept too
    assert status["deployments"].interval_seconds == 900
    # and the kept kinds are still in the document the API serves
    assert [w.name for w in store.section(EAST, "workloads")] == ["api"]
    assert [r.key for r in store.section(EAST, "resources")] == ["secrets"]
    assert store.get_cluster(EAST).workloads_total == 1


def test_a_kind_is_fetched_again_once_its_interval_has_passed(tiered, store, monkeypatch):
    runner.run_collection("scheduled")
    tiered["asked"].clear()

    later = runner.utcnow() + timedelta(minutes=20)
    monkeypatch.setattr(runner, "utcnow", lambda: later)
    runner.run_collection("scheduled")

    # the 15m tier is due, the hourly one is not
    assert sorted(tiered["asked"]) == ["deployments", "namespaces", "nodes", "pods"]
    status = _status_of(store)
    assert status["deployments"].cached is False and status["secrets"].cached is True
    assert _parse(status["secrets"].collected_at) < _parse(status["deployments"].collected_at)


def test_a_full_refresh_fetches_every_enabled_kind(tiered, store):
    runner.run_collection("scheduled")
    tiered["asked"].clear()

    runner.run_collection("manual", full=True)

    assert sorted(tiered["asked"]) == ["deployments", "namespaces", "nodes", "pods", "secrets"]
    assert all(not r.cached for r in _status_of(store).values())
    tiered["asked"].clear()
    assert runner.refresh_cluster(EAST, full=True)["ok"] is True
    assert sorted(tiered["asked"]) == ["deployments", "namespaces", "nodes", "pods", "secrets"]
    tiered["asked"].clear()
    runner.refresh_cluster(EAST)                 # on demand, but still only what is due
    assert sorted(tiered["asked"]) == ["namespaces", "nodes", "pods"]


def test_timings_land_on_the_cluster_and_on_the_run(tiered, store, monkeypatch):
    # per-kind tiers are the subject here, so every cluster must count as due
    monkeypatch.setattr(runner.settings, "refresh_interval_seconds", 0)
    runner.run_collection("scheduled")

    timings = store.get_cluster(EAST).timings
    assert timings["kinds_fetched"] == 5 and timings["kinds_cached"] == 0
    assert timings["objects"] == 5 and timings["bytes"] == 500     # five fake lists
    assert timings["parse_ms"] == 5.0
    for stage in ("fetch_ms", "assemble_ms", "health_ms", "persist_ms", "total_ms"):
        assert timings[stage] >= 0

    run = store.runs()[0].timings
    assert run["clusters"] == 1 and run["kinds_fetched"] == 5 and run["kinds_cached"] == 0
    assert run["bytes"] == 500 and run["objects"] == 5
    assert set(run["fetch_ms"]) == {"sum", "p95"}
    assert run["persist_ms"]["sum"] >= 0 and run["persist_ms"]["p95"] >= 0

    runner.run_collection("scheduled")
    assert store.get_cluster(EAST).timings["kinds_cached"] == 2
    assert store.runs()[0].timings["kinds_cached"] == 2


def test_p95_is_the_worst_cluster_not_the_average():
    assert runner._p95([]) == 0
    assert runner._p95([7]) == 7
    assert runner._p95([1] * 9 + [900]) == 900       # the tail is what p95 is for
    assert runner._p95(list(range(1, 101))) == 95    # the 95th of a hundred


def test_progress_aggregates_every_collector(fleet, store):
    runner.run_collection("manual")
    mine = runner.progress()
    assert mine["running"] is False and mine["total"] == 2 and mine["done"] == 2
    assert [c["instance"] for c in mine["collectors"]] == [runner.instance_name()]
    # another collector, mid-sweep on its own hub, published into the same Redis
    store.set_progress("hub-far#other:9", {"running": True, "trigger": "scheduled", "total": 114, "done": 71,
                                           "ok": 70, "failed": 1, "hubs": ["hub-far"],
                                           "started_at": "2026-09-14T10:00:00+00:00"}, ttl_seconds=60)
    agg = runner.progress()
    assert agg["running"] is True and agg["total"] == 114 and agg["done"] == 71 and agg["failed"] == 1
    from datetime import UTC, datetime
    assert agg["started_at"] == datetime(2026, 9, 14, 10, tzinfo=UTC)     # restored like every row
    assert len(agg["collectors"]) == 2
    assert {c["hubs"][0] for c in agg["collectors"] if c["hubs"]} == {"hub-far"}


def test_shared_access_verifies_against_the_cluster_ca_recorded_by_acm(store, monkeypatch, tmp_path):
    import base64

    from app.config_loader import FleetConfig, HubConfig

    corp = tmp_path / "corp-ca.pem"
    corp.write_text("-----BEGIN CERTIFICATE-----\nCORP\n-----END CERTIFICATE-----\n")
    cluster_pem = "-----BEGIN CERTIFICATE-----\nCLUSTER\n-----END CERTIFICATE-----\n"
    hub = HubConfig(name="acm", api_url="https://api.acm:6443", managed_access="shared",
                    ca_cert=str(corp), auth={"type": "password", "username": "svc", "password": "pw"})
    monkeypatch.setattr(runner, "load_config", lambda: FleetConfig({}, [hub], []))
    verify_by_url, ca_by_url = {}, {}
    monkeypatch.setattr(runner, "resolve_bearer_token",
                        lambda url, auth, verify=True: verify_by_url.__setitem__(url, verify) or "tok")
    monkeypatch.setattr(
        runner.kube, "bundle_from_endpoint",
        lambda url, token, verify=True, ca_cert=None: ca_by_url.__setitem__(url, ca_cert) or "b")
    mc = _managed("imported-3", "https://api.imported-3:6443")
    mc["spec"]["managedClusterClientConfigs"][0]["caBundle"] = base64.b64encode(cluster_pem.encode()).decode()
    monkeypatch.setattr(runner.kube, "list_managedclusters", lambda hb: [mc])

    (target,), _ = runner._discover(store)
    target.connect()
    cluster_url = "https://api.imported-3:6443"
    bundle_path = verify_by_url[cluster_url]
    assert bundle_path == ca_by_url[cluster_url] and bundle_path.endswith(".pem")
    assert verify_by_url["https://api.acm:6443"] == str(corp)      # the hub itself: its own ca_cert
    content = pathlib.Path(bundle_path).read_text()
    assert "CLUSTER" in content and "CORP" in content        # the cluster's CA plus the corporate one
    assert runner.cluster_ca_bundle(hub, {"name": "x"}) == str(corp)   # no ACM bundle: hub ca_cert
    assert runner.cluster_ca_bundle(HubConfig(name="h", api_url="https://h"), {"name": "x"}) is None


def test_scheduled_sweeps_skip_fresh_clusters_and_resume_the_stale_ones_first(fleet, store, monkeypatch):
    """A restart mid-sweep must continue with the clusters that were not yet
    collected, not start over: clusters collected within the interval are
    skipped and the rest are taken oldest first."""
    from datetime import timedelta

    runner.run_collection("manual")                      # both collected just now
    fleet["gathered"].clear()
    result = runner.run_collection("scheduled")
    assert result["clusters"] == 0 and fleet["gathered"] == []      # everything is fresh

    # make WEST look old (collected before the interval) and EAST fresh
    old = runner.utcnow() - timedelta(seconds=10 * runner.settings.refresh_interval_seconds)
    store.update_summary(WEST, last_synced=old)
    result = runner.run_collection("scheduled")
    assert [g["cluster"] for g in fleet["gathered"]] == [WEST] and result["clusters"] == 1

    # a never-collected cluster comes first, then the stalest known one
    fleet["gathered"].clear()
    fleet["clusters"] = ["brand-new", EAST, WEST]
    fleet["documents"]["brand-new"] = _document("brand-new")
    fleet["ok"]["brand-new"] = True
    store.update_summary(WEST, last_synced=old)
    store.update_summary(EAST, last_synced=old + timedelta(seconds=60))
    runner.run_collection("startup")
    assert [g["cluster"] for g in fleet["gathered"]] == ["brand-new", WEST, EAST]

    # manual and full refreshes always take everything
    fleet["gathered"].clear()
    runner.run_collection("manual")
    assert len(fleet["gathered"]) == 3
    fleet["gathered"].clear()
    runner.run_collection("scheduled", full=True)
    assert len(fleet["gathered"]) == 3
