"""
Plain-dict serializers for store rows (kept out of the routers).

A row is a `store.Row`: a dict with attribute access where a missing field reads
as None, carrying the field names the ORM columns used to have. Datetime-valued
fields are normally restored to datetimes by the store, but these serializers
also accept an already-encoded string so a row that skipped that restoration
still renders.
"""
from datetime import UTC, datetime

from .settings import settings

# The application name of a namespace that is under no business application
# (only possible when ownership comes from a mapping file).
UNASSIGNED = "(unassigned)"


def _iso(dt):
    """ISO-8601 for a datetime; an already-encoded string passes through."""
    if not dt:
        return None
    return dt.isoformat() if hasattr(dt, "isoformat") else str(dt)


def _datetime(value):
    """A datetime from either a datetime or an ISO-8601 string (None if neither)."""
    if value is None or isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value))
    except ValueError:
        return None


def _age_seconds(last_synced):
    """Whole seconds since the cluster was last collected (None if never)."""
    synced = _datetime(last_synced)
    if synced is None:
        return None
    if synced.tzinfo is None:      # a store that dropped the offset means UTC
        synced = synced.replace(tzinfo=UTC)
    return int((datetime.now(UTC) - synced).total_seconds())


def _pct(used, total):
    return round(100.0 * used / total, 1) if used is not None and total else None


def capacity_dict(c) -> dict:
    return {
        "metrics_available": bool(c.metrics_available),
        "cpu": {
            "capacity_cores": c.cpu_capacity, "allocatable_cores": c.cpu_allocatable,
            "requests_cores": c.cpu_requests, "limits_cores": c.cpu_limits,
            "used_cores": c.cpu_usage,
            "used_percent": _pct(c.cpu_usage, c.cpu_allocatable),
            "requests_percent": _pct(c.cpu_requests, c.cpu_allocatable),
            "headroom_cores": (round(c.cpu_allocatable - c.cpu_usage, 2)
                               if c.cpu_allocatable is not None and c.cpu_usage is not None else None),
        },
        "memory": {
            "capacity_bytes": c.memory_capacity, "allocatable_bytes": c.memory_allocatable,
            "requests_bytes": c.memory_requests, "limits_bytes": c.memory_limits,
            "used_bytes": c.memory_usage,
            "used_percent": _pct(c.memory_usage, c.memory_allocatable),
            "requests_percent": _pct(c.memory_requests, c.memory_allocatable),
            "headroom_bytes": (c.memory_allocatable - c.memory_usage
                               if c.memory_allocatable is not None and c.memory_usage is not None else None),
        },
        "pods": {"capacity": c.pods_capacity, "total": c.pods_total, "running": c.pods_running,
                 "used_percent": _pct(c.pods_running, c.pods_capacity)},
    }


def cluster_summary(c) -> dict:
    # A cluster that stopped being collected keeps answering from its (expiring)
    # Redis keys, so say how old the answer is rather than implying it is live.
    age = _age_seconds(c.last_synced)
    return {
        "name": c.name,
        "hub": c.hub_name,
        "region": c.region,
        "datacenter": c.datacenter,
        "environment": c.environment,
        "cloud": c.cloud,
        "platform": c.platform,
        "ocp_version": c.ocp_version,
        "desired_version": c.desired_version,
        "channel": c.channel,
        "upgrading": c.upgrading,
        "upgrade_percent": c.upgrade_percent,
        "overall_status": c.overall_status,
        "health_score": c.health_score,
        "checks": {
            "passed": c.checks_passed,
            "warned": c.checks_warned,
            "failed": c.checks_failed,
        },
        "nodes": {"ready": c.nodes_ready, "total": c.nodes_total},
        "namespaces": {"application": c.namespaces_application, "platform": c.namespaces_platform},
        "applications": c.applications_total,
        "workloads": c.workloads_total,
        "pod_issues": c.pod_issues_total,
        "certs_expiring": c.certs_expiring_total,
        "utilization": {
            "metrics_available": bool(c.metrics_available),
            "cpu_percent": _pct(c.cpu_usage, c.cpu_allocatable),
            "memory_percent": _pct(c.memory_usage, c.memory_allocatable),
        },
        "reachable": c.reachable,
        "last_synced": _iso(c.last_synced),
        "age_seconds": age,
        "stale": age is not None and age > 3 * settings.refresh_interval_seconds,
        # Where the last collection of this cluster spent its time, as the
        # collector measured it (null until a sweep has written it). The stage
        # names and units are described in docs/findings.md, "Where the
        # collector's time goes"; /api/collector/timings aggregates them.
        "timings": c.timings or None,
    }


