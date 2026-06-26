#!/usr/bin/env python3
"""
fleet.py - provision and seed the local OpenShift-like fleet.

This stands up a multi-hub estate entirely on kind:

  * Each `hub` in topology.yaml becomes a kind cluster carrying the ACM
    ManagedCluster API. It holds one ManagedCluster per managed cluster plus a
    per-cluster kubeconfig secret (how a real ACM hub stores cluster access).

  * Each `managed` cluster becomes its own kind cluster carrying the OpenShift
    config API: a ClusterVersion, the standard ClusterOperators, an
    Infrastructure object, and sample application workloads.

Health is never seeded. The `profile` only sets the raw CR state; the data
layer computes health from that state exactly as it would on a real cluster.

Commands:
    python fleet.py up         # create + seed everything, export kubeconfigs
    python fleet.py down       # delete all kind clusters in the topology
    python fleet.py seed       # re-seed without recreating clusters
    python fleet.py kubeconfigs# (re)export internal kubeconfigs + hub config
    python fleet.py status     # show what exists
"""
import base64
import concurrent.futures
import json
import os
import subprocess
import sys
import uuid
from datetime import datetime, timedelta, timezone

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
CRDS = os.path.join(HERE, "crds")
KUBECONFIG_DIR = os.path.join(HERE, "kubeconfigs")
HUB_CONFIG_OUT = os.path.join(REPO, "data-layer", "config", "hubs.yaml")

NOW = datetime.now(timezone.utc)


def ts(delta_hours=0):
    return (NOW - timedelta(hours=delta_hours)).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_topology():
    with open(os.path.join(HERE, "topology.yaml")) as f:
        return yaml.safe_load(f)


# --------------------------------------------------------------------------- #
# shell helpers
# --------------------------------------------------------------------------- #
def sh(args, input_text=None, check=True, quiet=False):
    if not quiet:
        print(f"  $ {' '.join(args)}")
    res = subprocess.run(
        args, input=input_text, capture_output=True, text=True
    )
    if check and res.returncode != 0:
        sys.stderr.write(res.stdout)
        sys.stderr.write(res.stderr)
        raise RuntimeError(f"command failed ({res.returncode}): {' '.join(args)}")
    return res


def kctx(name):
    return f"kind-{name}"


def existing_clusters():
    res = sh(["kind", "get", "clusters"], check=False, quiet=True)
    return set(l.strip() for l in res.stdout.splitlines() if l.strip())


def all_cluster_names(topo):
    names = []
    for hub in topo["hubs"]:
        names.append(hub["name"])
        names.extend(m["name"] for m in hub["managed"])
    return names


# --------------------------------------------------------------------------- #
# cluster lifecycle
# --------------------------------------------------------------------------- #
def create_cluster(name):
    existing = existing_clusters()
    if name in existing:
        print(f"  = {name} already exists")
        return
    sh(["kind", "create", "cluster", "--name", name, "--wait", "90s"], quiet=True)
    print(f"  + created {name}")


def apply_manifests(context, objs):
    """Apply a list of manifest dicts in a single kubectl call."""
    doc = {"apiVersion": "v1", "kind": "List", "items": objs}
    sh(
        ["kubectl", "apply", "--context", context, "-f", "-"],
        input_text=json.dumps(doc),
        quiet=True,
    )


CRD_NAMES = [
    "clusterversions.config.openshift.io",
    "clusteroperators.config.openshift.io",
    "infrastructures.config.openshift.io",
    "managedclusters.cluster.open-cluster-management.io",
]


def apply_crd_files(context, files):
    for f in files:
        sh(["kubectl", "apply", "--context", context, "-f", f], quiet=True)
    # wait for the API server to register them before we seed CRs
    for crd in CRD_NAMES:
        sh(["kubectl", "--context", context, "wait", f"crd/{crd}",
            "--for=condition=Established", "--timeout=60s"],
           check=False, quiet=True)


# --------------------------------------------------------------------------- #
# operator / version modelling
# --------------------------------------------------------------------------- #
def condition(ctype, status, reason="AsExpected", message="", hours=2):
    return {
        "type": ctype,
        "status": status,
        "lastTransitionTime": ts(hours),
        "reason": reason,
        "message": message,
    }


