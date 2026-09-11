# Operations insight catalog & data-sourcing strategy

> **Decision (September 2026): everything from the OCP API, scrubbed.**
> The data layer now reads *only* each cluster's API server - inventory, configuration, and utilization via `metrics.k8s.io` - and depends on no Prometheus, Thanos or external system.
> The rest of this document is the original analysis and is kept because its framing (state / metrics / events planes) still explains *why* each insight is shaped the way it is; where it recommends querying Thanos, the implemented answer is the metrics API served by the cluster itself.
> The current list of collected resources is the OCP API manifest ([ocp-api-manifest.md](ocp-api-manifest.md)); the "Have it today?" column below is superseded by the table at the end.

How to answer "what is the state of my multi-ACM estate, and what's going on when there are issues?"
This maps the kinds of questions a platform team asks to the data plane that actually holds the answer, how to get it, and whether our current data layer can.

## The core insight: there are three data planes, not one

Operational questions look similar but are answered by three structurally different sources.
Picking the wrong one is the most common and most expensive mistake.

| Plane | Answers | Source of truth | Shape | Right store |
|---|---|---|---|---|
| **State / inventory** | *what exists, how it's configured, what depends on what* | Kubernetes API (objects/CRs) | relational / graph | inventory DB, ACM Search |
| **Metrics / utilization** | *how much is being used, saturation, top-N, trends* | Prometheus → Thanos | time-series | Thanos / Prometheus |
| **Events / alerts** | *what changed, what's firing, what's wrong right now* | Kubernetes Events, Alertmanager/Thanos Ruler, audit, logs | event stream | Alertmanager, Loki |

The trap: actual **usage** ("highest CPU namespace") is *not* in the API objects.
The API holds resource **requests/limits** (configuration) and **capacity/allocatable** (declared), but real consumption is a metric.
You query Thanos for it, you do not poll the API for it.
Likewise, you do not copy raw metrics into a relational DB - Thanos already does that better.

## Grounding: what platform operators actually track

Real fleets (public or private cloud) track roughly twelve domains.
The first column tells you which plane it lives in.

| Domain | Plane | Examples |
|---|---|---|
| Inventory & topology | state | clusters, nodes, namespaces, workloads, images, operators, CRDs, routes |
| Version & config state | state | OCP/operator versions, image digests, channels, upgrade status, drift |
| Capacity & allocation | state | node allocatable, requests/limits, quotas, schedulable headroom |
| Resource utilization | **metrics** | real CPU/mem/disk/net by node/ns/pod, saturation, top-N |
| Health & availability | state + metrics + events | operator/node conditions, crashloops, restarts, readiness |
| Change & audit | events | what changed, who did it, recent deploys |
| Alerts & SLOs | events/metrics | firing alerts, error budgets, burn rate |
| Storage | state + metrics | PV/PVC/StorageClass/CSI graph, bound/pending, usage, backend health |
| Networking | state + metrics | routes, ingress, services, NetworkPolicies, egress, LB health |
| Security & compliance | state/events | RBAC, ACM policy compliance, image CVEs (ACS/Quay), cert expiry |
| Cost / chargeback | metrics + pricing | usage × price by namespace/team (OpenCost/Koku) |
| Dependencies / blast radius | state (graph) | storage→workload, operator→workload, app→cluster→team |

The metrics rows are the classic monitoring frameworks: Google's **Four Golden Signals** (latency, traffic, errors, **saturation**), Brendan Gregg's **USE** method (Utilization, Saturation, Errors) for resources, and **RED** (Rate, Errors, Duration) for services.
The state rows are inventory/CMDB territory.
"What's going on if there are issues" is almost always **events/alerts** correlated *back* to state and metrics for context.

## Worked catalog

For each question: the plane, the source of truth, how you'd actually answer it, and whether our collector can today.

