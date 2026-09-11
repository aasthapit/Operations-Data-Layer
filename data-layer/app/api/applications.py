"""
Applications = application-class namespaces, viewed fleet-wide.

An application is identified by its `app` label (or namespace name) and may
run on many clusters; these endpoints group the per-cluster namespace rows
into one entity per application with ownership, placement and health.
"""
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..db import get_session
from ..models import Cluster, Namespace, Workload
from ..serialize import namespace_dict, workload_dict

router = APIRouter(prefix="/api/applications", tags=["applications"])

_WORST = {"critical": 3, "warning": 2, "unknown": 1, "healthy": 0}


def _rollup(statuses):
    if not statuses:
        return "unknown"
    return max(statuses, key=lambda s: _WORST.get(s, 1))


def _group(rows, clusters_by_name):
    apps = defaultdict(list)
    for n in rows:
        apps[n.app_name or n.name].append(n)
    out = []
    for app, nss in sorted(apps.items()):
        placements = []
        for n in nss:
            c = clusters_by_name.get(n.cluster_name)
            placements.append({
                "cluster": n.cluster_name,
                "namespace": n.name,
                "region": c.region if c else None,
                "environment": c.environment if c else None,
                "cluster_status": c.overall_status if c else None,
                "ocp_version": c.ocp_version if c else None,
                "status": n.status,
                "workloads": n.workloads_total,
                "replicas_desired": n.replicas_desired,
                "replicas_ready": n.replicas_ready,
                "pod_issues": n.pod_issues,
                "cpu_used_cores": n.cpu_usage,
                "memory_used_bytes": n.memory_usage,
            })
        cpu = [n.cpu_usage for n in nss if n.cpu_usage is not None]
        mem = [n.memory_usage for n in nss if n.memory_usage is not None]
        out.append({
            "app": app,
            "team": next((n.team for n in nss if n.team), None),
            "tier": next((n.tier for n in nss if n.tier), None),
            "status": _rollup([n.status for n in nss]),
            "cluster_count": len(nss),
            "environments": sorted({p["environment"] for p in placements if p["environment"]}),
            "regions": sorted({p["region"] for p in placements if p["region"]}),
            "workloads": sum(n.workloads_total or 0 for n in nss),
            "replicas_desired": sum(n.replicas_desired or 0 for n in nss),
            "replicas_ready": sum(n.replicas_ready or 0 for n in nss),
            "pod_issues": sum(n.pod_issues or 0 for n in nss),
            "cpu_used_cores": round(sum(cpu), 3) if cpu else None,
            "memory_used_bytes": int(sum(mem)) if mem else None,
            "placements": sorted(placements, key=lambda p: p["cluster"]),
        })
    return out


@router.get("")
def list_applications(
    db: Session = Depends(get_session),
    team: str | None = None,
    tier: str | None = None,
    environment: str | None = None,
    region: str | None = None,
    cluster: str | None = None,
    status: str | None = Query(None, description="healthy|warning|critical"),
):
    q = db.query(Namespace).filter(Namespace.ns_class == "application")
    if team:
        q = q.filter(Namespace.team == team)
    if tier:
        q = q.filter(Namespace.tier == tier)
    if cluster:
        q = q.filter(Namespace.cluster_name == cluster)
    clusters = {c.name: c for c in db.query(Cluster).all()}
    rows = q.all()
    if environment:
        rows = [n for n in rows if clusters.get(n.cluster_name) and
                clusters[n.cluster_name].environment == environment]
    if region:
        rows = [n for n in rows if clusters.get(n.cluster_name) and
                clusters[n.cluster_name].region == region]
    apps = _group(rows, clusters)
    if status:
        apps = [a for a in apps if a["status"] == status]
    teams = sorted({a["team"] for a in apps if a["team"]})
    return {"count": len(apps), "teams": teams, "applications": apps}


@router.get("/{app}")
def get_application(app: str, db: Session = Depends(get_session)):
    rows = (db.query(Namespace)
            .filter(Namespace.ns_class == "application", Namespace.app_name == app).all())
    if not rows:
        rows = db.query(Namespace).filter(Namespace.ns_class == "application",
                                          Namespace.name == app).all()
    if not rows:
        raise HTTPException(404, f"application {app} not found")
    clusters = {c.name: c for c in db.query(Cluster).all()}
    grouped = _group(rows, clusters)[0]
    ns_names = {n.name for n in rows}
    cluster_names = {n.cluster_name for n in rows}
    workloads = (db.query(Workload)
                 .filter(Workload.cluster_name.in_(cluster_names), Workload.namespace.in_(ns_names))
                 .order_by(Workload.cluster_name, Workload.kind, Workload.name).all())
    grouped["namespaces"] = [namespace_dict(n) for n in sorted(rows, key=lambda n: n.cluster_name)]
    grouped["workloads_detail"] = [workload_dict(w, detail=True) for w in workloads]
    return grouped
