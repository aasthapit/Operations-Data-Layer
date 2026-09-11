#!/usr/bin/env python3
"""
fleet.py - provision and seed the local OpenShift-like fleet.

This stands up a multi-hub estate entirely on kind:

  * Each `hub` in topology.yaml becomes a kind cluster carrying the ACM
    ManagedCluster API. It holds one ManagedCluster per managed cluster plus a
    per-cluster kubeconfig secret (how a real ACM hub stores cluster access).

  * Each `managed` cluster becomes its own kind cluster carrying the OpenShift
    config API (ClusterVersion, ClusterOperators, Infrastructure, Network,
    Ingress config, MachineConfigPools), OLM operators (CSVs + Subscriptions),
    OpenShift-style platform namespaces with pods, application namespaces
    with the full workload footprint the data layer reads (Deployments with
    env references, Services, Routes, ConfigMaps, Secrets with *real* TLS
    certificates at varied expiry, ResourceQuotas, NetworkPolicies, PVCs,
    HPAs, CronJobs), and metrics-server so metrics.k8s.io is served like on
    OpenShift.

Health is never seeded. The `profile` only sets the raw state; the data layer
computes health from that state exactly as it would on a real cluster:

    healthy      everything settled
    warning      a non-critical operator progressing, an image-pull failure in a
                 platform namespace, a failed OLM install, app certs expiring soon,
                 a quota near its limit
    degraded     ClusterOperators Degraded, a degraded MachineConfigPool, a
                 crashlooping platform pod and app pod, an expired cert, an
                 exhausted quota
    progressing  ClusterVersion + MachineConfigPool mid-rollout, an OLM upgrade
                 pending, an unschedulable pod
    eol          a version past the supported floor, a paused MCP, the router
                 cert expiring soon

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
ADDONS = os.path.join(HERE, "addons")
KUBECONFIG_DIR = os.path.join(HERE, "kubeconfigs")
HUB_CONFIG_OUT = os.path.join(REPO, "data-layer", "config", "hubs.yaml")

NOW = datetime.now(timezone.utc)
PAUSE = "registry.k8s.io/pause:3.9"
MISSING_IMAGE = "registry.example.com/platform/image-registry:4.16.7"   # never resolves


def ts(delta_hours=0):
    return (NOW - timedelta(hours=delta_hours)).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_topology():
    with open(os.path.join(HERE, "topology.yaml")) as f:
        topo = yaml.safe_load(f)
    # FLEET_CLUSTERS=hub-east,ocp-east-1,... limits every command to a subset
    # (a hub is included when named; a managed cluster needs its hub named too).
    # Useful on laptops with a small Docker disk / memory allocation.
    only = {n.strip() for n in os.environ.get("FLEET_CLUSTERS", "").split(",") if n.strip()}
    if only:
        topo["hubs"] = [
            {**hub, "managed": [m for m in hub["managed"] if m["name"] in only]}
            for hub in topo["hubs"] if hub["name"] in only
        ]
        if not topo["hubs"]:
            sys.exit(f"FLEET_CLUSTERS={','.join(sorted(only))} matches no hub in topology.yaml")
    return topo


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
    return set(line.strip() for line in res.stdout.splitlines() if line.strip())


def all_cluster_names(topo):
    names = []
    for hub in topo["hubs"]:
        names.append(hub["name"])
        names.extend(m["name"] for m in hub["managed"])
    return names


# --------------------------------------------------------------------------- #
# cluster lifecycle
# --------------------------------------------------------------------------- #
def create_cluster(name, attempts=2):
    existing = existing_clusters()
    if name in existing:
        print(f"  = {name} already exists")
        return
    # kind leaves nothing behind when creation fails, so a retry is safe. Under
    # memory pressure (several clusters booting at once) kubeadm can time out.
    for attempt in range(1, attempts + 1):
        res = sh(["kind", "create", "cluster", "--name", name, "--wait", "120s"],
                 check=False, quiet=True)
        if res.returncode == 0:
            print(f"  + created {name}")
            return
        sys.stderr.write(res.stderr[-2000:])
        if attempt < attempts:
            print(f"  ! creating {name} failed (attempt {attempt}), retrying")
    raise RuntimeError(f"could not create kind cluster {name}")


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
    "networks.config.openshift.io",
    "ingresses.config.openshift.io",
    "routes.route.openshift.io",
    "machineconfigpools.machineconfiguration.openshift.io",
    "clusterserviceversions.operators.coreos.com",
    "subscriptions.operators.coreos.com",
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


def apply_addons(context):
    """metrics-server, so metrics.k8s.io is served like OpenShift's prometheus-adapter."""
    for f in sorted(os.listdir(ADDONS)):
        if f.endswith(".yaml"):
            sh(["kubectl", "apply", "--context", context, "-f", os.path.join(ADDONS, f)], quiet=True)


