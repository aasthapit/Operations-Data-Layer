// One response per Insights section, in the envelopes the FastAPI routers use.
// Each carries at least one row that is not healthy, because the interesting
// column in every one of these tables is the status column.

export const APPLICATIONS = {
  count: 3,
  source: "labels",
  teams: ["payments", "retail"],
  applications: [
    {
      app: "checkout",
      team: "payments",
      tier: "critical",
      assigned: true,
      status: "warning",
      cluster_count: 2,
      clusters: ["ocp-prod-iad-02", "ocp-stage-iad-01"],
      hubs: ["hub-east"],
      environments: ["prod", "stage"],
      namespace_environments: ["prod", "stage"],
      workloads: 9,
      replicas_desired: 22,
      replicas_ready: 19,
      pod_issues: 3,
      cpu_used_cores: 6.02,
      memory_used_bytes: 12884901888,
    },
    {
      app: "catalog",
      team: "retail",
      tier: "standard",
      assigned: true,
      status: "healthy",
      cluster_count: 1,
      clusters: ["ocp-prod-iad-01"],
      hubs: ["hub-east"],
      environments: ["prod"],
      namespace_environments: ["prod"],
      workloads: 4,
      replicas_desired: 8,
      replicas_ready: 8,
      pod_issues: 0,
      cpu_used_cores: 1.44,
      memory_used_bytes: 3221225472,
    },
    {
      app: "(unassigned)",
      team: null,
      tier: null,
      assigned: false,
      status: "healthy",
      cluster_count: 4,
      clusters: ["ocp-prod-iad-01", "ocp-prod-sjc-01"],
      hubs: ["hub-east", "hub-west"],
      environments: [],
      namespace_environments: [],
      workloads: 3,
      replicas_desired: 3,
      replicas_ready: 3,
      pod_issues: 0,
      cpu_used_cores: null,
      memory_used_bytes: null,
    },
  ],
};

export const APPLICATION_DETAIL = {
  app: "checkout",
  team: "payments",
  tier: "critical",
  assigned: true,
  status: "warning",
  cluster_count: 2,
  namespace_environments: ["prod", "stage"],
  placements: [
    {
      cluster: "ocp-prod-iad-02", hub: "hub-east", environment: "prod", ocp_version: "4.16.7",
      cluster_status: "warning", namespace: "checkout-prod", namespace_environment: "prod",
      status: "warning", workloads: 6, replicas_desired: 14, replicas_ready: 12, pod_issues: 3,
      cpu_used_cores: 6.02, memory_used_bytes: 12884901888,
    },
    {
      cluster: "ocp-stage-iad-01", hub: "hub-east", environment: "stage", ocp_version: "4.15.22",
      cluster_status: "critical", namespace: "checkout-stage", namespace_environment: "stage",
      status: "healthy", workloads: 3, replicas_desired: 8, replicas_ready: 7, pod_issues: 0,
      cpu_used_cores: 1.1, memory_used_bytes: 2147483648,
    },
  ],
  workloads_detail: [
    {
      cluster: "ocp-prod-iad-02", namespace: "checkout-prod", kind: "Deployment",
      name: "checkout-api", status: "degraded",
      replicas: { desired: 6, ready: 4, available: 4, updated: 6 },
      images: ["quay.io/acme/checkout:1.9.2"],
      containers: [{
        name: "api",
        env: [
          { name: "LOG_LEVEL", from: { kind: "literal" } },
          { name: "DB_PASSWORD", from: { kind: "Secret", name: "checkout-db", key: "password" } },
        ],
      }],
      config_refs: [{ kind: "Secret", name: "checkout-db", via: "env" }],
    },
  ],
};

export const CERTIFICATES = {
  count: 2,
  within_days: 30,
  certificates: [
    {
      cluster: "ocp-prod-iad-02", namespace: "checkout-prod", class: "application",
      kind: "Secret", secret_type: "kubernetes.io/tls", name: "checkout-tls",
      environment: "prod", status: "expiring", days_left: 12,
      expires_at: "2026-10-02T00:00:00+00:00",
      certificates: [{ subject: "CN=checkout.acme.example", issuer: "CN=Acme Internal CA" }],
    },
    {
      cluster: "ocp-stage-iad-01", namespace: "openshift-ingress", class: "platform",
      kind: "Secret", secret_type: "kubernetes.io/tls", name: "router-certs-default",
      environment: "stage", status: "expired", days_left: -4,
      expires_at: "2026-09-16T00:00:00+00:00",
      certificates: [{ subject: "CN=*.apps.ocp-stage-iad-01.acme.example",
        issuer: "CN=Acme Internal CA" }],
    },
  ],
};

