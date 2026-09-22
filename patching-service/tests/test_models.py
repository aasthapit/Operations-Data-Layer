"""
The record's own shape: identifiers, defaults and what the request bodies
accept.

These are the values a row gets when nobody supplied one, and they are what
the API's answers are built out of - so a default that quietly changed (a job
that arrives already approved, a threshold of 0, a timestamp with no zone)
would be a change to the system of record that no route test would notice.
"""
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from app.models import AuditEvent, PatchJob, PatchTask, new_id, utcnow
from app.schemas import ApproveBody, EventBody, JobCreate


# --------------------------------------------------------------------------- #
# identifiers and time
# --------------------------------------------------------------------------- #
def test_an_id_says_what_it_identifies_and_is_unique():
    first, second = new_id("job"), new_id("job")
    assert first.startswith("job_") and second.startswith("job_")
    assert first != second
    assert new_id("task").startswith("task_")


def test_times_are_recorded_in_utc_with_the_zone_on_them():
    """The estate spans regions; a naive local timestamp in the audit trail
    would be unusable the moment two of them are compared."""
    now = utcnow()
    assert now.tzinfo is not None
    assert now.utcoffset().total_seconds() == 0
    assert abs((now - datetime.now(UTC)).total_seconds()) < 5


# --------------------------------------------------------------------------- #
# what a row looks like when nobody said otherwise
# --------------------------------------------------------------------------- #
def test_a_job_starts_unapproved_and_with_nothing_done(session):
    job = PatchJob(plan_id="plan_1", requested_by="aadesh", target_version="4.16.7",
                   clusters=["ocp-east-1"])
    session.add(job)
    session.commit()

    assert job.id.startswith("job_")
    assert job.approval_status == "pending" and job.status == "submitted"
    assert job.approved_by is None
    assert job.threshold_pct == 90 and job.source == "api"
    assert (job.total, job.succeeded, job.failed, job.skipped, job.success_pct) == \
        (0, 0, 0, 0, 0)
    assert job.created_at is not None
    assert job.started_at is None and job.finished_at is None


def test_a_task_starts_queued_and_pending(session):
    job = PatchJob(plan_id="plan_1", clusters=[])
    task = PatchTask(cluster="ocp-east-1")
    job.tasks.append(task)
    session.add(job)
    session.commit()

    assert task.id.startswith("task_")
    assert task.phase == "queued" and task.outcome == "pending"
    assert task.job is job and task.job_id == job.id


def test_an_audit_event_is_stamped_the_moment_it_is_written(session):
    job = PatchJob(plan_id="plan_1", clusters=[])
    job.events.append(AuditEvent(actor="aadesh", action="job.submitted",
                                 data={"clusters": ["ocp-east-1"]}))
    session.add(job)
    session.commit()

    event = job.events[0]
    assert event.id == 1 and event.ts is not None
    assert event.data == {"clusters": ["ocp-east-1"]}


def test_audit_events_come_back_oldest_first(session):
    job = PatchJob(plan_id="plan_1", clusters=[])
    for index, action in enumerate(("job.submitted", "job.approved", "task.precheck")):
        job.events.append(AuditEvent(actor="n8n", action=action,
                                     ts=datetime(2026, 3, 1, 12, index, tzinfo=UTC)))
    session.add(job)
    session.commit()
    session.expire(job)

    assert [e.action for e in job.events] == \
        ["job.submitted", "job.approved", "task.precheck"]


# --------------------------------------------------------------------------- #
# the request bodies
# --------------------------------------------------------------------------- #
def test_a_cluster_list_may_arrive_as_a_list_or_as_a_form_field():
    assert JobCreate(requested_by="a", change_record="CHG1", target_version="4.16.7",
                     clusters=["ocp-east-1", "ocp-west-1"]).clusters == \
        ["ocp-east-1", "ocp-west-1"]
    assert JobCreate(requested_by="a", change_record="CHG1", target_version="4.16.7",
                     clusters="ocp-east-1, ocp-west-1").clusters == \
        ["ocp-east-1", "ocp-west-1"]


def test_blank_entries_in_a_typed_cluster_list_are_dropped():
    """A trailing comma in the form field must not become a patch job against
    a cluster called ""."""
    body = JobCreate(requested_by="a", change_record="CHG1", target_version="4.16.7",
                     clusters="ocp-east-1, , ocp-west-1,")
    assert body.clusters == ["ocp-east-1", "ocp-west-1"]


def test_a_job_must_say_who_asked_for_what_and_under_which_change():
    with pytest.raises(ValidationError) as err:
        JobCreate(clusters=["ocp-east-1"])
    missing = {e["loc"][0] for e in err.value.errors()}
    assert missing == {"requested_by", "change_record", "target_version"}


def test_a_decision_defaults_to_approval_but_must_name_the_approver():
    assert ApproveBody(approver="sre-lead").decision == "approve"
    assert ApproveBody(approver="sre-lead", decision="reject").note is None
    with pytest.raises(ValidationError):
        ApproveBody(decision="approve")


def test_an_event_defaults_to_the_orchestrator_and_must_name_an_action():
    assert EventBody(action="task.precheck").actor == "n8n"
    assert EventBody(action="task.precheck").cluster is None
    assert EventBody(action="job.note", actor="aadesh").actor == "aadesh"
    with pytest.raises(ValidationError):
        EventBody(actor="n8n")
