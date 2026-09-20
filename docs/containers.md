# Containers

Two images and one pod.
This is how the Operations Data Layer is deployed anywhere that is not a laptop running `make dev`.

## The two images

| image | built from | what it is |
|---|---|---|
| `odl-backend` | `data-layer/` | the Python application: FastAPI, the collector, the store, the query plane |
| `odl-dashboard` | `dashboard/` | nginx, the compiled React bundle, and the reverse proxy in front of the API |

### Why the backend has roles

The same backend image runs as three different processes, selected by `ODL_ROLE` (or the first argument):

| `ODL_ROLE` | what it does | listens |
|---|---|---|
| `api` | serves the UI, the REST API, MCP and the agent, read-only over Redis. It never collects. | `$PORT` (8000) |
| `worker` | the collector: startup sweep, scheduler, refresh-queue consumer. It serves nothing. | nothing |
| `all` | both in one process - today's behaviour, and what `docker-compose.yml` uses | `$PORT` (8000) |
| `check-config` | logs in to every hub and cluster in the config, reports what fails, exits | nothing |

One image, because they are one application: the collector and the API share the store contract, the manifest, the parsers and the models, and a second image would only be a copy that drifts.

Separate *processes*, because the two halves fail and scale differently.
Collection is CPU- and network-bound and gets slower as the fleet grows; serving is memory-bound and gets slower as questions get harder.
A sweep that pins four cores should not make the dashboard stutter, a collector crash-looping on a bad credential should not take the UI down with it, and at seven hubs the collectors need to be scaled out while the API stays at one replica ([ADR-0003](adr/0003-enterprise-scale.md)).
Splitting them is also what makes `strategy: Recreate` cheap to give up later: once the collector is out of the serving pod, the serving pod can roll.

Refresh still works from a process that does not collect.
`POST /api/refresh` and `POST /api/clusters/{name}/refresh` on an `api` process are queued through Redis and picked up by whichever collector is free; they answer 409 only when no collector is alive at all.
`GET /api/status` lists the live collectors.

## The pod

```mermaid
flowchart TB
  browser(["browser"])

  subgraph pod["pod odl - one network namespace"]
    dash["dashboard<br/>nginx :8080"]
    api["api<br/>ODL_ROLE=api :8000"]
    collector["collector<br/>ODL_ROLE=worker<br/>no port"]
  end

  redis[("Redis<br/>noeviction")]
  hubs["ACM hubs<br/>:6443"]
  clusters["managed clusters<br/>:6443"]

  browser -->|"https, Route or hostPort"| dash
  dash -->|"/api, /healthz<br/>127.0.0.1:8000"| api
  api --> redis
  collector --> redis
  collector -->|"discover"| hubs
  collector -->|"collect"| clusters
  hubs -.->|"ManagedClusters"| clusters
```

The three containers share one network namespace, so every arrow inside the pod is a `127.0.0.1` call.
Only the dashboard's 8080 leaves the pod.
The API is not reachable from the rest of the cluster, which is why there is no second Service, no second Route and no CORS anywhere.

The collector talks to Redis and to the fleet, and to nothing else.
The API talks to Redis, and to the model endpoint when somebody asks a natural-language question.

## Build

```sh
make images                    # both, with the public base images
make image-backend             # just one
make image-dashboard
```

`IMAGE_PREFIX` (default `localhost`) and `IMAGE_TAG` (default `latest`) set the tags; `make images-push IMAGE_PREFIX=quay.io/acme` pushes them.
`localhost` is the default because that is what podman looks for when `podman kube play` sees `imagePullPolicy: IfNotPresent`.

Measured sizes, and what was actually run:

| Image | Bases | Size | Proven |
|---|---|---|---|
| `odl-backend` | `python:3.12-slim` | 475 MB | the whole pod scenario below, as an arbitrary UID on a read-only root |
| `odl-dashboard` | `node:22-alpine`, `nginx:1.27-alpine` | 51 MB | same |
| `odl-backend` | `ubi9/python-312` | 1.41 GB | same; the UBI Python base is the weight, not the application |
| `odl-dashboard` | `ubi9/nodejs-22`, `ubi9/nginx-124` | - | same |