export const POD_ISSUES = {
  count: 2,
  by_reason: { CrashLoopBackOff: 1, Unschedulable: 1 },
  pod_issues: [
    { cluster: "ocp-prod-iad-02", namespace: "checkout-prod", class: "application",
      name: "checkout-api-7d9f8b6c4-2xk9p", reason: "CrashLoopBackOff", restarts: 19,
      containers_ready: "0/1", owner: "ReplicaSet/checkout-api-7d9f8b6c4",
      message: "back-off 5m0s restarting failed container=api",
      started_at: "2026-09-20T18:12:04+00:00" },
    { cluster: "ocp-stage-iad-01", namespace: "openshift-monitoring", class: "platform",
      name: "prometheus-k8s-1", reason: "Unschedulable", restarts: 0,
      containers_ready: "0/3", owner: "StatefulSet/prometheus-k8s",
      message: "0/5 nodes are available", started_at: "2026-09-20T19:40:00+00:00" },
  ],
};

export const QUOTAS = {
  count: 1,
  quotas: [
    {
      cluster: "ocp-prod-iad-02", namespace: "checkout-prod", name: "checkout-quota",
      status: "warning", max_percent: 94.0,
      resources: [
        { resource: "requests.cpu", used: "8500m", hard: "9", percent: 94 },
        { resource: "requests.memory", used: "16Gi", hard: "32Gi", percent: 50 },
      ],
    },
  ],
};

export const OLM_OPERATORS = {
  operators: [
    {
      package: "elasticsearch-operator",
      display_name: "OpenShift Elasticsearch Operator",
      provider: "Red Hat",
      clusters: 2,
      distinct: 2,
      unhealthy: 1,
      upgrades_pending: 1,
      versions: [{ version: "5.8.6", count: 1 }, { version: "5.8.4", count: 1 }],
      installs: [
        { cluster: "ocp-prod-iad-02", namespace: "openshift-operators-redhat",
          csv: "elasticsearch-operator.v5.8.6", version: "5.8.6", phase: "Succeeded",
          reason: "", unhealthy: false, upgrade_to: null },
        { cluster: "ocp-stage-iad-01", namespace: "openshift-operators-redhat",
          csv: "elasticsearch-operator.v5.8.4", version: "5.8.4", phase: "Failed",
          reason: "InstallCheckFailed", unhealthy: true, upgrade_to: "5.8.6" },
      ],
    },
  ],
};

export const MACHINE_CONFIG_POOLS = {
  count: 2,
  pools: [
    { cluster: "ocp-stage-iad-01", environment: "stage", pool: "worker", status: "degraded",
      machine_count: 3, updated: 1, ready: 1, unavailable: 2, degraded: 1,
      current_config: "rendered-worker-6b2c1a", message: "Node ip-10-4-2-44 is reporting: \"unexpected on-disk state\"" },
    { cluster: "ocp-prod-iad-02", environment: "prod", pool: "master", status: "updating",
      machine_count: 3, updated: 2, ready: 2, unavailable: 1, degraded: 0,
      current_config: "rendered-master-9f10ab", message: "" },
  ],
};

export const STORAGE = {
  storage_classes: [
    { name: "gp3-csi", provisioners: ["ebs.csi.aws.com"], clusters: ["ocp-prod-iad-02"],
      pvcs: 12, bound: 11, pending: 1, requested_bytes: 1099511627776 },
    { name: "efs-sc", provisioners: ["efs.csi.aws.com"], clusters: ["ocp-prod-iad-02",
      "ocp-stage-iad-01"], pvcs: 4, bound: 4, pending: 0, requested_bytes: 107374182400 },
  ],
  pvcs: [
    { cluster: "ocp-prod-iad-02", namespace: "checkout-prod", name: "checkout-data",
      status: "pending", storage_class: "gp3-csi", requested_bytes: 107374182400,
      capacity_bytes: null, volume: null, mounted_by: [] },
    { cluster: "ocp-prod-iad-02", namespace: "checkout-prod", name: "checkout-logs",
      status: "bound", storage_class: "gp3-csi", requested_bytes: 53687091200,
      capacity_bytes: 53687091200, volume: "pvc-3b1f", mounted_by: ["checkout-api"] },
  ],
};

