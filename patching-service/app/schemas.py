from typing import Optional, Union

from pydantic import BaseModel, field_validator


class JobCreate(BaseModel):
    requested_by: str
    change_record: str
    target_version: str
    clusters: Union[list[str], str]
    threshold_pct: int = 90
    plan_id: Optional[str] = None
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
    note: Optional[str] = None


class EventBody(BaseModel):
    """A progress/audit event from the orchestrator (N8N) or a human."""
    actor: str = "n8n"
    action: str                        # e.g. task.precheck, task.postcheck, job.note
    phase: Optional[str] = None        # precheck|suppress|execute|monitor|postcheck|done
    cluster: Optional[str] = None
    outcome: Optional[str] = None      # passed|skipped|failed
    version_from: Optional[str] = None
    version_to: Optional[str] = None
    health_before: Optional[int] = None
    health_after: Optional[int] = None
    message: Optional[str] = None
    job_status: Optional[str] = None   # explicitly move the job (running|paused|completed|failed)
    data: Optional[dict] = None
