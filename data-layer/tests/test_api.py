"""
The REST API, end to end over the store.

Two clusters are collected exactly the way the runner collects them - assemble
the document from raw API objects, run the health checks, persist - into a
fake-Redis store. Every endpoint then has to answer from those keys alone, so
these tests exercise the port rather than the fixtures: a router that reached
for something the store does not hold would fail here.

  ocp-east-1   us-east-1 / prod    / hub-east  4.16.7   healthy
  ocp-west-1   us-west-2 / staging / hub-west  4.15.30  degraded ingress operator

Both run the same nginx image, and both host the `payments` application.
"""
import base64
from datetime import UTC, datetime

import fakeredis
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import store as store_module
from app.api import (
    admin,
    applications,
    blast_radius,
    clusters,
    health,
    insights,
    metrics,
    versions,
)
from app.api import (
    manifest as manifest_api,
)
from app.collector import runner
from app.collector.collect import assemble
from app.collector.healthchecks import run_health_checks
from app.manifest import get_manifest
from app.settings import settings
from app.store.redis_store import RedisStore
from tests.conftest import make_cert_pem
from tests.test_parsers import NOW, _pod

NGINX = "docker.io/library/nginx:1.25"
APP_LABELS = {"odl.io/app": "payments", "odl.io/team": "payments", "odl.io/tier": "critical"}
RISK_LABELS = {"odl.io/app": "fraud", "odl.io/team": "risk", "odl.io/tier": "standard"}


# --------------------------------------------------------------------------- #
# raw API objects
# --------------------------------------------------------------------------- #
def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode()


def _ns(name, labels=None):
    return {"metadata": {"name": name, "labels": labels or {}}, "status": {"phase": "Active"}}


def _node(name, cpu="4", mem="16Gi"):
    return {"metadata": {"name": name}, "status": {
        "capacity": {"cpu": cpu, "memory": mem, "pods": "110"},
        "allocatable": {"cpu": cpu, "memory": mem, "pods": "110"},
        "conditions": [{"type": "Ready", "status": "True"}], "nodeInfo": {}}}


def _node_metrics(name, cpu, mem):
    return {"metadata": {"name": name}, "usage": {"cpu": cpu, "memory": mem}}


def _pod_metrics(namespace, cpu, mem):
    return {"metadata": {"namespace": namespace}, "containers": [{"usage": {"cpu": cpu, "memory": mem}}]}


def _operator(name, version, degraded=False):
    return {"metadata": {"name": name}, "status": {
        "versions": [{"name": "operator", "version": version}],
        "conditions": [
            {"type": "Available", "status": "True"},
            {"type": "Progressing", "status": "False"},
            {"type": "Degraded", "status": "True" if degraded else "False",
             "message": "router pods are crashlooping" if degraded else ""},
        ]}}


def _deployment(name, namespace, image, replicas=2, ready=2):
    return {"metadata": {"name": name, "namespace": namespace, "labels": {}},
            "spec": {"replicas": replicas, "template": {"spec": {"containers": [
                {"name": "app", "image": image,
                 "env": [{"name": "TOKEN", "valueFrom": {
                     "secretKeyRef": {"name": f"{name}-secret", "key": "token"}}}]}]}}},
            "status": {"readyReplicas": ready, "availableReplicas": ready,
                       "updatedReplicas": replicas}}


def _cert_secret(name, namespace, days):
    pem, _ = make_cert_pem(cn=f"{name}.example.com", days=days)
    return {"metadata": {"name": name, "namespace": namespace}, "type": "kubernetes.io/tls",
            "data": {"tls.crt": _b64(pem)}}


def _route(name, namespace, host, admitted=True):
    return {"metadata": {"name": name, "namespace": namespace},
            "spec": {"host": host, "to": {"name": name}, "tls": {"termination": "edge"}},
            "status": {"ingress": [{"routerName": "default", "conditions": [
                {"type": "Admitted", "status": "True" if admitted else "False"}]}]}}


def _quota(name, namespace, used, hard):
    return {"metadata": {"name": name, "namespace": namespace},
            "status": {"hard": {"requests.cpu": hard}, "used": {"requests.cpu": used}}}


def _csv(package, version, phase, namespace="openshift-operators"):
    return {"metadata": {"name": f"{package}.v{version}", "namespace": namespace,
                         "labels": {f"operators.coreos.com/{package}.{namespace}": ""}},
            "spec": {"displayName": "Elasticsearch Operator", "version": version,
                     "provider": {"name": "Red Hat"}},
            "status": {"phase": phase, "reason": "InstallSucceeded"}}


def _subscription(package, installed, current, namespace="openshift-operators"):
    return {"metadata": {"name": package, "namespace": namespace},
            "spec": {"name": package, "channel": "stable", "source": "redhat-operators",
                     "installPlanApproval": "Automatic"},
            "status": {"installedCSV": installed, "currentCSV": current, "state": "AtLatestKnown"}}


def _pvc(name, namespace, phase, storage_class="gp3"):
    return {"metadata": {"name": name, "namespace": namespace},
            "spec": {"storageClassName": storage_class,
                     "resources": {"requests": {"storage": "10Gi"}}},
            "status": {"phase": phase, "capacity": {"storage": "10Gi"}}}


def _storageclass(name, provisioner, default=False):
    annotations = {"storageclass.kubernetes.io/is-default-class": "true"} if default else {}
    return {"metadata": {"name": name, "annotations": annotations},
            "provisioner": provisioner, "reclaimPolicy": "Delete", "volumeBindingMode": "Immediate"}


