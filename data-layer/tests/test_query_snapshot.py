"""
The DuckDB snapshot, built from a fake-Redis store holding two real clusters.

The fixture goes the whole way round - raw Kubernetes objects, `assemble()`,
the health checks, `RedisStore.persist_cluster` - so what the snapshot loads is
exactly what a sweep writes, not a hand-made row. Everything else in this file
then asks the questions of it that the feature exists to answer:
`golden_questions.yaml` holds the reference SQL, and each entry states what it
must return.

`build_store()` is also imported by test_query_api.py.
"""
import base64
import os
from datetime import UTC, datetime, timedelta

import pytest
import yaml

from app.collector.collect import assemble
from app.collector.healthchecks import run_health_checks
from app.query import schema as query_schema
from app.query.config import query_config
from app.query.errors import QueryTimeout
from app.query.guard import validate
from app.query.service import run_sql
from app.query.snapshot import build, live_values, manager, render_live_values
from app.store.redis_store import RedisStore
from tests.conftest import make_cert_pem
from tests.test_collect import _dep, _node, _ns
from tests.test_parsers import NOW, _pod

GOLDEN_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "golden_questions.yaml")
SUPPORTED_FLOOR = "4.15.0"


# --------------------------------------------------------------------------- #
# the fixture fleet
# --------------------------------------------------------------------------- #
def _operator(name, version, degraded=False, message=""):
    conditions = [{"type": "Available", "status": "True"},
                  {"type": "Degraded", "status": "True" if degraded else "False",
                   "message": message}]
    return {"metadata": {"name": name},
            "status": {"conditions": conditions,
                       "versions": [{"name": "operator", "version": version}]}}


def _csv(package, version, namespace="openshift-operators", phase="Succeeded"):
    """A ClusterServiceVersion as OLM writes it (package comes from the label)."""
    return {"metadata": {"name": f"{package}.v{version}", "namespace": namespace,
                         "labels": {f"operators.coreos.com/{package}.{namespace}": ""}},
            "spec": {"displayName": "Elasticsearch Operator", "version": version,
                     "provider": {"name": "Red Hat"}},
            "status": {"phase": phase}}


def _tls_secret(name, namespace, days):
    pem, key = make_cert_pem(cn=f"{name}.example.com", days=days)
    return {"metadata": {"name": name, "namespace": namespace},
            "type": "kubernetes.io/tls",
            "data": {"tls.crt": base64.b64encode(pem).decode(),
                     "tls.key": base64.b64encode(key).decode()}}


def _quota(name, namespace, cpu_hard, cpu_used):
    return {"metadata": {"name": name, "namespace": namespace},
            "spec": {"hard": {"cpu": cpu_hard}},
            "status": {"hard": {"cpu": cpu_hard, "memory": "20Gi"},
                       "used": {"cpu": cpu_used, "memory": "8Gi"}}}


def _east_raw():
    """us-east-1, on 4.16.7, healthy platform, one expiring certificate."""
    return {
        "clusterversion": {"spec": {"channel": "stable-4.16"},
                           "status": {"desired": {"version": "4.16.7"},
                                      "history": [{"state": "Completed", "version": "4.16.7"}],
                                      "conditions": []}},
        "infrastructure": {"status": {"platform": "AWS",
                                      "apiServerURL": "https://api.ocp-east-1.example.com:6443",
                                      "infrastructureName": "ocp-east-1-abc"}},
        "network_config": {"status": {"networkType": "OVNKubernetes"}},
        "ingress_config": {"spec": {"domain": "apps.ocp-east-1.example.com"}},
        "clusteroperators": [_operator("ingress", "4.16.7"),
                             _operator("authentication", "4.16.7")],
        "nodes": [_node("east-1"), _node("east-2")],
        "node_metrics": [{"metadata": {"name": "east-1"}, "usage": {"cpu": "2", "memory": "8Gi"}},
                         {"metadata": {"name": "east-2"}, "usage": {"cpu": "1", "memory": "4Gi"}}],
        "namespaces": [_ns("payments", {"odl.io/team": "payments", "odl.io/tier": "critical"}),
                       _ns("risk"),
                       _ns("openshift-monitoring")],
        "pods": [_pod("api-1", "payments"), _pod("api-2", "payments"),
                 _pod("web-1", "payments"),
                 _pod("scorer-1", "risk", waiting="CrashLoopBackOff", restarts=9,
                      owner=("ReplicaSet", "scorer-abc"), hash_="abc"),
                 _pod("prom-1", "openshift-monitoring")],
        "pod_metrics": [{"metadata": {"namespace": "payments"},
                         "containers": [{"usage": {"cpu": "1200m", "memory": "2Gi"}}]},
                        {"metadata": {"namespace": "risk"},
                         "containers": [{"usage": {"cpu": "300m", "memory": "512Mi"}}]}],
        "deployments": [
            _dep("api", "payments"),
            _dep("web", "payments", image="docker.io/library/nginx:1.19"),
            _dep("scorer", "risk", ready=0,
                 labels={"odl.io/team": "risk", "odl.io/app": "fraud"}),
        ],
        "secrets": [_tls_secret("api-tls", "payments", days=10)],
        "resourcequotas": [_quota("payments-quota", "payments", "10", "9.5")],
        "clusterserviceversions": [_csv("elasticsearch-operator", "5.8.13")],
    }


