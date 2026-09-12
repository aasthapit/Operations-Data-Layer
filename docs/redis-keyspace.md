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
| `odl:{c:<name>}:sec:<section>` | STRING | Compressed JSON list of rows for one section. Sections: `operators`, `nodes`, `namespaces`, `workloads`, `workload_images`, `workload_refs`, `pod_issues`, `resources`, `resource_status`, `health_checks`. Rows carry the same field names as the former ORM columns. |
| `odl:{c:<name>}:snapshots` | ZSET | Health/utilization history. Score = epoch seconds, member = JSON snapshot (includes `snapshot_at`). Trimmed to `SNAPSHOT_RETENTION`. |
| `odl:{c:<name>}:ledger` | STRING | Compressed JSON list of `[op, key, member]` describing every fleet-index member this cluster contributed on its last write (`op` in `sadd`, `hset`, `zadd`, `hincr`). Read and reversed before the next write. Never expires: when the cluster's other keys age out, the ledger is what lets `prune_vanished` unpublish its fleet-index members. |
| `odl:{c:<name>}:lock` | STRING | `SET NX PX` single-flight lock for on-demand refresh of one cluster. |

Sections are independent keys so `/api/clusters/{name}/nodes` never decompresses the resources section.

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

Fleet-indexed resource kinds: `resourcequotas`, `machineconfigpools`, `clusterserviceversions`, `subscriptions`, `persistentvolumeclaims`, `persistentvolumes`, `storageclasses`, `routes`, `events`, `clusterrolebindings`.
Every other kind (`configmaps`, `secrets`, `services`, `ingresses`, `networkpolicies`, `cronjobs`, `horizontalpodautoscalers`) is large, rarely queried fleet-wide, and is only read from the per-cluster `resources` section; a fleet-wide inventory query over such a kind iterates clusters and stops at the requested limit.

## Write protocol (one cluster)

1. Assemble the new summary hash, the ten section blobs, the snapshot, and the list of fleet-index contributions.
2. Read the previous ledger.
3. In one `MULTI`: reverse every ledger entry (`SREM` / `HDEL` / `ZREM` / `HINCRBY -1`), write the summary (`DEL` + `HSET`), write the sections, `ZADD` the snapshot and `ZREMRANGEBYRANK` to retention, apply every new contribution, write the new ledger, `SADD` the cluster into `odl:{fleet}:clusters`, `EXPIRE` all per-cluster keys to `REDIS_TTL_SECONDS`, `EXEC`.
4. A cluster that is unreachable is still written (summary with `reachable=false`, empty sections) so it stays visible; its previous fleet contributions are removed.

Deleting a cluster (`prune_vanished`) reverses its ledger and deletes its keys in one `MULTI`.
At the end of a sweep the refcount hashes (`idx:ops`, `idx:images`) are swept of entries at or below zero, and `idx:image:names` loses the same fields.

## Read patterns

| API question | Redis operations |
|---|---|
| Fleet overview, health by dimension, versions, capacity | `SMEMBERS clusters` then pipelined `HGETALL summary` (one round trip). |
| List clusters with filters | `SINTER` of the dimension sets, then pipelined `HGETALL`. |
| Cluster detail / nodes / namespaces / workloads / resources | `HGETALL summary` + `GET` of the needed sections. |
| Timeline | `ZRANGE snapshots -N -1`. |
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
- History belongs in the per-cluster ZSET only at cluster granularity. Per-namespace utilization history is a metrics-plane question and is not stored in Redis.
