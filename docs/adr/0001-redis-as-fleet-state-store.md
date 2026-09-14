# ADR-0001: Redis as the fleet state store (a pull-fed read cache)

- Status: accepted (September 2026)
- Deciders: platform engineering
- Supersedes: the Postgres persistence described in `docs/architecture.md` (data model section)
- Related: [ADR-0002](0002-natural-language-queries.md), [ADR-0003](0003-enterprise-scale.md), [`docs/redis-keyspace.md`](../redis-keyspace.md)

## Context

The data layer collects inventory, configuration and live utilization (`metrics.k8s.io`) from every OpenShift cluster's API server, computes health, and serves it through a REST API, a dashboard and an MCP server.
Until now the collected state lived in Postgres: current-state tables replaced wholesale per cluster on every sweep, plus an append-only health snapshot table.

The hosting environment does not allow Postgres.
Redis is the approved store, and the question was whether Redis, keyed as a pull/read cache of OCP metrics and inventory, can carry the whole product, and what changes when the fleet is 900 clusters with hundreds of applications each.

What the store has to serve (from the API read paths in `data-layer/app/api/`):

| Read pattern | Examples | Postgres today |
|---|---|---|
| Fleet rollups over one row per cluster | overview, health by region, version spread, capacity by group | full scan of `clusters`, aggregated in Python |
| Filtered cluster lists | region / environment / status / version / team | indexed `WHERE` |
| One cluster, one section | nodes, namespaces, workloads, pod issues, resources, timeline | per-table `WHERE cluster_name = ?` |
| Fleet-wide entity queries | applications across clusters, expiring certificates, pod issues, quotas, OLM packages, MCPs, routes, events, images, config references | indexed table scans + Python grouping |
| Joins for impact | blast radius: version / operator / OLM / image → clusters → application namespaces → teams | several queries joined in Python |

The write side is simple: one collector process assembles one plain-dict document per cluster and replaces that cluster's rows in a single transaction.

## Decision

Redis becomes the only store for collected fleet state, designed as a **pull-fed read cache** with three kinds of keys (full contract in `docs/redis-keyspace.md`):

1. **Per-cluster keys** under one hash tag `{c:<name>}`: a summary HASH (the former `clusters` row), ten **compressed section blobs** (operators, nodes, namespaces, workloads, images, refs, pod issues, resources, resource status, health checks), a snapshots ZSET (history), and a ledger.
2. **Fleet indexes** under `{fleet}`: SETs per cluster dimension, per-operator HASHes, a namespace HASH with team / app / class SETs and usage ZSETs, per-kind resource HASHes with status SETs (only for the kinds that are queried fleet-wide), a certificate-expiry ZSET, image refcounts + usage SETs, and reference SETs.
3. **Runs**: a LIST of sweeps and the last-run pointer.

The write protocol replaces one cluster atomically (MULTI/EXEC): reverse the cluster's previous fleet contributions from its ledger, write summary + sections + snapshot, add the new contributions, write the new ledger.
The read side never scans every cluster's detail to answer a fleet question; the fleet indexes exist precisely for the questions the product asks.

Cache semantics:

- **Pull, not push.** The collector pulls on `REFRESH_INTERVAL_SECONDS` and on demand (`POST /api/refresh` for the fleet, `POST /api/clusters/{name}/refresh` for one cluster behind a single-flight lock).
- **Freshness is visible.** Every summary carries `last_synced`, `age_seconds` and `stale`; the API never hides that it is serving a cache.
- **Expire, never evict.** Per-cluster keys carry `REDIS_TTL_SECONDS` (default 24 h) so a cluster that is never collected again disappears; the Redis instance runs `maxmemory-policy noeviction`, because a cache that silently drops one cluster would answer blast-radius questions wrongly.
- **Restart without a storm.** RDB snapshots (or AOF) stay on, so an API restart serves the last picture immediately instead of forcing a full re-collection; the cache is rebuildable, but at 900 clusters rebuilding takes minutes and hammers the fleet.

## Options considered

| Option | Summary | Why not (or why) |
|---|---|---|
| A. One key per object (mirror the ORM) | Every namespace, workload, resource as its own HASH; index SETs for every column that was indexed in Postgres | ~20 GB at 900 clusters versus ~5 GB (per-key overhead, member strings), millions of keys, and a write of one cluster becomes tens of thousands of commands. No benefit: the API never reads one object by id. |
| B. RedisJSON + RediSearch (Redis Stack / Enterprise) | Documents as JSON, declarative secondary indexes, `FT.SEARCH` / `FT.AGGREGATE` | Attractive: removes hand-built indexes and adds full-text search. Rejected as the baseline because the modules are not available on every managed Redis (AWS ElastiCache, classic Azure Cache for Redis, GCP Memorystore), it still cannot join, and memory grows ~1.5-2x. Kept as an **optional accelerator** (see Consequences). |
| C. One compressed blob per cluster, no fleet indexes | Simplest possible keyspace | Every fleet question decompresses every cluster: 900 x ~1.3 MB per request. Fine at 10 clusters, unusable at 900. |
| **D. Section blobs + fleet indexes (chosen)** | Per-cluster detail as compressed sections; fleet-wide questions from purpose-built indexes maintained through per-cluster ledgers | Reads are one or two round trips; writes are one transaction per cluster; memory is dominated by compressed detail; works on plain Redis 7 (OSS, ElastiCache, Azure, Memorystore, Enterprise). |

