"""
The Redis store: what a sweep writes and what the API reads back.

Documents come from `assemble()` over small raw objects, so the rows under test
are the ones the collector really produces, not a hand-written approximation.
Everything runs against fakeredis, which is why the store uses MULTI/EXEC
pipelines and no Lua.
"""
import base64
import copy
from datetime import UTC, datetime, timedelta

import fakeredis
import pytest

from app.collector.collect import assemble, unreachable
from app.collector.healthchecks import run_health_checks
from app.store import history
from app.store.redis_store import RedisStore
from tests.conftest import make_cert_pem
from tests.test_parsers import NOW, _pod

EAST, WEST = "ocp-east-1", "ocp-west-1"
APP_IMAGE = "quay.io/acme/api:1.0"
CANARY_IMAGE = "quay.io/acme/api:2.0-RC1"          # uppercase: search must be case-insensitive
PLATFORM_IMAGE = "quay.io/openshift/prometheus:v2.5"


# --------------------------------------------------------------------------- #
# raw cluster objects
# --------------------------------------------------------------------------- #
def _ns(name, labels=None):
    return {"metadata": {"name": name, "labels": labels or {}}, "status": {"phase": "Active"}}


def _node(name, cpu="4", mem="16Gi"):
    return {"metadata": {"name": name}, "status": {
        "capacity": {"cpu": cpu, "memory": mem, "pods": "110"},
        "allocatable": {"cpu": cpu, "memory": mem, "pods": "110"},
        "conditions": [{"type": "Ready", "status": "True"}], "nodeInfo": {}}}


def _dep(name, ns, image, secret=None):
    env = ([{"name": "X", "valueFrom": {"secretKeyRef": {"name": secret, "key": "k"}}}]
           if secret else [])
    return {"metadata": {"name": name, "namespace": ns, "labels": {}},
            "spec": {"replicas": 2, "template": {"spec": {"containers": [
                {"name": "app", "image": image, "env": env}]}}},
            "status": {"readyReplicas": 2, "availableReplicas": 2, "updatedReplicas": 2}}


def _operator(name, version, degraded=False):
    return {"metadata": {"name": name}, "status": {
        "versions": [{"name": "operator", "version": version}],
        "conditions": [{"type": "Available", "status": "True"},
                       {"type": "Degraded", "status": "True" if degraded else "False",
                        "message": "router pods not ready" if degraded else ""}]}}


def _tls_secret(name, ns, pem):
    return {"metadata": {"name": name, "namespace": ns}, "type": "kubernetes.io/tls",
            "data": {"tls.crt": base64.b64encode(pem).decode()}}


def _raw(cluster, version, team, pem, usage, operators, images, degraded):
    deployments = [_dep("api", "payments", images[0], secret="api-tls"),
                   _dep("prom", "openshift-monitoring", PLATFORM_IMAGE)]
    if len(images) > 1:
        deployments.append(_dep("api-canary", "payments", images[1]))
    return {
        "clusterversion": {"spec": {"channel": "stable-4.16"},
                           "status": {"desired": {"version": version},
                                      "history": [{"state": "Completed", "version": version}],
                                      "conditions": []}},
        "infrastructure": {"status": {"platform": "AWS",
                                      "apiServerURL": f"https://api.{cluster}:6443"}},
        "network_config": {"status": {"networkType": "OVNKubernetes"}},
        "ingress_config": {"spec": {"domain": f"apps.{cluster}.example.com"}},
        "clusteroperators": [_operator(name, version, degraded=(degraded and name == "ingress"))
                             for name in operators],
        "nodes": [_node("n1"), _node("n2")],
        "node_metrics": [{"metadata": {"name": "n1"},
                          "usage": {"cpu": usage["node_cpu"], "memory": usage["node_mem"]}},
                         {"metadata": {"name": "n2"}, "usage": {"cpu": "500m", "memory": "2Gi"}}],
        "namespaces": [_ns("payments", {"odl.io/team": team, "odl.io/tier": "critical"}),
                       _ns("openshift-monitoring")],
        "pods": [_pod("api-1", "payments"),
                 _pod("api-2", "payments", claim="api-data"),
                 _pod("api-3", "payments", waiting="CrashLoopBackOff", restarts=9,
                      owner=("ReplicaSet", "api-3x"), hash_="3x"),
                 _pod("prom-1", "openshift-monitoring", waiting="ImagePullBackOff",
                      owner=("StatefulSet", "prometheus-k8s"))],
        "pod_metrics": [{"metadata": {"namespace": "payments"}, "containers": [
            {"usage": {"cpu": usage["ns_cpu"], "memory": usage["ns_mem"]}}]}],
        "deployments": deployments,
        "secrets": [_tls_secret("api-tls", "payments", pem)],
        "persistentvolumeclaims": [{"metadata": {"name": "api-data", "namespace": "payments"},
                                    "spec": {"storageClassName": "gp3"},
                                    "status": {"phase": "Bound"}}],
        "machineconfigpools": [{"metadata": {"name": "worker"}, "status": {
            "machineCount": 2,
            "conditions": [{"type": "Degraded", "status": "True" if degraded else "False",
                            "message": "node stuck draining"}]}}],
        "routes": [{"metadata": {"name": "api", "namespace": "payments"},
                    "spec": {"host": f"api.apps.{cluster}.example.com", "to": {"name": "api"}},
                    "status": {"ingress": [{"routerName": "default", "conditions": [
                        {"type": "Admitted", "status": "True"}]}]}}],
    }


def _document(manifest, cluster, *, version, team, pem, region, datacenter, usage,
              operators=("etcd", "ingress"), images=(APP_IMAGE,), degraded=False):
    meta = {"name": cluster, "region": region, "datacenter": datacenter,
            "environment": "prod", "cloud": "aws", "managed_available": True}
    raw = _raw(cluster, version, team, pem, usage, operators, images, degraded)
    status = {key: {"status": "collected", "count": 1} for key in raw}
    status["events"] = {"status": "forbidden", "count": 0, "error": "denied"}
    doc = assemble(meta, raw, status, manifest, NOW)
    doc["collect_ms"] = 1234
    return doc


