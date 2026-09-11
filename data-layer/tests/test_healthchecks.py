from app.collector.healthchecks import run_health_checks

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