# --------------------------------------------------------------------------- #
# certificates (real, self-signed; the data layer only ever sees their facts)
# --------------------------------------------------------------------------- #
def make_cert(cn, days, ca=False, sans=()):
    """Return (cert_pem, key_pem). `days` may be negative for an expired cert."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn),
                         x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Example Corp")])
    issuer = subject if ca else x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "Example Corp Issuing CA"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Example Corp")])
    b = (x509.CertificateBuilder()
         .subject_name(subject).issuer_name(issuer).public_key(key.public_key())
         .serial_number(x509.random_serial_number())
         .not_valid_before(NOW - timedelta(days=365))
         .not_valid_after(NOW + timedelta(days=days))
         .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True))
    if sans:
        b = b.add_extension(x509.SubjectAlternativeName([x509.DNSName(s) for s in sans]), critical=False)
    cert = b.sign(key, hashes.SHA256())
    return (cert.public_bytes(serialization.Encoding.PEM).decode(),
            key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                              serialization.NoEncryption()).decode())


def tls_secret(name, ns, cn, days, labels=None):
    crt, key = make_cert(cn, days, sans=(cn,))
    return {"apiVersion": "v1", "kind": "Secret", "type": "kubernetes.io/tls",
            "metadata": {"name": name, "namespace": ns, "labels": labels or {}},
            "stringData": {"tls.crt": crt, "tls.key": key}}


# --------------------------------------------------------------------------- #
# cluster-scoped platform state
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
            "startedTime": ts(1),
            "image": f"quay.io/openshift-release-dev/ocp-release:{upgrading_to}-x86_64",
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
        condition("Available", "True", "AsExpected"),
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


def apps_domain(m):
    return f"apps.{m['name']}.{m['region']}.example.com"


def build_infrastructure(m, cloud):
    region = m["region"]
    return {
        "apiVersion": "config.openshift.io/v1",
        "kind": "Infrastructure",
        "metadata": {"name": "cluster"},
        "spec": {"cloudConfig": {"name": ""}, "platformSpec": {"type": "AWS"}},
        "status": {
            "infrastructureName": f"{m['name']}-{str(uuid.uuid5(uuid.NAMESPACE_DNS, m['name'] + '-infra'))[:5]}",
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


def build_network_and_ingress_config(m):
    return [
        {"apiVersion": "config.openshift.io/v1", "kind": "Network",
         "metadata": {"name": "cluster"},
         "spec": {"networkType": "OVNKubernetes",
                  "clusterNetwork": [{"cidr": "10.128.0.0/14", "hostPrefix": 23}],
                  "serviceNetwork": ["172.30.0.0/16"]},
         "status": {"networkType": "OVNKubernetes",
                    "clusterNetwork": [{"cidr": "10.128.0.0/14", "hostPrefix": 23}],
                    "serviceNetwork": ["172.30.0.0/16"], "clusterNetworkMTU": 8901}},
        {"apiVersion": "config.openshift.io/v1", "kind": "Ingress",
         "metadata": {"name": "cluster"},
         "spec": {"domain": apps_domain(m)}, "status": {}},
    ]


def build_machineconfigpools(m):
    """master + worker pools; the worker pool carries the profile's rollout state."""
    profile = m["profile"]
    rendered = f"rendered-worker-{str(uuid.uuid5(uuid.NAMESPACE_DNS, m['name'] + m['version']))[:12]}"

    def pool(name, count, updated, ready, degraded, unavailable, conds, paused=False):
        return {
            "apiVersion": "machineconfiguration.openshift.io/v1", "kind": "MachineConfigPool",
            "metadata": {"name": name, "labels": {f"pools.operator.machineconfiguration.openshift.io/{name}": ""}},
            "spec": {"paused": paused, "configuration": {"name": rendered.replace("worker", name)}},
            "status": {
                "machineCount": count, "updatedMachineCount": updated, "readyMachineCount": ready,
                "degradedMachineCount": degraded, "unavailableMachineCount": unavailable,
                "configuration": {"name": rendered.replace("worker", name)},
                "conditions": conds,
            },
        }

    settled = [condition("Updated", "True", "", f"All nodes are updated with {rendered}"),
               condition("Updating", "False"), condition("Degraded", "False"),
               condition("NodeDegraded", "False"), condition("RenderDegraded", "False")]
    pools = [pool("master", 3, 3, 3, 0, 0, settled)]
    if profile == "progressing":
        pools.append(pool("worker", 3, 1, 2, 0, 1, [
            condition("Updated", "False"),
            condition("Updating", "True", "", f"All nodes are updating to {rendered}"),
            condition("Degraded", "False"), condition("NodeDegraded", "False"),
            condition("RenderDegraded", "False")]))
    elif profile == "degraded":
        pools.append(pool("worker", 3, 2, 2, 1, 1, [
            condition("Updated", "False"), condition("Updating", "False"),
            condition("Degraded", "True", "", "Node ip-10-0-143-7 is reporting: unexpected on-disk state"),
            condition("NodeDegraded", "True", "", "1 nodes are reporting degraded status on sync"),
            condition("RenderDegraded", "False")]))
    elif profile == "eol":
        pools.append(pool("worker", 3, 3, 3, 0, 0, settled, paused=True))
    else:
        pools.append(pool("worker", 3, 3, 3, 0, 0, settled))
    return pools


