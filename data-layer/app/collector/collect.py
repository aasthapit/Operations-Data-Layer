"""
Collect everything the manifest enables from one cluster and assemble it into
a single normalised document (plain dicts) that health checks and persistence
consume.

Two phases:
  1. fetch  - one API call per enabled manifest resource, recording per-resource
              outcome (collected / unavailable / forbidden / error) so "what can
              this cluster answer?" is itself data.
  2. assemble - join the raw objects: pods and metrics roll up into namespaces
              and nodes, workloads yield image / config-reference edges, every
              other kind becomes a scrubbed inventory row, and capacity is
              summed for the cluster.
"""
import logging
import time
from collections import Counter, defaultdict
from datetime import UTC, datetime

from .. import kube
from ..manifest import APPLICATION, Manifest
from . import parsers as p
from .registry import REGISTRY

log = logging.getLogger("odl.collect")

_GENERIC_PARSERS = {
    "configmaps": p.parse_configmap,
    "secrets": p.parse_secret,
    "services": p.parse_service,
    "routes": p.parse_route,
    "ingresses": p.parse_ingress,
    "networkpolicies": p.parse_networkpolicy,
    "persistentvolumeclaims": p.parse_pvc,
    "persistentvolumes": p.parse_pv,
    "storageclasses": p.parse_storageclass,
    "resourcequotas": p.parse_resourcequota,
    "events": p.parse_event,
    "cronjobs": p.parse_cronjob,
    "horizontalpodautoscalers": p.parse_hpa,
    "clusterserviceversions": p.parse_csv,
    "subscriptions": p.parse_subscription,
    "machineconfigpools": p.parse_mcp,
    "clusterrolebindings": p.parse_clusterrolebinding,
}
_WORKLOAD_KEYS = {"deployments": "Deployment", "statefulsets": "StatefulSet",
                  "daemonsets": "DaemonSet"}

_missing = [k for k, spec in REGISTRY.items() if spec.store == "generic" and k not in _GENERIC_PARSERS]
if _missing:
    raise RuntimeError(f"registry keys without a parser: {', '.join(_missing)}")


# --------------------------------------------------------------------------- #
# phase 1: fetch
# --------------------------------------------------------------------------- #
def _fetch(b: kube.ApiBundle, key: str, manifest: Manifest):
    spec = REGISTRY[key]
    if spec.name:
        return kube.get_resource(b, spec.base_path, spec.plural, spec.name)
    return kube.list_resource(b, spec.base_path, spec.plural,
                              field_selector=spec.field_selector)


def fetch_all(b: kube.ApiBundle, manifest: Manifest) -> tuple[dict, dict]:
    """Return (raw objects by key, status by key)."""
    raw, status = {}, {}
    for key in REGISTRY:
        if not manifest.enabled(key):
            status[key] = {"status": "disabled", "count": 0, "duration_ms": 0, "error": None}
            continue
        t0 = time.time()
        try:
            got = _fetch(b, key, manifest)
            raw[key] = got
            count = len(got) if isinstance(got, list) else 1
            status[key] = {"status": "collected", "count": count, "error": None}
        except kube.ResourceUnavailable as e:
            status[key] = {"status": "unavailable", "count": 0, "error": str(e)}
        except kube.ResourceForbidden as e:
            status[key] = {"status": "forbidden", "count": 0, "error": str(e)}
        except Exception as e:  # noqa: BLE001
            status[key] = {"status": "error", "count": 0, "error": str(e)[:500]}
            log.warning("collect %s: %s", key, e)
        status[key]["duration_ms"] = int((time.time() - t0) * 1000)
    return raw, status


# --------------------------------------------------------------------------- #
# phase 2: assemble
# --------------------------------------------------------------------------- #
def _ns_of(obj) -> str | None:
    return (obj.get("metadata") or {}).get("namespace")


def _most_common(values) -> str | None:
    values = [v for v in values if v]
    return Counter(values).most_common(1)[0][0] if values else None


def _ns_status(ns: dict, workloads: list[dict]) -> str:
    if any(w["status"] == "degraded" for w in workloads):
        return "critical"
    if ns.get("pod_issues") or any(w["status"] == "progressing" for w in workloads):
        return "warning"
    return "healthy"


