import pytest

from app.collector.healthchecks import CHECK_SPECS
from app.collector.registry import REGISTRY
from app.manifest import ManifestError, parse_manifest
from app.settings import settings


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


# --------------------------------------------------------------------------- #
# health checks
# --------------------------------------------------------------------------- #
def test_bundled_manifest_enables_every_check_at_its_default(manifest):
    configs = manifest.health_check_config
    assert set(configs) == set(CHECK_SPECS)
    assert all(c.enabled for c in configs.values())
    assert configs["capacity-headroom"].warn == {"used_percent": 85}
    assert configs["capacity-headroom"].fail == {"used_percent": 95}
    assert configs["no-degraded-operators"].severity == "critical"
    assert configs["version-supported"].fail == {"floor": settings.supported_floor}


def test_health_check_overrides_are_parsed():
    m = parse_manifest({"health_checks": {
        "no-degraded-operators": {"severity": "warning",
                                  "warn": {"degraded": 1}, "fail": {"degraded": 3}},
        "application-pods": False,
        "quotas-headroom": {"enabled": True, "warn": {"max_percent": 75}},
        "update-available": None,
    }})
    configs = m.health_check_config
    degraded = configs["no-degraded-operators"]
    assert degraded.severity == "warning" and degraded.warn == {"degraded": 1}
    assert degraded.fail == {"degraded": 3}
    assert configs["application-pods"].enabled is False
    assert configs["quotas-headroom"].warn == {"max_percent": 75}
    assert configs["update-available"].enabled is True          # a bare key means "defaults"
    assert configs["nodes-ready"].enabled is True               # untouched checks keep theirs


def test_legacy_thresholds_become_check_defaults():
    m = parse_manifest({"thresholds": {"capacity_warning_percent": 70,
                                       "capacity_critical_percent": 80,
                                       "certificate_expiry_days": 45,
                                       "quota_warning_percent": 60}})
    configs = m.health_check_config
    assert configs["capacity-headroom"].warn == {"used_percent": 70}
    assert configs["capacity-headroom"].fail == {"used_percent": 80}
    assert configs["certificates-valid"].warn["expiring_within_days"] == 45
    assert configs["quotas-headroom"].warn == {"max_percent": 60}
    # ... and the check's own level wins over the flat threshold.
    m = parse_manifest({"thresholds": {"capacity_warning_percent": 70},
                        "health_checks": {"capacity-headroom": {"warn": {"used_percent": 50}}}})
    assert m.health_check_config["capacity-headroom"].warn == {"used_percent": 50}


def test_unknown_check_rejected():
    with pytest.raises(ManifestError, match="unknown health check"):
        parse_manifest({"health_checks": {"nodes-readyy": {"enabled": False}}})


def test_unknown_level_rejected():
    with pytest.raises(ManifestError, match="unknown level"):
        parse_manifest({"health_checks": {"nodes-ready": {"warn": {"nodes": 1}}}})
    with pytest.raises(ManifestError, match="measures nothing"):
        parse_manifest({"health_checks": {"managed-available": {"warn": {"available": 1}}}})


def test_warn_above_fail_rejected():
    with pytest.raises(ManifestError, match="must be at or below"):
        parse_manifest({"health_checks": {"capacity-headroom": {"warn": {"used_percent": 99}}}})
    with pytest.raises(ManifestError, match="must be at or below"):
        parse_manifest({"health_checks": {"nodes-ready": {"warn": {"not_ready": 5},
                                                          "fail": {"not_ready": 2}}}})
    # a version floor and a certificate window read the other way round
    with pytest.raises(ManifestError, match="must be at or above"):
        parse_manifest({"health_checks": {"version-supported": {"warn": {"floor": "4.14.0"},
                                                                "fail": {"floor": "4.16.0"}}}})
    with pytest.raises(ManifestError, match="must be at or above"):
        parse_manifest({"health_checks": {"certificates-valid": {
            "warn": {"expiring": 1, "expiring_within_days": 7},
            "fail": {"expired": 1, "expiring": 1, "expiring_within_days": 30}}}})


def test_bad_severity_and_bad_values_rejected():
    with pytest.raises(ManifestError, match="severity must be"):
        parse_manifest({"health_checks": {"nodes-ready": {"severity": "urgent"}}})
    with pytest.raises(ManifestError, match="must be a number"):
        parse_manifest({"health_checks": {"nodes-ready": {"fail": {"not_ready": "two"}}}})
    with pytest.raises(ManifestError, match="must be a version string"):
        parse_manifest({"health_checks": {"version-supported": {"fail": {"floor": 4.15}}}})
    with pytest.raises(ManifestError, match="must not be negative"):
        parse_manifest({"health_checks": {"nodes-ready": {"fail": {"not_ready": -1}}}})
    with pytest.raises(ManifestError, match="enabled must be"):
        parse_manifest({"health_checks": {"nodes-ready": {"enabled": "yes"}}})
    with pytest.raises(ManifestError, match="unsupported option"):
        parse_manifest({"health_checks": {"nodes-ready": {"level": 1}}})
    with pytest.raises(ManifestError, match="must be a mapping"):
        parse_manifest({"health_checks": ["nodes-ready"]})


