"""
Precondition health checks - the "is this cluster fit?" panel.

Each check is a pure function of the data we collected from a cluster, so the
same logic runs identically against kind-backed fixtures or a real OCP cluster.
A check returns one of pass / warn / fail at a severity; the cluster's overall
status is the worst result across all checks.

Every check is configurable from the manifest's `health_checks:` section
(`app/manifest.py` parses and validates it, this module owns the catalogue and
the defaults):

    health_checks:
      no-degraded-operators:
        enabled: true          # a disabled check is not run and not shown
        severity: warning      # what a FAILING check means for the rollup
        warn: { degraded: 1 }  # levels in the check's own unit
        fail: { degraded: 3 }

A measured value at or above `fail` is a fail, at or above `warn` is a warn,
otherwise the check passes (`version-supported`'s `floor` is the one level that
compares the other way: a version *below* it is the bad one). A band that is
given replaces that band's defaults outright, so `fail: { degraded: 3 }` with no
`warn:` means "never warn, fail at three", and a level nobody set is never
evaluated. The defaults in `CHECK_SPECS` reproduce the behaviour this panel had
before it was configurable.

Rollup:

  * a `fail` at severity `critical` makes the cluster `critical`;
  * a `fail` at severity `warning`, and any `warn`, makes it `warning`;
  * anything at severity `info` is surfaced but never degrades the rollup.

Two results are deliberately informational whatever the check's severity is,
because they report missing data or an expected transition rather than ill
health: `capacity-headroom` when `metrics.k8s.io` is not served, `nodes-ready`
when no nodes were collected, and `machine-config-pools` while a pool updates.
"""
from dataclasses import dataclass, field
from datetime import UTC, datetime

SEVERITIES = ("critical", "warning", "info")
BANDS = ("warn", "fail")

# Comparisons a level may use:
#   gte     the measured value at or above the level trips it (counts, percents)
#   lt      the measured value below the level trips it (a version floor)
#   window  not compared - it parameterises what the band measures (a cert window)
_COMPARES = ("gte", "lt", "window")


@dataclass(frozen=True)
class Level:
    """One configurable number on a check: its unit and how it is compared."""
    key: str
    unit: str                 # count | percent | days | version
    doc: str
    compare: str = "gte"

    @property
    def ascending(self) -> bool:
        """True when `warn` must be at or below `fail` (the usual direction)."""
        return self.compare == "gte"


@dataclass(frozen=True)
class CheckSpec:
    name: str
    title: str
    severity: str
    doc: str
    levels: tuple[Level, ...] = ()
    warn: dict = field(default_factory=dict)
    fail: dict = field(default_factory=dict)

    def level(self, key: str) -> Level | None:
        return next((lv for lv in self.levels if lv.key == key), None)

    @property
    def level_keys(self) -> tuple[str, ...]:
        return tuple(lv.key for lv in self.levels)


def _c(key, doc, compare="gte"):
    return Level(key, "count", doc, compare)


def _pct(key, doc):
    return Level(key, "percent", doc)


