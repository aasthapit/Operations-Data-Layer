"""
Normalise raw OpenShift / Kubernetes objects (plain dicts) into the shapes the
data layer persists.

Parsing lives here (and only here) so the rest of the data layer never has to
know the shape of an API object. Scrubbing happens *inside* these parsers, so
a raw ConfigMap / Secret / container spec never escapes this module with its
values intact.
"""
import re
from collections import Counter, defaultdict
from datetime import UTC, datetime
from decimal import Decimal

from kubernetes.utils.quantity import parse_quantity

from . import scrub


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def parse_time(ts) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return None


def cores(q) -> float | None:
    """CPU quantity ("250m", "1234567n", "2") -> float cores."""
    if q in (None, ""):
        return None
    try:
        return float(parse_quantity(str(q)))
    except (ValueError, ArithmeticError):
        return None


def qbytes(q) -> int | None:
    """Memory / storage quantity ("16Gi", "1048576") -> int bytes."""
    if q in (None, ""):
        return None
    try:
        return int(parse_quantity(str(q)))
    except (ValueError, ArithmeticError):
        return None


def qint(q) -> int | None:
    if q in (None, ""):
        return None
    try:
        return int(Decimal(str(q)))
    except (ValueError, ArithmeticError):
        return None


def _conditions(obj) -> dict:
    return {c.get("type"): c for c in (obj.get("status") or {}).get("conditions") or []}


def _cond_true(conds: dict, ctype: str, default=False) -> bool:
    c = conds.get(ctype)
    return (c.get("status") == "True") if c else default


def meta(obj: dict, manifest) -> dict:
    """The metadata every persisted row shares, annotations allow-listed."""
    m = obj.get("metadata") or {}
    return {
        "name": m.get("name"),
        "namespace": m.get("namespace"),
        "labels": m.get("labels") or {},
        "annotations": scrub.scrub_annotations(m.get("annotations"), manifest.keep_annotations),
        "created_at": parse_time(m.get("creationTimestamp")),
    }


_IMAGE_RE = re.compile(r"^(?:(?P<registry>[^/]+\.[^/]+|localhost(?::\d+)?|[^/]+:\d+)/)?"
                       r"(?P<repo>[^@:]+(?::\d+/[^@:]+)?)(?::(?P<tag>[^@]+))?(?:@(?P<digest>.+))?$")


def split_image(image: str) -> dict:
    """'quay.io/org/app:1.2@sha256:abc' -> registry / repository / tag / digest."""
    m = _IMAGE_RE.match(image or "")
    if not m:
        return {"image": image, "registry": None, "repository": image, "tag": None, "digest": None}
    registry = m.group("registry") or "docker.io"
    return {"image": image, "registry": registry, "repository": m.group("repo"),
            "tag": m.group("tag"), "digest": m.group("digest")}


def pick_label(labels: dict, keys: list[str]) -> str | None:
    for k in keys:
        v = labels.get(k)
        if v:
            return v
    return None


