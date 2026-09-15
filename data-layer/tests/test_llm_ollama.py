"""
The local provider, without a local model.

Everything here is a translation - Anthropic shapes in, Ollama shapes out, and
Ollama's chunks back into the loop's five events - so all of it can be proven
against a fake session, and none of it needs a daemon, a network or 13 GB of
weights. What a real gpt-oss actually answers is a different question, and
`scripts/eval_generate.py` and `scripts/eval_ask.py` answer it against a live
API.

The fake session is the seam: `ollama._session` is the one object the module
talks to the world through, so replacing it replaces the world.
"""
import importlib
import json
import os

import pytest
import requests
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.agent.config import agent_config
from app.agent.model import run_model, set_model
from app.api import agent as agent_api
from app.llm import ollama, provider
from app.llm.config import llm_config
from app.query import llm as query_llm
from app.query.errors import QueryUnavailable

PLAN = {"sql": "SELECT name FROM clusters", "explanation": "Every cluster.",
        "assumptions": [], "confidence": 0.8}


# --------------------------------------------------------------------------- #
# the fake daemon
# --------------------------------------------------------------------------- #
class Response:
    """Just enough of a requests.Response for this module to read."""

    def __init__(self, status=200, payload=None, text="", lines=()):
        self.status_code = status
        self._payload = payload
        self.text = text if text else (json.dumps(payload) if payload is not None else "")
        # Not materialised: a stream that fails halfway has to fail while it is
        # being read, not while it is being described.
        self._lines = lines

    def json(self):
        if self._payload is None:
            raise ValueError("not JSON")
        return self._payload

    def iter_lines(self):
        for line in self._lines:
            yield line if isinstance(line, bytes) else json.dumps(line).encode()


class Session:
    """A session that answers from a script and records what it was asked."""

    def __init__(self, post=None, get=None):
        self.posts: list[dict] = []
        self.gets: list[dict] = []
        self._post = post
        self._get = get

    def post(self, url, json=None, timeout=None, stream=False):
        self.posts.append({"url": url, "body": json, "timeout": timeout, "stream": stream})
        return _answer(self._post, url, json)

    def get(self, url, timeout=None):
        self.gets.append({"url": url, "timeout": timeout})
        return _answer(self._get, url, None)


def _answer(script, url, body):
    """The scripted answer for one call: a response, or the failure to raise."""
    if isinstance(script, dict):
        script = next((value for key, value in script.items() if key in url), None)
    if callable(script):
        script = script(url, body)
    if isinstance(script, Exception):
        raise script
    if script is None:
        raise AssertionError(f"the fake session was not told what to answer for {url}")
    return script


SHOWN = Response(payload={"capabilities": ["completion", "tools", "thinking"],
                          "details": {"family": "gptoss"}})


def session(**scripts) -> Session:
    """Install a fake session. `/api/show` answers like gpt-oss unless told otherwise."""
    post = scripts.pop("post", None)
    if isinstance(post, Response | Exception) or callable(post):
        post = {"/api/chat": post, "/api/show": SHOWN}
    fake = Session(post=post or {"/api/show": SHOWN}, get=scripts.pop("get", None))
    ollama._session = fake
    return fake


@pytest.fixture(autouse=True)
def fresh():
    """No session, no capability cache and no seams leak between tests."""
    ollama._session = None
    ollama._capabilities.clear()
    yield
    ollama._session = None
    ollama._capabilities.clear()
    query_llm.set_generator(None)
    set_model(None)


@pytest.fixture
def local(monkeypatch):
    """The data layer as it comes up with ODL_LLM_PROVIDER=ollama.

    Both planes' models follow the provider at import time, so a fixture that
    only flipped the provider would describe a process that cannot exist.
    """
    monkeypatch.setattr(llm_config, "provider", "ollama")
    monkeypatch.setattr(query_llm.query_config, "model", llm_config.ollama_model)
    monkeypatch.setattr(agent_config, "model", llm_config.ollama_model)
    return llm_config


def chunk(**fields) -> dict:
    return {"model": "gpt-oss:20b", "message": {"role": "assistant", **fields.pop("message", {})},
            **fields}


def done(reason="stop", prompt=100, output=20) -> dict:
    return {"model": "gpt-oss:20b", "message": {"role": "assistant", "content": ""},
            "done": True, "done_reason": reason,
            "prompt_eval_count": prompt, "eval_count": output}


