"""
The /api/query endpoints, over the same two-cluster fixture.

The SQL endpoint is tested for real; the ask endpoint is tested with the
generator swapped for a stub (`set_generator`), because what needs proving here
is the loop and the HTTP contract - that a rejected query is a 400, that a bad
first query is retried with the error fed back, that two failures come back as
a 422 carrying the SQL that failed, and that missing credentials are a 503.
Whether the model writes good SQL is a different question, and
`scripts/eval_ask.py` answers it against the live API.

The app under test is built here from the router alone: the router is the unit,
and a test that boots the whole application would wait for Redis and start the
collector.
"""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import query as query_api
from app.query.errors import QueryUnavailable
from app.query.llm import SqlPlan, set_generator
from app.query.snapshot import manager
from app.store import set_store
from tests.test_query_snapshot import build_store

GOOD_SQL = ("SELECT name, region, overall_status FROM clusters "
            "WHERE overall_status = 'critical' ORDER BY name")
BROKEN_SQL = "SELECT name, wrong_column FROM clusters"


@pytest.fixture(scope="module")
def store(manifest):
    return build_store(manifest)


@pytest.fixture(autouse=True)
def client(store):
    """A one-router app, the fixture store, and no leftover snapshot."""
    set_store(store)
    manager.reset()
    app = FastAPI()
    app.include_router(query_api.router)
    with TestClient(app) as test_client:
        yield test_client
    set_generator(None)
    set_store(None)
    manager.reset()


def plan(sql, explanation="Clusters that are critical.", assumptions=(), confidence=0.9):
    return SqlPlan(sql=sql, explanation=explanation, assumptions=list(assumptions),
                   confidence=confidence)


def generator_returning(*plans):
    """A stub generator that hands out the given plans, one per attempt."""
    remaining = list(plans)
    seen = []

    def generate(question, schema_text, error_feedback=None):
        seen.append({"question": question, "feedback": error_feedback,
                     "schema_text": schema_text})
        return remaining.pop(0)

    generate.seen = seen
    set_generator(generate)
    return generate


# --------------------------------------------------------------------------- #
# GET /schema
# --------------------------------------------------------------------------- #
def test_schema_describes_the_tables_and_the_live_snapshot(client):
    body = client.get("/api/query/schema").json()
    tables = {t["name"]: t for t in body["tables"]}
    assert "clusters" in tables and "workload_images" in tables
    assert all(c["description"] for c in tables["clusters"]["columns"])
    assert any("application is a namespace" in n for n in body["notes"])
    assert body["examples"] and body["examples"][0]["sql"].lstrip().startswith("SELECT")
    assert body["snapshot"]["rows"]["clusters"] == 2
    assert body["snapshot"]["generation"] >= 1
    assert body["limits"]["max_rows"] >= 1


# --------------------------------------------------------------------------- #
# POST /sql
# --------------------------------------------------------------------------- #
def test_sql_runs_and_returns_the_sql_that_ran(client):
    body = client.post("/api/query/sql", json={"sql": GOOD_SQL, "limit": 10}).json()
    assert body["columns"] == ["name", "region", "overall_status"]
    assert body["rows"] == [["ocp-west-1", "eu-west-1", "critical"]]
    assert body["row_count"] == 1 and body["truncated"] is False
    assert body["sql"].endswith("LIMIT 10")
    assert body["elapsed_ms"] >= 0 and body["generation"] >= 1


def test_sql_refuses_anything_but_a_select(client):
    response = client.post("/api/query/sql", json={"sql": "DROP TABLE clusters"})
    assert response.status_code == 400
    assert "only SELECT queries are allowed" in response.json()["detail"]


def test_sql_refuses_an_unknown_table_with_a_helpful_message(client):
    response = client.post("/api/query/sql", json={"sql": "SELECT * FROM users"})
    assert response.status_code == 400
    assert "unknown table 'users'" in response.json()["detail"]


def test_sql_reports_a_database_error_as_a_bad_request(client):
    response = client.post("/api/query/sql", json={"sql": BROKEN_SQL})
    assert response.status_code == 400
    assert "wrong_column" in response.json()["detail"]


