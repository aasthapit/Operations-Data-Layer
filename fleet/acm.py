#!/usr/bin/env python3
"""
acm.py - provision the real ACM/OCM test topology on kind.

Unlike the simulated fleet (fleet.py), which carries CRDs only, this stands up
real controllers so ACM-delivered pipeline execution can be tested end to end:

  * 2 hubs running Open Cluster Management (the upstream of RHACM) installed
    with clusteradm: cluster-manager, registration, work APIs.

  * 4 spokes (2 per hub) joined as real ManagedClusters with a running
    klusterlet, each also running Tekton Pipelines with a `pipelines`
    namespace enforcing the restricted Pod Security profile (the closest
    kind-level approximation of OpenShift's restricted SCC).

The smoke test drives the same path a production pipeline-controller would:
a ManifestWork on the hub delivers a PipelineRun to a spoke, Tekton executes
it for real, and status flows back to the hub via feedbackRules.

Version pins live in acm-topology.yaml. This script never touches the
simulated fleet's clusters, data-layer/config/hubs.yaml, or fleet.py.

Commands:
    python acm.py up           # create clusters, install OCM + Tekton, join spokes
    python acm.py down         # delete the acm-* clusters and their kubeconfigs
    python acm.py status       # show topology state
    python acm.py smoke        # ManifestWork -> PipelineRun end-to-end test
    python acm.py kubeconfigs  # (re)export internal kubeconfigs
"""
import concurrent.futures
import glob
import json
import os
import re
import shutil
import sys
import time

import yaml

from fleet import KUBECONFIG_DIR, existing_clusters, kctx, sh

HERE = os.path.dirname(os.path.abspath(__file__))

SMOKE_WORK_NAME = "smoke-pipelinerun"
PIPELINES_NS = "pipelines"


def load_topology():
    with open(os.path.join(HERE, "acm-topology.yaml")) as f:
        return yaml.safe_load(f)


def hub_names(topo):
    return [h["name"] for h in topo["hubs"]]


def spoke_names(topo):
    return [s for h in topo["hubs"] for s in h["spokes"]]


def all_names(topo):
    return hub_names(topo) + spoke_names(topo)


def kubectl(context, *args, **kw):
    return sh(["kubectl", "--context", context, *args], **kw)


# --------------------------------------------------------------------------- #
# prerequisites
# --------------------------------------------------------------------------- #
def check_prereqs(topo):
    missing = [t for t in ("docker", "kind", "kubectl", "clusteradm") if not shutil.which(t)]
    if missing:
        print(f"missing required tools: {', '.join(missing)}")
        if "clusteradm" in missing:
            pin = topo["versions"]["clusteradm"]
            print("install clusteradm (any one of):")
            print(f"  curl -L https://raw.githubusercontent.com/open-cluster-management-io/clusteradm/main/install.sh | bash -s -- {pin}")
            print(f"  go install open-cluster-management.io/clusteradm/cmd/clusteradm@{pin}")
            print(f"  download {pin} from https://github.com/open-cluster-management-io/clusteradm/releases")
        sys.exit(1)
    pin = topo["versions"]["clusteradm"]
    res = sh(["clusteradm", "version"], check=False, quiet=True)
    if pin.lstrip("v") not in (res.stdout + res.stderr):
        print(f"  ! clusteradm version differs from pin {pin} (continuing): {res.stdout.strip() or res.stderr.strip()}")


# --------------------------------------------------------------------------- #
# cluster lifecycle
# --------------------------------------------------------------------------- #
def create_cluster(name, image):
    if name in existing_clusters():
        print(f"  = {name} already exists")
        return
    # one retry: under memory/CPU contention a control plane can miss the
    # kubeadm boot deadline, and kind cleans up after a failed create
    for attempt in (1, 2):
        res = sh(["kind", "create", "cluster", "--name", name, "--image", image,
                  "--wait", "120s"], check=False, quiet=True)
        if res.returncode == 0:
            print(f"  + created {name}")
            return
        print(f"  ! create {name} failed (attempt {attempt})")
        sh(["kind", "delete", "cluster", "--name", name], check=False, quiet=True)
    sys.stderr.write(res.stdout + res.stderr)
    raise RuntimeError(f"could not create cluster {name} after 2 attempts")