The pod scenario: the three containers on one network namespace, the collector sweeping a five-cluster fleet, the clusters served through the dashboard's proxy, `python -m app.worker --check` healthy, a fleet refresh and a cluster refresh queued by the API and run by the collector, the collector stopping on SIGTERM in under a second with exit code 0, and the API answering 409 once no collector is left.
`deploy/pod/odl-pod-with-redis.yaml` was also applied unchanged (images and fleet config aside) to a Kubernetes cluster: four containers ready, no restarts.

### Behind a corporate registry

Every base image and package index is a build argument, passed through only when set.

| argument | image | default |
|---|---|---|
| `PYTHON_IMAGE` | backend | `python:3.12-slim` (also works with `registry.access.redhat.com/ubi9/python-312`) |
| `PIP_INDEX_URL` | backend | PyPI |
| `PIP_EXTRA_INDEX_URL` | backend | - |
| `PIP_TRUSTED_HOST` | backend | - |
| `NODE_IMAGE` | dashboard | `node:22-alpine` |
| `NGINX_IMAGE` | dashboard | `nginx:1.27-alpine` (also works with `registry.access.redhat.com/ubi9/nginx-124`) |
| `NPM_REGISTRY` | dashboard | npmjs.com |
| `DIST` | dashboard | `build` - compile in the image; `prebuilt` - copy a `dist/` from the host |

```sh
make images \
    PYTHON_IMAGE=registry.access.redhat.com/ubi9/python-312 \
    NGINX_IMAGE=registry.access.redhat.com/ubi9/nginx-124 \
    NODE_IMAGE=registry.example.com/node:22-alpine \
    PIP_INDEX_URL=https://nexus.example.com/repository/pypi/simple \
    PIP_TRUSTED_HOST=nexus.example.com \
    NPM_REGISTRY=https://nexus.example.com/repository/npm/
```

The dashboard image is deliberately base-agnostic: it ships its own `nginx.conf`, its own server-block template and its own entrypoint under `/etc/nginx/odl`, and depends on none of the official image's `/docker-entrypoint.d` envsubst machinery, which a UBI nginx base does not have.

### When the build cannot reach an npm registry

Some build environments can reach a pip mirror but no npm one at all.
`DIST=prebuilt` compiles the bundle on the host and copies it in, skipping the node stage entirely - the node base image is then never even resolved.

```sh
make image-dashboard DIST=prebuilt      # runs `npm run build` here first
```

## Run it with podman

The pod manifests in [`deploy/pod/`](../deploy/pod/) are the same three containers, described in Kubernetes YAML that `podman kube play` accepts.

1. Put your fleet in the `odl-config` ConfigMap at the top of `deploy/pod/odl-pod.yaml`: the hubs, their API URLs, and how managed clusters are reached.
2. Put real credentials in the `odl-secrets` Secret below it: `OCP_USERNAME`, `OCP_PASSWORD`, `REDIS_URL`.
3. Build and play:

```sh
make images
make pod-up                    # podman kube play deploy/pod/odl-pod.yaml
make pod-logs                  # podman pod logs -f odl
make pod-down
```

The UI is at <http://localhost:8080>, with the API under `/api` on the same origin.

No Redis to point at?
`POD_FILE=deploy/pod/odl-pod-with-redis.yaml make pod-up` runs one in the pod, on the volume claim declared at the end of that file (a named volume under podman, the default storage class on Kubernetes), with `REDIS_URL=redis://127.0.0.1:6379/0` already set.
That file is generated from `odl-pod.yaml` by `deploy/pod/render.sh` (`make pod-render`) so the two cannot drift - edit `odl-pod.yaml`.

Both manifests are also plain Kubernetes: `kubectl apply -f deploy/pod/odl-pod.yaml` works, with `hostPort` becoming whatever your cluster does with host ports.

With docker instead of podman there is no `kube play` equivalent; use `make up` (docker-compose), which runs the simpler shape - one `ODL_ROLE=all` backend and the dashboard.

