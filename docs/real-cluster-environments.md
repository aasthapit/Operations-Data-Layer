# Real cluster environments - what to request from the platform org

The local tooling covers daily development, but only real OpenShift proves the product layers.
This doc defines the validation environments worth asking for, the options for providing them, the resource math, and a ready-to-send request template.

## Where real clusters sit in the test pyramid

| Tier | Environment | What it proves | Cost per cycle |
|---|---|---|---|
| 1 | Simulated fleet (`make fleet-up`) | data-layer logic against OpenShift/ACM CR shapes | seconds |
| 2 | ACM test topology (`make acm-up`) | orchestration end to end: ManifestWork delivery, real Tekton execution, status feedback | minutes |
| 3 | Real OpenShift + RHACM | SCCs, Routes, OAuth, RHACM proper, OpenShift Pipelines operator, real upgrades | hours to days |

Tier 3 is a fidelity checkpoint, not a daily environment.
Use it before releases and whenever tier 2 behavior could plausibly diverge from the product (operator defaults, RHACM-only APIs, SCC-sensitive workloads).

The ideal tier 3 shape mirrors the test topology: 2 RHACM hubs, each managing 2 spoke clusters.
A single hub with 2 spokes is an acceptable minimum, since multi-hub logic gets daily coverage in tier 2.

## Options, best first

### 1. Hosted Control Planes (HyperShift) - preferred

Control planes run as pods in namespaces on one management cluster; only worker capacity is dedicated per cluster.
This is by far the cheapest way to get many real OCP clusters, and creation/deletion is minutes, so environments can be ephemeral.

Ask for: HCP enabled on a management cluster, quota for 6 hosted clusters, and self-service `HostedCluster` creation rights (or a pipeline that stamps them).
Note: RHACM hubs themselves are supported as hosted clusters; confirm the platform team's supported worker platform (KubeVirt, agent, or cloud).

### 2. ClusterPool via Hive/ACM

An existing RHACM/Hive hub keeps a pool of pre-provisioned clusters on cloud credentials; you claim one, use it, and release it.
Great fit for CI and release checkpoints; requires the org to fund the cloud footprint.

Ask for: a `ClusterPool` sized 2-3, claim rights, and a documented claim/release flow.

### 3. Single Node OpenShift (SNO) on VMs or bare metal

Six SNO instances give the full topology with full isolation.
Highest fidelity for edge-like estates, but the heaviest footprint and the slowest to rebuild.

### 4. OpenShift Local (CRC) - listed for completeness

One instance per workstation, single cluster, cannot form the multi-cluster topology.
Useful as a personal RHACM hub sandbox (with kind spokes imported), not as a shared validation environment.

## Resource math

Baseline sizing for the full 2 hubs + 4 spokes topology built from SNO-class clusters:

| Role | Count | vCPU each | RAM each | Disk each |
|---|---|---|---|---|
| RHACM hub (SNO, base OCP + RHACM ~16 GB overhead) | 2 | 8-12 | 32 GB | 150 GB |
| Spoke (SNO, base + OpenShift Pipelines) | 4 | 8 | 16 GB | 120 GB |

Totals: roughly 48-64 vCPU, 100-130 GB RAM, ~800 GB-1 TB disk per environment.
With Hosted Control Planes the totals drop sharply, since control planes share the management cluster: budget the management cluster plus worker capacity per hosted cluster (2-3 nodes worth for hubs, 1-2 for spokes).

## Subscriptions and access

- A pull secret from console.redhat.com (per installing identity or a shared org secret).
- OpenShift subscriptions or 60-day evaluations for each cluster.
- RHACM entitlement for the hub clusters.
- Network reachability: hubs must reach spoke API servers (import) and the requesting team needs `kubeconfig`/OAuth access to all clusters.

## Request template

Fill in and send to the platform org:

```text
Subject: OpenShift validation environment for ACM pipeline testing

Purpose: end-to-end validation of the patching orchestration, which creates
ManifestWorks on ACM hubs to run Tekton pipelines on managed clusters.
Daily development happens on a local kind/OCM topology; this environment is
the pre-release fidelity checkpoint (RHACM proper, OpenShift Pipelines
operator, SCC behavior).

Requested option: Hosted Control Planes preferred; ClusterPool acceptable.

Topology: 2 RHACM hubs, each managing 2 spoke clusters.
Minimum viable: 1 hub, 2 spokes.

Sizing: [insert row(s) from the resource table above]

Software: OCP <version>, RHACM <version>, OpenShift Pipelines <version>.

Access: cluster-admin on all 6 (or scoped roles: RHACM admin on hubs,
namespace admin + Pipelines on spokes), pull secret, kubeconfigs.

Duration: [ephemeral per release cycle | standing with monthly rebuild]

Owner / cost center: [team, contact]
```
