# Redis keyspace

The data layer keeps the collected fleet state in Redis instead of Postgres.
This document is the contract between the collector (the only writer) and the API (the only reader).
The store code in `data-layer/app/store/` must match it exactly; change both together.

## Principles

- **Redis is a read cache fed by pull.** The collector pulls from each cluster's API server on a schedule (or on demand) and writes a complete, self-consistent picture of that cluster in one transaction.
  The API never touches a cluster; it only reads Redis.
- **The unit of write is one cluster.** Every key that belongs to a cluster is replaced atomically on every sweep (MULTI/EXEC), so a reader never sees half a cluster.
- **Per-cluster detail is stored as compressed section blobs, not as one key per object.** A cluster with 20k inventory objects is a handful of keys of a few hundred KB, not 20k keys.
  Detail endpoints read one section and filter in process.
- **Fleet-wide questions are served by fleet indexes, never by scanning every cluster's detail.** Each cluster contributes members to the fleet indexes on write and removes exactly those members on the next write (a per-cluster ledger records what it contributed).
- **Nothing is evicted, things expire.** The Redis instance runs with `maxmemory-policy noeviction`: a cache that silently drops a cluster would answer blast-radius questions wrongly.
  Per-cluster keys carry a TTL (`REDIS_TTL_SECONDS`, default 24h) so a cluster that is never collected again ages out; readers tolerate index members whose cluster has expired.
- **Cluster-mode ready.** Per-cluster keys share the hash tag `{c:<name>}`; fleet keys share `{fleet}`. A cluster's own write is therefore always single-slot; fleet index updates are cross-slot and are issued as a second pipeline when running against Redis Cluster (single-node Redis runs everything in one MULTI).

All keys start with the prefix `odl` (`REDIS_PREFIX`). `<name>` is the cluster name. Encoded values are JSON; sections and ledgers are zlib-compressed JSON (`z:` prefix byte marks compression).

## Per-cluster keys (hash tag `{c:<name>}`)

| Key | Type | Content |
|---|---|---|
| `odl:{c:<name>}:summary` | HASH | Every field of the former `clusters` row (placement, version, capacity, rollups, health, `last_synced`, `collect_ms`, `reachable`, `last_error`, `hub_name`). Scalars as strings, lists/dicts as JSON. |
| `odl:{c:<name>}:sec:<section>` | STRING | Compressed JSON list of rows for one section. Sections: `operators`, `nodes`, `namespaces`, `workloads`, `workload_images`, `workload_refs`, `pod_issues`, `resources`, `resource_status`, `health_checks`. Rows carry the same field names as the former ORM columns, plus `value` and `levels` on a `health_checks` row (what the check measured and the levels that applied). |
| `odl:{c:<name>}:snapshots` | ZSET | Per-sweep history. Score = epoch seconds, member = JSON snapshot row (health, utilization, what was going wrong, `snapshot_at`, `resolution: "sweep"`). Trimmed to the last `SNAPSHOT_RAW_HOURS` (48h) by score, and to `SNAPSHOT_RETENTION` rows as a safety net. |
| `odl:{c:<name>}:snapshots:hourly` | ZSET | The same rows rolled up per hour. Score = epoch seconds of the hour start, one member per hour. Trimmed to `SNAPSHOT_HOURLY_DAYS` (90d). |
| `odl:{c:<name>}:snapshots:daily` | ZSET | The same rolled up per day. Score = epoch seconds of midnight UTC. Trimmed to `SNAPSHOT_DAILY_DAYS` (730d). |
| `odl:{c:<name>}:changes` | STREAM | What changed between sweeps, one entry per change: fields `at`, `kind`, `subject`, `before`, `after`, `message`, each JSON-encoded so types survive. `XADD MAXLEN ~ 5000`. |
| `odl:{c:<name>}:ledger` | STRING | Compressed JSON list of `[op, key, member]` describing every fleet-index member this cluster contributed on its last write (`op` in `sadd`, `hset`, `zadd`, `hincr`). Read and reversed before the next write. Never expires: when the cluster's other keys age out, the ledger is what lets `prune_vanished` unpublish its fleet-index members. |
| `odl:{c:<name>}:lock` | STRING | `SET NX PX` single-flight lock for on-demand refresh of one cluster. |

Sections are independent keys so `/api/clusters/{name}/nodes` never decompresses the resources section.

### History: three tiers and a change log

Everything above is the state as of the last sweep.
The history keys are the exception, and they are what answers "was it like this yesterday?".