def _clusterrolebinding(name, group):
    return {"metadata": {"name": name}, "roleRef": {"name": "cluster-admin"},
            "subjects": [{"kind": "Group", "name": group}]}


def _mcp(name, degraded=False):
    return {"metadata": {"name": name}, "status": {
        "machineCount": 3, "readyMachineCount": 3, "updatedMachineCount": 3,
        "conditions": [{"type": "Updated", "status": "False" if degraded else "True"},
                       {"type": "Updating", "status": "False"},
                       {"type": "Degraded", "status": "True" if degraded else "False",
                        "message": "node lost its config" if degraded else ""}]}}


def _event(name, namespace, reason, minute):
    return {"metadata": {"name": name, "namespace": namespace}, "type": "Warning",
            "reason": reason, "message": "back-off restarting failed container",
            "involvedObject": {"kind": "Pod", "name": "scorer-1", "namespace": namespace},
            "lastTimestamp": f"2026-09-10T11:{minute:02d}:00Z"}


# --------------------------------------------------------------------------- #
# the two clusters
# --------------------------------------------------------------------------- #
def _east_raw():
    return {
        "clusterversion": {"spec": {"channel": "stable-4.16"},
                           "status": {"desired": {"version": "4.16.7"},
                                      "history": [{"state": "Completed", "version": "4.16.7"}],
                                      "conditions": []}},
        "infrastructure": {"status": {"platform": "AWS", "infrastructureName": "east-x9",
                                      "apiServerURL": "https://api.east.example.com:6443"}},
        "network_config": {"status": {"networkType": "OVNKubernetes"}},
        "ingress_config": {"spec": {"domain": "apps.east.example.com"}},
        "clusteroperators": [_operator("authentication", "4.16.7"), _operator("ingress", "4.16.7")],
        "nodes": [_node("east-n1"), _node("east-n2")],
        "node_metrics": [_node_metrics("east-n1", "2", "6Gi"), _node_metrics("east-n2", "1", "4Gi")],
        "namespaces": [_ns("payments", APP_LABELS), _ns("openshift-monitoring")],
        "pods": [_pod("api-1", "payments", node="east-n1"),
                 _pod("api-2", "payments", node="east-n1", claim="payments-data"),
                 _pod("prom-1", "openshift-monitoring", node="east-n2")],
        "pod_metrics": [_pod_metrics("payments", "500m", "1Gi"),
                        _pod_metrics("openshift-monitoring", "200m", "512Mi")],
        "deployments": [_deployment("api", "payments", NGINX)],
        "secrets": [_cert_secret("api-tls", "payments", days=400)],
        "routes": [_route("payments", "payments", "payments.apps.east.example.com")],
        "resourcequotas": [_quota("compute", "payments", "5", "20")],
        "clusterserviceversions": [_csv("elasticsearch-operator", "5.8.1", "Succeeded")],
        "subscriptions": [_subscription("elasticsearch-operator",
                                        "elasticsearch-operator.v5.8.1",
                                        "elasticsearch-operator.v5.8.1")],
        "persistentvolumeclaims": [_pvc("payments-data", "payments", "Bound")],
        "storageclasses": [_storageclass("gp3", "ebs.csi.aws.com", default=True)],
        "clusterrolebindings": [_clusterrolebinding("sre-admins", "sre-team")],
        "events": [_event("e1", "payments", "Unhealthy", 10),
                   _event("e2", "payments", "BackOff", 11)],
    }


def _west_raw():
    return {
        "clusterversion": {"spec": {"channel": "stable-4.15"},
                           "status": {"desired": {"version": "4.15.30"},
                                      "history": [{"state": "Completed", "version": "4.15.30"}],
                                      "conditions": []}},
        "infrastructure": {"status": {"platform": "AWS", "infrastructureName": "west-k2",
                                      "apiServerURL": "https://api.west.example.com:6443"}},
        "network_config": {"status": {"networkType": "OVNKubernetes"}},
        "ingress_config": {"spec": {"domain": "apps.west.example.com"}},
        "clusteroperators": [_operator("authentication", "4.15.30"),
                             _operator("ingress", "4.15.30", degraded=True)],
        "nodes": [_node("west-n1"), _node("west-n2")],
        "node_metrics": [_node_metrics("west-n1", "3", "10Gi"), _node_metrics("west-n2", "1", "2Gi")],
        "namespaces": [_ns("payments", APP_LABELS), _ns("risk", RISK_LABELS),
                       _ns("openshift-ingress"), _ns("openshift-monitoring")],
        "pods": [_pod("api-1", "payments", node="west-n1"),
                 _pod("scorer-1", "risk", waiting="CrashLoopBackOff", restarts=9,
                      owner=("ReplicaSet", "scorer-abc"), hash_="abc", node="west-n1"),
                 _pod("prom-1", "openshift-monitoring", waiting="ImagePullBackOff",
                      owner=("StatefulSet", "prometheus-k8s"), node="west-n2")],
        "pod_metrics": [_pod_metrics("risk", "1500m", "2Gi"),
                        _pod_metrics("payments", "250m", "512Mi")],
        "deployments": [_deployment("api", "payments", NGINX),
                        _deployment("scorer", "risk", NGINX, ready=0),
                        _deployment("router", "openshift-ingress", NGINX)],
        "secrets": [_cert_secret("risk-tls", "risk", days=5),
                    _cert_secret("legacy-tls", "risk", days=-2)],
        "routes": [_route("risk", "risk", "risk.apps.west.example.com", admitted=False)],
        "resourcequotas": [_quota("compute", "risk", "19", "20")],
        "clusterserviceversions": [_csv("elasticsearch-operator", "5.8.0", "Failed")],
        "subscriptions": [_subscription("elasticsearch-operator",
                                        "elasticsearch-operator.v5.8.0",
                                        "elasticsearch-operator.v5.8.1")],
        "persistentvolumeclaims": [_pvc("risk-data", "risk", "Pending")],
        "storageclasses": [_storageclass("gp3", "ebs.csi.aws.com", default=True)],
        "machineconfigpools": [_mcp("worker", degraded=True)],
        "clusterrolebindings": [_clusterrolebinding("sre-admins", "sre-team")],
        "events": [_event(f"e{i}", "risk", "BackOff", i) for i in range(3)],
    }


