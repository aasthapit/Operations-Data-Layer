# The OCP API manifest

Everything the Operations Data Layer knows about a cluster is read from that cluster's own API server.
The **OCP API manifest** (`data-layer/config/ocp-api-manifest.yaml`) is the single declaration of *what* is read: every resource kind the collector can fetch, whether it is enabled, how namespaces are classified into applications versus platform, where application ownership comes from, and how every health check is graded.
Nothing outside the manifest is ever requested from a cluster, and the read-only RBAC the collector needs is generated from it.

This document explains the manifest, the scrub policy that sits behind it, and how to extend it.

## Design

```
config/ocp-api-manifest.yaml        what is enabled + options       (operators edit this)
app/collector/registry.py           how each key is fetched          (code: group/version/plural, scope, RBAC)
app/collector/parsers.py            how each object is normalised    (code: one parser per key, scrubbing inside)
app/collector/collect.py            fetch every enabled key that is DUE, assemble the document
                                    (kinds that are not due keep the last collection's rows)
deploy/rbac/odl-collector-readonly.yaml   GENERATED from the enabled keys
GET /api/manifest                   the manifest as the API serves it
GET /api/manifest/availability      per cluster, per key: collected / unavailable / forbidden /
                                    error / disabled, when it was last read, and what it cost
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
- the file is re-read whenever it changes on disk, so a registry export can be refreshed without a restart;
- `mapping.fallback: labels` lets a namespace the registry does not list be claimed by its own ownership labels (only the keys under `namespaces.ownership`, so restrict those to the labels that really name an application, e.g. `app_id` and `lob`); `fallback: none` trusts the registry alone.

### Platform namespaces as applications

`applications.platform_apps` groups OpenShift's own namespaces into applications of their own, so the platform appears in the applications and blast-radius views with a team and a tier:

```yaml
applications:
  platform_apps:
    - name: openshift-critical
      team: platform
      tier: critical
      namespaces: [openshift-etcd, openshift-kube-apiserver, openshift-ingress, openshift-monitoring]
    - name: openshift-platform
      team: platform
      tier: standard
      namespaces: ["openshift-*", "kube-*"]
```

Entries are exact names or prefixes ending in `*`, first match wins; a platform namespace no entry matches stays ungrouped.
Grouped namespaces keep `ns_class: platform` (platform pod issues, counters and resource filters are unchanged) and carry `ownership_source: platform`; every namespace row says where its ownership came from (`mapping`, `labels`, `platform`, or null when unassigned).

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

health_checks:
  no-degraded-operators:
    warn: { degraded: 1 }        # one degraded operator is a warning
    fail: { degraded: 3 }        # three are critical
  capacity-headroom:
    warn: { used_percent: 80 }
    fail: { used_percent: 90 }
  application-pods:
    enabled: false               # not run, not shown
  certificates-valid:
    severity: critical
    warn: { expiring: 1, expiring_within_days: 30 }
    fail: { expiring: 1, expiring_within_days: 7 }

resources:
  clusterversion:        { enabled: true, interval: 0 }     # every sweep
  nodes:                 { enabled: true, interval: 0 }
  node_metrics:          { enabled: true, interval: 0 }
  pods:                  { enabled: true, interval: 0 }
  deployments:           { enabled: true, interval: 15m }   # its own tier
  secrets:               { enabled: true, namespace_class: all, interval: 1h }
  events:                { enabled: true, limit: 200 }
  ...
```

### `resources`

