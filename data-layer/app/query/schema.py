"""
The relational schema of the DuckDB snapshot - and the semantic layer.

This module is the single source of truth for three audiences:

  * the snapshot builder, which creates exactly these tables from the store;
  * the guard, whose table allowlist is `ALLOWED_TABLES`;
  * the model, which is handed `schema_text()` as its (cached) system prompt.

The tables and column names are the ones the data layer has always had (the
former SQLAlchemy models, which were the Postgres schema): keeping them
verbatim means `docs/architecture.md` "Data model", the API's field names and
the SQL an agent writes all describe the same thing. Only the surrogate `id`
columns are gone - they carried no meaning across a rebuild, and rows are
identified by (cluster_name, name) or (cluster_name, namespace, name).

The per-column descriptions are not documentation garnish: they are the
semantics the model has to work from. A column whose meaning is not obvious
from its name ("ns_class", "key", "critical") gets a sentence saying what the
values are.
"""
from __future__ import annotations

from dataclasses import dataclass

# --------------------------------------------------------------------------- #
# table definitions
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Column:
    name: str
    type: str
    doc: str


@dataclass(frozen=True)
class Table:
    name: str
    doc: str
    source: str                     # how the snapshot builder fills it
    columns: tuple[Column, ...]

    @property
    def column_names(self) -> tuple[str, ...]:
        return tuple(c.name for c in self.columns)


def _table(name: str, doc: str, source: str, columns: list[tuple[str, str, str]]) -> Table:
    return Table(name=name, doc=doc, source=source,
                 columns=tuple(Column(n, t, d) for n, t, d in columns))


HUBS = _table(
    "hubs",
    "ACM hubs (or logical groups of directly configured clusters). One row per hub.",
    "store.hubs()",
    [
        ("name", "VARCHAR", "Hub name, referenced by clusters.hub_name."),
        ("region", "VARCHAR", "Region the hub itself runs in."),
        ("datacenter", "VARCHAR", "Datacenter the hub itself runs in."),
        ("managed_count", "INTEGER", "How many clusters the hub reported on the last sweep."),
        ("reachable", "BOOLEAN", "False when the last sweep could not reach the hub."),
        ("last_synced", "TIMESTAMP", "When the collector last talked to this hub (UTC)."),
        ("last_error", "VARCHAR", "Error from the last failed hub contact, else NULL."),
    ],
)

