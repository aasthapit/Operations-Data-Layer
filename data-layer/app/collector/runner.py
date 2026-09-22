"""
Orchestrate a full collection sweep and persist it.

Flow (identical to what you'd run against real ACM):
    discover targets:
        for each hub THIS INSTANCE OWNS: connect, list ManagedClusters, read
            each kubeconfig secret
        for each direct cluster: resolve a bearer token
    collect (in parallel, bounded by COLLECT_WORKERS):
        read back what the last collection left, fetch every manifest-enabled
        resource that is DUE, assemble the cluster document
    persist (one transaction per cluster):
        run health checks, replace current state, append a snapshot, then write
        the sweep's timings and the collector's per-kind bookkeeping

Two knobs partition the work across processes, and they compose:

    COLLECT_HUBS=man01paa   this instance owns one hub: it discovers only that
                            hub's ManagedClusters, collects only those clusters,
                            and prunes only that hub's vanished clusters. The
                            natural unit at estate scale - one collector per
                            ACM hub, holding only that hub's credentials.
    COLLECT_SHARD=0/3       within the owned hubs, take a third of the clusters.

Reads never touch a cluster - the API serves whatever the last sweep wrote into
the store (see app/store/base.py and docs/redis-keyspace.md).
"""
import base64
import concurrent.futures
import hashlib
import logging
import math
import os
import socket
import tempfile
import threading
import time
import zlib
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime

from .. import kube
from ..clusterauth import resolve_bearer_token
from ..config_loader import load_config
from ..logsafe import logsafe
from ..manifest import get_manifest
from ..query import invalidate as invalidate_query_snapshot
from ..settings import settings
from ..store import Store, get_store
from .collect import (
    PREVIOUS_SECTIONS,
    STATE_FIELD,
    Previous,
    collect_managed_cluster,
    unreachable,
)
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


def owned_hubs() -> tuple[str, ...]:
    """The hubs this instance collects, from COLLECT_HUBS. Empty = every hub
    the fleet config lists."""
    return tuple(settings.collect_hubs)


def owns_hub(name: str, owned: tuple[str, ...] | None = None) -> bool:
    owned = owned_hubs() if owned is None else owned
    return not owned or name in owned


def configured_hubs(cfg) -> list[str]:
    """Every hub name in the fleet config, ACM hubs first, in order."""
    names = [h.name for h in cfg.hubs] + [c.hub for c in cfg.clusters]
    return list(dict.fromkeys(name for name in names if name))


def validate_hub_selection(cfg=None) -> tuple[str, ...]:
    """Check COLLECT_HUBS against the fleet config and return the owned hubs.

    Called at startup as well as at discovery: a typo would otherwise be a
    collector that quietly collects nothing at all.
    """
    owned = owned_hubs()
    if not owned:
        return owned
    configured = configured_hubs(cfg or load_config())
    unknown = [name for name in owned if name not in configured]
    if unknown:
        raise ValueError(
            f"COLLECT_HUBS: unknown hub(s) {', '.join(unknown)}. "
            f"Configured hubs: {', '.join(configured) or 'none'}")
    return owned


def in_shard(name: str, shard: tuple[int, int] | None) -> bool:
    """Whether an instance is responsible for a cluster. Stable across
    processes and restarts: a name always lands in the same shard."""
    if shard is None:
        return True
    i, n = shard
    return zlib.crc32(name.encode()) % n == i


def instance_name() -> str:
    """Who this process is, for the fleet-wide progress view and the refresh
    queue: the hubs it owns (or "all"), its shard, then host/role:pid.

    The role is not decoration. The containers of a pod share one hostname and
    each runs its process as PID 1, so host:pid alone names the read-only API
    and the collector beside it identically - and a collector skips refresh
    requests that carry its own name, so it would discard every request that
    API queued for it.
    """
    hubs = ",".join(owned_hubs()) or "all"
    shard = f"@{settings.collect_shard}" if settings.collect_shard else ""
    return f"{hubs}{shard}#{socket.gethostname()}/{settings.role}:{os.getpid()}"


