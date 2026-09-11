"""assemble() joins raw objects into the cluster document."""
from datetime import UTC, datetime

from app.collector.collect import assemble
from tests.test_parsers import _pod

NOW = datetime(2026, 9, 10, 12, 0, tzinfo=UTC)


def _dep(name, ns, replicas=2, ready=2, labels=None, image="quay.io/acme/api:1.0"):
    return {"metadata": {"name": name, "namespace": ns, "labels": labels or {}},
            "spec": {"replicas": replicas, "template": {"spec": {"containers": [
                {"name": "app", "image": image,
                 "env": [{"name": "X", "valueFrom": {
                     "secretKeyRef": {"name": f"{name}-secret", "key": "k"}}}]}]}}},
            "status": {"readyReplicas": ready, "availableReplicas": ready, "updatedReplicas": replicas}}


def _ns(name, labels=None):
    return {"metadata": {"name": name, "labels": labels or {}}, "status": {"phase": "Active"}}


def _node(name, cpu="4", mem="16Gi"):
    return {"metadata": {"name": name}, "status": {
        "capacity": {"cpu": cpu, "memory": mem, "pods": "110"},
        "allocatable": {"cpu": cpu, "memory": mem, "pods": "110"},
        "conditions": [{"type": "Ready", "status": "True"}], "nodeInfo": {}}}


def test_assemble_document(manifest):
    raw = {
        "clusterversion": {"spec": {"channel": "stable-4.16"},
                           "status": {"desired": {"version": "4.16.7"},
                                      "history": [{"state": "Completed", "version": "4.16.7"}],
                                      "conditions": []}},
        "infrastructure": {"status": {"platform": "AWS", "apiServerURL": "https://api.x:6443"}},
        "network_config": {"status": {"networkType": "OVNKubernetes"}},
        "ingress_config": {"spec": {"domain": "apps.x.example.com"}},
        "clusteroperators": [],
        "nodes": [_node("n1"), _node("n2")],
        "node_metrics": [{"metadata": {"name": "n1"}, "usage": {"cpu": "2", "memory": "8Gi"}},
                         {"metadata": {"name": "n2"}, "usage": {"cpu": "1", "memory": "2Gi"}}],
        "namespaces": [_ns("payments", {"odl.io/team": "payments", "odl.io/tier": "critical"}),
                       _ns("risk"), _ns("openshift-monitoring"), _ns("kube-system")],
        "pods": [_pod("api-1", "payments"), _pod("api-2", "payments", claim="api-data"),
                 _pod("scorer-1", "risk", waiting="CrashLoopBackOff", restarts=9,
                      owner=("ReplicaSet", "scorer-abc"), hash_="abc"),
                 _pod("prom-1", "openshift-monitoring", waiting="ImagePullBackOff",
                      owner=("StatefulSet", "prometheus-k8s"))],
        "pod_metrics": [{"metadata": {"namespace": "payments"},
                         "containers": [{"usage": {"cpu": "500m", "memory": "1Gi"}}]}],
        "deployments": [_dep("api", "payments"),
                        _dep("scorer", "risk", ready=0,
                             labels={"odl.io/team": "risk", "odl.io/app": "fraud"})],
        "secrets": [{"metadata": {"name": "api-secret", "namespace": "payments"}, "type": "Opaque",
                     "data": {"k": "c2VjcmV0"}}],
        "persistentvolumeclaims": [{"metadata": {"name": "api-data", "namespace": "payments"},
                                    "spec": {"storageClassName": "gp3"}, "status": {"phase": "Bound"}}],
        "machineconfigpools": [{"metadata": {"name": "worker"}, "status": {
            "machineCount": 2, "conditions": [{"type": "Degraded", "status": "True", "message": "bad"}]}}],
        "events": [{"metadata": {"name": f"e{i}", "namespace": "risk"}, "type": "Warning",
                    "reason": "BackOff",
                    "message": "x", "involvedObject": {"kind": "Pod", "name": "scorer-1"},
                    "lastTimestamp": f"2026-09-10T11:{i:02d}:00Z"} for i in range(5)],
    }
    status = {k: {"status": "collected", "count": 1} for k in raw}
    status["routes"] = {"status": "unavailable", "count": 0}
    meta = {"name": "ocp-1", "region": "us-east-1", "managed_available": True}
    doc = assemble(meta, raw, status, manifest, NOW)

    assert doc["version"] == "4.16.7" and doc["apps_domain"] == "apps.x.example.com"
    assert doc["network_type"] == "OVNKubernetes" and doc["api_url"] == "https://api.x:6443"
    assert doc["nodes_total"] == 2 and doc["nodes_ready"] == 2
    assert doc["nodes"][0]["cpu_usage"] == 2.0 and doc["nodes"][0]["pods_running"] == 4

    ns = {n["name"]: n for n in doc["namespaces"]}
    assert ns["payments"]["ns_class"] == "application"
    assert ns["openshift-monitoring"]["ns_class"] == "platform"
    assert ns["payments"]["team"] == "payments" and ns["payments"]["tier"] == "critical"
    assert ns["payments"]["app_name"] == "payments"          # falls back to the namespace name
    assert ns["risk"]["team"] == "risk" and ns["risk"]["app_name"] == "fraud"   # from workload labels
    assert ns["payments"]["cpu_usage"] == 0.5 and ns["risk"]["cpu_usage"] is None
    assert ns["payments"]["status"] == "healthy" and ns["risk"]["status"] == "critical"
    assert ns["openshift-monitoring"]["status"] == "warning"
    assert ns["payments"]["workloads_total"] == 1 and ns["payments"]["replicas_ready"] == 2
    assert doc["namespaces_application"] == 2 and doc["namespaces_platform"] == 2

    assert [w["name"] for w in doc["workloads"]] == ["api", "scorer"]
    assert {(r["workload_name"], r["ref_name"]) for r in doc["workload_refs"]} == {
        ("api", "api-secret"), ("scorer", "scorer-secret")}
    assert doc["workload_images"][0]["registry"] == "quay.io"
    assert {i["name"]: i["ns_class"] for i in doc["pod_issues"]} == {
        "scorer-1": "application", "prom-1": "platform"}

    cap = doc["capacity"]
    assert cap["cpu_allocatable"] == 8.0 and cap["cpu_usage"] == 3.0 and cap["metrics_available"]
    assert cap["memory_usage"] == 10 * 1024 ** 3 and cap["pods_running"] == 4
    assert cap["cpu_requests"] == 0.4      # 4 running pods x 100m

    keys = {r["key"] for r in doc["resources"]}
    assert keys == {"secrets", "machineconfigpools", "events", "persistentvolumeclaims"}
    pvc = next(r for r in doc["resources"] if r["key"] == "persistentvolumeclaims")
    assert pvc["status"] == "bound" and pvc["summary"]["mounted_by"] == ["api-2"]
    assert ns["payments"]["resource_counts"] == {"secrets": 1, "persistentvolumeclaims": 1}
    mcp = next(r for r in doc["resources"] if r["key"] == "machineconfigpools")
    assert mcp["status"] == "degraded" and mcp["kind"] == "MachineConfigPool"
    assert doc["resource_status"]["routes"]["status"] == "unavailable"