def assemble(meta: dict, raw: dict, status: dict, manifest: Manifest,
             now: datetime | None = None) -> dict:
    now = now or datetime.now(UTC)
    data = dict(meta)
    data.update({"reachable": True, "error": None, "resource_status": status})

    # --- cluster-level platform config -------------------------------------
    if "clusterversion" in raw:
        data.update(p.parse_clusterversion(raw["clusterversion"]))
    else:
        data.setdefault("version", meta.get("label_version"))
    if "infrastructure" in raw:
        data.update(p.parse_infrastructure(raw["infrastructure"]))
    if "network_config" in raw:
        data.update(p.parse_network_config(raw["network_config"]))
    if "ingress_config" in raw:
        data.update(p.parse_ingress_config(raw["ingress_config"]))
    data["operators"] = p.parse_operators(raw.get("clusteroperators") or [])

    # --- namespaces (the classification everything else hangs off) ---------
    namespaces: dict[str, dict] = {}
    for ns in raw.get("namespaces") or []:
        row = p.parse_namespace(ns, manifest)
        namespaces[row["name"]] = row

    def ns_class(name: str) -> str:
        row = namespaces.get(name)
        return row["ns_class"] if row else manifest.classify_namespace(name, {})

    def ensure_ns(name: str) -> dict:
        if name not in namespaces:
            namespaces[name] = {
                "name": name, "ns_class": manifest.classify_namespace(name, {}),
                "app_name": None, "team": None, "tier": None, "labels": {}, "annotations": {},
                "requester": None, "display_name": None, "phase": None, "created_at": None,
            }
        return namespaces[name]

    def wanted(key: str, obj: dict) -> bool:
        ns = _ns_of(obj)
        return ns is None or manifest.wants_namespace(key, ns_class(ns))

    # --- workloads ---------------------------------------------------------
    workloads: list[dict] = []
    images_rows: list[dict] = []
    refs_rows: list[dict] = []
    for key, kind in _WORKLOAD_KEYS.items():
        for obj in raw.get(key) or []:
            if not wanted(key, obj):
                continue
            w = p.parse_workload(obj, kind, manifest)
            w["ns_class"] = ns_class(w["namespace"])
            workloads.append(w)
            for c in w["containers"]:
                if c.get("image"):
                    images_rows.append({"namespace": w["namespace"], "workload_kind": kind,
                                        "workload_name": w["name"], "container": c["name"],
                                        **p.split_image(c["image"])})
            for r in w["config_refs"]:
                refs_rows.append({"namespace": w["namespace"], "workload_kind": kind,
                                  "workload_name": w["name"], "ref_kind": r["kind"],
                                  "ref_name": r["name"], "via": r["via"]})
    wl_by_ns: dict[str, list] = defaultdict(list)
    for w in workloads:
        wl_by_ns[w["namespace"]].append(w)

    # --- pods + pod metrics -------------------------------------------------
    pods_raw = [o for o in (raw.get("pods") or []) if wanted("pods", o)]
    pods = p.parse_pods(pods_raw, manifest, now)
    pod_metrics = p.parse_pod_metrics([o for o in (raw.get("pod_metrics") or [])
                                       if wanted("pod_metrics", o)])
    pod_issues = pods["issues"]
    for issue in pod_issues:
        issue["ns_class"] = ns_class(issue["namespace"])

    # --- nodes + node metrics ----------------------------------------------
    node_usage = p.parse_node_metrics(raw.get("node_metrics") or [])
    nodes = []
    for obj in raw.get("nodes") or []:
        n = p.parse_node(obj, manifest)
        n.update(node_usage.get(n["name"], {}))
        n["pods_running"] = pods["node_pods"].get(n["name"], 0)
        nodes.append(n)
    data["nodes"] = nodes
    data["nodes_total"] = len(nodes)
    data["nodes_ready"] = sum(1 for n in nodes if n["ready"])

    # --- generic resources --------------------------------------------------
    resources: list[dict] = []
    ns_counts: dict[str, Counter] = defaultdict(Counter)
    for key, parser in _GENERIC_PARSERS.items():
        spec = REGISTRY[key]
        items = raw.get(key) or []
        if key == "events":
            limit = manifest.config(key).limit
            items = sorted(items, key=lambda e: str(e.get("lastTimestamp") or e.get("eventTime")
                                                    or e.get("firstTimestamp") or ""), reverse=True)
            if limit:
                items = items[:limit]
        for obj in items:
            if spec.scope == "namespaced" and not wanted(key, obj):
                continue
            row = (parser(obj, manifest, pods["pvc_mounts"]) if key == "persistentvolumeclaims"
                   else parser(obj, manifest))
            if row is None:
                continue
            row.update({"key": key, "kind": spec.kind, "api_group": spec.api_group_label,
                        "ns_class": ns_class(row["namespace"]) if row["namespace"] else None})
            resources.append(row)
            if row["namespace"]:
                ns_counts[row["namespace"]][key] += 1
    data["resources"] = resources

    # --- namespace rollups --------------------------------------------------
    own = manifest.ownership
    for name in set(pods["namespaces"]) | set(wl_by_ns) | set(pod_metrics):
        ensure_ns(name)
    for name, ns in namespaces.items():
        roll = pods["namespaces"].get(name, {})
        ns.update({k: v for k, v in roll.items() if k != "images"})
        ns.setdefault("pods_total", 0)
        for k in ("pods_running", "pods_pending", "pods_failed", "pods_succeeded",
                  "restarts_total", "pod_issues"):
            ns.setdefault(k, 0)
        for k in ("cpu_requests", "cpu_limits", "memory_requests", "memory_limits"):
            ns.setdefault(k, None if not roll else roll.get(k))
        ns["images"] = roll.get("images", [])
        usage = pod_metrics.get(name)
        ns["cpu_usage"] = usage["cpu_usage"] if usage else None
        ns["memory_usage"] = usage["memory_usage"] if usage else None
        wls = wl_by_ns.get(name, [])
        ns["workloads_total"] = len(wls)
        ns["replicas_desired"] = sum(w["replicas_desired"] for w in wls)
        ns["replicas_ready"] = sum(w["replicas_ready"] for w in wls)
        ns["resource_counts"] = dict(ns_counts.get(name, {}))
        ns["status"] = _ns_status(ns, wls)
        # ownership: namespace labels first, then the workloads' most common value
        for field in ("app_name", "team", "tier"):
            if ns.get(field):
                continue
            keys = own.get("app" if field == "app_name" else field, [])
            ns[field] = _most_common(p.pick_label(w["labels"], keys) for w in wls)
        if not ns.get("app_name"):
            ns["app_name"] = name
    data["namespaces"] = sorted(namespaces.values(), key=lambda n: n["name"])
    data["workloads"] = workloads
    data["workload_images"] = images_rows
    data["workload_refs"] = refs_rows
    data["pod_issues"] = pod_issues

    # --- capacity / utilization rollup ---------------------------------------
    def total(rows, key, cast=float):
        vals = [r.get(key) for r in rows if r.get(key) is not None]
        return cast(sum(vals)) if vals else None

    metrics_ok = status.get("node_metrics", {}).get("status") == "collected"
    pod_metrics_ok = status.get("pod_metrics", {}).get("status") == "collected"
    cpu_usage = total(nodes, "cpu_usage") if metrics_ok else None
    mem_usage = total(nodes, "memory_usage", int) if metrics_ok else None
    if cpu_usage is None and pod_metrics_ok:
        cpu_usage = total(list(pod_metrics.values()), "cpu_usage")
        mem_usage = total(list(pod_metrics.values()), "memory_usage", int)
    ns_rows = data["namespaces"]
    data["capacity"] = {
        "cpu_capacity": total(nodes, "cpu_capacity"),
        "cpu_allocatable": total(nodes, "cpu_allocatable"),
        "cpu_requests": total(ns_rows, "cpu_requests"),
        "cpu_limits": total(ns_rows, "cpu_limits"),
        "cpu_usage": cpu_usage,
        "memory_capacity": total(nodes, "memory_capacity", int),
        "memory_allocatable": total(nodes, "memory_allocatable", int),
        "memory_requests": total(ns_rows, "memory_requests", int),
        "memory_limits": total(ns_rows, "memory_limits", int),
        "memory_usage": mem_usage,
        "pods_capacity": total(nodes, "pods_capacity", int),
        "pods_total": sum(n["pods_total"] for n in ns_rows),
        "pods_running": sum(n["pods_running"] for n in ns_rows),
        "metrics_available": bool(metrics_ok or pod_metrics_ok),
    }
    data["namespaces_application"] = sum(1 for n in ns_rows if n["ns_class"] == APPLICATION)
    data["namespaces_platform"] = len(ns_rows) - data["namespaces_application"]
    data["workloads_total"] = len(workloads)
    data["pod_issues_total"] = len(pod_issues)
    data["certs_expiring_total"] = sum(1 for r in resources
                                       if r["key"] in ("secrets", "configmaps")
                                       and r["status"] in ("expiring", "expired"))
    return data


def collect_managed_cluster(b: kube.ApiBundle, meta: dict, manifest: Manifest) -> dict:
    """Pull everything the manifest enables from one cluster."""
    t0 = time.time()
    raw, status = fetch_all(b, manifest)
    data = assemble(meta, raw, status, manifest)
    data["collect_ms"] = int((time.time() - t0) * 1000)
    return data


def unreachable(meta: dict, error: str) -> dict:
    """The document for a cluster we could not connect to."""
    data = dict(meta)
    data.update({
        "reachable": False, "error": error, "resource_status": {},
        "operators": [], "nodes": [], "namespaces": [], "workloads": [],
        "workload_images": [], "workload_refs": [], "pod_issues": [], "resources": [],
        "capacity": {}, "nodes_total": 0, "nodes_ready": 0,
    })
    return data