def operator_state(op_name, critical, profile, version, upgrading_to, index):
    """Return (available, progressing, degraded, op_version, message) for an op."""
    available, progressing, degraded = "True", "False", "False"
    op_version = version
    msg = ""
    if profile == "degraded":
        # a couple of operators are broken; one is critical, one is not
        if op_name in ("ingress", "monitoring"):
            degraded = "True"
            available = "True" if op_name == "monitoring" else "False"
            msg = f"{op_name} controller is reporting errors reconciling its resources"
    elif profile == "warning":
        if op_name in ("node-tuning", "insights"):
            progressing = "True"
            msg = f"{op_name} is rolling out an update"
    elif profile == "progressing":
        # mid-upgrade: ~60% of operators already on the new version
        if (index % 5) < 3 and upgrading_to:
            op_version = upgrading_to
        else:
            progressing = "True"
            msg = "working towards desired release"
    return available, progressing, degraded, op_version, msg


def build_clusteroperators(topo, m):
    profile = m["profile"]
    version = m["version"]
    upgrading_to = m.get("upgrading_to")
    objs = []
    for i, op in enumerate(topo["operators"]):
        avail, prog, degr, opver, msg = operator_state(
            op["name"], op["critical"], profile, version, upgrading_to, i
        )
        objs.append({
            "apiVersion": "config.openshift.io/v1",
            "kind": "ClusterOperator",
            "metadata": {
                "name": op["name"],
                "labels": {"odl.io/critical": str(op["critical"]).lower()},
            },
            "spec": {},
            "status": {
                "versions": [{"name": "operator", "version": opver}],
                "conditions": [
                    condition("Available", avail,
                              "AsExpected" if avail == "True" else "Degraded",
                              msg if avail != "True" else ""),
                    condition("Progressing", prog,
                              "AsExpected" if prog == "False" else "Progressing",
                              msg if prog == "True" else ""),
                    condition("Degraded", degr,
                              "AsExpected" if degr == "False" else "Degraded",
                              msg if degr == "True" else ""),
                    condition("Upgradeable", "True"),
                ],
                "relatedObjects": [],
            },
        })
    return objs


def build_clusterversion(m):
    profile = m["profile"]
    version = m["version"]
    upgrading_to = m.get("upgrading_to")
    channel = m["channel"]

    progressing = profile == "progressing"
    degraded = profile == "degraded"
    desired_version = upgrading_to if (progressing and upgrading_to) else version
    cluster_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, m["name"]))

    history = []
    if progressing and upgrading_to:
        history.append({
            "state": "Partial", "version": upgrading_to,
            "startedTime": ts(1), "image": f"quay.io/openshift-release-dev/ocp-release:{upgrading_to}-x86_64",
            "verified": True,
        })
    history.append({
        "state": "Completed", "version": version,
        "startedTime": ts(720), "completionTime": ts(719),
        "image": f"quay.io/openshift-release-dev/ocp-release:{version}-x86_64",
        "verified": True,
    })

    # synthesise a couple of available updates for non-progressing clusters
    avail_updates = []
    major_minor = ".".join(version.split(".")[:2])
    patch = int(version.split(".")[2])
    if not progressing:
        for bump in (1, 2):
            avail_updates.append({
                "version": f"{major_minor}.{patch + bump}",
                "image": f"quay.io/openshift-release-dev/ocp-release:{major_minor}.{patch + bump}-x86_64",
            })

    conditions = [
        condition("Available", "False" if degraded and False else "True",
                  "AsExpected"),
        condition("Failing", "True" if degraded else "False",
                  "ClusterOperatorDegraded" if degraded else "AsExpected",
                  "Cluster operator ingress is degraded" if degraded else ""),
        condition("Progressing", "True" if progressing else "False",
                  "Working towards " + desired_version if progressing else "AsExpected",
                  f"Working towards {desired_version}: 63% complete" if progressing else ""),
        condition("RetrievedUpdates", "True"),
    ]

    return {
        "apiVersion": "config.openshift.io/v1",
        "kind": "ClusterVersion",
        "metadata": {"name": "version"},
        "spec": {
            "channel": channel,
            "clusterID": cluster_id,
            **({"desiredUpdate": {"version": desired_version}} if progressing else {}),
        },
        "status": {
            "desired": {
                "version": desired_version,
                "image": f"quay.io/openshift-release-dev/ocp-release:{desired_version}-x86_64",
                "channels": [channel],
            },
            "history": history,
            "observedGeneration": 2,
            "versionHash": base64.b64encode(cluster_id.encode()).decode()[:16],
            "capabilities": {},
            "availableUpdates": avail_updates or None,
            "conditions": conditions,
        },
    }


