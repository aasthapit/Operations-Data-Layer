from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .db import get_session
from .models import AuditEvent, PatchJob, PatchTask, new_id, utcnow
from .schemas import ApproveBody, EventBody, JobCreate

router = APIRouter(prefix="/api", tags=["patching"])

TERMINAL_JOB = {"completed", "failed", "rejected", "cancelled"}


# --------------------------------------------------------------------------- #
# serializers
# --------------------------------------------------------------------------- #
def iso(dt):
    return dt.isoformat() if dt else None


def job_summary(j: PatchJob) -> dict:
    return {
        "id": j.id, "plan_id": j.plan_id, "change_record": j.change_record,
        "requested_by": j.requested_by, "approved_by": j.approved_by,
        "approval_status": j.approval_status, "status": j.status,
        "target_version": j.target_version, "threshold_pct": j.threshold_pct,
        "source": j.source,
        "totals": {"total": j.total, "succeeded": j.succeeded,
                   "failed": j.failed, "skipped": j.skipped,
                   "success_pct": j.success_pct},
        "created_at": iso(j.created_at), "started_at": iso(j.started_at),
        "finished_at": iso(j.finished_at),
    }


def task_dict(t: PatchTask) -> dict:
    return {
        "cluster": t.cluster, "phase": t.phase, "outcome": t.outcome,
        "version_from": t.version_from, "version_to": t.version_to,
        "precheck_status": t.precheck_status, "postcheck_status": t.postcheck_status,
        "health_before": t.health_before, "health_after": t.health_after,
        "message": t.message,
        "started_at": iso(t.started_at), "finished_at": iso(t.finished_at),
    }


def event_dict(e: AuditEvent) -> dict:
    return {"ts": iso(e.ts), "actor": e.actor, "action": e.action,
            "phase": e.phase, "cluster": e.cluster, "message": e.message,
            "data": e.data}


def job_detail(j: PatchJob) -> dict:
    d = job_summary(j)
    d["clusters"] = j.clusters or []
    d["tasks"] = [task_dict(t) for t in sorted(j.tasks, key=lambda t: t.cluster)]
    d["audit"] = [event_dict(e) for e in j.events]
    return d


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _audit(db, job, actor, action, phase=None, cluster=None, message=None, data=None):
    db.add(AuditEvent(job_id=job.id, ts=utcnow(), actor=actor, action=action,
                      phase=phase, cluster=cluster, message=message, data=data))


def _recompute(job):
    tasks = job.tasks
    job.total = len(tasks)
    job.succeeded = sum(1 for t in tasks if t.outcome == "passed")
    job.failed = sum(1 for t in tasks if t.outcome == "failed")
    job.skipped = sum(1 for t in tasks if t.outcome == "skipped")
    terminal = job.succeeded + job.failed + job.skipped
    job.success_pct = round(100 * job.succeeded / job.total) if job.total else 0
    if job.total and terminal == job.total and job.status in ("running", "approved"):
        job.status = ("completed" if job.success_pct >= (job.threshold_pct or 0)
                      else "paused")
        if not job.finished_at:
            job.finished_at = utcnow()


def _get_job(db, job_id) -> PatchJob:
    job = db.get(PatchJob, job_id)
    if not job:
        raise HTTPException(404, f"job {job_id} not found")
    return job


# --------------------------------------------------------------------------- #
# routes
# --------------------------------------------------------------------------- #
@router.post("/jobs")
def create_job(body: JobCreate, db: Session = Depends(get_session)):
    job = PatchJob(
        plan_id=body.plan_id or new_id("plan"),
        change_record=body.change_record, requested_by=body.requested_by,
        target_version=body.target_version, threshold_pct=body.threshold_pct,
        clusters=body.clusters, source=body.source, status="submitted",
        approval_status="pending",
    )
    db.add(job)
    db.flush()   # assign job.id before creating child rows that reference it
    for c in body.clusters:
        db.add(PatchTask(job_id=job.id, cluster=c, phase="queued", outcome="pending"))
    db.flush()
    _audit(db, job, body.requested_by, "job.submitted",
           message=f"requested patch to {body.target_version} on {len(body.clusters)} cluster(s)",
           data={"change_record": body.change_record, "clusters": body.clusters})
    _recompute(job)
    db.commit()
    return job_summary(job)