CLUSTERS = _table(
    "clusters",
    "One row per managed OpenShift cluster: placement, version, capacity, rollups and health. "
    "The centre of the model - almost every question joins to it on clusters.name.",
    "store.clusters()",
    [
        ("name", "VARCHAR", "Cluster name. Primary key; every other table joins on cluster_name."),
        ("hub_name", "VARCHAR", "Hub that manages this cluster (hubs.name)."),
        ("display_name", "VARCHAR", "Human label; equals name unless ACM reports another."),
        ("region", "VARCHAR", "Placement region, e.g. 'us-east-1'."),
        ("datacenter", "VARCHAR", "Placement datacenter."),
        ("environment", "VARCHAR", "Environment label, e.g. 'prod', 'stage', 'dev'."),
        ("cloud", "VARCHAR", "Cloud provider label, e.g. 'aws'."),
        ("vendor", "VARCHAR", "Distribution vendor, normally 'OpenShift'."),
        ("platform", "VARCHAR", "Infrastructure platform reported by the cluster, e.g. 'AWS', 'BareMetal'."),
        ("cluster_id", "VARCHAR", "ClusterVersion spec.clusterID (the cluster's global UUID)."),
        ("infrastructure_name", "VARCHAR", "Infrastructure status.infrastructureName."),
        ("api_url", "VARCHAR", "API server URL."),
        ("control_plane_topology", "VARCHAR", "'HighlyAvailable' | 'SingleReplica' | 'External'."),
        ("infrastructure_topology", "VARCHAR", "Worker topology: 'HighlyAvailable' | 'SingleReplica'."),
        ("network_type", "VARCHAR", "CNI, e.g. 'OVNKubernetes'."),
        ("cluster_network", "JSON", "List of pod network CIDRs."),
        ("service_network", "JSON", "List of service network CIDRs."),
        ("apps_domain", "VARCHAR", "Default ingress domain for routes, e.g. 'apps.c1.example.com'."),
        ("ocp_version", "VARCHAR", "Current OpenShift version, e.g. '4.16.7'. Compare with LIKE '4.16%'."),
        ("desired_version", "VARCHAR", "Version the cluster is moving to (equals ocp_version when settled)."),
        ("channel", "VARCHAR", "Update channel, e.g. 'stable-4.16'."),
        ("upgrading", "BOOLEAN", "True while an upgrade is in progress."),
        ("upgrade_percent", "INTEGER", "Upgrade completion percent while upgrading."),
        ("available_updates", "JSON", "List of versions the cluster could update to."),
        ("kube_version", "VARCHAR", "Kubernetes version of the API server."),
        ("nodes_total", "INTEGER", "Nodes in the cluster."),
        ("nodes_ready", "INTEGER", "Nodes with Ready=True. nodes_total - nodes_ready are not ready."),
        ("cpu_capacity", "DOUBLE", "Sum of node CPU capacity, in cores."),
        ("cpu_allocatable", "DOUBLE",
         "Sum of node allocatable CPU, in cores. The denominator for CPU usage."),
        ("cpu_requests", "DOUBLE", "Sum of pod CPU requests, in cores."),
        ("cpu_limits", "DOUBLE", "Sum of pod CPU limits, in cores."),
        ("cpu_usage", "DOUBLE", "Live CPU usage from metrics.k8s.io, in cores. NULL without metrics."),
        ("memory_capacity", "BIGINT", "Sum of node memory capacity, in bytes."),
        ("memory_allocatable", "BIGINT", "Sum of node allocatable memory, in bytes."),
        ("memory_requests", "BIGINT", "Sum of pod memory requests, in bytes."),
        ("memory_limits", "BIGINT", "Sum of pod memory limits, in bytes."),
        ("memory_usage", "BIGINT", "Live memory usage, in bytes. NULL without metrics."),
        ("pods_capacity", "INTEGER", "Sum of node pod capacity."),
        ("pods_total", "INTEGER", "Pods in all collected namespaces."),
        ("pods_running", "INTEGER", "Pods in phase Running."),
        ("metrics_available", "BOOLEAN", "False when metrics.k8s.io did not answer; usage columns are NULL."),
        ("namespaces_application", "INTEGER", "Application namespaces (see the note on applications)."),
        ("applications_total", "INTEGER", "Distinct applications on the cluster (assigned namespaces only)."),
        ("namespaces_platform", "INTEGER", "Platform (OpenShift / Kubernetes) namespaces."),
        ("workloads_total", "INTEGER", "Deployments + StatefulSets + DaemonSets collected."),
        ("pod_issues_total", "INTEGER", "Pods currently unhealthy on this cluster."),
        ("certs_expiring_total", "INTEGER", "Certificates expired or expiring inside the manifest window."),
        ("managed_available", "BOOLEAN", "ACM's ManagedClusterConditionAvailable."),
        ("overall_status", "VARCHAR", "Computed health: 'healthy' | 'warning' | 'critical' | 'unknown'."),
        ("health_score", "INTEGER", "0-100 score derived from the health checks."),
        ("checks_passed", "INTEGER", "Health checks that passed."),
        ("checks_warned", "INTEGER", "Health checks that warned."),
        ("checks_failed", "INTEGER", "Health checks that failed."),
        ("last_synced", "TIMESTAMP", "When this cluster was last collected (UTC)."),
        ("collect_ms", "INTEGER", "How long collecting this cluster took, in milliseconds."),
        ("timings", "JSON",
         "What the last collection of this cluster cost, per stage, in milliseconds: "
         "fetch_ms (network and API server), parse_ms (JSON decoding, measured inside the "
         "fetch window), assemble_ms, health_ms, persist_ms; plus bytes and objects pulled "
         "and kinds_fetched / kinds_cached. Read a field with "
         "CAST(json_extract(timings, '$.fetch_ms') AS BIGINT). NULL for a cluster collected "
         "before the collector measured itself."),
        ("reachable", "BOOLEAN",
         "False when the last sweep could not connect; detail tables are then empty."),
        ("last_error", "VARCHAR", "Error from the last failed collection, else NULL."),
    ],
)

CLUSTER_OPERATORS = _table(
    "cluster_operators",
    "OpenShift cluster operators (the platform's own components) per cluster. "
    "The table for version drift and degraded-platform questions.",
    "store.section_across('operators')",
    [
        ("cluster_name", "VARCHAR", "Cluster this operator runs on (clusters.name)."),
        ("name", "VARCHAR", "Operator name, e.g. 'ingress', 'authentication', 'etcd'."),
        ("version", "VARCHAR", "Version the operator reports. Differing versions across clusters is drift."),
        ("available", "BOOLEAN", "Available condition."),
        ("progressing", "BOOLEAN", "Progressing condition (mid-rollout)."),
        ("degraded", "BOOLEAN", "Degraded condition. degraded = true is the 'broken operator' filter."),
        ("critical", "BOOLEAN", "Operator flagged business-critical by label."),
        ("message", "VARCHAR", "Condition message explaining a degraded / progressing state."),
    ],
)

