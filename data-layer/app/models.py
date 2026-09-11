"""
ORM models - the persisted Operations Data Layer.

Two flavours of table:
  * current-state (Cluster and its children: operators, nodes, namespaces,
    workloads, pod issues, generic resources, resource status, health checks):
    replaced on every collection sweep, so reads are a cheap point-in-time view.
  * time-series (HealthSnapshot): appended on every sweep with health *and*
    utilization, so we can show how a cluster moves over time.

Applications are namespaces: every namespace that is not an OpenShift /
Kubernetes platform namespace (see the manifest) is an application namespace,
and its ownership (app / team / tier) comes from labels. Platform namespaces are
kept too, grouped separately.

Everything in `resources` is a scrubbed summary - ConfigMap / Secret values,
certificate material and env values never reach this schema (see
collector/scrub.py).
"""
from datetime import UTC, datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
)
from sqlalchemy.orm import relationship

from .db import Base


def utcnow():
    return datetime.now(UTC)


class Hub(Base):
    __tablename__ = "hubs"
    name = Column(String, primary_key=True)
    region = Column(String)
    datacenter = Column(String)
    managed_count = Column(Integer, default=0)
    reachable = Column(Boolean, default=True)
    last_synced = Column(DateTime(timezone=True))
    last_error = Column(String)


class Cluster(Base):
    __tablename__ = "clusters"
    name = Column(String, primary_key=True)
    hub_name = Column(String, ForeignKey("hubs.name"), index=True)
    display_name = Column(String)

    # placement / identity (sourced from the ACM ManagedCluster labels+claims)
    region = Column(String, index=True)
    datacenter = Column(String, index=True)
    environment = Column(String, index=True)
    cloud = Column(String)
    vendor = Column(String)
    platform = Column(String)
    cluster_id = Column(String)
    infrastructure_name = Column(String)

    # platform configuration (Infrastructure / Network / Ingress config)
    api_url = Column(String)
    control_plane_topology = Column(String)
    infrastructure_topology = Column(String)
    network_type = Column(String)
    cluster_network = Column(JSON)          # list[str] CIDRs
    service_network = Column(JSON)          # list[str] CIDRs
    apps_domain = Column(String)

    # version / upgrade state (from ClusterVersion)
    ocp_version = Column(String, index=True)
    desired_version = Column(String)
    channel = Column(String)
    upgrading = Column(Boolean, default=False)
    upgrade_percent = Column(Integer)
    available_updates = Column(JSON)        # list[str]
    kube_version = Column(String)

    # nodes (live, from the managed cluster)
    nodes_total = Column(Integer, default=0)
    nodes_ready = Column(Integer, default=0)

    # capacity + live utilization (nodes + metrics.k8s.io, summed)
    cpu_capacity = Column(Float)            # cores
    cpu_allocatable = Column(Float)
    cpu_requests = Column(Float)
    cpu_limits = Column(Float)
    cpu_usage = Column(Float)
    memory_capacity = Column(BigInteger)    # bytes
    memory_allocatable = Column(BigInteger)
    memory_requests = Column(BigInteger)
    memory_limits = Column(BigInteger)
    memory_usage = Column(BigInteger)
    pods_capacity = Column(Integer)
    pods_total = Column(Integer, default=0)
    pods_running = Column(Integer, default=0)
    metrics_available = Column(Boolean, default=False)

    # inventory rollups
    namespaces_application = Column(Integer, default=0)
    namespaces_platform = Column(Integer, default=0)
    workloads_total = Column(Integer, default=0)
    pod_issues_total = Column(Integer, default=0)
    certs_expiring_total = Column(Integer, default=0)   # within the manifest window (incl. expired)

    # ACM-reported availability
    managed_available = Column(Boolean, default=True)

    # computed health
    overall_status = Column(String, index=True)   # healthy | warning | critical | unknown
    health_score = Column(Integer, default=0)
    checks_passed = Column(Integer, default=0)
    checks_warned = Column(Integer, default=0)
    checks_failed = Column(Integer, default=0)

    last_synced = Column(DateTime(timezone=True))
    collect_ms = Column(Integer)
    reachable = Column(Boolean, default=True)
    last_error = Column(String)

    operators = relationship("ClusterOperator", back_populates="cluster",
                             cascade="all, delete-orphan")
    nodes = relationship("Node", back_populates="cluster", cascade="all, delete-orphan")
    namespaces = relationship("Namespace", back_populates="cluster",
                              cascade="all, delete-orphan")
    workloads = relationship("Workload", back_populates="cluster",
                             cascade="all, delete-orphan")
    pod_issues = relationship("PodIssue", back_populates="cluster",
                              cascade="all, delete-orphan")
    resources = relationship("Resource", back_populates="cluster",
                             cascade="all, delete-orphan")
    resource_status = relationship("ResourceStatus", back_populates="cluster",
                                   cascade="all, delete-orphan")
    health_checks = relationship("HealthCheck", back_populates="cluster",
                                 cascade="all, delete-orphan")

    @property
    def applications(self):
        return [n for n in self.namespaces if n.ns_class == "application"]


