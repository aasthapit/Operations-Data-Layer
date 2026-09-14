"""
Load and normalise the fleet config.

The config has three optional top-level sections:

    defaults:        # shared settings applied to every cluster
      auth: {...}
      insecure_skip_tls_verify: false
    hubs:            # ACM hubs to discover ManagedClusters from (kubeconfig)
      - {name, region, datacenter, kubeconfig}
    clusters:        # a direct list of live OCP API endpoints
      - {name, api_url, region, datacenter, environment, cloud, hub, auth}

`auth` supports:
    {type: password, username, password}     # OCP OAuth challenge flow
    {type: token,    token}                   # a pre-minted bearer token
    {type: kubeconfig, kubeconfig: <path>}    # a kubeconfig file (hubs use this)

Any string value may reference an environment variable as ${VAR}, so secrets do
not have to live in the file.
"""
import os
import re
from dataclasses import dataclass, field

import yaml

from .settings import settings

_ENV_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


def _expand(value):
    if isinstance(value, str):
        return _ENV_RE.sub(lambda m: os.environ.get(m.group(1), ""), value)
    if isinstance(value, list):
        return [_expand(v) for v in value]
    if isinstance(value, dict):
        return {k: _expand(v) for k, v in value.items()}
    return value


@dataclass
class HubConfig:
    """An ACM hub. Reached through a kubeconfig file (the kind fleet) or through
    `api_url` + `auth` like a direct cluster (a real hub behind a service
    account). `managed_access` says how its ManagedClusters are reached:
    `secret` (a kubeconfig Secret on the hub: Hive-provisioned clusters, the
    kind fleet), `shared` (the cluster's own API URL from the ManagedCluster
    with this hub's `auth`: imported clusters), or `auto` (secret, else shared)."""
    name: str
    region: str = None
    datacenter: str = None
    kubeconfig: str = None
    api_url: str = None
    auth: dict = field(default_factory=dict)
    insecure_skip_tls_verify: bool = False
    ca_cert: str = None
    managed_access: str = "auto"
    # Where a managed cluster's API server is when ACM did not record one on
    # the ManagedCluster: a template with {name}, e.g.
    # "https://api.{name}.ocp.example.net:6443".
    managed_api_url: str = None


@dataclass
class ClusterConfig:
    name: str
    api_url: str
    region: str = None
    datacenter: str = None
    environment: str = None
    cloud: str = None
    hub: str = "direct"
    auth: dict = field(default_factory=dict)
    insecure_skip_tls_verify: bool = False
    ca_cert: str = None


@dataclass
class FleetConfig:
    defaults: dict = field(default_factory=dict)
    hubs: list = field(default_factory=list)
    clusters: list = field(default_factory=list)


def load_config(path: str = None) -> FleetConfig:
    path = path or settings.config_path
    with open(path) as f:
        raw = _expand(yaml.safe_load(f) or {})

    defaults = raw.get("defaults", {}) or {}
    default_auth = defaults.get("auth", {}) or {}
    default_insecure = bool(defaults.get("insecure_skip_tls_verify", False))
    default_ca = defaults.get("ca_cert")

    default_access = defaults.get("managed_access", "auto")
    default_managed_url = defaults.get("managed_api_url")
    hubs = []
    for h in raw.get("hubs") or []:
        if not h.get("kubeconfig") and not h.get("api_url"):
            raise ValueError(f"hub {h.get('name')!r}: needs 'kubeconfig' or 'api_url' (+ auth)")
        access = h.get("managed_access", default_access)
        if access not in ("auto", "secret", "shared"):
            raise ValueError(f"hub {h.get('name')!r}: managed_access must be auto, secret or shared")
        hubs.append(HubConfig(
            name=h["name"], region=h.get("region"), datacenter=h.get("datacenter"),
            kubeconfig=h.get("kubeconfig"), api_url=h.get("api_url"),
            auth={**default_auth, **(h.get("auth") or {})},
            insecure_skip_tls_verify=bool(h.get("insecure_skip_tls_verify", default_insecure)),
            ca_cert=h.get("ca_cert", default_ca), managed_access=access,
            managed_api_url=h.get("managed_api_url", default_managed_url)))

    clusters = []
    for c in raw.get("clusters") or []:
        # per-cluster auth overrides the shared default auth
        merged_auth = {**default_auth, **(c.get("auth") or {})}
        clusters.append(ClusterConfig(
            name=c["name"],
            api_url=c["api_url"],
            region=c.get("region"),
            datacenter=c.get("datacenter"),
            environment=c.get("environment"),
            cloud=c.get("cloud"),
            hub=c.get("hub", "direct"),
            auth=merged_auth,
            insecure_skip_tls_verify=bool(
                c.get("insecure_skip_tls_verify", default_insecure)),
            ca_cert=c.get("ca_cert", default_ca),
        ))

    return FleetConfig(defaults=defaults, hubs=hubs, clusters=clusters)
