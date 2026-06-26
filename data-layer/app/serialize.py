"""Plain-dict serializers for ORM rows (kept out of the routers)."""


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
        "reachable": c.reachable,
        "last_synced": c.last_synced.isoformat() if c.last_synced else None,
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


def application_dict(a) -> dict:
    return {
        "name": a.name,
        "namespace": a.namespace,
        "team": a.team,
        "tier": a.tier,
        "replicas_desired": a.replicas_desired,
        "replicas_ready": a.replicas_ready,
    }


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
        "operators": [operator_dict(o) for o in
                      sorted(c.operators, key=lambda o: o.name)],
        "applications": [application_dict(a) for a in
                         sorted(c.applications, key=lambda a: a.name)],
        "health_checks": [check_dict(h) for h in c.health_checks],
    })
    return d
