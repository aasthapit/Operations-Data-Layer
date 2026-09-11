"""
Registry of every OpenShift / Kubernetes API resource the collector knows how
to read.

The manifest (config/ocp-api-manifest.yaml) decides *which* of these are
enabled; this module decides *how* each one is fetched and what RBAC it needs.
A resource that is not in this registry cannot be collected, full stop - which
is what makes the manifest a complete statement of the data layer's reach.

Adding a resource = one ResourceSpec here + one parser in parsers.py + one
manifest entry.
"""
from dataclasses import dataclass, field


@dataclass(frozen=True)
class ResourceSpec:
    key: str                       # manifest key
    group: str                     # "" for the core API
    version: str
    plural: str
    kind: str
    scope: str                     # cluster | namespaced
    description: str
    name: str | None = None        # fixed singleton name (get instead of list)
    field_selector: str | None = None
    domain: str = "platform"       # grouping for the manifest view
    # typed (its own table) | generic (resources table) | cluster (columns on Cluster)
    store: str = "generic"
    verbs: tuple = ("get", "list")
    options: tuple = field(default_factory=tuple)   # extra manifest options this key accepts

    @property
    def api_group_label(self) -> str:
        return self.group or "core"

    @property
    def base_path(self) -> str:
        return "/api/v1" if self.group == "" else f"/apis/{self.group}/{self.version}"


_SPECS = [
    # ---- cluster-scoped platform state ------------------------------------
    ResourceSpec("clusterversion", "config.openshift.io", "v1", "clusterversions", "ClusterVersion",
                 "cluster", "Current / desired OCP version, upgrade progress, available updates.",
                 name="version", store="cluster"),
    ResourceSpec("clusteroperators", "config.openshift.io", "v1", "clusteroperators", "ClusterOperator",
                 "cluster", "Every cluster operator: version, Available / Progressing / Degraded.",
                 store="typed"),
    ResourceSpec("infrastructure", "config.openshift.io", "v1", "infrastructures", "Infrastructure",
                 "cluster", "Platform, region, API URL, control-plane and infrastructure topology.",
                 name="cluster", store="cluster"),
    ResourceSpec("network_config", "config.openshift.io", "v1", "networks", "Network",
                 "cluster", "Network plugin (OVN / SDN), cluster and service CIDRs.",
                 name="cluster", store="cluster"),
    ResourceSpec("ingress_config", "config.openshift.io", "v1", "ingresses", "Ingress",
                 "cluster", "The cluster's application (apps.) domain.",
                 name="cluster", store="cluster"),
    ResourceSpec("nodes", "", "v1", "nodes", "Node",
                 "cluster", "Node roles, readiness, pressure conditions, capacity / allocatable, "
                 "kubelet + OS versions, cached images.",
                 store="typed"),
    ResourceSpec("node_metrics", "metrics.k8s.io", "v1beta1", "nodes", "NodeMetrics",
                 "cluster", "Live CPU / memory usage per node (Kubernetes metrics API).",
                 domain="metrics", store="typed"),
    ResourceSpec("machineconfigpools", "machineconfiguration.openshift.io", "v1", "machineconfigpools",
                 "MachineConfigPool", "cluster",
                 "Machine config rollout state per pool: updated / updating / degraded machine counts."),
    ResourceSpec("clusterrolebindings", "rbac.authorization.k8s.io", "v1", "clusterrolebindings",
                 "ClusterRoleBinding", "cluster",
                 "Who holds cluster-admin (subjects of bindings to the configured roles).",
                 domain="security"),
    ResourceSpec("storageclasses", "storage.k8s.io", "v1", "storageclasses", "StorageClass",
                 "cluster", "Storage classes, provisioners, default class.", domain="storage"),
    ResourceSpec("persistentvolumes", "", "v1", "persistentvolumes", "PersistentVolume",
                 "cluster", "Persistent volumes: capacity, phase, CSI driver, bound claim.",
                 domain="storage"),

    # ---- namespaced --------------------------------------------------------
    ResourceSpec("namespaces", "", "v1", "namespaces", "Namespace",
                 "cluster", "All namespaces, classified as application or platform.",
                 domain="workloads", store="typed"),
    ResourceSpec("pods", "", "v1", "pods", "Pod",
                 "namespaced", "Pod phase, restarts, waiting reasons, requests / limits, images, node. "
                 "Rolled up per namespace; only problem pods are stored individually.",
                 domain="workloads", store="typed", options=("namespace_class",)),
    ResourceSpec("pod_metrics", "metrics.k8s.io", "v1beta1", "pods", "PodMetrics",
                 "namespaced", "Live CPU / memory usage per pod, rolled up per namespace.",
                 domain="metrics", store="typed", options=("namespace_class",)),
    ResourceSpec("deployments", "apps", "v1", "deployments", "Deployment",
                 "namespaced", "Deployments: replicas, images, env var names + references, "
                 "requests / limits, conditions.", domain="workloads", store="typed",
                 options=("namespace_class",)),
    ResourceSpec("statefulsets", "apps", "v1", "statefulsets", "StatefulSet",
                 "namespaced", "StatefulSets (same shape as deployments).",
                 domain="workloads", store="typed", options=("namespace_class",)),
    ResourceSpec("daemonsets", "apps", "v1", "daemonsets", "DaemonSet",
                 "namespaced", "DaemonSets (same shape as deployments).",
                 domain="workloads", store="typed", options=("namespace_class",)),
    ResourceSpec("cronjobs", "batch", "v1", "cronjobs", "CronJob",
                 "namespaced", "CronJobs: schedule, suspended, last run, images.",
                 domain="workloads", options=("namespace_class",)),
    ResourceSpec("horizontalpodautoscalers", "autoscaling", "v2", "horizontalpodautoscalers",
                 "HorizontalPodAutoscaler", "namespaced",
                 "Autoscalers: target, min / max / current replicas, scaling conditions.",
                 domain="workloads", options=("namespace_class",)),
    ResourceSpec("services", "", "v1", "services", "Service",
                 "namespaced", "Services: type, cluster IP, ports, selector, load-balancer endpoints.",
                 domain="networking", options=("namespace_class",)),
    ResourceSpec("routes", "route.openshift.io", "v1", "routes", "Route",
                 "namespaced", "Routes: host, target service, TLS termination, admitted status.",
                 domain="networking", options=("namespace_class",)),
    ResourceSpec("ingresses", "networking.k8s.io", "v1", "ingresses", "Ingress",
                 "namespaced", "Kubernetes Ingresses: hosts, class, TLS.",
                 domain="networking", options=("namespace_class",)),
    ResourceSpec("networkpolicies", "networking.k8s.io", "v1", "networkpolicies", "NetworkPolicy",
                 "namespaced", "Network policies: selector, policy types, rule counts.",
                 domain="networking", options=("namespace_class",)),
    ResourceSpec("configmaps", "", "v1", "configmaps", "ConfigMap",
                 "namespaced", "ConfigMap names, key names and sizes, certificate facts. "
                 "Values are never collected.", domain="config", options=("namespace_class",)),
    ResourceSpec("secrets", "", "v1", "secrets", "Secret",
                 "namespaced", "Secret names, types, key names and sizes, certificate facts "
                 "(subject / issuer / expiry). Values are never collected.",
                 domain="config", options=("namespace_class",)),
    ResourceSpec("persistentvolumeclaims", "", "v1", "persistentvolumeclaims", "PersistentVolumeClaim",
                 "namespaced", "Claims: storage class, phase, requested / actual capacity, mounting pods.",
                 domain="storage", options=("namespace_class",)),
    ResourceSpec("resourcequotas", "", "v1", "resourcequotas", "ResourceQuota",
                 "namespaced", "Quota hard vs used per resource, with the worst percentage.",
                 domain="workloads", options=("namespace_class",)),
    ResourceSpec("events", "", "v1", "events", "Event",
                 "namespaced", "Most recent Warning events (what is going wrong right now).",
                 field_selector="type=Warning", domain="events",
                 options=("namespace_class", "limit")),
    ResourceSpec("clusterserviceversions", "operators.coreos.com", "v1alpha1", "clusterserviceversions",
                 "ClusterServiceVersion", "namespaced",
                 "OLM-installed operators: package, version, install phase.",
                 domain="operators", options=("namespace_class",)),
    ResourceSpec("subscriptions", "operators.coreos.com", "v1alpha1", "subscriptions", "Subscription",
                 "namespaced", "OLM subscriptions: channel, installed vs current CSV, pending upgrades.",
                 domain="operators", options=("namespace_class",)),
]