def _west_raw():
    """eu-west-1, still on 4.15.30, ingress degraded, no pod metrics."""
    return {
        "clusterversion": {"spec": {"channel": "stable-4.15"},
                           "status": {"desired": {"version": "4.15.30"},
                                      "history": [{"state": "Completed", "version": "4.15.30"}],
                                      "conditions": []}},
        "infrastructure": {"status": {"platform": "AWS",
                                      "apiServerURL": "https://api.ocp-west-1.example.com:6443",
                                      "infrastructureName": "ocp-west-1-def"}},
        "network_config": {"status": {"networkType": "OVNKubernetes"}},
        "ingress_config": {"spec": {"domain": "apps.ocp-west-1.example.com"}},
        "clusteroperators": [
            _operator("ingress", "4.15.30", degraded=True,
                      message="1 of 2 router replicas are not available"),
            _operator("authentication", "4.15.30"),
        ],
        "nodes": [_node("west-1")],
        "node_metrics": [{"metadata": {"name": "west-1"}, "usage": {"cpu": "1", "memory": "3Gi"}}],
        "namespaces": [_ns("checkout", {"odl.io/team": "payments", "odl.io/tier": "standard"}),
                       _ns("openshift-monitoring")],
        "pods": [_pod("edge-1", "checkout", node="west-1"),
                 _pod("prom-1", "openshift-monitoring", node="west-1")],
        "deployments": [_dep("edge", "checkout", image="docker.io/library/nginx:1.19")],
        "clusterserviceversions": [_csv("elasticsearch-operator", "5.8.1")],
    }


def _persist(store, manifest, hub, meta, raw, unavailable=()):
    status = {key: {"status": "collected", "count": len(raw[key]) if isinstance(raw[key], list) else 1,
                    "duration_ms": 3, "error": None}
              for key in raw}
    for key in unavailable:
        status[key] = {"status": "unavailable", "count": 0, "duration_ms": 1,
                       "error": "the server could not find the requested resource"}
    doc = assemble(meta, raw, status, manifest, NOW)
    checks, overall, score, counts = run_health_checks(
        doc, SUPPORTED_FLOOR, manifest.describe()["thresholds"])
    store.persist_cluster(hub, doc, checks, overall, score, counts)
    return doc


def build_store(manifest):
    """A fake-Redis store holding one full sweep of a two-cluster fleet."""
    import fakeredis

    store = RedisStore(fakeredis.FakeRedis(), prefix="odl", snapshot_retention=50)
    run_id = store.begin_run("test")
    now = datetime.now(UTC)
    store.upsert_hub("hub-east", region="us-east-1", datacenter="dc-east-1",
                     reachable=True, managed_count=1, last_synced=now)
    store.upsert_hub("hub-west", region="eu-west-1", datacenter="dc-west-1",
                     reachable=True, managed_count=1, last_synced=now)

    _persist(store, manifest, "hub-east", {
        "name": "ocp-east-1", "region": "us-east-1", "datacenter": "dc-east-1",
        "environment": "prod", "cloud": "aws", "vendor": "OpenShift",
        "managed_available": True}, _east_raw())
    _persist(store, manifest, "hub-west", {
        "name": "ocp-west-1", "region": "eu-west-1", "datacenter": "dc-west-1",
        "environment": "prod", "cloud": "aws", "vendor": "OpenShift",
        "managed_available": True}, _west_raw(), unavailable=("routes",))

    store.finalize_sweep()
    store.finish_run(run_id, finished_at=datetime.now(UTC) + timedelta(seconds=2),
                     duration_ms=2000, hubs_total=2, clusters_total=2,
                     clusters_ok=2, clusters_failed=0)
    return store


@pytest.fixture(scope="module")
def store(manifest):
    return build_store(manifest)


@pytest.fixture(autouse=True)
def _fresh_snapshot():
    """The snapshot manager is process-wide; never inherit one across tests."""
    manager.invalidate()
    yield
    manager.invalidate()


