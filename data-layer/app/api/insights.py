"""
Fleet-wide insights computed over the collected inventory - every one of these
is answered from the store, which in turn is fed only by the OCP API.

The kinds that carry fleet questions (quotas, MCPs, CSVs, storage, routes,
events, role bindings) have a fleet index each, so they are one hash read plus
in-process filtering. The counters on `/summary` come from HLEN / SCARD / ZCOUNT
and never load a row.
"""
from collections import defaultdict
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Query

from ..manifest import get_manifest
from ..serialize import pod_issue_dict, resource_dict
from ..store import FLEET_INDEXED_KINDS, Store
from .deps import get_store_dep, order_key

router = APIRouter(prefix="/api/insights", tags=["insights"])

# How many clusters' inventory sections to decompress at once when a query has
# to fall back to walking the fleet (see `_scan_resources`).
_SCAN_CHUNK = 25


def _cluster_index(store: Store):
    return {c.name: c for c in store.clusters()}


def _placement(c):
    return {"region": c.region, "environment": c.environment, "status": c.overall_status} if c else {}


def _resources(store: Store, key, cluster=None, namespace=None, status=None, ns_class=None):
    """Rows of one fleet-indexed kind, ordered (cluster, namespace, name).

    That is the order the SQL query used to return, and several callers then
    apply a stable secondary sort on top of it, so it has to be reproduced here
    rather than left to the store. `status` is pushed into the index so only the
    members with that status are loaded.
    """
    rows = list(store.fleet_resources(key, status=status,
                                      clusters=[cluster] if cluster else None))
    if namespace:
        rows = [r for r in rows if r.namespace == namespace]
    if ns_class:
        rows = [r for r in rows if r.ns_class == ns_class]
    rows.sort(key=lambda r: order_key(r.cluster_name, r.namespace, r.name))
    return rows


@router.get("/summary")
def summary(store: Store = Depends(get_store_dep)):
    """Counts for the overview tiles."""
    now = datetime.now(UTC)
    window = now + timedelta(days=get_manifest().threshold("certificate_expiry_days"))
    # `after` is an inclusive bound, so a certificate expiring in this exact
    # instant would count as both expired and expiring. Immaterial for a tile.
    expired = store.certificate_count(before=now.timestamp())
    expiring = store.certificate_count(after=now.timestamp(), before=window.timestamp())
    issues = store.pod_issue_counts()
    csv_total = store.fleet_resource_count("clusterserviceversions")
    csv_healthy = (store.fleet_resource_count("clusterserviceversions", "succeeded")
                   + store.fleet_resource_count("clusterserviceversions", "unknown"))
    apps = {n.app_name for n in store.namespaces(ns_class="application") if n.app_name}
    return {
        "certificates": {
            "expired": expired,
            "expiring": expiring,
        },
        "pod_issues": {
            "platform": issues.get("platform", 0),
            "application": issues.get("application", 0),
        },
        "quotas_near_limit": (store.fleet_resource_count("resourcequotas", "warning")
                              + store.fleet_resource_count("resourcequotas", "exhausted")),
        "machine_config_pools": {
            "degraded": store.fleet_resource_count("machineconfigpools", "degraded"),
            "updating": store.fleet_resource_count("machineconfigpools", "updating"),
        },
        "olm_operators_unhealthy": csv_total - csv_healthy,
        "olm_upgrades_pending": store.fleet_resource_count("subscriptions", "upgrade-pending"),
        "pvcs_pending": store.fleet_resource_count("persistentvolumeclaims", "pending"),
        "routes_rejected": store.fleet_resource_count("routes", "rejected"),
        "warning_events": store.fleet_resource_count("events"),
        "applications": len(apps),
        "clusters_without_metrics": sum(1 for c in store.clusters()
                                        if c.reachable and not c.metrics_available),
    }


@router.get("/certificates")
def certificates(store: Store = Depends(get_store_dep),
                 within_days: int | None = Query(None, description="default: manifest threshold"),
                 include_valid: bool = False, cluster: str | None = None,
                 ns_class: str | None = Query(None, alias="class")):
    """Certificates found in Secrets / ConfigMaps, soonest expiry first.
    The certificate material itself is never collected - only these facts."""
    now = datetime.now(UTC)
    days = within_days if within_days is not None else get_manifest().threshold("certificate_expiry_days")
    # The expiry index is a sorted set, so the cut-off is a range read and the
    # rows already arrive in expiry order.
    before = None if include_valid else (now + timedelta(days=days)).timestamp()
    clusters = _cluster_index(store)
    rows = []
    # A fleet rolls its certificates out together, so ties on the expiry score
    # are common; name the tie-break here rather than inheriting whatever order
    # the index happens to hold equal scores in.
    certs = sorted(store.certificates(before=before),
                   key=lambda r: (r.expires_at, *order_key(r.cluster_name, r.namespace, r.name)))
    for r in certs:
        if cluster and r.cluster_name != cluster:
            continue
        if ns_class and r.ns_class != ns_class:
            continue
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
def pod_issues(store: Store = Depends(get_store_dep), cluster: str | None = None,
               ns_class: str | None = Query(None, alias="class"), reason: str | None = None,
               namespace: str | None = None):
    rows = list(store.pod_issues(ns_class=ns_class, clusters=[cluster] if cluster else None))
    if reason:
        rows = [r for r in rows if r.reason == reason]
    if namespace:
        rows = [r for r in rows if r.namespace == namespace]
    rows.sort(key=lambda r: order_key(r.ns_class, r.cluster_name, r.namespace, r.name))
    by_reason = defaultdict(int)
    for r in rows:
        by_reason[r.reason] += 1
    return {"count": len(rows), "by_reason": dict(by_reason),
            "pod_issues": [pod_issue_dict(i) for i in rows]}