def build_storage_and_rbac(m):
    return [
        {"apiVersion": "storage.k8s.io/v1", "kind": "StorageClass",
         "metadata": {"name": "gp3-csi"}, "provisioner": "ebs.csi.aws.com",
         "parameters": {"type": "gp3"}, "reclaimPolicy": "Delete",
         "volumeBindingMode": "WaitForFirstConsumer", "allowVolumeExpansion": True},
        {"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "ClusterRoleBinding",
         "metadata": {"name": "platform-admins"},
         "roleRef": {"apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": "cluster-admin"},
         "subjects": [{"apiGroup": "rbac.authorization.k8s.io", "kind": "Group", "name": "platform-admins"},
                      {"apiGroup": "rbac.authorization.k8s.io", "kind": "User", "name": "ops-oncall@example.com"}]
                     + ([{"apiGroup": "rbac.authorization.k8s.io", "kind": "User", "name": "dev-lead@example.com"}]
                        if m["environment"] == "dev" else [])},
    ]


# --------------------------------------------------------------------------- #
# platform namespaces (OpenShift's own) with pods, config and OLM operators
# --------------------------------------------------------------------------- #
PLATFORM_NAMESPACES = {
    "openshift-monitoring": {"openshift.io/cluster-monitoring": "true"},
    "openshift-ingress": {"openshift.io/cluster-monitoring": "true"},
    "openshift-dns": {"openshift.io/run-level": "0"},
    "openshift-image-registry": {},
    "openshift-operators": {},
    "openshift-config": {},
}