def build_infrastructure(m, cloud):
    region = m["region"]
    return {
        "apiVersion": "config.openshift.io/v1",
        "kind": "Infrastructure",
        "metadata": {"name": "cluster"},
        "spec": {"cloudConfig": {"name": ""}, "platformSpec": {"type": "AWS"}},
        "status": {
            "infrastructureName": f"{m['name']}-{str(uuid.uuid4())[:5]}",
            "platform": "AWS",
            "controlPlaneTopology": "HighlyAvailable",
            "infrastructureTopology": "HighlyAvailable",
            "apiServerURL": f"https://api.{m['name']}.{region}.example.com:6443",
            "platformStatus": {
                "type": "AWS",
                "aws": {"region": region},
            },
        },
    }


# --------------------------------------------------------------------------- #
# application placement
# --------------------------------------------------------------------------- #
def app_matches(app, m):
    sel = app.get("place_on", {})
    if "names" in sel and m["name"] in sel["names"]:
        return True
    if "environment" in sel and m["environment"] in sel["environment"]:
        return True
    if "region" in sel and m["region"] in sel["region"]:
        return True
    return False


def build_apps(topo, m):
    objs = []
    for app in topo["applications"]:
        if not app_matches(app, m):
            continue
        ns = app["namespace"]
        replicas = 3 if app["tier"] == "critical" else 2
        labels = {
            "odl.io/app": app["name"],
            "odl.io/team": app["team"],
            "odl.io/tier": app["tier"],
        }
        objs.append({
            "apiVersion": "v1", "kind": "Namespace",
            "metadata": {"name": ns, "labels": {"odl.io/managed": "true"}},
        })
        objs.append({
            "apiVersion": "apps/v1", "kind": "Deployment",
            "metadata": {"name": app["name"], "namespace": ns, "labels": labels},
            "spec": {
                "replicas": replicas,
                "selector": {"matchLabels": {"app": app["name"]}},
                "template": {
                    "metadata": {"labels": {"app": app["name"], **labels}},
                    "spec": {"containers": [{
                        "name": "app",
                        "image": "registry.k8s.io/pause:3.9",
                        "resources": {"requests": {"cpu": "1m", "memory": "8Mi"}},
                    }]},
                },
            },
        })
    return objs


# --------------------------------------------------------------------------- #
# seeding
# --------------------------------------------------------------------------- #
def seed_managed(topo, hub, m):
    ctx = kctx(m["name"])
    objs = []
    objs.append(build_clusterversion(m))
    objs.extend(build_clusteroperators(topo, m))
    objs.append(build_infrastructure(m, hub.get("cloud", "AWS")))
    apply_manifests(ctx, objs)
    # apps applied separately (namespaces must exist before deployments; a List
    # is applied in order, but splitting keeps failures isolated)
    apps = build_apps(topo, m)
    if apps:
        apply_manifests(ctx, apps)
    print(f"  seeded {m['name']} ({m['profile']}, {m['version']}, "
          f"{len([o for o in apps if o['kind']=='Deployment'])} apps)")


def managed_internal_kubeconfig(name):
    res = sh(["kind", "get", "kubeconfig", "--name", name, "--internal"], quiet=True)
    return res.stdout


def register_on_hub(hub, topo):
    ctx = kctx(hub["name"])
    objs = []
    for m in hub["managed"]:
        ns = m["name"]
        kubeconfig = managed_internal_kubeconfig(m["name"])
        # namespace per managed cluster (ACM convention)
        objs.append({
            "apiVersion": "v1", "kind": "Namespace",
            "metadata": {"name": ns},
        })
        # kubeconfig secret the collector uses to reach the managed cluster
        objs.append({
            "apiVersion": "v1", "kind": "Secret",
            "metadata": {"name": f"{ns}-kubeconfig", "namespace": ns,
                         "labels": {"odl.io/role": "cluster-kubeconfig"}},
            "type": "Opaque",
            "stringData": {"kubeconfig": kubeconfig},
        })
        # the ManagedCluster registration itself
        objs.append({
            "apiVersion": "cluster.open-cluster-management.io/v1",
            "kind": "ManagedCluster",
            "metadata": {
                "name": m["name"],
                "labels": {
                    "name": m["name"],
                    "cloud": hub.get("cloud", "AWS"),
                    "vendor": "OpenShift",
                    "region": m["region"],
                    "datacenter": m["datacenter"],
                    "environment": m["environment"],
                    "openshiftVersion": m["version"],
                },
            },
            "spec": {"hubAcceptsClient": True, "leaseDurationSeconds": 60},
            "status": {
                "conditions": [
                    condition("HubAcceptedManagedCluster", "True", "HubClusterAdminAccepted"),
                    condition("ManagedClusterJoined", "True", "ManagedClusterJoined"),
                    condition("ManagedClusterConditionAvailable", "True", "ManagedClusterAvailable"),
                ],
                "version": {"kubernetes": "v1.31.0"},
                "clusterClaims": [
                    {"name": "id.openshift.io", "value": str(uuid.uuid5(uuid.NAMESPACE_DNS, m["name"]))},
                    {"name": "version.openshift.io", "value": m["version"]},
                    {"name": "region.open-cluster-management.io", "value": m["region"]},
                    {"name": "platform.open-cluster-management.io", "value": "AWS"},
                    {"name": "product.open-cluster-management.io", "value": "OpenShift"},
                    {"name": "datacenter.odl.io", "value": m["datacenter"]},
                    {"name": "environment.odl.io", "value": m["environment"]},
                ],
            },
        })
    apply_manifests(ctx, objs)
    print(f"  registered {len(hub['managed'])} managed clusters on {hub['name']}")