def _publish_progress(store: Store) -> None:
    """Mirror this process's progress into Redis so an API served by any
    process (or none of the collectors) can show the whole fleet's sweep."""
    with _progress_lock:
        snap = dict(_progress)
    snap["hubs"] = list(owned_hubs())
    snap["shard"] = settings.collect_shard or None
    try:
        # a dead collector's entry must not linger: expire it a few ticks
        # after its last update, whether or not it was still running
        store.set_progress(instance_name(), snap, ttl_seconds=3 * settings.refresh_interval_seconds)
    except Exception as e:  # noqa: BLE001 - progress is a courtesy, never a failure
        log.debug("progress publish failed: %s", e)


def progress() -> dict:
    """The fleet-wide sweep: every collector's published progress aggregated,
    plus the list per collector. Falls back to this process alone when the
    store has nothing (single collector, or Redis unreachable)."""
    with _progress_lock:
        local = dict(_progress)
    try:
        published = get_store().progress_all()
    except Exception:  # noqa: BLE001
        published = []
    if not published:
        return {**local, "collectors": []}
    running = [p for p in published if p.get("running")]
    considered = running or published
    total = sum(int(p.get("total") or 0) for p in considered)
    done = sum(int(p.get("done") or 0) for p in considered)
    started = [p.get("started_at") for p in running if p.get("started_at")]
    return {
        "running": bool(running),
        "trigger": (running[0].get("trigger") if running else considered[0].get("trigger")),
        "started_at": min(started) if started else None,
        "total": total, "done": done,
        "ok": sum(int(p.get("ok") or 0) for p in considered),
        "failed": sum(int(p.get("failed") or 0) for p in considered),
        "collectors": [{"instance": p.get("instance"), "hubs": p.get("hubs") or [],
                        "shard": p.get("shard"), "running": bool(p.get("running")),
                        "total": int(p.get("total") or 0), "done": int(p.get("done") or 0),
                        "failed": int(p.get("failed") or 0), "started_at": p.get("started_at")}
                       for p in sorted(published, key=lambda p: str(p.get("instance")))],
    }

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
        ca = cluster_ca_bundle(hub, meta)
        verify = _tls_verify(hub.insecure_skip_tls_verify, ca)
        token = resolve_bearer_token(url, hub.auth, verify=verify)
        if token is None:
            raise RuntimeError(f"hub {hub.name}: shared access needs auth of type token or password")
        return kube.bundle_from_endpoint(url, token, verify=bool(verify), ca_cert=ca)

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


_CA_DIR = os.path.join(tempfile.gettempdir(), "odl-ca")


def cluster_ca_bundle(hub, meta: dict) -> str | None:
    """The CA bundle file to verify a managed cluster's API server with.

    Managed clusters usually present a certificate signed by their own CA,
    not the corporate one, so the hub's `ca_cert` alone fails with
    "self-signed certificate in certificate chain". ACM records each
    cluster's CA on the ManagedCluster (managedClusterClientConfigs[].caBundle);
    that PEM, plus the hub's `ca_cert` when configured, is written once to a
    content-addressed file under the temp dir and reused. Returns the hub's
    `ca_cert` (possibly None) when ACM recorded no bundle.
    """
    raw = meta.get("client_ca_bundle")
    if not raw:
        return hub.ca_cert
    try:
        pem = base64.b64decode(raw).decode()
    except (ValueError, UnicodeDecodeError) as e:
        log.warning("%s: ACM caBundle is not base64 PEM (%s); using the hub's ca_cert", meta.get("name"), e)
        return hub.ca_cert
    parts = [pem.strip()]
    if hub.ca_cert:
        try:
            with open(hub.ca_cert) as f:
                parts.append(f.read().strip())
        except OSError as e:
            log.warning("hub %s: ca_cert %s unreadable (%s)", hub.name, hub.ca_cert, e)
    bundle = "\n".join(parts) + "\n"
    # Content addressing, not authentication: the digest only names the file
    # that holds this bundle, and the bundle itself is what TLS verifies against.
    # nosemgrep: python.lang.security.insecure-hash-algorithms.insecure-hash-algorithm-sha1 -- file name
    digest = hashlib.sha1(bundle.encode(), usedforsecurity=False).hexdigest()
    path = os.path.join(_CA_DIR, digest + ".pem")
    if not os.path.exists(path):
        # 0o700: the bundles are read back to verify TLS, so no other user on a
        # shared host gets to plant a CA in here.
        os.makedirs(_CA_DIR, mode=0o700, exist_ok=True)
        tmp = path + f".{os.getpid()}.tmp"
        with open(tmp, "w") as f:
            f.write(bundle)
        os.replace(tmp, path)          # atomic: a concurrent worker never sees a partial file
    return path


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


