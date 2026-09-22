"""
The patching API: jobs, approvals, per-cluster progress and the audit trail.

This service is the durable record of what was patched, by whom, with whose
approval and what happened - the one part of the estate that is not
regenerated from the clusters every few minutes. So what these tests hold onto
is the record itself: that a job's totals are recomputed from its tasks rather
than trusted from the caller, that a job only completes when every cluster has
finished and enough of them passed, that an approval and a rejection are both
written down with who decided, and that nothing has a path that edits or
deletes an audit event.

Everything runs against the real models on an in-memory SQLite (see
conftest.py), so the routes, the session and the schema are the production
ones.
"""
from datetime import UTC, datetime

from app.models import AuditEvent, PatchJob, PatchTask, new_id

JOB = {"requested_by": "aadesh", "change_record": "CHG0041234",
       "target_version": "4.16.7", "clusters": ["ocp-east-1", "ocp-west-1"],
       "threshold_pct": 90}


def _create(client, **overrides):
    body = {**JOB, **overrides}
    answer = client.post("/api/jobs", json=body)
    assert answer.status_code == 200, answer.text
    return answer.json()


def _instant(text):
    """The same instant, however it was spelled. Postgres hands a
    timezone-aware value back from a `DateTime(timezone=True)` column and the
    SQLite the tests run on cannot, so only the instant is comparable."""
    value = datetime.fromisoformat(text)
    return value.astimezone(UTC).replace(tzinfo=None) if value.tzinfo else value


def _event(client, job_id, **body):
    answer = client.post(f"/api/jobs/{job_id}/events", json={"action": "task.update", **body})
    assert answer.status_code == 200, answer.text
    return answer.json()


# --------------------------------------------------------------------------- #
# submitting a job
# --------------------------------------------------------------------------- #
def test_a_submitted_job_starts_pending_approval_with_a_task_per_cluster(client):
    job = _create(client)
    assert job["status"] == "submitted" and job["approval_status"] == "pending"
    assert job["requested_by"] == "aadesh" and job["change_record"] == "CHG0041234"
    assert job["target_version"] == "4.16.7" and job["threshold_pct"] == 90
    assert job["totals"] == {"total": 2, "succeeded": 0, "failed": 0, "skipped": 0,
                             "success_pct": 0}
    assert job["created_at"] is not None
    assert job["started_at"] is None and job["finished_at"] is None

    detail = client.get(f"/api/jobs/{job['id']}").json()
    assert [t["cluster"] for t in detail["tasks"]] == ["ocp-east-1", "ocp-west-1"]
    assert {t["phase"] for t in detail["tasks"]} == {"queued"}
    assert {t["outcome"] for t in detail["tasks"]} == {"pending"}
    assert detail["clusters"] == ["ocp-east-1", "ocp-west-1"]


def test_submitting_a_job_writes_the_first_audit_entry(client):
    job = _create(client)
    audit = client.get(f"/api/jobs/{job['id']}/audit").json()["audit"]
    assert len(audit) == 1
    entry = audit[0]
    assert entry["actor"] == "aadesh" and entry["action"] == "job.submitted"
    assert "4.16.7" in entry["message"] and "2 cluster(s)" in entry["message"]
    assert entry["data"] == {"change_record": "CHG0041234",
                             "clusters": ["ocp-east-1", "ocp-west-1"]}
    assert entry["ts"] is not None


def test_a_comma_separated_cluster_list_is_accepted_from_a_form(client):
    """The submission form posts one field; the API must not make the operator
    hand-roll JSON."""
    job = _create(client, clusters=" ocp-east-1 , ocp-west-1 ,, ")
    assert job["totals"]["total"] == 2
    detail = client.get(f"/api/jobs/{job['id']}").json()
    assert detail["clusters"] == ["ocp-east-1", "ocp-west-1"]


def test_a_job_without_a_plan_gets_one_so_every_run_is_traceable(client):
    job = _create(client)
    assert job["plan_id"].startswith("plan_")
    assert _create(client, plan_id="plan-nightly-4.16")["plan_id"] == "plan-nightly-4.16"


