# Operations Data Layer

A cloud data layer for an OpenShift fleet: it discovers clusters across multiple
ACM hubs, reads everything the manifest enables from each cluster's own API
server (versions, operators, nodes, namespaces, workloads, configuration
references, certificates, storage, routes, OLM operators, machine config pools,
events, and live utilization via `metrics.k8s.io`), runs precondition health
checks, records it all into a database with sensitive values scrubbed, and
serves it through a REST API, a web dashboard, and an MCP server.

The headline questions it answers:

* **What is healthy?** Per region / data center / environment / version, what is
  green, what is degraded, what is mid-upgrade.
* **What needs attention?** Expired or expiring certificates, crashlooping or
  unschedulable pods (platform vs application), quotas near their limit,
  degraded machine config pools, failed OLM installs, pending PVCs, warning
  events, capacity headroom.
* **What is the blast radius?** Given a bad OCP version, cluster operator, OLM
  operator, or container image, which clusters carry it - and which
  applications, teams and workloads ride on top.
* **Who depends on this?** Which workloads reference a Secret or ConfigMap,
  which storage class a claim rides on, who holds cluster-admin.

Everything comes from the OCP API. There is no Prometheus, Thanos or external
dependency, and ConfigMap / Secret values, certificate material and env values
are never collected (see **[docs/ocp-api-manifest.md](docs/ocp-api-manifest.md)**).

## Architecture

```
┌─ Fleet (kind, Docker) ──────────────────────────────────────┐
│  hub-east (ACM)              hub-west (ACM)                  │
│   └ ManagedCluster CRs        └ ManagedCluster CRs           │
│  ocp-east-1..4               ocp-west-1..4                   │
│   └ ClusterVersion            └ ClusterVersion               │
│   └ ClusterOperators (~24)    └ ClusterOperators             │
│   └ Infrastructure (region)   └ Infrastructure               │
│   └ applications (namespaces) └ applications                 │
└──────────────────┬──────────────────────────────────────────┘
                   │  collector polls hubs → managed clusters
┌──────────────────▼─ Data Layer (FastAPI + Redis) ───────────┐
│  Collector (APScheduler): discover via ACM → pull CRs →     │
│    run precondition health checks → upsert + snapshot        │
│  Redis: one cluster replaced per transaction - summary,      │
│    compressed detail sections, snapshots, fleet indexes      │
│  Query snapshot: DuckDB rebuilt from Redis after each sweep, │
│    Claude writes SQL for natural-language questions.         │
│  Cache/refresh: periodic poll + POST /api/refresh.           │
│                 Reads are always served from Redis.          │
└──────────────────┬──────────────────────────────────────────┘
                   │  REST
┌──────────────────▼─ Dashboard (React + nginx) ──────────────┐
│  Fleet health by region/DC · version distribution ·         │
│  cluster detail (checks/operators/apps) · blast radius       │
└─────────────────────────────────────────────────────────────┘
```

### Why kind clusters

Real OpenShift can't run small-and-many on a laptop (CRC is a single ~9 GB
cluster). So the fleet uses **kind** clusters that wear OpenShift's data model:
each is a genuine Kubernetes API server carrying the real OpenShift CRDs
(`ClusterVersion`, `ClusterOperator`, `Infrastructure`) and, on the hubs, the
real ACM `ManagedCluster` CRD. The collector talks to genuine Kubernetes APIs
and reads genuine custom resources - it has no idea it isn't talking to OCP.

Each managed cluster also runs `metrics-server`, so `metrics.k8s.io` is served
exactly as OpenShift serves it via `prometheus-adapter`, and carries the full
namespace / workload / configuration footprint the collector reads (real TLS
certificates at varied expiry, quotas, routes, OLM operators, machine config
pools, crashlooping and unschedulable pods, and so on) so every insight is
exercised end to end.

Pointing this at real ACM hubs later is purely a matter of swapping the
kubeconfigs in `data-layer/config/hubs.yaml`; no code changes.

## Quick start