# --------------------------------------------------------------------------- #
# fixtures
# --------------------------------------------------------------------------- #
@pytest.fixture(scope="module")
def pems():
    """Two real certificates, so `expires_at` is produced by the collector."""
    return {"east": make_cert_pem(cn="api.east.example.com", days=20)[0],
            "west": make_cert_pem(cn="api.west.example.com", days=5)[0]}


@pytest.fixture(scope="module")
def documents(manifest, pems):
    return {
        EAST: _document(manifest, EAST, version="4.16.7", team="payments", pem=pems["east"],
                        region="us-east-1", datacenter="iad1",
                        usage={"ns_cpu": "500m", "ns_mem": "2Gi",
                               "node_cpu": "3", "node_mem": "12Gi"}),
        WEST: _document(manifest, WEST, version="4.15.9", team="risk", pem=pems["west"],
                        region="us-west-2", datacenter="sjc1",
                        usage={"ns_cpu": "1500m", "ns_mem": "1Gi",
                               "node_cpu": "2", "node_mem": "8Gi"},
                        images=(APP_IMAGE, CANARY_IMAGE), degraded=True),
    }


@pytest.fixture
def make_store():
    def _make(**kwargs):
        kwargs.setdefault("snapshot_retention", 500)
        return RedisStore(fakeredis.FakeRedis(), prefix="odl", **kwargs)
    return _make


@pytest.fixture
def store(make_store):
    return make_store()


def _persist(store, manifest, doc, hub="hub-east", at=None):
    thresholds = manifest.describe()["thresholds"]
    checks, overall, score, counts = run_health_checks(doc, "4.15.0", thresholds)
    store.persist_cluster(hub, doc, checks, overall, score, counts, now=at)
    return overall


@pytest.fixture
def fleet(store, manifest, documents):
    """Both clusters persisted, east on hub-east and west on hub-west."""
    _persist(store, manifest, documents[EAST], hub="hub-east")
    _persist(store, manifest, documents[WEST], hub="hub-west")
    store.upsert_hub("hub-east", region="us-east-1", reachable=True)
    store.upsert_hub("hub-west", region="us-west-2", reachable=True)
    store.finalize_sweep()
    return store


# --------------------------------------------------------------------------- #
# summary, sections, snapshots
# --------------------------------------------------------------------------- #
def test_summary_round_trip(fleet):
    row = fleet.get_cluster(EAST)
    assert row.name == EAST and row.hub_name == "hub-east"
    assert row.ocp_version == "4.16.7" and row.region == "us-east-1"
    assert row.apps_domain == f"apps.{EAST}.example.com"
    # types survive: ints stay ints, floats floats, bools bools, lists lists
    assert row.nodes_total == 2 and isinstance(row.nodes_total, int)
    assert row.cpu_allocatable == 8.0 and isinstance(row.cpu_allocatable, float)
    assert row.metrics_available is True and row.upgrading is False
    assert row.available_updates == [] and row.cluster_network == []
    assert row.collect_ms == 1234 and row.reachable is True
    assert row.namespaces_application == 1 and row.namespaces_platform == 1
    assert row.pod_issues_total == 2 and row.certs_expiring_total == 1
    assert isinstance(row.last_synced, datetime) and row.last_synced.tzinfo is not None
    assert fleet.get_cluster("nope") is None


def test_sections_round_trip(fleet):
    sections = fleet.sections(EAST, ["operators", "nodes", "namespaces", "workloads",
                                     "workload_images", "workload_refs", "pod_issues",
                                     "resources", "resource_status", "health_checks"])
    assert {o.name for o in sections["operators"]} == {"etcd", "ingress"}
    assert {n.name for n in sections["nodes"]} == {"n1", "n2"}
    assert {n.name for n in sections["namespaces"]} == {"payments", "openshift-monitoring"}
    assert {w.name for w in sections["workloads"]} == {"api", "prom"}
    assert {i.image for i in sections["workload_images"]} == {APP_IMAGE, PLATFORM_IMAGE}
    assert ("api", "api-tls") in {(r.workload_name, r.ref_name)
                                  for r in sections["workload_refs"]}
    assert {p.name for p in sections["pod_issues"]} == {"api-3", "prom-1"}
    assert {r.key for r in sections["resources"]} == {
        "secrets", "persistentvolumeclaims", "machineconfigpools", "routes"}
    assert [s for s in sections["resource_status"] if s.key == "events"][0].status == "forbidden"
    assert all(c.status in ("pass", "warn", "fail") for c in sections["health_checks"])

    # every row carries the cluster it came from, and datetimes come back aware
    assert all(r.cluster_name == EAST for r in sections["resources"])
    secret = next(r for r in sections["resources"] if r.key == "secrets")
    assert isinstance(secret.expires_at, datetime) and secret.expires_at.tzinfo is not None
    assert isinstance(secret.summary, dict)         # nested JSON stays nested

    assert fleet.section(EAST, "nodes") == sections["nodes"]
    assert fleet.section("nope", "nodes") == []


def test_section_across_clusters(fleet):
    across = fleet.section_across("namespaces")
    assert set(across) == {EAST, WEST}
    assert all(r.cluster_name == name for name, rows in across.items() for r in rows)
    assert set(fleet.section_across("nodes", [EAST])) == {EAST}


def test_snapshots_are_appended_and_trimmed(make_store, manifest, documents):
    store = make_store(snapshot_retention=3)
    for _ in range(5):
        _persist(store, manifest, documents[EAST])
    snaps = store.snapshots(EAST)
    assert len(snaps) == 3                                   # trimmed to retention
    assert [s.cluster_name for s in snaps] == [EAST] * 3
    assert snaps[0].snapshot_at < snaps[-1].snapshot_at      # oldest first
    assert snaps[-1].health_score == store.get_cluster(EAST).health_score
    assert isinstance(snaps[-1].snapshot_at, datetime)