def test_the_source_of_the_request_is_recorded(client):
    assert _create(client)["source"] == "api"
    assert _create(client, source="schedule")["source"] == "schedule"


def test_a_job_missing_a_change_record_is_rejected_before_anything_is_written(client, session):
    answer = client.post("/api/jobs", json={"requested_by": "aadesh",
                                            "target_version": "4.16.7",
                                            "clusters": ["ocp-east-1"]})
    assert answer.status_code == 422
    assert "change_record" in answer.text
    assert session.query(PatchJob).count() == 0


def test_a_job_over_no_clusters_is_recorded_with_nothing_to_do(client):
    job = _create(client, clusters=[])
    assert job["totals"] == {"total": 0, "succeeded": 0, "failed": 0, "skipped": 0,
                             "success_pct": 0}
    assert job["status"] == "submitted"


# --------------------------------------------------------------------------- #
# listing and reading
# --------------------------------------------------------------------------- #
def test_jobs_come_back_newest_first(client):
    first = _create(client, change_record="CHG1")
    second = _create(client, change_record="CHG2")
    listed = client.get("/api/jobs").json()
    assert listed["count"] == 2
    assert [j["id"] for j in listed["jobs"]] == [second["id"], first["id"]]


def test_jobs_can_be_narrowed_to_a_status_or_a_requester(client):
    mine = _create(client, requested_by="aadesh")
    theirs = _create(client, requested_by="somebody-else")
    client.post(f"/api/jobs/{theirs['id']}/approve",
                json={"approver": "sre-lead", "decision": "reject"})

    assert [j["id"] for j in client.get("/api/jobs?status=rejected").json()["jobs"]] == \
        [theirs["id"]]
    assert [j["id"] for j in client.get("/api/jobs?requested_by=aadesh").json()["jobs"]] == \
        [mine["id"]]
    assert client.get("/api/jobs?status=completed").json() == {"count": 0, "jobs": []}


def test_the_listing_is_capped_so_a_long_history_cannot_time_out(client):
    for i in range(4):
        _create(client, change_record=f"CHG{i}")
    assert client.get("/api/jobs?limit=2").json()["count"] == 2


def test_a_job_that_does_not_exist_is_a_404_naming_it(client):
    assert client.get("/api/jobs/job_nope").status_code == 404
    assert "job_nope not found" in client.get("/api/jobs/job_nope").json()["detail"]
    assert client.get("/api/jobs/job_nope/audit").status_code == 404
    assert client.post("/api/jobs/job_nope/approve",
                       json={"approver": "sre-lead"}).status_code == 404
    assert client.post("/api/jobs/job_nope/events",
                       json={"action": "task.precheck"}).status_code == 404


def test_tasks_are_listed_in_a_stable_order_whatever_order_they_finished_in(client):
    job = _create(client, clusters=["ocp-west-1", "ocp-east-1", "ocp-mid-1"])
    _event(client, job["id"], cluster="ocp-mid-1", phase="precheck", outcome="passed")
    detail = client.get(f"/api/jobs/{job['id']}").json()
    assert [t["cluster"] for t in detail["tasks"]] == \
        ["ocp-east-1", "ocp-mid-1", "ocp-west-1"]


# --------------------------------------------------------------------------- #
# approvals
# --------------------------------------------------------------------------- #
def test_an_approval_records_who_approved_and_releases_the_job(client):
    job = _create(client)
    approved = client.post(f"/api/jobs/{job['id']}/approve",
                           json={"approver": "sre-lead", "note": "CAB approved"}).json()
    assert approved["approval_status"] == "approved"
    assert approved["approved_by"] == "sre-lead"
    assert approved["status"] == "approved"

    audit = client.get(f"/api/jobs/{job['id']}/audit").json()["audit"]
    assert [e["action"] for e in audit] == ["job.submitted", "job.approved"]
    assert audit[-1]["actor"] == "sre-lead" and audit[-1]["message"] == "CAB approved"