# --------------------------------------------------------------------------- #
# the catalogue - every check, its unit(s) and the levels it ships with
# --------------------------------------------------------------------------- #
_SPECS: tuple[CheckSpec, ...] = (
    CheckSpec(
        "cluster-reachable", "Cluster reachable", "critical",
        "Whether the collector could connect to the cluster at all. When it could not, "
        "this is the only check that runs - there is nothing else to evaluate.",
    ),
    CheckSpec(
        "managed-available", "ACM reports cluster available", "critical",
        "The hub's ManagedClusterConditionAvailable for this cluster.",
    ),
    CheckSpec(
        "cluster-version-available", "ClusterVersion available", "critical",
        "ClusterVersion is Available and not Failing.",
    ),
    CheckSpec(
        "critical-operators-available", "Critical operators available", "critical",
        "Cluster operators the registry marks critical (etcd, kube-apiserver, ...) "
        "reporting Available=False.",
        levels=(_c("unavailable", "critical cluster operators that are not available"),),
        fail={"unavailable": 1},
    ),
    CheckSpec(
        "no-degraded-operators", "No degraded operators", "critical",
        "Cluster operators reporting Degraded=True.",
        levels=(_c("degraded", "cluster operators reporting Degraded=True"),),
        fail={"degraded": 1},
    ),
    CheckSpec(
        "nodes-ready", "All nodes ready", "critical",
        "Nodes whose Ready condition is not True. A cluster that reported no nodes at "
        "all warns as informational (missing data, not a sick cluster).",
        levels=(_c("not_ready", "nodes that are not Ready"),
                _pct("not_ready_percent", "percent of the cluster's nodes that are not Ready")),
        fail={"not_ready": 1},
    ),
    CheckSpec(
        "nodes-pressure", "No node pressure", "warning",
        "Nodes reporting a pressure condition (memory / disk / PID) and nodes that are "
        "cordoned. Pressure fails, a cordon warns.",
        levels=(_c("pressured", "nodes reporting any pressure condition"),
                _c("cordoned", "nodes that are not schedulable")),
        warn={"cordoned": 1},
        fail={"pressured": 1},
    ),
    CheckSpec(
        "version-supported", "Running a supported version", "warning",
        "The cluster's OCP version against the supported floor. A version BELOW the "
        "floor trips the band; the default floor is SUPPORTED_FLOOR.",
        levels=(Level("floor", "version", "lowest OCP version considered supported",
                      compare="lt"),),
        fail={"floor": None},        # None: filled in from SUPPORTED_FLOOR
    ),
    CheckSpec(
        "upgrade-in-progress", "No upgrade in progress", "info",
        "Whether ClusterVersion is applying a new release. Informational by default: an "
        "upgrade is expected work, not ill health.",
    ),
    CheckSpec(
        "operators-stable", "Operators settled", "warning",
        "Cluster operators reporting Progressing=True outside an upgrade (an operator "
        "mid-rollout when the cluster is not upgrading). Zero while the cluster upgrades.",
        levels=(_c("progressing", "cluster operators progressing outside an upgrade"),),
        warn={"progressing": 1},
    ),
    CheckSpec(
        "machine-config-pools", "Machine config pools healthy", "critical",
        "MachineConfigPools that are degraded or still rolling out. An updating pool is "
        "reported as informational - it is a transition, not a fault.",
        levels=(_c("degraded", "machine config pools in a degraded state"),
                _c("updating", "machine config pools still rolling out a machine config")),
        warn={"updating": 1},
        fail={"degraded": 1},
    ),
    CheckSpec(
        "platform-pods", "Platform pods healthy", "warning",
        "Problem pods (crash-looping, OOM-killed, unschedulable, long-pending, "
        "high-restart) in OpenShift / Kubernetes platform namespaces.",
        levels=(_c("issues", "problem pods in platform namespaces"),
                _pct("issues_percent", "percent of the platform namespaces' pods with a problem")),
        warn={"issues": 1},
    ),
    CheckSpec(
        "application-pods", "Application pods healthy", "info",
        "Problem pods in application namespaces. Informational by default: one "
        "application's broken pod is not the cluster's problem.",
        levels=(_c("issues", "problem pods in application namespaces"),
                _pct("issues_percent", "percent of the application namespaces' pods with a problem")),
        warn={"issues": 1},
    ),
    CheckSpec(
        "capacity-headroom", "Capacity headroom", "warning",
        "Live usage against allocatable, whichever of CPU and memory is worse. Reported "
        "as informational when the cluster does not serve metrics.k8s.io.",
        levels=(_pct("used_percent", "the worse of CPU and memory usage, as a percent of allocatable"),),
        warn={"used_percent": 85},
        fail={"used_percent": 95},
    ),
    CheckSpec(
        "certificates-valid", "Certificates valid", "warning",
        "Certificates found in Secrets and ConfigMaps. `expiring_within_days` is the "
        "band's window: a band counts the certificates expiring inside its own window "
        "and compares that count with its `expiring` level.",
        levels=(_c("expired", "certificates whose notAfter has passed"),
                _c("expiring", "certificates expiring inside the band's window"),
                Level("expiring_within_days", "days",
                      "how far ahead the band looks for expiring certificates",
                      compare="window")),
        warn={"expiring": 1, "expiring_within_days": 30},
        fail={"expired": 1},
    ),
    CheckSpec(
        "quotas-headroom", "Resource quotas have headroom", "info",
        "The most-consumed ResourceQuota in the cluster, as a percent of its hard limit.",
        levels=(_pct("max_percent", "highest ResourceQuota usage against a hard limit"),
                _c("namespaces", "namespaces whose quota is at or above the warn percent")),
        warn={"max_percent": 90},
    ),
    CheckSpec(
        "olm-operators-healthy", "OLM operators installed", "warning",
        "ClusterServiceVersions not in Succeeded phase. Skipped entirely on a cluster "
        "without OLM.",
        levels=(_c("unhealthy", "ClusterServiceVersions not in the Succeeded phase"),),
        warn={"unhealthy": 1},
    ),
    CheckSpec(
        "update-available", "Update available", "info",
        "Whether ClusterVersion offers a newer release. Only reported when there is one "
        "and the cluster is not already upgrading.",
    ),
)

