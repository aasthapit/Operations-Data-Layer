"""
The synthetic load generator has to keep producing documents the real collector
could have produced: every section present, the row shapes the store indexes,
and a document the health checks can score. These tests run the whole load
(generate -> health check -> persist -> report) against fakeredis at a tiny
scale, so a drift in `assemble()` or in the store breaks here rather than 40
minutes into a 900-cluster run.
"""
import random

import fakeredis
import pytest

from app.collector.healthchecks import run_health_checks
from app.store.base import SECTIONS
from app.store.redis_store import RedisStore
from scripts.synth_load import (
    build_profile,
    cluster_names,
    gather_facts,
    generate_document,
    parse_args,
    read_latencies,
    render_report,
    run_load,
)

# The sections that are lists on the collector document itself; `health_checks`
# comes from the health checks and `resource_status` is a dict.
DOCUMENT_SECTIONS = tuple(s for s in SECTIONS if s not in ("health_checks", "resource_status"))
SMALL = {"apps": 5, "scale": 0.01}


@pytest.fixture(scope="module")
def profile():
    return build_profile(seed=7, image_pool=200, app_pool=60, team_pool=6, **SMALL)


@pytest.fixture(scope="module")
def loaded(profile):
    client = fakeredis.FakeRedis()
    store = RedisStore(client, prefix="odl", ttl_seconds=0, snapshot_retention=10)
    names = cluster_names(2)
    stats = run_load(store, client, profile, names, hubs=1, seed=7, workers=1, progress_every=0)
    return store, client, names, stats


def test_document_has_every_section_and_scores(profile):
    doc = generate_document("ocp-00-00", random.Random("7:ocp-00-00"), profile)
    for section in DOCUMENT_SECTIONS:
        assert doc[section], f"section {section} is empty"
    assert doc["resource_status"], "resource_status is empty"
    assert doc["capacity"]["metrics_available"] is True
    assert doc["namespaces_application"] == SMALL["apps"]
    assert doc["nodes_total"] == len(doc["nodes"])

    checks, overall, score, counts = run_health_checks(
        doc, profile.supported_floor, profile.thresholds)
    assert checks
    assert overall in ("healthy", "warning", "critical")
    assert 0 <= score <= 100
    assert counts["passed"] + counts["warned"] + counts["failed"] == len(checks)


def test_rows_carry_the_fields_the_store_indexes(profile):
    doc = generate_document("ocp-00-01", random.Random("7:ocp-00-01"), profile)
    assert {"name", "ns_class", "app_name", "team"} <= set(doc["namespaces"][0])
    assert {"image", "registry", "repository", "tag"} <= set(doc["workload_images"][0])
    assert {"ref_kind", "ref_name", "via"} <= set(doc["workload_refs"][0])
    assert {"key", "kind", "api_group", "status", "summary"} <= set(doc["resources"][0])
    # Index members are joined on "|", so no generated name may contain one.
    for row in doc["namespaces"] + doc["nodes"]:
        assert "|" not in row["name"]


def test_load_persists_every_cluster_through_the_store(loaded):
    store, _client, names, stats = loaded
    assert stats.clusters == len(names)
    assert stats.compressed_bytes > 0
    assert store.cluster_names() == sorted(names)
    assert len(store.clusters()) == len(names)

    sections = store.sections(names[0], list(SECTIONS))
    for section in SECTIONS:
        assert sections[section], f"section {section} did not round-trip"
    assert store.namespaces(ns_class="application")
    assert store.pod_issue_counts()
    assert store.hubs()
    assert store.last_run()


def test_report_renders(loaded, profile):
    store, client, _names, stats = loaded
    args = parse_args(["--clusters", "2", "--apps", "5", "--scale", "0.01", "--no-http"])
    facts = gather_facts(store, client, profile, args, stats)
    facts["latencies"] = read_latencies(store, iterations=2, budget=5.0)
    facts["http"] = {"available": False, "reason": "not measured in tests"}
    report = render_report(facts)

    assert report.startswith("# Synthetic load")
    for heading in ("## Load", "## Redis memory", "### Memory by key class",
                    "## Read latency (store level)", "## Read latency (HTTP)"):
        assert heading in report, f"{heading} missing from the report"
    assert "Documents generated | 2" in report