def test_event_limit_keeps_most_recent(manifest):
    m = manifest
    m.config("events").limit = 2
    raw = {"events": [{"metadata": {"name": f"e{i}", "namespace": "a"}, "type": "Warning",
                       "reason": "R", "lastTimestamp": f"2026-09-10T11:{i:02d}:00Z"} for i in range(5)]}
    doc = assemble({"name": "c"}, raw, {"events": {"status": "collected"}}, m, NOW)
    assert [r["name"] for r in doc["resources"]] == ["e4", "e3"]
    m.config("events").limit = 200


def test_namespace_class_filter(manifest):
    manifest.config("secrets").namespace_class = "application"
    raw = {"namespaces": [_ns("app"), _ns("openshift-config")],
           "secrets": [{"metadata": {"name": "s", "namespace": "app"}, "data": {}},
                       {"metadata": {"name": "s", "namespace": "openshift-config"}, "data": {}}]}
    doc = assemble({"name": "c"}, raw, {}, manifest, NOW)
    assert [r["namespace"] for r in doc["resources"]] == ["app"]
    manifest.config("secrets").namespace_class = "all"


def test_every_generic_registry_key_has_a_parser():
    from app.collector.collect import _GENERIC_PARSERS
    from app.collector.registry import REGISTRY
    generic = {k for k, spec in REGISTRY.items() if spec.store == "generic"}
    assert generic <= set(_GENERIC_PARSERS)
