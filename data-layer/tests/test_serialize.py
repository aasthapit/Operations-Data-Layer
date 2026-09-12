"""The serializers take store rows now, not ORM objects."""
from datetime import UTC, datetime, timedelta

from app.serialize import _iso, cluster_detail, cluster_summary
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
