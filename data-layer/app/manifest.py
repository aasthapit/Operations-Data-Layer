"""
The OCP API manifest - what the collector is allowed to read from a cluster,
how namespaces are classified, where application ownership comes from, and how
every health check is graded.

Two kinds of number live here, and the difference matters:

  * COLLECTION time - `thresholds:` inputs the parsers apply while a cluster is
    being read, so they decide what the stored document says (a pod is an issue,
    a certificate is "expiring", a quota is "warning"): pod_restart_threshold,
    pod_pending_seconds, certificate_expiry_days, quota_warning_percent,
    cluster_admin_roles. Changing one only takes effect on the next sweep.
  * EVALUATION time - `health_checks:` levels the health checks apply to an
    already-collected document. Changing one re-grades the fleet on the next
    sweep without collecting anything different.

The flat `thresholds:` keys that used to drive the checks keep working and
become the defaults of the check level they always meant (see
LEGACY_THRESHOLDS in app/collector/healthchecks.py).

A third number lives on each resource: `interval:`, how often that kind is
collected. It is neither collection nor evaluation time - it is SCHEDULE time.
0 (the default) means every sweep; "15m" means the collector fetches that kind
only when it is due and keeps the previous rows in between (see
app/collector/collect.py). It is what makes an estate of hundreds of clusters
affordable: platform state stays fresh, inventory is re-read on its own tier.

Loaded once at startup from ODL_MANIFEST (default: the bundled
config/ocp-api-manifest.yaml) and validated against the resource registry, so
a typo in a resource key fails fast instead of silently collecting nothing.

Also a CLI:
    python -m app.manifest validate      # check the manifest loads
    python -m app.manifest rbac          # emit the read-only ClusterRole it needs
"""
import re
import sys
from dataclasses import dataclass, field
from functools import cached_property

import yaml

from .appmap import DEFAULT_FIELDS
from .collector.healthchecks import (
    BANDS,
    CHECK_SPECS,
    SEVERITIES,
    CheckConfig,
    describe_checks,
    resolve_check_configs,
    version_tuple,
)
from .collector.registry import REGISTRY, SCRUB_POLICY, rbac_rules
from .settings import settings

APPLICATION = "application"
PLATFORM = "platform"

_DEFAULT_THRESHOLDS = {
    "certificate_expiry_days": 30,
    "pod_restart_threshold": 5,
    "pod_pending_seconds": 300,
    "quota_warning_percent": 90,
    "capacity_warning_percent": 85,
    "capacity_critical_percent": 95,
    "cluster_admin_roles": ["cluster-admin"],
}

# When each flat threshold acts. "collection" ones shape the document the
# collector stores and only take effect on the next sweep; "evaluation" ones are
# defaults for a `health_checks:` level and re-grade what is already stored.
_THRESHOLD_SCOPE = {
    "certificate_expiry_days": "collection+evaluation",
    "pod_restart_threshold": "collection",
    "pod_pending_seconds": "collection",
    "quota_warning_percent": "collection+evaluation",
    "capacity_warning_percent": "evaluation",
    "capacity_critical_percent": "evaluation",
    "cluster_admin_roles": "collection",
}


class ManifestError(ValueError):
    pass


@dataclass
class ResourceConfig:
    key: str
    enabled: bool = True
    namespace_class: str = "all"      # all | application | platform
    limit: int | None = None
    # How often this kind is collected, in seconds. 0 = every sweep (the
    # default). A kind with an interval is fetched only when it is due; in
    # between, the cluster document keeps the rows of the last collection.
    interval_seconds: int = 0


# Duration suffixes accepted by `interval:` ("90", 90, "2m", "15m", "1h", "1d").
_INTERVAL_UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400}
_INTERVAL_RE = re.compile(r"^(\d+(?:\.\d+)?)\s*([smhd]?)$")


