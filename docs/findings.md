# Notable findings

Facts learned while building and measuring the data layer that shape what it should do next.
Each finding says where it came from so it can be re-checked.
Decisions that followed from them live in [`docs/adr/`](adr/).

## 1. What only the OCP API can tell us

The product reads everything from each cluster's API server.
That is the right baseline, but it is only the *necessary* source for about half of the catalog: the other half is also in Prometheus (through kube-state-metrics and OpenShift's own metrics), often with history the API lacks.
The half that is API-only is the configuration content and the relationships between objects, which is exactly what the blast-radius and dependency questions need.

### Only reachable through the API server

| What the data layer holds | Why metrics and logs cannot supply it |
|---|---|
| Config references: which workload mounts which Secret, ConfigMap, PVC or ServiceAccount, and via what (env, envFrom, volume, imagePullSecret) | kube-state-metrics (KSM) exports pod to PVC edges but nothing about Secret or ConfigMap consumption. This is the "rotate this secret, who breaks" graph. |
| Certificate facts inside Secrets and ConfigMaps (subject, issuer, SANs, expiry) for application-owned TLS | KSM never reads secret data. Only cert-manager-managed certificates and a few platform certificates get an expiry metric. |
| Secret and ConfigMap key names, byte sizes and types; container env var names and their `valueFrom` sources | Not exported anywhere, and never written to logs by design. |
| Ownership: team, tier and app labels, `openshift.io/requester`, display names | KSM exports labels and annotations only for an explicit allow-list, which OpenShift's monitoring stack does not enable. |
| NetworkPolicy rules; Route and Ingress spec beyond host and termination | KSM exports rule counts only; openshift-state-metrics exports route host, termination and admission, not the rest. |
| ClusterRoleBinding subjects (who holds cluster-admin) | Newer KSM can export binding to role, never subjects, and it is not enabled on OpenShift by default. |
| Infrastructure, Network and Ingress config: platform, topology, network type, CIDRs, apps domain | A few platform-type gauges exist; the values do not. |
| Operator, MachineConfigPool and pod condition messages; the available-updates list | Metrics carry `reason` labels and counts, not message text or version lists. |
| Node image cache (count and bytes) | Not in KSM. Relevant to CVE and disk questions. |
| Kubernetes Events with their messages | Not metrics; they reach a log store only where an event exporter is installed. |
| What each cluster can answer (collected, forbidden, unavailable per resource) | A property of the API call itself. |

### Available from both

Versions and operator conditions, node info and pressure, pod phases and restart reasons, replica counts, quota used versus hard, PV and PVC status and storage class, images per container, HPAs, CronJobs, OLM CSV phases and Subscriptions, route admission.
Prometheus carries all of these through KSM and OpenShift metrics, with one to two minutes of lag and without message text.

### Where the API is the weaker source

Utilization: `metrics.k8s.io` gives one instantaneous value per pod and node, with no history, no rates and no percentiles.
Prometheus and Thanos own saturation, latency, error rates and alerts; audit logs own "who changed what"; container logs own "why it crashed".
The data layer's per-sweep timeline is a convenience, not a substitute.

### Consequences

- The differentiated value (blast radius, dependency graph, application certificate expiry, cluster-admin holders, ownership) lives entirely in the API-only table, which is also where the scrub policy matters most.
- The "available from both" rows are a scaling lever (ADR-0003): at 900 clusters they could be read from each hub's Thanos with one PromQL query instead of 900 paginated list calls, removing most of the raw pull volume; Secrets and ConfigMaps would still come from the API on a slow tier.

## 2. Scale: the collector, not the store, is the limit

Source: the sizing model in ADR-0003 and the synthetic load in [adr/synthetic-load-900.md](adr/synthetic-load-900.md).

- A production cluster with ~250 application namespaces is ~120 MB of raw Kubernetes JSON per sweep because Secrets, ConfigMaps and Pods are fetched whole and scrubbed in the collector; 900 clusters is ~109 GB per sweep, which rules out a 2-minute fleet-wide sweep (~7 Gbit/s, ~18 cores of parsing).
- Redis at 900 clusters measured 4.79 GB (1.31 MB per cluster, sections compressing 12.8x), against 21 GB for a one-key-per-object layout.
- Fleet indexes dominate memory (3.77 GB), not the detail blobs (0.96 GB); the resource hashes for fleet-queried kinds are the largest single item.
- Certificates were three times the estimate: OpenShift injects `kube-root-ca.crt` into every namespace, so every namespace contributes a certificate row. Excluding the injected service CA from the certificate index halves that.
- Read latency is milliseconds for everything indexed, except the unfiltered fleet-wide application list (225,000 rows, ~5 s), which must paginate.
- One cluster write costs ~2 s of CPU in the persisting process (18,158 index contributions in one transaction), so collection and persistence must be sharded to keep a fleet fresh.

## 3. Store behaviour worth knowing

- The per-cluster ledger must never expire: it is what unpublishes an aged-out cluster's fleet-index members. An early version expired it with the other keys and would have left zombie namespaces and resources in the fleet hashes (caught by review, covered by a test).
- A 3-hour soak of the live stack (~105 sweeps) kept keys and memory flat; an image that left the fleet disappeared from its refcount, its usage set and its name alias together.
- `maxmemory-policy noeviction` is a correctness setting, not a tuning knob: a cache that silently dropped one cluster would answer blast-radius questions wrongly.
- Redis Cluster is not needed for capacity at 900 clusters, but the hash-tag layout keeps it possible; fleet-index updates are cross-slot and would become a second pipeline there.

## 4. Natural-language queries

- Redis has no SQL and RediSearch cannot join, so the query surface is SQL over an in-process DuckDB snapshot rebuilt from Redis after each sweep; the relational schema is the former Postgres schema, so documentation and mental model stay continuous.
- The guard is structural (single allowlisted `SELECT`, enforced `LIMIT`, timeout, no file or catalog functions) on a read-only in-memory copy, so the worst case of a bad or manipulated query is a wrong `SELECT`.
- The Anthropic SDK (1.x) builds a client without credentials and fails only at request time with a plain `TypeError`, not an authentication error; the service maps that to a 503 with a clear message.
- `mcp` 2.x renamed `FastMCP`; the MCP server pins `mcp<2`.

## 5. Read-only value the API can still add

The data layer's contract is non-mutating: it only lists and gets.
Within that contract there is a lot more to read.
Three tiers, by what the read costs in privilege and risk:

### Tier A: plain reads, same RBAC posture as today

| Area | Objects | Questions it answers |
|---|---|---|
| Ingress exposure | Routes (TLS termination, `insecureEdgeTerminationPolicy`, wildcard policy), Ingress, Services of type LoadBalancer and NodePort, external IPs, IngressController CRs (domain, sharding selectors, LB scope, replicas), EndpointSlices | What is reachable from outside and how; which routes still allow plain HTTP; which services have no healthy backends; which pods sit behind a public hostname. |
| Egress posture | OVN-Kubernetes EgressIP and EgressFirewall, the cluster Proxy CR (httpProxy, noProxy, trusted CA), NetworkPolicy egress rules, EgressService, hostNetwork pods | Which namespaces may reach the internet and through which IPs; namespaces with no egress restriction; proxy bypass lists. |
| East-west policy | NetworkPolicy ingress rules per namespace, Multus NetworkAttachmentDefinitions, service mesh objects where present | Namespaces without a default-deny; allowed peers per application; a policy-coverage score. |
| Resilience posture | Deployments and StatefulSets: replica count, PodDisruptionBudgets, readiness and liveness probes, requests and limits, `latest` tags, anti-affinity and topology spread, emptyDir and hostPath volumes | Single-replica critical apps; PDBs that block node drains (`allowedDisruptions = 0`), which is the patching pre-check that matters most; workloads without probes or limits. |
| Security posture | Pod specs (privileged, hostNetwork, hostPID, hostPath, runAsRoot), SCC assignments, Pod Security Admission labels per namespace, ServiceAccount token automount, ImageDigestMirrorSets, APIServer CR (audit profile, etcd encryption, TLS profile), OAuth CR (identity providers) | Which namespaces run privileged workloads; who bypasses restricted PSA; whether etcd encryption and an audit profile are on; which identity providers are configured. |
| Lifecycle and capacity | ClusterVersion history (every upgrade with timestamps), MachineSets and Machines, MachineHealthChecks, KubeletConfig, Tuned profiles, cluster autoscaler config, LimitRanges, namespaces without quotas | Upgrade history per cluster; declared versus actual node counts; capacity that can still be added; namespaces with no guard rails. |
| Delivery provenance | ArgoCD Applications, Helm release metadata (the `sh.helm.release.v1` secret's labels only, never its payload), OwnerReferences | Which Git repository and chart version deploys each application; what is unmanaged. |
| Backups and data | VolumeSnapshots, OADP Backup and Schedule CRs, StorageClass reclaim policies | Which PVCs have never been snapshotted; backup schedules that are failing. |

Everything in Tier A is a `list` or `get` on objects the collector already has the pattern for: a parser, a scrubbed summary, a section field, a snapshot column, a semantic-layer line.

### Tier B: read-only but privileged or sensitive

| Read | Path | Value | Caution |
|---|---|---|---|
| Container logs | `pods/log` (including `previous=true`) | The last lines of a crashed container explain the crash better than `CrashLoopBackOff` does. | Logs contain secrets and personal data. Keep only a bounded tail of the previous container's log, pattern-redacted, and only for pods already flagged as issues. |
| Kubelet stats | `nodes/<name>/proxy/stats/summary` | Per-container network bytes, filesystem and ephemeral-storage usage, which `metrics.k8s.io` lacks. | Needs `nodes/proxy` get, a broad permission that reaches every kubelet endpoint. Prefer Prometheus (cAdvisor already scrapes this) where it exists. |
| cAdvisor and kubelet metrics | `nodes/<name>/proxy/metrics/cadvisor` | Network receive and transmit per pod, throttling, OOM events. | Same permission; same preference for Prometheus. |

Tier B stays read-only, but it changes the RBAC and the scrub story, so each item needs its own manifest entry with the redaction rule written next to it.

### Tier C: not read-only, and therefore not this product

TCP dumps, heap dumps, thread dumps, `oc debug node`, `oc adm must-gather` and anything using `pods/exec` create pods, run commands inside workloads, pause JVMs, and produce artifacts that contain memory or traffic, which means secrets.
None of that belongs in a pull cache with a read-only service account.

The right shape is an *actions plane* next to the data layer, modelled on the patching service: a request with a target and a reason, an approval, an audited job that runs the capture through a pipeline on the cluster, an artifact written to object storage with retention, and a link back into the data layer's cluster or workload page.
The data layer contributes the context (which pod, on which node, owned by which team, currently restarting because of what), the actions plane does the touching.

What the read-only side can still do for those cases without a dump: JVM heap and GC metrics from Prometheus when the application exposes them, the OOMKilled reason with limit versus working set, restart timelines, and the EndpointSlice and Route chain that tells an engineer where a packet capture would need to be taken.

### What the API does not have, in any tier

Observed traffic.
Routes, NetworkPolicies and EgressFirewalls describe the *allowed* topology; who actually talked to whom and how many bytes is network observability (OVN flow logs, NetObserv, eBPF), a different plane.
The data layer can host the allowed graph and link out to the observed one.

## 6. Suggested next reads, in order of value for effort

1. PodDisruptionBudgets and single-replica critical workloads (patching pre-check, tiny parser).
2. Route TLS posture and LoadBalancer services (exposure inventory, tiny parser).
3. NetworkPolicy coverage per namespace and EgressFirewall rules (egress compliance).
4. ClusterVersion history (upgrade timeline, already in an object the collector fetches).
5. Pod security facts from pod specs the collector already reads (privileged, hostNetwork, hostPath).
6. Previous-container log tail for flagged pods, with redaction (Tier B, needs a scrub rule).
