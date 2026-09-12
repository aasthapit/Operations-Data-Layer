# Synthetic load: the Redis store at 900 clusters

- Status: measured (September 2026)
- Related: [ADR-0001](0001-redis-as-fleet-state-store.md), [ADR-0003](0003-enterprise-scale.md), [`docs/redis-keyspace.md`](../redis-keyspace.md), [`data-layer/scripts/README.md`](../../data-layer/scripts/README.md)

## What was measured

ADR-0001 estimated 5.1 GB of Redis at 900 clusters from a model, and ADR-0003 said to prove the numbers rather than estimate them.
This is that proof.

`data-layer/scripts/synth_load.py` generates 900 realistic collector documents in the exact shape `app/collector/collect.py:assemble()` produces, runs the same health checks the collector runs, and persists every cluster through the real `RedisStore.persist_cluster`.
Nothing talks to a cluster: this measures the store, not the collector.
The load ran against a dedicated throwaway Redis 7 (`--save "" --appendonly no --maxmemory-policy noeviction`), never against a stack's Redis.

Every number below is measured, not modelled.
Memory comes from `INFO memory`, `DBSIZE`, `MEMORY USAGE` and `HLEN`; latency is wall-clock around the store calls themselves, in process, with no HTTP layer.

## The fleet that was generated

Per cluster, matching the production cluster ADR-0003 assumes:

| | Count |
|---|---:|
| Application namespaces | 250 |
| Platform namespaces | 70 |
| Workloads | 1,700 |
| Nodes | 30 |
| Cluster operators | 35 |
| Pod issues | 50 |
| Inventory objects (`resources`) | 16,633 |
| Workload image edges | ~2,030 |
| Workload config references | ~5,880 |
| Rows in total | 26,708 |

Across the fleet that is 24,058,923 rows.
The fleet is a fleet and not 900 unrelated clusters: applications come from a pool of 3,000 (so one application runs on about 75 clusters), teams from a pool of 150, and container images from a pool of 30,000, of which 17,940 ended up in use.
The generated health rollup came out at 385 healthy, 440 warning and 75 critical clusters.

## Write throughput

| Measure | Value |
|---|---|
| Documents generated | 900 |
| Rows generated | 24,058,923 |
| Generation CPU time | 490.5 s (0.54 s per cluster) |
| Persist CPU time | 1,725.5 s (1.92 s per cluster) |
| Wall time, 4 worker threads | 593.7 s |
| Throughput | 1.52 clusters/s |
| Compressed sections written | 0.85 GB (1.47 MB/s) |
| Raw document JSON processed | 10.88 GB (18.8 MB/s) |
| Compression ratio, whole fleet | 12.7x |

One cluster's write is one `MULTI`/`EXEC` carrying the 10 section blobs, the summary, the snapshot, the ledger, and 18,158 fleet-index contributions spread over 4,076 fleet keys (11,432 `SADD`, 3,669 `HSET`, 1,706 `HINCRBY`, 1,351 `ZADD`).
A re-persist of the same cluster issues the same number of reversal commands first, so a steady-state sweep is roughly twice that per cluster.
Throughput was flat across the whole run: 1.46 clusters/s over the first 25 clusters and 1.52 clusters/s over all 900, so nothing degrades as the fleet indexes grow.

Per cluster that is 0.54 s to generate the document and run the health checks and 1.92 s inside `persist_cluster`, which is 2.46 s of thread time against 0.66 s of wall time on four threads.
The persist figure is not all Redis: it covers one `json.dumps` per index payload (18,158 of them), zlib over the ten sections, and the round trip, and it was not decomposed further.
What matters for the sizing is the end-to-end number, and at a realistic 15 s per cluster collection the collector is more than twenty times slower than this, which is why ADR-0003 calls the collector the bottleneck.

## Redis memory

| Measure | Value |
|---|---|
| `used_memory_human` | 4.79G |
| `used_memory_rss_human` | 4.78G |
| `mem_fragmentation_ratio` | 1.0 |
| `DBSIZE` | 54,508 keys |
| Clusters in `odl:{fleet}:clusters` | 900 |

54,508 keys for 24 million rows is the whole point of the design: the one-key-per-object alternative in ADR-0001 would have been tens of millions of keys.

### Memory by key class

Each class is one `SCAN ... MATCH` pass; `MEMORY USAGE` is summed over the sampled keys (at most 20,000 per class) and extrapolated by key count.
Only the config-reference class was large enough to need extrapolation (20,000 of 21,490 keys measured).