CHECK_SPECS: dict[str, CheckSpec] = {s.name: s for s in _SPECS}
CHECK_NAMES: tuple[str, ...] = tuple(CHECK_SPECS)

# The flat `thresholds:` keys that predate `health_checks:`. They stay supported
# and become the defaults of the check level they always meant. The other
# thresholds (pod_restart_threshold, pod_pending_seconds, cluster_admin_roles,
# and certificate_expiry_days / quota_warning_percent in their parser role) act
# at COLLECTION time and are not health-check levels; see docs/ocp-api-manifest.md.
LEGACY_THRESHOLDS: dict[str, tuple[str, str, str]] = {
    "capacity_warning_percent": ("capacity-headroom", "warn", "used_percent"),
    "capacity_critical_percent": ("capacity-headroom", "fail", "used_percent"),
    "certificate_expiry_days": ("certificates-valid", "warn", "expiring_within_days"),
    "quota_warning_percent": ("quotas-headroom", "warn", "max_percent"),
}


# --------------------------------------------------------------------------- #
# effective configuration
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class CheckConfig:
    """One check's effective configuration: defaults, then the flat legacy
    thresholds, then the manifest's `health_checks:` entry."""
    spec: CheckSpec
    enabled: bool
    severity: str
    warn: dict
    fail: dict

    @property
    def name(self) -> str:
        return self.spec.name

    @property
    def title(self) -> str:
        return self.spec.title

    def band(self, band: str) -> dict:
        return self.warn if band == "warn" else self.fail

    def level(self, band: str, key: str):
        return self.band(band).get(key)

    def bands(self) -> dict:
        """Both bands, as a check result reports them: {"warn": {...}, "fail": {...}}."""
        return {"warn": dict(self.warn), "fail": dict(self.fail)}


def resolve_check_configs(thresholds: dict | None = None, overrides: dict | None = None,
                          supported_floor: str | None = None) -> dict[str, CheckConfig]:
    """Every check's effective configuration.

    `thresholds` is the manifest's flat legacy block, `overrides` its validated
    `health_checks:` section, `supported_floor` the SUPPORTED_FLOOR setting that
    `version-supported` falls back to.
    """
    thresholds = thresholds or {}
    overrides = overrides or {}

    bands: dict[str, dict[str, dict]] = {
        name: {"warn": dict(spec.warn), "fail": dict(spec.fail)}
        for name, spec in CHECK_SPECS.items()
    }
    if supported_floor:
        bands["version-supported"]["fail"]["floor"] = supported_floor
    for key, (check, band, level) in LEGACY_THRESHOLDS.items():
        if thresholds.get(key) is not None:
            bands[check][band][level] = thresholds[key]

    configs: dict[str, CheckConfig] = {}
    for name, spec in CHECK_SPECS.items():
        over = overrides.get(name) or {}
        # A band that is set REPLACES the default band rather than merging into
        # it, so what an operator writes is exactly what is graded (and `warn: {}`
        # means "never warn").
        warn = over["warn"] if "warn" in over else bands[name]["warn"]
        fail = over["fail"] if "fail" in over else bands[name]["fail"]
        configs[name] = CheckConfig(
            spec=spec,
            enabled=bool(over.get("enabled", True)),
            severity=over.get("severity") or spec.severity,
            warn={k: v for k, v in warn.items() if v is not None},
            fail={k: v for k, v in fail.items() if v is not None},
        )
    return configs