# --------------------------------------------------------------------------- #
# kubeconfig export for the data layer
# --------------------------------------------------------------------------- #
def export_kubeconfigs(topo):
    os.makedirs(KUBECONFIG_DIR, exist_ok=True)
    os.makedirs(os.path.dirname(HUB_CONFIG_OUT), exist_ok=True)
    hubs_cfg = []
    for hub in topo["hubs"]:
        kc = sh(["kind", "get", "kubeconfig", "--name", hub["name"], "--internal"],
                quiet=True).stdout
        path = os.path.join(KUBECONFIG_DIR, f"{hub['name']}.kubeconfig")
        with open(path, "w") as f:
            f.write(kc)
        hubs_cfg.append({
            "name": hub["name"],
            "region": hub["region"],
            "datacenter": hub["datacenter"],
            # path as mounted inside the data-layer container
            "kubeconfig": f"/fleet/kubeconfigs/{hub['name']}.kubeconfig",
        })
    with open(HUB_CONFIG_OUT, "w") as f:
        yaml.safe_dump({"hubs": hubs_cfg}, f, sort_keys=False)
    print(f"  exported {len(hubs_cfg)} hub kubeconfigs -> {KUBECONFIG_DIR}")
    print(f"  wrote hub config -> {HUB_CONFIG_OUT}")


# --------------------------------------------------------------------------- #
# commands
# --------------------------------------------------------------------------- #
def cmd_up(topo):
    names = all_cluster_names(topo)
    print(f"==> creating {len(names)} kind clusters (parallel)")
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
        list(ex.map(create_cluster, names))

    print("==> installing CRDs")
    crd_files = [os.path.join(CRDS, f) for f in os.listdir(CRDS) if f.endswith(".yaml")]
    for hub in topo["hubs"]:
        apply_crd_files(kctx(hub["name"]), crd_files)
        for m in hub["managed"]:
            apply_crd_files(kctx(m["name"]), crd_files)

    print("==> seeding managed clusters")
    for hub in topo["hubs"]:
        for m in hub["managed"]:
            seed_managed(topo, hub, m)

    print("==> registering managed clusters on hubs")
    for hub in topo["hubs"]:
        register_on_hub(hub, topo)

    print("==> exporting kubeconfigs")
    export_kubeconfigs(topo)
    print("\nDone. Fleet is up.")


def cmd_down(topo):
    for name in all_cluster_names(topo):
        sh(["kind", "delete", "cluster", "--name", name], check=False, quiet=True)
        print(f"  - deleted {name}")


def cmd_seed(topo):
    for hub in topo["hubs"]:
        for m in hub["managed"]:
            seed_managed(topo, hub, m)
        register_on_hub(hub, topo)


def cmd_kubeconfigs(topo):
    export_kubeconfigs(topo)


def cmd_status(topo):
    existing = existing_clusters()
    for name in all_cluster_names(topo):
        mark = "up" if name in existing else "MISSING"
        print(f"  {mark:8} {name}")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "up"
    topo = load_topology()
    {
        "up": cmd_up, "down": cmd_down, "seed": cmd_seed,
        "kubeconfigs": cmd_kubeconfigs, "status": cmd_status,
    }.get(cmd, lambda _: sys.exit(f"unknown command: {cmd}"))(topo)


if __name__ == "__main__":
    main()