# --------------------------------------------------------------------------- #
# messages: Anthropic shapes -> Ollama shapes
# --------------------------------------------------------------------------- #
SYSTEM = [{"type": "text", "text": "how to compose",
           "cache_control": {"type": "ephemeral"}}]


def test_the_system_blocks_become_one_message_without_the_cache_marker():
    blocks = [{"type": "text", "text": "how to compose", "cache_control": {"type": "ephemeral"}},
              {"type": "text", "text": "the schema"}]
    assert ollama.system_message(blocks) == "how to compose\n\nthe schema"
    messages = ollama.to_messages(blocks, [])
    assert messages == [{"role": "system", "content": "how to compose\n\nthe schema"}]


def test_a_thread_converts_and_a_tool_result_finds_the_name_of_its_call():
    """Ollama wants the tool's name on the result; Anthropic only carries the id."""
    messages = ollama.to_messages(SYSTEM, [
        {"role": "user", "content": [{"type": "text", "text": "apps under hub-east"}]},
        {"role": "assistant", "content": [
            {"type": "text", "text": "Building it."},
            {"type": "tool_use", "id": "tc1", "name": "add_panel",
             "input": {"title": "Clusters", "sql": "SELECT 1"}}]},
        {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "tc1", "content": '{"ok":true}'}]},
    ])
    assert messages[0]["role"] == "system"
    assert messages[1] == {"role": "user", "content": "apps under hub-east"}
    assert messages[2] == {"role": "assistant", "content": "Building it.",
                           "tool_calls": [{"id": "tc1", "function": {
                               "name": "add_panel",
                               "arguments": {"title": "Clusters", "sql": "SELECT 1"}}}]}
    assert messages[3] == {"role": "tool", "tool_call_id": "tc1", "tool_name": "add_panel",
                           "content": '{"ok":true}'}


def test_a_user_turn_carrying_results_and_text_becomes_the_results_then_the_text():
    """`prepend_to_last_user` puts the fleet values in the turn that also carries
    the previous turn's results, so both have to survive the conversion."""
    messages = ollama.to_messages([], [
        {"role": "assistant", "content": [
            {"type": "tool_use", "id": "a", "name": "preview_sql", "input": {}},
            {"type": "tool_use", "id": "b", "name": "add_panel", "input": {}}]},
        {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "a", "content": "rows"},
            {"type": "tool_result", "tool_use_id": "b", "content": "added"},
            {"type": "text", "text": "<fleet-values>\nprod\n</fleet-values>"}]},
    ])
    assert [m["role"] for m in messages] == ["assistant", "tool", "tool", "user"]
    assert [m["tool_name"] for m in messages[1:3]] == ["preview_sql", "add_panel"]
    assert messages[3]["content"].startswith("<fleet-values>")


def test_an_assistant_turn_with_no_text_still_carries_its_calls():
    messages = ollama.to_messages([], [
        {"role": "assistant",
         "content": [{"type": "tool_use", "id": "tc1", "name": "set_dashboard", "input": {}}]}])
    assert messages == [{"role": "assistant", "content": "",
                         "tool_calls": [{"id": "tc1", "function": {"name": "set_dashboard",
                                                                   "arguments": {}}}]}]


def test_a_result_that_is_not_a_string_still_arrives_as_one():
    messages = ollama.to_messages([], [
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "x",
                                      "content": [{"type": "text", "text": "two rows"}]}]}])
    assert messages[0]["content"] == "two rows"


def test_tools_convert_to_function_tools_with_the_schema_unchanged():
    schema = {"type": "object", "properties": {"sql": {"type": "string"}},
              "required": ["sql"], "additionalProperties": False}
    assert ollama.to_tools([{"name": "preview_sql", "description": "look", "input_schema": schema}
                            ]) == [{"type": "function",
                                    "function": {"name": "preview_sql", "description": "look",
                                                 "parameters": schema}}]


# --------------------------------------------------------------------------- #
# the stream: Ollama chunks -> the loop's five events
# --------------------------------------------------------------------------- #
def events_of(*chunks) -> list[tuple]:
    return list(ollama._events(json.dumps(c).encode() for c in chunks))


def test_text_chunks_stream_as_text_events_and_empty_ones_are_dropped():
    assert events_of(chunk(message={"content": "Buil"}),
                     chunk(message={"content": ""}),
                     chunk(message={"content": "ding."}),
                     done()) == [
        ("text", "Buil"), ("text", "ding."),
        ("stop", "end_turn", {"input_tokens": 100, "output_tokens": 20})]