# --------------------------------------------------------------------------- #
# OCM hub + spoke wiring
# --------------------------------------------------------------------------- #
def hub_external_api(hub):
    # host-reachable URL (https://127.0.0.1:<port>) for the clusteradm CLI;
    # the klusterlet itself flips to the docker-network endpoint via
    # --force-internal-endpoint-lookup, since <name>-control-plane only
    # resolves inside containers on the shared `kind` network.
    res = sh(["kubectl", "config", "view", "-o",
              f'jsonpath={{.clusters[?(@.name=="{kctx(hub)}")].cluster.server}}'],
             quiet=True)
    url = res.stdout.strip()
    if not url:
        raise RuntimeError(f"no kubeconfig server entry for {kctx(hub)}")
    return url


def init_hub(hub, bundle):
    ns = kubectl(kctx(hub), "get", "ns", "open-cluster-management-hub",
                 check=False, quiet=True)
    if ns.returncode == 0:
        print(f"  = {hub}: OCM hub already initialized")
        return
    sh(["clusteradm", "init", "--wait", "--context", kctx(hub),
        "--bundle-version", bundle], quiet=True)
    print(f"  + {hub}: OCM hub initialized")


def hub_token(hub):
    # `clusteradm get token` is deterministic on re-runs, unlike parsing the
    # one-shot output of `clusteradm init`.
    res = sh(["clusteradm", "get", "token", "--context", kctx(hub)], quiet=True)
    m = re.search(r"token=(\S+)", res.stdout) or re.search(r"--hub-token\s+(\S+)", res.stdout)
    if not m:
        raise RuntimeError(f"could not parse hub token for {hub}:\n{res.stdout}")
    return m.group(1)


def spoke_available(hub, spoke):
    res = kubectl(kctx(hub), "get", "managedcluster", spoke, "-o", "json",
                  check=False, quiet=True)
    if res.returncode != 0:
        return False
    mc = json.loads(res.stdout)
    return any(c.get("type") == "ManagedClusterConditionAvailable" and c.get("status") == "True"
               for c in mc.get("status", {}).get("conditions", []))


def join_spoke(hub, spoke, token, bundle):
    if spoke_available(hub, spoke):
        print(f"  = {spoke}: already joined to {hub}")
        return
    sh(["clusteradm", "join",
        "--hub-token", token,
        "--hub-apiserver", hub_external_api(hub),
        "--cluster-name", spoke,
        "--context", kctx(spoke),
        "--bundle-version", bundle,
        # make the klusterlet use the hub's in-cluster endpoint from
        # cluster-info (<hub>-control-plane:6443 on the `kind` network)
        # instead of the host-only 127.0.0.1 address we pass above
        "--force-internal-endpoint-lookup",
        "--wait"], quiet=True)
    print(f"  + {spoke}: klusterlet joined toward {hub}")


def accept_spokes(hub, spokes):
    pending = [s for s in spokes if not spoke_available(hub, s)]
    if pending:
        sh(["clusteradm", "accept", "--clusters", ",".join(pending),
            "--context", kctx(hub), "--wait"], quiet=True)
    for s in spokes:
        kubectl(kctx(hub), "wait", f"managedcluster/{s}",
                "--for=condition=ManagedClusterConditionAvailable=True",
                "--timeout=300s", quiet=True)
        print(f"  + {hub}: managed cluster {s} is Available")


def wire_hub(hub_def, bundle):
    hub = hub_def["name"]
    token = hub_token(hub)
    for spoke in hub_def["spokes"]:
        join_spoke(hub, spoke, token, bundle)
    accept_spokes(hub, hub_def["spokes"])