def test_describe_reports_the_effective_health_check_config(manifest):
    d = manifest.describe()
    by_name = {c["name"]: c for c in d["health_checks"]}
    assert set(by_name) == set(CHECK_SPECS)
    capacity = by_name["capacity-headroom"]
    assert capacity["enabled"] and capacity["severity"] == "warning"
    assert capacity["warn"] == {"used_percent": 85} and capacity["fail"] == {"used_percent": 95}
    assert capacity["units"] == [{"key": "used_percent", "unit": "percent", "compare": "gte",
                                  "description": capacity["units"][0]["description"]}]
    assert capacity["title"] and capacity["description"]
    assert by_name["managed-available"]["units"] == []
    # the flat thresholds stay, with the scope each one acts at
    assert d["thresholds"]["pod_restart_threshold"] == 5
    assert d["threshold_scope"]["pod_restart_threshold"] == "collection"
    assert d["threshold_scope"]["capacity_warning_percent"] == "evaluation"


def test_cluster_reachable_cannot_be_disabled():
    from app.manifest import ManifestError, parse_manifest

    with pytest.raises(ManifestError, match="cannot be disabled"):
        parse_manifest({"health_checks": {"cluster-reachable": {"enabled": False}}}, source="t")
    with pytest.raises(ManifestError, match="cannot be disabled"):
        parse_manifest({"health_checks": {"cluster-reachable": False}}, source="t")
    m = parse_manifest({"health_checks": {"cluster-reachable": {"severity": "warning"}}}, source="t")
    assert m.health_check_config["cluster-reachable"].severity == "warning"


# --------------------------------------------------------------------------- #
# tiers: `interval` per resource
# --------------------------------------------------------------------------- #
def test_interval_accepts_seconds_and_durations():
    m = parse_manifest({"resources": {
        "nodes": True,                                   # absent -> every sweep
        "pods": {"enabled": True, "interval": 0},
        "deployments": {"enabled": True, "interval": 90},
        "services": {"enabled": True, "interval": "90"},
        "routes": {"enabled": True, "interval": "2m"},
        "secrets": {"enabled": True, "interval": "15m"},
        "configmaps": {"enabled": True, "interval": "1h"},
        "events": {"enabled": True, "interval": "1d", "limit": 10},
    }})
    assert m.interval("nodes") == 0 and m.interval("pods") == 0
    assert m.interval("deployments") == 90 and m.interval("services") == 90
    assert m.interval("routes") == 120 and m.interval("secrets") == 900
    assert m.interval("configmaps") == 3600 and m.interval("events") == 86400
    assert m.interval("storageclasses") == 0              # not in the manifest at all
    assert m.tiered() is True
    assert parse_manifest({"resources": {"nodes": True}}).tiered() is False
    # a kind that is off cannot make a manifest tiered
    assert parse_manifest({"resources": {
        "nodes": True, "secrets": {"enabled": False, "interval": "1h"}}}).tiered() is False
    assert {r["key"]: r["interval_seconds"] for r in m.describe()["resources"]}["routes"] == 120


def test_bad_interval_rejected():
    for bad in ("soon", "15 minutes", "2w", True, [], "-5m"):
        with pytest.raises(ManifestError, match="interval must be"):
            parse_manifest({"resources": {"pods": {"enabled": True, "interval": bad}}})
    with pytest.raises(ManifestError, match="must not be negative"):
        parse_manifest({"resources": {"pods": {"enabled": True, "interval": -30}}})
    # and `interval` is accepted on every kind, not only the ones with options
    assert parse_manifest({"resources": {"nodes": {"interval": "5m"}}}).interval("nodes") == 300


def test_the_fleet_profile_is_the_default_manifest_with_tiers(manifest):
    import os

    from app.manifest import load_manifest

    fleet = load_manifest(os.path.join(os.path.dirname(manifest.source),
                                       "ocp-api-manifest.fleet.yaml"))
    # the heavy kinds are off, and the check that grades their data with them
    assert not fleet.enabled("secrets") and not fleet.enabled("configmaps")
    assert fleet.health_check_config["certificates-valid"].enabled is False
    assert fleet.health_check_config["no-degraded-operators"].enabled is True

    # platform state every sweep, inventory on its own tier
    assert fleet.tiered() is True and manifest.tiered() is False
    for key in ("clusterversion", "clusteroperators", "nodes", "node_metrics", "namespaces",
                "pods", "pod_metrics", "machineconfigpools", "events", "infrastructure",
                "network_config", "ingress_config"):
        assert fleet.enabled(key) and fleet.interval(key) == 0, key
    for key in ("deployments", "statefulsets", "daemonsets", "cronjobs", "services", "routes",
                "ingresses", "networkpolicies", "persistentvolumeclaims", "persistentvolumes",
                "storageclasses", "resourcequotas", "clusterserviceversions", "subscriptions",
                "horizontalpodautoscalers", "clusterrolebindings"):
        assert fleet.enabled(key) and fleet.interval(key) == 900, key

    # everything that is not the schedule is the default manifest's
    assert fleet.platform_names == manifest.platform_names
    assert fleet.ownership == manifest.ownership
    assert fleet.effective_thresholds() == manifest.effective_thresholds()
    assert fleet.keep_annotations == manifest.keep_annotations
    # and the RBAC it needs is a subset of the default's (two kinds fewer)
    assert set(fleet.enabled_keys()) < set(manifest.enabled_keys())
