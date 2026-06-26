"""
ORM models - the persisted Operations Data Layer.

Two flavours of table:
  * current-state (Cluster, ClusterOperator, Application, HealthCheck): replaced
    on every collection sweep, so reads are a cheap point-in-time view.
  * time-series (HealthSnapshot): appended on every sweep, so we can show how a
    cluster's health and upgrade progress move over time.
"""
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Index,
)
from sqlalchemy.orm import relationship

from .db import Base


def utcnow():
    return datetime.now(timezone.utc)


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

    # ACM-reported availability
    managed_available = Column(Boolean, default=True)

    # computed health
    overall_status = Column(String, index=True)   # healthy | warning | critical | unknown
    health_score = Column(Integer, default=0)
    checks_passed = Column(Integer, default=0)
    checks_warned = Column(Integer, default=0)
    checks_failed = Column(Integer, default=0)

    last_synced = Column(DateTime(timezone=True))
    reachable = Column(Boolean, default=True)
    last_error = Column(String)

    operators = relationship("ClusterOperator", back_populates="cluster",
                             cascade="all, delete-orphan")
    applications = relationship("Application", back_populates="cluster",
                                cascade="all, delete-orphan")
    health_checks = relationship("HealthCheck", back_populates="cluster",
                                 cascade="all, delete-orphan")


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


class Application(Base):
    __tablename__ = "applications"
    id = Column(Integer, primary_key=True, autoincrement=True)
    cluster_name = Column(String, ForeignKey("clusters.name"), index=True)
    name = Column(String, index=True)
    namespace = Column(String)
    team = Column(String, index=True)
    tier = Column(String)
    replicas_desired = Column(Integer, default=0)
    replicas_ready = Column(Integer, default=0)

    cluster = relationship("Cluster", back_populates="applications")


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
    """Append-only health history powering the per-cluster timeline."""
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