# --------------------------------------------------------------------------- #
# Tekton on the spokes
# --------------------------------------------------------------------------- #
def pipelines_ns_manifest():
    return {
        "apiVersion": "v1",
        "kind": "Namespace",
        "metadata": {
            "name": PIPELINES_NS,
            "labels": {
                "pod-security.kubernetes.io/enforce": "restricted",
                "pod-security.kubernetes.io/enforce-version": "latest",
            },
        },
    }


def install_tekton(spoke, release_url):
    ctx = kctx(spoke)
    kubectl(ctx, "apply", "-f", release_url, quiet=True)
    kubectl(ctx, "wait", "crd/pipelineruns.tekton.dev",
            "--for=condition=Established", "--timeout=120s", quiet=True)
    kubectl(ctx, "-n", "tekton-pipelines", "wait", "deploy",
            "--all", "--for=condition=Available", "--timeout=300s", quiet=True)
    # make Tekton's injected init containers comply with restricted PSA
    kubectl(ctx, "-n", "tekton-pipelines", "patch", "configmap", "feature-flags",
            "--type", "merge", "-p",
            json.dumps({"data": {"set-security-context": "true"}}), quiet=True)
    kubectl(ctx, "apply", "-f", "-",
            input_text=json.dumps(pipelines_ns_manifest()), quiet=True)
    print(f"  + {spoke}: Tekton ready, `{PIPELINES_NS}` namespace enforcing restricted PSA")


# --------------------------------------------------------------------------- #
# kubeconfigs
# --------------------------------------------------------------------------- #
def export_kubeconfigs(topo):
    os.makedirs(KUBECONFIG_DIR, exist_ok=True)
    for name in all_names(topo):
        res = sh(["kind", "get", "kubeconfig", "--name", name, "--internal"], quiet=True)
        # cluster names already carry the acm- prefix, so `down` can clean
        # them up with the acm-*.kubeconfig glob without touching sim-fleet files
        path = os.path.join(KUBECONFIG_DIR, f"{name}.kubeconfig")
        with open(path, "w") as f:
            f.write(res.stdout)
    # deliberately no hubs.yaml update: the data-layer collector must keep
    # ignoring these clusters.
    print(f"  + exported internal kubeconfigs to {KUBECONFIG_DIR}/acm-*.kubeconfig")


# --------------------------------------------------------------------------- #
# commands
# --------------------------------------------------------------------------- #
def cmd_up(topo):
    versions = topo["versions"]
    check_prereqs(topo)

    print("== creating kind clusters")
    # max_workers=3: six concurrent kind creates can trip Docker Desktop
    # inotify limits when the simulated fleet is also running.
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
        futs = [ex.submit(create_cluster, n, versions["kind_node_image"])
                for n in all_names(topo)]
        for f in futs:
            f.result()

    print("== installing OCM hubs and Tekton spokes")
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
        futs = [ex.submit(init_hub, h, versions["ocm_bundle"]) for h in hub_names(topo)]
        futs += [ex.submit(install_tekton, s, versions["tekton_release"])
                 for s in spoke_names(topo)]
        for f in futs:
            f.result()

    print("== joining spokes to hubs")
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
        futs = [ex.submit(wire_hub, h, versions["ocm_bundle"]) for h in topo["hubs"]]
        for f in futs:
            f.result()

    print("== exporting kubeconfigs")
    export_kubeconfigs(topo)

    print("\nACM test topology is up.")
    print("  hubs:   " + ", ".join(hub_names(topo)))
    print("  spokes: " + ", ".join(spoke_names(topo)))
    print("next: `make acm-smoke` runs the ManifestWork -> PipelineRun test")


def cmd_down(topo):
    for name in all_names(topo):
        if name in existing_clusters():
            sh(["kind", "delete", "cluster", "--name", name], check=False, quiet=True)
            print(f"  - deleted {name}")
    for path in glob.glob(os.path.join(KUBECONFIG_DIR, "acm-*.kubeconfig")):
        os.remove(path)
    print("ACM test topology deleted (simulated fleet untouched)")


