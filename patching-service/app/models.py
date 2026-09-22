"""
The patching system of record.

Unlike the data layer (which is overwritten every sweep), these tables are the
durable, queryable history of what was patched, by whom, with whose approval,
and exactly what happened. AuditEvent is append-only - there is deliberately no
update/delete path for it.
"""
import uuid
from datetime import UTC, datetime

from sqlalchemy import JSON, Column, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import relationship

from .db import Base


def utcnow():
    return datetime.now(UTC)


def new_id(prefix):
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class PatchJob(Base):
    """One patching job (a Plan execution) - the JOB_RUN record."""
    __tablename__ = "patch_jobs"
    id = Column(String, primary_key=True, default=lambda: new_id("job"))
    plan_id = Column(String, index=True)
    change_record = Column(String)              # ITSM change id (e.g. ServiceNow CHG...)
    requested_by = Column(String, index=True)
    approved_by = Column(String)
    approval_status = Column(String, default="pending")   # pending|approved|rejected
    status = Column(String, default="submitted", index=True)
    # submitted|approved|running|paused|completed|failed|rejected|cancelled
    target_version = Column(String)
    threshold_pct = Column(Integer, default=90)
    clusters = Column(JSON)                     # list[str]
    source = Column(String, default="api")      # form|schedule|adhoc|api

    total = Column(Integer, default=0)
    succeeded = Column(Integer, default=0)
    failed = Column(Integer, default=0)
    skipped = Column(Integer, default=0)
    success_pct = Column(Integer, default=0)

    created_at = Column(DateTime(timezone=True), default=utcnow)
    started_at = Column(DateTime(timezone=True))
    finished_at = Column(DateTime(timezone=True))

    tasks = relationship("PatchTask", back_populates="job",
                         cascade="all, delete-orphan")
    events = relationship("AuditEvent", back_populates="job",
                          cascade="all, delete-orphan",
                          order_by="AuditEvent.ts")


class PatchTask(Base):
    """Per-cluster outcome within a job - the TASK_RESULT record."""
    __tablename__ = "patch_tasks"
    id = Column(String, primary_key=True, default=lambda: new_id("task"))
    job_id = Column(String, ForeignKey("patch_jobs.id"), index=True)
    cluster = Column(String, index=True)
    phase = Column(String, default="queued")
    # queued|precheck|suppress|execute|monitor|postcheck|done
    outcome = Column(String, default="pending")   # pending|passed|skipped|failed
    version_from = Column(String)
    version_to = Column(String)
    precheck_status = Column(String)
    postcheck_status = Column(String)
    health_before = Column(Integer)
    health_after = Column(Integer)
    message = Column(Text)
    started_at = Column(DateTime(timezone=True))
    finished_at = Column(DateTime(timezone=True))

    job = relationship("PatchJob", back_populates="tasks")


class AuditEvent(Base):
    """Append-only audit trail. No update/delete API exists for this table."""
    __tablename__ = "audit_events"
    id = Column(Integer, primary_key=True, autoincrement=True)
    job_id = Column(String, ForeignKey("patch_jobs.id"), index=True)
    ts = Column(DateTime(timezone=True), default=utcnow, index=True)
    actor = Column(String)                # who/what (user, "auto", "n8n", system)
    action = Column(String)               # job.submitted, job.approved, task.precheck, ...
    phase = Column(String)
    cluster = Column(String)
    message = Column(Text)
    data = Column(JSON)                   # structured detail (versions, health, etc.)

    job = relationship("PatchJob", back_populates="events")
