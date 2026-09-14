"""
Orchestrate a full collection sweep and persist it.

Flow (identical to what you'd run against real ACM):
    discover targets:
        for each hub: connect, list ManagedClusters, read each kubeconfig secret
        for each direct cluster: resolve a bearer token
    collect (in parallel, bounded by COLLECT_WORKERS):
        fetch every manifest-enabled resource, assemble the cluster document
    persist (sequentially, one transaction per cluster):
        run health checks, replace current state, append a snapshot

Reads never touch a cluster - the API serves whatever the last sweep wrote into
the store (see app/store/base.py and docs/redis-keyspace.md).
"""
import concurrent.futures
import logging
import threading
import time
import zlib
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime

from .. import kube
from ..clusterauth import resolve_bearer_token
from ..config_loader import load_config
from ..manifest import get_manifest
from ..query import invalidate as invalidate_query_snapshot
from ..settings import settings
from ..store import Store, get_store
from .collect import collect_managed_cluster, unreachable
from .healthchecks import run_health_checks
from .parsers import normalize_managedcluster

log = logging.getLogger("odl.runner")
_lock = threading.Lock()
_last_run = {"at": None, "ok": False, "trigger": None}
# The sweep in progress, for `/api/status` and the dashboard: a first sweep
# of a large hub takes minutes and the picture fills in cluster by cluster.
_progress = {"running": False, "trigger": None, "started_at": None,
             "total": 0, "done": 0, "ok": 0, "failed": 0}
_progress_lock = threading.Lock()


def _shard() -> tuple[int, int] | None:
    """(index, count) from COLLECT_SHARD="i/n", or None for the whole fleet."""
    raw = (settings.collect_shard or "").strip()
    if not raw:
        return None
    try:
        i, n = (int(x) for x in raw.split("/", 1))
    except ValueError as e:
        raise ValueError(f"COLLECT_SHARD must look like 0/4, got {raw!r}") from e
    if n < 1 or not 0 <= i < n:
        raise ValueError(f"COLLECT_SHARD {raw!r}: index must be 0..n-1 and n >= 1")
    return i, n


def in_shard(name: str, shard: tuple[int, int] | None) -> bool:
    """Whether an instance is responsible for a cluster. Stable across
    processes and restarts: a name always lands in the same shard."""
    if shard is None:
        return True
    i, n = shard
    return zlib.crc32(name.encode()) % n == i


def progress() -> dict:
    with _progress_lock:
        return dict(_progress)

# How long a single-cluster refresh may hold its lock before another caller may
# assume the holder died.
REFRESH_LOCK_MS = 120_000


def utcnow():
    return datetime.now(UTC)


@dataclass
class Target:
    hub: str
    meta: dict
    connect: Callable[[], kube.ApiBundle]


# --------------------------------------------------------------------------- #
# discovery
# --------------------------------------------------------------------------- #
# Kubeconfig Secrets ACM keeps in a managed cluster's namespace on the hub:
# the kind fleet's fixture name, then Hive's for clusters ACM provisioned.
_HUB_KUBECONFIG_SECRETS = ("{name}-kubeconfig", "{name}-admin-kubeconfig")


def _tls_verify(insecure_skip_tls_verify: bool, ca_cert: str | None):
    """What `requests` should verify against: False, the default bundle, or a
    CA file. Python does not use the OS keychain, so a corporate CA has to be
    given explicitly (`ca_cert`) or the OAuth login fails before RBAC is
    even consulted."""
    if insecure_skip_tls_verify:
        return False
    return ca_cert or True


def _hub_bundle(hub) -> kube.ApiBundle:
    """A client for the hub itself: kubeconfig file, or api_url + auth."""
    if hub.kubeconfig:
        return kube.bundle_from_file(hub.kubeconfig)
    verify = _tls_verify(hub.insecure_skip_tls_verify, hub.ca_cert)
    token = resolve_bearer_token(hub.api_url, hub.auth, verify=verify)
    if token is None:
        raise RuntimeError(f"hub {hub.name}: api_url needs auth of type token or password")
    return kube.bundle_from_endpoint(hub.api_url, token, verify=bool(verify), ca_cert=hub.ca_cert)


