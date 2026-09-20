# Deploying the Operations Data Layer to OpenShift

A kustomize base that deploys the two images - `odl-backend` and `odl-dashboard` - as one `Deployment` with three containers, exposed through a single edge-terminated `Route`.
How the images are built and what every environment variable does is in [`docs/containers.md`](../../docs/containers.md); this file is the OpenShift specifics.

```
deploy/openshift/
  kustomization.yaml                   the default install: oc apply -k deploy/openshift
  base/                                the manifests both installs share
  overlays/sharded-collectors/         collection moved out of the serving pod
  secret.example.yaml                  the credential key names (not applied)
  redis.yaml                           an in-cluster Redis, if you have no other
```

`base/` exists because kustomize refuses to load a base directory that contains the overlay.
The root `kustomization.yaml` is a one-line pointer at it, so `oc apply -k deploy/openshift` still means "the plain install".

## What runs

| container | role | listens | notes |
|---|---|---|---|
| `dashboard` | nginx, the compiled UI, reverse proxy | 8080 | the only port the Service and Route reach |
| `api` | `ODL_ROLE=api` | 8000 | read-only over Redis, never collects; holds the DuckDB snapshot |
| `collector` | `ODL_ROLE=worker` | nothing | startup sweep, scheduler, refresh queue consumer |

They share the pod's network namespace, so the dashboard proxies to `127.0.0.1:8000` and the API is not reachable from anywhere else.
The `Deployment` uses `strategy: Recreate` because the pod carries the only collector and two of them overlapping would sweep the same fleet twice.

Nothing sets `runAsUser`: the `restricted-v2` SCC assigns a UID from the namespace's range, and both images are built to run as an arbitrary UID in GID 0 with a read-only root filesystem.

## Install

```sh
oc new-project ops-data-layer

# Credentials. Never a file in git - see secret.example.yaml for the key names
# and for the ExternalSecret form if a vault owns them.
oc create secret generic odl-secrets \
    --from-literal=OCP_USERNAME=svc-ops-data \
    --from-literal=OCP_PASSWORD='...' \
    --from-literal=REDIS_URL='rediss://odl:...@redis.example.internal:6380/0' \
    --from-literal=ANTHROPIC_API_KEY=''

# The fleet. Edit base/config/acm.yaml (hubs, auth, managed_access) and
# base/config/app-map.json (application ownership) before applying.
oc apply -k deploy/openshift

oc get route odl                 # -> the UI, with the API under /api
```

`base/config/` is turned into the `odl-config` ConfigMap by `configMapGenerator`, with a content hash in the name.
Editing either file and re-applying rolls the pod, so no process ever serves answers from a config it did not read.

The images are referred to by bare name in `base/deployment.yaml` and given their real location by the `images:` block in `base/kustomization.yaml` - retagging for your registry is that block and nothing else.
The default points at the cluster's internal registry in the `ops-data-layer` namespace.

## Redis

The data layer needs a Redis running `maxmemory-policy noeviction`, because silently dropping a cluster would make blast-radius answers wrong ([ADR-0001](../../docs/adr/0001-redis-as-fleet-state-store.md)).
Point `REDIS_URL` at an instance somebody operates.
If nobody does, `redis.yaml` is a single replica on a PVC, deliberately outside the kustomization:

```sh
oc apply -f deploy/openshift/redis.yaml     # then REDIS_URL=redis://odl-redis:6379/0
```

## TLS to the fleet

Most estates present private-CA certificates on their hub and cluster API servers.
`base/ca-bundle.yaml` creates an empty ConfigMap labelled `config.openshift.io/inject-trusted-cabundle: "true"`; the cluster network operator fills in `ca-bundle.crt` and keeps it current.
The deployment mounts it at `/etc/odl/ca` as `tls-ca-bundle.pem` and points `REQUESTS_CA_BUNDLE` and `SSL_CERT_FILE` at it, which covers both `requests` and the standard library.

