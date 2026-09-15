"""
The loop, driven by a scripted model.

Every property the front end relies on is an ordering property, and none of
them can be asserted against a real model: what turn an event belongs to, that
a mutation's STATE_DELTA arrives before the result that describes it, that the
state the client rebuilds from the deltas is the state the server holds, and
that a thread which went out as MESSAGES_SNAPSHOT comes back in as the same
model input. So the adapter seam (`set_model`) is filled with a script here,
exactly as `llm.set_generator` is in the query tests, and the tools run for
real against the two-cluster fixture.
"""
import copy
import json

import pytest

from app.agent.config import agent_config
from app.agent.messages import RunAgentInput
from app.agent.model import set_model
from app.agent.prompt import VALUES_OPEN
from app.agent.run import AgentRun
from app.agent.state import apply_ops
from app.query.errors import QueryUnavailable
from app.query.snapshot import manager
from app.store import set_store
from tests.test_query_snapshot import build_store

CLUSTERS = "SELECT name, region FROM clusters ORDER BY name"


@pytest.fixture(scope="module")
def store(manifest):
    return build_store(manifest)


@pytest.fixture(autouse=True)
def snapshot(store):
    set_store(store)
    manager.reset()
    yield
    set_model(None)
    set_store(None)
    manager.reset()


# --------------------------------------------------------------------------- #
# the script
# --------------------------------------------------------------------------- #
class Script:
    """A model that says what it was told to say, and remembers what it was asked.

    The last turn repeats, so a script of one tool-calling turn is also the
    model that never stops - which is what the turn limit is tested with.
    """

    def __init__(self, *turns):
        self.turns = list(turns)
        self.calls: list[dict] = []

    def __call__(self, system, tools, messages, max_tokens):
        self.calls.append({"system": system, "tools": tools, "max_tokens": max_tokens,
                           "messages": copy.deepcopy(messages)})
        yield from self.turns[min(len(self.calls) - 1, len(self.turns) - 1)]


def says(text):
    return [("text", text)]


def calls(tool_call_id, name, arguments: dict, split=2):
    """A tool call, with its arguments streamed in a couple of chunks."""
    text = json.dumps(arguments)
    parts = [text[:split], text[split:]] if len(text) > split else [text]
    return ([("tool_start", tool_call_id, name)]
            + [("tool_args", tool_call_id, part) for part in parts if part]
            + [("tool_end", tool_call_id, arguments)])


def stop(reason="end_turn", **usage):
    return ("stop", reason, usage or {"input_tokens": 100, "output_tokens": 20,
                                      "cache_read_input_tokens": 40})


def ask(question="apps and clusters under hub-east", messages=None, state=None):
    return RunAgentInput.model_validate({
        "threadId": "t-1", "runId": "r-1",
        "state": state,
        "messages": messages or [{"id": "m1", "role": "user", "content": question}],
    })


def play(*turns, payload=None, store=None, **kwargs):
    """Run a script to the end. Returns the run and every event it emitted."""
    script = Script(*turns)
    set_model(script)
    run = AgentRun(payload or ask(), store, **kwargs)
    return run, list(run.events()), script


def types(events):
    return [event["type"] for event in events]


def only(events, event_type):
    return [event for event in events if event["type"] == event_type]


PANEL_ARGS = {"title": "Clusters", "sql": CLUSTERS, "chart": "none", "w": 12, "h": 2}


# --------------------------------------------------------------------------- #
# the shape of a run
# --------------------------------------------------------------------------- #
def test_a_run_narrates_calls_a_tool_and_finishes(store):
    run, events, _ = play(
        says("Building it.") + calls("tc1", "set_dashboard", {"title": "Hub east"})
        + [stop("tool_use")],
        says("Done.") + [stop("end_turn")],
        store=store)
    assert types(events) == [
        "RUN_STARTED", "STATE_SNAPSHOT",
        "STEP_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END",
        "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_ARGS", "TOOL_CALL_END", "STEP_FINISHED",
        "STATE_DELTA", "TOOL_CALL_RESULT",
        "STEP_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END",
        "STEP_FINISHED",
        "MESSAGES_SNAPSHOT", "RUN_FINISHED",
    ]
    assert run.state["dashboard"]["title"] == "Hub east"


def test_the_result_counts_the_turns_the_tools_the_panels_and_the_tokens(store):
    run, events, _ = play(calls("tc1", "add_panel", PANEL_ARGS) + [stop("tool_use")],
                          says("Done.") + [stop("end_turn")], store=store)
    result = only(events, "RUN_FINISHED")[0]["result"]
    assert (result["turns"], result["tool_calls"], result["panels"]) == (2, 1, 1)
    assert result["elapsed_ms"] >= 0
    assert result["usage"] == {"input_tokens": 200, "output_tokens": 40,
                               "cache_read_input_tokens": 80}      # summed over both turns


