"""
Orchestrate a full collection sweep and persist it.

Flow (identical to what you'd run against real ACM):
    for each hub:
        connect (kubeconfig file)
        list ManagedClusters
        for each managed cluster:
            read its kubeconfig secret from the hub
            connect, collect raw state
            run health checks
            upsert current state + append a health snapshot

Reads never touch a cluster - the API serves whatever the last sweep wrote.
"""
import threading
import time
from datetime import datetime, timezone

from .. import kube
from ..clusterauth import resolve_bearer_token
from ..config_loader import load_config
from ..db import SessionLocal
from ..models import (
    Application,
    Cluster,
    ClusterOperator,
    CollectionRun,
    HealthCheck,
    HealthSnapshot,
    Hub,
)
from ..settings import settings
from .collect import collect_managed_cluster, normalize_managedcluster
from .healthchecks import run_health_checks

_lock = threading.Lock()
_last_run = {"at": None, "ok": False, "trigger": None}


def utcnow():
    return datetime.now(timezone.utc)


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


def _collect_one(db, hub_name, bundle, meta):
    """Collect, health-check and persist a single cluster. Returns ok bool."""
    name = meta["name"]
    try:
        collected = collect_managed_cluster(bundle, meta)
        ok = True
    except Exception as e:  # noqa: BLE001
        collected = dict(meta)
        collected.update({"reachable": False, "error": str(e),
                          "operators": [], "applications": []})
        ok = False
    checks, overall, score, counts = run_health_checks(
        collected, settings.supported_floor)
    _persist_cluster(db, hub_name, collected, checks, overall, score, counts)
    _prune_snapshots(db, name)
    db.commit()
    return ok


def _persist_cluster(db, hub_name, collected, checks, overall, score, counts):
    name = collected["name"]
    cluster = db.get(Cluster, name)
    is_new = cluster is None
    if is_new:
        cluster = Cluster(name=name)
    cluster.hub_name = hub_name
    cluster.display_name = name
    cluster.region = collected.get("region")
    cluster.datacenter = collected.get("datacenter")
    cluster.environment = collected.get("environment")
    cluster.cloud = collected.get("cloud")
    cluster.vendor = collected.get("vendor")
    cluster.platform = collected.get("platform")
    cluster.cluster_id = collected.get("cluster_id")
    cluster.infrastructure_name = collected.get("infrastructure_name")
    cluster.ocp_version = collected.get("version") or collected.get("label_version")
    cluster.desired_version = collected.get("desired_version")
    cluster.channel = collected.get("channel")
    cluster.upgrading = bool(collected.get("upgrading"))
    cluster.upgrade_percent = collected.get("upgrade_percent")
    cluster.available_updates = collected.get("available_updates") or []
    cluster.kube_version = collected.get("kube_version")
    cluster.nodes_total = collected.get("nodes_total", 0)
    cluster.nodes_ready = collected.get("nodes_ready", 0)
    cluster.managed_available = bool(collected.get("managed_available", True))
    cluster.overall_status = overall
    cluster.health_score = score
    cluster.checks_passed = counts["passed"]
    cluster.checks_warned = counts["warned"]
    cluster.checks_failed = counts["failed"]
    cluster.reachable = collected.get("reachable", True)
    cluster.last_error = collected.get("error")
    cluster.last_synced = utcnow()
    if is_new:
        db.add(cluster)

    # replace children
    db.query(ClusterOperator).filter_by(cluster_name=name).delete()
    db.query(Application).filter_by(cluster_name=name).delete()
    db.query(HealthCheck).filter_by(cluster_name=name).delete()

    for o in collected.get("operators", []):
        db.add(ClusterOperator(cluster_name=name, **o))
    for a in collected.get("applications", []):
        db.add(Application(cluster_name=name, **a))
    for c in checks:
        db.add(HealthCheck(
            cluster_name=name, name=c["name"], title=c["title"],
            status=c["status"], severity=c["severity"], message=c["message"]))

    db.add(HealthSnapshot(
        cluster_name=name, overall_status=overall, health_score=score,
        checks_passed=counts["passed"], checks_warned=counts["warned"],
        checks_failed=counts["failed"], ocp_version=cluster.ocp_version,
        upgrading=cluster.upgrading, snapshot_at=utcnow()))