def deployment(name, ns, replicas, labels, image=PAUSE, command=None, env=None, env_from=None,
               volumes=None, mounts=None, requests=None, limits=None, sa=None):
    container = {
        "name": "app", "image": image,
        "resources": {"requests": requests or {"cpu": "100m", "memory": "128Mi"},
                      "limits": limits or {"cpu": "500m", "memory": "256Mi"}},
    }
    if command:
        container["command"] = command
    if env:
        container["env"] = env
    if env_from:
        container["envFrom"] = env_from
    if mounts:
        container["volumeMounts"] = mounts
    spec = {"containers": [container]}
    if volumes:
        spec["volumes"] = volumes
    if sa:
        spec["serviceAccountName"] = sa
    return {
        "apiVersion": "apps/v1", "kind": "Deployment",
        "metadata": {"name": name, "namespace": ns, "labels": labels},
        "spec": {
            "replicas": replicas,
            "selector": {"matchLabels": {"app": name}},
            "template": {"metadata": {"labels": {"app": name, **labels}}, "spec": spec},
        },
    }


def build_platform_namespaces(topo, m, index):
    profile = m["profile"]
    objs = []
    for ns, labels in PLATFORM_NAMESPACES.items():
        objs.append({"apiVersion": "v1", "kind": "Namespace",
                     "metadata": {"name": ns, "labels": {"kubernetes.io/metadata.name": ns, **labels},
                                  "annotations": {"openshift.io/sa.scc.mcs": "s0:c25,c10"}}})
    plat = {"app.kubernetes.io/managed-by": "cluster-version-operator"}

    # monitoring: alertmanager crashloops on the degraded profile
    objs.append(deployment("prometheus-k8s", "openshift-monitoring", 2, {**plat, "app.kubernetes.io/name": "prometheus"}))
    objs.append(deployment("alertmanager-main", "openshift-monitoring", 2,
                           {**plat, "app.kubernetes.io/name": "alertmanager"},
                           command=["/nonexistent-alertmanager"] if profile == "degraded" else None))
    # ingress router + its serving cert (expiring soon on the eol profile)
    objs.append(deployment("router-default", "openshift-ingress", 2, {**plat, "ingresscontroller.operator.openshift.io/deployment-ingresscontroller": "default"}))
    objs.append(tls_secret("router-certs-default", "openshift-ingress", f"*.{apps_domain(m)}",
                           12 if profile == "eol" else 300))
    # dns as a DaemonSet
    objs.append({
        "apiVersion": "apps/v1", "kind": "DaemonSet",
        "metadata": {"name": "dns-default", "namespace": "openshift-dns", "labels": plat},
        "spec": {"selector": {"matchLabels": {"app": "dns-default"}},
                 "template": {"metadata": {"labels": {"app": "dns-default", **plat}},
                              "spec": {"tolerations": [{"operator": "Exists"}],
                                       "containers": [{"name": "dns", "image": PAUSE,
                                                       "resources": {"requests": {"cpu": "50m", "memory": "64Mi"}}}]}}},
    })
    # image registry: pull failure on the warning profile
    objs.append(deployment("image-registry", "openshift-image-registry", 1, plat,
                           image=MISSING_IMAGE if profile == "warning" else PAUSE))
    # cluster config: the API serving CA bundle (a ConfigMap carrying a cert)
    ca_crt, _ = make_cert("kube-apiserver-serving-ca", 730, ca=True)
    objs.append({"apiVersion": "v1", "kind": "ConfigMap",
                 "metadata": {"name": "kube-apiserver-server-ca", "namespace": "openshift-config"},
                 "data": {"ca-bundle.crt": ca_crt}})
    objs.append({"apiVersion": "v1", "kind": "Secret", "type": "Opaque",
                 "metadata": {"name": "pull-secret", "namespace": "openshift-config"},
                 "stringData": {".dockerconfigjson": json.dumps({"auths": {"quay.io": {"auth": "c2VjcmV0"}}})}})
    # OLM: CSVs + Subscriptions in openshift-operators
    for i, op in enumerate(topo.get("olm_operators", [])):
        version = op["version"] if index % 2 == 0 else op.get("alt_version", op["version"])
        failed = profile == "warning" and op["package"] == "elasticsearch-operator"
        csv_name = f"{op['package']}.v{version}"
        objs.append({
            "apiVersion": "operators.coreos.com/v1alpha1", "kind": "ClusterServiceVersion",
            "metadata": {"name": csv_name, "namespace": "openshift-operators",
                         "labels": {f"operators.coreos.com/{op['package']}.openshift-operators": ""}},
            "spec": {"displayName": op["display"], "version": version,
                     "provider": {"name": op["provider"]}, "install": {"strategy": "deployment"}},
            "status": {"phase": "Failed" if failed else "Succeeded",
                       "reason": "InstallCheckFailed" if failed else "InstallSucceeded",
                       "message": ("install failed: deployment elasticsearch-operator not ready"
                                   if failed else "install strategy completed with no errors"),
                       "lastUpdateTime": ts(3)},
        })
        next_version = op.get("next_version")
        pending = profile == "progressing" and next_version
        objs.append({
            "apiVersion": "operators.coreos.com/v1alpha1", "kind": "Subscription",
            "metadata": {"name": op["package"], "namespace": "openshift-operators"},
            "spec": {"name": op["package"], "channel": op["channel"], "source": "redhat-operators",
                     "sourceNamespace": "openshift-marketplace", "installPlanApproval": "Manual"},
            "status": {"installedCSV": csv_name,
                       "currentCSV": f"{op['package']}.v{next_version}" if pending else csv_name,
                       "state": "UpgradePending" if pending else "AtLatestKnown"},
        })
    return objs