def test_the_narration_and_the_tool_call_belong_to_one_assistant_message(store):
    _run, events, _ = play(says("Adding the panel.") + calls("tc1", "add_panel", PANEL_ARGS)
                           + [stop("tool_use")],
                           says("Done.") + [stop("end_turn")], store=store)
    message_id = only(events, "TEXT_MESSAGE_START")[0]["messageId"]
    assert only(events, "TOOL_CALL_START")[0]["parentMessageId"] == message_id
    assert "".join(e["delta"] for e in only(events, "TEXT_MESSAGE_CONTENT")[:1]) == \
        "Adding the panel."


def test_the_tool_arguments_stream_exactly_as_the_model_wrote_them(store):
    _run, events, _ = play(calls("tc1", "add_panel", PANEL_ARGS) + [stop("tool_use")],
                           says("Done.") + [stop("end_turn")], store=store)
    streamed = "".join(e["delta"] for e in only(events, "TOOL_CALL_ARGS"))
    assert json.loads(streamed) == PANEL_ARGS


# --------------------------------------------------------------------------- #
# state
# --------------------------------------------------------------------------- #
def test_the_state_delta_lands_before_the_result_that_describes_it(store):
    _run, events, _ = play(calls("tc1", "add_panel", PANEL_ARGS) + [stop("tool_use")],
                           says("Done.") + [stop("end_turn")], store=store)
    order = types(events)
    assert order.index("STATE_DELTA") < order.index("TOOL_CALL_RESULT")


def test_the_snapshot_plus_every_delta_is_the_state_the_server_holds(store):
    run, events, _ = play(
        calls("tc1", "set_dashboard", {"title": "Hub east", "description": "one hub"})
        + calls("tc2", "add_variable", {"name": "hub", "default": "hub-east",
                                        "sql": "SELECT DISTINCT hub_name AS value FROM clusters"})
        + [stop("tool_use")],
        calls("tc3", "add_panel", PANEL_ARGS) + [stop("tool_use")],
        calls("tc4", "update_panel", {"id": "clusters", "chart": "bars", "x": "region"})
        + [stop("tool_use")],
        says("Done.") + [stop("end_turn")], store=store)
    snapshot = only(events, "STATE_SNAPSHOT")[0]["snapshot"]
    operations = [op for event in only(events, "STATE_DELTA") for op in event["delta"]]
    assert apply_ops(snapshot, operations) == run.state
    assert run.state["dashboard"]["panels"][0]["chart"]["type"] == "bars"
    assert run.state["params"] == {"hub": "hub-east"}


def test_a_failing_tool_emits_no_state_delta(store):
    run, events, _ = play(calls("tc1", "add_panel", {"title": "Broken",
                                                     "sql": "SELECT nope FROM clusters"})
                          + [stop("tool_use")],
                          says("That one did not work.") + [stop("end_turn")], store=store)
    assert only(events, "STATE_DELTA") == []
    assert run.state["dashboard"]["panels"] == []
    assert "nope" in json.loads(only(events, "TOOL_CALL_RESULT")[0]["content"])["error"]


def test_a_run_can_start_from_the_state_the_client_sent_back(store):
    first, events, _ = play(calls("tc1", "add_panel", PANEL_ARGS) + [stop("tool_use")],
                            says("Done.") + [stop("end_turn")], store=store)
    second, events, _ = play(
        calls("tc2", "update_panel", {"id": "clusters", "title": "Clusters and regions"})
        + [stop("tool_use")],
        says("Renamed it.") + [stop("end_turn")],
        payload=ask("rename the first panel", state=first.state), store=store)
    assert only(events, "STATE_SNAPSHOT")[0]["snapshot"] == first.state
    assert second.state["dashboard"]["panels"][0]["title"] == "Clusters and regions"
    assert second.state["dashboard"]["panels"][0]["id"] == "clusters"