def test_a_tool_call_becomes_start_args_and_end_with_the_arguments_parsed():
    events = events_of(
        chunk(message={"content": "", "tool_calls": [
            {"id": "call_abc", "function": {"index": 0, "name": "add_panel",
                                            "arguments": {"title": "Clusters"}}}]}),
        done())
    assert events[0] == ("tool_start", "call_abc", "add_panel")
    assert events[1] == ("tool_args", "call_abc", json.dumps({"title": "Clusters"}))
    assert events[2] == ("tool_end", "call_abc", {"title": "Clusters"})
    # a turn that called a tool is `tool_use`, or the loop would stop there
    assert events[3] == ("stop", "tool_use", {"input_tokens": 100, "output_tokens": 20})


def test_a_tool_call_without_an_id_gets_one_that_is_unique_in_the_turn():
    """Some models omit the id; the loop only matches within the turn."""
    events = events_of(
        chunk(message={"tool_calls": [
            {"function": {"name": "add_panel", "arguments": {"n": 1}}},
            {"function": {"name": "add_panel", "arguments": {"n": 2}}}]}),
        done())
    assert [e[1] for e in events if e[0] == "tool_start"] == ["call_1", "call_2"]
    assert [e[2] for e in events if e[0] == "tool_end"] == [{"n": 1}, {"n": 2}]


def test_arguments_that_arrive_as_a_json_string_are_parsed_and_junk_is_none():
    assert events_of(chunk(message={"tool_calls": [
        {"id": "a", "function": {"name": "t", "arguments": '{"x":1}'}}]}), done())[2] == (
        "tool_end", "a", {"x": 1})
    assert events_of(chunk(message={"tool_calls": [
        {"id": "b", "function": {"name": "t", "arguments": "not json"}}]}), done())[2] == (
        "tool_end", "b", None)


def test_thinking_is_dropped_rather_than_narrated():
    assert events_of(chunk(message={"thinking": "the user wants clusters", "content": ""}),
                     chunk(message={"content": "Done."}),
                     done()) == [("text", "Done."),
                                 ("stop", "end_turn", {"input_tokens": 100, "output_tokens": 20})]


def test_the_output_cap_is_reported_as_max_tokens():
    assert events_of(chunk(message={"content": "half a sen"}), done(reason="length"))[-1] == (
        "stop", "max_tokens", {"input_tokens": 100, "output_tokens": 20})


def test_a_tool_call_in_the_same_chunk_as_done_is_still_a_tool_call():
    """gpt-oss sends exactly this: one chunk carrying the call and `done`."""
    events = events_of({"message": {"role": "assistant", "content": "", "tool_calls": [
        {"id": "call_1", "function": {"name": "set_dashboard", "arguments": {"title": "x"}}}]},
        "done": True, "done_reason": "stop", "prompt_eval_count": 153, "eval_count": 40})
    assert [e[0] for e in events] == ["tool_start", "tool_args", "tool_end", "stop"]
    assert events[-1] == ("stop", "tool_use", {"input_tokens": 153, "output_tokens": 40})


def test_a_chunk_that_is_not_json_is_ignored_rather_than_ending_the_turn():
    assert list(ollama._events([b"", b"{not json}", json.dumps(done()).encode()])) == [
        ("stop", "end_turn", {"input_tokens": 100, "output_tokens": 20})]


