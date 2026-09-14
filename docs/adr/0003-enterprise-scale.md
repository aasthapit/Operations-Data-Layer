# ADR-0003: Operating at enterprise scale (900 clusters, hundreds of applications each)

- Status: accepted (September 2026)
- Related: [ADR-0001](0001-redis-as-fleet-state-store.md), [ADR-0002](0002-natural-language-queries.md)

## Context

The local design is one collector process, one Redis, one API, ten kind clusters.
The target is 900 OpenShift clusters under many ACM hubs, each with 200-300 application namespaces, tens of thousands of inventory objects, and hundreds of users and agents asking questions.
This ADR records what changes, in order of what actually limits the system.

## Finding 1: the collector, not Redis, is the bottleneck

Redis at 900 clusters is ~5 GB (ADR-0001).
The collection side, extrapolated from the same per-cluster assumptions (6k Secrets, 5k ConfigMaps, 8k Pods, 1.7k workloads, plus everything else the manifest enables), pulls about **120 MB of raw Kubernetes JSON per cluster per sweep**, because Secrets and ConfigMaps are fetched whole and scrubbed in the collector.

| Sweep interval | Aggregate pull, 900 clusters | Sustained network | Parse CPU (Python, ~50 MB/s per core) |
|---|---|---|---|
| 2 min (today's default) | 109 GB per sweep | ~7.3 Gbit/s | ~18 cores continuously |
| 5 min | 109 GB | ~2.9 Gbit/s | ~7 cores |
| 15 min | 109 GB | ~1.0 Gbit/s | ~2.4 cores |
| 60 min | 109 GB | ~0.24 Gbit/s | ~0.6 cores |

A single 2-minute full sweep is not viable at 900 clusters.
(Measured later on Apple Silicon: JSON decoding runs at ~0.6 GB/s with the stock decoder and ~1 GB/s with `orjson`, so the parse column above is pessimistic by an order of magnitude; the certificate parsing and the per-object assembly are the larger CPU items. `GET /api/collector/timings` reports the real split per cluster and replaces this estimate.)
The fix is not a bigger collector; it is collecting less, less often, and only what changed.

Decision:

1. **Tiered refresh intervals per manifest resource.** Platform state (ClusterVersion, ClusterOperators, nodes, node metrics, MCPs, pod issues) every 2-5 min; inventory kinds (workloads, services, routes, PVCs, quotas, OLM) every 15-30 min; heavy scrub-only kinds (Secrets, ConfigMaps for certificate facts) every 1-6 h.
   The manifest gets an `interval` per resource; the collector keeps per-cluster, per-kind due times; a cluster write merges the freshly collected sections with the cached ones (sections are already independent keys).
2. **Watch instead of poll for churny kinds.** Pods and Events change constantly but mostly incrementally; a `LIST` + `WATCH` (resourceVersion) informer per cluster for those kinds turns 56 MB of pod JSON per sweep into a stream of deltas.
   This is the standard Kubernetes pattern and is what ACM Search does.
3. **Metadata-only lists where values are not needed.** For kinds where only names / labels / counts matter, request `PartialObjectMetadata` (`application/json;as=PartialObjectMetadata;v=v1;g=meta.k8s.io`) and cut per-object size by 5-10x.
   Secrets that carry certificates still need the data field to read the certificate facts; the tiered interval covers them.
4. **Per-cluster QPS budget.** Bound requests per cluster (kube-apiserver priority and fairness will throttle otherwise) and keep `LIST_PAGE_SIZE` at 500.

## Finding 2: collection must be sharded and coordinated, and Redis is the right coordinator

One process cannot hold ~100 concurrent cluster collections with informers.
Decision: **collector shards per hub (or per group of hubs), coordinated through Redis**:

- A Redis Stream `odl:{fleet}:collect` holds collection jobs (`cluster`, `kinds`, `due`); a consumer group with one consumer per collector pod hands each job to exactly one worker, with pending-entry claims (`XAUTOCLAIM`) for crashed workers.
- A scheduler (any pod, elected by a `SET NX PX` lease) enqueues jobs from the manifest's tiered schedule and from on-demand refresh requests.
- Each shard writes only its clusters' keys; fleet indexes are shared and only touched through per-cluster ledgers, so shards never conflict (ADR-0001).
- Credentials stay per hub; a shard mounts only the kubeconfigs / service accounts of the hubs it serves (blast radius of a compromised shard is its hubs).

Capacity math: at ~15 s per full cluster collection and 4 shards x 16 workers, a full inventory pass over 900 clusters takes ~4 min; with tiered intervals and watches the steady-state load is a small fraction of that.

## Finding 3: fleet-wide reads need pagination and precomputed rollups

At 900 clusters the fleet hashes reach 10^5 to 10^6 entries (routes ~720k, PVCs ~540k, namespaces ~290k).
Decision:

- Every fleet-wide list endpoint gains `limit` + `cursor` (HSCAN cursor) and returns `total` from `HLEN` / `SCARD` / `ZCOUNT`; the dashboard pages.
- Rollups that every screen shows (health by dimension, version spread, insights counters, capacity by group) are computed once at the end of each scheduler tick into `odl:{fleet}:rollup:*` keys, not per request.
- Top-N questions come from ZSETs (already the case for namespaces and nodes).
- `HGETALL` on a fleet hash is forbidden in the API; `HSCAN` with a bounded page or `HMGET` from an index set are the only patterns.

## Finding 4: what "enterprise" adds around the core

| Area | Requirement | Decision |
|---|---|---|
| Identity and access | Every request attributable; teams see their applications; platform teams see everything | OIDC (the corporate IdP) in front of the API and the MCP server; a scope resolver maps identity → allowed teams / environments / regions; the API applies the scope as a filter on `namespaces` and `clusters` (and as a wrapping view for NL SQL, ADR-0002). No anonymous access. |
| Secrets in the cache | Nothing sensitive may sit in Redis | Already true by construction: values, certificate material and env values never leave the parser. Enforced by tests (`test_scrub.py`) and by the manifest's closed annotation allow-list. |
| Transport and Redis security | Encryption in transit, least privilege | TLS to Redis (`rediss://`), Redis ACL users: `collector` (write), `api` (read-only commands), `scheduler` (streams + leases); no `FLUSHALL` / `KEYS` / `CONFIG` for any app user. |
| Availability | The dashboard must survive a Redis or collector failure | Redis primary + replica with automatic failover (Sentinel or managed HA); RDB every 5 min so a restart serves the last picture; API pods stateless and horizontally scaled; the query snapshot (ADR-0002) rebuilt from Redis on start. |
| Disaster recovery | Lose Redis entirely | The cache is rebuildable from the fleet; a full rebuild is throttled (tiered intervals) and takes ~10-15 min for platform state at 900 clusters. RDB backups to object storage give instant restore instead. |
| Observability of the data layer | Know when the picture is stale before users do | Metrics: sweep lag per cluster (`now - last_synced`), jobs pending / claimed / failed per shard, per-kind collection duration and error rates, Redis memory and fragmentation, API p95 per endpoint, snapshot build time. SLOs: 95% of clusters fresher than 2x their tier interval; API p95 < 300 ms for fleet endpoints. Alerts on staleness, on `noeviction` OOM, on stream backlog. |
| Audit | Who asked what | Structured request logs with identity, endpoint, filters, and for NL queries the question and the SQL. Shipped to the platform log store. |
| Multi-region | Hubs in several regions, one view | One Redis per region fed by regional shards, plus a thin global API that fans out (`SINTER` results merged in the API) or a single central Redis if latency and data-residency rules allow. Data residency decides, not performance. |
| Retention and history | Trend questions beyond 500 sweeps | Per-cluster ZSETs stay bounded; export health snapshots and fleet rollups per hour to Parquet in object storage; that export is the warehouse feed for ADR-0002 option 4. |
| Change management | Manifest and schema evolve | The manifest is config, versioned; adding a resource adds a parser, a section field, a snapshot column and a semantic-layer line in one change. RBAC for the collector is generated from the manifest (`make rbac`). |
| Capacity planning for the cache | Predictable growth | Memory per cluster ~1.4 MB detail + ~3 MB fleet-index share (ADR-0001); alert at 70% of `maxmemory`; the reference index and the events kind are the first to demote to per-cluster-only if memory is tight. |
| Testing at scale | Prove numbers, not estimates | `scripts/synth_load.py` generates N realistic cluster documents and persists them; run at 900 in CI-lite to track memory, write throughput and read latency per release. |
| Cost | Order of magnitude | Redis 16 GB HA pair; 4-6 collector pods (2 vCPU, 4 GB each); 3 API pods; object storage for exports. The LLM cost of NL queries is per question (cached schema prompt), typically cents. |

## Measured: the store at 900 synthetic clusters

The numbers above for Redis were a model; `data-layer/scripts/synth_load.py` replaced them with measurements (full report: [synthetic-load-900.md](synthetic-load-900.md)).
It generates 900 documents in the exact shape the collector produces (250 application + 70 platform namespaces, ~1,700 workloads, ~16,600 inventory objects per cluster; 24.1 M rows in total) and persists them through the real store into a throwaway Redis 7.

| Measurement | Result |
|---|---|
| Redis used memory | 4.79 GB (RSS 4.78 GB, fragmentation ratio 1.0) |
| Keys | 54,508 |
| Per-cluster footprint | 1.31 MB: 1.02 MB of compressed sections, 0.19 MB ledger, summary + history |
| Compression of the sections | 12.8x (12.97 MB of raw JSON per cluster) |
| Write throughput, one process, 4 threads | 1.52 clusters/s (593.7 s for 900); flat from the 25th to the 900th cluster |
| One cluster write | one MULTI/EXEC: 10 sections + summary + snapshot + ledger + 18,158 index contributions over 4,076 fleet keys; 1.92 s of CPU in `persist_cluster` |
| Read latency p50 / p95 | cluster detail 4.7 / 5.3 ms; counters 0.2 / 0.3 ms; top-N 0.8 / 2.0 ms; certificates 5.2 / 7.6 ms; operator index 3.8 / 4.7 ms; all 900 summaries 122 / 126 ms; routes with status `rejected` (17,870 rows) 227 / 250 ms |
| The one slow read | `namespaces(ns_class="application")`, 225,000 rows: 4.7 s p50 / 5.4 s p95 |

Where the memory went: fleet resource hashes 1.83 GB (37%), per-cluster sections 0.96 GB (19%), certificates + node / namespace / pod-issue indexes 0.77 GB (16%), config reference sets 0.62 GB (12%), the namespace index hash 0.40 GB (8%), image usage sets 0.23 GB (5%), ledgers 0.17 GB (3%).

What the measurement changes:

- **The 5 GB headline holds** (4.79 GB measured), but the split is different from the model: sections compressed 12.8x rather than 8x (0.96 GB instead of 1.29 GB) and the fleet indexes are larger (3.77 GB instead of 2.75 GB).
- **Certificates are three times the estimate** (600 k rows, 0.58 GB) because OpenShift injects `kube-root-ca.crt` into every namespace, so every one of the 320 namespaces contributes a certificate row. Excluding the injected service CA from the certificate index (it is the same certificate everywhere and its expiry is a cluster fact, not a namespace fact) halves that; this is a manifest-level change, not a store change.
- **The ledger is a real cost** (0.19 MB per cluster, 0.17 GB fleet-wide) and was not in the model. It is the price of exact index removal and belongs in the capacity plan.
- **Fragmentation did not occur on a write-once load** (ratio 1.0). The 25% allowance in ADR-0001 covers steady-state rewrites and stays.
- **The applications listing must paginate**, exactly as Finding 3 predicts: filtered reads by team or application take ~22 ms, the unfiltered fleet-wide read takes seconds. `limit` + cursor on `/api/applications` is the first item of the next phase.
- **Write cost per cluster is ~2 s of CPU** in the persisting process, which confirms the sharded-collector decision (Finding 2): 900 clusters at 2 s is 30 minutes of single-threaded CPU per full rewrite, 4 shards x 4 threads bring it to ~2 minutes.
- Memory is slightly sub-linear in the number of clusters (shared index keys amortise), so extrapolating from a small run is about 10% conservative.

## Rollout plan

1. **Now (this branch):** Redis store, atomic per-cluster writes, fleet indexes, on-demand refresh, `stale` flags, NL query over the snapshot, unit + E2E tests, synthetic load numbers.
2. **Next:** `limit`/`cursor` on `/api/applications` and the other fleet endpoints (the one measured slow read), exclude the injected service CA from the certificate index, tiered intervals in the manifest, precomputed rollups, OIDC + scopes, Redis ACL/TLS, metrics + SLO alerts.
3. **Then:** collector shards with the Redis Stream work queue, informers for pods / events, PartialObjectMetadata lists, Parquet exports and the incremental snapshot for NL queries.
4. **Later, if needed:** RediSearch where the managed Redis offers it; a warehouse over the Parquet exports for long history and cost analytics.

## Consequences

- The architecture separates concerns cleanly: pull (collector shards) → cache (Redis, atomic per cluster) → serve (API with indexes and rollups) → ask (NL over a snapshot).
- The biggest engineering investment at scale is in the collector (tiering, watches, sharding), not in storage.
- Every fleet-wide API surface must be designed as paginated from now on; unpaginated `HGETALL` reads are a defect, not a shortcut.
