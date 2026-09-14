"""The serializers take store rows now, not ORM objects."""
from datetime import UTC, datetime, timedelta

from app.serialize import _iso, cluster_detail, cluster_summary, resource_status_dict
from app.settings import settings
from app.store import Row


def _cluster(**fields):
    return Row({"name": "ocp-1", "hub_name": "hub-east", "region": "us-east-1",
                "overall_status": "healthy", "reachable": True, **fields})


def test_iso_accepts_a_datetime_or_an_encoded_string():
    moment = datetime(2026, 9, 10, 12, 0, tzinfo=UTC)
    assert _iso(moment) == "2026-09-10T12:00:00+00:00"
    assert _iso("2026-09-10T12:00:00+00:00") == "2026-09-10T12:00:00+00:00"
    assert _iso(None) is None


def test_cluster_summary_reports_age_and_staleness():
    fresh = cluster_summary(_cluster(last_synced=datetime.now(UTC) - timedelta(seconds=30)))
    assert 29 <= fresh["age_seconds"] <= 31 and fresh["stale"] is False

    old = cluster_summary(_cluster(
        last_synced=datetime.now(UTC) - timedelta(seconds=4 * settings.refresh_interval_seconds)))
    assert old["stale"] is True

    # a missing field reads as None, and a cluster never collected is not "old"
    never = cluster_summary(_cluster())
    assert never["age_seconds"] is None and never["stale"] is False
    assert never["last_synced"] is None


def test_cluster_summary_tolerates_a_string_timestamp():
    encoded = (datetime.now(UTC) - timedelta(seconds=10)).isoformat()
    assert cluster_summary(_cluster(last_synced=encoded))["age_seconds"] == 10


def test_cluster_detail_composes_the_sections_it_is_given():
    d = cluster_detail(
        _cluster(last_synced=datetime.now(UTC), cpu_allocatable=8.0, cpu_usage=2.0),
        operators=[Row({"name": "ingress", "version": "4.16.7", "degraded": False})],
        nodes=[Row({"name": "n2"}), Row({"name": "n1"})],
        namespaces=[Row({"name": "payments", "ns_class": "application", "app_name": "payments"}),
                    Row({"name": "openshift-etcd", "ns_class": "platform"})],
        pod_issues=[Row({"name": "api-1", "ns_class": "application", "namespace": "payments"})],
        resource_status=[Row({"key": "routes", "status": "collected", "count": 3})],
        health_checks=[Row({"name": "nodes-ready", "status": "pass"})],
    )
    assert d["name"] == "ocp-1" and d["capacity"]["cpu"]["used_percent"] == 25.0
    assert [n["name"] for n in d["nodes_detail"]] == ["n1", "n2"]
    assert [n["name"] for n in d["namespaces_detail"]] == ["openshift-etcd", "payments"]
    # applications are the application-class namespaces of the same section
    assert [a["name"] for a in d["applications"]] == ["payments"]
    assert d["resource_status"] == [{"key": "routes", "status": "collected", "count": 3,
                                     "duration_ms": None, "error": None}]
    assert [c["name"] for c in d["health_checks"]] == ["nodes-ready"]


def test_cluster_summary_and_detail_carry_the_collector_timings():
    timings = {"fetch_ms": 8000, "parse_ms": 400, "assemble_ms": 600,
               "health_ms": 50, "persist_ms": 950, "bytes": 120_000_000,
               "objects": 20_000, "kinds_fetched": 24, "kinds_cached": 6}
    c = _cluster(last_synced=datetime.now(UTC), timings=timings)
    assert cluster_summary(c)["timings"] == timings
    # the detail document is the summary plus its sections, so it inherits them
    detail = cluster_detail(c, operators=[], nodes=[], namespaces=[], pod_issues=[],
                            resource_status=[], health_checks=[])
    assert detail["timings"] == timings

    # a cluster collected before the collector measured itself says so
    assert cluster_summary(_cluster())["timings"] is None
    assert cluster_summary(_cluster(timings={}))["timings"] is None


def test_resource_status_passes_through_the_per_kind_collection_facts():
    collected_at = datetime(2026, 9, 13, 4, 13, 54, tzinfo=UTC)
    full = resource_status_dict(Row({
        "key": "secrets", "status": "collected", "count": 6000, "duration_ms": 3200,
        "error": None, "collected_at": collected_at, "cached": False, "bytes": 62_000_000,
        "objects": 6000, "parse_ms": 410.5, "requests": 12, "interval_seconds": 3600}))
    assert full == {
        "key": "secrets", "status": "collected", "count": 6000, "duration_ms": 3200,
        "error": None, "collected_at": "2026-09-13T04:13:54+00:00", "cached": False,
        "bytes": 62_000_000, "objects": 6000, "parse_ms": 410.5, "requests": 12,
        "interval_seconds": 3600}

    # a store that kept the timestamp as a string renders the same
    as_text = resource_status_dict(Row({"key": "pods", "status": "collected", "count": 10,
                                        "collected_at": "2026-09-13T04:13:54+00:00",
                                        "cached": True}))
    assert as_text["collected_at"] == "2026-09-13T04:13:54+00:00" and as_text["cached"] is True

    # and a row from a collector that recorded none of it is unchanged
    assert resource_status_dict(Row({"key": "routes", "status": "collected", "count": 3})) == {
        "key": "routes", "status": "collected", "count": 3, "duration_ms": None, "error": None}
