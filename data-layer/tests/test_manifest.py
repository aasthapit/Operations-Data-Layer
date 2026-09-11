import pytest

from app.collector.registry import REGISTRY
from app.manifest import ManifestError, parse_manifest


def test_bundled_manifest_enables_everything(manifest):
    assert set(manifest.enabled_keys()) == set(REGISTRY)
    assert manifest.config("events").limit == 200


def test_classification(manifest):
    assert manifest.classify_namespace("openshift-monitoring") == "platform"
    assert manifest.classify_namespace("kube-system") == "platform"
    assert manifest.classify_namespace("default") == "platform"
    assert manifest.classify_namespace("payments") == "application"
    assert manifest.classify_namespace("weird", {"openshift.io/run-level": "1"}) == "platform"
    assert manifest.classify_namespace("openshift", {}) == "platform"


def test_unknown_key_rejected():
    with pytest.raises(ManifestError, match="unknown resource key"):
        parse_manifest({"resources": {"podz": {"enabled": True}}})


def test_unknown_option_rejected():
    with pytest.raises(ManifestError, match="unsupported option"):
        parse_manifest({"resources": {"nodes": {"enabled": True, "limit": 5}}})
    with pytest.raises(ManifestError, match="namespace_class"):
        parse_manifest({"resources": {"pods": {"namespace_class": "everything"}}})


def test_missing_keys_default_disabled_and_bool_shorthand():
    m = parse_manifest({"resources": {"nodes": True, "pods": {"enabled": False}}})
    assert m.enabled("nodes") and not m.enabled("pods") and not m.enabled("secrets")
    assert m.enabled_keys() == ["nodes"]


def test_rbac_rules_group_by_api_group(manifest):
    role = manifest.rbac_clusterrole()
    rules = {r["apiGroups"][0]: r["resources"] for r in role["rules"]}
    assert "secrets" in rules[""] and "configmaps" in rules[""] and "pods" in rules[""]
    assert rules["metrics.k8s.io"] == ["nodes", "pods"]
    assert "clusterserviceversions" in rules["operators.coreos.com"]
    assert all(r["verbs"] == ["get", "list"] for r in role["rules"])
    m = parse_manifest({"resources": {"nodes": True}})
    assert m.rbac_clusterrole()["rules"] == [{"apiGroups": [""], "resources": ["nodes"],
                                              "verbs": ["get", "list"]}]


def test_describe_lists_every_registry_key(manifest):
    d = manifest.describe()
    assert {r["key"] for r in d["resources"]} == set(REGISTRY)
    assert d["thresholds"]["certificate_expiry_days"] == 30
    assert any("Secret values" in p["what"] for p in d["scrub_policy"])
