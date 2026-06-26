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
    name: str
    region: str = None
    datacenter: str = None
    kubeconfig: str = None


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

    hubs = [HubConfig(**{k: h.get(k) for k in ("name", "region", "datacenter", "kubeconfig")})
            for h in (raw.get("hubs") or [])]

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