@router.get("/quotas")
def quotas(store: Store = Depends(get_store_dep), cluster: str | None = None,
           min_percent: float = Query(0, description="only quotas at/above this usage")):
    rows = []
    for r in _resources(store, "resourcequotas", cluster=cluster):
        s = r.summary or {}
        if (s.get("max_percent") or 0) < min_percent:
            continue
        rows.append({"cluster": r.cluster_name, "namespace": r.namespace, "name": r.name,
                     "status": r.status, "max_percent": s.get("max_percent"),
                     "resources": s.get("resources", [])})
    rows.sort(key=lambda q: -(q["max_percent"] or 0))
    return {"count": len(rows), "quotas": rows}


@router.get("/olm-operators")
def olm_operators(store: Store = Depends(get_store_dep), name: str | None = None,
                  cluster: str | None = None):
    """OLM-installed operators across the fleet: version spread per package,
    install phase, and pending upgrades (from Subscriptions)."""
    csvs = _resources(store, "clusterserviceversions", cluster=cluster)
    subs = _resources(store, "subscriptions", cluster=cluster)
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
def machine_config_pools(store: Store = Depends(get_store_dep), cluster: str | None = None,
                         status: str | None = None):
    clusters = _cluster_index(store)
    rows = []
    for r in _resources(store, "machineconfigpools", cluster=cluster, status=status):
        rows.append({"cluster": r.cluster_name, **_placement(clusters.get(r.cluster_name)),
                     "pool": r.name, "status": r.status, **(r.summary or {})})
    order = {"degraded": 0, "updating": 1, "paused": 2, "unknown": 3, "updated": 4}
    rows.sort(key=lambda m: (order.get(m["status"], 9), m["cluster"], m["pool"]))
    return {"count": len(rows), "pools": rows}


@router.get("/storage")
def storage(store: Store = Depends(get_store_dep), cluster: str | None = None,
            storage_class: str | None = None):
    """Storage graph summary: classes, PV/PVC state, pending claims, what mounts them."""
    classes = defaultdict(lambda: {"clusters": set(), "provisioners": set(), "pvcs": 0,
                                   "bound": 0, "pending": 0, "requested_bytes": 0})
    for r in _resources(store, "storageclasses", cluster=cluster):
        c = classes[r.name]
        c["clusters"].add(r.cluster_name)
        c["provisioners"].add((r.summary or {}).get("provisioner"))
        c["default"] = c.get("default") or (r.summary or {}).get("default", False)
    pvcs = []
    for r in _resources(store, "persistentvolumeclaims", cluster=cluster):
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
           for r in _resources(store, "persistentvolumes", cluster=cluster)]
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
def routes(store: Store = Depends(get_store_dep), host: str | None = None,
           cluster: str | None = None, namespace: str | None = None, status: str | None = None):
    rows = []
    for r in _resources(store, "routes", cluster=cluster, namespace=namespace, status=status):
        s = r.summary or {}
        if host and host.lower() not in (s.get("host") or "").lower():
            continue
        rows.append({"cluster": r.cluster_name, "namespace": r.namespace, "class": r.ns_class,
                     "name": r.name, "status": r.status, **s})
    return {"count": len(rows), "routes": rows}


