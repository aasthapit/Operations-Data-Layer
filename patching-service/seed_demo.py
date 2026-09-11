#!/usr/bin/env python3
"""
Seed / integration test for the patching service.

Drives the same API calls N8N makes: create job -> approve -> per-cluster
pre/post-check events -> finalize. Creates two jobs (one clean completion, one
that pauses at the 90% threshold because a degraded cluster is skipped) so the
dashboard has realistic data. Run against http://localhost:18010.
"""
import json
import os
import urllib.request

BASE = os.environ.get("PATCHING_URL", "http://localhost:18010")


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{BASE}{path}", data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def run_cluster(job_id, cluster, target, *, skip=False, health_before=90, health_after=100):
    """Post the per-cluster lifecycle events as N8N would."""
    call("POST", f"/api/jobs/{job_id}/events", {
        "actor": "n8n", "action": "task.precheck", "phase": "precheck",
        "cluster": cluster, "outcome": "skipped" if skip else "passed",
        "version_from": target if skip else "4.15.18", "health_before": health_before,
        "message": "cluster degraded - not safe to patch" if skip else "pre-check passed"})
    if skip:
        return
    for action, phase, msg in [
        ("task.suppress", "suppress", "alerts silenced"),
        ("task.execute", "execute", "pipeline triggered"),
        ("task.monitor", "monitor", "upgrade progressing"),
    ]:
        call("POST", f"/api/jobs/{job_id}/events",
             {"actor": "n8n", "action": action, "phase": phase,
              "cluster": cluster, "message": msg})
    call("POST", f"/api/jobs/{job_id}/events", {
        "actor": "n8n", "action": "task.postcheck", "phase": "done",
        "cluster": cluster, "outcome": "passed", "version_to": target,
        "health_after": health_after, "message": "post-check passed; at target version"})
    call("POST", f"/api/jobs/{job_id}/events", {
        "actor": "n8n", "action": "task.notify", "cluster": cluster,
        "message": "notified owners; alerts re-enabled"})


def make_job(requested_by, approver, change, clusters, target, skips=()):
    job = call("POST", "/api/jobs", {
        "requested_by": requested_by, "change_record": change,
        "target_version": target, "clusters": clusters,
        "threshold_pct": 90, "source": "seed"})
    jid = job["id"]
    call("POST", f"/api/jobs/{jid}/approve", {"approver": approver, "decision": "approve",
                                              "note": "change reviewed in CAB"})
    call("POST", f"/api/jobs/{jid}/events", {"actor": "n8n", "action": "job.start",
                                             "job_status": "running"})
    for c in clusters:
        run_cluster(jid, c, target, skip=(c in skips))
    return jid


def main():
    j1 = make_job("alice", "bob", "CHG0012001",
                  ["ocp-west-1", "ocp-west-2"], "4.16.7")
    j2 = make_job("carol", "dave", "CHG0012002",
                  ["ocp-east-3", "ocp-west-3", "ocp-east-2"], "4.16.7",
                  skips=["ocp-east-2"])

    print("== Job 1 ==", json.dumps(call("GET", f"/api/jobs/{j1}")["totals"]
                                    if False else call("GET", f"/api/jobs/{j1}")["status"]))
    d1 = call("GET", f"/api/jobs/{j1}")
    print(f"  {d1['id']} status={d1['status']} success={d1['totals']['success_pct']}% "
          f"approved_by={d1['approved_by']} audit_events={len(d1['audit'])}")
    d2 = call("GET", f"/api/jobs/{j2}")
    print(f"  {d2['id']} status={d2['status']} success={d2['totals']['success_pct']}% "
          f"(degraded cluster skipped -> below 90% threshold -> paused)")
    print("\n== Report ==")
    print(json.dumps(call("GET", "/api/report"), indent=2)[:600])


if __name__ == "__main__":
    main()