Prerequisites: Docker, [kind](https://kind.sigs.k8s.io/), kubectl, Python 3,
and ~6-10 GB of memory available to Docker for the fleet.

```sh
make fleet-venv      # one-time: python venv for the fleet tooling
make fleet-up        # create + seed 2 hubs and 8 managed clusters (a few minutes)
make up              # build + start redis, api, dashboard

# Dashboard:  http://localhost:8080      (Overview · Clusters · Applications · Versions · Utilization · Insights · Blast radius · Patching · Collected)
# API + docs: http://localhost:18000/docs   (mapped off 8000 to avoid conflicts)
# Patching:   http://localhost:18010/docs   (system of record: jobs, approvals, audit)
# MCP:        http://localhost:18080/mcp
# N8N:        http://localhost:5678      (import patching/n8n-patching-workflow.json)
```

Inventory, configuration and utilization all come from one source - each
cluster's API server - and are served from Redis. Run `make dl-venv` once,
then `make test` and `make lint` for the data layer.

Natural-language questions (`POST /api/query/ask`) need `ANTHROPIC_API_KEY` set in the `api` service's environment.
Everything else - the whole REST API, the dashboard, the MCP server, and `POST /api/query/sql` for running your own SQL - works without it; `/ask` just answers 503 until a key is set.
To run a second stack alongside this one without port clashes (a worktree, a review build), set `ODL_API_PORT`, `ODL_DASHBOARD_PORT`, `ODL_PATCHING_PORT`, `ODL_MCP_PORT` and `ODL_N8N_PORT` before `make up`, e.g. `ODL_API_PORT=18001 ODL_DASHBOARD_PORT=8081 make up`.

### Ad-hoc development (honcho)

For a fast loop without rebuilding images, run the pieces as plain processes with [honcho](https://github.com/nickstenning/honcho):

```sh
make dev-venv        # one-time: venvs, honcho, dashboard node_modules, .env from .env.example
make dev             # redis + collector (containers), hot-reloading API, Vite dashboard, MCP server
```

`Procfile` defines the processes and `.env` (read by docker compose, honcho and make alike) defines every port, so `make dev-api`, `make dev-ui` or `make dev-mcp` run one of them in isolation.
The kind clusters resolve only inside Docker's `kind` network, so collection always runs in the container; the host API starts with `COLLECTOR_ENABLED=false` and serves Redis read-only (its refresh endpoints answer 409), reloading on every code change.
Defaults: host API http://localhost:18002/docs, Vite dashboard http://localhost:5174, MCP http://localhost:18082/mcp, Redis on localhost:16379.
Ad-hoc queries without a browser: `make sql Q="select name, overall_status from clusters"` and `make ask Q="which clusters are critical"`.

### Running without Docker (real clusters, your own Redis)

The container stack exists for the simulated kind fleet.
Against real OpenShift clusters nothing needs Docker: the API with its collector, the dashboard and the MCP server are plain processes, and Redis can be any instance you already run.

```sh
make dev-venv                                          # python venvs, honcho, dashboard node_modules, .env
cp data-layer/config/acm.example.yaml data-layer/config/acm.yaml             # your ACM hubs (git-ignored); ManagedClusters are discovered
# or: cp data-layer/config/clusters.example.yaml data-layer/config/clusters.yaml   # a direct list of endpoints instead
```

Then in `.env`:

```sh
REDIS_URL=rediss://odl:change-me@redis.example.internal:6380/0   # or redis://localhost:16379/0
ODL_CONFIG=config/acm.yaml                                       # relative to data-layer/ (defaults to acm.yaml if present, else clusters.yaml)
ODL_MANIFEST=config/ocp-api-manifest.fleet.yaml                   # recommended: tiered collection (platform state every sweep, inventory every 15m)
OCP_USERNAME=svc-ops-data                                         # whatever the config references as ${VAR}
OCP_PASSWORD=...
```

and start it:

```sh
make local-remote      # live Redis: API + collector, Vite dashboard, MCP server
make local             # same, plus a local redis-server (brew install redis) on ODL_REDIS_PORT
```

No Redis yet and no wish to install one: `make redis-up` runs just the Redis container with docker or podman, whichever is installed (persisted volume, `127.0.0.1:16379`); set `REDIS_URL=redis://localhost:16379/0` and use `make local-remote`.
`REDIS_URL` accepts any redis-py URL (`redis://`, `redis://:password@`, `redis://user:password@`, `rediss://` for TLS); `REDIS_PREFIX` namespaces the keys on a shared instance and `REDIS_TTL_SECONDS` bounds how long an uncollected cluster stays visible.
The API is at http://localhost:18002/docs, the dashboard at http://localhost:5174 (its Patching tab needs the patching service, which is not part of this mode), the MCP server at http://localhost:18082/mcp.
`make local-api` runs only the API; set `COLLECTOR_ENABLED=false` in `.env` to run it read-only against a Redis that another instance fills.
Onboarding real clusters (service account, RBAC, TLS) is in [docs/onboarding.md](docs/onboarding.md).

If sweeps are slow: the log prints one line per cluster per sweep (`collect <name>: 4200ms (fetch 3900ms, assemble 300ms; 12 kinds fetched, 18 cached; slowest: secrets 1800ms, pods 900ms, ...)`), `GET /api/runs` shows whole-sweep durations, and `GET /api/manifest/availability` shows per cluster and per kind how long each list took, when it was last read and whether what is being served is cached.
Turn the schedule first: every manifest resource takes an `interval` (0 = every sweep, or a tier such as `15m` / `1h`), and a kind that is not due is not fetched at all - its rows stand until it is.
`ODL_MANIFEST=config/ocp-api-manifest.fleet.yaml` is the ready-made profile (platform state every sweep, inventory every 15 minutes, Secrets and ConfigMaps off); `POST /api/refresh?full=true` ignores every tier when you want one complete pass.
Then turn, in order: `COLLECT_WORKERS` (clusters in flight per instance, default 8; each holds one cluster's raw objects in memory), `COLLECT_FETCH_WORKERS` (kinds fetched in parallel within a cluster, default 6), `LIST_PAGE_SIZE` (default 500), and finally the manifest again, where a heavy kind you do not need (`secrets`, `configmaps`, `events`) can be disabled outright or limited to application namespaces.
A sweep in progress is visible as `sweep` on `GET /api/status` and `GET /api/health/overview` (`done` of `total`), and every cluster appears in the UI as soon as it is written.
For an estate of several ACM hubs, run one collector per hub against the same Redis: `COLLECT_HUBS=man01paa DEV_API_PORT=18002 make local-api`, `COLLECT_HUBS=man02paa DEV_API_PORT=18003 make local-api`, and so on.
Each instance discovers, collects and prunes only its own hubs' clusters, holds only its own hubs' credentials, and leaves the other hubs' rows to their owners (it still records that they exist, so the fleet view is whole); an unknown hub name is a startup error.
One collector per hub is the recommended shape for several hubs: on one machine `make local-hubs` generates `Procfile.hubs` from the hubs in your config (each process owns one hub through `COLLECT_HUBS`, on ports 18010, 18011, ...) and runs them with the dashboard and MCP pointed at the first; across machines, put the same `acm.yaml` on each and set `COLLECT_HUBS=<hub>` in that machine's `.env`.
For a hub with a hundred or more clusters, split it further with `COLLECT_SHARD=i/n`, which takes a slice of the owned clusters: `COLLECT_HUBS=man01paa COLLECT_SHARD=0/3 DEV_API_PORT=18002 make local-api`, `... COLLECT_SHARD=1/3 DEV_API_PORT=18003 ...`, and so on; shard 0 does the end-of-sweep housekeeping.

### ACM test topology (real OCM + Tekton)

Separate from the simulated fleet, `make acm-up` stands up a second, real-controller
estate for testing ACM-triggered pipeline execution: 2 OCM hubs (upstream of RHACM)
with 2 Tekton spokes each, joined via clusteradm. `make acm-smoke` proves the full
path: ManifestWork on a hub → work agent applies a PipelineRun on a spoke → Tekton
runs it → status feeds back to the hub. See
**[docs/acm-test-topology.md](docs/acm-test-topology.md)**. Budget ~7-9 GB; run one
fleet at a time on smaller Docker allocations.

## Documentation

- **[docs/onboarding.md](docs/onboarding.md)** - point a list of live OCP cluster endpoints at the data layer using a single shared service account (username/password). Config format, RBAC, TLS, verification.
- **[docs/architecture.md](docs/architecture.md)** - components, collection flow, auth flow, storage model, natural-language queries, blast radius, and deployment, with diagrams.
- **[docs/findings.md](docs/findings.md)** - notable findings: what only the OCP API can tell us versus Prometheus and logs, the scale numbers, store behaviour, and the read-only value the API can still add (ingress and egress posture, resilience, security) versus what needs an actions plane (dumps, exec).
- **[docs/redis-keyspace.md](docs/redis-keyspace.md)** - the Redis keyspace contract: every key, its type, and who writes and reads it.
- **[docs/nl-query.md](docs/nl-query.md)** - natural-language queries and dashboards: the DuckDB snapshot, the guard, the semantic layer, the batch endpoint, the dashboard definition format, the settings, and how to add a golden question or a dashboard.
- **[docs/adr/](docs/adr/)** - the architecture decision records: [Redis as the fleet state store](docs/adr/0001-redis-as-fleet-state-store.md), [natural-language queries](docs/adr/0002-natural-language-queries.md), [operating at enterprise scale](docs/adr/0003-enterprise-scale.md).
- **[docs/ocp-api-manifest.md](docs/ocp-api-manifest.md)** - the OCP API manifest: what is collected, the scrub policy, applications vs platform namespaces, utilization from `metrics.k8s.io`, RBAC generation, adding a resource.
- **[docs/insight-catalog.md](docs/insight-catalog.md)** - the questions a platform team asks, which are answered from the OCP API today, and the reasoning behind the "everything from the API, scrubbed" decision.
- **[docs/patching-workflow.md](docs/patching-workflow.md)** - the N8N patching orchestration design + data-layer integration contract (pre-check/monitor/post-check).
- **[docs/acm-test-topology.md](docs/acm-test-topology.md)** - the real OCM + Tekton kind topology for end-to-end pipeline-trigger testing (2 hubs, 4 spokes).
- **[docs/real-cluster-environments.md](docs/real-cluster-environments.md)** - what to request from a platform org for real OpenShift/RHACM validation environments.
- **[mcp-server/README.md](mcp-server/README.md)** - the MCP server that wraps the API so an agent can query the fleet in natural language.

Tear down:

```sh
make down            # stop the data layer stack
make fleet-down      # delete the kind clusters
```

## The fleet

`fleet/topology.yaml` is the single source of truth - hubs, managed clusters,
regions, versions, the operator set, and application placement. `profile`
controls the *raw* state seeded onto each cluster (`healthy`, `warning`,
`degraded`, `progressing`, `eol`); health is always **computed** by the
collector from that state, never seeded.

`fleet/fleet.py` provisions everything: creates the kind clusters, installs the
CRDs and metrics-server, seeds the resources, registers each managed cluster on
its hub (with a kubeconfig secret, as ACM does), and exports internal
kubeconfigs for the collector.

Each kind node costs roughly 1-1.5 GB of Docker disk and ~0.7 GB of memory. On
a laptop where that does not fit, bring up a subset - the provisioner skips
clusters that already exist and seeding is idempotent, so you can grow it later:

```sh
FLEET_CLUSTERS=hub-east,ocp-east-1,ocp-east-2,ocp-east-3 make fleet-up   # 1 hub, 3 managed
FLEET_PARALLEL=2 make fleet-up                                             # gentler on Docker
```

## The data layer

* `config/ocp-api-manifest.yaml` - **the OCP API manifest**: which resources
  are collected from every cluster (each with an `enabled` flag and an
  `interval`, its collection tier), how namespaces are classified as
  application vs platform, ownership labels, and health thresholds. See
  [docs/ocp-api-manifest.md](docs/ocp-api-manifest.md).
* `config/ocp-api-manifest.fleet.yaml` - the same manifest with a schedule, for
  a real estate: platform state every sweep, inventory every 15 minutes,
  Secrets and ConfigMaps off (`ODL_MANIFEST=config/ocp-api-manifest.fleet.yaml`).
* `app/collector/registry.py` - the closed list of resources the collector can
  read (group/version/plural/scope); RBAC is generated from it.
* `app/collector/scrub.py` - the non-configurable scrub policy: ConfigMap and
  Secret values, certificate material and env values never get past parsing.
* `app/collector/parsers.py` - one normaliser per resource kind.
* `app/collector/collect.py` - fetch every enabled resource from a cluster
  (recording collected / unavailable / forbidden per resource) and assemble the
  cluster document: pods and metrics roll up into namespaces and nodes,
  workloads yield image and config-reference edges.
* `app/collector/healthchecks.py`, `runner.py` - the precondition checks and
  the parallel scheduled sweep.
* `app/store/` - the keyspace contract and the Redis store: atomic per-cluster
  writes, fleet indexes, ledgers, TTL. See [docs/redis-keyspace.md](docs/redis-keyspace.md).
* `app/query/` - natural-language queries and dashboards: the DuckDB snapshot
  rebuilt from the store (`snapshot.py`), the semantic layer the model reads
  (`schema.py`), the guard that validates generated SQL (`guard.py`), the
  generate/execute loop (`llm.py`, `service.py`), and the dashboard format and
  its variable substitution (`dashboards.py`, `params.py`).
  See [docs/nl-query.md](docs/nl-query.md).
* `app/api/` - the REST surface.

### Applications = namespaces

Every namespace that is not an OpenShift / Kubernetes platform namespace is an
application. Identity, team and tier come from labels on the namespace (falling
back to the most common value across its workloads). Platform namespaces
(`openshift-*`, `kube-*`, `default`...) are collected and grouped separately,
so a crashlooping pod in `openshift-monitoring` is a platform signal while one
in `payments` is an application signal.

### Health checks

Each cluster runs a panel of precondition checks (pass / warn / fail at a
severity): ACM availability, ClusterVersion availability, critical operators
available, no degraded operators, nodes ready, node pressure / cordons,
supported version, upgrade in progress, operator drift, machine config pools,
platform pods, application pods, capacity headroom (live usage vs allocatable),
certificates valid, quota headroom, OLM operators installed, update available.
The worst result sets the cluster's overall status; a per-cluster health score,
utilization and history are recorded each sweep.

### Refresh / cache strategy

The collector polls on an interval (`REFRESH_INTERVAL_SECONDS`, default 120s) and on demand via `POST /api/refresh`.
A sweep collects what is **due**: every manifest resource has its own `interval` (0 = every sweep), so platform state stays fresh while inventory is re-read on its own tier and the previous rows stand in between - `?full=true` forces a complete pass.
One cluster can also be refreshed on its own via `POST /api/clusters/{name}/refresh`, behind a single-flight lock, without waiting for the next sweep.
The API never touches a cluster on the read path - it serves the last collected snapshot from Redis, so reads are fast and the cluster API load is bounded by the poll interval.
Every cluster summary carries `last_synced`, `age_seconds` and `stale`, so the API never hides that it is serving a cache.
Per-cluster keys expire (`REDIS_TTL_SECONDS`, default 24h) and Redis runs with `maxmemory-policy noeviction` - a cluster that is never collected again ages out instead of being silently dropped.
Every sweep also appends a health snapshot per cluster, powering the timeline.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/health/overview` | fleet totals, hub status, last collection |
| `GET /api/health/summary?group_by=region\|datacenter\|environment\|hub\|version` | health rolled up by dimension |
| `GET /api/clusters?region=&environment=&status=&version=&team=` | filterable cluster list with utilization, issues, certs |
| `GET /api/clusters/{name}` | full detail: platform config, capacity, checks, operators, nodes, namespaces, pod issues, what was collected |
| `GET /api/clusters/{name}/nodes` · `/namespaces?class=` · `/workloads?namespace=&detail=` · `/pod-issues` · `/resources?kind=` | per-cluster inventory |
| `GET /api/clusters/{name}/timeline?resolution=sweep\|hour\|day&since=` | health, crash / error counters and utilization history (every sweep for 48 h, hourly for 90 days, daily for 2 years) |
| `GET /api/clusters/{name}/changes` · `GET /api/insights/changes?kind=&since=` | what changed between sweeps: version, status, checks, operators, nodes, application namespaces, upgrades, reachability |
| `POST /api/clusters/{name}/refresh` | collect and persist this one cluster now, behind a single-flight lock, without waiting for the next sweep (404 unknown cluster, 409 already refreshing) |
| `GET /api/applications?team=&tier=&environment=&status=` · `GET /api/applications/{app}` | applications (application namespaces) across the fleet |
| `GET /api/applications/summary?group_by=cluster\|hub\|region\|datacenter\|environment\|version` | how many distinct applications (and teams, namespaces, unassigned namespaces) run on each cluster or group of clusters |
| `GET /api/versions` · `GET /api/versions/operators?name=` | OCP / cluster-operator version spread |
| `GET /api/blast-radius?operator=&operator_version=&ocp_version=&olm_operator=&olm_version=&image=` | impacted clusters, applications, workloads |
| `GET /api/insights/summary` | fleet-wide "needs attention" counters |
| `GET /api/insights/certificates` · `/pod-issues` · `/quotas` · `/olm-operators` · `/machine-config-pools` · `/storage` · `/routes?host=` · `/events` · `/images?image=` · `/references?kind=&name=` · `/cluster-admins` | insights over the collected inventory |
| `GET /api/insights/resources?kind=&cluster=&namespace=&status=` | generic inventory query over any collected kind |
| `GET /api/metrics/top-namespaces?by=cpu\|memory&class=` · `/top-nodes` · `/capacity?group_by=` · `/cluster/{name}/utilization` · `/cluster/{name}/timeline` | utilization from `metrics.k8s.io` |
| `GET /api/manifest` · `GET /api/manifest/availability` | what is collected, and what each cluster actually served |
| `POST /api/refresh` | trigger a collection sweep |
| `GET /api/query/schema` | tables, columns, semantics and current snapshot state for natural-language queries (see [docs/nl-query.md](docs/nl-query.md)) |
| `POST /api/query/sql` | run one read-only SQL `SELECT` yourself against the fleet snapshot |
| `POST /api/query/ask` | ask a question in English; the model writes the SQL and the answer comes back with it, the explanation and the assumptions |
| `POST /api/query/batch` | run several SELECTs, with `{{variable}}` substitution, against one snapshot build; a failing query is an error under its own id |
| `POST /api/query/refresh-snapshot` | rebuild the SQL snapshot from Redis now, instead of waiting for the next sweep |
| `GET /api/dashboards` | saved and built-in query dashboards, as summary rows |
| `GET/PUT/DELETE /api/dashboards/{id}` | read, save or remove one dashboard definition (built-ins are read-only: 409) |
| `POST /api/dashboards/{id}/run` | run every panel of a dashboard, and its variables' option queries, in one batch against one snapshot |

Interactive docs at `/docs`.

## Deploying to OpenShift

`deploy/openshift/` contains the production-shaped manifests (Deployments,
Services, and `Route`s that expose the API and dashboard). See
`deploy/openshift/README.md`. The only real-world change is supplying per-hub
credentials instead of kind kubeconfigs.

## Layout

```
fleet/            kind-based OpenShift/ACM fleet (provisioning + seed, metrics-server addon, CRDs)
data-layer/       FastAPI app: collector, auth, models, REST API, tests
  config/         ocp-api-manifest.yaml (+ .fleet.yaml, tiered) · hubs.yaml (generated) · clusters.example.yaml (direct mode)
dashboard/        React + Vite dashboard (served by nginx)
mcp-server/       MCP server wrapping the API
patching-service/ patching system of record (jobs · approvals · audit) + seed_demo.py
patching/         N8N patching orchestration starter workflow (writes to patching-service)
deploy/openshift/ manifests for a real OpenShift deployment
deploy/rbac/      read-only ClusterRole for the collector (generated from the manifest)
docs/             onboarding · architecture · ocp-api-manifest · insight-catalog · patching-workflow
docker-compose.yml / Makefile
```

## Connecting real clusters

The local fleet uses kind + ACM discovery. To point at **real** OpenShift
clusters - a list of endpoints behind one shared service account using
username/password - follow **[docs/onboarding.md](docs/onboarding.md)**. The
collector code path is identical; only the config and credentials change.