@pytest.fixture
def conn(store):
    connection, _counts, _ms = build(store)
    yield connection
    connection.close()


def rows(conn, sql):
    cursor = conn.cursor()
    try:
        cursor.execute(sql)
        columns = [d[0] for d in cursor.description]
        return [dict(zip(columns, row, strict=True)) for row in cursor.fetchall()]
    finally:
        cursor.close()


# --------------------------------------------------------------------------- #
# the build
# --------------------------------------------------------------------------- #
def test_every_schema_table_exists_and_is_loaded(store):
    _conn, counts, elapsed = build(store)
    assert set(counts) == {t.name for t in query_schema.TABLES}
    assert counts["clusters"] == 2
    assert counts["hubs"] == 2
    assert counts["namespaces"] == 5          # 3 east + 2 west
    assert counts["cluster_operators"] == 4
    assert counts["health_snapshots"] == 2    # one sweep, two clusters
    assert counts["collection_runs"] == 1
    assert counts["workload_images"] == 4
    assert counts["health_checks"] > 0
    assert counts["resource_status"] > 0
    assert elapsed >= 0


def test_types_survive_the_round_trip(conn):
    cluster = rows(conn, "SELECT * FROM clusters WHERE name = 'ocp-east-1'")[0]
    assert cluster["ocp_version"] == "4.16.7"                 # VARCHAR
    assert cluster["nodes_total"] == 2                        # INTEGER
    assert cluster["cpu_allocatable"] == 8.0                  # DOUBLE
    assert cluster["memory_allocatable"] == 32 * 1024 ** 3    # BIGINT
    assert cluster["metrics_available"] is True               # BOOLEAN
    assert isinstance(cluster["last_synced"], datetime)       # TIMESTAMP
    assert cluster["last_synced"].tzinfo is None              # naive UTC
    assert cluster["reachable"] is True
    # JSON columns are queryable as JSON, not as text
    assert rows(conn, "SELECT json_extract_string(summary, '$.package') AS p FROM resources "
                      "WHERE key = 'clusterserviceversions' AND cluster_name = 'ocp-east-1'"
                )[0]["p"] == "elasticsearch-operator"
    assert rows(conn, "SELECT json_array_length(cluster_network) AS n FROM clusters "
                      "WHERE name = 'ocp-east-1'")[0]["n"] is not None


def test_a_null_column_stays_null(conn):
    """The west cluster has no pod metrics, so its namespace usage is unknown."""
    west = rows(conn, "SELECT name, cpu_usage FROM namespaces "
                      "WHERE cluster_name = 'ocp-west-1' AND name = 'checkout'")[0]
    assert west["cpu_usage"] is None


def test_timestamps_are_comparable_with_now(conn):
    expiring = rows(conn, "SELECT name, expires_at FROM resources "
                          "WHERE expires_at IS NOT NULL "
                          "AND expires_at BETWEEN now() AND now() + INTERVAL 30 DAY")
    assert [r["name"] for r in expiring] == ["api-tls"]


def test_cross_cluster_join_is_what_redis_cannot_do(conn):
    """The point of the snapshot: one query over both clusters."""
    found = rows(conn, """
        SELECT ns.team, count(DISTINCT wi.cluster_name) AS clusters
        FROM workload_images AS wi
        JOIN namespaces AS ns
          ON ns.cluster_name = wi.cluster_name AND ns.name = wi.namespace
        WHERE wi.image ILIKE '%nginx%'
        GROUP BY ns.team
    """)
    assert found == [{"team": "payments", "clusters": 2}]


def test_snapshot_is_cached_and_rebuilt_on_invalidate(store):
    first = manager.get(store)
    assert manager.get(store) is first
    generation = manager.info().generation
    manager.invalidate()
    assert manager.get(store) is not first
    assert manager.info().generation == generation + 1
    assert manager.info().row_counts["clusters"] == 2
    assert manager.info().built_at is not None


def test_live_values_come_from_the_data(conn):
    """The model should not have to guess whether it is 'prod' or 'production'."""
    values = live_values(conn)
    assert values["clusters.region"] == ["eu-west-1", "us-east-1"]
    assert values["clusters.environment"] == ["prod"]
    assert values["clusters.ocp_version"] == ["4.15.30", "4.16.7"]
    assert values["namespaces.team"] == ["payments", "risk"]
    assert "resourcequotas" in values["resources.key"]
    assert "docker.io" in values["workload_images.registry"]

    rendered = render_live_values(values)
    assert rendered.startswith("Values present in the current snapshot")
    assert "- clusters.environment: prod" in rendered