def _discover_via_hubs(store: Store, hubs, owned: tuple[str, ...]) -> list[Target]:
    """ACM mode: discover ManagedClusters on each hub this instance owns."""
    targets = []
    for hub in hubs:
        placement = {k: v for k, v in (("region", hub.region),
                                       ("datacenter", hub.datacenter)) if v}
        if not owns_hub(hub.name, owned):
            # Another collector owns it. Record that the hub exists - the fleet
            # view lists every hub - but never connect to it and never touch the
            # state (reachable, managed_count, last_synced) its owner writes.
            store.upsert_hub(hub.name, **placement)
            continue
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


def _discover_direct(store: Store, clusters, owned: tuple[str, ...]) -> list[Target]:
    """Direct mode: a flat list of live OCP endpoints behind shared credentials."""
    targets = []
    counts: dict[str, int] = {}
    for c in clusters:
        if not owns_hub(c.hub, owned):
            store.upsert_hub(c.hub)          # it exists; its owner keeps it current
            continue
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
    """Every cluster THIS INSTANCE is responsible for, and the configured hub
    count (which is the whole estate, not this instance's share)."""
    cfg = load_config()
    owned = validate_hub_selection(cfg)
    configured = configured_hubs(cfg)
    mine = [name for name in configured if owns_hub(name, owned)]
    log.info("hubs: %s (%d of %d configured)", ", ".join(mine) or "none",
             len(mine), len(configured))
    targets: list[Target] = []
    hubs_total = 0
    if cfg.hubs:
        targets += _discover_via_hubs(store, cfg.hubs, owned)
        hubs_total += len(cfg.hubs)
    if cfg.clusters:
        targets += _discover_direct(store, cfg.clusters, owned)
        hubs_total += len({c.hub for c in cfg.clusters})
    return targets, hubs_total


# --------------------------------------------------------------------------- #
# collection
# --------------------------------------------------------------------------- #
def _load_previous(store: Store, name: str, manifest, full: bool) -> Previous | None:
    """What the last collection of this cluster left behind, or None when the
    merge cannot need it (no kind has an interval, or this is a full refresh).

    Two reads, both pipelined: the summary carries the collector's bookkeeping,
    the sections carry the rows the not-due kinds keep.
    """
    if full or not manifest.tiered():
        return None
    try:
        summary = store.get_cluster(name)
        sections = store.sections(name, PREVIOUS_SECTIONS)
    except Exception:  # noqa: BLE001 - a store hiccup means "collect everything"
        log.exception("reading the previous state of %s failed", logsafe(name))
        return None
    if summary is None:
        return None
    return Previous(sections=sections, state=summary.get(STATE_FIELD) or {})


def _gather(target: Target, manifest, previous: Previous | None = None,
            full: bool = False, now=None) -> tuple[Target, dict, bool]:
    """Connect + collect one cluster. Never raises; returns the document."""
    try:
        bundle = target.connect()
    except Exception as e:  # noqa: BLE001
        log.warning("%s unreachable: connect: %s", target.meta.get("name"), e)
        return target, unreachable(target.meta, f"connect: {e}"), False
    try:
        return target, collect_managed_cluster(bundle, target.meta, manifest,
                                               previous=previous, full=full,
                                               now=now or utcnow()), True
    except Exception as e:  # noqa: BLE001
        log.exception("collect %s failed", target.meta.get("name"))
        return target, unreachable(target.meta, str(e)), False


