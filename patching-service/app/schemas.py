from pydantic import BaseModel, field_validator


class JobCreate(BaseModel):
    requested_by: str
    change_record: str
    target_version: str
    clusters: list[str] | str
    threshold_pct: int = 90
    plan_id: str | None = None
    source: str = "api"

    @field_validator("clusters")
    @classmethod
    def split_clusters(cls, v):
        if isinstance(v, str):
            return [c.strip() for c in v.split(",") if c.strip()]
        return v


class ApproveBody(BaseModel):
    approver: str
    decision: str = "approve"          # approve | reject
    note: str | None = None


class EventBody(BaseModel):
    """A progress/audit event from the orchestrator (N8N) or a human."""
    actor: str = "n8n"
    action: str                        # e.g. task.precheck, task.postcheck, job.note
    phase: str | None = None           # precheck|suppress|execute|monitor|postcheck|done
    cluster: str | None = None
    outcome: str | None = None         # passed|skipped|failed
    version_from: str | None = None
    version_to: str | None = None
    health_before: int | None = None
    health_after: int | None = None
    message: str | None = None
    job_status: str | None = None      # explicitly move the job (running|paused|completed|failed)
    data: dict | None = None