NODES = _table(
    "nodes",
    "Nodes of every cluster, with capacity and live usage.",
    "store.section_across('nodes')",
    [
        ("cluster_name", "VARCHAR", "Cluster the node belongs to."),
        ("name", "VARCHAR", "Node name."),
        ("roles", "JSON", "List of roles, e.g. ['master'], ['worker']."),
        ("ready", "BOOLEAN", "Ready condition."),
        ("schedulable", "BOOLEAN", "False when the node is cordoned."),
        ("conditions", "JSON", "Object of pressure conditions: MemoryPressure, DiskPressure, PIDPressure."),
        ("kubelet_version", "VARCHAR", "Kubelet version."),
        ("os_image", "VARCHAR", "Operating system image."),
        ("kernel_version", "VARCHAR", "Kernel version."),
        ("container_runtime", "VARCHAR", "Container runtime and version."),
        ("architecture", "VARCHAR", "CPU architecture, e.g. 'amd64'."),
        ("instance_type", "VARCHAR", "Cloud instance type."),
        ("zone", "VARCHAR", "Availability zone."),
        ("internal_ip", "VARCHAR", "Internal IP address."),
        ("cpu_capacity", "DOUBLE", "CPU capacity, in cores."),
        ("cpu_allocatable", "DOUBLE", "Allocatable CPU, in cores."),
        ("cpu_usage", "DOUBLE", "Live CPU usage, in cores. NULL without metrics."),
        ("memory_capacity", "BIGINT", "Memory capacity, in bytes."),
        ("memory_allocatable", "BIGINT", "Allocatable memory, in bytes."),
        ("memory_usage", "BIGINT", "Live memory usage, in bytes. NULL without metrics."),
        ("ephemeral_storage_allocatable", "BIGINT", "Allocatable ephemeral storage, in bytes."),
        ("pods_capacity", "INTEGER", "Maximum pods the kubelet accepts."),
        ("pods_running", "INTEGER", "Pods currently scheduled on the node."),
        ("images_count", "INTEGER", "Container images cached on the node."),
        ("images_bytes", "BIGINT", "Bytes of cached images."),
        ("taints", "JSON", "List of {key, effect}."),
        ("created_at", "TIMESTAMP", "When the node object was created (UTC)."),
    ],
)

NAMESPACES = _table(
    "namespaces",
    "Every namespace on every cluster. Application namespaces ARE the applications, "
    "so this is also the applications, teams and ownership table.",
    "store.section_across('namespaces')",
    [
        ("cluster_name", "VARCHAR", "Cluster the namespace is on."),
        ("name", "VARCHAR", "Namespace name."),
        ("ns_class", "VARCHAR", "'application' or 'platform' (OpenShift / Kubernetes own namespaces)."),
        ("app_name", "VARCHAR", "Application identity: from the application mapping file when one is "
                                "configured (then NULL means the namespace is under no business "
                                "application), otherwise from the app label or the namespace name. "
                                "The same app_name on several clusters is the same application."),
        ("team", "VARCHAR", "Owning team or line of business (the mapping's lob). NULL when unknown."),
        ("tier", "VARCHAR", "Criticality tier from labels, e.g. 'critical', 'standard'; "
                            "NULL with a mapping."),
        ("environment", "VARCHAR", "Namespace-level environment from the mapping (e.g. development, "
                                   "test, ist). NULL when unknown. clusters.environment is the cluster's."),
        ("assigned", "BOOLEAN", "FALSE when the namespace is under no business application "
                                "(only possible with a mapping file)."),
        ("ownership_source", "VARCHAR", "Where app_name came from: 'mapping' (the registry), 'labels', "
                                        "'platform' (a configured platform application grouping "
                                        "OpenShift namespaces), or NULL when unassigned."),
        ("labels", "JSON", "Namespace labels."),
        ("annotations", "JSON", "Allow-listed namespace annotations only."),
        ("requester", "VARCHAR", "openshift.io/requester annotation (who asked for the namespace)."),
        ("display_name", "VARCHAR", "openshift.io/display-name annotation."),
        ("phase", "VARCHAR", "Namespace phase: 'Active' | 'Terminating'."),
        ("status", "VARCHAR", "Rolled-up namespace health: 'healthy' | 'warning' | 'critical' | 'unknown'."),
        ("workloads_total", "INTEGER", "Deployments + StatefulSets + DaemonSets in the namespace."),
        ("replicas_desired", "INTEGER", "Sum of desired replicas."),
        ("replicas_ready", "INTEGER", "Sum of ready replicas. Less than desired means a rollout or a fault."),
        ("pods_total", "INTEGER", "Pods in the namespace."),
        ("pods_running", "INTEGER", "Pods in phase Running."),
        ("pods_pending", "INTEGER", "Pods in phase Pending."),
        ("pods_failed", "INTEGER", "Pods in phase Failed."),
        ("pods_succeeded", "INTEGER", "Pods in phase Succeeded."),
        ("restarts_total", "INTEGER", "Container restarts summed over the namespace's pods."),
        ("pod_issues", "INTEGER", "Unhealthy pods in the namespace (see pod_issues table)."),
        ("cpu_requests", "DOUBLE", "Sum of CPU requests, in cores."),
        ("cpu_limits", "DOUBLE", "Sum of CPU limits, in cores."),
        ("cpu_usage", "DOUBLE", "Live CPU usage, in cores. NULL without metrics."),
        ("memory_requests", "BIGINT", "Sum of memory requests, in bytes."),
        ("memory_limits", "BIGINT", "Sum of memory limits, in bytes."),
        ("memory_usage", "BIGINT", "Live memory usage, in bytes. NULL without metrics."),
        ("resource_counts", "JSON", "Object of per-kind counts in the namespace, e.g. {\"secrets\": 12}."),
        ("images", "JSON", "Distinct container images running in the namespace."),
        ("created_at", "TIMESTAMP", "When the namespace was created (UTC)."),
    ],
)

