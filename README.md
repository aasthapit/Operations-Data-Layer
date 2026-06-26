# Operations Data Layer

A cloud data layer for an OpenShift fleet: it discovers clusters across multiple
ACM hubs, runs precondition health checks against each one, records the rich
metadata (versions, operators, regions, applications) into a database, and
serves it through a REST API and a web dashboard.

The headline questions it answers:

* **What is healthy?** Per region / data center / environment / version, what is
  green, what is degraded, what is mid-upgrade.
* **What is the blast radius?** Given a bad OCP version or a bad cluster
  operator, which clusters carry it - and which applications (and teams) ride on
  top of those clusters.

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

Pointing this at real ACM hubs later is purely a matter of swapping the
kubeconfigs in `data-layer/config/hubs.yaml`; no code changes.

## Quick start

Prerequisites: Docker, [kind](https://kind.sigs.k8s.io/), kubectl, Python 3,
and ~6-10 GB of memory available to Docker for the fleet.

```sh
make fleet-venv      # one-time: python venv for the fleet tooling
make fleet-up        # create + seed 2 hubs and 8 managed clusters (a few minutes)
make up              # build + start db, api, dashboard

# Dashboard:  http://localhost:8080
# API + docs: http://localhost:18000/docs   (mapped off 8000 to avoid conflicts)
```

## Documentation

- **[docs/onboarding.md](docs/onboarding.md)** - point a list of live OCP cluster endpoints at the data layer using a single shared service account (username/password). Config format, RBAC, TLS, verification.
- **[docs/architecture.md](docs/architecture.md)** - components, collection flow, auth flow, data model, blast radius, and deployment, with diagrams.
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
CRDs, seeds the resources, registers each managed cluster on its hub (with a
kubeconfig secret, as ACM does), and exports internal kubeconfigs for the
collector.

## The data layer

* `app/collector/` - discovery (ACM hubs → ManagedClusters), collection
  (ClusterVersion / ClusterOperator / Infrastructure / nodes / apps), the
  precondition health checks, and the scheduled runner.
* `app/models.py` - the persisted schema (current-state + time-series tables).
* `app/api/` - the REST surface.

### Health checks

Each cluster runs a panel of precondition checks (pass / warn / fail at a
severity): ACM availability, ClusterVersion availability, critical operators
available, no degraded operators, nodes ready, supported version, upgrade in
progress, operator drift, update available. The worst result sets the cluster's
overall status; a per-cluster health score and history are recorded each sweep.

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
| `GET /api/clusters?region=&environment=&status=&version=&team=` | filterable cluster list |
| `GET /api/clusters/{name}` | full detail: checks, operators, applications |
| `GET /api/clusters/{name}/timeline` | health-score history |
| `GET /api/versions` | OCP version distribution across the fleet |
| `GET /api/versions/operators?name=` | operator version spread / drift |
| `GET /api/blast-radius?operator=&operator_version=&ocp_version=&degraded_only=` | impacted clusters + applications |
| `POST /api/refresh` | trigger a collection sweep |

Interactive docs at `/docs`.

## Deploying to OpenShift

`deploy/openshift/` contains the production-shaped manifests (Deployments,
Services, and `Route`s that expose the API and dashboard). See
`deploy/openshift/README.md`. The only real-world change is supplying per-hub
credentials instead of kind kubeconfigs.

## Layout

```
fleet/            kind-based OpenShift/ACM fleet (provisioning + seed)
data-layer/       FastAPI app: collector, auth, models, REST API
  config/         hubs.yaml (generated) + clusters.example.yaml (direct mode)
dashboard/        React + Vite dashboard (served by nginx)
mcp-server/       MCP server wrapping the API
deploy/openshift/ manifests for a real OpenShift deployment
deploy/rbac/      read-only ClusterRole for the collector
docs/             onboarding + architecture
docker-compose.yml / Makefile
```

## Connecting real clusters

The local fleet uses kind + ACM discovery. To point at **real** OpenShift
clusters - a list of endpoints behind one shared service account using
username/password - follow **[docs/onboarding.md](docs/onboarding.md)**. The
collector code path is identical; only the config and credentials change.