def operator_dict(o) -> dict:
    return {
        "name": o.name,
        "version": o.version,
        "available": o.available,
        "progressing": o.progressing,
        "degraded": o.degraded,
        "critical": o.critical,
        "message": o.message,
    }


def node_dict(n) -> dict:
    return {
        "name": n.name,
        "roles": n.roles or [],
        "ready": n.ready,
        "schedulable": n.schedulable,
        "conditions": n.conditions or {},
        "kubelet_version": n.kubelet_version,
        "os_image": n.os_image,
        "kernel_version": n.kernel_version,
        "container_runtime": n.container_runtime,
        "architecture": n.architecture,
        "instance_type": n.instance_type,
        "zone": n.zone,
        "internal_ip": n.internal_ip,
        "cpu": {"capacity_cores": n.cpu_capacity, "allocatable_cores": n.cpu_allocatable,
                "used_cores": n.cpu_usage, "used_percent": _pct(n.cpu_usage, n.cpu_allocatable)},
        "memory": {"capacity_bytes": n.memory_capacity, "allocatable_bytes": n.memory_allocatable,
                   "used_bytes": n.memory_usage, "used_percent": _pct(n.memory_usage, n.memory_allocatable)},
        "pods": {"capacity": n.pods_capacity, "running": n.pods_running},
        "images": {"count": n.images_count, "bytes": n.images_bytes},
        "taints": n.taints or [],
        "created_at": _iso(n.created_at),
    }


def namespace_dict(n) -> dict:
    return {
        "name": n.name,
        "class": n.ns_class,
        "app": n.app_name,
        "team": n.team,
        "tier": n.tier,
        "environment": n.environment,
        "assigned": True if n.assigned is None else bool(n.assigned),
        "status": n.status,
        "phase": n.phase,
        "requester": n.requester,
        "display_name": n.display_name,
        "labels": n.labels or {},
        "workloads": n.workloads_total,
        "replicas_desired": n.replicas_desired,
        "replicas_ready": n.replicas_ready,
        "pods": {"total": n.pods_total, "running": n.pods_running, "pending": n.pods_pending,
                 "failed": n.pods_failed, "succeeded": n.pods_succeeded,
                 "restarts": n.restarts_total, "issues": n.pod_issues},
        "cpu": {"requests_cores": n.cpu_requests, "limits_cores": n.cpu_limits, "used_cores": n.cpu_usage},
        "memory": {"requests_bytes": n.memory_requests, "limits_bytes": n.memory_limits,
                   "used_bytes": n.memory_usage},
        "resource_counts": n.resource_counts or {},
        "images": n.images or [],
        "created_at": _iso(n.created_at),
    }


def application_dict(n) -> dict:
    """An application namespace, in the shape blast radius and the app views use."""
    return {
        "name": n.app_name or (n.name if n.assigned is None else UNASSIGNED),
        "namespace": n.name,
        "team": n.team,
        "tier": n.tier,
        "environment": n.environment,
        "assigned": True if n.assigned is None else bool(n.assigned),
        "status": n.status,
        "replicas_desired": n.replicas_desired,
        "replicas_ready": n.replicas_ready,
        "pod_issues": n.pod_issues,
        "cpu_used_cores": n.cpu_usage,
        "memory_used_bytes": n.memory_usage,
    }


def workload_dict(w, detail=False) -> dict:
    d = {
        "cluster": w.cluster_name,
        "namespace": w.namespace,
        "class": w.ns_class,
        "kind": w.kind,
        "name": w.name,
        "status": w.status,
        "replicas": {"desired": w.replicas_desired, "ready": w.replicas_ready,
                     "available": w.replicas_available, "updated": w.replicas_updated},
        "images": w.images or [],
        "service_account": w.service_account,
        "strategy": w.strategy,
        "created_at": _iso(w.created_at),
    }
    if detail:
        d.update({
            "containers": w.containers or [],
            "config_refs": w.config_refs or [],
            "node_selector": w.node_selector or {},
            "labels": w.labels or {},
            "conditions": w.conditions or {},
        })
    return d


