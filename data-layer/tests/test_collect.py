"""assemble() joins raw objects into the cluster document, this sweep's and
the previous one's (the kinds that were not due)."""
from datetime import UTC, datetime, timedelta

from app.collector.collect import (
    PREVIOUS_SECTIONS,
    Previous,
    assemble,
    plan_collection,
)
from app.manifest import parse_manifest
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


def test_assemble_takes_ownership_from_the_mapping_not_from_labels(manifest, tmp_path):
    """Mapping mode: registry wins, labels are ignored, unmapped namespaces are
    under no application, and the cluster's environment comes from the registry
    when ACM had none."""
    import dataclasses
    import json

    from app import appmap as appmap_module

    path = tmp_path / "app-map.json"
    path.write_text(json.dumps([
        {"cluster": "c1", "env": "nonprod", "app_id": "1aat", "environment": "development",
         "lob": "wimt", "namespace": "payments"},
    ]))
    mapped = dataclasses.replace(manifest, applications={
        "source": "mapping",
        "mapping": {"path": str(path), "fields": dict(appmap_module.DEFAULT_FIELDS)}})
    appmap_module.reset_cache()
    raw = {
        "namespaces": [_ns("payments", {"odl.io/app": "from-label", "odl.io/team": "label-team"}),
                       _ns("scratch", {"odl.io/app": "scratch-app"}),
                       _ns("openshift-monitoring")],
        "deployments": [_dep("api", "payments", labels={"odl.io/tier": "critical"}),
                        _dep("job", "scratch")],
    }
    doc = assemble({"name": "c1", "region": "us"}, raw, {}, mapped)
    by = {n["name"]: n for n in doc["namespaces"]}
    assert by["payments"]["app_name"] == "1aat" and by["payments"]["team"] == "wimt"
    assert by["payments"]["environment"] == "development" and by["payments"]["assigned"] is True
    assert by["payments"]["tier"] is None                     # labels are not consulted
    assert by["scratch"]["app_name"] is None and by["scratch"]["assigned"] is False
    assert by["scratch"]["ns_class"] == "application"        # still an application namespace
    assert by["openshift-monitoring"]["assigned"] is False
    assert doc["environment"] == "nonprod"

    # labels mode is unchanged and never marks anything unassigned
    appmap_module.reset_cache()
    doc = assemble({"name": "c1", "region": "us"}, raw, {}, manifest)
    by = {n["name"]: n for n in doc["namespaces"]}
    assert by["payments"]["app_name"] == "from-label" and by["payments"]["assigned"] is True
    assert by["scratch"]["app_name"] == "scratch-app" and by["payments"]["environment"] is None


# --------------------------------------------------------------------------- #
# tiers: a kind that is not due keeps the rows of its last collection
# --------------------------------------------------------------------------- #
def _previous(doc):
    """The `Previous` a store round trip hands back for a collected document
    (mirrors redis_store._section_rows and the `collector_state` summary field)."""
    sections = {name: [dict(row) for row in (doc.get(name) or [])]
                for name in PREVIOUS_SECTIONS if name != "resource_status"}
    sections["resource_status"] = [{"key": key, **entry}
                                   for key, entry in (doc.get("resource_status") or {}).items()]
    return Previous(sections=sections, state=doc.get("collector_state") or {})


def _fetched(keys, at=NOW, status="collected"):
    return {key: {"status": status, "count": 1, "error": None, "duration_ms": 1,
                  "collected_at": at.isoformat(), "cached": False} for key in keys}


def _kept(previous, keys):
    return {key: {**previous.status(key), "cached": True} for key in keys}


def _first_sweep(manifest, raw):
    """Collect everything once, and hand back (document, Previous)."""
    doc = assemble({"name": "ocp-1", "region": "us-east-1"}, raw,
                   _fetched(raw.keys()), manifest, NOW)
    return doc, _previous(doc)


_TIERED_RAW = {
    "clusterversion": {"spec": {"channel": "stable-4.16"},
                       "status": {"desired": {"version": "4.16.7"},
                                  "history": [{"state": "Completed", "version": "4.16.7"}],
                                  "conditions": []}},
    "clusteroperators": [{"metadata": {"name": "etcd"}, "status": {"versions": [
        {"name": "operator", "version": "4.16.7"}], "conditions": [
        {"type": "Available", "status": "True"}]}}],
    "nodes": [_node("n1")],
    "namespaces": [_ns("payments")],
    "pods": [_pod("api-1", "payments"), _pod("api-2", "payments")],
    "deployments": [_dep("api", "payments")],
    "statefulsets": [],
    "secrets": [{"metadata": {"name": "api-secret", "namespace": "payments"},
                 "type": "Opaque", "data": {"k": "c2VjcmV0"}}],
    "routes": [{"metadata": {"name": "api", "namespace": "payments"},
                "spec": {"host": "api.example.com", "to": {"name": "api"}}, "status": {}}],
}
LATER = NOW + timedelta(minutes=5)