def test_a_rejection_stops_the_job_and_says_who_stopped_it(client):
    job = _create(client)
    rejected = client.post(f"/api/jobs/{job['id']}/approve",
                           json={"approver": "sre-lead", "decision": "reject",
                                 "note": "change window closed"}).json()
    assert rejected["approval_status"] == "rejected" and rejected["status"] == "rejected"
    assert rejected["approved_by"] is None, "a rejection must not read as an approval"

    audit = client.get(f"/api/jobs/{job['id']}/audit").json()["audit"]
    assert audit[-1]["action"] == "job.rejected"
    assert audit[-1]["message"] == "change window closed"


def test_approving_a_job_that_is_already_running_does_not_send_it_backwards(client):
    job = _create(client)
    client.post(f"/api/jobs/{job['id']}/approve", json={"approver": "sre-lead"})
    _event(client, job["id"], job_status="running")

    approved = client.post(f"/api/jobs/{job['id']}/approve",
                           json={"approver": "second-approver"}).json()
    assert approved["status"] == "running"
    assert approved["approved_by"] == "second-approver"


# --------------------------------------------------------------------------- #
# progress events
# --------------------------------------------------------------------------- #
def test_an_event_updates_the_cluster_s_task_and_is_written_to_the_audit(client):
    job = _create(client)
    _event(client, job["id"], actor="n8n", action="task.precheck", cluster="ocp-east-1",
           phase="precheck", outcome="passed", version_from="4.15.30",
           health_before=91, message="preconditions met")

    task = next(t for t in client.get(f"/api/jobs/{job['id']}").json()["tasks"]
                if t["cluster"] == "ocp-east-1")
    assert task["phase"] == "precheck" and task["outcome"] == "passed"
    assert task["precheck_status"] == "passed" and task["postcheck_status"] is None
    assert task["version_from"] == "4.15.30" and task["health_before"] == 91
    assert task["message"] == "preconditions met"
    assert task["started_at"] is not None and task["finished_at"] is not None

    audit = client.get(f"/api/jobs/{job['id']}/audit").json()["audit"][-1]
    assert audit["action"] == "task.precheck" and audit["cluster"] == "ocp-east-1"
    assert audit["data"]["version_from"] == "4.15.30"
    assert audit["data"]["health_before"] == 91
    assert audit["data"]["outcome"] == "passed"


def test_the_first_event_for_a_cluster_starts_its_clock_and_later_ones_do_not_reset_it(client):
    job = _create(client)
    _event(client, job["id"], cluster="ocp-east-1", phase="precheck", outcome="passed")
    started = next(t for t in client.get(f"/api/jobs/{job['id']}").json()["tasks"]
                   if t["cluster"] == "ocp-east-1")["started_at"]

    _event(client, job["id"], cluster="ocp-east-1", phase="execute")
    task = next(t for t in client.get(f"/api/jobs/{job['id']}").json()["tasks"]
                if t["cluster"] == "ocp-east-1")
    assert _instant(task["started_at"]) == _instant(started)
    assert task["phase"] == "execute"


def test_a_postcheck_is_recorded_separately_from_a_precheck(client):
    job = _create(client)
    _event(client, job["id"], cluster="ocp-east-1", phase="precheck", outcome="passed")
    _event(client, job["id"], cluster="ocp-east-1", phase="postcheck", outcome="failed",
           version_to="4.16.7", health_after=62)

    task = next(t for t in client.get(f"/api/jobs/{job['id']}").json()["tasks"]
                if t["cluster"] == "ocp-east-1")
    assert task["precheck_status"] == "passed" and task["postcheck_status"] == "failed"
    assert task["version_to"] == "4.16.7" and task["health_after"] == 62


def test_an_event_about_a_cluster_the_job_never_listed_is_still_recorded(client):
    """The orchestrator is the source of truth for what it actually touched;
    losing that would leave the record quietly wrong."""
    job = _create(client, clusters=["ocp-east-1"])
    _event(client, job["id"], cluster="ocp-late-1", phase="execute", outcome="passed")
    clusters = [t["cluster"] for t in client.get(f"/api/jobs/{job['id']}").json()["tasks"]]
    assert clusters == ["ocp-east-1", "ocp-late-1"]