@router.get("/jobs")
def list_jobs(status: str = None, requested_by: str = None,
              limit: int = 50, db: Session = Depends(get_session)):
    q = db.query(PatchJob)
    if status:
        q = q.filter(PatchJob.status == status)
    if requested_by:
        q = q.filter(PatchJob.requested_by == requested_by)
    jobs = q.order_by(PatchJob.created_at.desc()).limit(limit).all()
    return {"count": len(jobs), "jobs": [job_summary(j) for j in jobs]}


@router.get("/jobs/{job_id}")
def get_job(job_id: str, db: Session = Depends(get_session)):
    return job_detail(_get_job(db, job_id))


@router.get("/jobs/{job_id}/audit")
def get_audit(job_id: str, db: Session = Depends(get_session)):
    job = _get_job(db, job_id)
    return {"job_id": job.id, "audit": [event_dict(e) for e in job.events]}


@router.post("/jobs/{job_id}/approve")
def approve(job_id: str, body: ApproveBody, db: Session = Depends(get_session)):
    job = _get_job(db, job_id)
    if body.decision == "approve":
        job.approval_status = "approved"
        job.approved_by = body.approver
        if job.status == "submitted":
            job.status = "approved"
        _audit(db, job, body.approver, "job.approved", message=body.note)
    else:
        job.approval_status = "rejected"
        job.status = "rejected"
        _audit(db, job, body.approver, "job.rejected", message=body.note)
    db.commit()
    return job_summary(job)


@router.post("/jobs/{job_id}/events")
def post_event(job_id: str, body: EventBody, db: Session = Depends(get_session)):
    job = _get_job(db, job_id)

    data = dict(body.data or {})
    for k in ("version_from", "version_to", "health_before", "health_after", "outcome"):
        v = getattr(body, k)
        if v is not None:
            data[k] = v
    _audit(db, job, body.actor, body.action, phase=body.phase,
           cluster=body.cluster, message=body.message, data=data or None)

    # update the per-cluster task
    if body.cluster:
        task = (db.query(PatchTask)
                .filter_by(job_id=job.id, cluster=body.cluster).first())
        if task is None:
            task = PatchTask(job_id=job.id, cluster=body.cluster)
            db.add(task)
        if task.started_at is None:
            task.started_at = utcnow()
        if body.phase:
            task.phase = body.phase
        if body.outcome:
            task.outcome = body.outcome
        if body.version_from:
            task.version_from = body.version_from
        if body.version_to:
            task.version_to = body.version_to
        if body.health_before is not None:
            task.health_before = body.health_before
        if body.health_after is not None:
            task.health_after = body.health_after
        if body.phase == "precheck":
            task.precheck_status = body.outcome
        if body.phase == "postcheck":
            task.postcheck_status = body.outcome
        if body.message:
            task.message = body.message
        if body.outcome in ("passed", "skipped", "failed") or body.phase == "done":
            task.finished_at = utcnow()

    # explicit job status moves
    if body.job_status:
        job.status = body.job_status
        if body.job_status == "running" and not job.started_at:
            job.started_at = utcnow()
        if body.job_status in TERMINAL_JOB and not job.finished_at:
            job.finished_at = utcnow()

    db.flush()
    _recompute(job)
    db.commit()
    return job_summary(job)


@router.get("/report")
def report(db: Session = Depends(get_session)):
    jobs = db.query(PatchJob).all()
    by_status = {}
    clusters_done = clusters_failed = clusters_pending = 0
    for j in jobs:
        by_status[j.status] = by_status.get(j.status, 0) + 1
        clusters_done += j.succeeded
        clusters_failed += j.failed
        clusters_pending += max(0, j.total - j.succeeded - j.failed - j.skipped)
    completed = [j for j in jobs if j.status in ("completed", "failed", "paused")]
    avg_success = (round(sum(j.success_pct for j in completed) / len(completed))
                   if completed else None)
    recent = sorted(jobs, key=lambda j: j.created_at or utcnow(), reverse=True)[:10]
    return {
        "jobs_total": len(jobs),
        "jobs_by_status": by_status,
        "clusters": {"succeeded": clusters_done, "failed": clusters_failed,
                     "pending": clusters_pending},
        "avg_success_pct": avg_success,
        "recent_jobs": [job_summary(j) for j in recent],
    }
