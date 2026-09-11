"""
Precondition health checks - the "is this cluster fit?" panel.

Each check is a pure function of the data we collected from a cluster, so the
same logic runs identically against kind-backed fixtures or a real OCP cluster.
A check returns one of pass / warn / fail at a severity; the cluster's overall
status is the worst result across all checks. Thresholds come from the manifest.
"""


def _ver_tuple(v: str | None):
    if not v:
        return (0, 0, 0)
    parts = []
    for part in str(v).split("."):
        num = "".join(ch for ch in part if ch.isdigit())
        parts.append(int(num) if num else 0)
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts[:3])


def _check(name, title, status, severity, message=""):
    return {"name": name, "title": title, "status": status,
            "severity": severity, "message": message}


def _names(rows, limit=4):
    names = [r.get("name") or "" for r in rows]
    extra = f" (+{len(names) - limit})" if len(names) > limit else ""
    return ", ".join(names[:limit]) + extra


def _by_key(c, key):
    return [r for r in c.get("resources", []) if r.get("key") == key]


def run_health_checks(c: dict, supported_floor: str, thresholds: dict | None = None):
    """Return (checks, overall_status, score, counts)."""
    t = dict(thresholds or {})
    checks = []

    if not c.get("reachable", True):
        checks.append(_check(
            "cluster-reachable", "Cluster reachable", "fail", "critical",
            c.get("error") or "could not connect to the managed cluster"))
        return _finalize(checks)

    ops = c.get("operators", [])
    degraded = [o for o in ops if o["degraded"]]
    crit_unavailable = [o for o in ops if o["critical"] and not o["available"]]
    progressing_ops = [o for o in ops if o["progressing"]]

    # 1. ACM availability
    checks.append(_check(
        "managed-available", "ACM reports cluster available",
        "pass" if c.get("managed_available", True) else "fail",
        "critical",
        "" if c.get("managed_available", True)
        else "hub reports ManagedClusterConditionAvailable=False"))

    # 2. ClusterVersion available
    cv_available = c.get("cv_available", True)
    cv_failing = c.get("cv_failing", False)
    checks.append(_check(
        "cluster-version-available", "ClusterVersion available",
        "pass" if cv_available and not cv_failing else "fail", "critical",
        "" if cv_available and not cv_failing
        else "ClusterVersion is reporting Failing/Available=False"))

    # 3. critical operators available
    checks.append(_check(
        "critical-operators-available", "Critical operators available",
        "pass" if not crit_unavailable else "fail", "critical",
        "" if not crit_unavailable
        else "unavailable: " + ", ".join(o["name"] for o in crit_unavailable)))

    # 4. no degraded operators
    checks.append(_check(
        "no-degraded-operators", "No degraded operators",
        "pass" if not degraded else "fail", "critical",
        "" if not degraded
        else "degraded: " + ", ".join(o["name"] for o in degraded)))

    # 5. nodes ready
    nt, nr = c.get("nodes_total", 0), c.get("nodes_ready", 0)
    checks.append(_check(
        "nodes-ready", "All nodes ready",
        "pass" if nt and nr == nt else ("fail" if nt else "warn"), "critical",
        f"{nr}/{nt} nodes ready"))

    # 6. node pressure / schedulability
    nodes = c.get("nodes", [])
    pressured = [n for n in nodes if any((n.get("conditions") or {}).values())]
    cordoned = [n for n in nodes if not n.get("schedulable", True)]
    if pressured:
        checks.append(_check(
            "nodes-pressure", "No node pressure", "fail", "warning",
            "pressure on: " + _names(pressured)))
    elif cordoned:
        checks.append(_check(
            "nodes-pressure", "No node pressure", "warn", "warning",
            "cordoned: " + _names(cordoned)))
    else:
        checks.append(_check("nodes-pressure", "No node pressure", "pass", "warning"))

    # 7. supported version
    supported = _ver_tuple(c.get("version")) >= _ver_tuple(supported_floor)
    checks.append(_check(
        "version-supported", "Running a supported version",
        "pass" if supported else "fail", "warning",
        "" if supported
        else f"{c.get('version')} is past the supported floor {supported_floor}"))

    # 8. upgrade in progress (informational warn)
    if c.get("upgrading"):
        checks.append(_check(
            "upgrade-in-progress", "Upgrade in progress", "warn", "info",
            f"upgrading to {c.get('desired_version')} "
            f"({c.get('upgrade_percent', 0)}% complete)"))
    else:
        checks.append(_check(
            "upgrade-in-progress", "No upgrade in progress", "pass", "info"))

    # 9. operators mid-rollout
    if progressing_ops and not c.get("upgrading"):
        checks.append(_check(
            "operators-stable", "Operators settled", "warn", "warning",
            "progressing: " + ", ".join(o["name"] for o in progressing_ops)))
    else:
        checks.append(_check(
            "operators-stable", "Operators settled", "pass", "warning"))

    # 10. machine config pools
    mcps = _by_key(c, "machineconfigpools")
    mcp_degraded = [m for m in mcps if m["status"] == "degraded"]
    mcp_updating = [m for m in mcps if m["status"] == "updating"]
    if mcp_degraded:
        checks.append(_check(
            "machine-config-pools", "Machine config pools healthy", "fail", "critical",
            "degraded: " + _names(mcp_degraded)))
    elif mcp_updating:
        checks.append(_check(
            "machine-config-pools", "Machine config pools healthy", "warn", "info",
            "updating: " + _names(mcp_updating)))
    elif mcps or c.get("resource_status", {}).get("machineconfigpools", {}).get("status") == "collected":
        checks.append(_check("machine-config-pools", "Machine config pools healthy", "pass", "critical"))

    # 11. platform workloads (pods in OpenShift namespaces)
    platform_issues = [i for i in c.get("pod_issues", []) if i.get("ns_class") == "platform"]
    checks.append(_check(
        "platform-pods", "Platform pods healthy",
        "warn" if platform_issues else "pass", "warning",
        "" if not platform_issues else
        f"{len(platform_issues)} problem pod(s): "
        + ", ".join(f"{i['namespace']}/{i['name']} ({i['reason']})" for i in platform_issues[:3])
        + (f" (+{len(platform_issues) - 3})" if len(platform_issues) > 3 else "")))

    # 12. application workloads (informational: an app problem is not a cluster problem)
    app_issues = [i for i in c.get("pod_issues", []) if i.get("ns_class") != "platform"]
    checks.append(_check(
        "application-pods", "Application pods healthy",
        "warn" if app_issues else "pass", "info",
        "" if not app_issues else
        f"{len(app_issues)} problem pod(s) across "
        f"{len({i['namespace'] for i in app_issues})} namespace(s)"))

    # 13. capacity (live usage vs allocatable)
    cap = c.get("capacity") or {}
    warn_pct = t.get("capacity_warning_percent", 85)
    crit_pct = t.get("capacity_critical_percent", 95)
    worst = []
    for label, used, alloc in (("CPU", cap.get("cpu_usage"), cap.get("cpu_allocatable")),
                               ("memory", cap.get("memory_usage"), cap.get("memory_allocatable"))):
        if used is not None and alloc:
            worst.append((label, 100.0 * used / alloc))
    if not cap.get("metrics_available"):
        checks.append(_check(
            "capacity-headroom", "Capacity headroom", "warn", "info",
            "metrics.k8s.io is not available on this cluster - usage unknown"))
    elif worst:
        label, pct = max(worst, key=lambda w: w[1])
        status = "fail" if pct >= crit_pct else "warn" if pct >= warn_pct else "pass"
        checks.append(_check(
            "capacity-headroom", "Capacity headroom", status, "warning",
            f"{label} at {pct:.0f}% of allocatable" if status != "pass"
            else f"peak {label} {pct:.0f}% of allocatable"))
    else:
        checks.append(_check("capacity-headroom", "Capacity headroom", "pass", "warning"))

    # 14. certificates
    certs = [r for r in c.get("resources", []) if r.get("key") in ("secrets", "configmaps")
             and r.get("status") in ("expiring", "expired")]
    expired = [r for r in certs if r["status"] == "expired"]
    if expired:
        checks.append(_check(
            "certificates-valid", "Certificates valid", "fail", "warning",
            f"{len(expired)} expired: " + _names(expired, 3)))
    elif certs:
        checks.append(_check(
            "certificates-valid", "Certificates valid", "warn", "warning",
            f"{len(certs)} expiring within {t.get('certificate_expiry_days', 30)} days: "
            + _names(certs, 3)))
    else:
        checks.append(_check("certificates-valid", "Certificates valid", "pass", "warning"))

    # 15. resource quotas
    quotas = [r for r in _by_key(c, "resourcequotas") if r["status"] in ("warning", "exhausted")]
    checks.append(_check(
        "quotas-headroom", "Resource quotas have headroom",
        "warn" if quotas else "pass", "info",
        "" if not quotas else "near limit: "
        + ", ".join(f"{q['namespace']}/{q['name']} ({q['summary']['max_percent']:.0f}%)"
                    for q in quotas[:3])))

    # 16. OLM operators
    csvs = _by_key(c, "clusterserviceversions")
    bad_csvs = [r for r in csvs if r["status"] not in ("succeeded", "unknown")]
    if csvs:
        checks.append(_check(
            "olm-operators-healthy", "OLM operators installed", "warn" if bad_csvs else "pass",
            "warning", "" if not bad_csvs else
            ", ".join(f"{r['name']} ({r['summary'].get('phase')})" for r in bad_csvs[:3])))

    # 17. update available (informational)
    updates = c.get("available_updates") or []
    if updates and not c.get("upgrading"):
        checks.append(_check(
            "update-available", "Update available", "warn", "info",
            "available: " + ", ".join(updates[:3])))

    return _finalize(checks)


def _finalize(checks):
    passed = sum(1 for c in checks if c["status"] == "pass")
    warned = sum(1 for c in checks if c["status"] == "warn")
    failed = sum(1 for c in checks if c["status"] == "fail")

    crit_fail = any(c["status"] == "fail" and c["severity"] == "critical" for c in checks)
    # A warning-level fail or warn moves the rollup to "warning"; info results
    # (available updates, upgrade-in-progress) are surfaced but don't degrade it.
    warn_level = any(
        c["status"] in ("fail", "warn") and c["severity"] == "warning"
        for c in checks
    )

    if crit_fail:
        overall = "critical"
    elif warn_level:
        overall = "warning"
    else:
        overall = "healthy"

    penalty = 0
    for c in checks:
        if c["status"] == "fail":
            penalty += 30 if c["severity"] == "critical" else 15
        elif c["status"] == "warn" and c["severity"] == "warning":
            penalty += 8
    score = max(0, 100 - penalty)

    return checks, overall, score, {
        "passed": passed, "warned": warned, "failed": failed,
    }