# --------------------------------------------------------------------------- #
# application namespaces
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
    profile = m["profile"]
    domain = apps_domain(m)
    objs = []
    for app in topo["applications"]:
        if not app_matches(app, m):
            continue
        ns = app["namespace"]
        name = app["name"]
        critical = app["tier"] == "critical"
        replicas = 3 if critical else 2
        labels = {"odl.io/app": name, "odl.io/team": app["team"], "odl.io/tier": app["tier"]}

        objs.append({
            "apiVersion": "v1", "kind": "Namespace",
            "metadata": {"name": ns,
                         "labels": {"odl.io/managed": "true", **labels},
                         "annotations": {"openshift.io/requester": f"{app['team']}-deployer",
                                         "openshift.io/display-name": name.replace("-", " ").title(),
                                         "openshift.io/description": f"{name} owned by {app['team']}"}},
        })
        # config the workload references (values are what the data layer must never keep)
        objs.append({"apiVersion": "v1", "kind": "ConfigMap",
                     "metadata": {"name": f"{name}-config", "namespace": ns, "labels": labels},
                     "data": {"application.yaml": f"server:\n  port: 8080\nlogging:\n  level: info\napp: {name}\n",
                              "feature-flags": "new-checkout=true\nbeta-search=false\n"}})
        ca_crt, _ = make_cert(f"{app['team']}-internal-ca", 900, ca=True)
        objs.append({"apiVersion": "v1", "kind": "ConfigMap",
                     "metadata": {"name": f"{name}-ca-bundle", "namespace": ns, "labels": labels},
                     "data": {"ca-bundle.crt": ca_crt}})
        objs.append({"apiVersion": "v1", "kind": "Secret", "type": "Opaque",
                     "metadata": {"name": f"{name}-credentials", "namespace": ns, "labels": labels},
                     "stringData": {"username": f"{name}-svc", "password": f"s3cr3t-{uuid.uuid4().hex[:12]}",
                                    "url": f"postgres://{name}-svc:s3cr3t@db.{ns}.svc:5432/{name}"}})
        # TLS cert: expired for checkout on the degraded cluster, expiring soon on the warning cluster
        days = 300
        if profile == "degraded" and name == "checkout-web":
            days = -3
        elif profile == "warning":
            days = 20
        objs.append(tls_secret(f"{name}-tls", ns, f"{name}.{domain}", days, labels))

        volumes = [{"name": "tls", "secret": {"secretName": f"{name}-tls"}},
                   {"name": "config", "configMap": {"name": f"{name}-config"}}]
        mounts = [{"name": "tls", "mountPath": "/etc/tls", "readOnly": True},
                  {"name": "config", "mountPath": "/etc/app", "readOnly": True}]
        if critical:
            objs.append({"apiVersion": "v1", "kind": "PersistentVolumeClaim",
                         "metadata": {"name": f"{name}-data", "namespace": ns, "labels": labels},
                         "spec": {"accessModes": ["ReadWriteOnce"], "resources": {"requests": {"storage": "1Gi"}},
                                  "storageClassName": "standard"}})
            volumes.append({"name": "data", "persistentVolumeClaim": {"claimName": f"{name}-data"}})
            mounts.append({"name": "data", "mountPath": "/var/lib/app"})
        objs.append(deployment(
            name, ns, replicas, labels,
            env=[{"name": "LOG_LEVEL", "value": "info"},
                 {"name": "DATABASE_URL", "valueFrom": {"secretKeyRef": {"name": f"{name}-credentials", "key": "url"}}},
                 {"name": "DATABASE_PASSWORD", "valueFrom": {"secretKeyRef": {"name": f"{name}-credentials", "key": "password"}}},
                 {"name": "FEATURE_FLAGS", "valueFrom": {"configMapKeyRef": {"name": f"{name}-config", "key": "feature-flags"}}},
                 {"name": "POD_NAME", "valueFrom": {"fieldRef": {"fieldPath": "metadata.name"}}}],
            env_from=[{"configMapRef": {"name": f"{name}-config"}}],
            volumes=volumes, mounts=mounts))
        objs.append({"apiVersion": "v1", "kind": "Service",
                     "metadata": {"name": name, "namespace": ns, "labels": labels},
                     "spec": {"selector": {"app": name}, "ports": [{"name": "http", "port": 8080, "targetPort": 8080}]}})
        objs.append({"apiVersion": "route.openshift.io/v1", "kind": "Route",
                     "metadata": {"name": name, "namespace": ns, "labels": labels},
                     "spec": {"host": f"{name}.{domain}", "to": {"kind": "Service", "name": name},
                              "port": {"targetPort": "http"},
                              "tls": {"termination": "edge", "insecureEdgeTerminationPolicy": "Redirect"},
                              "wildcardPolicy": "None"},
                     "status": {"ingress": [{"host": f"{name}.{domain}", "routerName": "default",
                                             "conditions": [condition("Admitted", "True", "", "")]}]}})
        if critical:
            # quota: exhausted for payments on the degraded cluster, near the limit for checkout on warning
            hard = {"pods": "10", "requests.cpu": "2", "requests.memory": "4Gi", "limits.cpu": "6"}
            if profile == "degraded" and name == "payments-api":
                hard["pods"] = "3"
            if profile == "warning" and name == "checkout-web":
                hard["requests.cpu"] = "320m"
            objs.append({"apiVersion": "v1", "kind": "ResourceQuota",
                         "metadata": {"name": f"{ns}-quota", "namespace": ns, "labels": labels},
                         "spec": {"hard": hard}})
            objs.append({"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
                         "metadata": {"name": "default-deny-ingress", "namespace": ns, "labels": labels},
                         "spec": {"podSelector": {}, "policyTypes": ["Ingress"],
                                  "ingress": [{"from": [{"namespaceSelector": {"matchLabels": {
                                      "network.openshift.io/policy-group": "ingress"}}}]}]}})
        if name == "checkout-web":
            objs.append({"apiVersion": "autoscaling/v2", "kind": "HorizontalPodAutoscaler",
                         "metadata": {"name": name, "namespace": ns, "labels": labels},
                         "spec": {"scaleTargetRef": {"apiVersion": "apps/v1", "kind": "Deployment", "name": name},
                                  "minReplicas": replicas, "maxReplicas": 6,
                                  "metrics": [{"type": "Resource", "resource": {
                                      "name": "cpu", "target": {"type": "Utilization", "averageUtilization": 70}}}]}})
        if app["team"] == "data":
            objs.append({"apiVersion": "batch/v1", "kind": "CronJob",
                         "metadata": {"name": f"{name}-nightly", "namespace": ns, "labels": labels},
                         "spec": {"schedule": "0 2 * * *", "suspend": True, "concurrencyPolicy": "Forbid",
                                  "jobTemplate": {"spec": {"template": {"spec": {
                                      "restartPolicy": "Never",
                                      "containers": [{"name": "job", "image": PAUSE}]}}}}}})
        # profile-driven application problems
        if name == "analytics-pipeline":
            if profile == "progressing":
                objs.append(deployment(f"{name}-backfill", ns, 1, labels,
                                       requests={"cpu": "64", "memory": "256Mi"},
                                       limits={"cpu": "64", "memory": "512Mi"}))   # unschedulable
            objs.append({"apiVersion": "v1", "kind": "PersistentVolumeClaim",
                         "metadata": {"name": f"{name}-scratch", "namespace": ns, "labels": labels},
                         "spec": {"accessModes": ["ReadWriteOnce"], "resources": {"requests": {"storage": "5Gi"}},
                                  "storageClassName": "standard"}})     # never mounted -> Pending
        if name == "fraud-detection" and profile == "degraded":
            objs.append(deployment(f"{name}-scorer", ns, 1, labels, command=["/nonexistent-scorer"]))
    return objs