def pod_issue_dict(i) -> dict:
    return {
        "cluster": i.cluster_name,
        "namespace": i.namespace,
        "class": i.ns_class,
        "name": i.name,
        "node": i.node,
        "phase": i.phase,
        "reason": i.reason,
        "message": i.message,
        "restarts": i.restarts,
        "owner": f"{i.owner_kind}/{i.owner_name}" if i.owner_kind else None,
        "containers_ready": i.containers_ready,
        "started_at": _iso(i.started_at),
    }


def resource_dict(r) -> dict:
    return {
        "cluster": r.cluster_name,
        "key": r.key,
        "kind": r.kind,
        "api_group": r.api_group,
        "namespace": r.namespace,
        "class": r.ns_class,
        "name": r.name,
        "status": r.status,
        "expires_at": _iso(r.expires_at),
        "labels": r.labels or {},
        "summary": r.summary or {},
        "created_at": _iso(r.created_at),
    }


# Per-kind collection facts the collector records when it has them: when this
# kind was last collected, whether this sweep reused the cached section instead
# of fetching (tiered refresh intervals), and what the fetch cost. They are
# absent from the response unless the collector wrote them, so a store written
# by an older collector serialises exactly as it did before.
_RESOURCE_STATUS_EXTRA = ("collected_at", "cached", "bytes", "objects", "parse_ms",
                          "requests", "interval_seconds")


def resource_status_dict(s) -> dict:
    d = {"key": s.key, "status": s.status, "count": s.count,
         "duration_ms": s.duration_ms, "error": s.error}
    for field in _RESOURCE_STATUS_EXTRA:
        value = getattr(s, field, None)
        if value is None:
            continue
        d[field] = _iso(value) if field == "collected_at" else value
    return d


def check_dict(h) -> dict:
    return {
        "name": h.name,
        "title": h.title,
        "status": h.status,
        "severity": h.severity,
        "message": h.message,
        # What the check measured, keyed by unit, and the levels that applied -
        # enough to render "87% used (warn 85, fail 95)" without the manifest.
        "value": h.value or {},
        "levels": h.levels or {},
    }


def cluster_detail(c, operators, nodes, namespaces, pod_issues, resource_status, health_checks) -> dict:
    """The summary row plus the cluster's detail sections, as one document.

    The sections are read separately (each is its own key in the store), so the
    caller passes them in rather than the serializer reaching back for them.
    """
    applications = [n for n in namespaces if n.ns_class == "application"]
    d = cluster_summary(c)
    d.update({
        "cluster_id": c.cluster_id,
        "infrastructure_name": c.infrastructure_name,
        "vendor": c.vendor,
        "kube_version": c.kube_version,
        "available_updates": c.available_updates or [],
        "managed_available": c.managed_available,
        "last_error": c.last_error,
        "collect_ms": c.collect_ms,
        "platform_config": {
            "api_url": c.api_url,
            "control_plane_topology": c.control_plane_topology,
            "infrastructure_topology": c.infrastructure_topology,
            "network_type": c.network_type,
            "cluster_network": c.cluster_network or [],
            "service_network": c.service_network or [],
            "apps_domain": c.apps_domain,
        },
        "capacity": capacity_dict(c),
        "operators": [operator_dict(o) for o in sorted(operators, key=lambda o: o.name)],
        "nodes_detail": [node_dict(n) for n in sorted(nodes, key=lambda n: n.name)],
        "namespaces_detail": [namespace_dict(n) for n in sorted(namespaces, key=lambda n: n.name)],
        "applications": [application_dict(n) for n in
                         sorted(applications, key=lambda n: n.app_name or n.name)],
        "pod_issues_detail": [pod_issue_dict(i) for i in
                              sorted(pod_issues, key=lambda i: (i.ns_class or "", i.namespace or "",
                                                                i.name or ""))],
        "resource_status": [resource_status_dict(s) for s in sorted(resource_status, key=lambda s: s.key)],
        "health_checks": [check_dict(h) for h in health_checks],
    })
    return d