def test_plan_collects_a_kind_only_when_its_interval_has_passed():
    m = parse_manifest({"resources": {
        "pods": True,                                       # every sweep
        "deployments": {"enabled": True, "interval": "15m"},
        "secrets": {"enabled": True, "interval": "1h"},
        "routes": {"enabled": False, "interval": "15m"}}})
    previous = Previous(sections={"resource_status": [
        {"key": "pods", "status": "collected", "collected_at": NOW.isoformat()},
        {"key": "deployments", "status": "collected", "collected_at": NOW.isoformat()},
        {"key": "secrets", "status": "forbidden", "collected_at": NOW.isoformat()}]})

    plan = plan_collection(m, previous, now=LATER)
    assert plan.due == ["pods"]                              # the tiers are not up yet
    assert set(plan.cached) == {"deployments", "secrets"}
    assert plan.cached["secrets"]["status"] == "forbidden"   # kept, with its own timestamp
    assert plan.cached["secrets"]["cached"] is True
    assert plan.cached["secrets"]["collected_at"].startswith("2026-09-10T12:00")
    assert plan.cached["deployments"]["interval_seconds"] == 900

    # twenty minutes on, the 15m tier is due again and the hourly one is not
    assert plan_collection(m, previous, now=NOW + timedelta(minutes=20)).due == [
        "pods", "deployments"]
    # a full refresh ignores every tier, and so does a cluster never collected
    assert plan_collection(m, previous, now=LATER, full=True).due == [
        "pods", "deployments", "secrets"]
    assert plan_collection(m, None, now=LATER).due == ["pods", "deployments", "secrets"]
    # a disabled kind is never due, whatever its interval
    assert "routes" not in plan_collection(m, None, now=LATER).due
    # upgrade path: rows an older collector wrote carry no `collected_at`, and a
    # kind that used to be disabled has none either - both are due
    older = Previous(sections={"resource_status": [
        {"key": "pods", "status": "collected", "count": 3},
        {"key": "deployments", "status": "collected", "count": 1},
        {"key": "secrets", "status": "disabled", "count": 0}]})
    assert plan_collection(m, older, now=LATER).due == ["pods", "deployments", "secrets"]
    assert plan_collection(m, older, now=LATER).cached == {}


def test_assemble_keeps_the_rows_of_kinds_that_were_not_due(manifest):
    first, previous = _first_sweep(manifest, _TIERED_RAW)
    assert [w["name"] for w in first["workloads"]] == ["api"]

    # second sweep: only namespaces and pods are due, and one pod is gone
    raw = {"namespaces": [_ns("payments")], "pods": [_pod("api-1", "payments")]}
    status = {**_fetched(raw, LATER),
              **_kept(previous, ("clusterversion", "clusteroperators", "nodes", "deployments",
                                 "statefulsets", "secrets", "routes"))}
    doc = assemble({"name": "ocp-1", "region": "us-east-1"}, raw, status, manifest,
                   LATER, previous)

    # kept: workloads with their image and reference edges, inventory, nodes,
    # operators, and the cluster-level config of the singleton kinds
    assert [w["name"] for w in doc["workloads"]] == ["api"]
    assert [(r["workload_name"], r["ref_name"]) for r in doc["workload_refs"]] == [
        ("api", "api-secret")]
    assert [r["repository"] for r in doc["workload_images"]] == ["acme/api"]
    assert {r["key"] for r in doc["resources"]} == {"secrets", "routes"}
    assert [n["name"] for n in doc["nodes"]] == ["n1"] and doc["nodes_ready"] == 1
    assert [o["name"] for o in doc["operators"]] == ["etcd"]
    assert doc["version"] == "4.16.7" and doc["channel"] == "stable-4.16"

    # recomputed: the namespace rollups, from this sweep's pods and the kept workloads
    ns = {n["name"]: n for n in doc["namespaces"]}["payments"]
    assert ns["pods_total"] == 1 and ns["pods_running"] == 1
    assert ns["workloads_total"] == 1 and ns["replicas_ready"] == 2
    assert ns["resource_counts"] == {"secrets": 1, "routes": 1}     # kept rows still count
    assert doc["nodes"][0]["pods_running"] == 1
    assert doc["workloads_total"] == 1 and doc["capacity"]["pods_running"] == 1

    # and the document says which kinds it did not re-read
    assert doc["resource_status"]["secrets"]["cached"] is True
    assert doc["resource_status"]["pods"]["cached"] is False
    assert doc["collector_state"]["config"]["clusterversion"]["version"] == "4.16.7"


