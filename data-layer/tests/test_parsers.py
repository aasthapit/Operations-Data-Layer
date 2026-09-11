from datetime import UTC, datetime, timedelta

from app.collector import parsers

NOW = datetime(2026, 9, 10, 12, 0, tzinfo=UTC)


def _pod(name, ns, phase="Running", waiting=None, restarts=0, ready=True, age_s=3600,
         owner=("ReplicaSet", "api-7d9f8b"), hash_="7d9f8b", node="n1", cpu="100m", mem="128Mi",
         terminated=None, unschedulable=False, claim=None):
    started = (NOW - timedelta(seconds=age_s)).isoformat().replace("+00:00", "Z")
    state = {"waiting": {"reason": waiting, "message": f"back-off {waiting}"}} if waiting else {"running": {}}
    cs = {"name": "app", "image": "quay.io/acme/api:1.0", "imageID": "sha256:abc",
          "restartCount": restarts, "ready": ready, "state": state,
          "lastState": ({"terminated": {"reason": terminated}} if terminated else {})}
    conds = ([{"type": "PodScheduled", "status": "False", "reason": "Unschedulable",
               "message": "0/3 nodes available"}] if unschedulable else [])
    return {"metadata": {"name": name, "namespace": ns, "creationTimestamp": started,
                         "labels": {"pod-template-hash": hash_},
                         "ownerReferences": [{"kind": owner[0], "name": owner[1]}]},
            "spec": {"nodeName": node, "containers": [{"name": "app", "resources": {
                "requests": {"cpu": cpu, "memory": mem}, "limits": {"cpu": "500m", "memory": "256Mi"}}}],
                     "volumes": ([{"persistentVolumeClaim": {"claimName": claim}}] if claim else [])},
            "status": {"phase": phase, "startTime": started, "containerStatuses": [cs],
                       "conditions": conds}}


def test_pod_rollups_and_issues(manifest):
    pods = [
        _pod("api-1", "payments"),
        _pod("api-2", "payments", claim="api-data"),
        _pod("worker-1", "payments", waiting="CrashLoopBackOff", restarts=12,
             owner=("ReplicaSet", "worker-abc"), hash_="abc"),
        _pod("pull-1", "risk", phase="Pending", waiting="ImagePullBackOff", owner=("DaemonSet", "pull")),
        _pod("big-1", "analytics", phase="Pending", unschedulable=True, node=None, cpu="64"),
        _pod("job-1", "analytics", phase="Succeeded", owner=("Job", "nightly")),
        _pod("fresh-1", "risk", phase="Pending", age_s=30),                  # too young to flag
        _pod("oom-1", "risk", restarts=1, terminated="OOMKilled"),
        _pod("flap-1", "risk", restarts=7),
        _pod("notready-1", "risk", ready=False),
    ]
    out = parsers.parse_pods(pods, manifest, NOW)
    ns = out["namespaces"]
    assert ns["payments"]["pods_total"] == 3 and ns["payments"]["pods_running"] == 3
    assert ns["payments"]["restarts_total"] == 12
    assert ns["payments"]["cpu_requests"] == 0.3 and ns["payments"]["memory_requests"] == 3 * 128 * 1024 ** 2
    assert ns["payments"]["images"] == ["quay.io/acme/api:1.0"]
    assert ns["analytics"]["pods_succeeded"] == 1 and ns["analytics"]["pods_pending"] == 1
    assert out["node_pods"] == {"n1": 6}
    assert out["pvc_mounts"] == {("payments", "api-data"): ["api-2"]}
    reasons = {i["name"]: i["reason"] for i in out["issues"]}
    assert reasons == {"worker-1": "CrashLoopBackOff", "pull-1": "ImagePullBackOff",
                       "big-1": "Unschedulable", "oom-1": "OOMKilled", "flap-1": "HighRestarts",
                       "notready-1": "NotReady"}
    owners = {i["name"]: (i["owner_kind"], i["owner_name"]) for i in out["issues"]}
    assert owners["worker-1"] == ("Deployment", "worker")
    assert owners["pull-1"] == ("DaemonSet", "pull")
    assert ns["payments"]["pod_issues"] == 1 and ns["risk"]["pod_issues"] == 4