**Snapshots are tiered by time, not capped by row count.**
A trend question asks for a span, and how many rows a span holds is a consequence of the sweep interval, not something a caller should have to know.
So each tier is trimmed by its own window: every sweep for two days, every hour for three months, every day for two years.
`SNAPSHOT_RETENTION` remains only as a safety net on the per-sweep tier, so a pathologically short sweep interval cannot grow one cluster without bound.

The rollup rules are in `data-layer/app/store/history.py` and are chosen per field, because a mean and a max say different things:

| Field group | Rule | Why |
|---|---|---|
| Counters (`crashloops`, `image_pull_errors`, `oom_killed`, `pending_pods`, `pod_issues`, `warning_events`, `checks_failed`, `operators_degraded`, `restarts_total`, `certs_expiring_total`) | max over the bucket | A ten-minute spike must survive into the daily row; an average would hide it. |
| Gauges (`health_score`, `overall_status`, `ocp_version`, `nodes_total`, `nodes_ready`, `pods_running`, `applications_total`, ...) | last in the bucket | "What was it on Tuesday" means where it ended up. |
| Utilization (`cpu_usage`, `memory_usage`) | mean, plus `cpu_usage_max` / `memory_usage_max` | Capacity planning wants the typical value and the peak. A mean alone makes every cluster look idle. |
| Name lists (`checks_failed_names`, `checks_warned_names`) | union | "Which checks failed at any point today" is the useful question. |
| `events_by_reason` | max per reason, top 10 kept | Each sweep re-counts the same events, so summing would multiply them by the sweep rate. |
| `upgrading` | true if true anywhere in the bucket | An upgrade that starts and finishes inside one day still happened that day. |

Rolling hourly rows into a daily one applies the same rules, with the mean weighted by each row's `samples`, so a daily mean is the true mean of the raw samples and not a mean of means.
Every row carries `resolution` and `samples`, so a reader can always tell a rollup from a sweep and how much is behind it.

The current bucket of each coarse tier is **provisional**: it is written as soon as the first sample of the hour or day lands, and recomputed when the bucket closes.
A question about the last few minutes belongs to the per-sweep tier, which is exact.

**Memory at 800 clusters**, at roughly 300 bytes per row:

| Tier | Rows per cluster | Rows at 800 clusters | Approximate memory |
|---|---|---|---|
| sweep (48h at a 2-minute interval) | 1,440 | 1.15M | ~350 MB |
| hourly (90 days) | 2,160 | 1.73M | ~520 MB |
| daily (2 years) | 730 | 0.58M | ~175 MB |

That is roughly 1 GB of history for the whole estate, against which the coarse tiers are what make the two-year window affordable at all: storing two years of sweeps would be 500x the daily tier.
Shorten `SNAPSHOT_HOURLY_DAYS` first if that budget is too large; it is the biggest of the three.

**Changes are a stream, not a ZSET**, because they are an append-only log with no natural key and `XADD MAXLEN ~` trims in whole nodes without a read.
The entry id is Redis's own (`*`), and the record's `at` field is the truth about when the change happened, which is what a windowed read filters on.
Change kinds are a fixed vocabulary: `version`, `status`, `check`, `operator`, `nodes`, `namespace`, `application`, `upgrade`, `reachability`.
Two rules keep the log honest: a cluster seen for the first time records nothing (everything would read as "appeared"), and an unreachable sweep records only its reachability, because its sections are empty and every check would otherwise look recovered.

## Fleet keys (hash tag `{fleet}`)