| Key class | Pattern | Keys | Memory | Share |
|---|---|---:|---:|---:|
| fleet resource hashes | `odl:{fleet}:res:*` | 45 | 1,830.9 MB | 36.7% |
| per-cluster sections | `odl:{c:*}:sec:*` | 9,000 | 956.3 MB | 19.2% |
| everything else | (no class pattern matched) | 3,331 | 771.6 MB | 15.5% |
| config reference sets | `odl:{fleet}:idx:ref:*` | 21,490 | 618.6 MB | 12.4% |
| namespace index | `odl:{fleet}:ns*` | 1 | 401.5 MB | 8.1% |
| image usage sets | `odl:{fleet}:idx:image:*` | 17,941 | 233.2 MB | 4.7% |
| per-cluster ledgers | `odl:{c:*}:ledger` | 900 | 168.8 MB | 3.4% |
| per-cluster summaries | `odl:{c:*}:summary` | 900 | 1.4 MB | 0.0% |
| per-cluster snapshots | `odl:{c:*}:snapshots` | 900 | 1.1 MB | 0.0% |
| **total** | | **54,508** | **4.87 GB** | 100% |

The class total is 4.87 GB against a reported `used_memory` of 4.79 GB.
`MEMORY USAGE` samples five nested values per collection by default, so per-key figures for the very large hashes are estimates good to a few percent: the routes hash measured 545.9 MB and 578.2 MB on two successive calls.

### One cluster

`ocp-00-00`: 320 namespaces, 1,700 workloads, 16,633 inventory objects, 26,708 rows.

| Key | Compressed bytes | `MEMORY USAGE` |
|---|---:|---:|
| `sec:resources` | 712,058 | 786,512 |
| `sec:workloads` | 157,717 | 163,920 |
| `sec:namespaces` | 51,961 | 57,424 |
| `sec:workload_images` | 45,472 | 49,240 |
| `sec:workload_refs` | 42,451 | 49,232 |
| `sec:pod_issues` | 2,671 | 3,152 |
| `sec:nodes` | 2,234 | 2,632 |
| `sec:health_checks` | 610 | 720 |
| `sec:resource_status` | 515 | 728 |
| `sec:operators` | 463 | 592 |
| `summary` | | 1,608 |
| `snapshots` | | 1,296 |
| `ledger` | | 196,680 |
| **total** | **1,016,152** | **1,313,736** |

The same document as raw JSON is 12,973,382 bytes, so the sections compress **12.8x**.
One cluster therefore costs 1.31 MB of Redis, of which 0.19 MB is the ledger.

### Largest fleet hashes

| Key | `HLEN` | `MEMORY USAGE` |
|---|---:|---:|
| `odl:{fleet}:res:routes` | 720,000 | 578.2 MB |
| `odl:{fleet}:certs` | 600,097 | 503.7 MB |
| `odl:{fleet}:ns` | 288,000 | 401.5 MB |
| `odl:{fleet}:res:persistentvolumeclaims` | 540,000 | 380.3 MB |
| `odl:{fleet}:res:events` | 180,000 | 130.2 MB |
| `odl:{fleet}:nodes` | 27,000 | 25.8 MB |
| `odl:{fleet}:idx:images` | 17,940 | 1.6 MB |

### Where the fleet indexes actually go

| Index | Entries | Memory |
|---|---:|---:|
| `res:routes` | 720,000 | 578.2 MB |
| `certs` | 600,097 | 503.7 MB |
| `ns` | 288,000 | 401.5 MB |
| `res:persistentvolumeclaims` | 540,000 | 380.3 MB |
| `res:persistentvolumes` | 540,000 | 330.1 MB |
| `res:*:status:*` sets (35 keys) | | 202.7 MB |
| `res:resourcequotas` | 270,000 | 192.6 MB |
| `res:events` | 180,000 | 130.2 MB |
| `idx:cert:expires` | 600,097 | 87.1 MB |
| `idx:ns:cpu` + `idx:ns:mem` | 288,000 each | 70.0 MB |
| `res:clusterserviceversions` | 36,000 | 25.9 MB |
| `nodes` | 27,000 | 25.8 MB |
| `podissues:application` + `:platform` | 45,000 | 24.3 MB |
| `idx:ns:team:*` (150 keys) | 288,000 | 19.3 MB |
| `idx:ns:class:*` (2 keys) | 288,000 | 17.2 MB |
| `res:subscriptions` | 18,000 | 12.7 MB |
| `idx:ns:app:*` (3,070 keys) | 288,000 | 11.1 MB |
| `idx:node:cpu_pct` + `:mem_pct` | 27,000 each | 6.5 MB |
| `idx:op:*` (35 keys) | 31,500 | 4.8 MB |
| `res:storageclasses`, `res:clusterrolebindings` | 9,000 each | 9.0 MB |
| `idx:image:names` + `idx:images` | 17,940 each | 3.8 MB |
| `res:machineconfigpools` | 2,700 | 1.5 MB |
| `idx:cluster:*` (59 keys) | 900 | 0.2 MB |