def _persist(store, manifest, hub, meta, raw, status_overrides=None):
    """Collect and persist one cluster, the way runner._persist does."""
    status = {key: {"status": "collected", "count": len(value) if isinstance(value, list) else 1,
                    "duration_ms": 5, "error": None}
              for key, value in raw.items()}
    status.update(status_overrides or {})
    collected = assemble(meta, raw, status, manifest, NOW)
    collected["collect_ms"] = 42
    checks, overall, score, counts = run_health_checks(
        collected, settings.supported_floor, manifest.describe()["thresholds"])
    store.persist_cluster(hub, collected, checks, overall, score, counts)
    return collected


@pytest.fixture(scope="module")
def store():
    manifest = get_manifest()
    st = RedisStore(fakeredis.FakeRedis())
    now = datetime.now(UTC)
    st.upsert_hub("hub-east", region="us-east-1", datacenter="dc-east",
                  managed_count=1, reachable=True, last_synced=now)
    st.upsert_hub("hub-west", region="us-west-2", datacenter="dc-west",
                  managed_count=1, reachable=True, last_synced=now)
    run_id = st.begin_run("test")
    _persist(st, manifest, "hub-east",
             {"name": "ocp-east-1", "region": "us-east-1", "datacenter": "dc-east",
              "environment": "prod", "cloud": "aws", "vendor": "OpenShift",
              "managed_available": True},
             _east_raw(),
             # this cluster has no MachineConfigPool API, which is itself data
             {"machineconfigpools": {"status": "unavailable", "count": 0, "duration_ms": 1,
                                     "error": "the server could not find the requested resource"}})
    _persist(st, manifest, "hub-west",
             {"name": "ocp-west-1", "region": "us-west-2", "datacenter": "dc-west",
              "environment": "staging", "cloud": "aws", "vendor": "OpenShift",
              "managed_available": True},
             _west_raw())
    st.finish_run(run_id, duration_ms=1234, hubs_total=2, clusters_total=2,
                  clusters_ok=2, clusters_failed=0, error=None)
    st.finalize_sweep()
    return st


@pytest.fixture()
def client(store):
    """The routers over the fixture store, without main.py's Redis-waiting lifespan."""
    app = FastAPI()
    for module in (clusters, applications, health, versions, blast_radius,
                   insights, metrics, manifest_api, admin):
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
# health
# --------------------------------------------------------------------------- #
def test_overview(client):
    d = _get(client, "/api/health/overview")
    assert d["clusters_total"] == 2
    assert d["counts"] == {"healthy": 1, "warning": 0, "critical": 1, "unknown": 0}
    assert d["upgrading"] == 0
    assert [h["name"] for h in d["hubs"]] == ["hub-east", "hub-west"]
    assert d["hubs"][0]["region"] == "us-east-1" and d["hubs"][0]["reachable"] is True
    assert d["last_collection"]["clusters_ok"] == 2
    assert d["last_collection"]["duration_ms"] == 1234


def test_summary_groups_by_dimension(client):
    d = _get(client, "/api/health/summary", group_by="region")
    assert d["group_by"] == "region"
    assert [g["key"] for g in d["groups"]] == ["us-east-1", "us-west-2"]
    east, west = d["groups"]
    assert east["total"] == 1 and east["counts"]["healthy"] == 1 and east["rollup_status"] == "healthy"
    assert west["counts"]["critical"] == 1 and west["rollup_status"] == "critical"

    env = _get(client, "/api/health/summary", group_by="environment")
    assert [g["key"] for g in env["groups"]] == ["prod", "staging"]
    # an unknown dimension falls back to the primary dimension rather than erroring
    assert _get(client, "/api/health/summary", group_by="nonsense")["group_by"] == "hub"