| Key | Type | Content |
|---|---|---|
| `odl:{fleet}:clusters` | SET | Names of known clusters. |
| `odl:{fleet}:hubs` | HASH | hub name -> JSON hub row. |
| `odl:{fleet}:idx:cluster:<dim>:<value>` | SET | Cluster names by dimension. `dim` in `region`, `datacenter`, `environment`, `hub`, `version`, `status`. List filters are `SINTER` over these. |
| `odl:{fleet}:idx:op:<operator>` | HASH | cluster name -> JSON `{version, available, progressing, degraded, critical, message}`. One `HGETALL` answers "who runs operator X at version Y / degraded". |
| `odl:{fleet}:idx:ops` | HASH | operator name -> refcount (clusters reporting it). Cleaned of zero counts at sweep end. |
| `odl:{fleet}:ns` | HASH | `<cluster>\|<namespace>` -> JSON namespace row (both classes). Feeds applications, blast radius and top-N. |
| `odl:{fleet}:idx:ns:app:<app>` | SET | `<cluster>\|<namespace>` members for one application. |
| `odl:{fleet}:idx:ns:team:<team>` | SET | `<cluster>\|<namespace>` members for one team. |
| `odl:{fleet}:idx:ns:class:<class>` | SET | `<cluster>\|<namespace>` members per class (`application`, `platform`). |
| `odl:{fleet}:idx:ns:cpu` / `:mem` | ZSET | Score = live usage, member = `<cluster>\|<namespace>`. Top-N namespaces is `ZREVRANGE`. |
| `odl:{fleet}:nodes` | HASH | `<cluster>\|<node>` -> JSON node row. |
| `odl:{fleet}:idx:node:cpu_pct` / `:mem_pct` | ZSET | Score = utilisation percent, member = `<cluster>\|<node>`. |
| `odl:{fleet}:podissues:<class>` | HASH | `<cluster>\|<namespace>\|<pod>` -> JSON pod issue row, per namespace class. `HLEN` gives the summary counters. |
| `odl:{fleet}:res:<key>` | HASH | `<cluster>\|<namespace>\|<name>` -> JSON resource row, for the fleet-indexed kinds only (below). |
| `odl:{fleet}:res:<key>:status:<status>` | SET | Members of the hash above with that status. `SCARD` gives counters; status filters are `SMEMBERS` + `HMGET`. |
| `odl:{fleet}:certs` | HASH | `<cluster>\|<namespace>\|<key>\|<name>` -> JSON resource row for every certificate-bearing Secret / ConfigMap. |
| `odl:{fleet}:idx:cert:expires` | ZSET | Score = expiry epoch, member as above. Expiring-soon is `ZRANGEBYSCORE`, counters are `ZCOUNT`. |
| `odl:{fleet}:idx:images` | HASH | lowercased image string -> refcount across the fleet. Substring search is `HSCAN MATCH *needle*` against the lowercased field, which is what makes it case-insensitive. Zero counts are cleaned at sweep end. |
| `odl:{fleet}:idx:image:names` | HASH | lowercased image string -> the image as the workload spells it. A refcount and a display string cannot share one hash value, and the alias is shared by every cluster running that image, so it is not ledgered: it is deleted alongside its refcount at sweep end. |
| `odl:{fleet}:idx:image:<sha1(image)>` | SET | `<cluster>\|<namespace>\|<kind>\|<workload>\|<container>` usages of one image. |
| `odl:{fleet}:idx:ref:<kind>:<name>` | SET | `<cluster>\|<namespace>\|<wkind>\|<wname>\|<via>` workloads referencing a Secret / ConfigMap / PVC / ServiceAccount of that name. |
| `odl:{fleet}:runs` | LIST | Newest-first JSON collection runs, trimmed to 200. |
| `odl:{fleet}:run:last` | STRING | JSON of the last run summary (`at`, `ok`, `trigger`). |
| `odl:{fleet}:dashboards` | HASH | dashboard id -> JSON query-dashboard definition (variables and panels; see [docs/nl-query.md](nl-query.md)). The one key here that is not collected fleet state: it holds what people wrote, so nothing in the sweep touches it, it is never expired and it is not ledgered. Built-in dashboards ship as YAML in `data-layer/config/dashboards/` and are not in Redis. |

Fleet-indexed resource kinds: `resourcequotas`, `machineconfigpools`, `clusterserviceversions`, `subscriptions`, `persistentvolumeclaims`, `persistentvolumes`, `storageclasses`, `routes`, `events`, `clusterrolebindings`.
Every other kind (`configmaps`, `secrets`, `services`, `ingresses`, `networkpolicies`, `cronjobs`, `horizontalpodautoscalers`) is large, rarely queried fleet-wide, and is only read from the per-cluster `resources` section; a fleet-wide inventory query over such a kind iterates clusters and stops at the requested limit.

## Write protocol (one cluster)

1. Assemble the new summary hash, the ten section blobs, the snapshot row, and the list of fleet-index contributions.
2. Read, in one pipeline, everything this write compares itself against: the ledger, the previous summary, the newest per-sweep row, the newest hourly row, whether the current hour and day buckets already exist, and the previous `operators` section.
   The previous application namespaces are not read: they are recovered from the ledger, which already records the namespace-class and per-application set members this cluster published, so a large namespaces section is never decompressed just to notice that a namespace appeared.
3. Decide what to roll up, and diff the summary against the previous one to produce change records.
   When an hour or a day has closed, a second pipelined read fetches that bucket's source rows.
   At a two-minute sweep that happens once an hour per cluster; the steady-state write does one read pipeline and one write pipeline.