def parse_interval(value, where: str) -> int:
    """`interval:` as whole seconds. Accepts a number of seconds or a duration
    string with a unit suffix; 0 (or absent) means "every sweep"."""
    if value is None:
        return 0
    bad = ManifestError(
        f"{where}: interval must be a number of seconds or a duration like 30s, 2m, 15m, 1h "
        f"(got {value!r})")
    if isinstance(value, bool):
        raise bad
    if isinstance(value, int | float):
        seconds = float(value)
    elif isinstance(value, str):
        m = _INTERVAL_RE.match(value.strip())
        if not m:
            raise bad
        seconds = float(m.group(1)) * _INTERVAL_UNITS[m.group(2) or "s"]
    else:
        raise bad
    if seconds < 0:
        raise ManifestError(f"{where}: interval must not be negative (got {value!r})")
    return int(seconds)


@dataclass
class Manifest:
    resources: dict[str, ResourceConfig]
    platform_names: set[str]
    platform_prefixes: tuple[str, ...]
    platform_label_keys: tuple[str, ...]
    ownership: dict[str, list[str]]
    keep_annotations: tuple[str, ...]
    thresholds: dict = field(default_factory=dict)
    # Per-check overrides, already validated: {check name: {enabled, severity, warn, fail}}.
    health_checks: dict = field(default_factory=dict)
    source: str = ""
    # {source: labels|mapping, mapping: {path, fields}}; see app/appmap.py
    applications: dict = field(default_factory=lambda: {
        "source": "labels",
        "mapping": {"path": None, "fields": dict(DEFAULT_FIELDS), "fallback": "none"},
        "platform_apps": []})

    # -- resources ----------------------------------------------------------
    def enabled(self, key: str) -> bool:
        cfg = self.resources.get(key)
        return bool(cfg and cfg.enabled)

    def enabled_keys(self) -> list[str]:
        return [k for k in REGISTRY if self.enabled(k)]

    def config(self, key: str) -> ResourceConfig:
        return self.resources.get(key) or ResourceConfig(key=key, enabled=False)

    def interval(self, key: str) -> int:
        """Seconds between collections of this kind; 0 = every sweep."""
        return self.config(key).interval_seconds

    def tiered(self) -> bool:
        """Whether any enabled kind has an interval of its own. When nothing
        does, a sweep collects everything and the collector never has to read
        the previous state back."""
        return any(self.config(key).interval_seconds > 0 for key in self.enabled_keys())

    # -- namespaces ---------------------------------------------------------
    def classify_namespace(self, name: str, labels: dict | None = None) -> str:
        if name in self.platform_names or name.startswith(self.platform_prefixes):
            return PLATFORM
        if labels and any(k in labels for k in self.platform_label_keys):
            return PLATFORM
        return APPLICATION

    def wants_namespace(self, key: str, ns_class: str) -> bool:
        want = self.config(key).namespace_class
        return want == "all" or want == ns_class

    def threshold(self, name: str):
        return self.thresholds.get(name, _DEFAULT_THRESHOLDS.get(name))

    def effective_thresholds(self) -> dict:
        return {**_DEFAULT_THRESHOLDS, **self.thresholds}

    # -- health checks ------------------------------------------------------
    @cached_property
    def health_check_config(self) -> dict[str, CheckConfig]:
        """Every check's effective configuration: the catalogue's defaults, then
        the flat `thresholds:` block, then this manifest's `health_checks:`
        entries. Computed once - a manifest never changes after it is loaded."""
        return resolve_check_configs(self.effective_thresholds(), self.health_checks,
                                     supported_floor=settings.supported_floor)

    # -- presentation -------------------------------------------------------
    def describe(self) -> dict:
        """The manifest as the API serves it."""
        resources = []
        for key, spec in REGISTRY.items():
            cfg = self.config(key)
            resources.append({
                "key": key,
                "kind": spec.kind,
                "api_group": spec.api_group_label,
                "version": spec.version,
                "scope": spec.scope,
                "domain": spec.domain,
                "enabled": cfg.enabled,
                "namespace_class": cfg.namespace_class if spec.scope == "namespaced" else None,
                "limit": cfg.limit,
                # 0 = collected every sweep; otherwise the kind's own tier.
                "interval_seconds": cfg.interval_seconds,
                "description": spec.description,
            })
        return {
            "source": self.source,
            "resources": resources,
            "scrub_policy": SCRUB_POLICY,
            "namespaces": {
                "platform_names": sorted(self.platform_names),
                "platform_prefixes": list(self.platform_prefixes),
                "platform_label_keys": list(self.platform_label_keys),
                "ownership": self.ownership,
            },
            "keep_annotations": list(self.keep_annotations),
            "thresholds": self.effective_thresholds(),
            # Which of those act while a cluster is read, and which while it is graded.
            "threshold_scope": dict(_THRESHOLD_SCOPE),
            "health_checks": describe_checks(self.health_check_config),
            "applications": self.applications,
        }

    def rbac_clusterrole(self, name="odl-collector-readonly") -> dict:
        return {
            "apiVersion": "rbac.authorization.k8s.io/v1",
            "kind": "ClusterRole",
            "metadata": {"name": name, "labels": {"app": "odl"}},
            "rules": rbac_rules(self.enabled_keys()),
        }


