from datetime import UTC, datetime, timedelta

from app.collector.healthchecks import resolve_check_configs, run_health_checks

T = {"capacity_warning_percent": 85, "capacity_critical_percent": 95, "certificate_expiry_days": 30}


def _base(**over):
    c = {"reachable": True, "managed_available": True, "cv_available": True, "cv_failing": False,
         "operators": [], "nodes_total": 3, "nodes_ready": 3, "nodes": [], "version": "4.16.7",
         "upgrading": False, "available_updates": [], "resources": [], "pod_issues": [],
         "capacity": {"metrics_available": True, "cpu_usage": 2.0, "cpu_allocatable": 10.0,
                      "memory_usage": 1, "memory_allocatable": 10},
         "resource_status": {"machineconfigpools": {"status": "collected"}}}
    c.update(over)
    return c


def _by(checks):
    return {c["name"]: c for c in checks}


def test_healthy_cluster():
    checks, overall, score, counts = run_health_checks(_base(), "4.15.0", T)
    assert overall == "healthy" and score == 100 and counts["failed"] == 0
    assert _by(checks)["capacity-headroom"]["status"] == "pass"
    assert _by(checks)["machine-config-pools"]["status"] == "pass"


def test_unreachable_short_circuits():
    checks, overall, score, _ = run_health_checks(_base(reachable=False, error="boom"), "4.15.0", T)
    assert overall == "critical" and len(checks) == 1 and checks[0]["message"] == "boom"


def test_new_signals():
    c = _base(
        nodes=[{"name": "n1", "schedulable": False, "conditions": {"DiskPressure": True}}],
        pod_issues=[{"namespace": "openshift-dns", "name": "dns-1", "reason": "CrashLoopBackOff",
                     "ns_class": "platform"},
                    {"namespace": "payments", "name": "api-1", "reason": "OOMKilled",
                     "ns_class": "application"}],
        resources=[
            {"key": "machineconfigpools", "name": "worker", "status": "degraded", "summary": {}},
            {"key": "secrets", "name": "web-tls", "namespace": "web", "status": "expired", "summary": {}},
            {"key": "resourcequotas", "name": "q", "namespace": "web", "status": "exhausted",
             "summary": {"max_percent": 100.0}},
            {"key": "clusterserviceversions", "name": "x.v1", "status": "failed",
             "summary": {"phase": "Failed"}},
        ],
        capacity={"metrics_available": True, "cpu_usage": 9.6, "cpu_allocatable": 10.0,
                  "memory_usage": 1, "memory_allocatable": 10},
    )
    checks, overall, score, _ = run_health_checks(c, "4.15.0", T)
    b = _by(checks)
    assert b["nodes-pressure"]["status"] == "fail" and "n1" in b["nodes-pressure"]["message"]
    assert b["machine-config-pools"]["status"] == "fail"
    assert b["machine-config-pools"]["severity"] == "critical"
    assert b["platform-pods"]["status"] == "warn" and "openshift-dns/dns-1" in b["platform-pods"]["message"]
    assert b["application-pods"]["status"] == "warn" and b["application-pods"]["severity"] == "info"
    assert b["capacity-headroom"]["status"] == "fail" and "CPU at 96%" in b["capacity-headroom"]["message"]
    assert b["certificates-valid"]["status"] == "fail" and "web-tls" in b["certificates-valid"]["message"]
    assert b["quotas-headroom"]["status"] == "warn"
    assert b["olm-operators-healthy"]["status"] == "warn"
    assert overall == "critical"


def test_metrics_missing_is_informational():
    checks, overall, _, _ = run_health_checks(_base(capacity={"metrics_available": False}), "4.15.0", T)
    b = _by(checks)
    assert b["capacity-headroom"]["status"] == "warn" and b["capacity-headroom"]["severity"] == "info"
    assert overall == "healthy"