def _prune_snapshots(db, name):
    keep = settings.snapshot_retention
    ids = [r.id for r in db.query(HealthSnapshot.id)
           .filter_by(cluster_name=name)
           .order_by(HealthSnapshot.snapshot_at.desc())
           .offset(keep).all()]
    if ids:
        db.query(HealthSnapshot).filter(HealthSnapshot.id.in_(ids)).delete(
            synchronize_session=False)


def _collect_via_hubs(db, hubs):
    """ACM mode: discover ManagedClusters on each hub, then collect each."""
    c_total = c_ok = c_failed = 0
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
            c_total += 1
            meta = normalize_managedcluster(mc)
            try:
                kc = kube.read_kubeconfig_secret(hb, meta["name"],
                                                 f"{meta['name']}-kubeconfig")
                bundle = kube.bundle_from_kubeconfig_str(kc)
            except Exception as e:  # noqa: BLE001
                meta.update({"reachable": False, "error": str(e),
                             "operators": [], "applications": []})
                checks, overall, score, counts = run_health_checks(
                    meta, settings.supported_floor)
                _persist_cluster(db, hub.name, meta, checks, overall, score, counts)
                db.commit()
                c_failed += 1
                continue
            ok = _collect_one(db, hub.name, bundle, meta)
            c_ok += ok
            c_failed += (not ok)
    return c_total, c_ok, c_failed


def _collect_direct(db, clusters):
    """Direct mode: a flat list of live OCP endpoints behind shared credentials."""
    c_total = c_ok = c_failed = 0
    # group clusters under their logical hub for the UI
    for hub_name in sorted({c.hub for c in clusters}):
        _ensure_hub(db, hub_name)
    db.commit()
    hub_counts = {}

    for c in clusters:
        c_total += 1
        hub_counts[c.hub] = hub_counts.get(c.hub, 0) + 1
        meta = {
            "name": c.name, "region": c.region, "datacenter": c.datacenter,
            "environment": c.environment, "cloud": c.cloud, "vendor": "OpenShift",
            "managed_available": True,
        }
        verify = not c.insecure_skip_tls_verify
        try:
            token = resolve_bearer_token(c.api_url, c.auth, verify=verify)
            bundle = kube.bundle_from_endpoint(c.api_url, token, verify=verify,
                                               ca_cert=c.ca_cert)
        except Exception as e:  # noqa: BLE001
            meta.update({"reachable": False, "error": str(e),
                         "operators": [], "applications": []})
            checks, overall, score, counts = run_health_checks(
                meta, settings.supported_floor)
            _persist_cluster(db, c.hub, meta, checks, overall, score, counts)
            db.commit()
            c_failed += 1
            continue
        ok = _collect_one(db, c.hub, bundle, meta)
        c_ok += ok
        c_failed += (not ok)

    for hub_name, n in hub_counts.items():
        hub = db.get(Hub, hub_name)
        if hub:
            hub.reachable = True
            hub.managed_count = n
            hub.last_synced = utcnow()
    db.commit()
    return c_total, c_ok, c_failed


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
        h_total = c_ok = c_failed = c_total = 0

        if cfg.hubs:
            t, ok, failed = _collect_via_hubs(db, cfg.hubs)
            h_total += len(cfg.hubs)
            c_total += t; c_ok += ok; c_failed += failed
        if cfg.clusters:
            t, ok, failed = _collect_direct(db, cfg.clusters)
            h_total += len({c.hub for c in cfg.clusters})
            c_total += t; c_ok += ok; c_failed += failed

        hubs_total, clusters_total = h_total, c_total
        clusters_ok, clusters_failed = c_ok, c_failed
        run.finished_at = utcnow()
        run.duration_ms = int((time.time() - started) * 1000)
        run.hubs_total = hubs_total
        run.clusters_total = clusters_total
        run.clusters_ok = clusters_ok
        run.clusters_failed = clusters_failed
        db.add(run)
        db.commit()
        _last_run.update({"at": utcnow(), "ok": True, "trigger": trigger})
        return {
            "ok": True, "trigger": trigger, "duration_ms": run.duration_ms,
            "hubs": hubs_total, "clusters": clusters_total,
            "clusters_ok": clusters_ok, "clusters_failed": clusters_failed,
        }
    except Exception as e:  # noqa: BLE001
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