def _managed_connect(hub, hb: kube.ApiBundle, meta: dict) -> Callable[[], kube.ApiBundle]:
    """How to reach one ManagedCluster, per the hub's `managed_access`.

    A kubeconfig Secret on the hub exists for clusters ACM provisioned (Hive)
    and for the kind fleet; imported clusters have none, so they are reached
    at the API URL ACM recorded on the ManagedCluster, with the hub's shared
    credential (the same service account the direct list uses).
    """
    name = meta["name"]

    def via_secret():
        errors = []
        for pattern in _HUB_KUBECONFIG_SECRETS:
            secret = pattern.format(name=name)
            try:
                return kube.bundle_from_kubeconfig_str(kube.read_kubeconfig_secret(hb, name, secret))
            except Exception as e:  # noqa: BLE001 - every failure means "not this secret"
                errors.append(f"{secret}: {e}")
        raise RuntimeError("no kubeconfig secret on hub " + hub.name + " (" + "; ".join(errors) + ")")

    def via_shared():
        url = managed_api_url(hub, meta)
        if not url:
            raise RuntimeError(
                f"ManagedCluster {name}: no API URL (none recorded by ACM, no console URL claim, "
                f"and hub {hub.name} has no managed_api_url template)")
        verify = _tls_verify(hub.insecure_skip_tls_verify, hub.ca_cert)
        token = resolve_bearer_token(url, hub.auth, verify=verify)
        if token is None:
            raise RuntimeError(f"hub {hub.name}: shared access needs auth of type token or password")
        return kube.bundle_from_endpoint(url, token, verify=bool(verify), ca_cert=hub.ca_cert)

    def connect():
        if hub.managed_access == "secret":
            return via_secret()
        if hub.managed_access == "shared":
            return via_shared()
        try:
            return via_secret()
        except RuntimeError as secret_error:
            if not managed_api_url(hub, meta):
                raise
            log.debug("%s: %s; using the shared credential", name, secret_error)
            return via_shared()

    return connect


def managed_api_url(hub, meta: dict) -> str | None:
    """The API server of a managed cluster, best source first: what ACM
    recorded on the ManagedCluster, the hub's `managed_api_url` template, or
    the console URL claim (console-openshift-console.apps.<domain> ->
    api.<domain>:6443, the OpenShift convention)."""
    if meta.get("client_url"):
        return meta["client_url"]
    if hub.managed_api_url:
        return hub.managed_api_url.format(name=meta["name"])
    console = meta.get("console_url") or ""
    marker = "console-openshift-console.apps."
    if marker in console:
        domain = console.split(marker, 1)[1].split("/", 1)[0]
        return f"https://api.{domain}:6443"
    return None


def _discover_via_hubs(store: Store, hubs) -> list[Target]:
    """ACM mode: discover ManagedClusters on each hub."""
    targets = []
    for hub in hubs:
        placement = {k: v for k, v in (("region", hub.region),
                                       ("datacenter", hub.datacenter)) if v}
        try:
            hb = _hub_bundle(hub)
            managed = kube.list_managedclusters(hb)
        except Exception as e:  # noqa: BLE001
            log.warning("hub %s unreachable: %s", hub.name, e)
            store.upsert_hub(hub.name, **placement, reachable=False, last_error=str(e),
                             managed_count=0, last_synced=utcnow())
            continue
        store.upsert_hub(hub.name, **placement, reachable=True, last_error=None,
                         managed_count=len(managed), last_synced=utcnow())
        log.info("hub %s: %d managed clusters", hub.name, len(managed))
        if not managed:
            log.warning("hub %s lists no ManagedClusters: check that the identity may "
                        "list managedclusters.cluster.open-cluster-management.io", hub.name)
        for mc in managed:
            meta = normalize_managedcluster(mc)
            targets.append(Target(hub.name, meta, _managed_connect(hub, hb, meta)))
    return targets