WORKLOADS = _table(
    "workloads",
    "Deployments, StatefulSets and DaemonSets with replica state and scrubbed container detail.",
    "store.section_across('workloads')",
    [
        ("cluster_name", "VARCHAR", "Cluster the workload runs on."),
        ("namespace", "VARCHAR", "Namespace of the workload (namespaces.name on the same cluster)."),
        ("ns_class", "VARCHAR", "'application' or 'platform', copied from the namespace."),
        ("kind", "VARCHAR", "'Deployment' | 'StatefulSet' | 'DaemonSet'."),
        ("name", "VARCHAR", "Workload name."),
        ("replicas_desired", "INTEGER", "Desired replicas."),
        ("replicas_ready", "INTEGER", "Ready replicas."),
        ("replicas_available", "INTEGER", "Available replicas."),
        ("replicas_updated", "INTEGER", "Replicas already on the newest template."),
        ("status", "VARCHAR", "'healthy' | 'progressing' | 'degraded'."),
        ("containers", "JSON", "List of containers: name, image, env var NAMES and their sources, "
                               "requests and limits. Values are never collected."),
        ("images", "JSON", "List of image strings used by the workload."),
        ("config_refs", "JSON", "List of {kind, name, via} configuration references."),
        ("service_account", "VARCHAR", "ServiceAccount the pods run as."),
        ("node_selector", "JSON", "Node selector of the pod template."),
        ("strategy", "VARCHAR", "Update strategy, e.g. 'RollingUpdate'."),
        ("labels", "JSON", "Workload labels (where app / team / tier ownership comes from)."),
        ("conditions", "JSON", "Workload conditions."),
        ("created_at", "TIMESTAMP", "When the workload was created (UTC)."),
    ],
)

WORKLOAD_IMAGES = _table(
    "workload_images",
    "One row per container image reference: which workload on which cluster runs which image. "
    "The input to an image or CVE blast radius.",
    "store.section_across('workload_images')",
    [
        ("cluster_name", "VARCHAR", "Cluster running the image."),
        ("namespace", "VARCHAR", "Namespace of the workload."),
        ("workload_kind", "VARCHAR", "'Deployment' | 'StatefulSet' | 'DaemonSet'."),
        ("workload_name", "VARCHAR", "Workload name."),
        ("container", "VARCHAR", "Container name inside the pod template."),
        ("image", "VARCHAR", "Full image string as written in the pod spec."),
        ("registry", "VARCHAR", "Registry host, e.g. 'quay.io', 'docker.io'."),
        ("repository", "VARCHAR", "Repository path without the registry, e.g. 'acme/api'."),
        ("tag", "VARCHAR", "Tag, e.g. '1.19'. NULL when the image is pinned by digest only."),
        ("digest", "VARCHAR", "sha256 digest when the image is pinned by digest."),
    ],
)

WORKLOAD_REFS = _table(
    "workload_refs",
    "One row per configuration reference: which workload depends on which Secret, ConfigMap, "
    "PVC or ServiceAccount. The blast radius of rotating a secret or editing a config map.",
    "store.section_across('workload_refs')",
    [
        ("cluster_name", "VARCHAR", "Cluster the workload runs on."),
        ("namespace", "VARCHAR", "Namespace of the workload and of the referenced object."),
        ("workload_kind", "VARCHAR", "'Deployment' | 'StatefulSet' | 'DaemonSet'."),
        ("workload_name", "VARCHAR", "Workload name."),
        ("ref_kind", "VARCHAR", "'Secret' | 'ConfigMap' | 'PersistentVolumeClaim' | 'ServiceAccount'."),
        ("ref_name", "VARCHAR", "Name of the referenced object."),
        ("via", "VARCHAR", "How it is used: 'env' | 'envFrom' | 'volume' | 'imagePullSecret' "
                           "| 'serviceAccount'."),
    ],
)

