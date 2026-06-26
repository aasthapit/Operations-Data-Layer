"""
Blast radius: given a bad OCP version or a bad operator (optionally pinned to a
version), find which clusters carry it and which applications ride on top of
those clusters. This is the payoff of having a rich data layer - one query
turns "operator X v1.2 is buggy" into an impact list of clusters, teams, and
apps.
"""
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..db import get_session
from ..models import Cluster, ClusterOperator

router = APIRouter(prefix="/api/blast-radius", tags=["blast-radius"])


@router.get("")
def blast_radius(
    db: Session = Depends(get_session),
    operator: str | None = Query(None, description="cluster operator name"),
    operator_version: str | None = Query(None, description="pin operator to a version"),
    ocp_version: str | None = Query(None, description="OCP/ClusterVersion"),
    degraded_only: bool = Query(False, description="only clusters where the operator is currently degraded"),
):
    if not operator and not ocp_version:
        raise HTTPException(400, "supply at least one of: operator, ocp_version")

    matched: dict[str, dict] = {}

    if ocp_version:
        for c in db.query(Cluster).filter(Cluster.ocp_version == ocp_version).all():
            matched[c.name] = {"cluster": c, "reason": f"OCP {ocp_version}"}

    if operator:
        oq = db.query(ClusterOperator).filter(ClusterOperator.name == operator)
        if operator_version:
            oq = oq.filter(ClusterOperator.version == operator_version)
        if degraded_only:
            oq = oq.filter(ClusterOperator.degraded.is_(True))
        for o in oq.all():
            # intersect with ocp_version filter if both supplied
            if ocp_version and o.cluster_name not in matched:
                continue
            c = db.get(Cluster, o.cluster_name)
            if not c:
                continue
            reason = f"{operator} {o.version}" + (" (degraded)" if o.degraded else "")
            matched[c.name] = {"cluster": c, "reason": reason}

    clusters = [m["cluster"] for m in matched.values()]

    # impacted applications, de-duplicated across clusters
    apps = defaultdict(lambda: {"clusters": [], "team": None, "tier": None,
                                "namespace": None})
    for c in clusters:
        for a in c.applications:
            entry = apps[a.name]
            entry["team"] = a.team
            entry["tier"] = a.tier
            entry["namespace"] = a.namespace
            entry["clusters"].append({
                "cluster": c.name, "region": c.region,
                "environment": c.environment, "status": c.overall_status})

    impacted_apps = sorted(
        ({"app": name, **info, "cluster_count": len(info["clusters"])}
         for name, info in apps.items()),
        key=lambda a: (a["tier"] != "critical", -a["cluster_count"], a["app"]))

    # rollups
    by_env = defaultdict(int)
    by_region = defaultdict(int)
    for c in clusters:
        by_env[c.environment or "unknown"] += 1
        by_region[c.region or "unknown"] += 1
    critical_apps = [a for a in impacted_apps if a["tier"] == "critical"]

    return {
        "query": {"operator": operator, "operator_version": operator_version,
                  "ocp_version": ocp_version, "degraded_only": degraded_only},
        "summary": {
            "clusters_impacted": len(clusters),
            "applications_impacted": len(impacted_apps),
            "critical_applications": len(critical_apps),
            "teams_impacted": len({a["team"] for a in impacted_apps if a["team"]}),
            "by_environment": dict(by_env),
            "by_region": dict(by_region),
        },
        "clusters": sorted(({
            "name": c.name, "region": c.region, "datacenter": c.datacenter,
            "environment": c.environment, "ocp_version": c.ocp_version,
            "status": c.overall_status, "reason": matched[c.name]["reason"],
        } for c in clusters), key=lambda c: c["name"]),
        "applications": impacted_apps,
    }