def test_a_snapshot_row_counts_what_went_wrong(fleet, documents):
    """The row is what a trend is drawn from, so it carries the shape of the
    trouble, not just a total: which kind of pod issue, which checks failed."""
    row = fleet.snapshots(WEST)[-1]
    summary = fleet.get_cluster(WEST)
    assert row.resolution == "sweep" and row.samples == 1
    assert row.pod_issues == summary.pod_issues_total == 2
    assert row.pod_issues_application == 1 and row.pod_issues_platform == 1
    assert row.crashloops == 1                 # api-3 is CrashLoopBackOff
    assert row.image_pull_errors == 1          # prom-1 is ImagePullBackOff
    assert row.oom_killed == 0 and row.pending_pods == 0
    assert row.restarts_total == 9             # summed over the namespaces
    assert row.warning_events == 0             # the fixture's events are forbidden
    assert row.events_by_reason == {}
    assert row.operators_degraded == 1         # west's ingress is degraded
    assert "no-degraded-operators" in row.checks_failed_names
    assert row.checks_failed == len(row.checks_failed_names)
    assert row.nodes_total == 2 and row.nodes_ready == 2
    assert row.namespaces_application == 1 and row.applications_total == 1
    assert row.workloads_total == 3 and row.certs_expiring_total == 1


# --------------------------------------------------------------------------- #
# history: the rollup rules, as pure functions
# --------------------------------------------------------------------------- #
def _sample(minute, **fields):
    """One per-sweep row, with only the fields a rule under test cares about."""
    return {"cluster_name": EAST, "resolution": "sweep", "samples": 1,
            "snapshot_at": HOUR_START + timedelta(minutes=minute), **fields}


HOUR_START = datetime(2026, 9, 10, 10, 0, tzinfo=UTC)


def test_a_bucket_keeps_the_worst_counter_and_the_last_gauge():
    rolled = history.aggregate_snapshots([
        _sample(0, crashloops=1, pod_issues=2, health_score=90, nodes_ready=3,
                overall_status="warning", ocp_version="4.16.5"),
        _sample(20, crashloops=5, pod_issues=9, health_score=40, nodes_ready=1,
                overall_status="critical", ocp_version="4.16.5"),
        _sample(40, crashloops=0, pod_issues=1, health_score=100, nodes_ready=3,
                overall_status="healthy", ocp_version="4.16.7"),
    ], HOUR_START, "hour")

    # counters: the spike survives, because that is what the hour was about
    assert rolled["crashloops"] == 5 and rolled["pod_issues"] == 9
    # gauges: where the cluster ended up
    assert rolled["health_score"] == 100 and rolled["nodes_ready"] == 3
    assert rolled["overall_status"] == "healthy" and rolled["ocp_version"] == "4.16.7"
    assert rolled["snapshot_at"] == HOUR_START and rolled["resolution"] == "hour"
    assert rolled["samples"] == 3 and rolled["cluster_name"] == EAST


def test_a_bucket_means_utilization_and_keeps_the_peak():
    rolled = history.aggregate_snapshots([
        _sample(0, cpu_usage=2.0, memory_usage=100),
        _sample(20, cpu_usage=8.0, memory_usage=400),
        _sample(40, cpu_usage=2.0, memory_usage=100),
    ], HOUR_START, "hour")
    assert rolled["cpu_usage"] == 4.0 and rolled["cpu_usage_max"] == 8.0
    assert rolled["memory_usage"] == 200 and rolled["memory_usage_max"] == 400
    # cores are fractional, bytes are not: a mean of whole numbers stays whole
    assert isinstance(rolled["cpu_usage"], float)
    assert isinstance(rolled["memory_usage"], int)


def test_rolling_up_a_rollup_weights_the_mean_by_its_samples():
    """A daily row is the mean of the raw samples, never a mean of means."""
    hourly = [
        {"snapshot_at": HOUR_START, "resolution": "hour", "samples": 30,
         "cpu_usage": 1.0, "cpu_usage_max": 2.0},
        {"snapshot_at": HOUR_START + timedelta(hours=1), "resolution": "hour", "samples": 10,
         "cpu_usage": 5.0, "cpu_usage_max": 9.0},
    ]
    rolled = history.aggregate_snapshots(hourly, HOUR_START.replace(hour=0), "day")
    assert rolled["samples"] == 40
    assert rolled["cpu_usage"] == (30 * 1.0 + 10 * 5.0) / 40 == 2.0
    assert rolled["cpu_usage_max"] == 9.0        # the peak of an hour is a peak of the day


def test_a_bucket_unions_names_and_merges_event_reasons():
    rolled = history.aggregate_snapshots([
        _sample(0, checks_failed_names=["nodes-ready"], checks_warned_names=[],
                events_by_reason={"BackOff": 4, "FailedMount": 1}),
        _sample(30, checks_failed_names=["no-degraded-operators"],
                checks_warned_names=["capacity-headroom"],
                events_by_reason={"BackOff": 2, "Unhealthy": 7}),
    ], HOUR_START, "hour")
    assert rolled["checks_failed_names"] == ["no-degraded-operators", "nodes-ready"]
    assert rolled["checks_warned_names"] == ["capacity-headroom"]
    # the worst count per reason, not the sum: the same event is seen again by
    # every sweep, so summing would multiply it by the sweep rate
    assert rolled["events_by_reason"] == {"Unhealthy": 7, "BackOff": 4, "FailedMount": 1}


def test_a_bucket_of_missing_values_stays_missing():
    rolled = history.aggregate_snapshots([_sample(0), _sample(30)], HOUR_START, "hour")
    assert rolled["cpu_usage"] is None and rolled["cpu_usage_max"] is None
    assert rolled["crashloops"] is None and rolled["upgrading"] is False
    assert history.aggregate_snapshots([], HOUR_START, "hour") is None


def test_an_upgrade_anywhere_in_the_bucket_shows_on_the_bucket():
    rolled = history.aggregate_snapshots(
        [_sample(0, upgrading=False), _sample(20, upgrading=True), _sample(40, upgrading=False)],
        HOUR_START, "hour")
    assert rolled["upgrading"] is True       # an upgrade inside one day still happened