class ClusterOperator(Base):
    __tablename__ = "cluster_operators"
    id = Column(Integer, primary_key=True, autoincrement=True)
    cluster_name = Column(String, ForeignKey("clusters.name"), index=True)
    name = Column(String, index=True)
    version = Column(String, index=True)
    available = Column(Boolean, default=True)
    progressing = Column(Boolean, default=False)
    degraded = Column(Boolean, default=False)
    critical = Column(Boolean, default=False)
    message = Column(String)

    cluster = relationship("Cluster", back_populates="operators")


Index("ix_operator_name_version", ClusterOperator.name, ClusterOperator.version)


class Node(Base):
    __tablename__ = "nodes"
    id = Column(Integer, primary_key=True, autoincrement=True)
    cluster_name = Column(String, ForeignKey("clusters.name"), index=True)
    name = Column(String, index=True)
    roles = Column(JSON)                    # list[str]
    ready = Column(Boolean, default=False)
    schedulable = Column(Boolean, default=True)
    conditions = Column(JSON)               # {MemoryPressure: bool, DiskPressure: bool, ...}
    kubelet_version = Column(String)
    os_image = Column(String)
    kernel_version = Column(String)
    container_runtime = Column(String)
    architecture = Column(String)
    instance_type = Column(String)
    zone = Column(String)
    internal_ip = Column(String)
    cpu_capacity = Column(Float)
    cpu_allocatable = Column(Float)
    cpu_usage = Column(Float)
    memory_capacity = Column(BigInteger)
    memory_allocatable = Column(BigInteger)
    memory_usage = Column(BigInteger)
    ephemeral_storage_allocatable = Column(BigInteger)
    pods_capacity = Column(Integer)
    pods_running = Column(Integer, default=0)
    images_count = Column(Integer, default=0)
    images_bytes = Column(BigInteger, default=0)
    taints = Column(JSON)                   # list[{key, effect}]
    created_at = Column(DateTime(timezone=True))

    cluster = relationship("Cluster", back_populates="nodes")