The pod does not start until that injection has happened, which normally takes seconds.
On a cluster where it does not happen at all, drop the `ca-bundle` volume and mounts from `base/deployment.yaml` and set `defaults.ca_cert` in the fleet config instead.

If the fleet's CA is *different* from the cluster's own trusted bundle, add it to the cluster proxy's `additionalTrustBundle` - it lands in the same ConfigMap.

## Network

`base/networkpolicy.yaml` allows ingress only from the ingress router's namespace, only on 8080.
A namespace neighbour cannot call the API directly and skip the Route.

Egress is left open, and the policy lists what narrowing it would have to allow: every hub and managed cluster API server on 6443, Redis, the model endpoint when the natural-language endpoints are used, and cluster DNS.

## RBAC on the clusters being read

The pod's own ServiceAccount (`odl`) needs no permissions in the cluster it runs on - the data layer reads *other* clusters, through their API servers, with the credentials in `odl-secrets`.

What it needs on each cluster it reads is [`deploy/rbac/odl-collector-readonly.yaml`](../rbac/odl-collector-readonly.yaml), a read-only `ClusterRole` generated from the OCP API manifest and bound to the shared service-account user.
Regenerate it with `make rbac` after changing what is collected; do not hand-edit it.

## The application map is bigger than a ConfigMap

A ConfigMap caps at 1 MiB, and an estate-wide namespace-to-application export passes that quickly.
In order of preference:

1. **A plain key**, as in `base/config/app-map.json`. Fine into the low hundreds of kilobytes - a few thousand namespaces.
2. **`app-map.json.gz` via `binaryData`.** The backend reads a gzipped map, and JSON of this shape compresses about ten to one, so the 1 MiB cap becomes roughly 10 MiB of export. kustomize does this for you:
   ```yaml
   configMapGenerator:
     - name: odl-config
       files:
         - config/acm.yaml
         # kustomize sees this is not text and puts it in binaryData for you
         - config/app-map.json.gz
   ```
   and set `ODL_APP_MAP=/etc/odl/app-map.json.gz` on both backend containers.
3. **A PVC, or an init container that fetches it.** Past that, the map does not belong in the manifest at all: mount a `ReadWriteMany` PVC that a job refreshes, or add an init container that pulls the current export from the system of record into an `emptyDir` the backend containers share. This is also the answer when the map changes more often than you want to redeploy.

## Scaling collection out

One collector cannot finish a sweep of seven hubs with ~114 clusters each inside `REFRESH_INTERVAL_SECONDS` ([ADR-0003](../../docs/adr/0003-enterprise-scale.md)).
The overlay takes the `collector` container out of the serving pod and replaces it with a `StatefulSet` of four:

```sh
oc apply -k deploy/openshift/overlays/sharded-collectors
```

Each replica derives its shard index from its ordinal (`odl-collector-2` is shard 2) and divides the fleet by `ODL_SHARD_FROM_HOSTNAME`.
**`replicas` and `ODL_SHARD_FROM_HOSTNAME` are the same number.**
Scaling to 6 without changing the env gives six workers each collecting a quarter of the fleet, and two quarters collected by nobody.

To partition by hub instead - one StatefulSet per ACM hub, each holding only that hub's credentials - copy `statefulset.yaml` per hub, set `COLLECT_HUBS` and drop `ODL_SHARD_FROM_HOSTNAME`.

With collection out of the way, the serving pod is just nginx and a read-only API, and `strategy: Recreate` there can safely become `RollingUpdate`.

## Verifying

```sh
oc get pods -l app=odl
oc logs deploy/odl -c collector -f                    # sweeps, per cluster
oc exec deploy/odl -c api -- curl -s localhost:8000/api/status   # live collectors
curl -s "https://$(oc get route odl -o jsonpath='{.spec.host}')/api/health/summary"
```

`GET /api/status` lists the collectors that are alive.
If `POST /api/refresh` answers 409, none of them are - check the collector container's probe and logs before looking anywhere else.