def test_assemble_drops_the_rows_of_a_kind_that_became_forbidden(manifest):
    first, previous = _first_sweep(manifest, _TIERED_RAW)
    assert {r["key"] for r in first["resources"]} == {"secrets", "routes"}

    raw = {"namespaces": [_ns("payments")], "pods": [_pod("api-1", "payments")]}
    status = {**_fetched(raw, LATER),
              # secrets were due and came back 403; the deployments tier is not up
              **_fetched(["secrets"], LATER, status="forbidden"),
              **_kept(previous, ("clusterversion", "clusteroperators", "nodes", "deployments",
                                 "statefulsets", "routes"))}
    doc = assemble({"name": "ocp-1"}, raw, status, manifest, LATER, previous)

    assert {r["key"] for r in doc["resources"]} == {"routes"}       # the secrets rows are gone
    assert doc["resource_status"]["secrets"]["status"] == "forbidden"
    assert doc["resource_status"]["secrets"]["cached"] is False
    assert {n["name"]: n for n in doc["namespaces"]}["payments"]["resource_counts"] == {"routes": 1}
    assert doc["certs_expiring_total"] == 0
    # a workload kind that is disabled outright drops its rows the same way
    status["deployments"] = {"status": "disabled", "count": 0, "cached": False}
    doc = assemble({"name": "ocp-1"}, raw, status, manifest, LATER, previous)
    assert doc["workloads"] == [] and doc["workload_refs"] == []


def test_assemble_keeps_pod_rollups_when_pods_are_not_due(manifest):
    """Pods belong in the fast tier, but putting them in a slow one must not
    zero every namespace: the rollups stand until they are read again."""
    first, previous = _first_sweep(manifest, _TIERED_RAW)

    raw = {"namespaces": [_ns("payments")], "deployments": [_dep("api", "payments")]}
    status = {**_fetched(raw, LATER),
              **_kept(previous, ("clusterversion", "clusteroperators", "nodes", "pods",
                                 "statefulsets", "secrets", "routes"))}
    doc = assemble({"name": "ocp-1"}, raw, status, manifest, LATER, previous)

    ns = {n["name"]: n for n in doc["namespaces"]}["payments"]
    assert ns["pods_total"] == 2 and ns["pods_running"] == 2
    assert ns["cpu_requests"] == first["namespaces"][0]["cpu_requests"]
    assert doc["nodes"][0]["pods_running"] == 2
    assert doc["capacity"]["pods_running"] == 2
    assert [i["name"] for i in doc["pod_issues"]] == [i["name"] for i in first["pod_issues"]]


def test_mapping_with_label_fallback_and_platform_apps(manifest, tmp_path):
    """The registry decides; unmapped namespaces may be claimed only by the
    configured ownership labels; generic labels never group anything; the
    critical OpenShift namespaces form a platform application."""
    import dataclasses
    import json

    from app import appmap as appmap_module

    path = tmp_path / "app-map.json"
    path.write_text(json.dumps([{"cluster": "c1", "app_id": "1aat", "lob": "wimt", "namespace": "payments",
                                 "environment": "development", "env": "nonprod"}]))
    m = dataclasses.replace(
        manifest,
        ownership={"app": ["app_id"], "team": ["lob"], "tier": []},
        applications={"source": "mapping",
                      "mapping": {"path": str(path), "fields": dict(appmap_module.DEFAULT_FIELDS),
                                  "fallback": "labels"},
                      "platform_apps": [{"name": "openshift-critical", "team": "platform", "tier": "critical",
                                         "namespaces": ["openshift-etcd", "openshift-ingress*"]}]})
    appmap_module.reset_cache()
    raw = {
        "namespaces": [
            _ns("payments", {"app.kubernetes.io/part-of": "helix-ssa"}),        # mapped: registry wins
            _ns("ledger", {"app_id": "ldgr", "lob": "cto", "app.kubernetes.io/part-of": "helix-ssa"}),
            _ns("scratch", {"app.kubernetes.io/part-of": "helix-ssa"}),         # only a generic label
            _ns("openshift-etcd"), _ns("openshift-ingress-operator"), _ns("openshift-marketplace"),
        ],
        "deployments": [_dep("api", "payments"),
                        _dep("job", "scratch", labels={"app.kubernetes.io/name": "x"})],
    }
    doc = assemble({"name": "c1", "region": "us"}, raw, {}, m)
    by = {n["name"]: n for n in doc["namespaces"]}
    assert by["payments"]["app_name"] == "1aat" and by["payments"]["ownership_source"] == "mapping"
    assert by["ledger"]["app_name"] == "ldgr" and by["ledger"]["team"] == "cto"
    assert by["ledger"]["ownership_source"] == "labels" and by["ledger"]["assigned"] is True
    assert by["scratch"]["app_name"] is None and by["scratch"]["assigned"] is False
    for name in ("openshift-etcd", "openshift-ingress-operator"):
        assert by[name]["app_name"] == "openshift-critical" and by[name]["tier"] == "critical"
        assert by[name]["ns_class"] == "platform" and by[name]["ownership_source"] == "platform"
    marketplace = by["openshift-marketplace"]
    assert marketplace["app_name"] is None and marketplace["assigned"] is False
    assert doc["applications_total"] == 3           # 1aat, ldgr, openshift-critical

    # without the fallback the label-claimed namespace is unassigned too
    strict = dataclasses.replace(m, applications={**m.applications, "mapping": {**m.applications["mapping"],
                                                                                  "fallback": "none"}})
    appmap_module.reset_cache()
    by = {n["name"]: n for n in assemble({"name": "c1"}, raw, {}, strict)["namespaces"]}
    assert by["ledger"]["app_name"] is None and by["payments"]["app_name"] == "1aat"