def test_buckets_are_the_start_of_the_hour_and_of_the_day():
    when = datetime(2026, 9, 10, 10, 37, 12, tzinfo=UTC)
    assert history.bucket_start(when, "hour") == datetime(2026, 9, 10, 10, 0, tzinfo=UTC)
    assert history.bucket_start(when, "day") == datetime(2026, 9, 10, 0, 0, tzinfo=UTC)
    assert history.bucket_start(when, "sweep") == when          # a sweep is an instant
    assert history.bucket_end(history.bucket_start(when, "hour"), "hour") == \
        datetime(2026, 9, 10, 11, 0, tzinfo=UTC)
    assert history.bucket_end(history.bucket_start(when, "day"), "day") == \
        datetime(2026, 9, 11, 0, 0, tzinfo=UTC)
    assert history.bucket_start(when.timestamp(), "hour") == history.bucket_start(when, "hour")


# --------------------------------------------------------------------------- #
# history: the tiers, through the store
# --------------------------------------------------------------------------- #
def test_sweeps_roll_up_into_hours_and_days(make_store, manifest, documents):
    store = make_store()
    calm = documents[EAST]
    spike = copy.deepcopy(calm)
    spike["pod_issues"] = [*spike["pod_issues"], {**spike["pod_issues"][0], "name": "api-4"}]
    spike["pod_issues_total"] = len(spike["pod_issues"])
    spike["capacity"] = {**spike["capacity"], "cpu_usage": 7.5}

    start = datetime(2026, 9, 10, 10, 0, tzinfo=UTC)
    for minutes, doc in ((0, calm), (20, spike), (40, calm)):
        _persist(store, manifest, doc, at=start + timedelta(minutes=minutes))
    _persist(store, manifest, calm, at=start + timedelta(hours=1))      # closes the hour
    _persist(store, manifest, calm, at=start + timedelta(days=1))       # closes the day

    hour = next(r for r in store.snapshots(EAST, resolution="hour")
                if r.snapshot_at == start)
    assert hour.samples == 3 and hour.resolution == "hour"
    assert hour.crashloops == 2 and hour.pod_issues == 3        # the spike, not the average
    assert hour.cpu_usage == pytest.approx((3.5 + 7.5 + 3.5) / 3)
    assert hour.cpu_usage_max == 7.5
    assert hour.health_score == store.get_cluster(EAST).health_score

    day = next(r for r in store.snapshots(EAST, resolution="day")
               if r.snapshot_at == start.replace(hour=0))
    assert day.samples == 4 and day.resolution == "day"         # the hour, plus the 11:00 sweep
    assert day.crashloops == 2 and day.cpu_usage_max == 7.5
    assert day.cluster_name == EAST


def test_the_current_bucket_exists_from_the_first_sweep(make_store, manifest, documents):
    """A cluster collected once is already queryable at every resolution: the
    open bucket holds what there is so far and is recomputed when it closes."""
    store = make_store()
    at = datetime(2026, 9, 10, 10, 5, tzinfo=UTC)
    _persist(store, manifest, documents[EAST], at=at)
    for resolution, expected in (("sweep", at), ("hour", at.replace(minute=0)),
                                 ("day", at.replace(hour=0, minute=0))):
        rows = store.snapshots(EAST, resolution=resolution)
        assert [r.snapshot_at for r in rows] == [expected], resolution
        assert rows[0].samples == 1


def test_each_tier_is_trimmed_by_its_own_window(make_store, manifest, documents):
    store = make_store(raw_hours=2, hourly_days=1, daily_days=3)
    start = datetime(2026, 9, 1, 0, 5, tzinfo=UTC)
    for hours in range(0, 24 * 5, 6):          # one sweep every six hours, for five days
        _persist(store, manifest, documents[EAST], at=start + timedelta(hours=hours))
    last = start + timedelta(hours=24 * 5 - 6)

    # the per-sweep tier keeps hours, the hourly tier a day, the daily tier days
    assert [r.snapshot_at for r in store.snapshots(EAST, limit=500)] == [last]
    hourly = store.snapshots(EAST, limit=500, resolution="hour")
    assert len(hourly) == 4 and all(r.snapshot_at > last - timedelta(days=1) for r in hourly)
    daily = store.snapshots(EAST, limit=500, resolution="day")
    assert len(daily) == 3 and all(r.snapshot_at > last - timedelta(days=3) for r in daily)
    # and nothing ages out of the coarse tiers just because the sweeps did
    assert daily[-1].samples == 4 and sum(r.samples for r in daily) == 12


def test_the_row_cap_is_a_safety_net_on_the_sweep_tier_only(make_store, manifest, documents):
    store = make_store(snapshot_retention=2)
    start = datetime(2026, 9, 10, 10, 0, tzinfo=UTC)
    for hours in range(6):
        _persist(store, manifest, documents[EAST], at=start + timedelta(hours=hours))
    assert len(store.snapshots(EAST, limit=500)) == 2            # capped
    assert len(store.snapshots(EAST, limit=500, resolution="hour")) == 6   # untouched


def test_history_reads_by_resolution_and_window(make_store, manifest, documents):
    store = make_store()
    start = datetime(2026, 9, 10, 0, 0, tzinfo=UTC)
    for hours in range(12):
        _persist(store, manifest, documents[EAST], at=start + timedelta(hours=hours))

    assert len(store.snapshots(EAST, limit=3)) == 3               # the last three sweeps
    window = store.snapshots(EAST, limit=100, resolution="hour",
                             since=start + timedelta(hours=4),
                             until=start + timedelta(hours=6))
    assert [r.snapshot_at for r in window] == [start + timedelta(hours=h) for h in (4, 5, 6)]
    # bounds may be ISO strings or epoch seconds, as a query string carries them
    assert store.snapshots(EAST, resolution="hour",
                           since=(start + timedelta(hours=4)).isoformat(),
                           until=(start + timedelta(hours=6)).timestamp()) == window
    assert store.snapshots(EAST, resolution="day") == store.snapshots(EAST, resolution="day")
    assert store.snapshots("nope", resolution="hour") == []