def _discover_direct(store: Store, clusters) -> list[Target]:
    """Direct mode: a flat list of live OCP endpoints behind shared credentials."""
    targets = []
    counts: dict[str, int] = {}
    for c in clusters:
        counts[c.hub] = counts.get(c.hub, 0) + 1
        meta = {
            "name": c.name, "region": c.region, "datacenter": c.datacenter,
            "environment": c.environment, "cloud": c.cloud, "vendor": "OpenShift",
            "managed_available": True,
        }

        def connect(c=c):
            verify = _tls_verify(c.insecure_skip_tls_verify, c.ca_cert)
            token = resolve_bearer_token(c.api_url, c.auth, verify=verify)
            return kube.bundle_from_endpoint(c.api_url, token, verify=bool(verify), ca_cert=c.ca_cert)

        targets.append(Target(c.hub, meta, connect))
    for hub_name, n in counts.items():
        store.upsert_hub(hub_name, reachable=True, last_error=None,
                         managed_count=n, last_synced=utcnow())
    return targets


def _discover(store: Store) -> tuple[list[Target], int]:
    """Every cluster this data layer is responsible for, and the hub count."""
    cfg = load_config()
    targets: list[Target] = []
    hubs_total = 0
    if cfg.hubs:
        targets += _discover_via_hubs(store, cfg.hubs)
        hubs_total += len(cfg.hubs)
    if cfg.clusters:
        targets += _discover_direct(store, cfg.clusters)
        hubs_total += len({c.hub for c in cfg.clusters})
    return targets, hubs_total


# --------------------------------------------------------------------------- #
# collection
# --------------------------------------------------------------------------- #
def _gather(target: Target, manifest) -> tuple[Target, dict, bool]:
    """Connect + collect one cluster. Never raises; returns the document."""
    try:
        bundle = target.connect()
    except Exception as e:  # noqa: BLE001
        log.warning("%s unreachable: connect: %s", target.meta.get("name"), e)
        return target, unreachable(target.meta, f"connect: {e}"), False
    try:
        return target, collect_managed_cluster(bundle, target.meta, manifest), True
    except Exception as e:  # noqa: BLE001
        log.exception("collect %s failed", target.meta.get("name"))
        return target, unreachable(target.meta, str(e)), False


# --------------------------------------------------------------------------- #
# persistence
# --------------------------------------------------------------------------- #
def _persist(store: Store, target: Target, collected: dict, manifest):
    """Health-check the document and replace the cluster in one transaction."""
    thresholds = manifest.describe()["thresholds"]
    checks, overall, score, counts = run_health_checks(
        collected, settings.supported_floor, thresholds)
    store.persist_cluster(target.hub, collected, checks, overall, score, counts)


def _prune_vanished(store: Store, targets: list[Target]):
    """Drop clusters that are no longer discovered on a hub we could reach.

    A cluster removed from ACM (or from the direct list) must not linger as a
    stale row forever. Clusters under an unreachable hub are kept as-is: we
    cannot tell whether they are gone or the hub is merely down, so only hubs
    that answered this sweep get an entry in `seen`.
    """
    reachable = {h.name for h in store.hubs() if h.reachable}
    seen: dict[str, set[str]] = {name: set() for name in reachable}
    for t in targets:
        if t.hub in seen:
            seen[t.hub].add(t.meta["name"])
    store.prune_vanished(seen)