# --------------------------------------------------------------------------- #
# clusters
# --------------------------------------------------------------------------- #
def test_cluster_list_and_filters(client):
    d = _get(client, "/api/clusters")
    assert d["count"] == 2
    assert [c["name"] for c in d["clusters"]] == ["ocp-east-1", "ocp-west-1"]
    east = d["clusters"][0]
    assert east["ocp_version"] == "4.16.7" and east["overall_status"] == "healthy"
    assert east["nodes"] == {"ready": 2, "total": 2}
    assert east["namespaces"] == {"application": 1, "platform": 1}
    assert east["utilization"]["cpu_percent"] == 37.5
    # freshly persisted, so it cannot be stale
    assert east["stale"] is False and 0 <= east["age_seconds"] < 3 * settings.refresh_interval_seconds

    assert [c["name"] for c in _get(client, "/api/clusters", region="us-west-2")["clusters"]] \
        == ["ocp-west-1"]
    assert _get(client, "/api/clusters", status="healthy")["count"] == 1
    assert _get(client, "/api/clusters", version="4.15.30")["count"] == 1
    assert _get(client, "/api/clusters", environment="prod")["count"] == 1
    assert _get(client, "/api/clusters", hub="hub-west")["count"] == 1
    # team is a namespace property, resolved through the namespace index
    assert [c["name"] for c in _get(client, "/api/clusters", team="payments")["clusters"]] \
        == ["ocp-east-1", "ocp-west-1"]
    assert [c["name"] for c in _get(client, "/api/clusters", team="risk")["clusters"]] \
        == ["ocp-west-1"]


def test_cluster_detail(client):
    d = _get(client, "/api/clusters/ocp-west-1")
    assert d["name"] == "ocp-west-1" and d["overall_status"] == "critical"
    assert d["infrastructure_name"] == "west-k2"
    assert d["platform_config"]["network_type"] == "OVNKubernetes"
    assert d["platform_config"]["apps_domain"] == "apps.west.example.com"
    assert d["capacity"]["cpu"]["allocatable_cores"] == 8.0
    assert d["capacity"]["cpu"]["used_cores"] == 4.0 and d["capacity"]["cpu"]["used_percent"] == 50.0

    assert [o["name"] for o in d["operators"]] == ["authentication", "ingress"]
    assert d["operators"][1]["degraded"] is True
    assert [n["name"] for n in d["nodes_detail"]] == ["west-n1", "west-n2"]
    assert [n["name"] for n in d["namespaces_detail"]] == [
        "openshift-ingress", "openshift-monitoring", "payments", "risk"]
    assert [a["name"] for a in d["applications"]] == ["fraud", "payments"]
    assert [(i["namespace"], i["name"]) for i in d["pod_issues_detail"]] == [
        ("risk", "scorer-1"), ("openshift-monitoring", "prom-1")]
    checks = {c["name"]: c["status"] for c in d["health_checks"]}
    assert checks["no-degraded-operators"] == "fail"
    assert checks["nodes-ready"] == "pass"
    status_keys = {r["key"]: r["status"] for r in d["resource_status"]}
    assert status_keys["routes"] == "collected"

    assert client.get("/api/clusters/nope").status_code == 404


def test_cluster_sections(client):
    ops = _get(client, "/api/clusters/ocp-east-1/operators")
    assert [o["name"] for o in ops["operators"]] == ["authentication", "ingress"]

    hp = _get(client, "/api/clusters/ocp-east-1/health")
    assert hp["overall_status"] == "healthy" and hp["health_score"] == 100
    assert all(c["status"] == "pass" for c in hp["checks"])

    nodes = _get(client, "/api/clusters/ocp-east-1/nodes")
    assert [n["name"] for n in nodes["nodes"]] == ["east-n1", "east-n2"]
    assert nodes["nodes"][0]["cpu"]["used_cores"] == 2.0
    assert nodes["nodes"][0]["pods"]["running"] == 2

    ns = _get(client, "/api/clusters/ocp-west-1/namespaces")
    # ordered by class then name, exactly as the SQL query was
    assert [n["name"] for n in ns["namespaces"]] == [
        "payments", "risk", "openshift-ingress", "openshift-monitoring"]
    apps_only = _get(client, "/api/clusters/ocp-west-1/namespaces", **{"class": "application"})
    assert [n["name"] for n in apps_only["namespaces"]] == ["payments", "risk"]
    assert apps_only["namespaces"][1]["team"] == "risk" and apps_only["namespaces"][1]["app"] == "fraud"
    assert _get(client, "/api/clusters/ocp-west-1/namespaces", status="critical")["count"] == 1

    wl = _get(client, "/api/clusters/ocp-west-1/workloads")
    assert [(w["namespace"], w["name"]) for w in wl["workloads"]] == [
        ("openshift-ingress", "router"), ("payments", "api"), ("risk", "scorer")]
    assert wl["workloads"][2]["status"] == "degraded"
    assert "containers" not in wl["workloads"][0]
    detailed = _get(client, "/api/clusters/ocp-west-1/workloads", namespace="risk", detail=True)
    assert detailed["count"] == 1 and detailed["workloads"][0]["config_refs"]

    issues = _get(client, "/api/clusters/ocp-west-1/pod-issues")
    assert [i["name"] for i in issues["pod_issues"]] == ["scorer-1", "prom-1"]
    assert issues["pod_issues"][0]["reason"] == "CrashLoopBackOff"
    assert _get(client, "/api/clusters/ocp-west-1/pod-issues",
                **{"class": "platform"})["count"] == 1

    res = _get(client, "/api/clusters/ocp-west-1/resources", kind="secrets")
    assert [r["name"] for r in res["resources"]] == ["legacy-tls", "risk-tls"]
    assert _get(client, "/api/clusters/ocp-west-1/resources", limit=3)["count"] == 3

    assert client.get("/api/clusters/nope/nodes").status_code == 404