def test_expiring_cert_is_warning():
    c = _base(resources=[{"key": "configmaps", "name": "ca", "namespace": "x", "status": "expiring",
                          "summary": {}}])
    _, overall, score, _ = run_health_checks(c, "4.15.0", T)
    assert overall == "warning" and score == 92

# --------------------------------------------------------------------------- #
# configurable levels
# --------------------------------------------------------------------------- #
def _run(overrides=None, floor="4.15.0", **document):
    """Run the panel with per-check overrides, as the manifest would supply them."""
    configs = resolve_check_configs(T, overrides or {}, supported_floor=floor)
    return run_health_checks(_base(**document), floor, checks_config=configs)


def _cert(name, status, days=None):
    row = {"key": "secrets", "name": name, "namespace": "web", "status": status, "summary": {}}
    if days is not None:
        row["expires_at"] = datetime.now(UTC) + timedelta(days=days)
    return row


def test_every_result_carries_its_value_and_levels():
    checks, _, _, _ = _run()
    b = _by(checks)
    assert b["capacity-headroom"]["value"] == {"used_percent": 20.0}
    assert b["capacity-headroom"]["levels"] == {"warn": {"used_percent": 85},
                                                "fail": {"used_percent": 95}}
    assert b["nodes-ready"]["value"] == {"not_ready": 0, "not_ready_percent": 0.0}
    assert b["version-supported"]["value"] == {"version": "4.16.7"}
    assert b["version-supported"]["levels"]["fail"] == {"floor": "4.15.0"}


def test_nodes_ready_levels():
    over = {"nodes-ready": {"warn": {"not_ready": 1}, "fail": {"not_ready": 3}}}
    for not_ready, expected in ((0, "pass"), (1, "warn"), (2, "warn"), (3, "fail"), (4, "fail")):
        checks, _, _, _ = _run(over, nodes_total=5, nodes_ready=5 - not_ready)
        assert _by(checks)["nodes-ready"]["status"] == expected, not_ready


def test_nodes_ready_percent_level():
    over = {"nodes-ready": {"warn": {"not_ready_percent": 20}, "fail": {"not_ready_percent": 50}}}
    checks, _, _, _ = _run(over, nodes_total=10, nodes_ready=9)          # 10%
    assert _by(checks)["nodes-ready"]["status"] == "pass"
    checks, _, _, _ = _run(over, nodes_total=10, nodes_ready=8)          # 20%
    assert _by(checks)["nodes-ready"]["status"] == "warn"
    checks, _, _, _ = _run(over, nodes_total=10, nodes_ready=5)          # 50%
    assert _by(checks)["nodes-ready"]["status"] == "fail"


def test_no_nodes_collected_is_informational():
    checks, overall, score, _ = _run(nodes_total=0, nodes_ready=0)
    check = _by(checks)["nodes-ready"]
    assert check["status"] == "warn" and check["severity"] == "info"
    assert overall == "healthy" and score == 100


def test_degraded_operators_warn_then_fail():
    over = {"no-degraded-operators": {"warn": {"degraded": 1}, "fail": {"degraded": 3}}}
    for count, expected in ((0, "pass"), (1, "warn"), (3, "fail")):
        ops = [{"name": f"op{i}", "degraded": True, "critical": False, "available": True,
                "progressing": False} for i in range(count)]
        checks, _, _, _ = _run(over, operators=ops)
        check = _by(checks)["no-degraded-operators"]
        assert check["status"] == expected and check["value"] == {"degraded": count}


def test_capacity_headroom_boundaries():
    for used, expected in ((8.49, "pass"), (8.5, "warn"), (9.49, "warn"), (9.5, "fail")):
        checks, _, _, _ = _run(capacity={"metrics_available": True, "cpu_usage": used,
                                         "cpu_allocatable": 10.0, "memory_usage": 1,
                                         "memory_allocatable": 10})
        assert _by(checks)["capacity-headroom"]["status"] == expected, used