def test_node_and_metrics(manifest):
    node = {"metadata": {"name": "n1", "labels": {"node-role.kubernetes.io/control-plane": "",
                                                   "topology.kubernetes.io/zone": "us-east-1a",
                                                   "node.kubernetes.io/instance-type": "m6i.xlarge"}},
            "spec": {"unschedulable": True, "taints": [{"key": "k", "effect": "NoSchedule"}]},
            "status": {"capacity": {"cpu": "4", "memory": "16Gi", "pods": "110"},
                       "allocatable": {"cpu": "3500m", "memory": "15Gi", "pods": "110",
                                       "ephemeral-storage": "100Gi"},
                       "conditions": [{"type": "Ready", "status": "True"},
                                      {"type": "MemoryPressure", "status": "True"}],
                       "nodeInfo": {"kubeletVersion": "v1.31.0", "osImage": "RHCOS 9.4",
                                    "containerRuntimeVersion": "cri-o://1.31", "architecture": "amd64"},
                       "addresses": [{"type": "InternalIP", "address": "10.0.0.5"}],
                       "images": [{"names": ["a"], "sizeBytes": 100}, {"names": ["b"], "sizeBytes": 50}]}}
    n = parsers.parse_node(node, manifest)
    assert n["roles"] == ["control-plane"] and n["ready"] and not n["schedulable"]
    assert n["conditions"]["MemoryPressure"] is True and n["conditions"]["DiskPressure"] is False
    assert n["cpu_capacity"] == 4.0 and n["cpu_allocatable"] == 3.5
    assert n["memory_allocatable"] == 15 * 1024 ** 3 and n["pods_capacity"] == 110
    assert n["images_count"] == 2 and n["images_bytes"] == 150 and n["zone"] == "us-east-1a"
    usage = parsers.parse_node_metrics([{"metadata": {"name": "n1"},
                                         "usage": {"cpu": "1250m", "memory": "4Gi"}}])
    assert usage["n1"] == {"cpu_usage": 1.25, "memory_usage": 4 * 1024 ** 3}
    pm = parsers.parse_pod_metrics([
        {"metadata": {"namespace": "a"}, "containers": [{"usage": {"cpu": "100m", "memory": "10Mi"}},
                                                        {"usage": {"cpu": "50m", "memory": "5Mi"}}]},
        {"metadata": {"namespace": "a"}, "containers": [{"usage": {"cpu": "1", "memory": "1Mi"}}]}])
    assert round(pm["a"]["cpu_usage"], 3) == 1.15 and pm["a"]["memory_usage"] == 16 * 1024 ** 2


def test_split_image():
    assert parsers.split_image("quay.io/acme/api:1.2@sha256:abc") == {
        "image": "quay.io/acme/api:1.2@sha256:abc", "registry": "quay.io", "repository": "acme/api",
        "tag": "1.2", "digest": "sha256:abc"}
    assert parsers.split_image("nginx")["registry"] == "docker.io"
    assert parsers.split_image("localhost:5000/x/y:v1") == {
        "image": "localhost:5000/x/y:v1", "registry": "localhost:5000", "repository": "x/y",
        "tag": "v1", "digest": None}
    assert parsers.split_image("registry.k8s.io/pause:3.9")["repository"] == "pause"