def test_a_note_about_the_whole_job_carries_no_cluster_and_touches_no_task(client):
    job = _create(client)
    _event(client, job["id"], actor="aadesh", action="job.note",
           message="waiting for the change window")
    detail = client.get(f"/api/jobs/{job['id']}").json()
    assert {t["phase"] for t in detail["tasks"]} == {"queued"}
    assert detail["audit"][-1]["action"] == "job.note"
    assert detail["audit"][-1]["cluster"] is None
    assert detail["audit"][-1]["data"] is None


def test_structured_detail_on_an_event_is_kept_alongside_the_known_fields(client):
    job = _create(client)
    _event(client, job["id"], cluster="ocp-east-1", outcome="failed",
           data={"mcp": "worker", "degraded_nodes": 3})
    audit = client.get(f"/api/jobs/{job['id']}/audit").json()["audit"][-1]
    assert audit["data"] == {"mcp": "worker", "degraded_nodes": 3, "outcome": "failed"}


def test_moving_the_job_to_running_starts_its_clock_once(client):
    job = _create(client)
    running = _event(client, job["id"], action="job.started", job_status="running")
    assert running["status"] == "running" and running["started_at"] is not None

    again = _event(client, job["id"], action="job.note", job_status="running")
    assert _instant(again["started_at"]) == _instant(running["started_at"])


def test_moving_the_job_to_a_terminal_status_stops_its_clock(client):
    job = _create(client)
    cancelled = _event(client, job["id"], action="job.cancelled", job_status="cancelled")
    assert cancelled["status"] == "cancelled" and cancelled["finished_at"] is not None


# --------------------------------------------------------------------------- #
# totals, recomputed from the tasks and never trusted from the caller
# --------------------------------------------------------------------------- #
def test_a_job_completes_when_every_cluster_finished_and_enough_of_them_passed(client):
    job = _create(client, clusters=["a", "b", "c", "d"], threshold_pct=75)
    client.post(f"/api/jobs/{job['id']}/approve", json={"approver": "sre-lead"})
    _event(client, job["id"], job_status="running")
    for cluster in ("a", "b", "c"):
        _event(client, job["id"], cluster=cluster, phase="done", outcome="passed")
    latest = _event(client, job["id"], cluster="d", phase="done", outcome="skipped")

    assert latest["totals"] == {"total": 4, "succeeded": 3, "failed": 0, "skipped": 1,
                                "success_pct": 75}
    assert latest["status"] == "completed" and latest["finished_at"] is not None


def test_a_job_that_missed_its_threshold_pauses_for_a_human_instead_of_completing(client):
    job = _create(client, clusters=["a", "b"], threshold_pct=90)
    client.post(f"/api/jobs/{job['id']}/approve", json={"approver": "sre-lead"})
    _event(client, job["id"], job_status="running")
    _event(client, job["id"], cluster="a", phase="done", outcome="passed")
    latest = _event(client, job["id"], cluster="b", phase="done", outcome="failed")

    assert latest["totals"]["success_pct"] == 50
    assert latest["status"] == "paused"


def test_a_job_still_in_flight_keeps_its_status_while_the_totals_move(client):
    job = _create(client, clusters=["a", "b"])
    client.post(f"/api/jobs/{job['id']}/approve", json={"approver": "sre-lead"})
    latest = _event(client, job["id"], cluster="a", phase="done", outcome="passed")
    assert latest["totals"]["succeeded"] == 1 and latest["totals"]["success_pct"] == 50
    assert latest["status"] == "approved" and latest["finished_at"] is None


def test_a_job_a_human_already_moved_on_is_not_reopened_by_a_late_event(client):
    """`completed`, `failed` and `cancelled` are decisions; recomputing must
    only ever close a job that is still approved or running."""
    job = _create(client, clusters=["a"])
    _event(client, job["id"], job_status="cancelled")
    latest = _event(client, job["id"], cluster="a", phase="done", outcome="passed")
    assert latest["status"] == "cancelled"


