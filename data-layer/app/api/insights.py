"""
Fleet-wide insights computed over the collected inventory - every one of these
is answered from Postgres, which in turn is fed only by the OCP API.
"""
from collections import defaultdict
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..db import get_session
from ..manifest import get_manifest
from ..models import Cluster, Namespace, PodIssue, Resource, WorkloadImage, WorkloadRef
from ..serialize import pod_issue_dict, resource_dict

router = APIRouter(prefix="/api/insights", tags=["insights"])


def _cluster_index(db):
    return {c.name: c for c in db.query(Cluster).all()}


def _placement(c):
    return {"region": c.region, "environment": c.environment, "status": c.overall_status} if c else {}


def _resources(db, key, cluster=None, namespace=None, status=None, ns_class=None):
    q = db.query(Resource).filter(Resource.key == key)
    if cluster:
        q = q.filter(Resource.cluster_name == cluster)
    if namespace:
        q = q.filter(Resource.namespace == namespace)
    if status:
        q = q.filter(Resource.status == status)
    if ns_class:
        q = q.filter(Resource.ns_class == ns_class)
    return q.order_by(Resource.cluster_name, Resource.namespace, Resource.name)


@router.get("/summary")
def summary(db: Session = Depends(get_session)):
    """Counts for the overview tiles."""
    now = datetime.now(UTC)
    window = now + timedelta(days=get_manifest().threshold("certificate_expiry_days"))
    certs = db.query(Resource).filter(Resource.key.in_(("secrets", "configmaps")),
                                      Resource.expires_at.isnot(None))
    return {
        "certificates": {
            "expired": certs.filter(Resource.expires_at <= now).count(),
            "expiring": certs.filter(Resource.expires_at > now, Resource.expires_at <= window).count(),
        },
        "pod_issues": {
            "platform": db.query(PodIssue).filter(PodIssue.ns_class == "platform").count(),
            "application": db.query(PodIssue).filter(PodIssue.ns_class == "application").count(),
        },
        "quotas_near_limit": db.query(Resource).filter(
            Resource.key == "resourcequotas", Resource.status.in_(("warning", "exhausted"))).count(),
        "machine_config_pools": {
            "degraded": db.query(Resource).filter(Resource.key == "machineconfigpools",
                                                  Resource.status == "degraded").count(),
            "updating": db.query(Resource).filter(Resource.key == "machineconfigpools",
                                                  Resource.status == "updating").count(),
        },
        "olm_operators_unhealthy": db.query(Resource).filter(
            Resource.key == "clusterserviceversions",
            Resource.status.notin_(("succeeded", "unknown"))).count(),
        "olm_upgrades_pending": db.query(Resource).filter(
            Resource.key == "subscriptions", Resource.status == "upgrade-pending").count(),
        "pvcs_pending": db.query(Resource).filter(Resource.key == "persistentvolumeclaims",
                                                  Resource.status == "pending").count(),
        "routes_rejected": db.query(Resource).filter(Resource.key == "routes",
                                                     Resource.status == "rejected").count(),
        "warning_events": db.query(Resource).filter(Resource.key == "events").count(),
        "applications": db.query(func.count(func.distinct(Namespace.app_name)))
        .filter(Namespace.ns_class == "application").scalar() or 0,
        "clusters_without_metrics": db.query(Cluster).filter(
            Cluster.reachable.is_(True), Cluster.metrics_available.is_(False)).count(),
    }


@router.get("/certificates")
def certificates(db: Session = Depends(get_session),
                 within_days: int | None = Query(None, description="default: manifest threshold"),
                 include_valid: bool = False, cluster: str | None = None,
                 ns_class: str | None = Query(None, alias="class")):
    """Certificates found in Secrets / ConfigMaps, soonest expiry first.
    The certificate material itself is never collected - only these facts."""
    now = datetime.now(UTC)
    days = within_days if within_days is not None else get_manifest().threshold("certificate_expiry_days")
    q = db.query(Resource).filter(Resource.key.in_(("secrets", "configmaps")),
                                  Resource.expires_at.isnot(None))
    if not include_valid:
        q = q.filter(Resource.expires_at <= now + timedelta(days=days))
    if cluster:
        q = q.filter(Resource.cluster_name == cluster)
    if ns_class:
        q = q.filter(Resource.ns_class == ns_class)
    clusters = _cluster_index(db)
    rows = []
    for r in q.order_by(Resource.expires_at).all():
        days_left = (r.expires_at - now).total_seconds() / 86400
        rows.append({
            "cluster": r.cluster_name, **_placement(clusters.get(r.cluster_name)),
            "namespace": r.namespace, "class": r.ns_class, "kind": r.kind, "name": r.name,
            "secret_type": (r.summary or {}).get("type"),
            "status": r.status, "expires_at": r.expires_at.isoformat(),
            "days_left": round(days_left, 1),
            "certificates": (r.summary or {}).get("certificates", []),
        })
    return {"within_days": days, "count": len(rows), "certificates": rows}


