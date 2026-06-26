"""
Collect raw state from a managed cluster and normalise it into plain dicts.

Parsing lives here (and only here) so the rest of the data layer never has to
know the shape of an OpenShift CR. The normalised dicts are what health checks
and persistence consume.
"""
import re

from .. import kube


# --------------------------------------------------------------------------- #
# ManagedCluster (read from the hub)
# --------------------------------------------------------------------------- #
def normalize_managedcluster(mc: dict) -> dict:
    meta = mc.get("metadata", {})
    labels = meta.get("labels", {})
    status = mc.get("status", {})
    claims = {c["name"]: c["value"] for c in status.get("clusterClaims", [])}
    conds = {c["type"]: c["status"] for c in status.get("conditions", [])}
    return {
        "name": meta.get("name"),
        "region": labels.get("region") or claims.get("region.open-cluster-management.io"),
        "datacenter": labels.get("datacenter") or claims.get("datacenter.odl.io"),
        "environment": labels.get("environment") or claims.get("environment.odl.io"),
        "cloud": labels.get("cloud"),
        "vendor": labels.get("vendor"),
        "label_version": labels.get("openshiftVersion") or claims.get("version.openshift.io"),
        "cluster_id": claims.get("id.openshift.io"),
        "kube_version": status.get("version", {}).get("kubernetes"),
        "managed_available": conds.get("ManagedClusterConditionAvailable") == "True",
    }


# --------------------------------------------------------------------------- #
# ClusterVersion / ClusterOperator / Infrastructure (read from managed cluster)
# --------------------------------------------------------------------------- #
def _conditions(obj) -> dict:
    return {c["type"]: c for c in obj.get("status", {}).get("conditions", [])}


def parse_clusterversion(cv: dict) -> dict:
    status = cv.get("status", {})
    conds = _conditions(cv)
    desired = status.get("desired", {}).get("version")

    history = status.get("history", []) or []
    completed = [h for h in history if h.get("state") == "Completed"]
    current = completed[0]["version"] if completed else desired

    progressing = conds.get("Progressing", {}).get("status") == "True"
    pct = 0
    if progressing:
        msg = conds.get("Progressing", {}).get("message", "")
        m = re.search(r"(\d+)%", msg)
        pct = int(m.group(1)) if m else 0

    return {
        "version": current,
        "desired_version": desired,
        "channel": cv.get("spec", {}).get("channel"),
        "cluster_id": cv.get("spec", {}).get("clusterID"),
        "upgrading": progressing,
        "upgrade_percent": pct,
        "cv_available": conds.get("Available", {}).get("status", "True") == "True",
        "cv_failing": conds.get("Failing", {}).get("status") == "True",
        "available_updates": [u["version"] for u in (status.get("availableUpdates") or [])],
    }


def parse_operators(items: list) -> list:
    out = []
    for op in items:
        meta = op.get("metadata", {})
        conds = _conditions(op)
        versions = op.get("status", {}).get("versions", []) or []
        opver = next((v["version"] for v in versions if v["name"] == "operator"),
                     versions[0]["version"] if versions else None)
        out.append({
            "name": meta.get("name"),
            "version": opver,
            "available": conds.get("Available", {}).get("status", "True") == "True",
            "progressing": conds.get("Progressing", {}).get("status") == "True",
            "degraded": conds.get("Degraded", {}).get("status") == "True",
            "critical": meta.get("labels", {}).get("odl.io/critical") == "true",
            "message": (conds.get("Degraded", {}).get("message")
                        or conds.get("Progressing", {}).get("message") or ""),
        })
    return out


def parse_infrastructure(infra: dict) -> dict:
    status = infra.get("status", {})
    pstatus = status.get("platformStatus", {})
    region = None
    for plat in ("aws", "azure", "gcp", "vsphere"):
        if plat in pstatus and isinstance(pstatus[plat], dict):
            region = pstatus[plat].get("region") or region
    return {
        "platform": status.get("platform"),
        "infrastructure_name": status.get("infrastructureName"),
        "infra_region": region,
    }


def collect_nodes(b: kube.ApiBundle):
    nodes = b.core.list_node().items
    ready = 0
    for n in nodes:
        for cond in (n.status.conditions or []):
            if cond.type == "Ready" and cond.status == "True":
                ready += 1
    return len(nodes), ready


def collect_apps(b: kube.ApiBundle):
    deps = b.apps.list_deployment_for_all_namespaces(
        label_selector="odl.io/app").items
    apps = []
    for d in deps:
        labels = d.metadata.labels or {}
        apps.append({
            "name": labels.get("odl.io/app", d.metadata.name),
            "namespace": d.metadata.namespace,
            "team": labels.get("odl.io/team"),
            "tier": labels.get("odl.io/tier"),
            "replicas_desired": d.spec.replicas or 0,
            "replicas_ready": d.status.ready_replicas or 0,
        })
    return apps


def collect_managed_cluster(b: kube.ApiBundle, meta: dict) -> dict:
    """Pull everything we care about from one managed cluster."""
    data = dict(meta)
    data["reachable"] = True
    data["error"] = None
    try:
        cv = kube.get_clusterversion(b)
        data.update(parse_clusterversion(cv))
    except Exception as e:  # noqa: BLE001
        data.setdefault("version", meta.get("label_version"))
        data["cv_error"] = str(e)

    try:
        data["operators"] = parse_operators(kube.list_clusteroperators(b))
    except Exception:  # noqa: BLE001
        data["operators"] = []

    try:
        data.update(parse_infrastructure(kube.get_infrastructure(b)))
    except Exception:  # noqa: BLE001
        pass

    try:
        data["nodes_total"], data["nodes_ready"] = collect_nodes(b)
    except Exception:  # noqa: BLE001
        data["nodes_total"], data["nodes_ready"] = 0, 0

    try:
        data["applications"] = collect_apps(b)
    except Exception:  # noqa: BLE001
        data["applications"] = []

    return data