## Read latency, store level

20 iterations per call against the loaded Redis, in process, no HTTP layer.
Calls that exceeded a 60 s budget stopped early; that happened to exactly one.

| Store call | Rows | Iterations | p50 (ms) | p95 (ms) |
|---|---:|---:|---:|---:|
| `clusters()`, every summary | 900 | 20 | 122.1 | 125.6 |
| `clusters(region='sa-east-1')` | 108 | 20 | 15.5 | 17.1 |
| `get_cluster` + `sections(4 sections)` | | 20 | 4.7 | 5.3 |
| `namespaces(ns_class='application')` | 225,000 | 13 | 4,718.5 | 5,367.9 |
| `namespaces(team='tooling-prime')` | 1,490 | 20 | 22.5 | 25.7 |
| `top_namespaces('cpu', 10)` | 10 | 20 | 0.8 | 2.0 |
| `certificates(before=now+30d)` | 337 | 20 | 5.2 | 7.6 |
| `images('nginx')` + `image_usages` x5 | | 20 | 21.5 | 25.7 |
| `operator_index('ingress')` | 900 | 20 | 3.8 | 4.7 |
| `fleet_resources('routes', status='rejected')` | 17,870 | 20 | 227.2 | 250.3 |
| `fleet_resource_count('routes')` | | 20 | 0.2 | 0.3 |
| `pod_issue_counts()` | 2 | 20 | 0.2 | 0.3 |

Everything the dashboard opens with is comfortable.
A cluster detail page is 4.7 ms, counters served from `HLEN` and `SCARD` are 0.2 ms whatever the fleet size, top-N from the ZSETs is under 1 ms, and the whole fleet's summaries are 122 ms for 900 rows.

The one call that is not comfortable is `namespaces(ns_class="application")` at 4.7 s p50 for 225,000 rows.
That is the unpaginated fleet-wide applications read, and it is exactly the defect ADR-0003 Finding 3 predicted: `SMEMBERS` of a 225,000-member set, `HMGET` of 225,000 fields, and 225,000 JSON documents parsed in Python for one request.
`fleet_resources("routes", status="rejected")` at 227 ms for 17,870 rows is the same shape one order of magnitude down, and it is fine only because a status filter is narrow.

## Read latency, HTTP

Not measured.
An API stack came up on `localhost:18001` during the run, but it serves 5 clusters while the load Redis holds 900, so it is pointed at a different Redis.
The script checks that before timing anything and left the stack alone, which is the correct behaviour: the load Redis is throwaway and another worker's stack is not.
To measure the HTTP layer, point an API pod at the load Redis deliberately (`REDIS_URL=redis://localhost:16379/0`) and re-run with `--api-base`.

## Comparison with the ADR-0001 estimate

| | ADR-0001 estimate | Measured | |
|---|---|---|---|
| Sections, summaries, history | 1.29 GB | 0.94 GB | under |
| Per-cluster ledgers | not modelled | 0.16 GB | new |
| Fleet indexes | 2.75 GB | 3.77 GB | over |
| Total, logical | 4.0 GB | 4.79 GB | 20% over |
| Total, with a 25% fragmentation allowance | **5.1 GB** | **4.79 GB** | 6% under |
| Per-cluster keys | ~1.4 MB | 1.31 MB | on target |
| Section compression | 8x assumed | 12.8x measured | better |
| One-key-per-object alternative | 21 GB | not built | |

The headline number holds.
ADR-0001 said 5.1 GB and the load used 4.79 GB, so the sizing guidance (a single Redis primary with 8 to 16 GB plus a replica) is right, with the 70% alert threshold landing at 11.2 GB on a 16 GB instance and the fleet sitting at 30% of it.

The composition is wrong in an interesting way.
The detail blobs cost less than modelled because zlib does better on this JSON than the 8x the model assumed, and the fleet indexes cost more than modelled because index entries carry the full row and Redis charges hashtable overhead per entry once a collection outgrows its listpack encoding.

Per index, against ADR-0001's breakdown:

| Index | Estimate | Measured | |
|---|---|---|---|
| Resource hashes for fleet-queried kinds | 1.2 GB | 1.59 GB, plus 0.20 GB of status sets | over |
| Config references | 0.9 GB | 0.60 GB | under |
| Image usages | 0.25 GB | 0.23 GB | on target |
| Namespaces | 0.21 GB | 0.51 GB with its sets and ZSETs | 2.4x over |
| Certificates | 0.19 GB | 0.58 GB with the expiry ZSET | 3x over |
| Everything else | under 50 MB | ~65 MB | on target |