def test_history_across_clusters_is_one_round_trip(make_store, manifest, documents):
    store = make_store()
    at = datetime(2026, 9, 10, 10, 0, tzinfo=UTC)
    _persist(store, manifest, documents[EAST], hub="hub-east", at=at)
    _persist(store, manifest, documents[WEST], hub="hub-west", at=at)
    across = store.snapshots_across([EAST, WEST], resolution="hour")
    assert set(across) == {EAST, WEST}
    assert all(row.cluster_name == name for name, rows in across.items() for row in rows)
    assert [r.snapshot_at for r in across[EAST]] == [at]
    # a window nothing falls in leaves the cluster out rather than yielding []
    assert store.snapshots_across([EAST], resolution="hour",
                                  since=at + timedelta(hours=1)) == {}
    assert store.snapshots_across([]) == {}


# --------------------------------------------------------------------------- #
# history: the change log
# --------------------------------------------------------------------------- #
def _changed(doc: dict, **fields) -> dict:
    return {**copy.deepcopy(doc), **fields}


def test_the_first_sweep_of_a_cluster_changes_nothing(store, manifest, documents):
    _persist(store, manifest, documents[EAST])
    assert store.changes(EAST) == []


def test_every_kind_of_change_is_recorded(store, manifest, documents):
    base = documents[EAST]
    _persist(store, manifest, base)
    moved = _changed(base, version="4.17.1", nodes_total=3, nodes_ready=2, upgrading=True,
                     desired_version="4.17.2", applications_total=2)
    moved["namespaces"] = [*moved["namespaces"],
                           {**moved["namespaces"][0], "name": "risk", "app_name": "fraud",
                            "ns_class": "application"}]
    moved["operators"] = [{**o, "degraded": True} for o in moved["operators"]]
    _persist(store, manifest, moved)

    by_kind = {}
    for change in store.changes(EAST):
        by_kind.setdefault(change.kind, []).append(change)
    assert set(by_kind) == {"version", "status", "check", "operator", "nodes", "namespace",
                            "application", "upgrade"}
    assert all(k in history.KINDS for k in by_kind)

    version = by_kind["version"][0]
    assert (version.subject, version.before, version.after) == \
        ("ocp_version", "4.16.7", "4.17.1")
    assert version.message == "version changed from 4.16.7 to 4.17.1"
    assert isinstance(version.at, datetime) and version.cluster_name == EAST
    # ints stay ints and booleans booleans, so a caller can render "2 -> 3"
    assert [(c.subject, c.before, c.after) for c in by_kind["nodes"]] == [("nodes_total", 2, 3)]
    assert [(c.subject, c.before, c.after) for c in by_kind["application"]] == [
        ("applications_total", 1, 2)]
    assert by_kind["upgrade"][0].after is True
    assert by_kind["upgrade"][0].subject == "4.17.2"
    assert by_kind["namespace"][0].after == "fraud"
    assert "risk" in by_kind["namespace"][0].message
    assert {c.subject for c in by_kind["operator"]} == {"etcd", "ingress"}
    assert all(c.after == "degraded" and c.before == "ok" for c in by_kind["operator"])
    # three nodes but only two ready, and every operator degraded: two checks fell over
    assert {c.subject for c in by_kind["check"]} == {"no-degraded-operators", "nodes-ready"}
    assert all(c.after == "fail" and c.before == "ok" for c in by_kind["check"])
    assert by_kind["status"][0].after == "critical"


def test_a_check_and_an_operator_that_recover_are_recorded_too(store, manifest, documents):
    degraded = _changed(documents[EAST])
    degraded["operators"] = [{**o, "degraded": True} for o in degraded["operators"]]
    _persist(store, manifest, degraded)
    _persist(store, manifest, degraded)              # nothing moved: nothing recorded
    assert store.changes(EAST) == []
    _persist(store, manifest, documents[EAST])       # operators healthy again

    recovered = {(c.kind, c.subject, c.after) for c in store.changes(EAST)}
    assert ("operator", "ingress", "ok") in recovered
    assert ("check", "no-degraded-operators", "ok") in recovered
    assert ("status", "overall_status", "warning") in recovered


def test_an_unreachable_sweep_records_only_that(store, manifest, documents):
    """A cluster the collector cannot reach has empty sections. Reporting every
    check as recovered and every namespace as deleted would be a lie."""
    _persist(store, manifest, documents[EAST])
    _persist(store, manifest, unreachable({"name": EAST}, "connect: timed out"))
    lost = store.changes(EAST)
    assert [(c.kind, c.subject) for c in lost] == [("reachability", "reachable")]
    assert lost[0].before is True and lost[0].after is False
    assert "timed out" in lost[0].message

    _persist(store, manifest, documents[EAST])       # and back again
    assert [(c.kind, c.after) for c in store.changes(EAST, limit=1)] == [("reachability", True)]


def test_changes_are_read_newest_first_and_by_window(store, manifest, documents):
    base = documents[EAST]
    start = datetime(2026, 9, 10, 10, 0, tzinfo=UTC)
    _persist(store, manifest, base, at=start)
    for index, version in enumerate(("4.16.8", "4.16.9", "4.17.0"), start=1):
        _persist(store, manifest, _changed(base, version=version),
                 at=start + timedelta(hours=index))

    everything = store.changes(EAST)
    assert [c.after for c in everything] == ["4.17.0", "4.16.9", "4.16.8"]
    assert [c.after for c in store.changes(EAST, limit=1)] == ["4.17.0"]
    assert [c.after for c in store.changes(EAST, since=start + timedelta(hours=2, minutes=30))] \
        == ["4.17.0"]
    assert store.changes("nope") == []


