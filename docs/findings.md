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

## 7. Where the collector's time goes

Source: the per-stage measurements the collector now records for every cluster, served by `GET /api/collector/timings` and shown on the dashboard's **Collected** tab.
ADR-0003 Finding 1 modelled the collector as the bottleneck; this section is how to check the model against a real estate rather than argue about it.

### The stages, and what each is bound by

| Stage | What it covers | Bound by | What shrinks it |
|---|---|---|---|
| `fetch_ms` | Time in HTTP for every kind the sweep fetched, including pagination: connect, the API server's own work (etcd reads, serialization), and the transfer. | Network and kube-apiserver. | Fetching less and less often: tiered intervals, watches instead of polling, `PartialObjectMetadata` lists, a per-cluster QPS budget (ADR-0003, Finding 1). Not a faster language. |
| `parse_ms` | Decoding those response bodies into Python objects (`orjson`, measured inside `kube.get_json`). | CPU, and the size of the JSON. | Pulling fewer bytes; a faster decoder (already done: orjson instead of the client's `json.loads` over a decoded `str`); a collector in a compiled language. |
| `assemble_ms` | Turning raw objects into the normalised document: parsers, scrubbing, certificate facts, rollups per namespace and per cluster. | CPU, and the number of objects. | Parsing lazily (certificates are only parsed for values that contain a PEM certificate), collecting fewer kinds, a compiled language. |
| `health_ms` | Running the health checks over the assembled document. | CPU, small and flat. | Nothing worth doing. |
| `persist_ms` | The store write: compressing ten sections and applying the fleet-index contributions in one MULTI/EXEC. | CPU in the collector (compression, index maths) plus one Redis round trip. | Sharding the collector (ADR-0003, Finding 2); it is ~2 s of CPU per cluster at synthetic-load scale. |

`parse_ms` is measured *inside* the fetch phase - a response is decoded on the thread that fetched it, and a cluster's kinds are fetched concurrently.
So a cluster's wall clock is `fetch + assemble + health + persist`, and `parse_ms` says how much of the fetch window was Python burning CPU rather than waiting on a socket.
The endpoint reports both: `share_percent` partitions the wall clock, `cpu_percent` and `parse_percent_of_fetch` say how much of it is CPU.

### How to read the endpoint

`GET /api/collector/timings?limit=50` answers "where does the time go?" in one call:

- `clusters[]` - one row per cluster that reported, sorted by `total_ms` descending: the five stage times, `cpu_ms`, the bytes and objects pulled, and how many kinds were fetched versus served from cache by the tiered schedule. The slowest clusters are the ones to look at first, and the `kinds_fetched` / `kinds_cached` split says whether a slow cluster is slow because it was a full collection.
- `fleet` - `totals`, `p50` and `p95` per stage over every cluster that reported (`limit` bounds the rows, never the aggregates), plus `share_percent`, `cpu_percent`, `parse_percent_of_fetch`, `bytes_per_fetch_second` and `objects_per_parse_second`.
- `last_run` - the last completed sweep: its wall duration and the aggregates the runner wrote, so a sweep's elapsed time can be compared with the summed per-cluster work (the ratio is how much concurrency the collector actually achieved).

The same numbers are on each cluster (`timings` on `/api/clusters` and `/api/clusters/{name}`), per kind (`/api/clusters/{name}` `resource_status`, which carries `bytes`, `objects`, `parse_ms`, `requests`, `collected_at`, `cached` and `interval_seconds`), per sweep (`/api/runs`, `/api/status`) and in SQL (`clusters.timings`, for "which region costs the most bytes per sweep").

### The decision it is there to inform

Whether to rewrite the collector in Go. The numbers to look at, in order:

1. `fleet.cpu_percent`. A Go collector replaces `parse_ms + assemble_ms + health_ms + persist_ms`. If that is 20% of the wall clock, a rewrite buys at most 20% before it buys anything else; if it is 70%, the case is real.
2. `fleet.share_percent.fetch_ms` against `bytes_per_fetch_second`. A low throughput with a high fetch share is an API-server or network problem, and tiering and watches are the fix - a rewrite would not touch it.
3. `p95` against `p50` per stage. A fleet whose p95 is many times its p50 has a few pathological clusters (a huge Secret count, a slow API server), and fixing those is cheaper than any rewrite.
4. `persist_ms` as a share. If persistence dominates, the answer is sharding (ADR-0003, Finding 2), which is a deployment change, not a language change.

The numbers themselves are deliberately not written here: they are a property of the estate the collector is pointed at, and the local kind fleet would only mislead.
Fill them in from a real sweep - `/api/collector/timings` after a full sweep against production hubs - and record the date and the fleet size next to them.

### Two measured improvements already in the collector

Both were measured on this machine (Apple M-series, Python 3.12) and are reproducible from the scripts described below.

- **Deserialisation moved off the kubernetes client.** `kube.get_json` asks `call_api` for the raw urllib3 response (`_preload_content=False`) and parses the bytes with `orjson`, instead of letting the client decode the body to `str` and run `json.loads` over it. On a synthetic 52.6 MB Secret list: 91.2 ms for the client's path (576 MB/s) against 50.1 ms (1,049 MB/s), a **1.8x speedup** of every byte the collector reads. Worth noting against ADR-0003's model, which assumed ~50 MB/s per core for parsing: the real figure is an order of magnitude higher, so the "~18 cores of parsing" line in Finding 1 is pessimistic - the pull volume is still the problem, the decode is not.
- **Certificates are only parsed when a value contains one.** Every Secret and ConfigMap value used to be handed to `cryptography`; now `scrub.looks_like_cert` gates it on a byte check (the PEM marker at the start of the value, or anywhere inside it for a key named like a certificate or any key of a `kubernetes.io/tls` Secret), and sizes and certificate facts are taken in one pass so a Secret value is base64-decoded once rather than twice. On a realistic 600-Secret / 500-ConfigMap mix: Secrets **1.9x faster**, and a trust bundle is capped at the first 20 certificates (`scrub.MAX_CERTS_PER_KEY`, facts from a capped bundle carry `"truncated": true`), which is another **1.7x** on ConfigMaps in a fleet that mounts a full CA bundle. No certificate fact changes: a PEM certificate cannot exist without its marker.