def _level_value(check: str, band: str, level, value):
    """One `warn:` / `fail:` value, checked against its level's unit."""
    if value is None:               # an explicit null clears the default level
        return None
    if level.unit == "version":
        if not isinstance(value, str) or not value.strip():
            raise ManifestError(
                f"health check `{check}`: `{band}.{level.key}` must be a version string "
                f'such as "4.15.0" (got {value!r})')
        return value
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ManifestError(
            f"health check `{check}`: `{band}.{level.key}` must be a number "
            f"({level.unit}), got {value!r}")
    if value < 0:
        raise ManifestError(f"health check `{check}`: `{band}.{level.key}` must not be negative")
    return value


def _validate_bands(configs: dict[str, CheckConfig]):
    """`warn` must be reached before `fail`, whichever way the level compares."""
    for name, cfg in configs.items():
        for level in cfg.spec.levels:
            warn, fail = cfg.warn.get(level.key), cfg.fail.get(level.key)
            if warn is None or fail is None:
                continue
            if level.unit == "version":
                bad, rule = version_tuple(warn) < version_tuple(fail), "at or above"
            elif level.compare == "window":
                bad, rule = warn < fail, "at or above"
            else:
                bad, rule = warn > fail, "at or below"
            if bad:
                raise ManifestError(
                    f"health check `{name}`: `warn.{level.key}` ({warn}) must be {rule} "
                    f"`fail.{level.key}` ({fail}) - a check has to warn before it fails")


def _parse_health_checks(raw: dict, thresholds: dict) -> dict:
    """The `health_checks:` section, validated against the check catalogue."""
    section = raw.get("health_checks") or {}
    if not isinstance(section, dict):
        raise ManifestError("`health_checks` must be a mapping of check name -> options")
    unknown = sorted(set(section) - set(CHECK_SPECS))
    if unknown:
        raise ManifestError(
            f"unknown health check(s) in manifest: {', '.join(unknown)}. "
            f"Known checks: {', '.join(CHECK_SPECS)}")

    overrides: dict[str, dict] = {}
    for name, opts in section.items():
        spec = CHECK_SPECS[name]
        if opts is None:
            opts = {}
        if isinstance(opts, bool):
            opts = {"enabled": opts}
        if not isinstance(opts, dict):
            raise ManifestError(f"health check `{name}` must be a mapping or a boolean")
        bad = sorted(set(opts) - {"enabled", "severity", *BANDS})
        if bad:
            raise ManifestError(
                f"health check `{name}` has unsupported option(s): {', '.join(bad)} "
                f"(supported: enabled, severity, {', '.join(BANDS)})")

        entry: dict = {}
        if "enabled" in opts:
            if not isinstance(opts["enabled"], bool):
                raise ManifestError(f"health check `{name}`: enabled must be true or false")
            if name == "cluster-reachable" and not opts["enabled"]:
                # The only check that runs for an unreachable cluster; without it
                # such a cluster would report healthy on an empty panel.
                raise ManifestError("health check `cluster-reachable` cannot be disabled")
            entry["enabled"] = opts["enabled"]
        if "severity" in opts:
            if opts["severity"] not in SEVERITIES:
                raise ManifestError(
                    f"health check `{name}`: severity must be {' | '.join(SEVERITIES)} "
                    f"(got {opts['severity']!r})")
            entry["severity"] = opts["severity"]
        for band in BANDS:
            if band not in opts:
                continue
            levels = opts[band] or {}
            if not isinstance(levels, dict):
                raise ManifestError(
                    f"health check `{name}`: `{band}` must be a mapping of level -> value")
            if not spec.levels:
                raise ManifestError(
                    f"health check `{name}` measures nothing, so it takes no `{band}:` levels "
                    f"- it only has `enabled` and `severity`")
            bad = sorted(set(levels) - set(spec.level_keys))
            if bad:
                raise ManifestError(
                    f"health check `{name}`: unknown level(s) in `{band}`: {', '.join(bad)}. "
                    f"Levels of this check: {', '.join(spec.level_keys)}")
            entry[band] = {key: _level_value(name, band, spec.level(key), value)
                           for key, value in levels.items()}
        overrides[name] = entry

    _validate_bands(resolve_check_configs(thresholds, overrides,
                                          supported_floor=settings.supported_floor))
    return overrides