def test_generic_parsers(manifest):
    rq = parsers.parse_resourcequota({
        "metadata": {"name": "q", "namespace": "payments"},
        "status": {"hard": {"pods": "10", "requests.cpu": "2"},
                   "used": {"pods": "9", "requests.cpu": "300m"}}},
        manifest)
    assert rq["status"] == "warning" and rq["summary"]["max_percent"] == 90.0
    route = parsers.parse_route({
        "metadata": {"name": "web", "namespace": "checkout"},
        "spec": {"host": "web.apps.example.com", "to": {"name": "web"}, "tls": {"termination": "edge"}},
        "status": {"ingress": [{"routerName": "default",
                                "conditions": [{"type": "Admitted", "status": "True"}]}]}}, manifest)
    assert route["status"] == "admitted" and route["summary"]["tls_termination"] == "edge"
    mcp = parsers.parse_mcp({
        "metadata": {"name": "worker"}, "spec": {},
        "status": {"machineCount": 3, "updatedMachineCount": 1, "readyMachineCount": 2,
                   "conditions": [{"type": "Updating", "status": "True", "message": "rolling"},
                                  {"type": "Degraded", "status": "False"}]}}, manifest)
    assert mcp["status"] == "updating" and mcp["summary"]["updated"] == 1
    csv = parsers.parse_csv({
        "metadata": {"name": "cert-manager.v1.14.4", "namespace": "openshift-operators",
                     "labels": {"operators.coreos.com/cert-manager.openshift-operators": ""}},
        "spec": {"version": "1.14.4", "displayName": "cert-manager"},
        "status": {"phase": "Succeeded"}}, manifest)
    assert csv["summary"]["package"] == "cert-manager" and csv["status"] == "succeeded"
    sub = parsers.parse_subscription({
        "metadata": {"name": "cert-manager", "namespace": "openshift-operators"},
        "spec": {"name": "cert-manager", "channel": "stable"},
        "status": {"installedCSV": "cert-manager.v1.14.4", "currentCSV": "cert-manager.v1.15.0",
                   "state": "UpgradePending"}}, manifest)
    assert sub["status"] == "upgrade-pending"
    crb = parsers.parse_clusterrolebinding({
        "metadata": {"name": "admins"}, "roleRef": {"name": "cluster-admin"},
        "subjects": [{"kind": "User", "name": "alice"}]}, manifest)
    assert crb["summary"]["subjects"] == [{"kind": "User", "name": "alice", "namespace": None}]
    assert parsers.parse_clusterrolebinding({"metadata": {"name": "x"}, "roleRef": {"name": "view"}},
                                            manifest) is None
    pvc = parsers.parse_pvc({"metadata": {"name": "data", "namespace": "payments"},
                             "spec": {"storageClassName": "gp3",
                                      "resources": {"requests": {"storage": "10Gi"}}},
                             "status": {"phase": "Pending"}}, manifest,
                            mounts={("payments", "data"): ["api-1"]})
    assert pvc["status"] == "pending" and pvc["summary"]["mounted_by"] == ["api-1"]
    assert pvc["summary"]["requested_bytes"] == 10 * 1024 ** 3


def test_clusterversion_and_platform_config():
    cv = parsers.parse_clusterversion({
        "spec": {"channel": "stable-4.16", "clusterID": "abc"},
        "status": {"desired": {"version": "4.16.7"},
                   "history": [{"state": "Partial", "version": "4.16.7"},
                               {"state": "Completed", "version": "4.15.18"}],
                   "availableUpdates": [{"version": "4.16.8"}],
                   "conditions": [{"type": "Progressing", "status": "True",
                                   "message": "Working towards 4.16.7: 63% complete"}]}})
    assert cv["version"] == "4.15.18" and cv["desired_version"] == "4.16.7"
    assert cv["upgrading"] and cv["upgrade_percent"] == 63 and cv["available_updates"] == ["4.16.8"]
    net = parsers.parse_network_config({"status": {"networkType": "OVNKubernetes",
                                                   "clusterNetwork": [{"cidr": "10.128.0.0/14"}],
                                                   "serviceNetwork": ["172.30.0.0/16"]}})
    assert net == {"network_type": "OVNKubernetes", "cluster_network": ["10.128.0.0/14"],
                   "service_network": ["172.30.0.0/16"]}
    infra = parsers.parse_infrastructure({"status": {"platform": "AWS", "apiServerURL": "https://api:6443",
                                                     "controlPlaneTopology": "HighlyAvailable",
                                                     "platformStatus": {"aws": {"region": "us-east-1"}}}})
    assert infra["infra_region"] == "us-east-1" and infra["api_url"] == "https://api:6443"