class Namespace(Base):
    """A namespace on a cluster. Application namespaces *are* the applications."""
    __tablename__ = "namespaces"
    id = Column(Integer, primary_key=True, autoincrement=True)
    cluster_name = Column(String, ForeignKey("clusters.name"), index=True)
    name = Column(String, index=True)
    ns_class = Column(String, index=True)   # application | platform
    app_name = Column(String, index=True)   # application identity (label or namespace name)
    team = Column(String, index=True)
    tier = Column(String)
    labels = Column(JSON)
    annotations = Column(JSON)              # allow-listed only
    requester = Column(String)
    display_name = Column(String)
    phase = Column(String)
    status = Column(String, index=True)     # healthy | warning | critical | unknown

    workloads_total = Column(Integer, default=0)
    replicas_desired = Column(Integer, default=0)
    replicas_ready = Column(Integer, default=0)
    pods_total = Column(Integer, default=0)
    pods_running = Column(Integer, default=0)
    pods_pending = Column(Integer, default=0)
    pods_failed = Column(Integer, default=0)
    pods_succeeded = Column(Integer, default=0)
    restarts_total = Column(Integer, default=0)
    pod_issues = Column(Integer, default=0)

    cpu_requests = Column(Float)
    cpu_limits = Column(Float)
    cpu_usage = Column(Float)
    memory_requests = Column(BigInteger)
    memory_limits = Column(BigInteger)
    memory_usage = Column(BigInteger)

    resource_counts = Column(JSON)          # {configmaps: n, secrets: n, routes: n, ...}
    images = Column(JSON)                   # unique images running in the namespace
    created_at = Column(DateTime(timezone=True))

    cluster = relationship("Cluster", back_populates="namespaces")


Index("ix_namespace_cluster_name", Namespace.cluster_name, Namespace.name)


class Workload(Base):
    """Deployment / StatefulSet / DaemonSet, with scrubbed container detail."""
    __tablename__ = "workloads"
    id = Column(Integer, primary_key=True, autoincrement=True)
    cluster_name = Column(String, ForeignKey("clusters.name"), index=True)
    namespace = Column(String, index=True)
    ns_class = Column(String)
    kind = Column(String)
    name = Column(String, index=True)
    replicas_desired = Column(Integer, default=0)
    replicas_ready = Column(Integer, default=0)
    replicas_available = Column(Integer, default=0)
    replicas_updated = Column(Integer, default=0)
    status = Column(String)                 # healthy | progressing | degraded
    containers = Column(JSON)               # [{name, image, env(names+refs), env_from, requests, limits}]
    images = Column(JSON)                   # list[str]
    config_refs = Column(JSON)              # [{kind, name, via}]
    service_account = Column(String)
    node_selector = Column(JSON)
    strategy = Column(String)
    labels = Column(JSON)
    conditions = Column(JSON)
    created_at = Column(DateTime(timezone=True))

    cluster = relationship("Cluster", back_populates="workloads")


class WorkloadImage(Base):
    """Normalised image usage: which workload runs which image."""
    __tablename__ = "workload_images"
    id = Column(Integer, primary_key=True, autoincrement=True)
    cluster_name = Column(String, ForeignKey("clusters.name"), index=True)
    namespace = Column(String)
    workload_kind = Column(String)
    workload_name = Column(String)
    container = Column(String)
    image = Column(String, index=True)
    registry = Column(String, index=True)
    repository = Column(String, index=True)
    tag = Column(String)
    digest = Column(String)


class WorkloadRef(Base):
    """Normalised configuration references: workload -> Secret / ConfigMap / PVC."""
    __tablename__ = "workload_refs"
    id = Column(Integer, primary_key=True, autoincrement=True)
    cluster_name = Column(String, ForeignKey("clusters.name"), index=True)
    namespace = Column(String, index=True)
    workload_kind = Column(String)
    workload_name = Column(String)
    ref_kind = Column(String, index=True)   # Secret | ConfigMap | PersistentVolumeClaim | ServiceAccount
    ref_name = Column(String, index=True)
    via = Column(String)                    # env | envFrom | volume | imagePullSecret | serviceAccount


class PodIssue(Base):
    """A pod that is currently not healthy (crashloop, pull failure, pending...)."""
    __tablename__ = "pod_issues"
    id = Column(Integer, primary_key=True, autoincrement=True)
    cluster_name = Column(String, ForeignKey("clusters.name"), index=True)
    namespace = Column(String, index=True)
    ns_class = Column(String, index=True)
    name = Column(String)
    node = Column(String)
    phase = Column(String)
    reason = Column(String, index=True)
    message = Column(String)
    restarts = Column(Integer, default=0)
    owner_kind = Column(String)
    owner_name = Column(String)
    containers_ready = Column(String)       # "1/2"
    started_at = Column(DateTime(timezone=True))

    cluster = relationship("Cluster", back_populates="pod_issues")