def cmd_status(topo):
    existing = existing_clusters()
    for hub_def in topo["hubs"]:
        hub = hub_def["name"]
        if hub not in existing:
            print(f"{hub}: MISSING")
            continue
        print(f"{hub}: up")
        for spoke in hub_def["spokes"]:
            if spoke not in existing:
                print(f"  {spoke}: MISSING")
                continue
            avail = "Available" if spoke_available(hub, spoke) else "NOT available"
            tk = kubectl(kctx(spoke), "-n", "tekton-pipelines", "get",
                         "deploy", "tekton-pipelines-controller",
                         "-o", "jsonpath={.status.availableReplicas}",
                         check=False, quiet=True)
            tekton = "tekton ready" if tk.stdout.strip() not in ("", "0") else "tekton NOT ready"
            ns = kubectl(kctx(spoke), "get", "ns", PIPELINES_NS, "-o",
                         "jsonpath={.metadata.labels.pod-security\\.kubernetes\\.io/enforce}",
                         check=False, quiet=True)
            psa = "restricted" if ns.stdout.strip() == "restricted" else "PSA label MISSING"
            print(f"  {spoke}: up, {avail}, {tekton}, {psa}")


# --------------------------------------------------------------------------- #
# smoke test: hub-1 delivers a PipelineRun to spoke-1a
# --------------------------------------------------------------------------- #
def smoke_manifestwork(spoke, run_name, image):
    pipelinerun = {
        "apiVersion": "tekton.dev/v1",
        "kind": "PipelineRun",
        "metadata": {"name": run_name, "namespace": PIPELINES_NS},
        "spec": {
            "pipelineSpec": {
                "tasks": [{
                    "name": "echo",
                    "taskSpec": {
                        "steps": [{
                            "name": "echo",
                            "image": image,
                            # explicit restricted-PSA compliance, independent
                            # of Tekton's set-security-context flag
                            "securityContext": {
                                "runAsNonRoot": True,
                                "runAsUser": 65532,
                                "allowPrivilegeEscalation": False,
                                "capabilities": {"drop": ["ALL"]},
                                "seccompProfile": {"type": "RuntimeDefault"},
                            },
                            "script": "echo 'acm smoke ok'",
                        }],
                    },
                }],
            },
        },
    }
    return {
        "apiVersion": "work.open-cluster-management.io/v1",
        "kind": "ManifestWork",
        "metadata": {"name": SMOKE_WORK_NAME, "namespace": spoke},
        "spec": {
            "deleteOption": {
                "propagationPolicy": "SelectivelyOrphan",
                "selectivelyOrphans": {
                    # acm-up owns the pipelines namespace; deleting the work
                    # must not rip it out from under other runs
                    "orphaningRules": [
                        {"group": "", "resource": "namespaces", "name": PIPELINES_NS},
                    ],
                },
            },
            "workload": {"manifests": [pipelines_ns_manifest(), pipelinerun]},
            "manifestConfigs": [{
                "resourceIdentifier": {
                    "group": "tekton.dev",
                    "resource": "pipelineruns",
                    "namespace": PIPELINES_NS,
                    "name": run_name,
                },
                "feedbackRules": [{
                    "type": "JSONPaths",
                    "jsonPaths": [
                        {"name": "succeeded-status",
                         "path": '.status.conditions[?(@.type=="Succeeded")].status'},
                        {"name": "succeeded-reason",
                         "path": '.status.conditions[?(@.type=="Succeeded")].reason'},
                        # filter-free fallback in case the filtered path is
                        # rejected by the work API
                        {"name": "completion-time", "path": ".status.completionTime"},
                    ],
                }],
            }],
        },
    }