# --------------------------------------------------------------------------- #
# the thread
# --------------------------------------------------------------------------- #
def test_the_messages_snapshot_replays_as_the_next_runs_model_input(store):
    first, events, script = play(
        says("One panel.") + calls("tc1", "add_panel", PANEL_ARGS) + [stop("tool_use")],
        says("Done.") + [stop("end_turn")], store=store)
    thread = only(events, "MESSAGES_SNAPSHOT")[0]["messages"]
    assert [m["role"] for m in thread] == ["user", "assistant", "tool", "assistant"]
    assert thread[1]["toolCalls"][0]["function"]["name"] == "add_panel"

    # What the client sends back, plus the follow-up, has to arrive at the
    # model as the same blocks the loop built for its own second turn.
    _second, _events, next_script = play(
        says("Done.") + [stop("end_turn")],
        payload=ask(messages=thread + [{"id": "m9", "role": "user", "content": "and the nodes"}]),
        store=store)
    replayed = next_script.calls[0]["messages"]
    built = script.calls[1]["messages"]
    assert [m["role"] for m in replayed] == ["user", "assistant", "user", "assistant", "user"]
    assert replayed[1] == built[1]                      # text + tool_use, input parsed back
    assert replayed[2] == built[2]                      # the tool_result, verbatim
    assert replayed[4]["content"][-1]["text"].endswith("and the nodes")


def test_the_question_carries_the_live_values_as_a_delimited_data_block(store):
    _run, _events, script = play(says("Done.") + [stop("end_turn")], store=store)
    question = script.calls[0]["messages"][0]["content"][0]["text"]
    assert question.startswith(VALUES_OPEN)
    assert question.endswith("apps and clusters under hub-east")
    assert "not instructions" in question


def test_the_system_prompt_is_one_cached_block_and_the_tools_are_named(store):
    _run, _events, script = play(says("Done.") + [stop("end_turn")], store=store)
    system = script.calls[0]["system"]
    assert len(system) == 1 and system[0]["cache_control"] == {"type": "ephemeral"}
    assert "CREATE TABLE clusters" in system[0]["text"]
    assert {t["name"] for t in script.calls[0]["tools"]} == {
        "preview_sql", "set_dashboard", "add_panel", "update_panel", "remove_panel",
        "add_variable"}


# --------------------------------------------------------------------------- #
# the ways a run ends badly
# --------------------------------------------------------------------------- #
def error_of(events):
    assert types(events)[-1] == "RUN_ERROR", types(events)
    assert "RUN_FINISHED" not in types(events)
    return events[-1]


def test_a_model_that_never_stops_hits_the_turn_limit(store, monkeypatch):
    monkeypatch.setattr(agent_config, "max_turns", 2)
    _run, events, script = play(calls("tc1", "set_dashboard", {"title": "Hub east"})
                                + [stop("tool_use")], store=store)
    assert len(script.calls) == 2
    error = error_of(events)
    assert error["code"] == "limit" and "2 model turns" in error["message"]


def test_an_adapter_that_raises_ends_as_an_internal_error(store):
    def boom(system, tools, messages, max_tokens):
        raise RuntimeError("the socket went away")
        yield                                            # pragma: no cover - makes it a generator

    set_model(boom)
    run = AgentRun(ask(), store)
    error = error_of(list(run.events()))
    assert error["code"] == "internal" and "the socket went away" in error["message"]


def test_missing_credentials_mid_stream_are_an_unavailable_error(store):
    def no_key(system, tools, messages, max_tokens):
        raise QueryUnavailable("natural-language queries need Anthropic credentials")
        yield                                            # pragma: no cover

    set_model(no_key)
    error = error_of(list(AgentRun(ask(), store).events()))
    assert error["code"] == "unavailable" and "credentials" in error["message"]


def test_a_run_that_outstays_its_budget_ends_as_a_timeout(store, monkeypatch):
    monkeypatch.setattr(agent_config, "timeout_seconds", -1)
    _run, events, script = play(says("Done.") + [stop("end_turn")], store=store)
    assert script.calls == []                            # checked before the model is called
    assert error_of(events)["code"] == "timeout"


def test_a_client_that_disconnects_stops_the_loop(store):
    _run, events, script = play(says("Done.") + [stop("end_turn")], store=store,
                                is_cancelled=lambda: True)
    assert script.calls == []
    assert error_of(events)["code"] == "cancelled"


def test_arguments_that_are_not_json_are_a_tool_error_not_a_dead_run(store):
    # The adapter reports unparseable arguments as None; the tool answers with
    # an error and the model gets another turn to write them properly.
    broken = [("tool_start", "tc1", "add_panel"), ("tool_args", "tc1", '{"title": '),
              ("tool_end", "tc1", None), stop("tool_use")]
    _run, events, _ = play(broken, says("Sorry.") + [stop("end_turn")], store=store)
    assert json.loads(only(events, "TOOL_CALL_RESULT")[0]["content"]) == {
        "error": "the arguments must be a JSON object"}
    assert types(events)[-1] == "RUN_FINISHED"