4. In one `MULTI`: reverse every ledger entry (`SREM` / `HDEL` / `ZREM` / `HINCRBY -1`), write the summary (`DEL` + `HSET`), write the sections, `ZADD` the snapshot, replace each recomputed hourly / daily bucket (`ZREMRANGEBYSCORE` on the bucket score, then `ZADD`), `ZREMRANGEBYSCORE` each tier to its window, `ZREMRANGEBYRANK` the per-sweep tier to `SNAPSHOT_RETENTION`, `XADD` every change record, apply every new contribution, write the new ledger, `SADD` the cluster into `odl:{fleet}:clusters`, `EXPIRE` all per-cluster keys to `REDIS_TTL_SECONDS`, `EXEC`.
5. A cluster that is unreachable is still written (summary with `reachable=false`, empty sections) so it stays visible; its previous fleet contributions are removed and the only change record it produces is its reachability.

Deleting a cluster (`prune_vanished`) reverses its ledger and deletes its keys in one `MULTI`.
At the end of a sweep the refcount hashes (`idx:ops`, `idx:images`) are swept of entries at or below zero, and `idx:image:names` loses the same fields.

## Read patterns

| API question | Redis operations |
|---|---|
| Fleet overview, health by dimension, versions, capacity | `SMEMBERS clusters` then pipelined `HGETALL summary` (one round trip). |
| List clusters with filters | `SINTER` of the dimension sets, then pipelined `HGETALL`. |
| Cluster detail / nodes / namespaces / workloads / resources | `HGETALL summary` + `GET` of the needed sections. |
| Timeline (last N sweeps) | `ZRANGE snapshots -N -1`. |
| Timeline over a window, at any tier | `ZRANGEBYSCORE snapshots[:hourly|:daily] <since> <until>`; fleet-wide, one pipelined call per cluster (`snapshots_across`). |
| Change log | `XREVRANGE changes + - COUNT n`, filtered on each record's `at`; fleet-wide, one pipelined `XREVRANGE` per cluster, merged newest first. |
| Applications (fleet) | `SMEMBERS idx:ns:class:application` (or team / app set) + `HMGET ns`. |
| Blast radius | `SMEMBERS idx:cluster:version:X`, `HGETALL idx:op:X`, `HGETALL res:clusterserviceversions`, `HSCAN idx:images MATCH`, `SMEMBERS idx:image:<sha1>`; then `HGETALL summary` and the namespaces of the matched clusters. |
| Certificates | `ZRANGEBYSCORE idx:cert:expires` + `HMGET certs`. |
| Pod issues, quotas, MCPs, OLM, storage, routes, events, cluster admins | `HGETALL res:<key>` / `podissues:<class>`, filtered in process; status-only queries use the status sets. |
| Images | `HSCAN idx:images MATCH *x*` (needle lowercased), `HMGET idx:image:names` for the strings as spelled, then `SMEMBERS idx:image:<sha1>` per hit. |
| References | `SMEMBERS idx:ref:<kind>:<name>`; without a name, iterate clusters' `workload_refs` sections. |
| Top namespaces / nodes | `ZREVRANGE idx:ns:cpu 0 N` + `HMGET ns`. |

## Scale notes (900 clusters, hundreds of applications each)

Per-cluster keys grow with the cluster; fleet keys grow with the fleet. Estimated sizes are in ADR-0001.
The design choices that matter at that scale:

- Sections are compressed blobs, so the dominant cost (inventory rows) is ~10x smaller than one-key-per-object and one round trip per section.
- Fleet hashes for `ns`, `nodes`, `routes`, `events` reach 10^5 to 10^6 entries. Reads that `HGETALL` them must paginate (`HSCAN`) and endpoints that list them fleet-wide need `limit` + cursor parameters; the counters come from `SCARD` / `HLEN` / `ZCOUNT`, never from loading the hash.
- The collector is sharded by hub; each shard writes its own clusters' keys. Fleet indexes are shared and only ever touched through ledgers, so shards never conflict.
- History belongs in the per-cluster ZSETs only at cluster granularity, and is tiered by time (see above), so two years of it costs about 1 GB across the estate. Per-namespace utilization history is a metrics-plane question and is not stored in Redis.
- History rolls up inside the write that notices the boundary, not in a background job. Nothing has to be scheduled, a collector that stops leaves the tiers consistent, and the extra read happens once an hour per cluster rather than once per sweep.