## Run it on OpenShift

[`deploy/openshift/`](../deploy/openshift/) is a kustomize base; its [README](../deploy/openshift/README.md) has the detail.
The short version:

```sh
oc new-project ops-data-layer
oc create secret generic odl-secrets \
    --from-literal=OCP_USERNAME=svc-ops-data \
    --from-literal=OCP_PASSWORD='...' \
    --from-literal=REDIS_URL='rediss://odl:...@redis.example.internal:6380/0' \
    --from-literal=ANTHROPIC_API_KEY=''
oc apply -k deploy/openshift
oc get route odl
```

The fleet config lives in `deploy/openshift/base/config/` and becomes a ConfigMap with a content hash in its name, so editing it rolls the pod.

Private CAs on the fleet's API servers are handled by the cluster: `base/ca-bundle.yaml` is an empty ConfigMap labelled `config.openshift.io/inject-trusted-cabundle: "true"`, the cluster network operator fills it in, and the deployment mounts it at `/etc/odl/ca` with `REQUESTS_CA_BUNDLE` and `SSL_CERT_FILE` pointing at it.

The Route is edge-terminated and redirects insecure requests.
It carries a 900 s router timeout, because the agent's event stream goes through it.

No `runAsUser` appears anywhere: the `restricted-v2` SCC assigns a UID from the namespace's range and both images run as an arbitrary UID in GID 0.

## Configuration

Everything is environment, nothing is baked into an image.
Config files are mounted; credentials come from a Secret.

### Backend (`odl-backend`)

| variable | default | what it does |
|---|---|---|
| `ODL_ROLE` | `all` | `api`, `worker`, `all` or `check-config` |
| `PORT` | `8000` | uvicorn's port, for `api` and `all` |
| `HOME` | - | set to `/tmp`: an arbitrary UID has no home directory |
| `ODL_CONFIG` | - | the fleet config, mounted at `/etc/odl/acm.yaml` |
| `ODL_APP_MAP` | - | application ownership, `/etc/odl/app-map.json` (or `.json.gz`) |
| `ODL_MANIFEST` | the image's default | what is collected; the pods use `/app/config/ocp-api-manifest.fleet.yaml` |
| `OCP_USERNAME` / `OCP_PASSWORD` | - | the shared read-only service account, referenced as `${VAR}` from the fleet config |
| `REDIS_URL` | - | where the fleet state lives; the instance must run `maxmemory-policy noeviction` |
| `REDIS_PREFIX` / `REDIS_TTL_SECONDS` | `odl` / `86400` | key prefix, and how long a cluster nobody collects stays visible |
| `REFRESH_INTERVAL_SECONDS` | `120` | the sweep tick |
| `COLLECT_WORKERS` / `COLLECT_FETCH_WORKERS` | `8` / `6` | clusters in flight, and kinds in flight within a cluster |
| `COLLECT_HUBS` | all | restrict this process to named hubs - one collector per ACM hub |
| `COLLECT_SHARD` | - | `i/n`: split the owned hubs' clusters across processes |
| `ODL_SHARD_FROM_HOSTNAME` | - | the shard count, with the index taken from the pod's ordinal (the StatefulSet overlay) |
| `ODL_WORKER_TICK_SECONDS` | `5` | how often a collector touches its heartbeat, republishes its presence and drains the refresh queue; a collector that dies disappears from `GET /api/status` within about 20 s |
| `ODL_WORKER_HEARTBEAT` | `/tmp/odl-worker.heartbeat` | the file `python -m app.worker --check` reads; it must sit on the writable `/tmp` |
| `ANTHROPIC_API_KEY` | - | only `POST /api/query/ask` and `POST /api/agent/run` need it |
| `ODL_LLM_PROVIDER` | `anthropic` | `anthropic` or `ollama`; with `ollama` no question leaves the building |
| `OLLAMA_BASE_URL` / `ODL_OLLAMA_MODEL` / `ODL_OLLAMA_NUM_CTX` / `ODL_OLLAMA_TIMEOUT_SECONDS` / `ODL_OLLAMA_THINK` | see `.env.example` | the local-model settings |
| `REQUESTS_CA_BUNDLE` / `SSL_CERT_FILE` | - | the CA bundle for the fleet's API servers, `/etc/odl/ca/tls-ca-bundle.pem` |