REGISTRY: dict[str, ResourceSpec] = {s.key: s for s in _SPECS}

# What is scrubbed, always. Surfaced by GET /api/manifest so consumers can see
# the policy; it is enforced in scrub.py and is not configurable.
SCRUB_POLICY = [
    {"what": "ConfigMap values", "kept": "key names, byte sizes, certificate facts for PEM keys"},
    {"what": "Secret values", "kept": "type, key names, byte sizes, certificate facts for PEM keys"},
    {"what": "Certificates",
     "kept": "subject, issuer, not-before, not-after, SAN count; the PEM is discarded"},
    {"what": "Container env values",
     "kept": "env var names, and configMapKeyRef / secretKeyRef / fieldRef sources"},
    {"what": "Annotations", "kept": "only the keys listed under keep_annotations in the manifest"},
    {"what": "Container command / args", "kept": "nothing - not collected"},
]


def rbac_rules(keys) -> list[dict]:
    """Aggregate the enabled specs into ClusterRole rules (one per API group)."""
    groups: dict[str, set] = {}
    for key in keys:
        spec = REGISTRY[key]
        groups.setdefault(spec.group, set()).add(spec.plural)
    rules = []
    for group in sorted(groups, key=lambda g: (g != "", g)):
        rules.append({
            "apiGroups": [group],
            "resources": sorted(groups[group]),
            "verbs": ["get", "list"],
        })
    return rules
