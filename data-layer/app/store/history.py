"""
The history model: what one snapshot row holds, how rows roll up into coarser
tiers, and what counts as a change worth recording.

Everything here is a pure function of the collector document, so the same logic
is testable without Redis and behaves identically wherever it runs. The Redis
mechanics (which key, which transaction) live in `redis_store.py`.

Three tiers, each its own ZSET per cluster, each trimmed by *time* rather than
by a row count:

    sweep   one row per collection sweep, kept SNAPSHOT_RAW_HOURS (48h)
    hour    one row per hour,             kept SNAPSHOT_HOURLY_DAYS (90d)
    day     one row per day,              kept SNAPSHOT_DAILY_DAYS  (730d)

A trend question asks for a span ("crash loops per hour over the last day",
"warning events per day over the last month"), not for a number of rows, and
the number of rows a sweep interval produces is an implementation detail. The
coarser tiers are what make two years of history affordable: see
`docs/redis-keyspace.md` for the memory arithmetic.

How a bucket is rolled up depends on what the field means, which is the whole
reason this is a table rather than a loop:

    counters (crash loops, warning events, failing checks)  MAX over the bucket
        - a spike that lasted ten minutes must survive into the daily row, and
          an average would hide it.
    gauges (health score, node counts, version, application count)  LAST
        - the state at the end of the bucket, which is what "what was it on
          Tuesday?" means.
    utilization (cpu_usage, memory_usage)  MEAN, plus MAX beside it
        - capacity planning wants the typical value and the peak, and a mean
          alone makes every cluster look idle.
    name lists (which checks failed)  UNION
        - "which checks failed at any point today" is the useful question.

Rolling an hourly row into a daily one applies the same rules to the hourly
rows, with the mean weighted by each row's `samples`, so a daily mean is the
true mean of the raw samples behind it and not a mean of means.
"""
from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, datetime, timedelta

# The three tiers, coarsest last. `sweep` is what the collector writes; the
# other two are derived from it and never written directly.
SWEEP, HOUR, DAY = "sweep", "hour", "day"
RESOLUTIONS = (SWEEP, HOUR, DAY)

# Pod issue reasons, exactly as `collector/parsers.py:pod_issue` produces them
# (the waiting reasons come from its BAD_WAITING set).
CRASHLOOP_REASONS = frozenset({"CrashLoopBackOff"})
IMAGE_PULL_REASONS = frozenset({"ImagePullBackOff", "ErrImagePull", "InvalidImageName"})
OOM_REASONS = frozenset({"OOMKilled"})
PENDING_REASONS = frozenset({"Pending", "Unschedulable"})

# How many event reasons one snapshot row keeps. A cluster in trouble produces
# a long tail of one-off reasons; the head is what a trend is about.
EVENT_REASONS_KEPT = 10

# --------------------------------------------------------------------------- #
# aggregation rules - see the module docstring for why each field is where
# --------------------------------------------------------------------------- #
# Counters: the worst value in the bucket.
MAX_FIELDS: tuple[str, ...] = (
    "checks_warned", "checks_failed", "pod_issues", "pod_issues_platform",
    "pod_issues_application", "crashloops", "image_pull_errors", "oom_killed",
    "pending_pods", "restarts_total", "warning_events", "operators_degraded",
    "certs_expiring_total",
)
# Gauges: the value at the end of the bucket.
LAST_FIELDS: tuple[str, ...] = (
    "overall_status", "health_score", "checks_passed", "ocp_version",
    "cpu_allocatable", "memory_allocatable", "pods_running", "nodes_total",
    "nodes_ready", "namespaces_application", "applications_total", "workloads_total",
)
# Utilization: the mean over the bucket, with the peak kept beside it as
# `<field>_max`.
MEAN_FIELDS: tuple[str, ...] = ("cpu_usage", "memory_usage")
# Name lists: everything seen anywhere in the bucket.
UNION_FIELDS: tuple[str, ...] = ("checks_failed_names", "checks_warned_names")
# A boolean that is true when it was true at any point in the bucket: an
# upgrade that started and finished inside one day still shows on that day.
ANY_FIELDS: tuple[str, ...] = ("upgrading",)


def _peak(field: str) -> str:
    return f"{field}_max"


# Every field a snapshot row can carry, in a stable order (the SQL schema
# mirrors it).
SNAPSHOT_FIELDS: tuple[str, ...] = (
    "cluster_name", "resolution", "samples", "snapshot_at",
    *LAST_FIELDS, *ANY_FIELDS, *MAX_FIELDS, *MEAN_FIELDS,
    *(_peak(f) for f in MEAN_FIELDS), *UNION_FIELDS, "events_by_reason",
)