@router.get("/pod-issues")
def pod_issues(db: Session = Depends(get_session), cluster: str | None = None,
               ns_class: str | None = Query(None, alias="class"), reason: str | None = None,
               namespace: str | None = None):
    q = db.query(PodIssue)
    if cluster:
        q = q.filter(PodIssue.cluster_name == cluster)
    if ns_class:
        q = q.filter(PodIssue.ns_class == ns_class)
    if reason:
        q = q.filter(PodIssue.reason == reason)
    if namespace:
        q = q.filter(PodIssue.namespace == namespace)
    rows = q.order_by(PodIssue.ns_class, PodIssue.cluster_name, PodIssue.namespace, PodIssue.name).all()
    by_reason = defaultdict(int)
    for r in rows:
        by_reason[r.reason] += 1
    return {"count": len(rows), "by_reason": dict(by_reason),
            "pod_issues": [pod_issue_dict(i) for i in rows]}


@router.get("/quotas")
def quotas(db: Session = Depends(get_session), cluster: str | None = None,
           min_percent: float = Query(0, description="only quotas at/above this usage")):
    rows = []
    for r in _resources(db, "resourcequotas", cluster=cluster).all():
        s = r.summary or {}
        if (s.get("max_percent") or 0) < min_percent:
            continue
        rows.append({"cluster": r.cluster_name, "namespace": r.namespace, "name": r.name,
                     "status": r.status, "max_percent": s.get("max_percent"),
                     "resources": s.get("resources", [])})
    rows.sort(key=lambda q: -(q["max_percent"] or 0))
    return {"count": len(rows), "quotas": rows}


@router.get("/olm-operators")
def olm_operators(db: Session = Depends(get_session), name: str | None = None,
                  cluster: str | None = None):
    """OLM-installed operators across the fleet: version spread per package,
    install phase, and pending upgrades (from Subscriptions)."""
    csvs = _resources(db, "clusterserviceversions", cluster=cluster).all()
    subs = _resources(db, "subscriptions", cluster=cluster).all()
    pending = {(s.cluster_name, s.namespace, (s.summary or {}).get("package")): s.summary
               for s in subs if s.status == "upgrade-pending"}
    packages = defaultdict(lambda: {"versions": defaultdict(int), "installs": [], "unhealthy": 0,
                                    "upgrades_pending": 0})
    for r in csvs:
        s = r.summary or {}
        pkg = s.get("package") or r.name.rsplit(".v", 1)[0]
        if name and pkg != name:
            continue
        p = packages[pkg]
        p["display_name"] = s.get("display_name") or pkg
        p["provider"] = s.get("provider")
        p["versions"][s.get("version") or "unknown"] += 1
        unhealthy = r.status not in ("succeeded", "unknown")
        p["unhealthy"] += unhealthy
        pend = pending.get((r.cluster_name, r.namespace, pkg))
        p["upgrades_pending"] += bool(pend)
        p["installs"].append({"cluster": r.cluster_name, "namespace": r.namespace, "csv": r.name,
                              "version": s.get("version"), "phase": s.get("phase"),
                              "reason": s.get("reason"), "unhealthy": unhealthy,
                              "upgrade_to": pend.get("current_csv") if pend else None})
    out = []
    for pkg, p in sorted(packages.items()):
        out.append({"package": pkg, "display_name": p["display_name"], "provider": p["provider"],
                    "versions": [{"version": v, "count": n}
                                 for v, n in sorted(p["versions"].items(), reverse=True)],
                    "distinct": len(p["versions"]), "clusters": len(p["installs"]),
                    "unhealthy": p["unhealthy"], "upgrades_pending": p["upgrades_pending"],
                    "installs": sorted(p["installs"], key=lambda i: i["cluster"])})
    return {"operators": out}