def test_timeline_has_one_point_per_sweep(client):
    d = _get(client, "/api/clusters/ocp-east-1/timeline")
    assert len(d["snapshots"]) == 1
    point = d["snapshots"][0]
    assert point["overall_status"] == "healthy" and point["ocp_version"] == "4.16.7"
    assert point["cpu_used_cores"] == 3.0 and point["pods_running"] == 3
    assert point["at"]


def test_refresh_one_cluster(client, monkeypatch):
    calls = []

    def fake_refresh(name):
        calls.append(name)
        if name == "nope":
            return {"ok": False, "error": "unknown cluster"}
        if name == "busy":
            return {"skipped": True, "reason": "a refresh is already running"}
        return {"ok": True, "cluster": name, "duration_ms": 12}

    monkeypatch.setattr(runner, "refresh_cluster", fake_refresh)
    assert client.post("/api/clusters/ocp-east-1/refresh").json()["ok"] is True
    assert client.post("/api/clusters/nope/refresh").status_code == 404
    assert client.post("/api/clusters/busy/refresh").status_code == 409
    assert calls == ["ocp-east-1", "nope", "busy"]


# --------------------------------------------------------------------------- #
# applications
# --------------------------------------------------------------------------- #
def test_applications_group_across_clusters(client):
    d = _get(client, "/api/applications")
    assert d["count"] == 2 and d["teams"] == ["payments", "risk"]
    fraud, payments = d["applications"]
    assert fraud["app"] == "fraud" and payments["app"] == "payments"
    assert payments["team"] == "payments" and payments["tier"] == "critical"
    assert payments["cluster_count"] == 2
    assert payments["environments"] == ["prod", "staging"]
    assert payments["regions"] == ["us-east-1", "us-west-2"]
    assert [p["cluster"] for p in payments["placements"]] == ["ocp-east-1", "ocp-west-1"]
    assert payments["placements"][0]["ocp_version"] == "4.16.7"
    assert fraud["status"] == "critical" and fraud["pod_issues"] == 1

    assert _get(client, "/api/applications", team="risk")["count"] == 1
    assert _get(client, "/api/applications", tier="critical")["count"] == 1
    assert _get(client, "/api/applications", environment="prod")["count"] == 1
    assert _get(client, "/api/applications", region="us-west-2")["count"] == 2
    assert _get(client, "/api/applications", cluster="ocp-east-1")["count"] == 1
    assert _get(client, "/api/applications", status="critical")["count"] == 1


def test_application_detail(client):
    d = _get(client, "/api/applications/payments")
    assert d["cluster_count"] == 2
    assert [n["name"] for n in d["namespaces"]] == ["payments", "payments"]
    assert [(w["cluster"], w["name"]) for w in d["workloads_detail"]] == [
        ("ocp-east-1", "api"), ("ocp-west-1", "api")]
    assert d["workloads_detail"][0]["images"] == [NGINX]
    assert d["workloads_detail"][0]["containers"]
    assert client.get("/api/applications/nope").status_code == 404


# --------------------------------------------------------------------------- #
# versions
# --------------------------------------------------------------------------- #
def test_versions(client):
    d = _get(client, "/api/versions")
    assert d["distinct_versions"] == 2
    assert [v["version"] for v in d["versions"]] == ["4.16.7", "4.15.30"]
    assert d["versions"][0]["clusters"][0]["name"] == "ocp-east-1"
    assert d["channels"] == [{"channel": "stable-4.15", "count": 1},
                             {"channel": "stable-4.16", "count": 1}]

    ops = _get(client, "/api/versions/operators")
    assert [o["operator"] for o in ops["operators"]] == ["authentication", "ingress"]
    assert ops["operators"][0]["versions"] == [{"version": "4.16.7", "count": 1},
                                               {"version": "4.15.30", "count": 1}]
    one = _get(client, "/api/versions/operators", name="ingress")
    assert [o["operator"] for o in one["operators"]] == ["ingress"]
    assert _get(client, "/api/versions/operators", name="nope")["operators"] == []


# --------------------------------------------------------------------------- #
# blast radius
# --------------------------------------------------------------------------- #
def test_blast_radius_by_image(client):
    d = _get(client, "/api/blast-radius", image="nginx")
    assert [c["name"] for c in d["clusters"]] == ["ocp-east-1", "ocp-west-1"]
    assert d["summary"]["clusters_impacted"] == 2
    assert d["summary"]["workloads_impacted"] == 4
    assert d["summary"]["by_environment"] == {"prod": 1, "staging": 1}
    assert d["summary"]["by_region"] == {"us-east-1": 1, "us-west-2": 1}
    # a platform namespace runs it too, which is worth calling out separately
    assert d["summary"]["platform_namespaces_impacted"] == ["openshift-ingress"]
    # critical tier first, then by breadth
    assert [a["app"] for a in d["applications"]] == ["payments", "fraud"]
    assert d["applications"][0]["cluster_count"] == 2
    assert d["summary"]["critical_applications"] == 1
    assert d["summary"]["teams_impacted"] == 2
    assert [(w["cluster"], w["namespace"], w["name"]) for w in d["workloads"]] == [
        ("ocp-east-1", "payments", "api"), ("ocp-west-1", "openshift-ingress", "router"),
        ("ocp-west-1", "payments", "api"), ("ocp-west-1", "risk", "scorer")]
    assert d["clusters"][0]["reason"] == f"image {NGINX}"