def test_a_stream_sends_the_context_window_the_tools_and_the_thinking_effort(local):
    fake = session(post=Response(lines=[chunk(message={"content": "hi"}), done()]))
    events = list(ollama.model(SYSTEM, [{"name": "preview_sql", "description": "look",
                                         "input_schema": {"type": "object"}}],
                               [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
                               2048))
    body = fake.posts[-1]["body"]
    assert fake.posts[-1]["stream"] is True and body["stream"] is True
    assert body["options"] == {"num_ctx": llm_config.num_ctx, "num_predict": 2048}
    assert body["think"] == agent_config.effort
    assert body["tools"][0]["function"]["name"] == "preview_sql"
    assert [e[0] for e in events] == ["text", "stop"]


# --------------------------------------------------------------------------- #
# question -> SQL
# --------------------------------------------------------------------------- #
def test_generate_asks_for_the_plan_schema_and_parses_what_comes_back(local):
    fake = session(post=Response(payload={"message": {"content": json.dumps(PLAN)},
                                          "prompt_eval_count": 900, "eval_count": 60}))
    plan = ollama.generate("which clusters are critical", "CREATE TABLE clusters (...)")

    assert plan.sql == PLAN["sql"] and plan.confidence == 0.8
    body = fake.posts[-1]["body"]
    assert body["stream"] is False
    assert body["format"]["properties"].keys() >= {"sql", "explanation", "confidence"}
    assert body["messages"][0]["role"] == "system"
    assert "CREATE TABLE clusters" in body["messages"][0]["content"]
    assert body["messages"][1]["content"] == "Question: which clusters are critical"


def test_generate_feeds_the_previous_error_back_the_way_the_hosted_path_does(local):
    fake = session(post=Response(payload={"message": {"content": json.dumps(PLAN)}}))
    ollama.generate("q", "schema", "This SQL:\nSELECT 1\n\nfailed with:\nno such column")
    asked = fake.posts[-1]["body"]["messages"][1]["content"]
    assert asked.startswith("Question: q") and "no such column" in asked


@pytest.mark.parametrize("content", ["I cannot answer that.", '{"sql": 12}', ""])
def test_an_answer_that_is_not_a_plan_is_unavailable_not_a_crash(local, content):
    session(post=Response(payload={"message": {"content": content}}))
    with pytest.raises(QueryUnavailable, match="no valid SQL plan"):
        ollama.generate("q", "schema")


# --------------------------------------------------------------------------- #
# failures a person can act on
# --------------------------------------------------------------------------- #
def test_a_daemon_that_is_not_running_says_how_to_start_it(local):
    session(post=requests.exceptions.ConnectionError("refused"))
    with pytest.raises(QueryUnavailable, match=r"not reachable at http://localhost:11434 "
                                               r"\(start it with `ollama serve`\)"):
        ollama.generate("q", "schema")


def test_a_model_that_was_never_pulled_says_how_to_pull_it(local):
    session(post={"/api/chat": Response(404, payload={"error": 'model "gpt-oss:20b" not found'}),
                  "/api/show": SHOWN})
    with pytest.raises(QueryUnavailable, match=r"model gpt-oss:20b is not pulled "
                                               r"\(`ollama pull gpt-oss:20b`\)"):
        ollama.generate("q", "schema")


def test_a_turn_that_outstays_the_budget_says_how_long_it_waited(local):
    session(post=requests.exceptions.ReadTimeout("too slow"))
    with pytest.raises(QueryUnavailable,
                       match=f"did not answer within {llm_config.timeout_seconds:g} s"):
        ollama.generate("q", "schema")


def test_another_http_error_carries_the_status_and_what_ollama_said(local):
    session(post={"/api/chat": Response(500, payload={"error": "out of memory"}),
                  "/api/show": SHOWN})
    with pytest.raises(QueryUnavailable, match="Ollama returned 500: out of memory"):
        ollama.generate("q", "schema")


def test_a_404_that_is_not_about_a_model_stays_a_404(local):
    session(post={"/api/chat": Response(404, payload={"error": "unknown endpoint"}),
                  "/api/show": SHOWN})
    with pytest.raises(QueryUnavailable, match="Ollama returned 404: unknown endpoint"):
        ollama.generate("q", "schema")


def test_a_failure_halfway_through_a_stream_is_mapped_too(local):
    def lines():
        yield json.dumps(chunk(message={"content": "half "})).encode()
        raise requests.exceptions.ReadTimeout("gone")

    session(post=lambda url, body: Response(lines=lines()))
    stream = ollama.model(SYSTEM, [], [], 512)
    assert next(stream) == ("text", "half ")
    with pytest.raises(QueryUnavailable, match="did not answer within"):
        list(stream)


def test_a_model_that_cannot_think_is_not_sent_the_flag(local):
    session(post={"/api/chat": Response(payload={"message": {"content": json.dumps(PLAN)}}),
                  "/api/show": Response(payload={"capabilities": ["completion", "tools"],
                                                 "details": {"family": "llama"}})})
    ollama.generate("q", "schema")
    assert "think" not in ollama._session.posts[-1]["body"]


def test_a_thinking_model_that_is_not_gpt_oss_is_sent_a_boolean(local, monkeypatch):
    monkeypatch.setattr(query_llm.query_config, "model", "qwen3:4b")
    session(post={"/api/chat": Response(payload={"message": {"content": json.dumps(PLAN)}}),
                  "/api/show": Response(payload={"capabilities": ["tools", "thinking"],
                                                 "details": {"family": "qwen3"}})})
    ollama.generate("q", "schema")
    assert ollama._session.posts[-1]["body"]["think"] is True


def test_thinking_off_never_sends_the_flag_and_asks_nothing(local, monkeypatch):
    monkeypatch.setattr(llm_config, "think", "off")
    fake = session(post={"/api/chat": Response(payload={"message": {"content": json.dumps(PLAN)}})})
    ollama.generate("q", "schema")
    assert "think" not in fake.posts[-1]["body"]
    assert not any("/api/show" in post["url"] for post in fake.posts)


def test_the_capabilities_of_a_model_are_read_once_per_process(local):
    fake = session(post={"/api/chat": Response(payload={"message": {"content": json.dumps(PLAN)}}),
                         "/api/show": SHOWN})
    ollama.generate("q", "schema")
    ollama.generate("q", "schema")
    assert len([p for p in fake.posts if "/api/show" in p["url"]]) == 1


# --------------------------------------------------------------------------- #
# availability
# --------------------------------------------------------------------------- #
def tags(*names) -> Response:
    return Response(payload={"models": [{"name": name} for name in names]})


def test_availability_is_true_when_the_model_is_pulled(local):
    fake = session(get=tags("gpt-oss:20b", "llama3.2:3b"))
    assert ollama.availability("gpt-oss:20b") == (True, None)
    # a directory read, and never more than a couple of seconds of the page's time
    assert fake.gets[-1]["url"].endswith("/api/tags")
    assert fake.gets[-1]["timeout"] == ollama.PROBE_TIMEOUT


def test_availability_matches_a_name_with_and_without_the_latest_tag(local):
    session(get=tags("qwen3:4b", "nomic-embed-text:latest"))
    assert ollama.availability("nomic-embed-text") == (True, None)
    assert ollama.availability("qwen3:4b") == (True, None)
    ollama._session = Session(get=tags("mistral"))
    assert ollama.availability("mistral:latest") == (True, None)


def test_availability_names_the_model_that_is_missing(local):
    session(get=tags("llama3.2:3b"))
    assert ollama.availability("gpt-oss:20b") == (
        False, "model gpt-oss:20b is not pulled (`ollama pull gpt-oss:20b`)")


def test_availability_defaults_to_the_configured_model(local):
    session(get=tags("gpt-oss:20b"))
    assert ollama.availability() == (True, None)


def test_availability_says_the_daemon_is_down_rather_than_raising(local):
    session(get=requests.exceptions.ConnectionError("refused"))
    available, reason = ollama.availability()
    assert available is False and "start it with `ollama serve`" in reason


def test_availability_says_so_when_the_daemon_is_too_slow_to_answer(local):
    session(get=requests.exceptions.ReadTimeout("slow"))
    available, reason = ollama.availability()
    assert available is False and f"within {ollama.PROBE_TIMEOUT:g} s" in reason


def test_availability_reports_an_http_error_from_the_daemon(local):
    session(get=Response(503, payload={"error": "loading"}))
    assert ollama.availability() == (False, "Ollama returned 503: loading")


# --------------------------------------------------------------------------- #
# the provider switch
# --------------------------------------------------------------------------- #
def test_the_provider_chooses_the_backend_from_the_configuration(local):
    assert provider.backend() is ollama
    llm_config.provider = "anthropic"
    from app.llm import anthropic as anthropic_backend
    assert provider.backend() is anthropic_backend


def test_an_unknown_provider_falls_back_to_anthropic_rather_than_failing(monkeypatch):
    monkeypatch.setattr(llm_config, "provider", "llamafile")
    from app.llm import anthropic as anthropic_backend
    assert provider.backend() is anthropic_backend


def test_generate_sql_goes_to_the_local_model_and_the_seam_still_wins(local):
    session(post=Response(payload={"message": {"content": json.dumps(PLAN)}}))
    assert query_llm.generate_sql("q", "schema").sql == PLAN["sql"]

    query_llm.set_generator(lambda question, schema, feedback=None: query_llm.SqlPlan(
        sql="SELECT 1", explanation="scripted"))
    assert query_llm.generate_sql("q", "schema").explanation == "scripted"


def test_run_model_streams_from_the_local_model_and_the_seam_still_wins(local):
    session(post=Response(lines=[chunk(message={"content": "hi"}), done()]))
    assert [e[0] for e in run_model(SYSTEM, [], [], 512)] == ["text", "stop"]

    set_model(lambda system, tools, messages, max_tokens: iter([("text", "scripted"),
                                                                ("stop", "end_turn", {})]))
    assert list(run_model(SYSTEM, [], [], 512))[0] == ("text", "scripted")


def test_the_query_plane_reports_availability_through_the_provider(local):
    session(get=tags("gpt-oss:20b"))
    assert query_llm.available() is True
    ollama._session = Session(get=tags("llama3.2:3b"))
    assert query_llm.available() is False


def test_the_capability_endpoint_reports_the_local_model_and_the_reason(local):
    """GET /api/agent is what the Generate view reads before it offers to run."""
    app = FastAPI()
    app.include_router(agent_api.router)
    client = TestClient(app)

    session(get=tags("gpt-oss:20b"))
    payload = client.get("/api/agent").json()
    assert payload == {"available": True, "model": "gpt-oss:20b", "reason": None,
                       "limits": agent_config.as_limits()}

    ollama._session = Session(get=tags("llama3.2:3b"))
    payload = client.get("/api/agent").json()
    assert payload["available"] is False
    assert payload["reason"] == "model gpt-oss:20b is not pulled (`ollama pull gpt-oss:20b`)"
    assert client.post("/api/agent/run", json={
        "threadId": "t", "runId": "r",
        "messages": [{"id": "m", "role": "user", "content": "hi"}]}).status_code == 503


# --------------------------------------------------------------------------- #
# the defaults that follow the provider
# --------------------------------------------------------------------------- #
def test_the_defaults_follow_the_provider(monkeypatch):
    monkeypatch.setattr(llm_config, "provider", "ollama")
    assert llm_config.default_model() == llm_config.ollama_model
    assert llm_config.default_agent_timeout() == 600.0
    monkeypatch.setattr(llm_config, "provider", "anthropic")
    assert llm_config.default_model() == "claude-opus-5"
    assert llm_config.default_agent_timeout() == 150.0


SETTINGS = ("ODL_LLM_PROVIDER", "ODL_OLLAMA_MODEL", "ODL_QUERY_MODEL", "ODL_AGENT_MODEL",
            "ODL_AGENT_TIMEOUT_SECONDS")


def configured(**environment) -> dict:
    """The three config modules as they would come up with this environment.

    Rebuilt rather than mocked because these are import-time settings, and what
    is worth proving is exactly that: which value a process ends up with when it
    starts with these variables set and no others.
    """
    saved = {name: os.environ.pop(name, None) for name in SETTINGS}
    os.environ.update({k: v for k, v in environment.items() if v is not None})
    try:
        config = importlib.reload(importlib.import_module("app.llm.config"))
        query = importlib.reload(importlib.import_module("app.query.config"))
        agent = importlib.reload(importlib.import_module("app.agent.config"))
        return {"provider": config.llm_config.provider,
                "query_model": query.query_config.model,
                "agent_model": agent.agent_config.model,
                "agent_timeout": agent.agent_config.timeout_seconds}
    finally:
        for name in SETTINGS:
            os.environ.pop(name, None)
            if saved[name] is not None:
                os.environ[name] = saved[name]
        for name in ("app.llm.config", "app.query.config", "app.agent.config"):
            importlib.reload(importlib.import_module(name))


def test_with_ollama_both_planes_default_to_the_local_model_and_a_longer_run():
    assert configured(ODL_LLM_PROVIDER="ollama") == {
        "provider": "ollama", "query_model": "gpt-oss:20b", "agent_model": "gpt-oss:20b",
        "agent_timeout": 600.0}


def test_an_explicit_model_or_timeout_still_wins_over_the_provider_default():
    assert configured(ODL_LLM_PROVIDER="ollama", ODL_OLLAMA_MODEL="qwen3:4b",
                      ODL_AGENT_MODEL="llama3.2:3b",
                      ODL_AGENT_TIMEOUT_SECONDS="45") == {
        "provider": "ollama", "query_model": "qwen3:4b", "agent_model": "llama3.2:3b",
        "agent_timeout": 45.0}


def test_without_the_setting_nothing_about_the_hosted_path_changes():
    assert configured() == {"provider": "anthropic", "query_model": "claude-opus-5",
                            "agent_model": "claude-opus-5", "agent_timeout": 150.0}