def parse_manifest(raw: dict, source: str = "") -> Manifest:
    raw = raw or {}
    res_raw = raw.get("resources") or {}
    if not isinstance(res_raw, dict):
        raise ManifestError("`resources` must be a mapping of key -> options")

    unknown = sorted(set(res_raw) - set(REGISTRY))
    if unknown:
        raise ManifestError(
            f"unknown resource key(s) in manifest: {', '.join(unknown)}. "
            f"Known keys: {', '.join(REGISTRY)}")

    resources: dict[str, ResourceConfig] = {}
    for key, spec in REGISTRY.items():
        opts = res_raw.get(key)
        if opts is None:
            resources[key] = ResourceConfig(key=key, enabled=False)
            continue
        if isinstance(opts, bool):
            opts = {"enabled": opts}
        if not isinstance(opts, dict):
            raise ManifestError(f"resource `{key}` must be a mapping or a boolean")
        bad = sorted(set(opts) - {"enabled", "interval", *spec.options})
        if bad:
            raise ManifestError(f"resource `{key}` has unsupported option(s): {', '.join(bad)}")
        ns_class = opts.get("namespace_class", "all")
        if ns_class not in ("all", APPLICATION, PLATFORM):
            raise ManifestError(f"resource `{key}`: namespace_class must be all|application|platform")
        resources[key] = ResourceConfig(
            key=key, enabled=bool(opts.get("enabled", True)),
            namespace_class=ns_class, limit=opts.get("limit"),
            interval_seconds=parse_interval(opts.get("interval"), f"resource `{key}`"))

    ns = raw.get("namespaces") or {}
    platform = ns.get("platform") or {}
    ownership = {k: list(v or []) for k, v in (ns.get("ownership") or {}).items()}
    for k in ("app", "team", "tier"):
        ownership.setdefault(k, [])

    apps_raw = raw.get("applications") or {}
    apps_source = apps_raw.get("source", "labels")
    if apps_source not in ("labels", "mapping"):
        raise ManifestError("applications.source must be labels or mapping")
    mapping = apps_raw.get("mapping") or {}
    bad = sorted(set(mapping.get("fields") or {}) - set(DEFAULT_FIELDS))
    if bad:
        raise ManifestError(f"applications.mapping.fields: unknown field(s): {', '.join(bad)} "
                            f"(known: {', '.join(DEFAULT_FIELDS)})")
    fallback = mapping.get("fallback", "none")
    if fallback not in ("none", "labels"):
        raise ManifestError("applications.mapping.fallback must be none or labels")
    platform_apps = []
    for i, entry in enumerate(apps_raw.get("platform_apps") or []):
        if not isinstance(entry, dict) or not entry.get("name") or not entry.get("namespaces"):
            raise ManifestError(f"applications.platform_apps[{i}]: needs `name` and a non-empty "
                                "`namespaces` list (exact names, or prefixes ending in *)")
        names = entry["namespaces"]
        if not isinstance(names, list) or not all(isinstance(n, str) and n for n in names):
            raise ManifestError(f"applications.platform_apps[{i}]: namespaces must be a list of strings")
        platform_apps.append({"name": str(entry["name"]), "team": entry.get("team"),
                              "tier": entry.get("tier"), "namespaces": list(names)})
    applications = {"source": apps_source,
                    "mapping": {"path": mapping.get("path"),
                                "fields": {**DEFAULT_FIELDS, **(mapping.get("fields") or {})},
                                "fallback": fallback},
                    "platform_apps": platform_apps}

    thresholds = dict(raw.get("thresholds") or {})
    bad = sorted(set(thresholds) - set(_DEFAULT_THRESHOLDS))
    if bad:
        raise ManifestError(f"unknown threshold(s): {', '.join(bad)}")

    health_checks = _parse_health_checks(raw, {**_DEFAULT_THRESHOLDS, **thresholds})

    return Manifest(
        resources=resources,
        platform_names=set(platform.get("names") or []),
        platform_prefixes=tuple(platform.get("prefixes") or []),
        platform_label_keys=tuple(platform.get("label_keys") or []),
        ownership=ownership,
        keep_annotations=tuple(raw.get("keep_annotations") or []),
        thresholds=thresholds,
        health_checks=health_checks,
        source=source,
        applications=applications,
    )


