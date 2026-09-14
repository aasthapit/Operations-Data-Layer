# The OCP API manifest

Everything the Operations Data Layer knows about a cluster is read from that cluster's own API server.
The **OCP API manifest** (`data-layer/config/ocp-api-manifest.yaml`) is the single declaration of *what* is read: every resource kind the collector can fetch, whether it is enabled, how namespaces are classified into applications versus platform, where application ownership comes from, and the thresholds the health checks use.
Nothing outside the manifest is ever requested from a cluster, and the read-only RBAC the collector needs is generated from it.

This document explains the manifest, the scrub policy that sits behind it, and how to extend it.

## Design

```
config/ocp-api-manifest.yaml        what is enabled + options       (operators edit this)
app/collector/registry.py           how each key is fetched          (code: group/version/plural, scope, RBAC)
app/collector/parsers.py            how each object is normalised    (code: one parser per key, scrubbing inside)
app/collector/collect.py            fetch every enabled key, then assemble the cluster document
deploy/rbac/odl-collector-readonly.yaml   GENERATED from the enabled keys
GET /api/manifest                   the manifest as the API serves it
GET /api/manifest/availability      per cluster, per key: collected / unavailable / forbidden / error / disabled
```

The registry is the closed list of what the data layer can read.
The manifest chooses from it.
A manifest key that is not in the registry fails at startup, so a typo cannot silently collect nothing.
A registry key that is missing from the manifest is disabled.

Because every fetch is recorded per cluster, "what can this cluster answer?" is itself data: a cluster without OLM reports `clusterserviceversions: unavailable`, a cluster where RBAC was not applied reports `secrets: forbidden`, and a cluster without `metrics.k8s.io` reports `node_metrics: unavailable`.
The dashboard's **Collected** tab shows this as a matrix.

## Applications from a mapping file

Estates that keep an application registry instead of labelling namespaces set `applications.source: mapping` in the manifest.
A JSON or YAML file then maps `(cluster, namespace)` to the application id, the line of business and the namespace's environment (`data-layer/config/app-map.example.json`; the real file is git-ignored; `ODL_APP_MAP` overrides the path; `fields` in the manifest names the record keys).

With a mapping:

- labels are ignored for ownership; every resource in a namespace belongs to the namespace's application;
- `app_name` is the registry's application id, `team` is the line of business, and each namespace carries its own `environment` (development, test, ist ...) next to the cluster's;
- a namespace absent from the file is under no business application: `app_name` is null, `assigned` is false, and such namespaces group under `(unassigned)` in the applications and blast-radius views (`GET /api/applications?assigned=false` lists them);
- when ACM carries no environment label for a cluster, the environment the mapping's records agree on for that cluster is used;
- the file is re-read whenever it changes on disk, so a registry export can be refreshed without a restart.

## The manifest

```yaml
namespaces:
  platform:
    names: [default, kube-system, kube-public, kube-node-lease, openshift, local-path-storage]
    prefixes: [openshift-, kube-, open-cluster-management, multicluster-engine, hive, rhacs-operator, stackrox]
    label_keys: [openshift.io/run-level]
  ownership:
    app:  [odl.io/app, app.kubernetes.io/part-of, app.kubernetes.io/name]
    team: [odl.io/team, team, owner]
    tier: [odl.io/tier, tier, criticality]

keep_annotations: [openshift.io/requester, openshift.io/display-name, ...]

thresholds:
  certificate_expiry_days: 30
  pod_restart_threshold: 5
  pod_pending_seconds: 300
  quota_warning_percent: 90
  capacity_warning_percent: 85
  capacity_critical_percent: 95
  cluster_admin_roles: [cluster-admin]

resources:
  clusterversion:        { enabled: true }
  nodes:                 { enabled: true }
  node_metrics:          { enabled: true }
  pods:                  { enabled: true }
  secrets:               { enabled: true, namespace_class: all }
  events:                { enabled: true, limit: 200 }
  ...
```

### `resources`

One entry per registry key.
`enabled` turns collection on or off.
Namespaced kinds also accept `namespace_class: all | application | platform` to limit collection to one class of namespace (for example, collect ConfigMaps only from application namespaces).
`events` accepts `limit`, the number of most recent Warning events kept per cluster.
A bare boolean (`nodes: true`) is shorthand for `{ enabled: true }`.

Every key, its API group, scope, and what it contributes is listed by `GET /api/manifest` and in the dashboard's Collected tab.
The registry today covers:

| Domain | Keys |
|---|---|
| platform | clusterversion, clusteroperators, infrastructure, network_config, ingress_config, nodes, machineconfigpools |
| metrics | node_metrics, pod_metrics (`metrics.k8s.io`) |
| workloads | namespaces, pods, deployments, statefulsets, daemonsets, cronjobs, horizontalpodautoscalers, resourcequotas |
| networking | services, routes, ingresses, networkpolicies |
| config | configmaps, secrets |
| storage | storageclasses, persistentvolumes, persistentvolumeclaims |
| operators | clusterserviceversions, subscriptions (OLM) |
| security | clusterrolebindings (only bindings to `thresholds.cluster_admin_roles`) |
| events | events (Warning only) |

### `namespaces`

Applications are namespaces.
Every namespace that is not an OpenShift / Kubernetes platform namespace is an application namespace; platform namespaces are collected too and grouped separately.
A namespace is platform if its name is in `platform.names`, starts with one of `platform.prefixes`, or carries any label key in `platform.label_keys`.

Application identity and ownership come from labels.
For each of `app`, `team` and `tier`, the first label in the list that is present on the namespace wins; if the namespace has none, the most common value across the namespace's workloads is used; `app` finally falls back to the namespace name.
This is how a namespace called `payments` with `odl.io/team=payments` on its Deployments becomes application `payments` owned by team `payments` even when the namespace itself is unlabelled.

### `keep_annotations`

Annotations are dropped unless listed here.
This is deliberate: `kubectl.kubernetes.io/last-applied-configuration` can embed an entire object, including Secret data.

### `thresholds`

Inputs to the health checks and status derivations (certificate windows, restart counts, quota and capacity percentages) and the roles reported by the cluster-admins insight.

## What is never collected

The scrub policy is enforced in `app/collector/scrub.py` and is **not configurable**.
It is applied inside the parsers, so a raw object's sensitive values never leave the parsing step:

| Scrubbed | What is kept instead |
|---|---|
| ConfigMap values | key names, byte sizes, certificate facts for PEM-looking keys |
| Secret values | type, key names, byte sizes, certificate facts for PEM-looking keys |
| Certificates | subject, issuer, not-before, not-after, SAN count, CA flag, a short fingerprint; the PEM is parsed and discarded |
| Container env values | env var names and their sources (`secretKeyRef` / `configMapKeyRef` / `fieldRef` name and key); literal values are dropped |
| Annotations | only the allow-listed keys |
| Container command / args | nothing; they are not collected at all |

`data-layer/tests/test_scrub.py` is the regression guarantee: it feeds Secrets, ConfigMaps and Deployments carrying known sentinel values through the parsers and asserts the sentinels do not appear anywhere in the output.

The read access to Secrets and ConfigMaps is what makes the certificate-expiry and configuration-reference insights possible.
If that access is not acceptable in an environment, disable `secrets` and `configmaps` in the manifest and regenerate the RBAC; those two insights then report nothing and everything else keeps working.

## Utilization from the OCP API

Live CPU and memory usage comes from the Kubernetes metrics API (`metrics.k8s.io/v1beta1` `NodeMetrics` and `PodMetrics`), which OpenShift serves through the API server via `prometheus-adapter` and kind serves via `metrics-server`.
The collector reads it on every sweep alongside the inventory: node usage is stored per node, pod usage is rolled up per namespace, and both roll up to the cluster.
Requests and limits (from pod specs) and capacity / allocatable (from nodes) are stored next to usage, so headroom is computed in one place.
A compact per-sweep snapshot keeps a utilization history per cluster for the timeline.

There is no Prometheus, Thanos or Grafana dependency.
If `metrics.k8s.io` is not served on a cluster, the cluster reports `metrics_available: false`, the capacity check becomes informational, and every other insight still works.

## Generating RBAC

```sh
make rbac      # writes deploy/rbac/odl-collector-readonly.yaml from the enabled keys
```

The generated `ClusterRole` grants `get` and `list` on exactly the enabled resources, grouped by API group.
Apply it to every cluster the collector reads.

## Customising without rebuilding

Point `ODL_MANIFEST` at a copy of the manifest (it is mounted read-only from `data-layer/config/` in the local stack) and restart the API.
`GET /api/manifest` reports the path that was loaded.

## Adding a resource

1. Add a `ResourceSpec` to `app/collector/registry.py` with the real group / version / plural / kind / scope and a one-line description.
2. Add a parser in `app/collector/parsers.py` that returns the scrubbed summary (use `meta()` for metadata so annotations are allow-listed) and register it in `collect.py`'s parser table.
3. Add the key to the manifest.
4. Regenerate RBAC and add a test.

Generic kinds land in the `resources` table with a `status` and, for certificate-bearing kinds, an `expires_at`, and are immediately queryable through `GET /api/insights/resources?kind=<key>` and the per-cluster resource browser.