def feedback_values(hub, spoke):
    res = kubectl(kctx(hub), "-n", spoke, "get", "manifestwork", SMOKE_WORK_NAME,
                  "-o", "json", check=False, quiet=True)
    if res.returncode != 0:
        return {}
    work = json.loads(res.stdout)
    values = {}
    for manifest in work.get("status", {}).get("resourceStatus", {}).get("manifests", []):
        for v in manifest.get("statusFeedback", {}).get("values", []):
            values[v["name"]] = v.get("fieldValue", {})
    return values


def dump_failure(spoke, run_name):
    print("\n---- pipelinerun describe ----")
    res = kubectl(kctx(spoke), "-n", PIPELINES_NS, "describe", "pipelinerun",
                  run_name, check=False, quiet=True)
    print(res.stdout or res.stderr)
    print("---- pod logs ----")
    res = kubectl(kctx(spoke), "-n", PIPELINES_NS, "logs",
                  "-l", f"tekton.dev/pipelineRun={run_name}", "--all-containers",
                  "--tail=50", check=False, quiet=True)
    print(res.stdout or res.stderr)


def cmd_smoke(topo):
    hub_def = topo["hubs"][0]
    hub, spoke = hub_def["name"], hub_def["spokes"][0]
    image = topo["versions"]["smoke_image"]

    existing = existing_clusters()
    if hub not in existing or spoke not in existing:
        print(f"smoke needs {hub} and {spoke} up; run `make acm-up` first")
        sys.exit(1)
    if not spoke_available(hub, spoke):
        print(f"{spoke} is not Available on {hub}; run `make acm-up` first")
        sys.exit(1)

    print(f"== smoke: {hub} delivers a PipelineRun to {spoke} via ManifestWork")
    kubectl(kctx(hub), "-n", spoke, "delete", "manifestwork", SMOKE_WORK_NAME,
            "--ignore-not-found", "--wait=true", quiet=True)

    run_name = f"smoke-{int(time.time())}"
    work = smoke_manifestwork(spoke, run_name, image)
    kubectl(kctx(hub), "apply", "-f", "-", input_text=json.dumps(work), quiet=True)
    print(f"  + applied manifestwork/{SMOKE_WORK_NAME} (pipelinerun {run_name})")

    kubectl(kctx(hub), "-n", spoke, "wait", f"manifestwork/{SMOKE_WORK_NAME}",
            "--for=condition=Applied", "--timeout=120s", quiet=True)
    print("  + manifestwork Applied on the hub")

    res = kubectl(kctx(spoke), "-n", PIPELINES_NS, "wait", f"pipelinerun/{run_name}",
                  "--for=condition=Succeeded", "--timeout=300s",
                  check=False, quiet=True)
    if res.returncode != 0:
        print(f"FAIL: pipelinerun {run_name} did not succeed on {spoke}")
        dump_failure(spoke, run_name)
        sys.exit(1)
    print(f"  + pipelinerun {run_name} Succeeded on {spoke}")

    deadline = time.time() + 180
    values = {}
    while time.time() < deadline:
        values = feedback_values(hub, spoke)
        if values.get("succeeded-status", {}).get("string") == "True":
            print("  + hub feedback: succeeded-status=True "
                  f"(reason={values.get('succeeded-reason', {}).get('string')}, "
                  f"completed={values.get('completion-time', {}).get('string')})")
            print("\nsmoke test PASSED")
            return
        time.sleep(5)
    print("FAIL: hub never reported succeeded-status=True via feedbackRules")
    print(f"  last feedback values: {json.dumps(values)}")
    sys.exit(1)


def main():
    cmds = {
        "up": cmd_up,
        "down": cmd_down,
        "status": cmd_status,
        "smoke": cmd_smoke,
        "kubeconfigs": export_kubeconfigs,
    }
    if len(sys.argv) != 2 or sys.argv[1] not in cmds:
        print(__doc__)
        sys.exit(1)
    cmds[sys.argv[1]](load_topology())


if __name__ == "__main__":
    main()