# --------------------------------------------------------------------------- #
# one sweep
# --------------------------------------------------------------------------- #
def _count_issues(pod_issues: Iterable[dict]) -> dict:
    """Pod issues counted the ways a trend asks about them."""
    counts = {"pod_issues_platform": 0, "pod_issues_application": 0, "crashloops": 0,
              "image_pull_errors": 0, "oom_killed": 0, "pending_pods": 0}
    for issue in pod_issues or ():
        ns_class = issue.get("ns_class")
        if ns_class == "platform":
            counts["pod_issues_platform"] += 1
        elif ns_class == "application":
            counts["pod_issues_application"] += 1
        reason = issue.get("reason")
        if reason in CRASHLOOP_REASONS:
            counts["crashloops"] += 1
        elif reason in IMAGE_PULL_REASONS:
            counts["image_pull_errors"] += 1
        elif reason in OOM_REASONS:
            counts["oom_killed"] += 1
        elif reason in PENDING_REASONS:
            counts["pending_pods"] += 1
    return counts


def _event_reasons(resources: Iterable[dict]) -> tuple[int, dict[str, int]]:
    """(warning events, the commonest reasons) from the `events` resource rows.

    The collector only fetches Warning events (`type=Warning` field selector,
    capped by the manifest's `limit`), so every events row is a warning and the
    count is the number of rows, not the sum of each event's own `count`.
    """
    total = 0
    by_reason: dict[str, int] = {}
    for row in resources or ():
        if row.get("key") != "events":
            continue
        total += 1
        reason = (row.get("summary") or {}).get("reason") or "Unknown"
        by_reason[reason] = by_reason.get(reason, 0) + 1
    return total, _top_reasons(by_reason)


def _top_reasons(by_reason: dict[str, int]) -> dict[str, int]:
    """The commonest reasons, most frequent first, ties broken by name."""
    ordered = sorted(by_reason.items(), key=lambda kv: (-kv[1], kv[0]))
    return dict(ordered[:EVENT_REASONS_KEPT])


def snapshot_row(name: str, summary: dict, collected: dict, checks: Iterable[dict],
                 now: datetime) -> dict:
    """One sweep's history row: health, utilization and what is going wrong.

    The counters are computed here rather than read off the summary because the
    summary keeps only the totals the current-state API needs; a trend wants to
    know *which* kind of trouble it was (crash loops, image pulls, OOM kills)
    and which checks were failing by name.
    """
    cap = collected.get("capacity") or {}
    checks = list(checks or ())
    warning_events, events_by_reason = _event_reasons(collected.get("resources"))
    row = {
        "cluster_name": name,
        "resolution": SWEEP,
        "samples": 1,
        "snapshot_at": now,
        # -- health
        "overall_status": summary["overall_status"],
        "health_score": summary["health_score"],
        "checks_passed": summary["checks_passed"],
        "checks_warned": summary["checks_warned"],
        "checks_failed": summary["checks_failed"],
        "checks_failed_names": sorted(c["name"] for c in checks if c.get("status") == "fail"),
        "checks_warned_names": sorted(c["name"] for c in checks if c.get("status") == "warn"),
        "operators_degraded": sum(1 for o in (collected.get("operators") or [])
                                  if o.get("degraded")),
        # -- version
        "ocp_version": summary["ocp_version"],
        "upgrading": summary["upgrading"],
        # -- utilization
        "cpu_usage": cap.get("cpu_usage"),
        "cpu_allocatable": cap.get("cpu_allocatable"),
        "memory_usage": cap.get("memory_usage"),
        "memory_allocatable": cap.get("memory_allocatable"),
        "pods_running": summary["pods_running"],
        # -- what is going wrong
        "pod_issues": summary["pod_issues_total"],
        "restarts_total": sum(int(n.get("restarts_total") or 0)
                              for n in (collected.get("namespaces") or [])),
        "warning_events": warning_events,
        "events_by_reason": events_by_reason,
        # -- shape of the cluster
        "nodes_total": summary["nodes_total"],
        "nodes_ready": summary["nodes_ready"],
        "namespaces_application": summary["namespaces_application"],
        "applications_total": summary["applications_total"],
        "workloads_total": summary["workloads_total"],
        "certs_expiring_total": summary["certs_expiring_total"],
    }
    row.update(_count_issues(collected.get("pod_issues")))
    return row


# --------------------------------------------------------------------------- #
# buckets
# --------------------------------------------------------------------------- #
def bucket_start(when: datetime | float, resolution: str) -> datetime:
    """The start of the `resolution` bucket `when` falls in, in UTC."""
    if isinstance(when, int | float):
        when = datetime.fromtimestamp(float(when), UTC)
    when = when.astimezone(UTC) if when.tzinfo else when.replace(tzinfo=UTC)
    if resolution == DAY:
        return when.replace(hour=0, minute=0, second=0, microsecond=0)
    if resolution == HOUR:
        return when.replace(minute=0, second=0, microsecond=0)
    return when