def load_manifest(path: str | None = None) -> Manifest:
    path = path or settings.manifest_path
    with open(path) as f:
        return parse_manifest(yaml.safe_load(f) or {}, source=path)


_manifest: Manifest | None = None


def get_manifest() -> Manifest:
    """Process-wide manifest, loaded on first use."""
    global _manifest
    if _manifest is None:
        _manifest = load_manifest()
    return _manifest


def _main(argv):
    cmd = argv[1] if len(argv) > 1 else "validate"
    m = load_manifest()
    if cmd == "validate":
        checks = m.health_check_config
        enabled_checks = sum(1 for c in checks.values() if c.enabled)
        print(f"ok: {m.source} - {len(m.enabled_keys())}/{len(REGISTRY)} resources enabled, "
              f"{enabled_checks}/{len(checks)} health checks enabled")
    elif cmd == "rbac":
        header = (
            "# Read-only access the Operations Data Layer collector needs on EACH\n"
            "# OpenShift cluster it polls. GENERATED from the OCP API manifest -\n"
            "# regenerate after changing config/ocp-api-manifest.yaml:\n"
            "#\n"
            "#     cd data-layer && .venv/bin/python -m app.manifest rbac \\\n"
            "#         > ../deploy/rbac/odl-collector-readonly.yaml\n"
            "#\n"
            "# The collector only ever reads. ConfigMap / Secret values, certificate\n"
            "# material and env values are scrubbed at parse time and never stored;\n"
            "# the read access below is what lets it report key names, references and\n"
            "# certificate expiry (see docs/ocp-api-manifest.md).\n"
        )
        binding = {
            "apiVersion": "rbac.authorization.k8s.io/v1",
            "kind": "ClusterRoleBinding",
            "metadata": {"name": "odl-collector-readonly", "labels": {"app": "odl"}},
            "roleRef": {"apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole",
                        "name": "odl-collector-readonly"},
            "subjects": [{"apiGroup": "rbac.authorization.k8s.io", "kind": "User",
                          "name": "svc-ops-data"}],
        }
        sys.stdout.write(header)
        sys.stdout.write("---\n")
        yaml.safe_dump(m.rbac_clusterrole(), sys.stdout, sort_keys=False)
        sys.stdout.write("---\n")
        sys.stdout.write("# Bind to the shared service-account *user* (the username/password identity\n"
                         "# from your IdP). Swap kind/name if you use a Kubernetes ServiceAccount.\n")
        yaml.safe_dump(binding, sys.stdout, sort_keys=False)
    else:
        sys.exit(f"unknown command: {cmd} (validate | rbac)")


if __name__ == "__main__":
    _main(sys.argv)