# --------------------------------------------------------------------------- #
# ManagedCluster (read from the hub)
# --------------------------------------------------------------------------- #
def normalize_managedcluster(mc: dict) -> dict:
    m = mc.get("metadata", {})
    labels = m.get("labels", {})
    status = mc.get("status", {})
    claims = {c["name"]: c["value"] for c in status.get("clusterClaims", [])}
    conds = {c["type"]: c["status"] for c in status.get("conditions", [])}
    return {
        "name": m.get("name"),
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
# cluster-scoped platform config
# --------------------------------------------------------------------------- #
def parse_clusterversion(cv: dict) -> dict:
    status = cv.get("status", {})
    conds = _conditions(cv)
    desired = status.get("desired", {}).get("version")

    history = status.get("history", []) or []
    completed = [h for h in history if h.get("state") == "Completed"]
    current = completed[0]["version"] if completed else desired

    progressing = _cond_true(conds, "Progressing")
    pct = 0
    if progressing:
        msg = conds.get("Progressing", {}).get("message", "") or ""
        m = re.search(r"(\d+)%", msg)
        pct = int(m.group(1)) if m else 0

    return {
        "version": current,
        "desired_version": desired,
        "channel": cv.get("spec", {}).get("channel"),
        "cluster_id": cv.get("spec", {}).get("clusterID"),
        "upgrading": progressing,
        "upgrade_percent": pct,
        "cv_available": _cond_true(conds, "Available", default=True),
        "cv_failing": _cond_true(conds, "Failing"),
        "available_updates": [u["version"] for u in (status.get("availableUpdates") or [])],
    }


def parse_operators(items: list) -> list:
    out = []
    for op in items:
        m = op.get("metadata", {})
        conds = _conditions(op)
        versions = op.get("status", {}).get("versions", []) or []
        opver = next((v["version"] for v in versions if v.get("name") == "operator"),
                     versions[0]["version"] if versions else None)
        out.append({
            "name": m.get("name"),
            "version": opver,
            "available": _cond_true(conds, "Available", default=True),
            "progressing": _cond_true(conds, "Progressing"),
            "degraded": _cond_true(conds, "Degraded"),
            "critical": (m.get("labels") or {}).get("odl.io/critical") == "true",
            "message": (conds.get("Degraded", {}).get("message")
                        or conds.get("Progressing", {}).get("message") or ""),
        })
    return out


def parse_infrastructure(infra: dict) -> dict:
    status = infra.get("status", {})
    pstatus = status.get("platformStatus", {}) or {}
    region = None
    for plat in ("aws", "azure", "gcp", "vsphere", "ibmcloud", "openstack"):
        if isinstance(pstatus.get(plat), dict):
            region = pstatus[plat].get("region") or region
    return {
        "platform": status.get("platform") or pstatus.get("type"),
        "infrastructure_name": status.get("infrastructureName"),
        "infra_region": region,
        "api_url": status.get("apiServerURL"),
        "control_plane_topology": status.get("controlPlaneTopology"),
        "infrastructure_topology": status.get("infrastructureTopology"),
    }


def parse_network_config(net: dict) -> dict:
    status = net.get("status") or {}
    spec = net.get("spec") or {}
    return {
        "network_type": status.get("networkType") or spec.get("networkType"),
        "cluster_network": [c.get("cidr") for c in (status.get("clusterNetwork")
                                                     or spec.get("clusterNetwork") or [])],
        "service_network": list(status.get("serviceNetwork") or spec.get("serviceNetwork") or []),
    }


def parse_ingress_config(ing: dict) -> dict:
    return {"apps_domain": (ing.get("spec") or {}).get("domain")}


# --------------------------------------------------------------------------- #
# nodes + node metrics
# --------------------------------------------------------------------------- #
PRESSURE_CONDITIONS = ("MemoryPressure", "DiskPressure", "PIDPressure", "NetworkUnavailable")


def parse_node(node: dict, manifest) -> dict:
    m = meta(node, manifest)
    labels = m["labels"]
    status = node.get("status") or {}
    spec = node.get("spec") or {}
    conds = _conditions(node)
    info = status.get("nodeInfo") or {}
    cap = status.get("capacity") or {}
    alloc = status.get("allocatable") or {}
    roles = sorted(k.split("/", 1)[1] for k in labels
                   if k.startswith("node-role.kubernetes.io/")) or ["worker"]
    images = status.get("images") or []
    return {
        "name": m["name"],
        "roles": roles,
        "ready": _cond_true(conds, "Ready"),
        "schedulable": not spec.get("unschedulable", False),
        "conditions": {c: _cond_true(conds, c) for c in PRESSURE_CONDITIONS},
        "kubelet_version": info.get("kubeletVersion"),
        "os_image": info.get("osImage"),
        "kernel_version": info.get("kernelVersion"),
        "container_runtime": info.get("containerRuntimeVersion"),
        "architecture": info.get("architecture"),
        "instance_type": labels.get("node.kubernetes.io/instance-type")
        or labels.get("beta.kubernetes.io/instance-type"),
        "zone": (labels.get("topology.kubernetes.io/zone")
                 or labels.get("failure-domain.beta.kubernetes.io/zone")),
        "internal_ip": next((a.get("address") for a in status.get("addresses") or []
                             if a.get("type") == "InternalIP"), None),
        "cpu_capacity": cores(cap.get("cpu")),
        "cpu_allocatable": cores(alloc.get("cpu")),
        "cpu_usage": None,
        "memory_capacity": qbytes(cap.get("memory")),
        "memory_allocatable": qbytes(alloc.get("memory")),
        "memory_usage": None,
        "ephemeral_storage_allocatable": qbytes(alloc.get("ephemeral-storage")),
        "pods_capacity": qint(alloc.get("pods") or cap.get("pods")),
        "pods_running": 0,
        "images_count": len(images),
        "images_bytes": sum(int(i.get("sizeBytes") or 0) for i in images),
        "taints": [{"key": t.get("key"), "effect": t.get("effect")} for t in spec.get("taints") or []],
        "created_at": m["created_at"],
    }


def parse_node_metrics(items: list) -> dict:
    """{node: {cpu_usage, memory_usage}}"""
    out = {}
    for it in items:
        usage = it.get("usage") or {}
        out[(it.get("metadata") or {}).get("name")] = {
            "cpu_usage": cores(usage.get("cpu")),
            "memory_usage": qbytes(usage.get("memory")),
        }
    return out


def parse_pod_metrics(items: list) -> dict:
    """{namespace: {cpu_usage, memory_usage}} summed over every container."""
    out = defaultdict(lambda: {"cpu_usage": 0.0, "memory_usage": 0})
    for it in items:
        ns = (it.get("metadata") or {}).get("namespace")
        for c in it.get("containers") or []:
            usage = c.get("usage") or {}
            out[ns]["cpu_usage"] += cores(usage.get("cpu")) or 0.0
            out[ns]["memory_usage"] += qbytes(usage.get("memory")) or 0
    for r in out.values():
        r["cpu_usage"] = round(r["cpu_usage"], 6)
    return dict(out)


# --------------------------------------------------------------------------- #
# namespaces
# --------------------------------------------------------------------------- #
def parse_namespace(ns: dict, manifest) -> dict:
    m = meta(ns, manifest)
    labels = m["labels"]
    ann = m["annotations"]
    own = manifest.ownership
    return {
        "name": m["name"],
        "ns_class": manifest.classify_namespace(m["name"], labels),
        "app_name": pick_label(labels, own.get("app", [])),      # filled from workloads / name later
        "team": pick_label(labels, own.get("team", [])),
        "tier": pick_label(labels, own.get("tier", [])),
        "labels": labels,
        "annotations": ann,
        "requester": ann.get("openshift.io/requester"),
        "display_name": ann.get("openshift.io/display-name"),
        "phase": (ns.get("status") or {}).get("phase"),
        "created_at": m["created_at"],
    }


# --------------------------------------------------------------------------- #
# pods -> namespace rollups + issues
# --------------------------------------------------------------------------- #
BAD_WAITING = {"CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "InvalidImageName",
               "CreateContainerConfigError", "CreateContainerError", "RunContainerError",
               "ErrImageNeverPull", "ContainerCannotRun"}


def _owner(pod: dict) -> tuple[str | None, str | None]:
    refs = (pod.get("metadata") or {}).get("ownerReferences") or []
    if not refs:
        return None, None
    kind, name = refs[0].get("kind"), refs[0].get("name")
    labels = (pod.get("metadata") or {}).get("labels") or {}
    if kind == "ReplicaSet" and labels.get("pod-template-hash") and name:
        # deployment-<hash> -> the Deployment; the hash is the label value
        suffix = "-" + labels["pod-template-hash"]
        if name.endswith(suffix):
            return "Deployment", name[: -len(suffix)]
    return kind, name


def pod_issue(pod: dict, manifest, now: datetime) -> dict | None:
    """Decide whether a pod is a current problem, and why."""
    status = pod.get("status") or {}
    phase = status.get("phase")
    statuses = status.get("containerStatuses") or []
    init_statuses = status.get("initContainerStatuses") or []
    restarts = sum(int(s.get("restartCount") or 0) for s in statuses + init_statuses)
    ready = sum(1 for s in statuses if s.get("ready"))
    total = len(statuses)
    conds = _conditions(pod)
    started = parse_time(status.get("startTime")) or parse_time(
        (pod.get("metadata") or {}).get("creationTimestamp"))
    age = (now - started).total_seconds() if started else 0

    reason = message = None
    if status.get("reason") == "Evicted":
        reason, message = "Evicted", status.get("message")
    elif phase == "Failed":
        reason = "Failed"
        message = status.get("message") or status.get("reason")
    elif phase == "Unknown":
        reason = "Unknown"
    else:
        for s in statuses + init_statuses:
            waiting = (s.get("state") or {}).get("waiting") or {}
            if waiting.get("reason") in BAD_WAITING:
                reason, message = waiting.get("reason"), waiting.get("message")
                break
            last = (s.get("lastState") or {}).get("terminated") or {}
            if last.get("reason") == "OOMKilled" and restarts > 0:
                reason, message = "OOMKilled", f"container {s.get('name')} was OOM-killed"
                break
        if not reason and phase == "Pending":
            sched = conds.get("PodScheduled") or {}
            if sched.get("status") == "False" and sched.get("reason") == "Unschedulable":
                reason, message = "Unschedulable", sched.get("message")
            elif age >= manifest.threshold("pod_pending_seconds"):
                reason, message = "Pending", f"pending for {int(age)}s"
        if not reason and restarts >= manifest.threshold("pod_restart_threshold"):
            reason, message = "HighRestarts", f"{restarts} restarts"
        if (not reason and phase == "Running" and total and ready < total
                and age >= manifest.threshold("pod_pending_seconds")):
            reason, message = "NotReady", f"{ready}/{total} containers ready"

    if not reason:
        return None
    owner_kind, owner_name = _owner(pod)
    m = pod.get("metadata") or {}
    return {
        "namespace": m.get("namespace"),
        "name": m.get("name"),
        "node": (pod.get("spec") or {}).get("nodeName"),
        "phase": phase,
        "reason": reason,
        "message": (message or "")[:500],
        "restarts": restarts,
        "owner_kind": owner_kind,
        "owner_name": owner_name,
        "containers_ready": f"{ready}/{total}",
        "started_at": started,
    }


def parse_pods(items: list, manifest, now: datetime | None = None) -> dict:
    """Roll pods up per namespace and per node, and extract problem pods."""
    now = now or datetime.now(UTC)
    ns_rollup: dict[str, dict] = defaultdict(lambda: {
        "pods_total": 0, "pods_running": 0, "pods_pending": 0, "pods_failed": 0,
        "pods_succeeded": 0, "restarts_total": 0, "pod_issues": 0,
        "cpu_requests": 0.0, "cpu_limits": 0.0, "memory_requests": 0, "memory_limits": 0,
        "images": set(),
    })
    node_pods: Counter = Counter()
    issues: list[dict] = []
    pvc_mounts: dict[tuple, list] = defaultdict(list)   # (ns, claim) -> [pod]
    for pod in items:
        m = pod.get("metadata") or {}
        ns = m.get("namespace")
        spec = pod.get("spec") or {}
        status = pod.get("status") or {}
        phase = status.get("phase") or "Unknown"
        r = ns_rollup[ns]
        r["pods_total"] += 1
        key = {"Running": "pods_running", "Pending": "pods_pending",
               "Failed": "pods_failed", "Succeeded": "pods_succeeded"}.get(phase)
        if key:
            r[key] += 1
        if phase == "Running" and spec.get("nodeName"):
            node_pods[spec["nodeName"]] += 1
        statuses = status.get("containerStatuses") or []
        r["restarts_total"] += sum(int(s.get("restartCount") or 0) for s in statuses)
        if phase in ("Running", "Pending"):
            for c in spec.get("containers") or []:
                res = c.get("resources") or {}
                r["cpu_requests"] += cores((res.get("requests") or {}).get("cpu")) or 0.0
                r["cpu_limits"] += cores((res.get("limits") or {}).get("cpu")) or 0.0
                r["memory_requests"] += qbytes((res.get("requests") or {}).get("memory")) or 0
                r["memory_limits"] += qbytes((res.get("limits") or {}).get("memory")) or 0
        for s in statuses:
            if s.get("image"):
                r["images"].add(s["image"])
        for v in spec.get("volumes") or []:
            claim = (v.get("persistentVolumeClaim") or {}).get("claimName")
            if claim:
                pvc_mounts[(ns, claim)].append(m.get("name"))
        issue = pod_issue(pod, manifest, now)
        if issue:
            issues.append(issue)
            r["pod_issues"] += 1
    for r in ns_rollup.values():
        r["images"] = sorted(r["images"])
        r["cpu_requests"] = round(r["cpu_requests"], 6)   # avoid float drift from summing millicores
        r["cpu_limits"] = round(r["cpu_limits"], 6)
    return {"namespaces": dict(ns_rollup), "node_pods": dict(node_pods),
            "issues": issues, "pvc_mounts": {k: sorted(v) for k, v in pvc_mounts.items()}}


# --------------------------------------------------------------------------- #
# workloads (Deployment / StatefulSet / DaemonSet)
# --------------------------------------------------------------------------- #
def _containers(pod_spec: dict) -> tuple[list[dict], list[str], list[dict]]:
    """Scrubbed container detail, images, and config references for a pod template."""
    containers, images, refs = [], [], []
    seen = set()

    def ref(kind, name, via):
        if name and (kind, name, via) not in seen:
            seen.add((kind, name, via))
            refs.append({"kind": kind, "name": name, "via": via})

    for c in (pod_spec.get("initContainers") or []) + (pod_spec.get("containers") or []):
        res = c.get("resources") or {}
        env = scrub.scrub_env(c.get("env"))
        env_from = scrub.scrub_env_from(c.get("envFrom"))
        for e in env:
            src = e.get("from") or {}
            if src.get("kind") in ("Secret", "ConfigMap"):
                ref(src["kind"], src.get("name"), "env")
        for e in env_from:
            ref(e["kind"], e.get("name"), "envFrom")
        image = c.get("image")
        if image:
            images.append(image)
        containers.append({
            "name": c.get("name"),
            "image": image,
            "env": env,
            "env_from": env_from,
            "requests": {k: v for k, v in (res.get("requests") or {}).items()},
            "limits": {k: v for k, v in (res.get("limits") or {}).items()},
            "ports": [p.get("containerPort") for p in c.get("ports") or []],
        })
    for v in pod_spec.get("volumes") or []:
        if v.get("secret"):
            ref("Secret", v["secret"].get("secretName"), "volume")
        elif v.get("configMap"):
            ref("ConfigMap", v["configMap"].get("name"), "volume")
        elif v.get("persistentVolumeClaim"):
            ref("PersistentVolumeClaim", v["persistentVolumeClaim"].get("claimName"), "volume")
        elif v.get("projected"):
            for s in v["projected"].get("sources") or []:
                if s.get("secret"):
                    ref("Secret", s["secret"].get("name"), "volume")
                elif s.get("configMap"):
                    ref("ConfigMap", s["configMap"].get("name"), "volume")
    for s in pod_spec.get("imagePullSecrets") or []:
        ref("Secret", s.get("name"), "imagePullSecret")
    if pod_spec.get("serviceAccountName"):
        ref("ServiceAccount", pod_spec["serviceAccountName"], "serviceAccount")
    return containers, images, refs


def parse_workload(obj: dict, kind: str, manifest) -> dict:
    m = meta(obj, manifest)
    spec = obj.get("spec") or {}
    status = obj.get("status") or {}
    pod_spec = ((spec.get("template") or {}).get("spec")) or {}
    containers, images, refs = _containers(pod_spec)
    conds = _conditions(obj)

    if kind == "DaemonSet":
        desired = int(status.get("desiredNumberScheduled") or 0)
        ready = int(status.get("numberReady") or 0)
        available = int(status.get("numberAvailable") or 0)
        updated = int(status.get("updatedNumberScheduled") or 0)
        strategy = (spec.get("updateStrategy") or {}).get("type")
    else:
        desired = int(spec.get("replicas") if spec.get("replicas") is not None else 1)
        ready = int(status.get("readyReplicas") or 0)
        available = int(status.get("availableReplicas") or 0)
        updated = int(status.get("updatedReplicas") or 0)
        strategy = ((spec.get("strategy") or spec.get("updateStrategy") or {}).get("type"))

    if desired == 0:
        wl_status = "healthy"
    elif ready == 0:
        wl_status = "degraded"
    elif ready < desired or updated < desired:
        wl_status = "progressing"
    else:
        wl_status = "healthy"
    if kind == "Deployment" and _cond_true(conds, "ReplicaFailure"):
        wl_status = "degraded"

    return {
        "namespace": m["namespace"],
        "kind": kind,
        "name": m["name"],
        "replicas_desired": desired,
        "replicas_ready": ready,
        "replicas_available": available,
        "replicas_updated": updated,
        "status": wl_status,
        "containers": containers,
        "images": sorted(set(images)),
        "config_refs": refs,
        "service_account": pod_spec.get("serviceAccountName") or "default",
        "node_selector": pod_spec.get("nodeSelector") or {},
        "strategy": strategy,
        "labels": m["labels"],
        "conditions": {t: (c.get("status") == "True") for t, c in conds.items()},
        "created_at": m["created_at"],
    }


# --------------------------------------------------------------------------- #
# generic resources -> {name, namespace, labels, status, expires_at, summary}
# --------------------------------------------------------------------------- #
def _generic(obj, manifest, summary: dict, status=None, expires_at=None) -> dict:
    m = meta(obj, manifest)
    if m["annotations"]:
        summary = {**summary, "annotations": m["annotations"]}
    return {"name": m["name"], "namespace": m["namespace"], "labels": m["labels"],
            "status": status, "expires_at": expires_at, "summary": summary,
            "created_at": m["created_at"]}


def parse_configmap(cm: dict, manifest) -> dict:
    keys, total = scrub.scrub_data(cm.get("data"), cm.get("binaryData"), b64=False)
    facts = scrub.cert_facts_from_data(cm.get("data"), b64=False)
    exp = scrub.earliest_expiry(facts)
    summary = {"keys": keys, "total_bytes": total, "key_count": len(keys)}
    if facts:
        summary["certificates"] = facts
    return _generic(cm, manifest, summary, status=_cert_status(exp, manifest), expires_at=exp)


def parse_secret(sec: dict, manifest) -> dict:
    keys, total = scrub.scrub_data(sec.get("data"), None, b64=True)
    stype = sec.get("type")
    facts = scrub.cert_facts_from_data(sec.get("data"), b64=True, secret_type=stype)
    exp = scrub.earliest_expiry(facts)
    summary = {"type": stype, "keys": keys, "total_bytes": total, "key_count": len(keys)}
    if facts:
        summary["certificates"] = facts
    return _generic(sec, manifest, summary, status=_cert_status(exp, manifest), expires_at=exp)


def _cert_status(exp: datetime | None, manifest, now: datetime | None = None) -> str | None:
    if exp is None:
        return None
    now = now or datetime.now(UTC)
    if exp <= now:
        return "expired"
    days = manifest.threshold("certificate_expiry_days")
    if (exp - now).total_seconds() <= days * 86400:
        return "expiring"
    return "valid"


def parse_service(svc: dict, manifest) -> dict:
    spec = svc.get("spec") or {}
    lb = ((svc.get("status") or {}).get("loadBalancer") or {}).get("ingress") or []
    return _generic(svc, manifest, {
        "type": spec.get("type"),
        "cluster_ip": spec.get("clusterIP"),
        "ports": [{"port": p.get("port"), "target": p.get("targetPort"),
                   "protocol": p.get("protocol"), "node_port": p.get("nodePort")}
                  for p in spec.get("ports") or []],
        "selector": spec.get("selector") or {},
        "load_balancer": [i.get("hostname") or i.get("ip") for i in lb],
    }, status=(spec.get("type") or "ClusterIP").lower())


def parse_route(route: dict, manifest) -> dict:
    spec = route.get("spec") or {}
    tls = spec.get("tls") or {}
    admitted = None
    routers = []
    for ing in (route.get("status") or {}).get("ingress") or []:
        routers.append(ing.get("routerName"))
        for c in ing.get("conditions") or []:
            if c.get("type") == "Admitted":
                admitted = c.get("status") == "True"
    return _generic(route, manifest, {
        "host": spec.get("host"),
        "path": spec.get("path"),
        "service": (spec.get("to") or {}).get("name"),
        "port": (spec.get("port") or {}).get("targetPort"),
        "tls_termination": tls.get("termination"),
        "insecure_policy": tls.get("insecureEdgeTerminationPolicy"),
        "wildcard_policy": spec.get("wildcardPolicy"),
        "admitted": admitted,
        "routers": [r for r in routers if r],
    }, status="admitted" if admitted else ("rejected" if admitted is False else "unknown"))


def parse_ingress(ing: dict, manifest) -> dict:
    spec = ing.get("spec") or {}
    return _generic(ing, manifest, {
        "class": spec.get("ingressClassName"),
        "hosts": [r.get("host") for r in spec.get("rules") or [] if r.get("host")],
        "tls_hosts": [h for t in spec.get("tls") or [] for h in t.get("hosts") or []],
        "load_balancer": [i.get("hostname") or i.get("ip") for i in
                          ((ing.get("status") or {}).get("loadBalancer") or {}).get("ingress") or []],
    })


def parse_networkpolicy(np: dict, manifest) -> dict:
    spec = np.get("spec") or {}
    return _generic(np, manifest, {
        "pod_selector": spec.get("podSelector") or {},
        "policy_types": spec.get("policyTypes") or [],
        "ingress_rules": len(spec.get("ingress") or []),
        "egress_rules": len(spec.get("egress") or []),
    })


def parse_pvc(pvc: dict, manifest, mounts: dict | None = None) -> dict:
    spec = pvc.get("spec") or {}
    status = pvc.get("status") or {}
    m = pvc.get("metadata") or {}
    mounted_by = (mounts or {}).get((m.get("namespace"), m.get("name")), [])
    phase = status.get("phase")
    return _generic(pvc, manifest, {
        "storage_class": spec.get("storageClassName"),
        "phase": phase,
        "access_modes": spec.get("accessModes") or [],
        "volume_mode": spec.get("volumeMode"),
        "volume": spec.get("volumeName"),
        "requested_bytes": qbytes(((spec.get("resources") or {}).get("requests") or {}).get("storage")),
        "capacity_bytes": qbytes((status.get("capacity") or {}).get("storage")),
        "mounted_by": mounted_by,
    }, status=(phase or "unknown").lower())


def parse_pv(pv: dict, manifest) -> dict:
    spec = pv.get("spec") or {}
    claim = spec.get("claimRef") or {}
    csi = spec.get("csi") or {}
    phase = (pv.get("status") or {}).get("phase")
    return _generic(pv, manifest, {
        "storage_class": spec.get("storageClassName"),
        "phase": phase,
        "capacity_bytes": qbytes((spec.get("capacity") or {}).get("storage")),
        "access_modes": spec.get("accessModes") or [],
        "reclaim_policy": spec.get("persistentVolumeReclaimPolicy"),
        "csi_driver": csi.get("driver"),
        "claim": f"{claim.get('namespace')}/{claim.get('name')}" if claim.get("name") else None,
    }, status=(phase or "unknown").lower())


def parse_storageclass(sc: dict, manifest) -> dict:
    ann = (sc.get("metadata") or {}).get("annotations") or {}
    return _generic(sc, manifest, {
        "provisioner": sc.get("provisioner"),
        "reclaim_policy": sc.get("reclaimPolicy"),
        "binding_mode": sc.get("volumeBindingMode"),
        "allow_expansion": bool(sc.get("allowVolumeExpansion")),
        "default": ann.get("storageclass.kubernetes.io/is-default-class") == "true",
    })


def parse_resourcequota(rq: dict, manifest) -> dict:
    status = rq.get("status") or {}
    hard = status.get("hard") or (rq.get("spec") or {}).get("hard") or {}
    used = status.get("used") or {}
    rows, worst = [], 0.0
    for res, h in sorted(hard.items()):
        hv = _quota_value(h)
        uv = _quota_value(used.get(res, "0"))
        pct = round(100.0 * uv / hv, 1) if hv else 0.0
        worst = max(worst, pct)
        rows.append({"resource": res, "hard": h, "used": used.get(res, "0"), "percent": pct})
    warn = manifest.threshold("quota_warning_percent")
    status_s = "exhausted" if worst >= 100 else ("warning" if worst >= warn else "ok")
    return _generic(rq, manifest, {"resources": rows, "max_percent": worst}, status=status_s)


def _quota_value(q) -> float:
    try:
        return float(parse_quantity(str(q)))
    except (ValueError, ArithmeticError):
        return 0.0


def parse_event(ev: dict, manifest) -> dict:
    inv = ev.get("involvedObject") or {}
    last = ev.get("lastTimestamp") or ((ev.get("series") or {}).get("lastObservedTime")) \
        or ev.get("eventTime") or ev.get("firstTimestamp")
    return _generic(ev, manifest, {
        "reason": ev.get("reason"),
        "message": (ev.get("message") or "")[:500],
        "type": ev.get("type"),
        "count": ev.get("count") or ((ev.get("series") or {}).get("count")) or 1,
        "involved": {"kind": inv.get("kind"), "name": inv.get("name"),
                     "namespace": inv.get("namespace")},
        "source": (ev.get("source") or {}).get("component") or ev.get("reportingComponent"),
        "first_at": ev.get("firstTimestamp") or ev.get("eventTime"),
        "last_at": last,
    }, status=(ev.get("reason") or "").lower() or None)


def parse_cronjob(cj: dict, manifest) -> dict:
    spec = cj.get("spec") or {}
    status = cj.get("status") or {}
    pod_spec = (((spec.get("jobTemplate") or {}).get("spec") or {}).get("template") or {}).get("spec") or {}
    _, images, _ = _containers(pod_spec)
    suspended = bool(spec.get("suspend"))
    return _generic(cj, manifest, {
        "schedule": spec.get("schedule"),
        "suspended": suspended,
        "concurrency_policy": spec.get("concurrencyPolicy"),
        "active": len(status.get("active") or []),
        "last_schedule": status.get("lastScheduleTime"),
        "last_successful": status.get("lastSuccessfulTime"),
        "images": sorted(set(images)),
    }, status="suspended" if suspended else "active")


def parse_hpa(hpa: dict, manifest) -> dict:
    spec = hpa.get("spec") or {}
    status = hpa.get("status") or {}
    conds = _conditions(hpa)
    target = spec.get("scaleTargetRef") or {}
    metrics = []
    for mt in spec.get("metrics") or []:
        res = mt.get("resource") or {}
        tgt = res.get("target") or {}
        if res:
            metrics.append({"resource": res.get("name"),
                            "target_percent": tgt.get("averageUtilization"),
                            "target_value": tgt.get("averageValue")})
    able = _cond_true(conds, "AbleToScale", default=True)
    return _generic(hpa, manifest, {
        "target": f"{target.get('kind')}/{target.get('name')}",
        "min_replicas": spec.get("minReplicas"),
        "max_replicas": spec.get("maxReplicas"),
        "current_replicas": status.get("currentReplicas"),
        "desired_replicas": status.get("desiredReplicas"),
        "metrics": metrics,
        "scaling_active": _cond_true(conds, "ScalingActive"),
        "scaling_limited": _cond_true(conds, "ScalingLimited"),
    }, status="ok" if able and _cond_true(conds, "ScalingActive") else "inactive")


def parse_csv(csv: dict, manifest) -> dict:
    spec = csv.get("spec") or {}
    status = csv.get("status") or {}
    labels = (csv.get("metadata") or {}).get("labels") or {}
    package = next((k.split("operators.coreos.com/", 1)[1].rsplit(".", 1)[0]
                    for k in labels if k.startswith("operators.coreos.com/")), None)
    phase = status.get("phase")
    return _generic(csv, manifest, {
        "package": package,
        "display_name": spec.get("displayName"),
        "version": spec.get("version"),
        "phase": phase,
        "reason": status.get("reason"),
        "message": (status.get("message") or "")[:300],
        "provider": (spec.get("provider") or {}).get("name"),
        "replaces": spec.get("replaces"),
    }, status=(phase or "unknown").lower())


def parse_subscription(sub: dict, manifest) -> dict:
    spec = sub.get("spec") or {}
    status = sub.get("status") or {}
    installed, current = status.get("installedCSV"), status.get("currentCSV")
    pending = bool(current and installed and current != installed)
    return _generic(sub, manifest, {
        "package": spec.get("name"),
        "channel": spec.get("channel"),
        "source": spec.get("source"),
        "approval": spec.get("installPlanApproval"),
        "installed_csv": installed,
        "current_csv": current,
        "state": status.get("state"),
        "upgrade_pending": pending,
    }, status="upgrade-pending" if pending else (status.get("state") or "unknown").lower())


def parse_mcp(mcp: dict, manifest) -> dict:
    status = mcp.get("status") or {}
    conds = _conditions(mcp)
    degraded = (_cond_true(conds, "Degraded") or _cond_true(conds, "NodeDegraded")
                or _cond_true(conds, "RenderDegraded"))
    updating = _cond_true(conds, "Updating")
    paused = bool((mcp.get("spec") or {}).get("paused"))
    st = "degraded" if degraded else "paused" if paused else "updating" if updating else \
        "updated" if _cond_true(conds, "Updated", default=True) else "unknown"
    return _generic(mcp, manifest, {
        "machine_count": status.get("machineCount") or 0,
        "ready": status.get("readyMachineCount") or 0,
        "updated": status.get("updatedMachineCount") or 0,
        "unavailable": status.get("unavailableMachineCount") or 0,
        "degraded": status.get("degradedMachineCount") or 0,
        "paused": paused,
        "current_config": (status.get("configuration") or {}).get("name"),
        "message": next((c.get("message") for t, c in conds.items()
                         if t in ("Degraded", "NodeDegraded", "Updating") and c.get("status") == "True"
                         and c.get("message")), ""),
    }, status=st)


def parse_clusterrolebinding(crb: dict, manifest) -> dict | None:
    role = (crb.get("roleRef") or {}).get("name")
    if role not in (manifest.threshold("cluster_admin_roles") or []):
        return None
    subjects = [{"kind": s.get("kind"), "name": s.get("name"), "namespace": s.get("namespace")}
                for s in crb.get("subjects") or []]
    return _generic(crb, manifest, {"role": role, "subjects": subjects}, status=role)