@router.get("/machine-config-pools")
def machine_config_pools(db: Session = Depends(get_session), cluster: str | None = None,
                         status: str | None = None):
    clusters = _cluster_index(db)
    rows = []
    for r in _resources(db, "machineconfigpools", cluster=cluster, status=status).all():
        rows.append({"cluster": r.cluster_name, **_placement(clusters.get(r.cluster_name)),
                     "pool": r.name, "status": r.status, **(r.summary or {})})
    order = {"degraded": 0, "updating": 1, "paused": 2, "unknown": 3, "updated": 4}
    rows.sort(key=lambda m: (order.get(m["status"], 9), m["cluster"], m["pool"]))
    return {"count": len(rows), "pools": rows}


@router.get("/storage")
def storage(db: Session = Depends(get_session), cluster: str | None = None,
            storage_class: str | None = None):
    """Storage graph summary: classes, PV/PVC state, pending claims, what mounts them."""
    classes = defaultdict(lambda: {"clusters": set(), "provisioners": set(), "pvcs": 0,
                                   "bound": 0, "pending": 0, "requested_bytes": 0})
    for r in _resources(db, "storageclasses", cluster=cluster).all():
        c = classes[r.name]
        c["clusters"].add(r.cluster_name)
        c["provisioners"].add((r.summary or {}).get("provisioner"))
        c["default"] = c.get("default") or (r.summary or {}).get("default", False)
    pvcs = []
    for r in _resources(db, "persistentvolumeclaims", cluster=cluster).all():
        s = r.summary or {}
        sc = s.get("storage_class") or "(none)"
        if storage_class and sc != storage_class:
            continue
        c = classes[sc]
        c["pvcs"] += 1
        c["bound"] += r.status == "bound"
        c["pending"] += r.status == "pending"
        c["requested_bytes"] += s.get("requested_bytes") or 0
        pvcs.append({"cluster": r.cluster_name, "namespace": r.namespace, "class": r.ns_class,
                     "name": r.name, "status": r.status, "storage_class": sc,
                     "requested_bytes": s.get("requested_bytes"), "capacity_bytes": s.get("capacity_bytes"),
                     "volume": s.get("volume"), "mounted_by": s.get("mounted_by", [])})
    pvs = [{"cluster": r.cluster_name, "name": r.name, "status": r.status, **(r.summary or {})}
           for r in _resources(db, "persistentvolumes", cluster=cluster).all()]
    order = {"pending": 0, "lost": 1, "bound": 2}
    pvcs.sort(key=lambda p: (order.get(p["status"], 9), p["cluster"], p["namespace"], p["name"]))
    return {
        "storage_classes": [{"name": k, "clusters": sorted(v["clusters"]),
                             "provisioners": sorted(p for p in v["provisioners"] if p),
                             "default": bool(v.get("default")), "pvcs": v["pvcs"], "bound": v["bound"],
                             "pending": v["pending"], "requested_bytes": v["requested_bytes"]}
                            for k, v in sorted(classes.items())],
        "pvcs": pvcs,
        "pvs": pvs,
    }


@router.get("/routes")
def routes(db: Session = Depends(get_session), host: str | None = None,
           cluster: str | None = None, namespace: str | None = None, status: str | None = None):
    rows = []
    for r in _resources(db, "routes", cluster=cluster, namespace=namespace, status=status).all():
        s = r.summary or {}
        if host and host.lower() not in (s.get("host") or "").lower():
            continue
        rows.append({"cluster": r.cluster_name, "namespace": r.namespace, "class": r.ns_class,
                     "name": r.name, "status": r.status, **s})
    return {"count": len(rows), "routes": rows}


@router.get("/events")
def events(db: Session = Depends(get_session), cluster: str | None = None,
           namespace: str | None = None, ns_class: str | None = Query(None, alias="class"),
           reason: str | None = None, limit: int = Query(200, le=2000)):
    rows = []
    for r in _resources(db, "events", cluster=cluster, namespace=namespace, ns_class=ns_class).all():
        s = r.summary or {}
        if reason and (s.get("reason") or "").lower() != reason.lower():
            continue
        rows.append({"cluster": r.cluster_name, "namespace": r.namespace, "class": r.ns_class,
                     "name": r.name, **s})
    rows.sort(key=lambda e: e.get("last_at") or "", reverse=True)
    by_reason = defaultdict(int)
    for e in rows:
        by_reason[e.get("reason")] += 1
    return {"count": len(rows), "by_reason": dict(by_reason), "events": rows[:limit]}