POD_ISSUES = _table(
    "pod_issues",
    "Pods that are currently unhealthy. One row per bad pod; a healthy pod is not in this table.",
    "store.section_across('pod_issues')",
    [
        ("cluster_name", "VARCHAR", "Cluster the pod runs on."),
        ("namespace", "VARCHAR", "Namespace of the pod."),
        ("ns_class", "VARCHAR", "'application' or 'platform' - separates app pain from platform pain."),
        ("name", "VARCHAR", "Pod name."),
        ("node", "VARCHAR", "Node the pod is scheduled on (NULL when unschedulable)."),
        ("phase", "VARCHAR", "Pod phase: 'Pending' | 'Running' | 'Failed' | 'Succeeded'."),
        ("reason", "VARCHAR", "Why it is unhealthy: 'CrashLoopBackOff', 'ImagePullBackOff', "
                              "'Unschedulable', 'Pending', 'OOMKilled', 'HighRestarts', 'NotReady', "
                              "'Failed', 'Evicted'."),
        ("message", "VARCHAR", "Detail message from the pod status."),
        ("restarts", "INTEGER", "Container restart count."),
        ("owner_kind", "VARCHAR", "Kind of the owning workload, e.g. 'Deployment'."),
        ("owner_name", "VARCHAR", "Name of the owning workload."),
        ("containers_ready", "VARCHAR", "Ready containers as a string, e.g. '1/2'."),
        ("started_at", "TIMESTAMP", "When the pod started (UTC)."),
    ],
)

RESOURCES = _table(
    "resources",
    "Scrubbed inventory of every other collected kind: routes, secrets, config maps, PVCs, PVs, "
    "storage classes, quotas, events, cron jobs, HPAs, OLM CSVs and subscriptions, machine config "
    "pools, cluster role bindings. One row per object; the kind-specific detail is in `summary`.",
    "store.section_across('resources')",
    [
        ("cluster_name", "VARCHAR", "Cluster the object lives on."),
        ("key", "VARCHAR", "Manifest key naming the kind (see the enumeration below), e.g. 'routes'."),
        ("kind", "VARCHAR", "Kubernetes kind, e.g. 'Route'."),
        ("api_group", "VARCHAR", "API group, e.g. 'route.openshift.io/v1'."),
        ("namespace", "VARCHAR", "Namespace, NULL for cluster-scoped objects."),
        ("ns_class", "VARCHAR", "'application' or 'platform' for namespaced objects, else NULL."),
        ("name", "VARCHAR", "Object name."),
        ("status", "VARCHAR", "Kind-specific status, e.g. 'bound' | 'pending' for PVCs, "
                              "'expired' | 'expiring' | 'valid' for certificate holders, "
                              "'degraded' | 'updating' | 'updated' for machine config pools, "
                              "'succeeded' | 'failed' for OLM CSVs, 'ok' | 'warning' | 'exhausted' "
                              "for quotas."),
        ("expires_at", "TIMESTAMP", "Earliest certificate expiry for Secrets / ConfigMaps that hold one "
                                    "(UTC). NULL for everything else."),
        ("labels", "JSON", "Object labels."),
        ("summary", "JSON", "The scrubbed, normalised detail; its shape depends on `key`. "
                            "Read it with json_extract_string(summary, '$.field')."),
        ("created_at", "TIMESTAMP", "When the object was created (UTC)."),
    ],
)

RESOURCE_STATUS = _table(
    "resource_status",
    "Per cluster and manifest key: could the collector read it? Explains why a cluster is missing "
    "from an inventory answer (no OLM, no metrics API, RBAC denied).",
    "store.section_across('resource_status')",
    [
        ("cluster_name", "VARCHAR", "Cluster the attempt was made against."),
        ("key", "VARCHAR", "Manifest key, e.g. 'routes'."),
        ("status", "VARCHAR", "'collected' | 'unavailable' (API not served) | 'forbidden' (RBAC) "
                              "| 'error' | 'disabled' (turned off in the manifest)."),
        ("count", "INTEGER", "Objects collected."),
        ("duration_ms", "INTEGER", "How long the call took, in milliseconds."),
        ("error", "VARCHAR", "Error text when status is not 'collected'."),
    ],
)

HEALTH_CHECKS = _table(
    "health_checks",
    "Current result of every precondition check for every cluster. The detail behind "
    "clusters.overall_status and clusters.health_score.",
    "store.section_across('health_checks')",
    [
        ("cluster_name", "VARCHAR", "Cluster the check was evaluated on."),
        ("name", "VARCHAR", "Check id, e.g. 'no-degraded-operators', 'version-supported'."),
        ("title", "VARCHAR", "Human title of the check."),
        ("status", "VARCHAR", "'pass' | 'warn' | 'fail'."),
        ("severity", "VARCHAR", "'critical' | 'warning' | 'info'. A failing check at 'critical' "
                                "makes the cluster critical; 'info' never degrades it."),
        ("message", "VARCHAR", "Why it warned or failed."),
        ("value", "JSON", "What the check measured, keyed by its unit, e.g. "
                          "{\"used_percent\": 87.2} or {\"degraded\": 2}."),
        ("levels", "JSON", "The configured levels that applied: "
                           "{\"warn\": {...}, \"fail\": {...}} in the same units."),
    ],
)