Plain Redis 7 core with no modules is the compatibility floor; nothing in the design needs Lua, modules or keyspace notifications.

## Sizing

Measured on the local kind fleet (5 clusters, tiny): a sweep takes ~450 ms, a cluster document is ~250 resources / 17 namespaces / 16 workloads, and the whole Postgres database was 13 MB.
The model below assumes a production cluster with 250 application namespaces (~1,700 workloads, ~16,600 inventory objects, ~26,000 rows in total), a JSON row of ~450 B and 8x zlib compression on the sections (measured 8-12x on this kind of JSON).

| Clusters | Sections + summaries + history | Fleet indexes | Total (logical) | Total with 25% fragmentation | One-key-per-object alternative |
|---|---|---|---|---|---|
| 10 | 14 MB | 31 MB | 45 MB | 0.06 GB | 0.23 GB |
| 100 | 0.14 GB | 0.31 GB | 0.45 GB | 0.56 GB | 2.4 GB |
| 900 | 1.29 GB | 2.75 GB | 4.0 GB | **5.1 GB** | 21 GB |

Where the fleet indexes go at 900 clusters: resource hashes for fleet-queried kinds 1.2 GB (routes, PVCs, PVs, quotas, events dominate), config references 0.9 GB, image usages 0.25 GB, namespaces 0.21 GB, certificates 0.19 GB, everything else under 50 MB.
Two knobs keep this honest: the reference index is optional (`REDIS_INDEX_REFS`, falls back to per-cluster sections when a cluster filter is given), and the large fleet hashes must be read with `HSCAN` and paginated endpoints rather than `HGETALL` (ADR-0003).

Measured afterwards on a synthetic 900-cluster load (see [ADR-0003](0003-enterprise-scale.md) and [synthetic-load-900.md](synthetic-load-900.md)): **4.79 GB** used memory, 54,508 keys, 1.31 MB per cluster, sections compressing 12.8x, fleet indexes 3.77 GB (certificates three times the estimate because of the `kube-root-ca.crt` ConfigMap injected into every namespace), ledgers 0.17 GB.
The headline holds; the composition shifted from detail to indexes.

Per-cluster keys are ~1.3-1.4 MB each, so a single cluster's detail is one round trip of a few hundred KB per section.
A single Redis primary with 8-16 GB and one replica is enough at 900 clusters; Redis Cluster is not needed for capacity, but the hash-tag layout keeps it possible.

## Consequences

Positive:

- No relational database anywhere in the data layer; the deployment is API pods + Redis.
- Reads that used to be full-table scans are one pipelined round trip; per-cluster detail is one `GET` per section.
- Writes are atomic per cluster and independent across clusters, which is exactly what sharded collectors need (ADR-0003).
- The cache framing is explicit: TTLs, `stale` flags and on-demand refresh are first-class instead of implied.
- The design is portable across managed Redis offerings.

Negative and mitigations:

- **Ad-hoc queries are not free.** Redis answers the questions we indexed; a new fleet-wide question needs either a new index or a scan. ADR-0002 provides the general-purpose query surface (SQL over an embedded snapshot) so that indexes stay small and purpose-built.
- **Hand-maintained indexes are a correctness burden.** The ledger makes removal exact and the store tests assert that stale members disappear; `finalize_sweep` cleans refcounts. If RediSearch becomes available, the fleet resource hashes and the image / namespace lookups can move to declared indexes with no API change.
- **Filtering happens in process for section reads.** A cluster with 16k resources decompresses ~0.5 MB and filters in Python in a few ms; that is acceptable per request and bounded by cluster size, not fleet size.
- **History is capped.** `SNAPSHOT_RETENTION` per cluster (default 500 sweeps) in a ZSET; longer retention or per-namespace history belongs in the metrics plane or an object-store export, not in Redis.
  (Superseded: history is now three time-trimmed tiers per cluster - every sweep for `SNAPSHOT_RAW_HOURS`, hourly for `SNAPSHOT_HOURLY_DAYS`, daily for `SNAPSHOT_DAILY_DAYS` - plus a change-log stream, which buys two years of cluster-level trend at about 1 GB for 800 clusters. `SNAPSHOT_RETENTION` remains only as a row cap on the per-sweep tier. See [redis-keyspace.md](../redis-keyspace.md). Per-namespace history is still out of scope.)
- **The patching system of record still uses Postgres.** It is a separate service with an audit log; moving it needs its own decision (Redis Streams for the append-only audit, HASHes for jobs, AOF persistence, since it is a system of record and not a cache).

## Verification

- Unit tests with `fakeredis` cover persist / read / re-persist / prune / TTL / retention for every index.
- End-to-end against the kind fleet: the worktree stack collects the same clusters as the Postgres stack and the dashboard endpoints return the same structures and counts.
- A synthetic load test (`scripts/synth_load.py`) persists 900 generated cluster documents and reports Redis memory, key counts, write throughput and read latency for the fleet endpoints; its measurements are recorded in ADR-0003.
