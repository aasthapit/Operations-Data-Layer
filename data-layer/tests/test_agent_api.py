"""
The endpoint: what happens before the stream, and what the stream looks like.

The split is the point of these tests. Anything that can still be a status code
happens first - no credentials is a 503, a body that is not a run is a 422 -
because once the response has begun there is no status left to send. After that
every outcome is an event, and the last event always says how the run ended.

The app is assembled from the routers, as in test_query_api.py: the routers are
the unit, and booting the whole application would wait for Redis and start the
collector.
"""
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.agent.model import set_model
from app.agent.state import apply_ops
from app.api import agent as agent_api
from app.api import dashboards as dashboards_api
from app.query import llm
from app.query.errors import QueryUnavailable
from app.query.snapshot import manager
from app.store import set_store
from tests.test_agent_run import PANEL_ARGS, Script, ask, calls, says, stop
from tests.test_query_snapshot import build_store


@pytest.fixture(scope="module")
def store(manifest):
    return build_store(manifest)


@pytest.fixture(autouse=True)
def client(store):
    set_store(store)
    manager.reset()
    app = FastAPI()
    app.include_router(agent_api.router)
    app.include_router(dashboards_api.router)
    with TestClient(app) as test_client:
        yield test_client
    set_model(None)
    set_store(None)
    manager.reset()
    for saved in list(store.dashboards()):
        store.dashboard_delete(saved.get("id", ""))


def body(**overrides) -> dict:
    payload = ask().model_dump(by_alias=True)
    payload.update(overrides)
    return payload


def stream(client, payload) -> list[dict]:
    """POST a run and parse every event out of the SSE body."""
    response = client.post("/api/agent/run", json=payload)
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["x-accel-buffering"] == "no"
    frames = [frame for frame in response.text.split("\n\n") if frame.strip()]
    assert all(frame.startswith("data: ") for frame in frames), frames[:2]
    return [json.loads(frame[len("data: "):]) for frame in frames]


# --------------------------------------------------------------------------- #
# GET /api/agent
# --------------------------------------------------------------------------- #
def test_the_capability_endpoint_says_what_a_run_is_bounded_by(client):
    set_model(Script(says("hi") + [stop()]))          # a stub model needs no credentials
    payload = client.get("/api/agent").json()
    assert payload["available"] is True and payload["reason"] is None
    assert payload["model"]
    assert set(payload["limits"]) == {"max_turns", "max_panels", "timeout_seconds"}


def test_without_credentials_the_endpoint_says_so_and_a_run_is_a_503(client, monkeypatch):
    def no_credentials():
        raise QueryUnavailable("natural-language queries need Anthropic credentials")

    monkeypatch.setattr(llm, "_get_client", no_credentials)
    payload = client.get("/api/agent").json()
    assert payload["available"] is False
    assert "credentials" in payload["reason"]

    response = client.post("/api/agent/run", json=body())
    assert response.status_code == 503
    assert "credentials" in response.json()["detail"]


# --------------------------------------------------------------------------- #
# the body
# --------------------------------------------------------------------------- #
def test_a_thread_that_does_not_end_with_a_user_message_is_a_422(client):
    set_model(Script(says("hi") + [stop()]))
    response = client.post("/api/agent/run", json=body(messages=[
        {"id": "m1", "role": "user", "content": "hello"},
        {"id": "m2", "role": "assistant", "content": "hi"}]))
    assert response.status_code == 422
    assert "user message" in response.json()["detail"]
    assert client.post("/api/agent/run", json=body(messages=[])).status_code == 422


def test_a_state_that_is_not_a_dashboard_is_a_422_naming_the_field(client):
    set_model(Script(says("hi") + [stop()]))
    response = client.post("/api/agent/run", json=body(
        state={"dashboard": {"id": "generated", "title": "x",
                             "panels": [{"id": "p", "title": "", "sql": ""}]}}))
    assert response.status_code == 422
    assert any("panels.0" in error["field"] for error in response.json()["detail"])


def test_a_body_that_is_not_a_run_input_is_a_422(client):
    set_model(Script(says("hi") + [stop()]))
    assert client.post("/api/agent/run", json={"messages": "not a list"}).status_code == 422


def test_unknown_keys_in_the_body_are_ignored(client):
    set_model(Script(says("Done.") + [stop()]))
    events = stream(client, body(forwardedProps={"anything": 1}, context=[{"x": 1}],
                                 tools=[], parentRunId=None, somethingElse="ignored"))
    assert events[-1]["type"] == "RUN_FINISHED"


# --------------------------------------------------------------------------- #
# the stream
# --------------------------------------------------------------------------- #
def test_a_whole_run_streams_as_server_sent_events(client):
    set_model(Script(
        says("Building it.")
        + calls("tc1", "set_dashboard", {"title": "Hub east", "description": "one hub"})
        + [stop("tool_use")],
        calls("tc2", "add_panel", PANEL_ARGS) + [stop("tool_use")],
        says("Two panels, one hub.") + [stop("end_turn")]))
    events = stream(client, body())
    assert [e["type"] for e in events][:2] == ["RUN_STARTED", "STATE_SNAPSHOT"]
    assert events[0]["runId"] == "r-1" and events[0]["threadId"] == "t-1"
    assert events[-1]["type"] == "RUN_FINISHED"
    assert events[-1]["result"]["panels"] == 1
    assert [e["type"] for e in events].count("STATE_DELTA") == 2


def test_what_the_agent_built_is_a_dashboard_the_dashboards_api_accepts(client):
    """The point of composing from the existing vocabulary: it is saveable."""
    set_model(Script(
        calls("tc1", "set_dashboard", {"title": "Hub east"})
        + calls("tc2", "add_panel", PANEL_ARGS) + [stop("tool_use")],
        says("Done.") + [stop("end_turn")]))
    events = stream(client, body())
    snapshot = next(e for e in events if e["type"] == "STATE_SNAPSHOT")["snapshot"]
    state = snapshot
    for event in events:
        if event["type"] == "STATE_DELTA":
            state = apply_ops(state, event["delta"])

    saved = client.put("/api/dashboards/from-the-agent", json=state["dashboard"])
    assert saved.status_code == 200, saved.text
    run = client.post("/api/dashboards/from-the-agent/run", json={"params": state["params"]})
    assert run.status_code == 200
    assert run.json()["results"]["clusters"]["row_count"] == 2


def test_a_failure_after_the_headers_is_the_last_event_not_a_dead_stream(client):
    def boom(system, tools, messages, max_tokens):
        raise RuntimeError("the model went away")
        yield                                            # pragma: no cover

    set_model(boom)
    events = stream(client, body())
    assert events[-1]["type"] == "RUN_ERROR"
    assert events[-1]["code"] == "internal"