HEALTH_SNAPSHOTS = _table(
    "health_snapshots",
    "Append-only per-sweep time series per cluster: health and utilization. The only table with "
    "history - every other table is the current state.",
    "store.snapshots(cluster)",
    [
        ("cluster_name", "VARCHAR", "Cluster the snapshot belongs to."),
        ("overall_status", "VARCHAR", "Cluster status at that moment."),
        ("health_score", "INTEGER", "Health score at that moment."),
        ("checks_passed", "INTEGER", "Checks passing at that moment."),
        ("checks_warned", "INTEGER", "Checks warning at that moment."),
        ("checks_failed", "INTEGER", "Checks failing at that moment."),
        ("ocp_version", "VARCHAR", "Version at that moment (compare consecutive rows to see an upgrade)."),
        ("upgrading", "BOOLEAN", "Whether an upgrade was in progress."),
        ("cpu_usage", "DOUBLE", "Live CPU usage then, in cores."),
        ("cpu_allocatable", "DOUBLE", "Allocatable CPU then, in cores."),
        ("memory_usage", "BIGINT", "Live memory usage then, in bytes."),
        ("memory_allocatable", "BIGINT", "Allocatable memory then, in bytes."),
        ("pods_running", "INTEGER", "Running pods then."),
        ("pod_issues", "INTEGER", "Unhealthy pods then."),
        ("snapshot_at", "TIMESTAMP", "When the sweep took this snapshot (UTC). Order by this."),
    ],
)

COLLECTION_RUNS = _table(
    "collection_runs",
    "One row per collection sweep - observability of the data layer itself, not of the fleet.",
    "store.runs(200)",
    [
        ("id", "VARCHAR", "Run id."),
        ("started_at", "TIMESTAMP", "When the sweep started (UTC)."),
        ("finished_at", "TIMESTAMP", "When it finished (UTC); NULL while running."),
        ("duration_ms", "INTEGER", "How long it took, in milliseconds."),
        ("hubs_total", "INTEGER", "Hubs contacted."),
        ("clusters_total", "INTEGER", "Clusters discovered."),
        ("clusters_ok", "INTEGER", "Clusters collected successfully."),
        ("clusters_failed", "INTEGER", "Clusters that failed."),
        ("trigger", "VARCHAR", "'startup' | 'scheduled' | 'manual'."),
        ("error", "VARCHAR", "Sweep-level error, else NULL."),
    ],
)

TABLES: tuple[Table, ...] = (
    HUBS, CLUSTERS, CLUSTER_OPERATORS, NODES, NAMESPACES, WORKLOADS, WORKLOAD_IMAGES,
    WORKLOAD_REFS, POD_ISSUES, RESOURCES, RESOURCE_STATUS, HEALTH_CHECKS, HEALTH_SNAPSHOTS,
    COLLECTION_RUNS,
)
TABLES_BY_NAME: dict[str, Table] = {t.name: t for t in TABLES}

# The guard's allowlist. Anything else in a FROM or JOIN is rejected.
ALLOWED_TABLES: frozenset[str] = frozenset(TABLES_BY_NAME)

# Sections of the store that map one-to-one onto a snapshot table.
SECTION_TABLES: dict[str, str] = {
    "operators": CLUSTER_OPERATORS.name,
    "nodes": NODES.name,
    "namespaces": NAMESPACES.name,
    "workloads": WORKLOADS.name,
    "workload_images": WORKLOAD_IMAGES.name,
    "workload_refs": WORKLOAD_REFS.name,
    "pod_issues": POD_ISSUES.name,
    "resources": RESOURCES.name,
    "resource_status": RESOURCE_STATUS.name,
    "health_checks": HEALTH_CHECKS.name,
}

# --------------------------------------------------------------------------- #
# curated semantics
# --------------------------------------------------------------------------- #