def test_changes_across_the_fleet_are_merged_newest_first(fleet, manifest, documents):
    start = datetime(2026, 9, 10, 10, 0, tzinfo=UTC)
    _persist(fleet, manifest, _changed(documents[WEST], version="4.15.10"),
             hub="hub-west", at=start)
    _persist(fleet, manifest, _changed(documents[EAST], version="4.16.8"),
             hub="hub-east", at=start + timedelta(minutes=1))

    rows = fleet.changes_across([EAST, WEST])
    assert [(r.cluster_name, r.after) for r in rows] == [(EAST, "4.16.8"), (WEST, "4.15.10")]
    assert [r.cluster_name for r in fleet.changes_across()] == [EAST, WEST]
    assert fleet.changes_across([], since=start) == []
    assert [r.cluster_name for r in
            fleet.changes_across(since=start + timedelta(seconds=30))] == [EAST]


# --------------------------------------------------------------------------- #
# fleet indexes
# --------------------------------------------------------------------------- #
def test_cluster_dimension_filters(fleet):
    assert fleet.cluster_names() == [EAST, WEST]
    assert [c.name for c in fleet.clusters()] == [EAST, WEST]
    assert [c.name for c in fleet.clusters(region="us-east-1")] == [EAST]
    assert [c.name for c in fleet.clusters(hub="hub-west")] == [WEST]
    assert [c.name for c in fleet.clusters(version="4.15.9")] == [WEST]
    assert [c.name for c in fleet.clusters(environment="prod")] == [EAST, WEST]
    # filters intersect
    assert fleet.clusters(region="us-east-1", version="4.15.9") == []
    assert [c.name for c in fleet.clusters(names=[WEST])] == [WEST]
    assert [c.name for c in fleet.clusters(status="critical")] == [WEST]


def test_operator_index(fleet):
    assert fleet.operator_names() == ["etcd", "ingress"]
    index = fleet.operator_index("ingress")
    assert set(index) == {EAST, WEST}
    assert index[EAST].version == "4.16.7" and index[EAST].degraded is False
    assert index[WEST].degraded is True and "router" in index[WEST].message
    assert fleet.operator_index("nope") == {}


def test_namespaces_by_class_team_and_app(fleet):
    everything = fleet.namespaces()
    assert [(n.cluster_name, n.name) for n in everything] == [
        (EAST, "openshift-monitoring"), (EAST, "payments"),
        (WEST, "openshift-monitoring"), (WEST, "payments")]
    assert {n.cluster_name for n in fleet.namespaces(ns_class="application")} == {EAST, WEST}
    assert [n.cluster_name for n in fleet.namespaces(team="payments")] == [EAST]
    assert [n.cluster_name for n in fleet.namespaces(team="risk")] == [WEST]
    # filters intersect, and `clusters` restricts
    assert fleet.namespaces(team="risk", ns_class="platform") == []
    assert [n.name for n in fleet.namespaces(app_name="payments", clusters=[EAST])] == ["payments"]
    assert fleet.namespaces(clusters=[]) == []


def test_top_namespaces_and_nodes(fleet):
    top_ns = fleet.top_namespaces("cpu", 2)
    assert [(n.cluster_name, n.value) for n in top_ns] == [(WEST, 1.5), (EAST, 0.5)]
    assert top_ns[0].name == "payments" and top_ns[0].team == "risk"
    assert [n.cluster_name for n in fleet.top_namespaces("memory", 1)] == [EAST]

    assert [n.cluster_name for n in fleet.nodes()] == [EAST, EAST, WEST, WEST]
    assert [n.name for n in fleet.nodes(clusters=[WEST])] == ["n1", "n2"]
    top_nodes = fleet.top_nodes("cpu", 2)
    assert [(n.cluster_name, n.name) for n in top_nodes] == [(EAST, "n1"), (WEST, "n1")]
    assert top_nodes[0].value == 75.0 and top_nodes[1].value == 50.0
    assert [(n.cluster_name, n.value) for n in fleet.top_nodes("memory", 1)] == [(EAST, 75.0)]


def test_pod_issues_and_counts(fleet):
    assert fleet.pod_issue_counts() == {"application": 2, "platform": 2}
    assert {i.name for i in fleet.pod_issues()} == {"api-3", "prom-1"}
    assert [i.cluster_name for i in fleet.pod_issues(ns_class="platform")] == [EAST, WEST]
    assert [i.name for i in fleet.pod_issues(clusters=[EAST])] == ["prom-1", "api-3"]
    assert fleet.pod_issues(ns_class="application")[0].reason == "CrashLoopBackOff"


def test_fleet_resources_and_status_counts(fleet):
    routes = fleet.fleet_resources("routes")
    assert [(r.cluster_name, r.name) for r in routes] == [(EAST, "api"), (WEST, "api")]
    assert routes[0].summary["host"] == f"api.apps.{EAST}.example.com"
    assert fleet.fleet_resource_count("routes") == 2
    assert fleet.fleet_resource_count("routes", status="admitted") == 2
    assert [r.cluster_name for r in fleet.fleet_resources("routes", status="admitted",
                                                          clusters=[WEST])] == [WEST]
    assert fleet.fleet_resource_count("machineconfigpools", status="degraded") == 1
    assert [r.cluster_name
            for r in fleet.fleet_resources("machineconfigpools", status="degraded")] == [WEST]
    assert fleet.fleet_resources("machineconfigpools", status="nonsense") == []
    # Secrets are deliberately not fleet-indexed: they live in the section only.
    assert fleet.fleet_resource_count("secrets") == 0
    assert {r.key for r in fleet.section(EAST, "resources")} >= {"secrets"}


def test_certificates_ordered_by_expiry(fleet):
    certs = fleet.certificates()
    assert [c.cluster_name for c in certs] == [WEST, EAST]      # west expires sooner
    assert certs[0].name == "api-tls" and certs[0].namespace == "payments"
    assert certs[0].expires_at < certs[1].expires_at
    assert fleet.certificate_count() == 2

    cutoff = (datetime.now(UTC) + timedelta(days=10)).timestamp()
    assert fleet.certificate_count(before=cutoff) == 1
    assert [c.cluster_name for c in fleet.certificates(before=cutoff)] == [WEST]
    assert fleet.certificate_count(after=cutoff) == 1


