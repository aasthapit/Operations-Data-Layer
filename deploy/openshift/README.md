# Deploying the Operations Data Layer to OpenShift

These manifests deploy the data layer and dashboard as containers on OpenShift,
with the API endpoints exposed through `Route`s. They are the production-shaped
equivalent of the local `docker-compose.yml`.

What changes versus local:

* The collector no longer reads kind kubeconfigs. Instead it reads one
  kubeconfig (or, in a real ACM setup, a service-account token) per hub from a
  mounted `Secret`. Point `HUBS_CONFIG` at a config that lists those hubs.
* Redis can be the bundled `Deployment` here or a managed instance; just set
  `REDIS_URL`. It must run with `maxmemory-policy noeviction` - the data layer
  relies on nothing being evicted behind its back, and lets per-cluster keys
  expire on their own TTL instead (`REDIS_TTL_SECONDS`).

Apply order:

```sh
oc new-project ops-data-layer
oc apply -f redis.yaml
oc apply -f data-layer.yaml
oc apply -f dashboard.yaml
oc get route                      # -> dashboard + API URLs
```

The collector's in-cluster identity (ServiceAccount `odl-collector`) is what you
would bind to ACM `ManagedClusterView` / cluster-proxy RBAC when wiring real
hubs. For a first deployment, the mounted per-hub kubeconfig secret is the
simplest path and matches the local model exactly.