# --------------------------------------------------------------------------- #
# persistence
# --------------------------------------------------------------------------- #
def _persist(store: Store, target: Target, collected: dict, manifest) -> dict:
    """Health-check the document, replace the cluster in one transaction, then
    record what each stage cost. Returns the timings it wrote."""
    t0 = time.time()
    checks, overall, score, counts = run_health_checks(
        collected, settings.supported_floor, checks_config=manifest.health_check_config)
    health_ms = int((time.time() - t0) * 1000)
    t1 = time.time()
    store.persist_cluster(target.hub, collected, checks, overall, score, counts)
    persist_ms = int((time.time() - t1) * 1000)
    timings = {**(collected.get("timings") or {}), "health_ms": health_ms,
               "persist_ms": persist_ms,
               # end to end for this cluster, the stages' own wall clocks aside
               # (parse_ms happens inside the fetch window, so they do not sum)
               "total_ms": (collected.get("collect_ms") or 0) + health_ms + persist_ms}
    # After the write, because persist_cluster replaces the summary wholesale:
    # the timings of the stages it could not know, and the per-kind bookkeeping
    # the next collection reads back to decide what is due.
    store.update_summary(collected["name"], timings=timings,
                         **{STATE_FIELD: collected.get(STATE_FIELD) or {}})
    return timings


def _prune_vanished(store: Store, targets: list[Target], owned: tuple[str, ...] = ()):
    """Drop clusters that are no longer discovered on a hub we could reach.

    A cluster removed from ACM (or from the direct list) must not linger as a
    stale row forever. Clusters under an unreachable hub are kept as-is: we
    cannot tell whether they are gone or the hub is merely down, so only hubs
    that answered this sweep get an entry in `seen`. With COLLECT_HUBS, only
    the hubs this instance owns do: another collector's hub is reachable in the
    shared store without this instance having looked at it, and its clusters
    are not ours to drop.
    """
    reachable = {h.name for h in store.hubs()
                 if h.reachable and owns_hub(h.name, owned)}
    seen: dict[str, set[str]] = {name: set() for name in reachable}
    for t in targets:
        if t.hub in seen:
            seen[t.hub].add(t.meta["name"])
    store.prune_vanished(seen)


# --------------------------------------------------------------------------- #
# the sweep
# --------------------------------------------------------------------------- #
def run_collection(trigger="manual", full: bool = False) -> dict:
    """Run one sweep: collect what is due from every cluster this instance owns
    (with `full`, every enabled kind whether it is due or not)."""
    if not _lock.acquire(blocking=False):
        return {"skipped": True, "reason": "a collection is already running"}

    started = time.time()
    store = get_store()
    run_id = store.begin_run(trigger)

    try:
        manifest = get_manifest()
        targets, hubs_total = _discover(store)

        # This instance sees every cluster of the hubs it owns and prunes
        # against them; only collection is partitioned further, across shards.
        _prune_vanished(store, targets, owned_hubs())
        shard = _shard()
        mine = [t for t in targets if in_shard(t.meta["name"], shard)]
        if shard:
            log.info("shard %d/%d: collecting %d of %d clusters", shard[0], shard[1],
                     len(mine), len(targets))
        mine, fresh = _due_first(store, mine, force=full or trigger == "manual")
        if fresh:
            log.info("sweep %s: %d clusters due, %d fresh skipped (collected within the interval)",
                     trigger, len(mine), fresh)
        with _progress_lock:
            _progress.update({"running": True, "trigger": trigger, "started_at": utcnow(),
                              "total": len(mine), "done": 0, "ok": 0, "failed": 0})
        _publish_progress(store)

        # Each worker collects AND persists its cluster, so the write to Redis
        # overlaps with other clusters' collection instead of queueing on this
        # thread; the store is safe to share across threads.
        ok_count = failed = 0
        measured: list[dict] = []
        workers = max(1, min(settings.collect_workers, len(mine) or 1))
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
            futures = [ex.submit(_collect_and_persist, t, manifest, full) for t in mine]
            for fut in concurrent.futures.as_completed(futures):
                ok, timings = fut.result()
                ok_count += ok
                failed += (not ok)
                measured.append(timings)
                with _progress_lock:
                    _progress.update({"done": ok_count + failed, "ok": ok_count, "failed": failed})
                _publish_progress(store)

        if shard is None or shard[0] == 0:
            store.finalize_sweep()       # refcount housekeeping: once per sweep, not per shard
        invalidate_query_snapshot()   # the SQL snapshot must not outlive the sweep it was built from
        duration_ms = int((time.time() - started) * 1000)
        aggregates = aggregate_timings(measured)
        store.finish_run(run_id, finished_at=utcnow(), duration_ms=duration_ms,
                         hubs_total=hubs_total, clusters_total=len(mine),
                         clusters_ok=ok_count, clusters_failed=failed,
                         timings=aggregates)
        _last_run.update({"at": utcnow(), "ok": True, "trigger": trigger})
        log.info("sweep %s: %d clusters (%d ok, %d failed) in %dms; %d kinds fetched, "
                 "%d cached", trigger, len(mine), ok_count, failed, duration_ms,
                 aggregates["kinds_fetched"], aggregates["kinds_cached"])
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
        _publish_progress(store)
        _lock.release()