| Question | Plane | Source & how | Have it today? |
|---|---|---|---|
| **What images are on this cluster?** | state | API: `node.status.images[]` (images cached per node, with sizeBytes) and `pod.status.containerStatuses[].imageID` (running digests). List and aggregate. | Partial - we connect & list, but only collect labelled Deployments. Extend to pods/nodes. Easy. ACM Search already indexes this. |
| **What is the capacity of these nodes?** | state (+metrics for usage) | API: `node.status.capacity` / `.allocatable` (cpu, memory, pods, ephemeral-storage). For *free/used*, Thanos (`node:node_cpu_utilisation`, node-exporter). | Capacity: easy extend (we already read nodes). Usage: **no** - needs metrics. |
| **Which namespaces/nodes have the highest CPU/memory?** | **metrics** | Thanos/PromQL: `topk(10, sum by (namespace)(container_cpu_usage_seconds_total rate))`, `container_memory_working_set_bytes`; nodes via node-exporter. Multi-ACM → global Thanos query. | **No, and the API is the wrong source.** Requires metrics integration. |
| **If storage provider X has a problem, what's the impact?** | state graph (+ events/metrics) | API graph: `StorageClass(provisioner=X)` → `PV(csi.driver / storageClassName)` → bound `PVC` → `Pod(volumes.pvc)` → workload → namespace → app/team. Overlay current alerts/CSI health for "actively affected". | This is blast-radius generalised to storage. Pattern: yes. Storage objects: not collected yet. Feasible via API. |
| Which pods are crashlooping / restarting? | state+events | API: `pod.status.containerStatuses[].restartCount` + reason; Events; `kube_pod_container_status_restarts_total`. | Extend inventory (pods) - easy. |
| What's firing right now across the fleet? | events | Alertmanager / Thanos Ruler aggregated across hubs. | No - needs alert integration. |
| Are any certs / tokens about to expire? | state | API/operators (`kube_certificate_*`, cert objects), ACM policies. | Extend; partly metrics. |
| Which clusters are out of compliance? | events/state | ACM **policy compliance** (per hub) → aggregate. | No - read ACM Policy CRs (we already talk to hubs). |
| Where is quota nearly exhausted? | state | API: `ResourceQuota.status used vs hard`. | Extend inventory - easy. |
| What does this cost by team? | metrics+pricing | OpenCost/Koku over Thanos usage × cloud pricing. | No - separate system. |

## At multi-ACM scale, where each plane lives

