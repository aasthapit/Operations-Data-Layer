"""
Precondition health checks - the Azure-style "is this cluster fit?" panel.

Each check is a pure function of the data we collected from a cluster, so the
same logic runs identically against kind-backed fixtures or a real OCP cluster.
A check returns one of pass / warn / fail at a severity; the cluster's overall
status is the worst result across all checks.
"""
from typing import Optional


def _ver_tuple(v: Optional[str]):
    if not v:
        return (0, 0, 0)
    parts = []
    for p in str(v).split("."):
        num = "".join(ch for ch in p if ch.isdigit())
        parts.append(int(num) if num else 0)
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts[:3])


def _check(name, title, status, severity, message=""):
    return {"name": name, "title": title, "status": status,
            "severity": severity, "message": message}


def run_health_checks(c: dict, supported_floor: str):
    """Return (checks, overall_status, score, counts)."""
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

    # 6. supported version
    supported = _ver_tuple(c.get("version")) >= _ver_tuple(supported_floor)
    checks.append(_check(
        "version-supported", "Running a supported version",
        "pass" if supported else "fail", "warning",
        "" if supported
        else f"{c.get('version')} is past the supported floor {supported_floor}"))

    # 7. upgrade in progress (informational warn)
    if c.get("upgrading"):
        checks.append(_check(
            "upgrade-in-progress", "Upgrade in progress", "warn", "info",
            f"upgrading to {c.get('desired_version')} "
            f"({c.get('upgrade_percent', 0)}% complete)"))
    else:
        checks.append(_check(
            "upgrade-in-progress", "No upgrade in progress", "pass", "info"))

    # 8. operators mid-rollout
    if progressing_ops and not c.get("upgrading"):
        checks.append(_check(
            "operators-stable", "Operators settled", "warn", "warning",
            "progressing: " + ", ".join(o["name"] for o in progressing_ops)))
    else:
        checks.append(_check(
            "operators-stable", "Operators settled", "pass", "warning"))

    # 9. update available (informational)
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
