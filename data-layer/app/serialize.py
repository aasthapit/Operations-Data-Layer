"""Plain-dict serializers for ORM rows (kept out of the routers)."""


def _iso(dt):
    return dt.isoformat() if dt else None


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
        "name": n.app_name or n.name,
        "namespace": n.name,
        "team": n.team,
        "tier": n.tier,
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


def resource_status_dict(s) -> dict:
    return {"key": s.key, "status": s.status, "count": s.count,
            "duration_ms": s.duration_ms, "error": s.error}


def check_dict(h) -> dict:
    return {
        "name": h.name,
        "title": h.title,
        "status": h.status,
        "severity": h.severity,
        "message": h.message,
    }


def cluster_detail(c) -> dict:
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
        "operators": [operator_dict(o) for o in sorted(c.operators, key=lambda o: o.name)],
        "nodes_detail": [node_dict(n) for n in sorted(c.nodes, key=lambda n: n.name)],
        "namespaces_detail": [namespace_dict(n) for n in sorted(c.namespaces, key=lambda n: n.name)],
        "applications": [application_dict(n) for n in
                         sorted(c.applications, key=lambda n: n.app_name or n.name)],
        "pod_issues_detail": [pod_issue_dict(i) for i in
                              sorted(c.pod_issues, key=lambda i: (i.ns_class, i.namespace, i.name))],
        "resource_status": [resource_status_dict(s) for s in sorted(c.resource_status, key=lambda s: s.key)],
        "health_checks": [check_dict(h) for h in c.health_checks],
    })
    return d