def bucket_end(start: datetime, resolution: str) -> datetime:
    """The first instant of the next bucket (an exclusive upper bound)."""
    return start + (timedelta(days=1) if resolution == DAY else timedelta(hours=1))


def source_resolution(resolution: str) -> str:
    """The tier an `hour` / `day` row is aggregated from."""
    return HOUR if resolution == DAY else SWEEP


# --------------------------------------------------------------------------- #
# rolling up
# --------------------------------------------------------------------------- #
def _numbers(rows: list[dict], field: str) -> list:
    return [r[field] for r in rows if r.get(field) is not None]


def _weighted_mean(rows: list[dict], field: str) -> float | int | None:
    """The mean over the raw samples behind `rows`, not a mean of means.

    A mean of whole numbers stays whole: memory is bytes, and a row reporting
    2.6 billion point four bytes helps nobody. CPU is cores and stays a float.
    """
    total = weight = 0.0
    whole = True
    for row in rows:
        value = row.get(field)
        if value is None:
            continue
        whole = whole and isinstance(value, int)
        samples = max(1, int(row.get("samples") or 1))
        total += float(value) * samples
        weight += samples
    if not weight:
        return None
    mean = total / weight
    return round(mean) if whole else mean


def _peak_of(rows: list[dict], field: str):
    """The highest value of `field` anywhere in the bucket, taking an already
    aggregated row's own peak into account."""
    values = [r.get(_peak(field)) if r.get(_peak(field)) is not None else r.get(field)
              for r in rows]
    values = [v for v in values if v is not None]
    return max(values) if values else None


def _merge_reasons(rows: list[dict]) -> dict[str, int]:
    """Event reasons across the bucket: the worst count seen per reason.

    Max rather than sum for the same reason the counters use it - each row is a
    snapshot of what the cluster held at that moment, and the same event is
    counted again by the next sweep, so summing would multiply it by the sweep
    rate.
    """
    merged: dict[str, int] = {}
    for row in rows:
        for reason, count in (row.get("events_by_reason") or {}).items():
            merged[reason] = max(merged.get(reason, 0), int(count or 0))
    return _top_reasons(merged)


def aggregate_snapshots(rows: list[dict], at: datetime, resolution: str) -> dict | None:
    """Roll several snapshot rows into one row of the coarser `resolution`.

    `rows` are the rows of one bucket, at any resolution, in any order; `at` is
    the bucket start, which becomes the new row's `snapshot_at`. Returns None
    for an empty bucket. See the module docstring for the per-field rules.
    """
    rows = [r for r in rows if r]
    if not rows:
        return None
    ordered = sorted(rows, key=lambda r: _as_epoch(r.get("snapshot_at")))
    last = ordered[-1]

    out = {
        "cluster_name": last.get("cluster_name"),
        "resolution": resolution,
        "samples": sum(max(1, int(r.get("samples") or 1)) for r in ordered),
        "snapshot_at": at,
    }
    for field in LAST_FIELDS:
        out[field] = last.get(field)
    for field in ANY_FIELDS:
        out[field] = any(bool(r.get(field)) for r in ordered)
    for field in MAX_FIELDS:
        values = _numbers(ordered, field)
        out[field] = max(values) if values else None
    for field in MEAN_FIELDS:
        out[field] = _weighted_mean(ordered, field)
        out[_peak(field)] = _peak_of(ordered, field)
    for field in UNION_FIELDS:
        names: set[str] = set()
        for row in ordered:
            names.update(row.get(field) or ())
        out[field] = sorted(names)
    out["events_by_reason"] = _merge_reasons(ordered)
    return out


def _as_epoch(value) -> float:
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=UTC)
        return dt.timestamp()
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, str):
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return 0.0
        return (dt if dt.tzinfo else dt.replace(tzinfo=UTC)).timestamp()
    return 0.0


# --------------------------------------------------------------------------- #
# the change log
# --------------------------------------------------------------------------- #
# The vocabulary of `kind`. A reader filters on these, so they are fixed: a new
# kind is a deliberate addition here and in the SQL column's description.
KINDS = ("version", "status", "check", "operator", "nodes", "namespace",
         "application", "upgrade", "reachability")

# What "not failing" is called in a check's before / after. A check that was
# warning and starts failing reads `ok -> fail`, which is the transition the
# change log is about; the warn/pass detail is in the snapshot row's
# `checks_warned_names`.
OK, FAIL = "ok", "fail"
DEGRADED = "degraded"