## Surprises

**Certificates are three times the estimate, and it is not the Secrets.**
The estimate counted roughly 300 certificate-bearing Secrets per cluster.
The real driver is that OpenShift injects a `kube-root-ca.crt` ConfigMap into every namespace, and the parser extracts certificate facts from any key that looks like a PEM, so every one of the 320 namespaces contributes a certificate row too.
That is 667 certificate rows per cluster, 600,097 fleet-wide, and 0.58 GB across `certs` and `idx:cert:expires`.
This is real behaviour, not a generator artefact, and it is worth a decision: the fleet certificate view almost certainly wants the service CA out of it, which would cut the index roughly in half and make the expiring-soon question sharper at the same time.

**The ledger is real memory that the model never counted.**
Each cluster's ledger holds 18,158 `[op, key, member]` entries, 196,680 bytes compressed, which is 15% of that cluster's footprint and 0.16 GB across the fleet.
It buys exact index removal, which is the correctness property the whole design rests on, so this is a price worth paying rather than a defect.
It should simply appear in the capacity model.

**Fragmentation did not happen.**
The model added 25% on top of the logical size; the measured `mem_fragmentation_ratio` was 1.0 and RSS was 4.78 GB against 4.79 GB of `used_memory`.
A write-once load is the best case for an allocator, so a long-running instance with repeated sweeps will fragment more than this, and keeping the allowance in the capacity plan is still right.
But the allowance, not the model, is what made 4.0 GB into 5.1 GB, and the composition error underneath it happened to cancel out.

**The namespace row is the expensive one.**
`odl:{fleet}:ns` is a single 288,000-field hash at 401.5 MB, which is 1.4 KB per namespace.
A namespace row carries `labels`, `annotations`, `resource_counts` and `images`, uncompressed, and it is duplicated between the fleet index and the cluster's own `namespaces` section.
This is the first place to look if memory ever needs to come down: the fleet index only needs the fields the applications and blast-radius views read.

**Throughput is flat and Redis is not the constraint.**
1.52 clusters/s end to end with four threads, and the per-cluster cost did not move between cluster 25 and cluster 900 despite the fleet hashes growing to 720,000 entries.
At a realistic 15 s per cluster collection the collector is more than twenty times slower than the whole generate-and-persist path measured here, exactly as ADR-0003 Finding 1 says.

## What this changes

1. The capacity model in ADR-0001 should be restated by composition: detail blobs compress 12.8x, fleet index entries cost about 1 KB each, and the ledger costs 0.19 MB per cluster.
2. `namespaces(ns_class="application")` must be paginated before this ships to 900 clusters; 4.7 s for one unfiltered request is the single measured defect in the read path.
   Team-filtered and app-filtered reads are already fine at 22 ms, so the fix is a `limit` and cursor on the unfiltered case, not a new index.
3. Excluding the service CA from the certificate index is worth doing on its own merits and would return roughly 0.3 GB.
4. The 16 GB HA pair stays the recommendation, with the alert at 70% and the fleet at 30%.

## How to reproduce

```sh
docker run -d --name odl-synth-redis -p 16379:6379 redis:7-alpine \
  redis-server --save "" --appendonly no --maxmemory-policy noeviction

cd data-layer

# unit tests: the whole pipeline at a tiny scale against fakeredis
.venv/bin/python -m pytest -q tests/test_synth_load.py
.venv/bin/ruff check scripts tests/test_synth_load.py

# smoke, about 15 seconds
.venv/bin/python -m scripts.synth_load --clusters 20 --workers 4 --flush

# the run this document reports, about 10 minutes and 4.8 GB
.venv/bin/python -m scripts.synth_load --clusters 900 --workers 4 --flush \
  --report /tmp/synthetic-load-900.md

docker rm -f odl-synth-redis
```

The tables above are that report's output; the prose around them is commentary, so write the script's report somewhere else rather than over this file.
The run is deterministic for a given `--seed` (default 1).
`--apps` and `--scale` move the per-cluster sizes, and `--clusters` moves the fleet size.
Memory is close to linear in `--clusters` but slightly sub-linear: the 20-cluster smoke used 117 MB (5.9 MB per cluster) and the 900-cluster run used 4.79 GB (5.4 MB per cluster), because the shared index keys amortise as the fleet grows (21,490 config-reference keys at 900 clusters against 16,256 at 20, and 17,941 image keys against 12,452).
A linear extrapolation from a small run is therefore conservative by roughly 10%, which is the right direction for a capacity estimate.

Environment for the numbers above: Redis 7 Alpine in Docker on a macOS host, 4 worker threads, one Redis connection each, 12 hubs, seed 1.