One entry per registry key.
`enabled` turns collection on or off.
`interval` says how often that kind is collected, and is what [Tiers](#tiers-collect-each-kind-on-its-own-interval) below is about: `0` (the default) means every sweep.
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

The older flat block of numbers.
Two kinds live in it, and the difference decides when a change takes effect.

| Threshold | Acts at | What it does |
|---|---|---|
| `pod_restart_threshold` | collection | restarts at or above this make a pod an issue |
| `pod_pending_seconds` | collection | a pod Pending (or not-ready) longer than this is an issue |
| `certificate_expiry_days` | collection **and** evaluation | certificates inside this window are stored with status `expiring`; also the default of `certificates-valid.warn.expiring_within_days` |
| `quota_warning_percent` | collection **and** evaluation | a ResourceQuota at or above this is stored with status `warning`; also the default of `quotas-headroom.warn.max_percent` |
| `capacity_warning_percent` | evaluation | default of `capacity-headroom.warn.used_percent` |
| `capacity_critical_percent` | evaluation | default of `capacity-headroom.fail.used_percent` |
| `cluster_admin_roles` | collection | which ClusterRoleBindings the cluster-admins insight reports |

**Collection-time** thresholds are applied by the parsers while a cluster is read, so they decide what the stored document *says*; changing one only takes effect on the next sweep.
**Evaluation-time** levels are applied by the health checks to an already-collected document, so changing one re-grades the fleet on the next sweep without collecting anything different.
`GET /api/manifest` reports the scope of each threshold in `threshold_scope`.

The four thresholds that always fed a health check keep working and are now the *defaults* of the check level they always meant; a level set under `health_checks:` wins over them.

### `health_checks`

Every check in the panel is configurable, one entry per check name.

```yaml
health_checks:
  no-degraded-operators:
    enabled: true          # a disabled check is not run and not shown
    severity: critical     # what a FAILING check means for the cluster rollup
    warn: { degraded: 1 }  # levels, in this check's own unit
    fail: { degraded: 3 }
```

`severity` is `critical`, `warning` or `info`, and says what a **failing** check means for the cluster.
A measured value at or above `fail` is a fail, at or above `warn` is a warn, otherwise the check passes.
A band you set *replaces* that band's defaults rather than merging into it, so write every level you want in it: `fail: { degraded: 3 }` on its own means "never warn, fail at three", and `warn: {}` means "never warn".
Two levels read the other way round, and say so in the table below: `version-supported`'s `floor` (a version *below* it trips the band) and `expiring_within_days` (a window, not a level - it says how far ahead that band looks for expiring certificates).

The rollup, driven by those severities:

- any **fail** at `critical` severity makes the cluster `critical`;
- any **fail** at `warning` severity, and any **warn**, makes it `warning`;
- anything at `info` severity is surfaced but never degrades the rollup.

Three results are deliberately informational whatever the check's severity, because they report missing data or an expected transition rather than ill health: `capacity-headroom` on a cluster that does not serve `metrics.k8s.io`, `nodes-ready` on a cluster that reported no nodes, and `machine-config-pools` while a pool is updating.

#### Units per check

| Check | Severity | Levels (unit) | Defaults |
|---|---|---|---|
| `cluster-reachable` | critical | - | fails when the collector cannot connect |
| `managed-available` | critical | - | fails on `ManagedClusterConditionAvailable=False` |
| `cluster-version-available` | critical | - | fails when ClusterVersion is Failing or not Available |
| `critical-operators-available` | critical | `unavailable` (count) | `fail: 1` |
| `no-degraded-operators` | critical | `degraded` (count) | `fail: 1` |
| `nodes-ready` | critical | `not_ready` (count), `not_ready_percent` (percent) | `fail: { not_ready: 1 }` |
| `nodes-pressure` | warning | `pressured` (count), `cordoned` (count) | `warn: { cordoned: 1 }`, `fail: { pressured: 1 }` |
| `version-supported` | warning | `floor` (version, *below* trips) | `fail: { floor: SUPPORTED_FLOOR }` |
| `upgrade-in-progress` | info | - | warns while an upgrade is applying |
| `operators-stable` | warning | `progressing` (count, outside an upgrade) | `warn: 1` |
| `machine-config-pools` | critical | `degraded` (count), `updating` (count) | `warn: { updating: 1 }`, `fail: { degraded: 1 }` |
| `platform-pods` | warning | `issues` (count), `issues_percent` (percent of the class's pods) | `warn: { issues: 1 }` |
| `application-pods` | info | `issues` (count), `issues_percent` (percent of the class's pods) | `warn: { issues: 1 }` |
| `capacity-headroom` | warning | `used_percent` (percent of allocatable, worse of CPU and memory) | `warn: 85`, `fail: 95` |
| `certificates-valid` | warning | `expired` (count), `expiring` (count inside the band's window), `expiring_within_days` (days, the window) | `warn: { expiring: 1, expiring_within_days: 30 }`, `fail: { expired: 1 }` |
| `quotas-headroom` | info | `max_percent` (percent of a hard limit), `namespaces` (count at or above the warn percent) | `warn: { max_percent: 90 }` |
| `olm-operators-healthy` | warning | `unhealthy` (count) | `warn: 1` |
| `update-available` | info | - | warns when a newer release is offered |

`cluster-reachable` is the only check that runs on an unreachable cluster, so it cannot be disabled (the manifest refuses); its severity can be lowered when an unreachable cluster should not count as critical.
`olm-operators-healthy` is skipped on a cluster without OLM, and `machine-config-pools` on one that did not serve them.

#### Examples

"Treat 1 degraded operator as a warning and 3 as critical":

```yaml
health_checks:
  no-degraded-operators:
    warn: { degraded: 1 }
    fail: { degraded: 3 }
```

"A certificate with a week left is a failure, not a warning":

```yaml
health_checks:
  certificates-valid:
    warn: { expiring: 1, expiring_within_days: 30 }
    fail: { expired: 1, expiring: 1, expiring_within_days: 7 }
```

"Application pods are this estate's problem after all" (they are informational by default):

```yaml
health_checks:
  application-pods:
    severity: warning
    warn: { issues_percent: 5 }
    fail: { issues_percent: 20 }
```

"We run a busy estate: only page on real saturation, and never on a cordon":

```yaml
health_checks:
  capacity-headroom:
    warn: { used_percent: 92 }
    fail: { used_percent: 98 }
  nodes-pressure:
    warn: {}
    fail: { pressured: 2 }
```

An unknown check name, an unknown level for a check, a `warn` that is only reached after `fail`, a bad severity or a level of the wrong type is a `ManifestError` at load: the API refuses to start on a manifest it cannot honour rather than silently grading the fleet differently.

#### What a check result carries

Every check result carries what it measured and the levels that applied, so a reader never has to open the manifest to understand a status:

```json
{
  "name": "capacity-headroom", "title": "Capacity headroom",
  "status": "warn", "severity": "warning",
  "message": "CPU at 88% of allocatable",
  "value": {"used_percent": 88.0},
  "levels": {"warn": {"used_percent": 85}, "fail": {"used_percent": 95}}
}
```

`GET /api/manifest` describes the effective configuration of every check (title, enabled, severity, units, warn, fail, description), which is what the dashboard and the MCP `what_is_collected` tool show.

## Tiers: collect each kind on its own interval

Every resource takes an `interval`: how often that kind is collected.
`0`, the default, means every sweep, the sweep being `REFRESH_INTERVAL_SECONDS`.
Anything else is a tier, written as seconds or as a duration (`90`, `2m`, `15m`, `1h`, `1d`).

```yaml
resources:
  clusterversion: { enabled: true,  interval: 0 }      # every sweep
  deployments:    { enabled: true,  interval: 15m }    # inventory, on its own tier
  secrets:        { enabled: false, interval: 1h }     # off here; hourly if you need it
```

This is the difference between a data layer that works on ten clusters and one that works on eight hundred.
A full pass over a large cluster pulls on the order of 120 MB of Kubernetes JSON ([ADR-0003](adr/0003-enterprise-scale.md), Finding 1), and most of it is inventory that changes when somebody deploys, not every two minutes.
Tiers keep the platform state that the health panel grades fresh every sweep, and re-read the rest on a schedule.

### How "due" is decided

Per cluster and per kind, the collector records `collected_at` on the kind's `resource_status` entry.
At the start of a cluster's collection it reads that back, together with the sections the merge may need (the cluster summary, then one pipelined read of the sections), and a kind is due when any of the following holds:

- a full refresh was asked for (`POST /api/refresh?full=true`),
- its `interval` is 0,
- it has never been collected, so there is nothing to keep,
- `now - collected_at >= interval`.

An attempt counts as a collection whatever its outcome, so a kind that is forbidden on a cluster is retried on its tier rather than on every sweep.
A kind that is not due keeps its previous status entry, marked `cached`, with the `collected_at` of the collection that did fetch it.
`GET /api/manifest/availability` shows all of it per cluster and per kind: status, `collected_at`, `cached`, `interval_seconds`, and what the last fetch cost (`duration_ms`, `requests`, `bytes`, `objects`, `parse_ms`).

### What is rebuilt and what is kept

The stored document has exactly the same shape whether a sweep collected everything or almost nothing, so health checks, the store and the API cannot tell the difference.
What varies is where each part comes from:

| Part of the document | When its kind is due | When it is not |
|---|---|---|
| `resources` rows | rebuilt from the fetch, per kind | the previous rows of that kind are kept |
| `workloads`, `workload_images`, `workload_refs` | rebuilt for each due workload kind | the rows of the kinds that were not due are kept, grouped by kind |
| `operators`, `nodes` | rebuilt | kept |
| cluster config (ClusterVersion, Infrastructure, Network, Ingress) | reparsed | kept from the last parse |
| namespace rollups (pods, workloads, resource counts) | always recomputed from the pods of this sweep and whatever workload and inventory rows are in play | pod rollups stand only if pods themselves were not due |
| `pod_issues` | from this sweep's pods | kept |
| capacity | recomputed from the nodes in play plus metrics | - |

Two consequences worth knowing:

- A kind that becomes forbidden, unavailable or disabled is reported as such and its previous rows are **dropped**.
  The document always says what the cluster serves today, never what it used to serve.
- Node usage and per-namespace usage follow the metrics kinds' tiers, not the nodes' or namespaces' tier: a node row that was kept still gets this sweep's usage if `node_metrics` was due, and keeps the last reading if it was not.

Pods belong in the fast tier.
Putting them on a slow one is supported (the rollups and pod issues simply stand until they are read again), but the health panel is then as old as that tier.

### The fleet profile

`data-layer/config/ocp-api-manifest.fleet.yaml` is the production profile: the default manifest, with a schedule.

- Every sweep: `clusterversion`, `clusteroperators`, `infrastructure`, `network_config`, `ingress_config`, `nodes`, `node_metrics`, `machineconfigpools`, `namespaces`, `pods`, `pod_metrics`, `events`.
- Every 15 minutes: `deployments`, `statefulsets`, `daemonsets`, `cronjobs`, `horizontalpodautoscalers`, `services`, `routes`, `ingresses`, `networkpolicies`, `persistentvolumeclaims`, `persistentvolumes`, `storageclasses`, `resourcequotas`, `clusterserviceversions`, `subscriptions`, `clusterrolebindings`.
- Off: `secrets` and `configmaps`, the two heaviest kinds, together with the `certificates-valid` health check that grades what they carry.

Use it with `ODL_MANIFEST=config/ocp-api-manifest.fleet.yaml`.
To get certificate expiry back without paying for it every sweep, read those two kinds hourly and turn the check back on:

```yaml
resources:
  secrets:    { enabled: true, interval: 1h }
  configmaps: { enabled: true, interval: 1h }
health_checks:
  certificates-valid: { enabled: true }
```

Changing a manifest does not retroactively change what is stored.
After editing tiers, `POST /api/refresh?full=true` collects everything once so the whole picture is from the new manifest; without it, each kind simply comes back on its new tier.

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
