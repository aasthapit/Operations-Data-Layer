# data-layer/scripts

Operational scripts that are not part of the served application.
Run them from `data-layer/` with the project virtualenv.

## `synth_load.py` - synthetic load test for the Redis store

Answers one question with measurements instead of estimates: what does the Redis store actually cost at 900 clusters, and how fast is it to write and to read?

It generates realistic collector documents, runs the same health checks the collector runs, persists every cluster through the real `RedisStore`, and reports Redis memory, key counts, write throughput and read latency.
Nothing talks to a cluster: the point is to measure the store, not the collector.

The latest measured run is written up in [`docs/adr/synthetic-load-900.md`](../../docs/adr/synthetic-load-900.md).

### What it generates

`generate_document(name, rng, profile)` returns a document in the exact shape `app/collector/collect.py:assemble()` produces: the top-level cluster fields, a `capacity` dict, a `resource_status` dict, and the lists `operators`, `nodes`, `namespaces`, `workloads`, `workload_images`, `workload_refs`, `pod_issues` and `resources`.
Rows carry the same field names the former ORM columns had, and per-kind `summary` payloads mirror the parsers in `app/collector/parsers.py`.

Per cluster at the defaults (`--apps 250 --scale 1.0`), matching the production cluster described in ADR-0003:

| | Count |
|---|---:|
| Application namespaces | 250 |
| Platform namespaces | 70 |
| Workloads | 1,700 |
| Nodes | 30 |
| Cluster operators | 35 |
| Pod issues | 50 |
| Inventory objects (`resources`) | 16,633 |
| Rows in total | ~26,700 |

The fleet is a fleet and not 900 unrelated clusters: applications come from a pool of 3,000 (so one application runs on many clusters), teams from a pool of 150, and container images from a pool of 30,000 - so blast-radius queries fan out the way they do in production.
Certificate material, ConfigMap and Secret values and container env values are never generated, because they are never stored: only names, key names, byte sizes and certificate facts are.

Statuses are drawn with realistic frequencies, so the load exercises the status sets the store maintains: a few percent of quotas are `warning` or `exhausted`, ~2.5% of routes are `rejected`, some ClusterServiceVersions are not `succeeded`, an occasional MachineConfigPool is `degraded`, and a small share of clusters carry a degraded operator, an unready node or a certificate expiring inside 30 days.

### Sizes are parameterisable

| Flag | Default | Meaning |
|---|---|---|
| `--clusters` | 900 | clusters to generate and persist |
| `--apps` | 250 | application namespaces per cluster |
| `--scale` | 1.0 | multiplier on the per-cluster inventory counts |
| `--hubs` | 12 | hubs the clusters are spread over |
| `--workers` | 4 | persist threads, one Redis connection each |
| `--seed` | 1 | random seed (the whole run is reproducible) |
| `--redis-url` | `redis://localhost:16379/0` | where to load |
| `--report` | - | write the Markdown report to this path |
| `--flush` | off | `FLUSHDB` before loading |
| `--latency-iters` | 20 | iterations per timed call |
| `--latency-budget` | 60 | seconds per timed call before stopping early |
| `--api-base` | `http://localhost:18001` | API stack to time, if it serves the loaded Redis |
| `--no-http` | off | skip the HTTP measurements |

### Running it

Never load a synthetic fleet into a stack's Redis: use a throwaway server.

```sh
docker run -d --name odl-synth-redis -p 16379:6379 redis:7-alpine \
  redis-server --save "" --appendonly no --maxmemory-policy noeviction

cd data-layer
.venv/bin/python -m scripts.synth_load --clusters 20 --flush            # smoke
.venv/bin/python -m scripts.synth_load --clusters 900 --workers 4 --flush \
  --report /tmp/synthetic-load-900.md

docker rm -f odl-synth-redis
```

Both entry points work: `python -m scripts.synth_load ...` and `python scripts/synth_load.py ...`.

Expect roughly 5 GB of Redis memory and about ten minutes at 900 clusters on a laptop.
The HTTP measurements only run when the API at `--api-base` is answering **and** serves the same cluster count as the Redis that was just loaded; otherwise the script reports store-level latencies only and leaves the API alone.

### What it reports

- documents generated, generation time, persist throughput (clusters/s and MB of compressed sections/s), total wall time;
- `INFO memory` (`used_memory_human`, `used_memory_rss_human`, `mem_fragmentation_ratio`), `DBSIZE`;
- for one sample cluster, `MEMORY USAGE` of the summary key and each section key next to the raw JSON size of the same document, giving the compression ratio;
- `HLEN` and `MEMORY USAGE` of the largest fleet hashes;
- memory by key class, sampled with one `SCAN ... MATCH` pass per class (up to 20,000 keys measured per class, extrapolated by key count);
- store-level read latency (p50/p95) for the calls the API read paths are built on, and HTTP latency when the API is pointed at the loaded Redis.

### Tests

`tests/test_synth_load.py` runs the whole pipeline (generate, health check, persist, report) at a tiny scale against `fakeredis`, so drift in `assemble()` or in the store fails fast instead of forty minutes into a 900-cluster run.

```sh
cd data-layer && .venv/bin/python -m pytest -q tests/test_synth_load.py
```