@router.get("/events")
def events(store: Store = Depends(get_store_dep), cluster: str | None = None,
           namespace: str | None = None, ns_class: str | None = Query(None, alias="class"),
           reason: str | None = None, limit: int = Query(200, le=2000)):
    rows = []
    for r in _resources(store, "events", cluster=cluster, namespace=namespace, ns_class=ns_class):
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
def images(store: Store = Depends(get_store_dep),
           image: str | None = Query(None, description="substring match"),
           registry: str | None = None, cluster: str | None = None,
           group_by: str = Query("image", description="image|registry|repository")):
    """Which workloads run which images - the input to a CVE blast radius.

    The image index is a refcount hash scanned by substring; each surviving image
    then yields its usages from its own set. Without an `image` needle that is a
    read per distinct image in the fleet, which is what a fleet-wide image
    question costs.
    """
    groups = defaultdict(lambda: {"clusters": set(), "workloads": []})
    for hit in sorted(store.images(image)):
        for r in store.image_usages(hit):
            if registry and r.registry != registry:
                continue
            if cluster and r.cluster_name != cluster:
                continue
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
def references(store: Store = Depends(get_store_dep),
               kind: str = Query(..., description="Secret|ConfigMap|PersistentVolumeClaim|ServiceAccount"),
               name: str | None = None, cluster: str | None = None, namespace: str | None = None):
    """Which workloads reference a given Secret / ConfigMap / PVC / ServiceAccount
    (the blast radius of rotating a secret or changing a config map)."""
    if name:
        # the interesting case, and the one with an index: one set read
        rows = list(store.references(kind, name))
    else:
        # "every Secret anyone references" has no index; read the reference
        # section of the clusters in question instead
        sections = store.section_across("workload_refs", [cluster] if cluster else None)
        rows = [r for cluster_name in sorted(sections)
                for r in sections[cluster_name] if r.ref_kind == kind]
    if cluster:
        rows = [r for r in rows if r.cluster_name == cluster]
    if namespace:
        rows = [r for r in rows if r.namespace == namespace]
    groups = defaultdict(list)
    for r in rows:
        groups[(r.cluster_name, r.namespace, r.ref_name)].append(
            {"kind": r.workload_kind, "name": r.workload_name, "via": r.via})
    out = [{"cluster": c, "namespace": ns, "kind": kind, "name": n,
            "workloads": sorted(ws, key=lambda w: (w["name"], w["via"]))}
           for (c, ns, n), ws in sorted(groups.items(), key=lambda kv: order_key(*kv[0]))]
    return {"count": len(out), "references": out}


@router.get("/cluster-admins")
def cluster_admins(store: Store = Depends(get_store_dep), cluster: str | None = None):
    """Subjects bound to cluster-admin (or the roles configured in the manifest)."""
    subjects = defaultdict(lambda: {"clusters": set(), "bindings": set()})
    for r in _resources(store, "clusterrolebindings", cluster=cluster):
        for s in (r.summary or {}).get("subjects", []):
            key = (s.get("kind"), s.get("name"), s.get("namespace"))
            subjects[key]["clusters"].add(r.cluster_name)
            subjects[key]["bindings"].add(r.name)
            subjects[key]["role"] = (r.summary or {}).get("role")
    out = [{"kind": k, "name": n, "namespace": ns, "role": v.get("role"),
            "cluster_count": len(v["clusters"]), "clusters": sorted(v["clusters"]),
            "bindings": sorted(v["bindings"])}
           for (k, n, ns), v in subjects.items()]
    out.sort(key=lambda s: (-s["cluster_count"], *order_key(s["kind"], s["name"])))
    return {"count": len(out), "subjects": out}


def _matches(r, kind, namespace, name, status, ns_class) -> bool:
    return (r.key == kind
            and (not namespace or r.namespace == namespace)
            and (not name or r.name == name)
            and (not status or r.status == status)
            and (not ns_class or r.ns_class == ns_class))


def _scan_resources(store: Store, kind, cluster, namespace, name, status, ns_class, limit):
    """Inventory of a kind that has no fleet index, by walking the clusters.

    Kinds like configmaps, services or networkpolicies are large and rarely asked
    fleet-wide, so they live only in each cluster's `resources` section. We read
    those sections in chunks (bounded memory), in cluster-name order so the rows
    kept are the same first `limit` the SQL `ORDER BY ... LIMIT` used to return,
    and keep counting matches past the limit so `total` stays exact.
    """
    names = [cluster] if cluster else store.cluster_names()
    rows, total = [], 0
    for start in range(0, len(names), _SCAN_CHUNK):
        chunk = names[start:start + _SCAN_CHUNK]
        sections = store.section_across("resources", chunk)
        for cluster_name in chunk:
            matched = [r for r in sections.get(cluster_name, [])
                       if _matches(r, kind, namespace, name, status, ns_class)]
            total += len(matched)
            if len(rows) < limit:
                matched.sort(key=lambda r: order_key(r.namespace, r.name))
                rows.extend(matched[:limit - len(rows)])
    return rows, total


@router.get("/resources")
def inventory(store: Store = Depends(get_store_dep),
              kind: str = Query(..., description="manifest key, e.g. routes, secrets, services"),
              cluster: str | None = None, namespace: str | None = None, name: str | None = None,
              status: str | None = None, ns_class: str | None = Query(None, alias="class"),
              limit: int = Query(500, le=5000)):
    """Generic fleet-wide inventory query over any collected kind."""
    if kind in FLEET_INDEXED_KINDS:
        rows = _resources(store, kind, cluster=cluster, namespace=namespace,
                          status=status, ns_class=ns_class)
        if name:
            rows = [r for r in rows if r.name == name]
        total = len(rows)
        rows = rows[:limit]
    else:
        rows, total = _scan_resources(store, kind, cluster, namespace, name,
                                      status, ns_class, limit)
    return {"kind": kind, "total": total, "count": len(rows),
            "resources": [resource_dict(r) for r in rows]}