# What a newcomer would have to be told before their first query is right.
# These are the notes that turn column names into meaning.
NOTES: tuple[str, ...] = (
    "An application is a namespace: every namespace that is not an OpenShift / Kubernetes "
    "platform namespace has ns_class='application', and its app_name identifies the application "
    "across clusters. 'Applications per team' is therefore a query over namespaces, not over some "
    "applications table.",
    "Ownership comes either from labels (then app_name falls back to the namespace name and is never "
    "NULL) or from an application mapping file (then app_name is the registry's application id, team "
    "is the line of business, environment is the namespace's environment, and app_name IS NULL / "
    "assigned = FALSE means the namespace is under no business application). Every resource in a "
    "namespace belongs to that namespace's application.",
    "Join keys: every detail table has cluster_name = clusters.name. Namespaced rows additionally "
    "join on namespace = namespaces.name WITH the same cluster_name - a namespace name is only "
    "unique inside a cluster, so never join on namespace alone.",
    "There are no surrogate id columns and no foreign keys; the snapshot is rebuilt from scratch "
    "after every collection sweep.",
    "clusters.overall_status is one of 'healthy', 'warning', 'critical', 'unknown'. Unhealthy means "
    "overall_status IN ('warning','critical'). health_checks holds the checks behind it.",
    "Utilization columns (cpu_usage, memory_usage) are live values from metrics.k8s.io and are NULL "
    "when clusters.metrics_available is false. Always guard with IS NOT NULL before ranking by them. "
    "CPU is in cores, memory in bytes; percentages are usage / allocatable.",
    "resources is the catch-all inventory: filter it by `key` first (one manifest key per kind), then "
    "read the kind-specific fields out of the JSON `summary` column, e.g. "
    "json_extract_string(summary, '$.package') for the OLM package of a clusterserviceversions row, "
    "or CAST(json_extract(summary, '$.max_percent') AS DOUBLE) for a resourcequotas row.",
    "Certificates are resources rows with key IN ('secrets','configmaps') and expires_at IS NOT NULL; "
    "status is 'expired' | 'expiring' | 'valid'. Certificate material itself is never collected - only "
    "subject, issuer and expiry facts inside summary.certificates.",
    "workload_images is the image blast radius input (one row per container image reference). Join it "
    "to namespaces on (cluster_name, namespace) to get the owning application and team, and to "
    "clusters for region / environment. workload_refs is the same idea for Secret / ConfigMap / PVC "
    "dependencies.",
    "cluster_operators holds OpenShift's own operators; version drift is a name with more than one "
    "distinct version across clusters. OLM-installed operators are a different thing: resources rows "
    "with key='clusterserviceversions' (package and version inside summary).",
    "health_snapshots is the only history: one row per cluster per sweep, ordered by snapshot_at. "
    "Everything else is the state as of the last sweep.",
    "Names are case-sensitive; use ILIKE '%needle%' for fuzzy matching on images, hosts and names.",
    "All timestamps are UTC and comparable with now() and INTERVAL arithmetic, e.g. "
    "expires_at <= now() + INTERVAL 30 DAY.",
    "clusters.timings holds what collecting each cluster cost per stage, and the bytes and "
    "objects pulled to pay for it, so capacity questions about the collector itself are SQL: "
    "which clusters are slowest, how the fleet's time divides between network (fetch_ms) and "
    "Python CPU (parse_ms + assemble_ms + health_ms + persist_ms), and how many bytes per "
    "sweep a region costs. parse_ms is measured inside the fetch window, so a wall-clock total "
    "is fetch_ms + assemble_ms + health_ms + persist_ms. /api/collector/timings answers the "
    "same question without SQL.",
)

# --------------------------------------------------------------------------- #
# few-shot examples
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Example:
    question: str
    sql: str


EXAMPLES: tuple[Example, ...] = (
    Example(
        "Which regions have unhealthy clusters?",
        "SELECT region,\n"
        "       count(*) AS clusters,\n"
        "       count(*) FILTER (WHERE overall_status = 'critical') AS critical,\n"
        "       count(*) FILTER (WHERE overall_status = 'warning') AS warning\n"
        "FROM clusters\n"
        "WHERE overall_status IN ('critical', 'warning')\n"
        "GROUP BY region\n"
        "ORDER BY critical DESC, warning DESC",
    ),
    Example(
        "Which clusters are still on OpenShift 4.15?",
        "SELECT name, region, environment, ocp_version, channel, overall_status\n"
        "FROM clusters\n"
        "WHERE ocp_version LIKE '4.15%'\n"
        "ORDER BY name",
    ),
    Example(
        "If nginx 1.19 is vulnerable, what is the blast radius?",
        "SELECT wi.cluster_name, c.region, c.environment, wi.namespace,\n"
        "       ns.app_name, ns.team, wi.workload_kind, wi.workload_name, wi.image\n"
        "FROM workload_images AS wi\n"
        "JOIN clusters AS c ON c.name = wi.cluster_name\n"
        "LEFT JOIN namespaces AS ns\n"
        "       ON ns.cluster_name = wi.cluster_name AND ns.name = wi.namespace\n"
        "WHERE wi.image ILIKE '%nginx:1.19%'\n"
        "ORDER BY wi.cluster_name, wi.namespace, wi.workload_name",
    ),
    Example(
        "Which certificates expire in the next 30 days?",
        "SELECT cluster_name, namespace, name, key, status, expires_at,\n"
        "       json_extract_string(summary, '$.certificates[0].subject') AS subject\n"
        "FROM resources\n"
        "WHERE key IN ('secrets', 'configmaps')\n"
        "  AND expires_at IS NOT NULL\n"
        "  AND expires_at <= now() + INTERVAL 30 DAY\n"
        "ORDER BY expires_at",
    ),
    Example(
        "Which application namespaces use the most CPU?",
        "SELECT cluster_name, name AS namespace, team, cpu_usage, cpu_requests\n"
        "FROM namespaces\n"
        "WHERE ns_class = 'application' AND cpu_usage IS NOT NULL\n"
        "ORDER BY cpu_usage DESC\n"
        "LIMIT 10",
    ),
    Example(
        "Which cluster operators are drifting between versions?",
        "SELECT name AS operator,\n"
        "       count(DISTINCT version) AS versions,\n"
        "       string_agg(DISTINCT version, ', ' ORDER BY version) AS version_list,\n"
        "       count(*) AS clusters\n"
        "FROM cluster_operators\n"
        "WHERE version IS NOT NULL\n"
        "GROUP BY name\n"
        "HAVING count(DISTINCT version) > 1\n"
        "ORDER BY versions DESC, operator",
    ),
    Example(
        "Which resource quotas are over 90 percent used?",
        "SELECT r.cluster_name, r.namespace, r.name,\n"
        "       CAST(json_extract(r.summary, '$.max_percent') AS DOUBLE) AS max_percent,\n"
        "       r.status\n"
        "FROM resources AS r\n"
        "WHERE r.key = 'resourcequotas'\n"
        "  AND CAST(json_extract(r.summary, '$.max_percent') AS DOUBLE) >= 90\n"
        "ORDER BY max_percent DESC",
    ),
    Example(
        "How many applications does each team run in production?",
        "SELECT ns.team,\n"
        "       count(DISTINCT ns.app_name) AS applications,\n"
        "       count(*) AS namespaces,\n"
        "       count(DISTINCT ns.cluster_name) AS clusters\n"
        "FROM namespaces AS ns\n"
        "JOIN clusters AS c ON c.name = ns.cluster_name\n"
        "WHERE ns.ns_class = 'application' AND c.environment = 'prod'\n"
        "GROUP BY ns.team\n"
        "ORDER BY applications DESC",
    ),
)