def test_blast_radius_by_version_and_operator(client):
    d = _get(client, "/api/blast-radius", ocp_version="4.16.7")
    assert [c["name"] for c in d["clusters"]] == ["ocp-east-1"]
    assert d["clusters"][0]["reason"] == "OCP 4.16.7"
    # an OCP query impacts every application on the cluster, not just some
    assert [a["app"] for a in d["applications"]] == ["payments"]

    d = _get(client, "/api/blast-radius", operator="ingress", degraded_only=True)
    assert [c["name"] for c in d["clusters"]] == ["ocp-west-1"]
    assert d["clusters"][0]["reason"] == "ingress 4.15.30 (degraded)"
    assert {a["app"] for a in d["applications"]} == {"payments", "fraud"}

    assert _get(client, "/api/blast-radius", operator="ingress")["summary"]["clusters_impacted"] == 2
    pinned = _get(client, "/api/blast-radius", operator="ingress", operator_version="4.16.7")
    assert [c["name"] for c in pinned["clusters"]] == ["ocp-east-1"]

    olm = _get(client, "/api/blast-radius", olm_operator="elasticsearch-operator", olm_version="5.8.0")
    assert [c["name"] for c in olm["clusters"]] == ["ocp-west-1"]

    # intersecting two axes narrows rather than widens
    both = _get(client, "/api/blast-radius", ocp_version="4.16.7", operator="ingress")
    assert [c["name"] for c in both["clusters"]] == ["ocp-east-1"]

    assert client.get("/api/blast-radius").status_code == 400


# --------------------------------------------------------------------------- #
# insights
# --------------------------------------------------------------------------- #
def test_insights_summary_counters(client):
    d = _get(client, "/api/insights/summary")
    assert d["certificates"] == {"expired": 1, "expiring": 1}
    assert d["pod_issues"] == {"platform": 1, "application": 1}
    assert d["quotas_near_limit"] == 1
    assert d["machine_config_pools"] == {"degraded": 1, "updating": 0}
    assert d["olm_operators_unhealthy"] == 1
    assert d["olm_upgrades_pending"] == 1
    assert d["pvcs_pending"] == 1
    assert d["routes_rejected"] == 1
    assert d["warning_events"] == 5
    assert d["applications"] == 2
    assert d["clusters_without_metrics"] == 0


def test_insights_certificates_sorted_by_expiry(client):
    d = _get(client, "/api/insights/certificates")
    assert d["within_days"] == 30
    assert [c["name"] for c in d["certificates"]] == ["legacy-tls", "risk-tls"]
    assert d["certificates"][0]["status"] == "expired"
    assert d["certificates"][0]["days_left"] < 0 < d["certificates"][1]["days_left"]
    assert d["certificates"][0]["region"] == "us-west-2"
    assert d["certificates"][0]["certificates"][0]["subject"]

    everything = _get(client, "/api/insights/certificates", include_valid=True)
    assert [c["name"] for c in everything["certificates"]] == ["legacy-tls", "risk-tls", "api-tls"]
    assert _get(client, "/api/insights/certificates", cluster="ocp-east-1",
                include_valid=True)["count"] == 1


def test_insights_pod_issues(client):
    d = _get(client, "/api/insights/pod-issues")
    assert d["count"] == 2
    assert d["by_reason"] == {"CrashLoopBackOff": 1, "ImagePullBackOff": 1}
    # ordered by class, then cluster, then namespace
    assert [i["name"] for i in d["pod_issues"]] == ["scorer-1", "prom-1"]
    assert _get(client, "/api/insights/pod-issues", reason="CrashLoopBackOff")["count"] == 1
    assert _get(client, "/api/insights/pod-issues", cluster="ocp-east-1")["count"] == 0


def test_insights_resource_views(client):
    quotas = _get(client, "/api/insights/quotas")
    assert [q["cluster"] for q in quotas["quotas"]] == ["ocp-west-1", "ocp-east-1"]
    assert quotas["quotas"][0]["status"] == "warning" and quotas["quotas"][0]["max_percent"] == 95.0
    assert _get(client, "/api/insights/quotas", min_percent=90)["count"] == 1

    olm = _get(client, "/api/insights/olm-operators")
    pkg = olm["operators"][0]
    assert pkg["package"] == "elasticsearch-operator" and pkg["clusters"] == 2
    assert pkg["unhealthy"] == 1 and pkg["upgrades_pending"] == 1
    assert pkg["versions"] == [{"version": "5.8.1", "count": 1}, {"version": "5.8.0", "count": 1}]
    assert pkg["installs"][1]["upgrade_to"] == "elasticsearch-operator.v5.8.1"

    mcps = _get(client, "/api/insights/machine-config-pools")
    assert [m["pool"] for m in mcps["pools"]] == ["worker"]
    assert mcps["pools"][0]["status"] == "degraded" and mcps["pools"][0]["region"] == "us-west-2"

    storage = _get(client, "/api/insights/storage")
    gp3 = next(c for c in storage["storage_classes"] if c["name"] == "gp3")
    assert gp3["clusters"] == ["ocp-east-1", "ocp-west-1"] and gp3["default"] is True
    assert gp3["pvcs"] == 2 and gp3["bound"] == 1 and gp3["pending"] == 1
    # pending claims sort to the top, where someone has to act
    assert [p["name"] for p in storage["pvcs"]] == ["risk-data", "payments-data"]

    routes = _get(client, "/api/insights/routes")
    assert [r["name"] for r in routes["routes"]] == ["payments", "risk"]
    assert _get(client, "/api/insights/routes", status="rejected")["count"] == 1
    assert _get(client, "/api/insights/routes", host="apps.east")["count"] == 1

    events = _get(client, "/api/insights/events")
    assert events["count"] == 5 and events["by_reason"]["BackOff"] == 4
    assert events["events"][0]["last_at"] >= events["events"][-1]["last_at"]
    assert _get(client, "/api/insights/events", cluster="ocp-east-1")["count"] == 2
    assert _get(client, "/api/insights/events", reason="unhealthy")["count"] == 1

    admins = _get(client, "/api/insights/cluster-admins")
    assert admins["count"] == 1
    assert admins["subjects"][0]["name"] == "sre-team"
    assert admins["subjects"][0]["clusters"] == ["ocp-east-1", "ocp-west-1"]