def test_capacity_headroom_levels_are_configurable():
    over = {"capacity-headroom": {"warn": {"used_percent": 50}, "fail": {"used_percent": 60}}}
    checks, overall, _, _ = _run(over)                                   # the base cluster is at 20%
    assert _by(checks)["capacity-headroom"]["status"] == "pass" and overall == "healthy"
    checks, overall, _, _ = _run(over, capacity={"metrics_available": True, "cpu_usage": 5.5,
                                                 "cpu_allocatable": 10.0, "memory_usage": 1,
                                                 "memory_allocatable": 10})
    assert _by(checks)["capacity-headroom"]["status"] == "warn" and overall == "warning"


def test_certificates_windows_per_band():
    certs = [_cert("soon", "expiring", days=5), _cert("later", "expiring", days=20)]
    checks, _, _, _ = _run(resources=certs)
    check = _by(checks)["certificates-valid"]
    assert check["status"] == "warn" and check["value"] == {"expired": 0, "expiring": 2}

    # "a certificate with a week left is a failure": only the 5-day one is inside
    # the fail window, and one is enough.
    over = {"certificates-valid": {"fail": {"expiring": 1, "expiring_within_days": 7}}}
    checks, _, _, _ = _run(over, resources=certs)
    assert _by(checks)["certificates-valid"]["status"] == "fail"

    # a narrower warn window ignores both
    over = {"certificates-valid": {"warn": {"expiring": 1, "expiring_within_days": 2}}}
    checks, overall, _, _ = _run(over, resources=certs)
    assert _by(checks)["certificates-valid"]["status"] == "pass" and overall == "healthy"


def test_certificates_expired_level():
    rows = [_cert("a", "expired"), _cert("b", "expired")]
    over = {"certificates-valid": {"warn": {"expired": 1}, "fail": {"expired": 3}}}
    checks, overall, _, _ = _run(over, resources=rows)
    check = _by(checks)["certificates-valid"]
    assert check["status"] == "warn" and check["value"]["expired"] == 2 and overall == "warning"


def test_quota_headroom_level():
    def quota(pct):
        return [{"key": "resourcequotas", "name": "q", "namespace": "web", "status": "warning",
                 "summary": {"max_percent": pct}}]

    checks, _, _, _ = _run(resources=quota(89.0))
    assert _by(checks)["quotas-headroom"]["status"] == "pass"
    checks, _, _, _ = _run(resources=quota(90.0))
    check = _by(checks)["quotas-headroom"]
    assert check["status"] == "warn" and check["value"] == {"max_percent": 90.0, "namespaces": 1}

    over = {"quotas-headroom": {"warn": {"max_percent": 95}, "fail": {"max_percent": 100}}}
    checks, _, _, _ = _run(over, resources=quota(100.0))
    assert _by(checks)["quotas-headroom"]["status"] == "fail"


def test_application_pods_percent_of_pods():
    namespaces = [{"name": "payments", "ns_class": "application", "pods_total": 20}]
    issues = [{"namespace": "payments", "name": f"api-{i}", "reason": "OOMKilled",
               "ns_class": "application"} for i in range(3)]
    over = {"application-pods": {"warn": {"issues_percent": 10}, "fail": {"issues_percent": 25}}}
    checks, _, _, _ = _run(over, namespaces=namespaces, pod_issues=issues)
    check = _by(checks)["application-pods"]
    assert check["status"] == "warn" and check["value"]["issues_percent"] == 15.0

    checks, _, _, _ = _run(over, namespaces=namespaces, pod_issues=issues * 2)   # 6/20 = 30%
    assert _by(checks)["application-pods"]["status"] == "fail"


def test_disabled_check_is_not_run_and_not_shown():
    over = {"capacity-headroom": {"enabled": False}}
    checks, overall, score, _ = _run(over, capacity={"metrics_available": True, "cpu_usage": 9.9,
                                                     "cpu_allocatable": 10.0, "memory_usage": 1,
                                                     "memory_allocatable": 10})
    assert "capacity-headroom" not in _by(checks)
    assert overall == "healthy" and score == 100