@router.get("/images")
def images(db: Session = Depends(get_session), image: str | None = Query(None, description="substring match"),
           registry: str | None = None, cluster: str | None = None,
           group_by: str = Query("image", description="image|registry|repository")):
    """Which workloads run which images - the input to a CVE blast radius."""
    q = db.query(WorkloadImage)
    if image:
        q = q.filter(WorkloadImage.image.ilike(f"%{image}%"))
    if registry:
        q = q.filter(WorkloadImage.registry == registry)
    if cluster:
        q = q.filter(WorkloadImage.cluster_name == cluster)
    groups = defaultdict(lambda: {"clusters": set(), "workloads": []})
    for r in q.all():
        key = getattr(r, group_by if group_by in ("registry", "repository") else "image")
        g = groups[key]
        g["clusters"].add(r.cluster_name)
        g["workloads"].append({"cluster": r.cluster_name, "namespace": r.namespace,
                               "kind": r.workload_kind, "name": r.workload_name,
                               "container": r.container, "image": r.image, "tag": r.tag,
                               "digest": r.digest})
    out = [{group_by: k, "cluster_count": len(v["clusters"]), "workload_count": len(v["workloads"]),
            "workloads": sorted(v["workloads"], key=lambda w: (w["cluster"], w["namespace"], w["name"]))}
           for k, v in groups.items()]
    out.sort(key=lambda g: (-g["workload_count"], str(g[group_by])))
    return {"group_by": group_by, "count": len(out), "images": out}


@router.get("/references")
def references(db: Session = Depends(get_session),
               kind: str = Query(..., description="Secret|ConfigMap|PersistentVolumeClaim|ServiceAccount"),
               name: str | None = None, cluster: str | None = None, namespace: str | None = None):
    """Which workloads reference a given Secret / ConfigMap / PVC / ServiceAccount
    (the blast radius of rotating a secret or changing a config map)."""
    q = db.query(WorkloadRef).filter(WorkloadRef.ref_kind == kind)
    if name:
        q = q.filter(WorkloadRef.ref_name == name)
    if cluster:
        q = q.filter(WorkloadRef.cluster_name == cluster)
    if namespace:
        q = q.filter(WorkloadRef.namespace == namespace)
    groups = defaultdict(list)
    for r in q.all():
        groups[(r.cluster_name, r.namespace, r.ref_name)].append(
            {"kind": r.workload_kind, "name": r.workload_name, "via": r.via})
    out = [{"cluster": c, "namespace": ns, "kind": kind, "name": n,
            "workloads": sorted(ws, key=lambda w: (w["name"], w["via"]))}
           for (c, ns, n), ws in sorted(groups.items())]
    return {"count": len(out), "references": out}


@router.get("/cluster-admins")
def cluster_admins(db: Session = Depends(get_session), cluster: str | None = None):
    """Subjects bound to cluster-admin (or the roles configured in the manifest)."""
    subjects = defaultdict(lambda: {"clusters": set(), "bindings": set()})
    for r in _resources(db, "clusterrolebindings", cluster=cluster).all():
        for s in (r.summary or {}).get("subjects", []):
            key = (s.get("kind"), s.get("name"), s.get("namespace"))
            subjects[key]["clusters"].add(r.cluster_name)
            subjects[key]["bindings"].add(r.name)
            subjects[key]["role"] = (r.summary or {}).get("role")
    out = [{"kind": k, "name": n, "namespace": ns, "role": v.get("role"),
            "cluster_count": len(v["clusters"]), "clusters": sorted(v["clusters"]),
            "bindings": sorted(v["bindings"])}
           for (k, n, ns), v in subjects.items()]
    out.sort(key=lambda s: (-s["cluster_count"], s["kind"], s["name"]))
    return {"count": len(out), "subjects": out}


@router.get("/resources")
def inventory(db: Session = Depends(get_session),
              kind: str = Query(..., description="manifest key, e.g. routes, secrets, services"),
              cluster: str | None = None, namespace: str | None = None, name: str | None = None,
              status: str | None = None, ns_class: str | None = Query(None, alias="class"),
              limit: int = Query(500, le=5000)):
    """Generic fleet-wide inventory query over any collected kind."""
    q = db.query(Resource).filter(Resource.key == kind)
    if cluster:
        q = q.filter(Resource.cluster_name == cluster)
    if namespace:
        q = q.filter(Resource.namespace == namespace)
    if name:
        q = q.filter(Resource.name == name)
    if status:
        q = q.filter(Resource.status == status)
    if ns_class:
        q = q.filter(Resource.ns_class == ns_class)
    total = q.count()
    rows = q.order_by(Resource.cluster_name, Resource.namespace, Resource.name).limit(limit).all()
    return {"kind": kind, "total": total, "count": len(rows),
            "resources": [resource_dict(r) for r in rows]}
