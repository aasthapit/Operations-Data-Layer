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


def _persist(store, manifest, doc, hub="hub-east"):
    thresholds = manifest.describe()["thresholds"]
    checks, overall, score, counts = run_health_checks(doc, "4.15.0", thresholds)
    store.persist_cluster(hub, doc, checks, overall, score, counts)
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
        assert 0 < store.r.ttl(key) <= 3600, key
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
