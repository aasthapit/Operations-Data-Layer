"""
Application mapping: which namespace on which cluster belongs to which
business application.

Some estates do not label namespaces; they keep a registry that maps
(cluster, namespace) to an application, a line of business and an
environment. When the manifest's `applications.source` is `mapping`, that
file is the only source of ownership: labels are ignored, every resource in a
namespace belongs to the namespace's application, and a namespace absent from
the file is "not under a business application" (app_name NULL, assigned
false).

The file is JSON or YAML: a list of records, or an object whose `items` is
that list. Field names are configurable in the manifest, so the records can be
whatever the registry exports, for example

    {"cluster": "lew06", "namespace": "1aat-dev", "app_id": "1aat",
     "lob": "wimt", "environment": "development", "env": "nonprod"}

The file is re-read when it changes on disk, so a registry export can be
refreshed without restarting the collector.
"""
from __future__ import annotations

import json
import logging
import os
import threading
from collections import Counter
from dataclasses import dataclass

import yaml

log = logging.getLogger("odl.appmap")

# data layer field -> record key
DEFAULT_FIELDS = {
    "cluster": "cluster",
    "namespace": "namespace",
    "app": "app_id",
    "team": "lob",
    "environment": "environment",
    "cluster_environment": "env",
}


@dataclass(frozen=True)
class Assignment:
    app: str
    team: str | None
    environment: str | None
    cluster_environment: str | None


def _text(value) -> str | None:
    if value is None:
        return None
    value = str(value).strip()
    return value or None


class AppMap:
    def __init__(self, records: list, fields: dict | None = None, source: str = ""):
        f = {**DEFAULT_FIELDS, **(fields or {})}
        self.source = source
        self._by_namespace: dict[tuple[str, str], Assignment] = {}
        votes: dict[str, Counter] = {}
        self.skipped = 0
        for rec in records:
            if not isinstance(rec, dict):
                self.skipped += 1
                continue
            cluster = _text(rec.get(f["cluster"]))
            namespace = _text(rec.get(f["namespace"]))
            app = _text(rec.get(f["app"]))
            if not (cluster and namespace and app):
                self.skipped += 1
                continue
            hit = Assignment(app=app, team=_text(rec.get(f["team"])),
                             environment=_text(rec.get(f["environment"])),
                             cluster_environment=_text(rec.get(f["cluster_environment"])))
            self._by_namespace[(cluster, namespace)] = hit     # a later record wins
            if hit.cluster_environment:
                votes.setdefault(cluster, Counter())[hit.cluster_environment] += 1
        self._cluster_environment = {c: v.most_common(1)[0][0] for c, v in votes.items()}
        self.records = len(records)

    def lookup(self, cluster: str, namespace: str) -> Assignment | None:
        return self._by_namespace.get((cluster, namespace))

    def cluster_environment(self, cluster: str) -> str | None:
        """The environment the mapping's records agree on for a cluster, used
        when ACM carries no environment label for it."""
        return self._cluster_environment.get(cluster)

    @property
    def clusters(self) -> int:
        return len({c for c, _ in self._by_namespace})

    @property
    def apps(self) -> int:
        return len({a.app for a in self._by_namespace.values()})

    def describe(self) -> dict:
        return {"source": self.source, "records": self.records, "skipped": self.skipped,
                "namespaces": len(self._by_namespace), "clusters": self.clusters, "apps": self.apps}


def load_appmap(path: str, fields: dict | None = None) -> AppMap:
    with open(path) as fh:
        raw = yaml.safe_load(fh) if path.endswith((".yaml", ".yml")) else json.load(fh)
    if isinstance(raw, dict):
        raw = raw.get("items") or raw.get("records") or raw.get("applications") or []
    if not isinstance(raw, list):
        raise ValueError(f"{path}: expected a list of records (or an object with `items`)")
    appmap = AppMap(raw, fields, source=path)
    log.info("application mapping %s: %d records, %d namespaces, %d apps on %d clusters%s",
             path, appmap.records, len(appmap._by_namespace), appmap.apps, appmap.clusters,
             f", {appmap.skipped} skipped" if appmap.skipped else "")
    return appmap


def resolve_path(manifest) -> str:
    """ODL_APP_MAP, else the manifest's `applications.mapping.path`, resolved
    against the manifest file's own directory so the same manifest works in
    the container (/app/config) and on a host (data-layer/config)."""
    env = os.environ.get("ODL_APP_MAP")
    if env:
        return env
    path = (manifest.applications.get("mapping") or {}).get("path") or "app-map.json"
    if os.path.isabs(path):
        return path
    base = os.path.dirname(os.path.abspath(manifest.source)) if manifest.source else os.getcwd()
    return os.path.join(base, path)


_lock = threading.Lock()
_cached: tuple[str, float, AppMap] | None = None


def get_appmap(manifest) -> AppMap | None:
    """The mapping for this manifest, or None when ownership comes from labels.
    Raises FileNotFoundError when the manifest asks for a mapping that is not there."""
    global _cached
    if manifest.applications.get("source") != "mapping":
        return None
    path = resolve_path(manifest)
    mtime = os.stat(path).st_mtime
    with _lock:
        if _cached and _cached[0] == path and _cached[1] == mtime:
            return _cached[2]
        appmap = load_appmap(path, (manifest.applications.get("mapping") or {}).get("fields"))
        _cached = (path, mtime, appmap)
        return appmap


def reset_cache() -> None:
    """Tests."""
    global _cached
    _cached = None