def describe_checks(configs: dict[str, CheckConfig]) -> list[dict]:
    """The effective health-check configuration, as GET /api/manifest serves it."""
    out = []
    for name in CHECK_NAMES:
        cfg = configs[name]
        out.append({
            "name": name,
            "title": cfg.title,
            "enabled": cfg.enabled,
            "severity": cfg.severity,
            "description": cfg.spec.doc,
            "units": [{"key": lv.key, "unit": lv.unit, "compare": lv.compare,
                       "description": lv.doc} for lv in cfg.spec.levels],
            "warn": dict(cfg.warn),
            "fail": dict(cfg.fail),
        })
    return out


# --------------------------------------------------------------------------- #
# grading
# --------------------------------------------------------------------------- #
def version_tuple(v: str | None):
    if not v:
        return (0, 0, 0)
    parts = []
    for part in str(v).split("."):
        num = "".join(ch for ch in part if ch.isdigit())
        parts.append(int(num) if num else 0)
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts[:3])


def _trips(level: Level, measured, threshold) -> bool:
    if measured is None or threshold is None:
        return False
    if level.compare == "window":
        return False
    if level.compare == "lt":
        return version_tuple(measured) < version_tuple(threshold)
    return measured >= threshold


def grade(cfg: CheckConfig, measure) -> str:
    """`fail`, `warn` or `pass` for one check's measurement.

    `measure` is the measured values keyed by unit, or a callable taking the
    band's levels for a check whose measurement depends on them (a window).
    """
    for band in ("fail", "warn"):
        levels = cfg.band(band)
        if not levels:
            continue
        values = measure(levels) if callable(measure) else measure
        if any(_trips(cfg.spec.level(key), values.get(key), threshold)
               for key, threshold in levels.items()):
            return band
    return "pass"


# --------------------------------------------------------------------------- #
# helpers over the collected document
# --------------------------------------------------------------------------- #
def _names(rows, limit=4):
    names = [r.get("name") or "" for r in rows]
    extra = f" (+{len(names) - limit})" if len(names) > limit else ""
    return ", ".join(names[:limit]) + extra


def _by_key(c, key):
    return [r for r in c.get("resources", []) if r.get("key") == key]


def _percent(part, total):
    return round(100.0 * part / total, 1) if total else None


def _pods_in(c, ns_class: str):
    """Pods in one class of namespace, or None when namespaces were not collected."""
    rows = [n for n in c.get("namespaces") or []
            if (n.get("ns_class") == "platform") == (ns_class == "platform")]
    return sum(n.get("pods_total") or 0 for n in rows) or None


def _days_to_expiry(row, now):
    exp = row.get("expires_at")
    if isinstance(exp, str):
        try:
            exp = datetime.fromisoformat(exp.replace("Z", "+00:00"))
        except ValueError:
            return None
    if not isinstance(exp, datetime):
        return None
    if exp.tzinfo is None:
        exp = exp.replace(tzinfo=UTC)
    return (exp - now).total_seconds() / 86400.0


class _Panel:
    """The checks that ran, in the order the panel presents them."""

    def __init__(self, configs: dict[str, CheckConfig]):
        self.configs = configs
        self.checks: list[dict] = []

    def wants(self, name: str) -> CheckConfig | None:
        """The check's config when it is enabled - a disabled check never runs."""
        cfg = self.configs[name]
        return cfg if cfg.enabled else None

    def add(self, cfg: CheckConfig, status: str, message: str = "", value: dict | None = None,
            severity: str | None = None, title: str | None = None):
        self.checks.append({
            "name": cfg.name,
            "title": title or cfg.title,
            "status": status,
            "severity": severity or cfg.severity,
            "message": message,
            # Additive, so a reader sees "87% used (warn 85, fail 95)" without
            # having to go and read the manifest.
            "value": value or {},
            "levels": cfg.bands(),
        })