def test_sql_requires_a_query(client):
    assert client.post("/api/query/sql", json={"sql": ""}).status_code == 422


# --------------------------------------------------------------------------- #
# POST /ask
# --------------------------------------------------------------------------- #
def test_ask_answers_with_the_sql_the_rows_and_the_reasoning(client):
    generate = generator_returning(plan(GOOD_SQL, assumptions=["'unhealthy' means critical"]))
    body = client.post("/api/query/ask",
                       json={"question": "Which clusters are critical?"}).json()

    assert body["question"] == "Which clusters are critical?"
    assert body["sql"].startswith("SELECT")
    assert body["explanation"] == "Clusters that are critical."
    assert body["assumptions"] == ["'unhealthy' means critical"]
    assert body["confidence"] == 0.9
    assert body["attempts"] == 1 and body["failed_attempts"] == []
    assert body["result"]["rows"] == [["ocp-west-1", "eu-west-1", "critical"]]
    # the semantic layer really was handed to the generator, and with it the
    # values the fleet actually uses (so the model spells literals correctly)
    assert "CREATE TABLE clusters" in generate.seen[0]["schema_text"]
    assert generate.seen[0]["feedback"] is None
    asked = generate.seen[0]["question"]
    assert asked.startswith("Which clusters are critical?")
    assert "clusters.region: eu-west-1, us-east-1" in asked
    assert "clusters.environment: prod" in asked


def test_ask_retries_once_with_the_error_fed_back(client):
    generate = generator_returning(plan(BROKEN_SQL), plan(GOOD_SQL))
    body = client.post("/api/query/ask",
                       json={"question": "Which clusters are critical?"}).json()

    assert body["attempts"] == 2
    assert body["result"]["row_count"] == 1
    assert [a["sql"] for a in body["failed_attempts"]] == [BROKEN_SQL]
    feedback = generate.seen[1]["feedback"]
    assert BROKEN_SQL in feedback and "wrong_column" in feedback


def test_ask_retries_a_query_the_guard_rejected(client):
    generate = generator_returning(plan("SELECT * FROM read_csv('/etc/passwd')"),
                                   plan(GOOD_SQL))
    body = client.post("/api/query/ask", json={"question": "Which clusters are critical?"}).json()
    assert body["attempts"] == 2
    assert "table functions are not allowed" in generate.seen[1]["feedback"]


def test_ask_gives_up_after_two_attempts_and_shows_what_it_tried(client):
    generator_returning(plan(BROKEN_SQL), plan(BROKEN_SQL))
    response = client.post("/api/query/ask", json={"question": "Which clusters are critical?"})
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["sql"] == BROKEN_SQL
    assert "wrong_column" in detail["error"]
    assert len(detail["attempts"]) == 2


def test_ask_is_unavailable_without_credentials(client):
    def no_credentials(question, schema_text, error_feedback=None):
        raise QueryUnavailable("natural-language queries need Anthropic credentials")

    set_generator(no_credentials)
    response = client.post("/api/query/ask", json={"question": "Which clusters are critical?"})
    assert response.status_code == 503
    assert "credentials" in response.json()["detail"]


def test_ask_requires_a_question(client):
    assert client.post("/api/query/ask", json={"question": ""}).status_code == 422


# --------------------------------------------------------------------------- #
# POST /refresh-snapshot
# --------------------------------------------------------------------------- #
def test_refresh_snapshot_rebuilds_and_reports_row_counts(client):
    before = client.get("/api/query/schema").json()["snapshot"]["generation"]
    body = client.post("/api/query/refresh-snapshot").json()["snapshot"]
    assert body["generation"] == before + 1
    assert body["rows"]["clusters"] == 2
    assert body["total_rows"] > 10
    assert body["built_at"]


def test_generate_sql_without_credentials_is_unavailable(monkeypatch):
    """No key, no token, no profile: the real generator must fail as 'unavailable',
    never as an unhandled error (SDK 1.x raises a plain TypeError at request time)."""
    from app.query import llm
    from app.query.errors import QueryUnavailable

    for var in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(llm, "_client", None)
    monkeypatch.setattr(llm, "_generator", None)
    with pytest.raises(QueryUnavailable):
        llm.generate_sql("which clusters are critical", "schema")