# --------------------------------------------------------------------------- #
# rendering
# --------------------------------------------------------------------------- #


def _enumerations() -> list[str]:
    """Value enumerations worth spelling out, read from the OCP API manifest.

    `resources.key` is the one column whose value set the model cannot guess,
    and it is manifest-driven, so it is generated rather than hard-coded.
    """
    try:
        from ..manifest import get_manifest
        described = get_manifest().describe()
    except Exception:  # noqa: BLE001 - the schema text must render without a manifest
        return []
    keys = [r["key"] for r in described.get("resources", []) if r.get("enabled")]
    if not keys:
        return []
    lines = [f"resources.key is one of: {', '.join(sorted(keys))}."]
    thresholds = described.get("thresholds") or {}
    if thresholds.get("certificate_expiry_days"):
        lines.append(
            f"'expiring' certificates are those inside the manifest window of "
            f"{thresholds['certificate_expiry_days']} days; 'expired' ones are already past it.")
    if thresholds.get("quota_warning_percent"):
        lines.append(
            f"A resourcequotas row has status 'warning' at or above "
            f"{thresholds['quota_warning_percent']}% of any hard limit and 'exhausted' at 100%.")
    return lines


def ddl() -> str:
    """The schema as annotated CREATE TABLE statements (what the model reads)."""
    out = []
    for t in TABLES:
        out.append(f"-- {t.doc}")
        out.append(f"CREATE TABLE {t.name} (")
        width = max(len(c.name) for c in t.columns)
        rows = []
        for index, c in enumerate(t.columns):
            # The comma belongs before the comment, or the DDL stops being DDL.
            comma = "," if index < len(t.columns) - 1 else ""
            rows.append(f"  {c.name:<{width}} {c.type:<9}{comma:<2} -- {c.doc}")
        out.append("\n".join(rows))
        out.append(");")
        out.append("")
    return "\n".join(out)


def schema_text() -> str:
    """The full semantic layer: tables, columns, notes, enumerations, examples.

    This string is the cached prefix of the system prompt, so it must be
    stable across requests - nothing time-dependent may appear in it.
    """
    parts = ["# Tables", "", ddl(), "# How to read this data", ""]
    parts += [f"- {n}" for n in NOTES]
    enums = _enumerations()
    if enums:
        parts += ["", "# Value enumerations", ""] + [f"- {e}" for e in enums]
    parts += ["", "# Worked examples", ""]
    for ex in EXAMPLES:
        parts += [f"Question: {ex.question}", "SQL:", ex.sql, ""]
    return "\n".join(parts)


def describe() -> dict:
    """The schema as the API serves it (GET /api/query/schema)."""
    return {
        "tables": [
            {
                "name": t.name,
                "description": t.doc,
                "source": t.source,
                "columns": [{"name": c.name, "type": c.type, "description": c.doc}
                            for c in t.columns],
            }
            for t in TABLES
        ],
        "notes": list(NOTES),
        "enumerations": _enumerations(),
        "examples": [{"question": e.question, "sql": e.sql} for e in EXAMPLES],
    }