def test_insights_images_and_references(client):
    d = _get(client, "/api/insights/images", image="nginx")
    assert d["count"] == 1
    group = d["images"][0]
    assert group["image"] == NGINX and group["cluster_count"] == 2 and group["workload_count"] == 4
    assert [(w["namespace"], w["name"]) for w in group["workloads"]] == [
        ("payments", "api"), ("openshift-ingress", "router"), ("payments", "api"), ("risk", "scorer")]
    assert _get(client, "/api/insights/images", image="nginx",
                cluster="ocp-east-1")["images"][0]["workload_count"] == 1
    by_registry = _get(client, "/api/insights/images", image="nginx", group_by="registry")
    assert by_registry["images"][0]["registry"] == "docker.io"

    refs = _get(client, "/api/insights/references", kind="Secret", name="api-secret")
    assert refs["count"] == 2
    assert [r["cluster"] for r in refs["references"]] == ["ocp-east-1", "ocp-west-1"]
    assert refs["references"][0]["workloads"] == [{"kind": "Deployment", "name": "api", "via": "env"}]
    # without a name there is no index, so it walks the reference sections
    everything = _get(client, "/api/insights/references", kind="Secret")
    assert {r["name"] for r in everything["references"]} == {"api-secret", "scorer-secret",
                                                            "router-secret"}
    assert _get(client, "/api/insights/references", kind="Secret",
                cluster="ocp-east-1")["count"] == 1


def test_insights_inventory(client):
    # a fleet-indexed kind is answered from its index
    routes = _get(client, "/api/insights/resources", kind="routes")
    assert routes["total"] == 2 and routes["count"] == 2
    assert [r["cluster"] for r in routes["resources"]] == ["ocp-east-1", "ocp-west-1"]

    # a kind with no fleet index is answered by walking the clusters
    secrets = _get(client, "/api/insights/resources", kind="secrets")
    assert secrets["total"] == 3
    assert [r["name"] for r in secrets["resources"]] == ["api-tls", "legacy-tls", "risk-tls"]
    # total stays exact even when the page is smaller than the match set
    capped = _get(client, "/api/insights/resources", kind="secrets", limit=1)
    assert capped["total"] == 3 and capped["count"] == 1 and capped["resources"][0]["name"] == "api-tls"
    assert _get(client, "/api/insights/resources", kind="secrets", cluster="ocp-west-1")["total"] == 2
    assert _get(client, "/api/insights/resources", kind="secrets", name="risk-tls")["total"] == 1
    assert _get(client, "/api/insights/resources", kind="secrets", namespace="risk")["total"] == 2
    assert _get(client, "/api/insights/resources", kind="services")["total"] == 0


# --------------------------------------------------------------------------- #
# metrics
# --------------------------------------------------------------------------- #
def test_metrics_health_and_top_n(client):
    h = _get(client, "/api/metrics/health")
    assert h["clusters_total"] == 2 and h["clusters_with_metrics"] == 2
    assert h["reachable"] is True and h["without_metrics"] == []

    ns = _get(client, "/api/metrics/top-namespaces", by="cpu", limit=3)
    assert ns["unit"] == "cores"
    assert [(r["cluster"], r["namespace"]) for r in ns["results"]] == [
        ("ocp-west-1", "risk"), ("ocp-east-1", "payments"),
        ("ocp-west-1", "payments")]
    assert ns["results"][0]["value"] == 1.5 and ns["results"][0]["team"] == "risk"
    apps_only = _get(client, "/api/metrics/top-namespaces", by="cpu", **{"class": "application"})
    assert [r["namespace"] for r in apps_only["results"]] == ["risk", "payments", "payments"]
    by_mem = _get(client, "/api/metrics/top-namespaces", by="memory", limit=1)
    assert by_mem["unit"] == "bytes" and by_mem["results"][0]["namespace"] == "risk"

    nodes = _get(client, "/api/metrics/top-nodes", by="cpu", limit=2)
    assert nodes["unit"] == "percent"
    assert [r["node"] for r in nodes["results"]] == ["west-n1", "east-n1"]
    assert nodes["results"][0]["value"] == 75.0