def test_live_values_are_computed_once_per_build(store):
    first = manager.live_values(store)
    assert manager.live_values(store) is first
    manager.invalidate()
    assert manager.live_values(store) is not first


def test_run_sql_caps_rows_and_reports_the_sql(store):
    result = run_sql("SELECT name FROM clusters ORDER BY name", limit=1, store=store)
    assert result.sql.endswith("LIMIT 1")
    assert result.row_count == 1 and result.truncated is True
    assert result.columns == ["name"]
    assert result.rows == [["ocp-east-1"]]
    assert result.generation == manager.info().generation


def test_a_runaway_query_is_interrupted_and_the_snapshot_survives(store, monkeypatch):
    """A LIMIT does not bound a recursive CTE; the wall clock does."""
    monkeypatch.setattr(query_config, "timeout_seconds", 0.3)
    runaway = ("WITH RECURSIVE counter(n) AS ("
               "  SELECT 1 UNION ALL SELECT n + 1 FROM counter WHERE n < 2000000000"
               ") SELECT count(*) FROM counter")
    with pytest.raises(QueryTimeout) as excinfo:
        run_sql(runaway, store=store)
    assert "cancelled" in str(excinfo.value)
    assert run_sql("SELECT count(*) FROM clusters", store=store).rows == [[2]]


def test_run_sql_serialises_timestamps(store):
    result = run_sql("SELECT name, last_synced FROM clusters ORDER BY name", store=store)
    assert isinstance(result.rows[0][1], str)       # ISO 8601, ready for JSON


# --------------------------------------------------------------------------- #
# golden questions
# --------------------------------------------------------------------------- #
def load_golden() -> list[dict]:
    with open(GOLDEN_PATH) as f:
        return yaml.safe_load(f)


GOLDEN = load_golden()


def _matches(row: dict, wanted: dict) -> bool:
    for column, value in wanted.items():
        actual = row.get(column)
        if isinstance(value, float) or isinstance(actual, float):
            if actual is None or abs(float(actual) - float(value)) > 1e-6:
                return False
        elif actual != value:
            return False
    return True


def check_expectations(entry: dict, result_rows: list[dict]) -> list[str]:
    """Every way a golden answer can be wrong, as a list of messages."""
    expect = entry.get("expect") or {}
    problems = []
    if "row_count" in expect and len(result_rows) != expect["row_count"]:
        problems.append(f"expected {expect['row_count']} rows, got {len(result_rows)}")
    if "min_rows" in expect and len(result_rows) < expect["min_rows"]:
        problems.append(f"expected at least {expect['min_rows']} rows, got {len(result_rows)}")
    if "columns" in expect:
        present = set(result_rows[0]) if result_rows else set()
        missing = [c for c in expect["columns"] if c not in present]
        if missing:
            problems.append(f"missing columns: {', '.join(missing)}")
    wanted = expect.get("contains")
    if wanted is not None:
        for want in (wanted if isinstance(wanted, list) else [wanted]):
            if not any(_matches(row, want) for row in result_rows):
                problems.append(f"no row matches {want}")
    return problems


def test_golden_file_is_well_formed():
    assert GOLDEN, "golden_questions.yaml is empty"
    ids = [e["id"] for e in GOLDEN]
    assert len(ids) == len(set(ids)), "duplicate golden question ids"
    for entry in GOLDEN:
        assert entry.get("question", "").strip(), f"{entry['id']}: no question"
        assert entry.get("sql", "").strip(), f"{entry['id']}: no sql"
        assert entry.get("expect"), f"{entry['id']}: no expectation"


@pytest.mark.parametrize("entry", GOLDEN, ids=[e["id"] for e in GOLDEN])
def test_golden_question(entry, conn):
    sql = validate(entry["sql"], 500)          # the guard must accept the reference SQL
    problems = check_expectations(entry, rows(conn, sql))
    assert not problems, f"{entry['id']}: " + "; ".join(problems)


def test_the_prompt_ddl_is_real_ddl():
    """What the model reads must be executable, not prose shaped like SQL."""
    import duckdb

    connection = duckdb.connect()
    try:
        connection.execute(query_schema.ddl())
        created = {row[0] for row in connection.execute("SHOW TABLES").fetchall()}
    finally:
        connection.close()
    assert created == {t.name for t in query_schema.TABLES}


def test_schema_examples_are_valid_sql(conn):
    """The few-shot examples in the prompt must run against the real schema."""
    for example in query_schema.EXAMPLES:
        sql = validate(example.sql, 50)
        rows(conn, sql)                        # raises if a column does not exist