class Resource(Base):
    """Scrubbed inventory row for every other collected kind (routes, secrets...)."""
    __tablename__ = "resources"
    id = Column(Integer, primary_key=True, autoincrement=True)
    cluster_name = Column(String, ForeignKey("clusters.name"), index=True)
    key = Column(String, index=True)        # manifest key, e.g. "secrets"
    kind = Column(String)
    api_group = Column(String)
    namespace = Column(String, index=True)  # null for cluster-scoped
    ns_class = Column(String)
    name = Column(String, index=True)
    status = Column(String, index=True)     # kind-specific: bound | pending | expired | degraded ...
    expires_at = Column(DateTime(timezone=True), index=True)   # certificate-bearing resources
    labels = Column(JSON)
    summary = Column(JSON)                  # the scrubbed, normalised detail
    created_at = Column(DateTime(timezone=True))

    cluster = relationship("Cluster", back_populates="resources")


Index("ix_resource_cluster_key", Resource.cluster_name, Resource.key)
Index("ix_resource_key_name", Resource.key, Resource.name)


class ResourceStatus(Base):
    """Per cluster, per manifest key: was it collected, unavailable, forbidden?"""
    __tablename__ = "resource_status"
    id = Column(Integer, primary_key=True, autoincrement=True)
    cluster_name = Column(String, ForeignKey("clusters.name"), index=True)
    key = Column(String, index=True)
    status = Column(String)                 # collected | unavailable | forbidden | error | disabled
    count = Column(Integer, default=0)
    duration_ms = Column(Integer)
    error = Column(String)

    cluster = relationship("Cluster", back_populates="resource_status")


class HealthCheck(Base):
    """Current result of one precondition check for one cluster."""
    __tablename__ = "health_checks"
    id = Column(Integer, primary_key=True, autoincrement=True)
    cluster_name = Column(String, ForeignKey("clusters.name"), index=True)
    name = Column(String)
    title = Column(String)
    status = Column(String)       # pass | warn | fail
    severity = Column(String)     # critical | warning | info
    message = Column(String)

    cluster = relationship("Cluster", back_populates="health_checks")


class HealthSnapshot(Base):
    """Append-only per-sweep history: health and utilization."""
    __tablename__ = "health_snapshots"
    id = Column(Integer, primary_key=True, autoincrement=True)
    cluster_name = Column(String, index=True)
    overall_status = Column(String)
    health_score = Column(Integer)
    checks_passed = Column(Integer)
    checks_warned = Column(Integer)
    checks_failed = Column(Integer)
    ocp_version = Column(String)
    upgrading = Column(Boolean)
    cpu_usage = Column(Float)
    cpu_allocatable = Column(Float)
    memory_usage = Column(BigInteger)
    memory_allocatable = Column(BigInteger)
    pods_running = Column(Integer)
    pod_issues = Column(Integer)
    snapshot_at = Column(DateTime(timezone=True), default=utcnow, index=True)


class CollectionRun(Base):
    """One full sweep of the fleet - for observability of the data layer itself."""
    __tablename__ = "collection_runs"
    id = Column(Integer, primary_key=True, autoincrement=True)
    started_at = Column(DateTime(timezone=True), default=utcnow)
    finished_at = Column(DateTime(timezone=True))
    duration_ms = Column(Integer)
    hubs_total = Column(Integer, default=0)
    clusters_total = Column(Integer, default=0)
    clusters_ok = Column(Integer, default=0)
    clusters_failed = Column(Integer, default=0)
    trigger = Column(String)      # startup | scheduled | manual
    error = Column(String)


# Children replaced wholesale on every sweep, in dependency-free order.
CHILD_TABLES = (ClusterOperator, Node, Namespace, Workload, WorkloadImage, WorkloadRef,
                PodIssue, Resource, ResourceStatus, HealthCheck)