def test_metrics_capacity_and_utilization(client):
    cap = _get(client, "/api/metrics/capacity")
    assert cap["group_by"] == "cluster"
    assert [r["cluster"] for r in cap["results"]] == ["ocp-east-1", "ocp-west-1"]
    assert cap["results"][0]["allocatable_cores"] == 8.0 and cap["results"][0]["used_cores"] == 3.0
    assert cap["results"][0]["used_percent"] == 37.5
    by_region = _get(client, "/api/metrics/capacity", group_by="region")
    assert [r["region"] for r in by_region["results"]] == ["us-east-1", "us-west-2"]

    u = _get(client, "/api/metrics/cluster/ocp-west-1/utilization")
    assert u["cpu"]["used_cores"] == 4.0 and u["metrics_available"] is True
    assert [n["namespace"] for n in u["top_namespaces"]] == ["risk", "payments"]
    assert client.get("/api/metrics/cluster/nope/utilization").status_code == 404

    t = _get(client, "/api/metrics/cluster/ocp-east-1/timeline")
    assert len(t["points"]) == 1 and t["points"][0]["cpu_percent"] == 37.5


# --------------------------------------------------------------------------- #
# manifest + admin
# --------------------------------------------------------------------------- #
def test_manifest_describes_the_health_checks(client):
    d = _get(client, "/api/manifest")
    checks = {c["name"]: c for c in d["health_checks"]}
    capacity = checks["capacity-headroom"]
    assert capacity["enabled"] and capacity["severity"] == "warning"
    assert capacity["warn"] == {"used_percent": 85} and capacity["fail"] == {"used_percent": 95}
    assert [u["key"] for u in capacity["units"]] == ["used_percent"]
    assert d["threshold_scope"]["pod_restart_threshold"] == "collection"

    # and a cluster's own results carry what they measured against those levels
    detail = _get(client, "/api/clusters/ocp-east-1")
    by_name = {c["name"]: c for c in detail["health_checks"]}
    assert by_name["capacity-headroom"]["levels"] == {"warn": {"used_percent": 85},
                                                      "fail": {"used_percent": 95}}
    assert "used_percent" in by_name["capacity-headroom"]["value"]
    assert by_name["nodes-ready"]["value"]["not_ready"] == 0


def test_manifest_availability(client):
    d = _get(client, "/api/manifest/availability")
    assert "routes" in d["resources"]
    assert [c["name"] for c in d["clusters"]] == ["ocp-east-1", "ocp-west-1"]
    east = d["clusters"][0]
    assert east["reachable"] is True and east["status"] == "healthy"
    assert east["resources"]["routes"]["status"] == "collected"
    assert east["resources"]["routes"]["count"] == 1
    # the one resource this cluster's API server does not serve
    assert east["resources"]["machineconfigpools"]["status"] == "unavailable"
    assert d["totals"]["machineconfigpools"] == {"unavailable": 1, "collected": 1}


def test_admin_runs(client):
    d = _get(client, "/api/runs")
    assert len(d["runs"]) == 1
    run = d["runs"][0]
    assert run["trigger"] == "test" and run["clusters_ok"] == 2
    assert run["duration_ms"] == 1234 and run["started_at"]


def test_refresh_endpoints_answer_409_when_collector_disabled(client, monkeypatch):
    from app import settings as settings_module

    monkeypatch.setattr(settings_module.settings, "collector_enabled", False)
    assert client.post("/api/refresh").status_code == 409
    assert client.post("/api/clusters/ocp-east-1/refresh").status_code == 409


def test_unassigned_namespaces_group_separately(monkeypatch):
    """With a mapping file, a namespace under no application is listed as
    (unassigned), filterable, and never merged into a real application."""
    from app.collector.collect import assemble
    from app.collector.healthchecks import run_health_checks
    from app.settings import settings

    manifest = get_manifest()
    st = RedisStore(fakeredis.FakeRedis())
    collected = assemble({"name": "ocp-map-1", "region": "us-east-1", "environment": "prod",
                          "managed_available": True}, _east_raw(), {}, manifest)
    app_ns = [n for n in collected["namespaces"] if n["ns_class"] == "application"]
    assert app_ns
    app_ns[0].update({"app_name": "1aat", "team": "wimt", "environment": "development", "assigned": True})
    # two namespaces the registry does not know: they are under no application
    for name in ("scratch-a", "scratch-b"):
        stray = dict(app_ns[0], name=name, app_name=None, team=None, environment=None, assigned=False)
        collected["namespaces"].append(stray)
        app_ns.append(stray)
    checks, overall, score, counts = run_health_checks(
        collected, settings.supported_floor, manifest.describe()["thresholds"])
    st.persist_cluster("hub-east", collected, checks, overall, score, counts)

    app = FastAPI()
    app.include_router(applications.router)
    app.include_router(blast_radius.router)
    store_module.set_store(st)
    try:
        c = TestClient(app)
        body = c.get("/api/applications").json()
        names = {a["app"]: a for a in body["applications"]}
        assert names["1aat"]["assigned"] is True and names["1aat"]["team"] == "wimt"
        assert names["1aat"]["namespace_environments"] == ["development"]
        assert names["(unassigned)"]["assigned"] is False
        assert names["(unassigned)"]["cluster_count"] == len(app_ns) - 1
        only = c.get("/api/applications", params={"assigned": "false"}).json()["applications"]
        assert [a["app"] for a in only] == ["(unassigned)"]
        detail = c.get("/api/applications/(unassigned)").json()
        assert detail["assigned"] is False and len(detail["namespaces"]) == len(app_ns) - 1
        assert c.get("/api/applications/1aat").json()["cluster_count"] == 1
        blast = c.get("/api/blast-radius", params={"ocp_version": collected.get("version")}).json()
        assert {a["app"] for a in blast["applications"]} >= {"1aat", "(unassigned)"}
    finally:
        store_module.set_store(None)