### Dashboard (`odl-dashboard`)

| variable | default | what it does |
|---|---|---|
| `PORT` | `8080` | where nginx listens; unprivileged, so never 80 |
| `API_UPSTREAM` | `127.0.0.1:8000` | the data layer, `host:port` |
| `PATCHING_UPSTREAM` | `127.0.0.1:8010` | the patching system of record; an IP literal by default, because an unresolvable hostname is a fatal nginx start error and most deployments have no patching service |
| `API_READ_TIMEOUT` | `120s` | read budget for an ordinary API call |
| `AGENT_READ_TIMEOUT` | `900s` | read budget for one agent run; a local model takes up to ten minutes |

`GET /nginx-health` is answered by nginx itself and is what the probes use.
`/healthz` still proxies to the API, so the two questions - "is the web tier up" and "is the data layer up" - have separate answers.

## Security posture

- **Non-root, and not a fixed user.** Both images declare a numeric `USER` (1001 for the backend, 101 for the dashboard) with GID 0, and both run correctly under an arbitrary UID in GID 0, which is what OpenShift's `restricted-v2` SCC assigns. Everything the processes read is group-readable rather than owned by a named account.
- **Read-only root filesystem.** Every container mounts an `emptyDir` at `/tmp` and writes nowhere else. nginx's pid file, its rendered server block and all five of its scratch paths are under `/tmp/nginx`; the backend gets `HOME=/tmp`.
- **All capabilities dropped**, `allowPrivilegeEscalation: false`, `seccompProfile: RuntimeDefault`, `runAsNonRoot: true` on every container in every manifest.
- **No secrets in the images.** Credentials arrive as environment from a Secret, the fleet config as a mounted ConfigMap, the CA bundle as a mounted, operator-injected ConfigMap. Nothing is baked in, so the same image runs in every environment.
- **One port out.** The API and the collector have no port outside the pod. The NetworkPolicy allows ingress only from the ingress router, only on 8080.
- **What leaves the pod:** hub and managed-cluster API servers on 6443, Redis, cluster DNS, and - only when the natural-language endpoints are used - the model endpoint. Nothing else. The collector only ever reads, and values from Secrets, ConfigMaps and env are scrubbed at parse time and never stored ([docs/ocp-api-manifest.md](ocp-api-manifest.md)).
- **nginx tells nobody its version** (`server_tokens off`), sends `X-Content-Type-Options`, `Referrer-Policy` and `X-Frame-Options` on everything it serves, and emits relative redirects so a Route's TLS cannot be downgraded by one.

## Sizing

The target estate is seven ACM hubs with roughly 114 clusters each - about 800 clusters.

Redis is not the constraint: 900 clusters measured at 4.79 GB, and the model holds ([ADR-0001](adr/0001-redis-as-fleet-state-store.md), [ADR-0003](adr/0003-enterprise-scale.md)).
The collector is.
A full pass reads about 120 MB of raw Kubernetes JSON per cluster, so a complete sweep of the fleet is on the order of 100 GB, which is not something one container does every two minutes.

Two things make it fit, in this order:

1. **Collect each kind on its own interval.** `ocp-api-manifest.fleet.yaml` - the manifest the pods use - reads platform state every sweep, inventory every 15 minutes, and leaves Secrets and ConfigMaps off entirely, which is roughly half the bytes. This is a config change, not a topology change, and it is worth doing before adding a single container.
2. **Run more collectors.** Either one per ACM hub (`COLLECT_HUBS=acm-prod-east`, so each process holds only that hub's credentials and touches only its clusters) or sharded within the hubs they own (`COLLECT_SHARD=i/n`, or `ODL_SHARD_FROM_HOSTNAME` from a StatefulSet ordinal).

`oc apply -k deploy/openshift/overlays/sharded-collectors` does the second one: the `collector` container leaves the serving pod and a `StatefulSet` of four takes over.
**Its `replicas` and its `ODL_SHARD_FROM_HOSTNAME` are the same number** - six replicas against a value of 4 means two shards of the fleet collected by nobody.

Per container, the starting points in the manifests are:

| container | requests | limits | why |
|---|---|---|---|
| dashboard | 50m / 64Mi | 200m / 128Mi | it serves static files and proxies |
| api | 250m / 512Mi | 2 / 2Gi | memory-shaped: the DuckDB snapshot behind `/api/query/*` is built in this process |
| collector | 500m / 1Gi | 4 / 4Gi | the CPU consumer: it decodes and parses every cluster's JSON, several clusters at a time |

Raise `COLLECT_WORKERS` and the collector's CPU limit together; they are the same dial.
`GET /api/collector/timings` reports where a sweep actually went before you guess.

## Troubleshooting

**The UI loads but every panel says the API is unreachable, and nginx logs 502.**
The API container is not up yet, or not up at all.
`/nginx-health` answering 200 while `/healthz` 502s is exactly this and is why the two probes are separate.
Check the API container's startup probe - it allows two minutes, most of which is waiting for Redis - and then `REDIS_URL`.

**`POST /api/refresh` answers 409.**
No collector is alive.
In the single-pod shape that means the `collector` container is down or crash-looping; in the sharded overlay it means the StatefulSet has no ready pod.
`GET /api/status` lists the live collectors.
The API answering at all is not evidence a collector exists - that is the point of the 409.

**The collector container never becomes ready, and its probe keeps failing.**
The probe is `python -m app.worker --check`, which is the worker saying it cannot do its job.
Run it by hand for the real message: `oc exec deploy/odl -c collector -- python -m app.worker --check`.
Usually it is Redis, or a fleet config that references a `${VAR}` no Secret provides.

**Every cluster fails with a TLS error.**
The fleet's API servers present a private CA the container does not trust.
On OpenShift, confirm the operator actually injected `ca-bundle.crt` into `odl-trusted-ca` - the pod will not start without it - and that the fleet's CA is in the cluster's trust bundle, adding it to the cluster proxy's `additionalTrustBundle` if not.
Elsewhere, mount the CA and set `defaults.ca_cert` in the fleet config.
`ODL_ROLE=check-config` tries every hub and cluster the way the collector will and prints what fails.

**nginx exits immediately with `host not found in upstream`.**
`API_UPSTREAM` or `PATCHING_UPSTREAM` names something DNS cannot resolve.
nginx resolves upstreams once, at start, so an unresolvable name is fatal rather than a 502 - which is why `PATCHING_UPSTREAM` defaults to an IP literal.

**A container exits with `No space left on device` or `No usable temporary directory`.**
`/tmp` is the only writable path in every container and it is an `emptyDir` on the node's disk.
The node (or the podman / Docker VM) is out of disk; the image is not at fault.
Free space, or give the `emptyDir` a `sizeLimit` and `medium: Memory` if the node's disk is not yours to manage.

**`docker pull` or `docker build` hangs forever on Docker Desktop, before any bytes move.**
Look for stuck `docker-credential-desktop` processes: the credential helper is hanging, and every registry operation waits on it, including anonymous pulls.
Pointing the CLI at a config without a credential store gets public and mirror pulls moving again: `mkdir -p /tmp/dockercfg && echo '{"auths":{}}' > /tmp/dockercfg/config.json && DOCKER_CONFIG=/tmp/dockercfg make images`.

**A deep link 404s, or a reload loses the page.**
That is the SPA fallback, and it means the request did not reach this nginx.
Inside the image, `try_files` sends everything that is not `/api` or `/healthz` to `index.html`.

**The Generate tab streams nothing until the run finishes.**
Something between the browser and the API is buffering the event stream.
nginx does not: `/api/agent/` runs with `proxy_buffering off` and its own timeout.
Look at whatever is in front of it - a router timeout under 900 s, or a corporate proxy.