def test_images_search_and_usages(fleet):
    assert fleet.images() == sorted([APP_IMAGE, CANARY_IMAGE, PLATFORM_IMAGE])
    assert fleet.images("acme") == sorted([APP_IMAGE, CANARY_IMAGE])
    assert fleet.images("prometheus") == [PLATFORM_IMAGE]
    # the search is case-insensitive but hands back the image as spelled
    assert fleet.images("rc1") == [CANARY_IMAGE] == fleet.images("RC1")
    assert fleet.images("nothing-like-this") == []

    usages = fleet.image_usages(APP_IMAGE)
    assert [(u.cluster_name, u.namespace, u.workload_name) for u in usages] == [
        (EAST, "payments", "api"), (WEST, "payments", "api")]
    assert usages[0].registry == "quay.io" and usages[0].repository == "acme/api"
    assert usages[0].tag == "1.0" and usages[0].container == "app"
    assert [u.cluster_name for u in fleet.image_usages(CANARY_IMAGE)] == [WEST]
    assert fleet.image_usages("quay.io/acme/api:9.9") == []


def test_references(fleet):
    refs = fleet.references("Secret", "api-tls")
    assert [(r.cluster_name, r.workload_name, r.via) for r in refs] == [
        (EAST, "api", "env"), (WEST, "api", "env")]
    assert refs[0].ref_kind == "Secret" and refs[0].namespace == "payments"
    assert fleet.references("Secret", "not-mounted") == []


# --------------------------------------------------------------------------- #
# the ledger: a re-write removes exactly what the previous write contributed
# --------------------------------------------------------------------------- #
def test_repersist_drops_stale_index_members(fleet, manifest, documents):
    changed = copy.deepcopy(documents[WEST])
    for ns in changed["namespaces"]:
        if ns["name"] == "payments":
            ns["team"] = "core"                       # team moved
    changed["operators"] = [o for o in changed["operators"] if o["name"] != "ingress"]
    changed["workload_images"] = [i for i in changed["workload_images"]
                                  if i["image"] != CANARY_IMAGE]
    changed["workload_refs"] = [r for r in changed["workload_refs"]
                                if r["ref_name"] != "api-tls"]
    changed["resources"] = [r for r in changed["resources"] if r["key"] != "routes"]
    _persist(fleet, manifest, changed, hub="hub-west")

    assert [n.cluster_name for n in fleet.namespaces(team="risk")] == []
    assert [n.cluster_name for n in fleet.namespaces(team="core")] == [WEST]
    assert set(fleet.operator_index("ingress")) == {EAST}     # east still has it
    assert [r.cluster_name for r in fleet.references("Secret", "api-tls")] == [EAST]
    assert [r.cluster_name for r in fleet.fleet_resources("routes")] == [EAST]
    assert fleet.image_usages(CANARY_IMAGE) == []
    # east still runs the shared image, so its usage survives west dropping it
    assert [u.cluster_name for u in fleet.image_usages(APP_IMAGE)] == [EAST, WEST]

    # the refcount is now zero; finalize_sweep is what actually forgets the name
    assert fleet.images("rc1") == []
    assert fleet.r.hexists(fleet.keys.images, CANARY_IMAGE.lower())
    fleet.finalize_sweep()
    assert not fleet.r.hexists(fleet.keys.images, CANARY_IMAGE.lower())
    assert not fleet.r.hexists(fleet.keys.image_names, CANARY_IMAGE.lower())
    assert fleet.operator_names() == ["etcd", "ingress"]       # east still reports ingress


def test_repersist_moves_cluster_between_dimensions(fleet, manifest, documents):
    changed = copy.deepcopy(documents[EAST])
    changed["version"] = "4.17.1"
    changed["region"] = "eu-central-1"
    _persist(fleet, manifest, changed, hub="hub-east")

    assert fleet.clusters(version="4.16.7") == []
    assert [c.name for c in fleet.clusters(version="4.17.1")] == [EAST]
    assert fleet.clusters(region="us-east-1") == []
    assert [c.name for c in fleet.clusters(region="eu-central-1")] == [EAST]
    assert fleet.cluster_names() == [EAST, WEST]              # still one cluster, not two


def test_unreachable_cluster_stays_visible_but_unindexed(fleet, manifest):
    doc = unreachable({"name": EAST, "region": "us-east-1"}, "connect: timed out")
    _persist(fleet, manifest, doc, hub="hub-east")

    row = fleet.get_cluster(EAST)
    assert row.reachable is False and row.last_error == "connect: timed out"
    assert row.overall_status == "critical" and row.nodes_total == 0
    assert fleet.section(EAST, "nodes") == [] and fleet.section(EAST, "resources") == []
    assert EAST in fleet.cluster_names()
    # its fleet contributions are gone; west's are untouched
    assert set(fleet.operator_index("etcd")) == {WEST}
    assert [n.cluster_name for n in fleet.namespaces()] == [WEST, WEST]
    assert [c.cluster_name for c in fleet.certificates()] == [WEST]
    assert [u.cluster_name for u in fleet.image_usages(APP_IMAGE)] == [WEST]
    assert fleet.pod_issue_counts() == {"application": 1, "platform": 1}
    assert fleet.section(EAST, "health_checks")[0].name == "cluster-reachable"


# --------------------------------------------------------------------------- #
# lifecycle
# --------------------------------------------------------------------------- #
def test_delete_cluster(fleet):
    fleet.delete_cluster(EAST)
    assert fleet.cluster_names() == [WEST]
    assert fleet.get_cluster(EAST) is None
    assert fleet.section(EAST, "nodes") == [] and fleet.snapshots(EAST) == []
    assert set(fleet.operator_index("etcd")) == {WEST}
    assert [n.cluster_name for n in fleet.nodes()] == [WEST, WEST]
    assert fleet.certificate_count() == 1
    assert fleet.fleet_resource_count("routes") == 1