def test_severity_override_changes_the_rollup():
    ops = [{"name": "etcd", "degraded": True, "critical": False, "available": True,
            "progressing": False}]
    checks, overall, score, _ = _run(operators=ops)
    assert _by(checks)["no-degraded-operators"]["status"] == "fail" and overall == "critical"
    assert score == 70

    over = {"no-degraded-operators": {"severity": "warning"}}
    checks, overall, score, _ = _run(over, operators=ops)
    check = _by(checks)["no-degraded-operators"]
    assert check["status"] == "fail" and check["severity"] == "warning"
    assert overall == "warning" and score == 85


def test_info_severity_never_degrades_the_rollup():
    over = {"no-degraded-operators": {"severity": "info"}}
    ops = [{"name": "etcd", "degraded": True, "critical": False, "available": True,
            "progressing": False}]
    checks, overall, score, counts = _run(over, operators=ops)
    check = _by(checks)["no-degraded-operators"]
    assert check["status"] == "fail" and check["severity"] == "info"
    assert overall == "healthy" and score == 100 and counts["failed"] == 1


def test_version_floor_is_configurable():
    checks, overall, _, _ = _run(version="4.15.9")
    assert _by(checks)["version-supported"]["status"] == "pass" and overall == "healthy"

    over = {"version-supported": {"fail": {"floor": "4.16.0"}}}
    checks, overall, _, _ = _run(over, version="4.15.9")
    check = _by(checks)["version-supported"]
    assert check["status"] == "fail" and "4.16.0" in check["message"] and overall == "warning"

    over = {"version-supported": {"warn": {"floor": "4.17.0"}, "fail": {"floor": "4.16.0"}}}
    checks, _, _, _ = _run(over, version="4.16.7")
    assert _by(checks)["version-supported"]["status"] == "warn"


def test_legacy_thresholds_are_the_defaults():
    """The flat block keeps working: it sets the levels it always meant."""
    configs = resolve_check_configs(
        {"capacity_warning_percent": 70, "capacity_critical_percent": 80,
         "certificate_expiry_days": 45, "quota_warning_percent": 60},
        supported_floor="4.15.0")
    assert configs["capacity-headroom"].warn == {"used_percent": 70}
    assert configs["capacity-headroom"].fail == {"used_percent": 80}
    assert configs["certificates-valid"].warn["expiring_within_days"] == 45
    assert configs["quotas-headroom"].warn == {"max_percent": 60}

    checks, _, _, _ = run_health_checks(
        _base(capacity={"metrics_available": True, "cpu_usage": 7.5, "cpu_allocatable": 10.0,
                        "memory_usage": 1, "memory_allocatable": 10}),
        "4.15.0", checks_config=configs)
    assert _by(checks)["capacity-headroom"]["status"] == "warn"


def test_unreachable_check_can_be_disabled():
    configs = resolve_check_configs(T, {"cluster-reachable": {"enabled": False}},
                                supported_floor="4.15.0")
    checks, _, _, counts = run_health_checks(_base(reachable=False, error="boom"), "4.15.0",
                                             checks_config=configs)
    assert checks == [] and counts == {"passed": 0, "warned": 0, "failed": 0}


def test_a_band_replaces_the_default_band():
    """What an operator writes is what is graded - bands do not merge."""
    over = {"nodes-ready": {"fail": {"not_ready_percent": 50}}}
    configs = resolve_check_configs(T, over, supported_floor="4.15.0")
    assert configs["nodes-ready"].fail == {"not_ready_percent": 50}      # not_ready: 1 is gone
    checks, _, _, _ = run_health_checks(_base(nodes_total=10, nodes_ready=9), "4.15.0",
                                        checks_config=configs)
    assert _by(checks)["nodes-ready"]["status"] == "pass"
