"""
Blast radius: given something bad - an OCP version, a cluster operator
(optionally at a version), an OLM operator package, or a container image -
find which clusters carry it and which applications (namespaces, teams) ride
on top. This is the payoff of a rich data layer: one query turns "X is buggy"
into an impact list.
"""
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..db import get_session
from ..models import Cluster, ClusterOperator, Namespace, Resource, WorkloadImage

router = APIRouter(prefix="/api/blast-radius", tags=["blast-radius"])


def join_reasons(reasons: dict[str, int]) -> str:
    """'image x' matched 10 times and 'OCP 4.16' once -> 'image x (x10); OCP 4.16'."""
    return "; ".join(f"{r} (x{n})" if n > 1 else r for r, n in reasons.items())


@router.get("")
def blast_radius(
    db: Session = Depends(get_session),
    operator: str | None = Query(None, description="cluster operator name"),
    operator_version: str | None = Query(None, description="pin operator to a version"),
    ocp_version: str | None = Query(None, description="OCP/ClusterVersion"),
    degraded_only: bool = Query(False, description="only clusters where the operator is currently degraded"),
    olm_operator: str | None = Query(None, description="OLM package name (ClusterServiceVersion)"),
    olm_version: str | None = Query(None, description="pin the OLM operator to a version"),
    image: str | None = Query(None, description="container image substring (workload-level impact)"),
):
    if not any((operator, ocp_version, olm_operator, image)):
        raise HTTPException(400, "supply at least one of: operator, ocp_version, olm_operator, image")

    matched: dict[str, dict] = {}
    workloads: list[dict] = []

    def add(c, reason):
        if not c:
            return
        entry = matched.setdefault(c.name, {"cluster": c, "reasons": {}})
        entry["reasons"][reason] = entry["reasons"].get(reason, 0) + 1

    if ocp_version:
        for c in db.query(Cluster).filter(Cluster.ocp_version == ocp_version).all():
            add(c, f"OCP {ocp_version}")

    if operator:
        oq = db.query(ClusterOperator).filter(ClusterOperator.name == operator)
        if operator_version:
            oq = oq.filter(ClusterOperator.version == operator_version)
        if degraded_only:
            oq = oq.filter(ClusterOperator.degraded.is_(True))
        for o in oq.all():
            if ocp_version and o.cluster_name not in matched:
                continue   # intersect when both supplied
            add(db.get(Cluster, o.cluster_name),
                f"{operator} {o.version}" + (" (degraded)" if o.degraded else ""))

    if olm_operator:
        for r in db.query(Resource).filter(Resource.key == "clusterserviceversions").all():
            s = r.summary or {}
            if (s.get("package") or "") != olm_operator:
                continue
            if olm_version and s.get("version") != olm_version:
                continue
            if ocp_version and r.cluster_name not in matched:
                continue
            add(db.get(Cluster, r.cluster_name),
                f"{olm_operator} {s.get('version')} ({s.get('phase')})")

    if image:
        for w in db.query(WorkloadImage).filter(WorkloadImage.image.ilike(f"%{image}%")).all():
            if ocp_version and w.cluster_name not in matched:
                continue
            add(db.get(Cluster, w.cluster_name), f"image {w.image}")
            workloads.append({"cluster": w.cluster_name, "namespace": w.namespace,
                              "kind": w.workload_kind, "name": w.workload_name,
                              "container": w.container, "image": w.image})

    clusters = [m["cluster"] for m in matched.values()]
    hit_ns = {(w["cluster"], w["namespace"]) for w in workloads}

    # impacted applications (application namespaces), de-duplicated across clusters
    apps = defaultdict(lambda: {"clusters": [], "team": None, "tier": None, "namespace": None})
    for c in clusters:
        for n in c.applications:
            if image and not (olm_operator or operator or ocp_version) and (c.name, n.name) not in hit_ns:
                continue   # an image only impacts the namespaces that run it
            entry = apps[n.app_name or n.name]
            entry["team"] = entry["team"] or n.team
            entry["tier"] = entry["tier"] or n.tier
            entry["namespace"] = n.name
            entry["clusters"].append({
                "cluster": c.name, "region": c.region,
                "environment": c.environment, "status": c.overall_status,
                "app_status": n.status})

    impacted_apps = sorted(
        ({"app": name, **info, "cluster_count": len(info["clusters"])}
         for name, info in apps.items()),
        key=lambda a: (a["tier"] != "critical", -a["cluster_count"], a["app"]))

    # platform namespaces on impacted clusters (for image / OLM queries these matter too)
    platform_hit = sorted({w["namespace"] for w in workloads
                           if db.query(Namespace).filter_by(cluster_name=w["cluster"], name=w["namespace"],
                                                            ns_class="platform").first()})

    by_env = defaultdict(int)
    by_region = defaultdict(int)
    for c in clusters:
        by_env[c.environment or "unknown"] += 1
        by_region[c.region or "unknown"] += 1
    critical_apps = [a for a in impacted_apps if a["tier"] == "critical"]

    return {
        "query": {"operator": operator, "operator_version": operator_version,
                  "ocp_version": ocp_version, "degraded_only": degraded_only,
                  "olm_operator": olm_operator, "olm_version": olm_version, "image": image},
        "summary": {
            "clusters_impacted": len(clusters),
            "applications_impacted": len(impacted_apps),
            "critical_applications": len(critical_apps),
            "teams_impacted": len({a["team"] for a in impacted_apps if a["team"]}),
            "workloads_impacted": len(workloads),
            "platform_namespaces_impacted": platform_hit,
            "by_environment": dict(by_env),
            "by_region": dict(by_region),
        },
        "clusters": sorted(({
            "name": c.name, "region": c.region, "datacenter": c.datacenter,
            "environment": c.environment, "ocp_version": c.ocp_version,
            "status": c.overall_status, "reason": join_reasons(matched[c.name]["reasons"]),
        } for c in clusters), key=lambda c: c["name"]),
        "applications": impacted_apps,
        "workloads": sorted(workloads, key=lambda w: (w["cluster"], w["namespace"], w["name"])),
    }