def test_the_finish_time_of_a_completed_job_is_not_moved_by_a_later_event(client):
    job = _create(client, clusters=["a"])
    client.post(f"/api/jobs/{job['id']}/approve", json={"approver": "sre-lead"})
    finished = _event(client, job["id"], cluster="a", phase="done",
                      outcome="passed")["finished_at"]
    later = _event(client, job["id"], action="job.note", message="verified by hand")
    assert _instant(later["finished_at"]) == _instant(finished)


# --------------------------------------------------------------------------- #
# the fleet-wide report
# --------------------------------------------------------------------------- #
def test_an_estate_that_has_never_patched_reports_zeroes_rather_than_failing(client):
    assert client.get("/api/report").json() == {
        "jobs_total": 0, "jobs_by_status": {},
        "clusters": {"succeeded": 0, "failed": 0, "pending": 0},
        "avg_success_pct": None, "recent_jobs": []}


def test_the_report_counts_jobs_by_status_and_clusters_by_outcome(client):
    done = _create(client, clusters=["a", "b"], threshold_pct=50)
    client.post(f"/api/jobs/{done['id']}/approve", json={"approver": "sre-lead"})
    _event(client, done["id"], cluster="a", phase="done", outcome="passed")
    _event(client, done["id"], cluster="b", phase="done", outcome="failed")
    _create(client, clusters=["c", "d"])            # still submitted, nothing done

    report = client.get("/api/report").json()
    assert report["jobs_total"] == 2
    assert report["jobs_by_status"] == {"completed": 1, "submitted": 1}
    assert report["clusters"] == {"succeeded": 1, "failed": 1, "pending": 2}
    assert report["avg_success_pct"] == 50


def test_the_report_averages_only_the_jobs_that_actually_ran(client):
    """A job nobody has approved yet has a success rate of 0 by definition;
    averaging it in would make the estate look worse than it is."""
    done = _create(client, clusters=["a"], threshold_pct=50)
    client.post(f"/api/jobs/{done['id']}/approve", json={"approver": "sre-lead"})
    _event(client, done["id"], cluster="a", phase="done", outcome="passed")
    _create(client, clusters=["b"])

    assert client.get("/api/report").json()["avg_success_pct"] == 100


def test_the_report_shows_only_the_ten_most_recent_jobs(client):
    for i in range(12):
        _create(client, change_record=f"CHG{i:02d}")
    recent = client.get("/api/report").json()["recent_jobs"]
    assert len(recent) == 10
    assert [j["change_record"] for j in recent][:2] == ["CHG11", "CHG10"]


# --------------------------------------------------------------------------- #
# the record itself
# --------------------------------------------------------------------------- #
def test_the_audit_trail_has_no_update_or_delete_path(client):
    """Append-only is the point of the table; it is enforced by there being no
    route that can reach an event."""
    routes = {(method, route.path)
              for route in client.app.routes
              for method in getattr(route, "methods", ())}
    reaches_audit = {r for r in routes if "audit" in r[1] or "event" in r[1]}
    assert reaches_audit == {("GET", "/api/jobs/{job_id}/audit"),
                             ("POST", "/api/jobs/{job_id}/events")}
    assert not any(method in ("PUT", "PATCH", "DELETE") for method, _path in routes)


def test_deleting_a_job_takes_its_tasks_and_audit_with_it(session):
    """There is no API for it, but an operator pruning the database by hand
    must not leave orphaned rows behind."""
    job = PatchJob(id=new_id("job"), plan_id="plan_1", requested_by="aadesh",
                   clusters=["ocp-east-1"])
    job.tasks.append(PatchTask(cluster="ocp-east-1"))
    job.events.append(AuditEvent(actor="aadesh", action="job.submitted"))
    session.add(job)
    session.commit()

    session.delete(job)
    session.commit()
    assert session.query(PatchTask).count() == 0
    assert session.query(AuditEvent).count() == 0