# --------------------------------------------------------------------------- #
# seeding
# --------------------------------------------------------------------------- #
def seed_managed(topo, hub, m, index):
    ctx = kctx(m["name"])
    cluster_objs = [build_clusterversion(m)]
    cluster_objs.extend(build_clusteroperators(topo, m))
    cluster_objs.append(build_infrastructure(m, hub.get("cloud", "AWS")))
    cluster_objs.extend(build_network_and_ingress_config(m))
    cluster_objs.extend(build_machineconfigpools(m))
    cluster_objs.extend(build_storage_and_rbac(m))
    apply_manifests(ctx, cluster_objs)

    platform = build_platform_namespaces(topo, m, index)
    apps = build_apps(topo, m)
    # namespaces first, then everything that lives in them
    namespaced = platform + apps
    apply_manifests(ctx, [o for o in namespaced if o["kind"] == "Namespace"])
    apply_manifests(ctx, [o for o in namespaced if o["kind"] != "Namespace"])
    n_apps = len([o for o in apps if o["kind"] == "Namespace"])
    print(f"  seeded {m['name']} ({m['profile']}, {m['version']}, {n_apps} apps, "
          f"{len(cluster_objs) + len(namespaced)} objects)")


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
def managed_with_index(topo):
    i = 0
    for hub in topo["hubs"]:
        for m in hub["managed"]:
            yield hub, m, i
            i += 1


def cmd_up(topo):
    names = all_cluster_names(topo)
    print(f"==> creating {len(names)} kind clusters (parallel)")
    workers = int(os.environ.get("FLEET_PARALLEL", "3"))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        list(ex.map(create_cluster, names))

    print("==> installing CRDs + addons")
    crd_files = [os.path.join(CRDS, f) for f in os.listdir(CRDS) if f.endswith(".yaml")]
    for hub in topo["hubs"]:
        apply_crd_files(kctx(hub["name"]), crd_files)
        for m in hub["managed"]:
            apply_crd_files(kctx(m["name"]), crd_files)
            apply_addons(kctx(m["name"]))

    print("==> seeding managed clusters")
    for hub, m, i in managed_with_index(topo):
        seed_managed(topo, hub, m, i)

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
    crd_files = [os.path.join(CRDS, f) for f in os.listdir(CRDS) if f.endswith(".yaml")]
    for hub, m, i in managed_with_index(topo):
        apply_crd_files(kctx(m["name"]), crd_files)
        apply_addons(kctx(m["name"]))
        seed_managed(topo, hub, m, i)
    for hub in topo["hubs"]:
        apply_crd_files(kctx(hub["name"]), crd_files)
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
