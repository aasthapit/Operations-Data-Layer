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

Reads never touch a cluster - the API serves whatever the last sweep wrote.
"""
import concurrent.futures
import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime

from .. import kube
from ..clusterauth import resolve_bearer_token
from ..config_loader import load_config
from ..db import SessionLocal
from ..manifest import get_manifest
from ..models import (
    CHILD_TABLES,
    Cluster,
    ClusterOperator,
    CollectionRun,
    HealthCheck,
    HealthSnapshot,
    Hub,
    Namespace,
    Node,
    PodIssue,
    Resource,
    ResourceStatus,
    Workload,
    WorkloadImage,
    WorkloadRef,
)
from ..settings import settings
from .collect import collect_managed_cluster, unreachable
from .healthchecks import run_health_checks
from .parsers import normalize_managedcluster

log = logging.getLogger("odl.runner")
_lock = threading.Lock()
_last_run = {"at": None, "ok": False, "trigger": None}


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
def _ensure_hub(db, name, region=None, datacenter=None):
    hub = db.get(Hub, name)
    if hub is None:
        hub = Hub(name=name)
        db.add(hub)
    if region:
        hub.region = region
    if datacenter:
        hub.datacenter = datacenter
    return hub


def _discover_via_hubs(db, hubs) -> list[Target]:
    """ACM mode: discover ManagedClusters on each hub."""
    targets = []
    for hub in hubs:
        hub_row = _ensure_hub(db, hub.name, hub.region, hub.datacenter)
        try:
            hb = kube.bundle_from_file(hub.kubeconfig)
            managed = kube.list_managedclusters(hb)
            hub_row.reachable = True
            hub_row.last_error = None
            hub_row.managed_count = len(managed)
        except Exception as e:  # noqa: BLE001
            hub_row.reachable = False
            hub_row.last_error = str(e)
            hub_row.managed_count = 0
            hub_row.last_synced = utcnow()
            db.commit()
            continue
        hub_row.last_synced = utcnow()
        db.commit()   # hub must exist before its clusters reference it (FK)

        for mc in managed:
            meta = normalize_managedcluster(mc)

            def connect(hb=hb, name=meta["name"]):
                kc = kube.read_kubeconfig_secret(hb, name, f"{name}-kubeconfig")
                return kube.bundle_from_kubeconfig_str(kc)

            targets.append(Target(hub.name, meta, connect))
    return targets


def _discover_direct(db, clusters) -> list[Target]:
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
            verify = not c.insecure_skip_tls_verify
            token = resolve_bearer_token(c.api_url, c.auth, verify=verify)
            return kube.bundle_from_endpoint(c.api_url, token, verify=verify, ca_cert=c.ca_cert)

        targets.append(Target(c.hub, meta, connect))
    for hub_name, n in counts.items():
        hub = _ensure_hub(db, hub_name)
        hub.reachable = True
        hub.managed_count = n
        hub.last_synced = utcnow()
    db.commit()
    return targets


# --------------------------------------------------------------------------- #
# collection
# --------------------------------------------------------------------------- #
def _gather(target: Target, manifest) -> tuple[Target, dict, bool]:
    """Connect + collect one cluster. Never raises; returns the document."""
    try:
        bundle = target.connect()
    except Exception as e:  # noqa: BLE001
        return target, unreachable(target.meta, f"connect: {e}"), False
    try:
        return target, collect_managed_cluster(bundle, target.meta, manifest), True
    except Exception as e:  # noqa: BLE001
        log.exception("collect %s failed", target.meta.get("name"))
        return target, unreachable(target.meta, str(e)), False


# --------------------------------------------------------------------------- #
# persistence
# --------------------------------------------------------------------------- #
def _persist_cluster(db, hub_name, collected, checks, overall, score, counts):
    name = collected["name"]
    cluster = db.get(Cluster, name)
    is_new = cluster is None
    if is_new:
        cluster = Cluster(name=name)
    cap = collected.get("capacity") or {}
    cluster.hub_name = hub_name
    cluster.display_name = name
    for field in ("region", "datacenter", "environment", "cloud", "vendor", "platform",
                  "cluster_id", "infrastructure_name", "api_url", "control_plane_topology",
                  "infrastructure_topology", "network_type", "cluster_network",
                  "service_network", "apps_domain", "desired_version", "channel",
                  "upgrade_percent", "kube_version"):
        setattr(cluster, field, collected.get(field))
    cluster.ocp_version = collected.get("version") or collected.get("label_version")
    cluster.upgrading = bool(collected.get("upgrading"))
    cluster.available_updates = collected.get("available_updates") or []
    cluster.nodes_total = collected.get("nodes_total", 0)
    cluster.nodes_ready = collected.get("nodes_ready", 0)
    for field in ("cpu_capacity", "cpu_allocatable", "cpu_requests", "cpu_limits", "cpu_usage",
                  "memory_capacity", "memory_allocatable", "memory_requests", "memory_limits",
                  "memory_usage", "pods_capacity"):
        setattr(cluster, field, cap.get(field))
    cluster.pods_total = cap.get("pods_total", 0) or 0
    cluster.pods_running = cap.get("pods_running", 0) or 0
    cluster.metrics_available = bool(cap.get("metrics_available"))
    cluster.namespaces_application = collected.get("namespaces_application", 0) or 0
    cluster.namespaces_platform = collected.get("namespaces_platform", 0) or 0
    cluster.workloads_total = collected.get("workloads_total", 0) or 0
    cluster.pod_issues_total = collected.get("pod_issues_total", 0) or 0
    cluster.certs_expiring_total = collected.get("certs_expiring_total", 0) or 0
    cluster.managed_available = bool(collected.get("managed_available", True))
    cluster.overall_status = overall
    cluster.health_score = score
    cluster.checks_passed = counts["passed"]
    cluster.checks_warned = counts["warned"]
    cluster.checks_failed = counts["failed"]
    cluster.reachable = collected.get("reachable", True)
    cluster.last_error = collected.get("error")
    cluster.collect_ms = collected.get("collect_ms")
    cluster.last_synced = utcnow()
    if is_new:
        db.add(cluster)
        db.flush()

    # replace children wholesale
    for table in CHILD_TABLES:
        db.query(table).filter_by(cluster_name=name).delete(synchronize_session=False)

    def rows(items, allowed):
        return [{"cluster_name": name, **{k: v for k, v in it.items() if k in allowed}}
                for it in items]

    db.bulk_insert_mappings(ClusterOperator, rows(collected.get("operators", []), _COLS[ClusterOperator]))
    db.bulk_insert_mappings(Node, rows(collected.get("nodes", []), _COLS[Node]))
    db.bulk_insert_mappings(Namespace, rows(collected.get("namespaces", []), _COLS[Namespace]))
    db.bulk_insert_mappings(Workload, rows(collected.get("workloads", []), _COLS[Workload]))
    db.bulk_insert_mappings(WorkloadImage, rows(collected.get("workload_images", []), _COLS[WorkloadImage]))
    db.bulk_insert_mappings(WorkloadRef, rows(collected.get("workload_refs", []), _COLS[WorkloadRef]))
    db.bulk_insert_mappings(PodIssue, rows(collected.get("pod_issues", []), _COLS[PodIssue]))
    db.bulk_insert_mappings(Resource, rows(collected.get("resources", []), _COLS[Resource]))
    db.bulk_insert_mappings(ResourceStatus, [
        {"cluster_name": name, "key": key, **{k: v for k, v in st.items() if k in _COLS[ResourceStatus]}}
        for key, st in (collected.get("resource_status") or {}).items()])
    db.bulk_insert_mappings(HealthCheck, rows(checks, _COLS[HealthCheck]))

    db.add(HealthSnapshot(
        cluster_name=name, overall_status=overall, health_score=score,
        checks_passed=counts["passed"], checks_warned=counts["warned"],
        checks_failed=counts["failed"], ocp_version=cluster.ocp_version,
        upgrading=cluster.upgrading,
        cpu_usage=cap.get("cpu_usage"), cpu_allocatable=cap.get("cpu_allocatable"),
        memory_usage=cap.get("memory_usage"), memory_allocatable=cap.get("memory_allocatable"),
        pods_running=cluster.pods_running, pod_issues=cluster.pod_issues_total,
        snapshot_at=utcnow()))


_COLS = {m: {c.name for c in m.__table__.columns if c.name not in ("id", "cluster_name")}
         for m in (ClusterOperator, Node, Namespace, Workload, WorkloadImage, WorkloadRef,
                   PodIssue, Resource, ResourceStatus, HealthCheck)}


def _prune_snapshots(db, name):
    keep = settings.snapshot_retention
    ids = [r.id for r in db.query(HealthSnapshot.id)
           .filter_by(cluster_name=name)
           .order_by(HealthSnapshot.snapshot_at.desc())
           .offset(keep).all()]
    if ids:
        db.query(HealthSnapshot).filter(HealthSnapshot.id.in_(ids)).delete(
            synchronize_session=False)


def _persist(db, target: Target, collected: dict, manifest):
    thresholds = manifest.describe()["thresholds"]
    checks, overall, score, counts = run_health_checks(
        collected, settings.supported_floor, thresholds)
    _persist_cluster(db, target.hub, collected, checks, overall, score, counts)
    _prune_snapshots(db, collected["name"])
    db.commit()


def _prune_vanished(db, targets: list[Target]):
    """Drop clusters that are no longer discovered on a hub we could reach.

    A cluster removed from ACM (or from the direct list) must not linger as a
    stale row forever. Clusters under an unreachable hub are kept as-is: we
    cannot tell whether they are gone or the hub is merely down.
    """
    seen: dict[str, set] = {}
    for t in targets:
        seen.setdefault(t.hub, set()).add(t.meta["name"])
    for hub in db.query(Hub).all():
        if not hub.reachable:
            continue
        names = seen.get(hub.name, set())
        stale = [c for c in db.query(Cluster).filter(Cluster.hub_name == hub.name).all()
                 if c.name not in names]
        for c in stale:
            log.info("pruning cluster %s: no longer discovered on hub %s", c.name, hub.name)
            db.query(HealthSnapshot).filter_by(cluster_name=c.name).delete(synchronize_session=False)
            db.delete(c)
    db.commit()


# --------------------------------------------------------------------------- #
# the sweep
# --------------------------------------------------------------------------- #
def run_collection(trigger="manual") -> dict:
    """Run one sweep. Returns a small summary dict."""
    if not _lock.acquire(blocking=False):
        return {"skipped": True, "reason": "a collection is already running"}

    started = time.time()
    db = SessionLocal()
    run = CollectionRun(trigger=trigger, started_at=utcnow())
    db.add(run)
    db.commit()

    try:
        cfg = load_config()
        manifest = get_manifest()
        targets: list[Target] = []
        hubs_total = 0
        if cfg.hubs:
            targets += _discover_via_hubs(db, cfg.hubs)
            hubs_total += len(cfg.hubs)
        if cfg.clusters:
            targets += _discover_direct(db, cfg.clusters)
            hubs_total += len({c.hub for c in cfg.clusters})

        _prune_vanished(db, targets)

        ok_count = failed = 0
        workers = max(1, min(settings.collect_workers, len(targets) or 1))
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
            futures = [ex.submit(_gather, t, manifest) for t in targets]
            for fut in concurrent.futures.as_completed(futures):
                target, collected, ok = fut.result()
                try:
                    _persist(db, target, collected, manifest)
                except Exception:  # noqa: BLE001
                    db.rollback()
                    log.exception("persist %s failed", collected.get("name"))
                    ok = False
                ok_count += ok
                failed += (not ok)

        run.finished_at = utcnow()
        run.duration_ms = int((time.time() - started) * 1000)
        run.hubs_total = hubs_total
        run.clusters_total = len(targets)
        run.clusters_ok = ok_count
        run.clusters_failed = failed
        db.add(run)
        db.commit()
        _last_run.update({"at": utcnow(), "ok": True, "trigger": trigger})
        log.info("sweep %s: %d clusters (%d ok, %d failed) in %dms",
                 trigger, len(targets), ok_count, failed, run.duration_ms)
        return {
            "ok": True, "trigger": trigger, "duration_ms": run.duration_ms,
            "hubs": hubs_total, "clusters": len(targets),
            "clusters_ok": ok_count, "clusters_failed": failed,
        }
    except Exception as e:  # noqa: BLE001
        log.exception("sweep failed")
        db.rollback()
        run.error = str(e)
        run.finished_at = utcnow()
        db.add(run)
        db.commit()
        _last_run.update({"at": utcnow(), "ok": False, "trigger": trigger})
        return {"ok": False, "error": str(e)}
    finally:
        db.close()
        _lock.release()


def last_run():
    return dict(_last_run)