# --------------------------------------------------------------------------- #
# the panel
# --------------------------------------------------------------------------- #
def run_health_checks(c: dict, supported_floor: str, thresholds: dict | None = None,
                      checks_config: dict[str, CheckConfig] | None = None):
    """Return (checks, overall_status, score, counts).

    `checks_config` is the manifest's effective configuration
    (`Manifest.health_check_config()`); without it the panel runs on its
    defaults plus whatever the flat `thresholds` block overrides.
    """
    configs = checks_config or resolve_check_configs(thresholds, supported_floor=supported_floor)
    p = _Panel(configs)
    now = datetime.now(UTC)

    if not c.get("reachable", True):
        if cfg := p.wants("cluster-reachable"):
            p.add(cfg, "fail", c.get("error") or "could not connect to the managed cluster",
                  {"reachable": False})
        return _finalize(p.checks)

    ops = c.get("operators", [])
    degraded = [o for o in ops if o["degraded"]]
    crit_unavailable = [o for o in ops if o["critical"] and not o["available"]]
    upgrading = bool(c.get("upgrading"))
    progressing_ops = [] if upgrading else [o for o in ops if o["progressing"]]

    # 1. ACM availability
    if cfg := p.wants("managed-available"):
        available = bool(c.get("managed_available", True))
        p.add(cfg, "pass" if available else "fail",
              "" if available else "hub reports ManagedClusterConditionAvailable=False",
              {"available": available})

    # 2. ClusterVersion available
    if cfg := p.wants("cluster-version-available"):
        cv_available = c.get("cv_available", True)
        cv_failing = c.get("cv_failing", False)
        ok = cv_available and not cv_failing
        p.add(cfg, "pass" if ok else "fail",
              "" if ok else "ClusterVersion is reporting Failing/Available=False",
              {"available": bool(cv_available), "failing": bool(cv_failing)})

    # 3. critical operators available
    if cfg := p.wants("critical-operators-available"):
        value = {"unavailable": len(crit_unavailable)}
        status = grade(cfg, value)
        p.add(cfg, status, "" if status == "pass" else
              "unavailable: " + ", ".join(o["name"] for o in crit_unavailable), value)

    # 4. no degraded operators
    if cfg := p.wants("no-degraded-operators"):
        value = {"degraded": len(degraded)}
        status = grade(cfg, value)
        p.add(cfg, status, "" if status == "pass" else
              "degraded: " + ", ".join(o["name"] for o in degraded), value)

    # 5. nodes ready
    if cfg := p.wants("nodes-ready"):
        nt, nr = c.get("nodes_total", 0), c.get("nodes_ready", 0)
        if not nt:
            # No nodes collected at all: missing data, not a sick cluster.
            p.add(cfg, "warn", "no nodes collected", {"not_ready": None}, severity="info")
        else:
            value = {"not_ready": nt - nr, "not_ready_percent": _percent(nt - nr, nt)}
            p.add(cfg, grade(cfg, value), f"{nr}/{nt} nodes ready", value)

    # 6. node pressure / schedulability
    if cfg := p.wants("nodes-pressure"):
        nodes = c.get("nodes", [])
        pressured = [n for n in nodes if any((n.get("conditions") or {}).values())]
        cordoned = [n for n in nodes if not n.get("schedulable", True)]
        value = {"pressured": len(pressured), "cordoned": len(cordoned)}
        status = grade(cfg, value)
        if status == "pass":
            message = ""
        elif pressured:
            message = "pressure on: " + _names(pressured)
        else:
            message = "cordoned: " + _names(cordoned)
        p.add(cfg, status, message, value)

    # 7. supported version
    if cfg := p.wants("version-supported"):
        version = c.get("version")
        value = {"floor": version}     # graded against the band's floor
        status = grade(cfg, value)
        floor = cfg.level("fail", "floor") or cfg.level("warn", "floor") or supported_floor
        p.add(cfg, status, "" if status == "pass" else
              f"{version} is past the supported floor {floor}", {"version": version})

    # 8. upgrade in progress (informational by default)
    if cfg := p.wants("upgrade-in-progress"):
        p.add(cfg, "warn" if upgrading else "pass",
              f"upgrading to {c.get('desired_version')} "
              f"({c.get('upgrade_percent', 0)}% complete)" if upgrading else "",
              {"upgrading": upgrading},
              title="Upgrade in progress" if upgrading else None)

    # 9. operators mid-rollout
    if cfg := p.wants("operators-stable"):
        value = {"progressing": len(progressing_ops)}
        status = grade(cfg, value)
        p.add(cfg, status, "" if status == "pass" else
              "progressing: " + ", ".join(o["name"] for o in progressing_ops), value)

    # 10. machine config pools
    mcps = _by_key(c, "machineconfigpools")
    collected = c.get("resource_status", {}).get("machineconfigpools", {}).get("status") == "collected"
    if (cfg := p.wants("machine-config-pools")) and (mcps or collected):
        mcp_degraded = [m for m in mcps if m["status"] == "degraded"]
        mcp_updating = [m for m in mcps if m["status"] == "updating"]
        value = {"degraded": len(mcp_degraded), "updating": len(mcp_updating)}
        status = grade(cfg, value)
        if status == "pass":
            p.add(cfg, status, "", value)
        elif mcp_degraded:
            p.add(cfg, status, "degraded: " + _names(mcp_degraded), value)
        else:
            # An updating pool is a transition, not a fault.
            p.add(cfg, status, "updating: " + _names(mcp_updating), value, severity="info")

    # 11. platform workloads (pods in OpenShift namespaces)
    # 12. application workloads (an app problem is not a cluster problem)
    for name, ns_class in (("platform-pods", "platform"), ("application-pods", "application")):
        if not (cfg := p.wants(name)):
            continue
        issues = [i for i in c.get("pod_issues", [])
                  if (i.get("ns_class") == "platform") == (ns_class == "platform")]
        value = {"issues": len(issues),
                 "issues_percent": _percent(len(issues), _pods_in(c, ns_class))}
        status = grade(cfg, value)
        if status == "pass":
            message = ""
        elif ns_class == "platform":
            message = (f"{len(issues)} problem pod(s): "
                       + ", ".join(f"{i['namespace']}/{i['name']} ({i['reason']})"
                                   for i in issues[:3])
                       + (f" (+{len(issues) - 3})" if len(issues) > 3 else ""))
        else:
            message = (f"{len(issues)} problem pod(s) across "
                       f"{len({i['namespace'] for i in issues})} namespace(s)")
        p.add(cfg, status, message, value)

    # 13. capacity (live usage vs allocatable)
    if cfg := p.wants("capacity-headroom"):
        cap = c.get("capacity") or {}
        worst = []
        for label, used, alloc in (("CPU", cap.get("cpu_usage"), cap.get("cpu_allocatable")),
                                   ("memory", cap.get("memory_usage"), cap.get("memory_allocatable"))):
            if used is not None and alloc:
                worst.append((label, 100.0 * used / alloc))
        if not cap.get("metrics_available"):
            p.add(cfg, "warn", "metrics.k8s.io is not available on this cluster - usage unknown",
                  {"used_percent": None}, severity="info")
        elif worst:
            label, pct = max(worst, key=lambda w: w[1])
            value = {"used_percent": round(pct, 1)}
            status = grade(cfg, value)
            p.add(cfg, status,
                  f"{label} at {pct:.0f}% of allocatable" if status != "pass"
                  else f"peak {label} {pct:.0f}% of allocatable", value)
        else:
            p.add(cfg, "pass", "", {"used_percent": None})

    # 14. certificates
    if cfg := p.wants("certificates-valid"):
        certs = [r for r in c.get("resources", []) if r.get("key") in ("secrets", "configmaps")
                 and r.get("status") in ("expiring", "expired")]
        expired = [r for r in certs if r["status"] == "expired"]

        def expiring_within(days):
            """Certificates expiring inside `days`. One whose expiry the collector
            could not parse counts in every window - it was flagged at collection
            time, which is all we know about it."""
            if days is None:
                return []
            rows = []
            for r in certs:
                if r["status"] == "expired":
                    continue
                left = _days_to_expiry(r, now)
                if left is None or left <= days:
                    rows.append(r)
            return rows

        def measure(levels):
            return {"expired": len(expired),
                    "expiring": len(expiring_within(levels.get("expiring_within_days")))}

        status = grade(cfg, measure)
        window = cfg.level("warn", "expiring_within_days")
        expiring = expiring_within(window)
        value = {"expired": len(expired), "expiring": len(expiring)}
        if status == "pass":
            message = ""
        elif expired:
            message = f"{len(expired)} expired: " + _names(expired, 3)
        else:
            message = f"{len(expiring)} expiring within {window} days: " + _names(expiring, 3)
        p.add(cfg, status, message, value)

    # 15. resource quotas
    if cfg := p.wants("quotas-headroom"):
        quotas = _by_key(c, "resourcequotas")
        percents = [(q, (q.get("summary") or {}).get("max_percent")) for q in quotas]
        percents = [(q, pct) for q, pct in percents if pct is not None]
        worst = max((pct for _, pct in percents), default=None)
        warn_at = cfg.level("warn", "max_percent")
        near = [q for q, pct in percents if warn_at is None or pct >= warn_at]
        value = {"max_percent": worst, "namespaces": len(near)}
        status = grade(cfg, value)
        p.add(cfg, status, "" if status == "pass" else "near limit: "
              + ", ".join(f"{q['namespace']}/{q['name']} ({q['summary']['max_percent']:.0f}%)"
                          for q in near[:3]), value)

    # 16. OLM operators
    csvs = _by_key(c, "clusterserviceversions")
    if (cfg := p.wants("olm-operators-healthy")) and csvs:
        bad_csvs = [r for r in csvs if r["status"] not in ("succeeded", "unknown")]
        value = {"unhealthy": len(bad_csvs)}
        status = grade(cfg, value)
        p.add(cfg, status, "" if status == "pass" else
              ", ".join(f"{r['name']} ({r['summary'].get('phase')})" for r in bad_csvs[:3]), value)

    # 17. update available (informational)
    updates = c.get("available_updates") or []
    if (cfg := p.wants("update-available")) and updates and not upgrading:
        p.add(cfg, "warn", "available: " + ", ".join(updates[:3]),
              {"available_updates": len(updates)})

    return _finalize(p.checks)


def _finalize(checks):
    passed = sum(1 for c in checks if c["status"] == "pass")
    warned = sum(1 for c in checks if c["status"] == "warn")
    failed = sum(1 for c in checks if c["status"] == "fail")

    # A fail at critical severity is what makes a cluster critical. A fail at
    # warning severity, and any warn, make it a warning. Results at info
    # severity (available updates, an upgrade, missing metrics) are surfaced
    # but never degrade the rollup.
    crit_fail = any(c["status"] == "fail" and c["severity"] == "critical" for c in checks)
    warn_level = any(c["status"] in ("fail", "warn") and c["severity"] in ("critical", "warning")
                     for c in checks)

    if crit_fail:
        overall = "critical"
    elif warn_level:
        overall = "warning"
    else:
        overall = "healthy"

    penalty = 0
    for c in checks:
        if c["severity"] == "info":
            continue
        if c["status"] == "fail":
            penalty += 30 if c["severity"] == "critical" else 15
        elif c["status"] == "warn":
            penalty += 8
    score = max(0, 100 - penalty)

    return checks, overall, score, {
        "passed": passed, "warned": warned, "failed": failed,
    }