- **Metrics** → **per-hub Thanos.** ACM's multicluster-observability-operator (MCO) stands up Thanos + Grafana on each hub; every managed cluster's Prometheus **remote-writes (pushes)** its metrics to *that* hub's Thanos (via the Observatorium Operator) - it is not pulled from the kube-apiserver, and durable storage is user-configured S3-compatible object storage. This is the supported way to get **per-hub** fleet utilization - don't rebuild it. Note: observability is **per hub**; there is no native single PromQL surface across *multiple* hubs (an MCO object-store bucket can't even be shared across installs), so cross-hub metrics need extra federation.
- **State / inventory** → aggregate **ACM Search** (per-hub) or a relational inventory sync across hubs (what our collector does). Multicluster **Global Hub** is the productized hub-of-hubs: it moves managed-cluster inventory + policy-compliance off each hub over **Kafka** into **PostgreSQL** with **Grafana**. Caveats that matter: its scope is **policy compliance + cluster inventory** (not app utilization/business ownership), its dashboards are **daily-summarized, not real-time**, **observability is not available within Global Hub itself**, and it has been **fast-moving / Tech Preview** in recent releases - check your deployed ACM version.
- **Events / alerts** → Alertmanager (per hub) federated, plus events.
- **The join** → a thin correlation + query layer (and the **MCP/NL interface**) that references all three. *This* is the proposed unique, ownable value - though note (see Validation below) that no vendor reference architecture independently endorses it; it's our hypothesis, not received wisdom.

## Verdict: is "poll everything into one DB" the right way?

Per plane:

- **State/inventory/relationships - yes, a collected store is right.** The API is the source of truth, it's small and cheap to read (see the performance note), and relational/graph storage is what enables joins like blast radius. Use **watch/informers** at scale rather than polling. ACM Search is the native option; our collector is a fit-for-purpose custom version.
- **Metrics/utilization - no, do not poll the API or copy metrics.** Query **Thanos**. Storing raw time-series in Postgres is rebuilding Prometheus, badly. Reference metrics by query, cache only what you display.
- **Events/alerts - no, subscribe, don't poll.** Consume Alertmanager/events.

So "all data in one place" is best realised as **one query/insight layer over three federated sources**, not one database you scrape everything into.
The data layer's real job is: **own the inventory + relationships + business-ownership join, and be the correlation/query/agent front door** - delegating utilization to Thanos and alerts to Alertmanager by reference.

## What this means for our system

The current collector is a solid **state/inventory** plane for a few hubs. To serve the questions above it should evolve:

1. **Broaden inventory collection** (the cheap, high-value win): pods+images, node capacity/allocatable, StorageClass/PV/PVC/CSI, ResourceQuota, routes, ACM Policy compliance. All read-only API objects, same pattern we have.
2. **Integrate metrics by reference, not copy**: add a Thanos query client so "top CPU namespaces / capacity headroom" is answered by PromQL against (federated) Thanos, surfaced through the same API/MCP. Cache results briefly; never persist series.
3. **Add an alerts/events feed** for "what's going on right now," correlated to the inventory.
4. **Reposition the data layer** from "the database that has everything" to "the correlation + query + MCP layer" that joins inventory (ours/ACM Search/Global Hub) with metrics (Thanos) and alerts (Alertmanager), and adds the business-ownership dimension nothing else has.
5. **Switch inventory to watch/informers** before scaling past a handful of hubs.

The blast-radius POC stays valuable - it's the template for every dependency/impact question (storage, operator, version, node). It just becomes one query type among many on a broader inventory, correlated with live metrics and alerts.

## Validation (researched)

A multi-source, adversarially-verified research pass (25 claims voted, 0 refuted, mostly primary sources) **confirmed** the load-bearing claims:

- **Confirmed:** utilization is not in the Kubernetes API (only requests/limits + capacity/allocatable); real usage needs metrics-server (autoscaling-scoped, *explicitly not a monitoring source*) or Prometheus/cAdvisor/node-exporter.
- **Confirmed:** ACM metrics = MCO deploys Thanos+Grafana; managed clusters **remote-write** to the hub, not pulled from the apiserver.
- **Confirmed:** ACM observability / Search / Grafana are **per hub**; no native cross-hub single pane.
- **Confirmed:** Global Hub = hub-of-hubs via Kafka → PostgreSQL → Grafana, scoped to policy compliance + inventory, **daily-summarized**, with **no observability within it**.
- **Partially confirmed / our hypothesis:** the "federate the planes, don't single-DB-poll" conclusion is supported by the architecture, but the *business-ownership-join + MCP front door as the differentiator* is reasoned, not independently sourced - treat it as a hypothesis to prove, not settled fact.
- **Sourced but not separately voted here (treat as standard, not re-verified):** Golden Signals / USE / RED; the apiserver mitigations (resourceVersion=0, pagination, informers, APF); CMDB/ServiceNow/Backstage as the ownership source; OpenCost/Koku and ACS/Quay as the cost/vuln sources.

Key sources to read: Red Hat ACM Observability and Multicluster Global Hub docs (2.11-2.13); `stolostron/multicluster-observability-operator`; Kubernetes resource-metrics-pipeline and manage-resources-containers docs; Google SRE "Monitoring Distributed Systems"; Brendan Gregg's USE method; Kubernetes API Priority & Fairness (flow-control) docs and ahmet.im "Kubernetes API list performance".


## Status after the OCP-API-only decision

| Question | Answered from | Endpoint |
|---|---|---|
| What images are on this cluster / who runs image X? | pod status + workload specs | `/api/insights/images`, blast radius `image=` |
| What is the capacity of these nodes? Free / used? | `Node` capacity + allocatable, `metrics.k8s.io` NodeMetrics | `/api/clusters/{name}/nodes`, `/api/metrics/*` |
| Which namespaces / nodes have the highest CPU / memory? | `metrics.k8s.io` PodMetrics rolled up per namespace, NodeMetrics | `/api/metrics/top-namespaces`, `/top-nodes` |
| If storage provider X has a problem, what's the impact? | StorageClass → PVC (mounted-by from pod volumes) → workload → app | `/api/insights/storage`, `/references?kind=PersistentVolumeClaim` |
| Which pods are crashlooping / restarting / unschedulable? | pod status, per namespace class | `/api/insights/pod-issues` |
| What's going wrong right now? | Warning events (most recent N per cluster) | `/api/insights/events` |
| Are any certs about to expire? | TLS Secrets + PEM ConfigMap keys, parsed for facts only | `/api/insights/certificates` |
| Where is quota nearly exhausted? | `ResourceQuota` hard vs used | `/api/insights/quotas` |
| Which OLM operators, at which versions, are failing or have upgrades pending? | CSVs + Subscriptions | `/api/insights/olm-operators` |
| Is a node config rollout stuck? | MachineConfigPools | `/api/insights/machine-config-pools` |
| Which cluster serves this hostname? | Routes | `/api/insights/routes?host=` |
| Who depends on this secret / config map? | env / envFrom / volume references on workloads | `/api/insights/references` |
| Who is cluster-admin? | ClusterRoleBindings | `/api/insights/cluster-admins` |
| Which clusters are out of compliance (ACM policy)? | not yet - ACM `Policy` CRs on the hub are the next registry entry | - |
| What's firing (Alertmanager)? | out of scope by design - alerts are not in the OCP API | - |
| What does this cost by team? | out of scope - needs pricing | - |