def _due_first(store: Store, targets: list[Target], force: bool) -> tuple[list[Target], int]:
    """Which clusters this sweep collects, stalest first.

    A cluster written less than the sweep interval ago (by this process
    before a restart, or by an on-demand refresh) is not due and is skipped;
    the rest are ordered by age with never-collected clusters first. That is
    what lets a restarted collector resume the remaining fleet instead of
    starting over at the top of the hub's list. A manual or full refresh
    forces every cluster. The 10% slack keeps a scheduled sweep from skipping
    clusters it collected a few milliseconds under one interval ago.
    Returns (due targets, number skipped as fresh).
    """
    if force or not targets:
        return targets, 0
    now = utcnow()
    known = {c.name: c for c in store.clusters(names=[t.meta["name"] for t in targets])}

    def age(target: Target) -> float:
        row = known.get(target.meta["name"])
        if not row or not row.last_synced:
            return math.inf
        return (now - row.last_synced).total_seconds()

    threshold = 0.9 * settings.refresh_interval_seconds
    due = sorted((t for t in targets if age(t) >= threshold), key=age, reverse=True)
    return due, len(targets) - len(due)


def _collect_and_persist(target: Target, manifest, full: bool = False) -> tuple[bool, dict]:
    """One cluster, end to end, on a worker thread. Never raises."""
    store = get_store()
    previous = _load_previous(store, target.meta["name"], manifest, full)
    _, collected, ok = _gather(target, manifest, previous, full)
    try:
        timings = _persist(store, target, collected, manifest)
    except Exception:  # noqa: BLE001
        log.exception("persist %s failed", collected.get("name"))
        return False, dict(collected.get("timings") or {})
    return ok, timings


# Stages every cluster reports, summed and p95'd over a sweep.
_TIMING_STAGES = ("fetch_ms", "assemble_ms", "health_ms", "persist_ms")
_TIMING_TOTALS = ("kinds_fetched", "kinds_cached", "bytes", "objects", "parse_ms")


def _p95(values: list[int]) -> int:
    """The 95th percentile (nearest rank), which is what a slow tail looks like
    when a sweep's average still looks fine."""
    if not values:
        return 0
    ordered = sorted(values)
    return ordered[max(1, math.ceil(0.95 * len(ordered))) - 1]


def aggregate_timings(measured: list[dict]) -> dict:
    """One sweep's per-cluster timings as a run record: what each stage cost in
    total and at p95, and how much was pulled to pay for it."""
    out: dict = {"clusters": len(measured)}
    for stage in _TIMING_STAGES:
        values = [int(t.get(stage) or 0) for t in measured if t.get(stage) is not None]
        out[stage] = {"sum": sum(values), "p95": _p95(values)}
    for total in _TIMING_TOTALS:
        out[total] = sum(int(t.get(total) or 0) for t in measured)
    return out


def refresh_cluster(name: str, full: bool = False) -> dict:
    """Collect and persist a single cluster on demand: what is due, or every
    enabled kind with `full`.

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
        previous = _load_previous(store, name, manifest, full)
        _, collected, _ok = _gather(target, manifest, previous, full)
        _persist(store, target, collected, manifest)
    finally:
        store.unlock(name)
    invalidate_query_snapshot()
    duration_ms = int((time.time() - started) * 1000)
    log.info("refresh %s in %dms", logsafe(name), duration_ms)
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