def _change(at: datetime, kind: str, subject: str, before, after, message: str) -> dict:
    return {"at": at, "kind": kind, "subject": subject,
            "before": before, "after": after, "message": message}


def _scalar_changes(at, previous: dict, current: dict) -> list[dict]:
    """The summary fields whose change is itself the story."""
    out = []
    old_version, new_version = previous.get("ocp_version"), current.get("ocp_version")
    if old_version != new_version and new_version:
        out.append(_change(at, "version", "ocp_version", old_version, new_version,
                           f"version changed from {old_version or 'unknown'} to {new_version}"))
    old_status, new_status = previous.get("overall_status"), current.get("overall_status")
    if old_status != new_status:
        out.append(_change(at, "status", "overall_status", old_status, new_status,
                           f"status changed from {old_status or 'unknown'} to {new_status}"))
    for field in ("nodes_total", "nodes_ready"):
        old, new = previous.get(field) or 0, current.get(field) or 0
        if old != new:
            out.append(_change(at, "nodes", field, old, new,
                               f"{field.replace('_', ' ')} changed from {old} to {new}"))
    old_apps, new_apps = previous.get("applications_total") or 0, current.get("applications_total") or 0
    if old_apps != new_apps:
        out.append(_change(at, "application", "applications_total", old_apps, new_apps,
                           f"applications changed from {old_apps} to {new_apps}"))
    was, is_now = bool(previous.get("upgrading")), bool(current.get("upgrading"))
    if was != is_now:
        target = current.get("desired_version") or current.get("ocp_version") or "unknown"
        out.append(_change(at, "upgrade", target, was, is_now,
                           f"upgrade to {target} started" if is_now
                           else f"upgrade finished on {current.get('ocp_version') or target}"))
    return out


def _set_changes(at, kind: str, before: set[str], after: set[str],
                 enter: str, leave: str, verb: str, recovered: str) -> list[dict]:
    """One record per member that entered or left a set of bad things."""
    out = [_change(at, kind, name, leave, enter, f"{name} {verb}")
           for name in sorted(after - before)]
    out += [_change(at, kind, name, enter, leave, f"{name} {recovered}")
            for name in sorted(before - after)]
    return out


def _namespace_changes(at, previous: dict[str, str | None],
                       current: dict[str, str | None]) -> list[dict]:
    """Application namespaces that appeared or disappeared, with their app."""
    out = []
    for name in sorted(set(current) - set(previous)):
        app = current[name]
        out.append(_change(at, "namespace", name, None, app,
                           f"namespace {name} added" + (f" (application {app})" if app else "")))
    for name in sorted(set(previous) - set(current)):
        app = previous[name]
        out.append(_change(at, "namespace", name, app, None,
                           f"namespace {name} removed" + (f" (application {app})" if app else "")))
    return out


def diff_changes(*, at: datetime, previous_summary: dict | None, summary: dict,
                 previous_checks_failed: Iterable[str] = (),
                 checks_failed: Iterable[str] = (),
                 previous_degraded_operators: Iterable[str] = (),
                 degraded_operators: Iterable[str] = (),
                 previous_namespaces: dict[str, str | None] | None = None,
                 namespaces: dict[str, str | None] | None = None) -> list[dict]:
    """What changed between the last sweep of a cluster and this one.

    Returns change records `{at, kind, subject, before, after, message}` with
    `kind` from `KINDS`. Two rules keep the log honest:

    * **A cluster seen for the first time changes nothing.** Without a previous
      summary every value would read as "appeared", which is noise, not news.
    * **An unreachable sweep reports only its reachability.** A cluster the
      collector could not connect to has empty sections, so every check would
      look recovered and every namespace deleted; the one thing that actually
      happened is that it went unreachable (or came back), and that is the only
      record either side of the gap produces.
    """
    if previous_summary is None:
        return []
    was_reachable = bool(previous_summary.get("reachable", True))
    is_reachable = bool(summary.get("reachable", True))
    if was_reachable != is_reachable:
        error = summary.get("last_error")
        return [_change(at, "reachability", "reachable", was_reachable, is_reachable,
                        "cluster is reachable again" if is_reachable
                        else f"cluster became unreachable: {error}" if error
                        else "cluster became unreachable")]
    if not (was_reachable and is_reachable):
        return []

    out = _scalar_changes(at, previous_summary, summary)
    out += _set_changes(at, "check", set(previous_checks_failed), set(checks_failed),
                        FAIL, OK, "started failing", "recovered")
    out += _set_changes(at, "operator", set(previous_degraded_operators),
                        set(degraded_operators), DEGRADED, OK,
                        "became degraded", "recovered")
    out += _namespace_changes(at, previous_namespaces or {}, namespaces or {})
    return out
