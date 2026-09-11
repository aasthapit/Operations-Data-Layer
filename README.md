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
┌──────────────────▼─ Data Layer (FastAPI + Postgres) ────────┐
│  Collector (APScheduler): discover via ACM → pull CRs →     │
│    run precondition health checks → upsert + snapshot        │
│  Postgres: hubs, clusters, operators, applications,          │
│    health_checks, health_snapshots (time-series)             │
│  Cache/refresh: periodic poll + POST /api/refresh.           │
│                 Reads are always served from Postgres.       │
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
make up              # build + start db, api, dashboard

# Dashboard:  http://localhost:8080      (Overview · Clusters · Applications · Versions · Utilization · Insights · Blast radius · Patching · Collected)
# API + docs: http://localhost:18000/docs   (mapped off 8000 to avoid conflicts)
# Patching:   http://localhost:18010/docs   (system of record: jobs, approvals, audit)
# MCP:        http://localhost:18080/mcp
# N8N:        http://localhost:5678      (import patching/n8n-patching-workflow.json)
```

Inventory, configuration and utilization all come from one source - each
cluster's API server - and are served from Postgres. Run `make dl-venv` once,
then `make test` and `make lint` for the data layer.

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
- **[docs/architecture.md](docs/architecture.md)** - components, collection flow, auth flow, data model, blast radius, and deployment, with diagrams.
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
  are collected from every cluster (each with an `enabled` flag), how
  namespaces are classified as application vs platform, ownership labels, and
  health thresholds. See [docs/ocp-api-manifest.md](docs/ocp-api-manifest.md).
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
* `app/models.py` - the persisted schema (current-state + time-series tables).
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

The collector polls on an interval (`REFRESH_INTERVAL_SECONDS`, default 120s)
and on demand via `POST /api/refresh`. The API never touches a cluster on the
read path - it serves the last collected snapshot from Postgres, so reads are
fast and the cluster API load is bounded by the poll interval. Every sweep also
appends a health snapshot per cluster, powering the timeline.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/health/overview` | fleet totals, hub status, last collection |
| `GET /api/health/summary?group_by=region\|datacenter\|environment\|hub\|version` | health rolled up by dimension |
| `GET /api/clusters?region=&environment=&status=&version=&team=` | filterable cluster list with utilization, issues, certs |
| `GET /api/clusters/{name}` | full detail: platform config, capacity, checks, operators, nodes, namespaces, pod issues, what was collected |
| `GET /api/clusters/{name}/nodes` · `/namespaces?class=` · `/workloads?namespace=&detail=` · `/pod-issues` · `/resources?kind=` | per-cluster inventory |
| `GET /api/clusters/{name}/timeline` | health-score + utilization history |
| `GET /api/applications?team=&tier=&environment=&status=` · `GET /api/applications/{app}` | applications (application namespaces) across the fleet |
| `GET /api/versions` · `GET /api/versions/operators?name=` | OCP / cluster-operator version spread |
| `GET /api/blast-radius?operator=&operator_version=&ocp_version=&olm_operator=&olm_version=&image=` | impacted clusters, applications, workloads |
| `GET /api/insights/summary` | fleet-wide "needs attention" counters |
| `GET /api/insights/certificates` · `/pod-issues` · `/quotas` · `/olm-operators` · `/machine-config-pools` · `/storage` · `/routes?host=` · `/events` · `/images?image=` · `/references?kind=&name=` · `/cluster-admins` | insights over the collected inventory |
| `GET /api/insights/resources?kind=&cluster=&namespace=&status=` | generic inventory query over any collected kind |
| `GET /api/metrics/top-namespaces?by=cpu\|memory&class=` · `/top-nodes` · `/capacity?group_by=` · `/cluster/{name}/utilization` · `/cluster/{name}/timeline` | utilization from `metrics.k8s.io` |
| `GET /api/manifest` · `GET /api/manifest/availability` | what is collected, and what each cluster actually served |
| `POST /api/refresh` | trigger a collection sweep |

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
  config/         ocp-api-manifest.yaml · hubs.yaml (generated) · clusters.example.yaml (direct mode)
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