def test_prune_vanished_keeps_clusters_of_unreachable_hubs(fleet):
    # hub-east answered and no longer lists east; hub-west did not answer at all
    removed = fleet.prune_vanished({"hub-east": set()})
    assert removed == [EAST]
    assert fleet.cluster_names() == [WEST]

    # nothing discovered anywhere, but no hub is claimed reachable: keep everything
    assert fleet.prune_vanished({}) == []
    assert fleet.cluster_names() == [WEST]

    # a cluster still discovered on its hub survives
    assert fleet.prune_vanished({"hub-west": {WEST}}) == []
    assert fleet.cluster_names() == [WEST]


def test_prune_vanished_drops_expired_clusters(fleet):
    for key in fleet.keys.expiring_keys(WEST):
        fleet.r.delete(key)                       # what a TTL expiry leaves behind
    assert fleet.prune_vanished({}) == [WEST]
    assert fleet.cluster_names() == [EAST]
    # The ledger survived the expiry, so the cluster's fleet contributions are
    # unpublished too: no zombie namespaces, resources or images.
    assert {n.cluster_name for n in fleet.namespaces()} == {EAST}
    assert {r.cluster_name for r in fleet.fleet_resources("routes")} <= {EAST}
    assert all(r.cluster_name == EAST for r in fleet.pod_issues())
    assert fleet.r.exists(fleet.keys.ledger(WEST)) == 0


def test_ttl_is_set_only_when_configured(make_store, manifest, documents):
    store = make_store(ttl_seconds=3600)
    _persist(store, manifest, documents[EAST])
    for key in store.keys.expiring_keys(EAST):
        # The change log only exists once something has changed, and a first
        # sweep changes nothing; every other per-cluster key is written here.
        if key == store.keys.changes(EAST):
            continue
        assert 0 < store.r.ttl(key) <= 3600, key

    changed = copy.deepcopy(documents[EAST])
    changed["version"] = "4.17.1"
    _persist(store, manifest, changed)
    assert 0 < store.r.ttl(store.keys.changes(EAST)) <= 3600
    assert store.r.ttl(store.keys.ledger(EAST)) == -1      # the ledger outlives the data
    assert store.r.ttl(store.keys.clusters) == -1          # fleet keys never expire

    forever = make_store(ttl_seconds=0)
    _persist(forever, manifest, documents[EAST])
    assert forever.r.ttl(forever.keys.summary(EAST)) == -1


def test_refresh_lock_is_single_flight(store):
    assert store.try_lock(EAST, 5000) is True
    assert store.try_lock(EAST, 5000) is False
    assert store.try_lock(WEST, 5000) is True      # per cluster, not global
    store.unlock(EAST)
    assert store.try_lock(EAST, 5000) is True


def test_hubs_are_upserted_field_by_field(store):
    store.upsert_hub("hub-east", region="us-east-1", reachable=True, managed_count=4,
                     last_synced=datetime.now(UTC))
    store.upsert_hub("hub-east", reachable=False, last_error="timeout")
    store.upsert_hub("hub-west", region="us-west-2", reachable=True)

    hubs = {h.name: h for h in store.hubs()}
    assert [h.name for h in store.hubs()] == ["hub-east", "hub-west"]
    assert hubs["hub-east"].region == "us-east-1"           # untouched by the second write
    assert hubs["hub-east"].reachable is False and hubs["hub-east"].last_error == "timeout"
    assert hubs["hub-east"].managed_count == 4
    assert isinstance(hubs["hub-east"].last_synced, datetime)


def test_runs_are_recorded(store):
    assert store.last_run() is None
    first = store.begin_run("startup")
    second = store.begin_run("scheduled")
    assert first != second

    store.finish_run(second, finished_at=datetime.now(UTC), duration_ms=91,
                     hubs_total=2, clusters_total=7, clusters_ok=6, clusters_failed=1)
    runs = store.runs(10)
    assert [r.id for r in runs] == [second, first]          # newest first
    assert runs[0].duration_ms == 91 and runs[0].clusters_failed == 1
    assert isinstance(runs[0].started_at, datetime) and isinstance(runs[0].finished_at, datetime)
    assert runs[1].finished_at is None
    assert store.last_run() == {"at": runs[0].finished_at, "ok": True, "trigger": "scheduled"}

    store.finish_run(first, finished_at=datetime.now(UTC), error="boom")
    assert store.last_run()["ok"] is False
    assert store.runs(1)[0].id == second                    # order is by insertion, not finish


def test_member_separator_is_rejected(store, manifest, documents):
    doc = copy.deepcopy(documents[EAST])
    doc["name"] = "bad|name"
    with pytest.raises(ValueError, match="contains"):
        _persist(store, manifest, doc)


def test_update_summary_sets_fields_without_rewriting(store, manifest, documents):
    doc = next(iter(documents.values()))
    _persist(store, manifest, doc)
    name = doc["name"]
    before = store.get_cluster(name)
    store.update_summary(name, timings={"fetch_ms": 12, "persist_ms": 3})
    after = store.get_cluster(name)
    assert after.timings == {"fetch_ms": 12, "persist_ms": 3}
    assert after.ocp_version == before.ocp_version and after.last_synced == before.last_synced
    store.update_summary("no-such-cluster", timings={})       # a no-op, not an error
    assert store.get_cluster("no-such-cluster") is None


def test_progress_is_published_per_instance_and_expires(store):
    store.set_progress("hubA#h:1", {"running": True, "total": 10, "done": 3}, ttl_seconds=60)
    store.set_progress("hubB#h:2", {"running": False, "total": 5, "done": 5}, ttl_seconds=60)
    rows = {p["instance"]: p for p in store.progress_all()}
    assert rows["hubA#h:1"]["done"] == 3 and rows["hubB#h:2"]["running"] is False
    store.clear_progress("hubA#h:1")
    assert [p["instance"] for p in store.progress_all()] == ["hubB#h:2"]
    store.set_progress("hubC#h:3", {"running": True, "total": 1, "done": 0}, ttl_seconds=1)
    assert store.r.ttl(store.keys.progress("hubC#h:3")) >= 0     # expires on its own
