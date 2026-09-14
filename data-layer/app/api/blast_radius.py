"""
Blast radius: given something bad - an OCP version, a cluster operator
(optionally at a version), an OLM operator package, or a container image -
find which clusters carry it and which applications (namespaces, teams) ride
on top. This is the payoff of a rich data layer: one query turns "X is buggy"
into an impact list.

Every lookup here is a fleet index: the version dimension set, the per-operator
hash, the CSV resource hash, the image refcount hash and its per-image usage
set. Nothing walks the clusters.
"""
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Query

from ..serialize import UNASSIGNED
from ..store import Store
from .deps import get_store_dep

router = APIRouter(prefix="/api/blast-radius", tags=["blast-radius"])


def join_reasons(reasons: dict[str, int]) -> str:
    """'image x' matched 10 times and 'OCP 4.16' once -> 'image x (x10); OCP 4.16'."""
    return "; ".join(f"{r} (x{n})" if n > 1 else r for r, n in reasons.items())


@router.get("")
def blast_radius(
    store: Store = Depends(get_store_dep),
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

    # cluster name -> why it matched -> how often. Insertion order is the order
    # the matches were found, which the environment/region rollups follow.
    reasons: dict[str, dict[str, int]] = {}
    workloads: list[dict] = []

    def add(cluster_name, reason):
        entry = reasons.setdefault(cluster_name, {})
        entry[reason] = entry.get(reason, 0) + 1

    if ocp_version:
        for c in store.clusters(version=ocp_version):
            add(c.name, f"OCP {ocp_version}")

    if operator:
        for cluster_name, o in sorted(store.operator_index(operator).items()):
            if operator_version and o.version != operator_version:
                continue
            if degraded_only and not o.degraded:
                continue
            if ocp_version and cluster_name not in reasons:
                continue   # intersect when both supplied
            add(cluster_name, f"{operator} {o.version}" + (" (degraded)" if o.degraded else ""))

    if olm_operator:
        for r in sorted(store.fleet_resources("clusterserviceversions"),
                        key=lambda r: (r.cluster_name or "", r.namespace or "", r.name or "")):
            s = r.summary or {}
            if (s.get("package") or "") != olm_operator:
                continue
            if olm_version and s.get("version") != olm_version:
                continue
            if ocp_version and r.cluster_name not in reasons:
                continue
            add(r.cluster_name, f"{olm_operator} {s.get('version')} ({s.get('phase')})")

    if image:
        for hit in sorted(store.images(image)):
            for w in sorted(store.image_usages(hit),
                            key=lambda w: (w.cluster_name or "", w.namespace or "",
                                           w.workload_name or "", w.container or "")):
                if ocp_version and w.cluster_name not in reasons:
                    continue
                add(w.cluster_name, f"image {w.image}")
                workloads.append({"cluster": w.cluster_name, "namespace": w.namespace,
                                  "kind": w.workload_kind, "name": w.workload_name,
                                  "container": w.container, "image": w.image})

    # An index member whose cluster has aged out of Redis is not an impact.
    known = {c.name: c for c in store.clusters(names=list(reasons))} if reasons else {}
    clusters = [known[n] for n in reasons if n in known]
    hit_ns = {(w["cluster"], w["namespace"]) for w in workloads}

    # impacted applications (application namespaces), de-duplicated across clusters
    by_cluster = defaultdict(list)
    if clusters:
        for n in store.namespaces(ns_class="application", clusters=[c.name for c in clusters]):
            by_cluster[n.cluster_name].append(n)
    apps = defaultdict(lambda: {"clusters": [], "team": None, "tier": None, "namespace": None})
    for c in clusters:
        for n in sorted(by_cluster.get(c.name, []), key=lambda n: n.name):
            if image and not (olm_operator or operator or ocp_version) and (c.name, n.name) not in hit_ns:
                continue   # an image only impacts the namespaces that run it
            entry = apps[n.app_name or (n.name if n.assigned is None else UNASSIGNED)]
            entry["team"] = entry["team"] or n.team
            entry["tier"] = entry["tier"] or n.tier
            entry["namespace"] = n.name
            entry["clusters"].append({
                "cluster": c.name, "region": c.region,
                "environment": c.environment, "status": c.overall_status,
                "app_status": n.status})

    impacted_apps = sorted(
        ({"app": name, "assigned": name != UNASSIGNED, **info, "cluster_count": len(info["clusters"])}
         for name, info in apps.items()),
        key=lambda a: (a["tier"] != "critical", -a["cluster_count"], a["app"]))

    # platform namespaces on impacted clusters (for image / OLM queries these matter too).
    # One index read for the platform namespaces of the hit clusters, then a
    # membership test - not a lookup per workload.
    platform_hit: list[str] = []
    if workloads:
        platform = {(n.cluster_name, n.name) for n in store.namespaces(
            ns_class="platform", clusters=sorted({w["cluster"] for w in workloads}))}
        platform_hit = sorted({w["namespace"] for w in workloads
                               if (w["cluster"], w["namespace"]) in platform})

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
            "status": c.overall_status, "reason": join_reasons(reasons[c.name]),
        } for c in clusters), key=lambda c: c["name"]),
        "applications": impacted_apps,
        "workloads": sorted(workloads, key=lambda w: (w["cluster"], w["namespace"], w["name"])),
    }