# --------------------------------------------------------------------------- #
# the sweep
# --------------------------------------------------------------------------- #
def run_collection(trigger="manual") -> dict:
    """Run one sweep. Returns a small summary dict."""
    if not _lock.acquire(blocking=False):
        return {"skipped": True, "reason": "a collection is already running"}

    started = time.time()
    store = get_store()
    run_id = store.begin_run(trigger)

    try:
        manifest = get_manifest()
        targets, hubs_total = _discover(store)

        # Every instance sees the whole fleet (discovery is cheap) and prunes
        # against it; only collection is partitioned across shards.
        _prune_vanished(store, targets)
        shard = _shard()
        mine = [t for t in targets if in_shard(t.meta["name"], shard)]
        if shard:
            log.info("shard %d/%d: collecting %d of %d clusters", shard[0], shard[1],
                     len(mine), len(targets))
        with _progress_lock:
            _progress.update({"running": True, "trigger": trigger, "started_at": utcnow(),
                              "total": len(mine), "done": 0, "ok": 0, "failed": 0})

        # Each worker collects AND persists its cluster, so the write to Redis
        # overlaps with other clusters' collection instead of queueing on this
        # thread; the store is safe to share across threads.
        ok_count = failed = 0
        workers = max(1, min(settings.collect_workers, len(mine) or 1))
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
            futures = [ex.submit(_collect_and_persist, t, manifest) for t in mine]
            for fut in concurrent.futures.as_completed(futures):
                ok = fut.result()
                ok_count += ok
                failed += (not ok)
                with _progress_lock:
                    _progress.update({"done": ok_count + failed, "ok": ok_count, "failed": failed})

        if shard is None or shard[0] == 0:
            store.finalize_sweep()       # refcount housekeeping: once per sweep, not per shard
        invalidate_query_snapshot()   # the SQL snapshot must not outlive the sweep it was built from
        duration_ms = int((time.time() - started) * 1000)
        store.finish_run(run_id, finished_at=utcnow(), duration_ms=duration_ms,
                         hubs_total=hubs_total, clusters_total=len(mine),
                         clusters_ok=ok_count, clusters_failed=failed)
        _last_run.update({"at": utcnow(), "ok": True, "trigger": trigger})
        log.info("sweep %s: %d clusters (%d ok, %d failed) in %dms",
                 trigger, len(mine), ok_count, failed, duration_ms)
        return {
            "ok": True, "trigger": trigger, "duration_ms": duration_ms,
            "hubs": hubs_total, "clusters": len(mine),
            "clusters_ok": ok_count, "clusters_failed": failed,
        }
    except Exception as e:  # noqa: BLE001
        log.exception("sweep failed")
        store.finish_run(run_id, finished_at=utcnow(),
                         duration_ms=int((time.time() - started) * 1000), error=str(e))
        _last_run.update({"at": utcnow(), "ok": False, "trigger": trigger})
        return {"ok": False, "error": str(e)}
    finally:
        with _progress_lock:
            _progress["running"] = False
        _lock.release()


def _collect_and_persist(target: Target, manifest) -> bool:
    """One cluster, end to end, on a worker thread. Never raises."""
    store = get_store()
    _, collected, ok = _gather(target, manifest)
    try:
        _persist(store, target, collected, manifest)
    except Exception:  # noqa: BLE001
        log.exception("persist %s failed", collected.get("name"))
        return False
    return ok


def refresh_cluster(name: str) -> dict:
    """Collect and persist a single cluster on demand.

    Single-flight per cluster rather than per process: a full sweep and a
    refresh of another cluster may run at the same time, since each cluster is
    written independently.
    """
    store = get_store()
    manifest = get_manifest()
    targets, _ = _discover(store)
    target = next((t for t in targets if t.meta.get("name") == name), None)
    if target is None:
        return {"ok": False, "error": "unknown cluster"}
    if not store.try_lock(name, REFRESH_LOCK_MS):
        return {"ok": False, "skipped": True, "reason": "refresh already running"}

    started = time.time()
    try:
        _, collected, _ok = _gather(target, manifest)
        _persist(store, target, collected, manifest)
    finally:
        store.unlock(name)
    invalidate_query_snapshot()
    duration_ms = int((time.time() - started) * 1000)
    log.info("refresh %s in %dms", name, duration_ms)
    return {"ok": True, "cluster": name, "collect_ms": duration_ms}


def last_run():
    """The last sweep, from the store when it has one (it is shared across
    processes: a read-only API sees the collecting instance's sweeps) and
    from this process otherwise."""
    try:
        stored = get_store().last_run()
    except Exception:  # noqa: BLE001 - never let status reporting fail on the store
        stored = None
    return stored or dict(_last_run)