export const ROUTES = {
  count: 2,
  routes: [
    { cluster: "ocp-prod-iad-02", namespace: "checkout-prod", name: "checkout",
      host: "checkout.apps.ocp-prod-iad-02.acme.example", path: "/", service: "checkout",
      port: "8080", tls_termination: "edge", insecure_policy: "Redirect",
      status: "admitted", routers: ["default"] },
    { cluster: "ocp-stage-iad-01", namespace: "checkout-stage", name: "checkout",
      host: "checkout.apps.ocp-stage-iad-01.acme.example", path: "", service: "checkout",
      port: null, tls_termination: null, insecure_policy: null,
      status: "rejected", routers: [] },
  ],
};

export const EVENTS = {
  count: 2,
  by_reason: { FailedScheduling: 1, BackOff: 1 },
  events: [
    { cluster: "ocp-stage-iad-01", namespace: "openshift-monitoring", class: "platform",
      name: "prometheus-k8s-1.17f0a", reason: "FailedScheduling", count: 18,
      source: "default-scheduler", message: "0/5 nodes are available",
      involved: { kind: "Pod", name: "prometheus-k8s-1" },
      last_at: "2026-09-20T20:50:00+00:00" },
    { cluster: "ocp-prod-iad-02", namespace: "checkout-prod", class: "application",
      name: "checkout-api.17f09", reason: "BackOff", count: 44, source: "kubelet",
      message: "Back-off restarting failed container",
      involved: { kind: "Pod", name: "checkout-api-7d9f8b6c4-2xk9p" },
      last_at: "2026-09-20T20:55:00+00:00" },
  ],
};

export const IMAGES = {
  count: 2,
  group_by: "image",
  images: [
    {
      image: "quay.io/acme/checkout:1.9.2",
      repository: "acme/checkout",
      registry: "quay.io",
      cluster_count: 2,
      workload_count: 2,
      workloads: [
        { cluster: "ocp-prod-iad-02", namespace: "checkout-prod", kind: "Deployment",
          name: "checkout-api", container: "api", image: "quay.io/acme/checkout:1.9.2" },
        { cluster: "ocp-stage-iad-01", namespace: "checkout-stage", kind: "Deployment",
          name: "checkout-api", container: "api", image: "quay.io/acme/checkout:1.9.2" },
      ],
    },
    {
      image: "registry.redhat.io/openshift4/ose-haproxy-router:v4.16",
      repository: "openshift4/ose-haproxy-router",
      registry: "registry.redhat.io",
      cluster_count: 1,
      workload_count: 1,
      workloads: [
        { cluster: "ocp-prod-iad-02", namespace: "openshift-ingress", kind: "Deployment",
          name: "router-default", container: "router",
          image: "registry.redhat.io/openshift4/ose-haproxy-router:v4.16" },
      ],
    },
  ],
};

export const REFERENCES = {
  count: 1,
  kind: "Secret",
  references: [
    {
      cluster: "ocp-prod-iad-02", namespace: "checkout-prod", name: "checkout-db",
      workloads: [
        { kind: "Deployment", name: "checkout-api", via: "env" },
        { kind: "CronJob", name: "checkout-reconcile", via: "envFrom" },
      ],
    },
  ],
};

export const CLUSTER_ADMINS = {
  count: 2,
  subjects: [
    { kind: "Group", name: "sre-oncall", namespace: null, role: "cluster-admin",
      cluster_count: 2, clusters: ["ocp-prod-iad-02", "ocp-stage-iad-01"],
      bindings: ["sre-oncall-admin"] },
    { kind: "ServiceAccount", name: "pipeline", namespace: "openshift-gitops",
      role: "cluster-admin", cluster_count: 1, clusters: ["ocp-prod-iad-02"],
      bindings: ["gitops-cluster-admin"] },
  ],
};
