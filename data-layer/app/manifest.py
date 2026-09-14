"""
The OCP API manifest - what the collector is allowed to read from a cluster,
how namespaces are classified, where application ownership comes from, and the
thresholds the health checks use.

Loaded once at startup from ODL_MANIFEST (default: the bundled
config/ocp-api-manifest.yaml) and validated against the resource registry, so
a typo in a resource key fails fast instead of silently collecting nothing.

Also a CLI:
    python -m app.manifest validate      # check the manifest loads
    python -m app.manifest rbac          # emit the read-only ClusterRole it needs
"""
import sys
from dataclasses import dataclass, field

import yaml

from .appmap import DEFAULT_FIELDS
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


class ManifestError(ValueError):
    pass


@dataclass
class ResourceConfig:
    key: str
    enabled: bool = True
    namespace_class: str = "all"      # all | application | platform
    limit: int | None = None


@dataclass
class Manifest:
    resources: dict[str, ResourceConfig]
    platform_names: set[str]
    platform_prefixes: tuple[str, ...]
    platform_label_keys: tuple[str, ...]
    ownership: dict[str, list[str]]
    keep_annotations: tuple[str, ...]
    thresholds: dict = field(default_factory=dict)
    source: str = ""
    # {source: labels|mapping, mapping: {path, fields}}; see app/appmap.py
    applications: dict = field(default_factory=lambda: {
        "source": "labels", "mapping": {"path": None, "fields": dict(DEFAULT_FIELDS)}})

    # -- resources ----------------------------------------------------------
    def enabled(self, key: str) -> bool:
        cfg = self.resources.get(key)
        return bool(cfg and cfg.enabled)

    def enabled_keys(self) -> list[str]:
        return [k for k in REGISTRY if self.enabled(k)]

    def config(self, key: str) -> ResourceConfig:
        return self.resources.get(key) or ResourceConfig(key=key, enabled=False)

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
            "thresholds": {**_DEFAULT_THRESHOLDS, **self.thresholds},
            "applications": self.applications,
        }

    def rbac_clusterrole(self, name="odl-collector-readonly") -> dict:
        return {
            "apiVersion": "rbac.authorization.k8s.io/v1",
            "kind": "ClusterRole",
            "metadata": {"name": name, "labels": {"app": "odl"}},
            "rules": rbac_rules(self.enabled_keys()),
        }


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
        bad = sorted(set(opts) - {"enabled", *spec.options})
        if bad:
            raise ManifestError(f"resource `{key}` has unsupported option(s): {', '.join(bad)}")
        ns_class = opts.get("namespace_class", "all")
        if ns_class not in ("all", APPLICATION, PLATFORM):
            raise ManifestError(f"resource `{key}`: namespace_class must be all|application|platform")
        resources[key] = ResourceConfig(
            key=key, enabled=bool(opts.get("enabled", True)),
            namespace_class=ns_class, limit=opts.get("limit"))

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
    applications = {"source": apps_source,
                    "mapping": {"path": mapping.get("path"),
                                "fields": {**DEFAULT_FIELDS, **(mapping.get("fields") or {})}}}

    thresholds = dict(raw.get("thresholds") or {})
    bad = sorted(set(thresholds) - set(_DEFAULT_THRESHOLDS))
    if bad:
        raise ManifestError(f"unknown threshold(s): {', '.join(bad)}")

    return Manifest(
        resources=resources,
        platform_names=set(platform.get("names") or []),
        platform_prefixes=tuple(platform.get("prefixes") or []),
        platform_label_keys=tuple(platform.get("label_keys") or []),
        ownership=ownership,
        keep_annotations=tuple(raw.get("keep_annotations") or []),
        thresholds=thresholds,
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
        print(f"ok: {m.source} - {len(m.enabled_keys())}/{len(REGISTRY)} resources enabled")
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
