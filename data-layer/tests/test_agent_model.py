"""
The agent's model seam, and the Anthropic adapter behind it.

The loop consumes five internal events and knows nothing else about the model,
so this module is where the wire format is turned into that contract. What is
worth pinning is exactly the translation: which raw stream events produce an
internal event and which are silently structural, that a tool call's arguments
arrive as partial JSON and are only parsed at the end, and that usage is merged
from the two places the SDK reports it (the input side at message_start, the
output side at message_delta) rather than read off a final message streaming
never produces.

The client is replaced with a scripted stream, so nothing here needs
credentials or a network.
"""
from types import SimpleNamespace

import anthropic
import pytest

from app.agent import model as agent_model
from app.agent.config import agent_config
from app.llm import provider
from app.query import llm as query_llm
from app.query.errors import QueryUnavailable


# --------------------------------------------------------------------------- #
# SDK-shaped events
# --------------------------------------------------------------------------- #
def _message_start(**usage):
    return SimpleNamespace(type="message_start",
                           message=SimpleNamespace(usage=SimpleNamespace(**usage)))


def _text_block_start(index=0):
    return SimpleNamespace(type="content_block_start", index=index,
                           content_block=SimpleNamespace(type="text"))


def _text(delta, index=0):
    return SimpleNamespace(type="content_block_delta", index=index,
                           delta=SimpleNamespace(type="text_delta", text=delta))


def _tool_block_start(index, tool_id, name):
    return SimpleNamespace(type="content_block_start", index=index,
                           content_block=SimpleNamespace(type="tool_use", id=tool_id,
                                                         name=name))


def _json(partial, index):
    return SimpleNamespace(type="content_block_delta", index=index,
                           delta=SimpleNamespace(type="input_json_delta",
                                                 partial_json=partial))


def _block_stop(index):
    return SimpleNamespace(type="content_block_stop", index=index)


def _message_delta(stop_reason, **usage):
    return SimpleNamespace(type="message_delta",
                           delta=SimpleNamespace(stop_reason=stop_reason),
                           usage=SimpleNamespace(**usage))


class _Stream:
    def __init__(self, events, error=None):
        self.events = events
        self.error = error

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def __iter__(self):
        if self.error is not None:
            raise self.error
        return iter(self.events)


class _Messages:
    def __init__(self, events, error=None, raise_on_call=None):
        self.events = events
        self.error = error
        self.raise_on_call = raise_on_call
        self.calls = []

    def stream(self, **kwargs):
        self.calls.append(kwargs)
        if self.raise_on_call is not None:
            raise self.raise_on_call
        return _Stream(self.events, self.error)


@pytest.fixture
def scripted(monkeypatch):
    """A client whose stream yields whatever a test scripts."""
    def install(events, error=None, raise_on_call=None):
        messages = _Messages(events, error, raise_on_call)
        monkeypatch.setattr(query_llm, "_get_client",
                            lambda: SimpleNamespace(messages=messages))
        return messages

    return install


@pytest.fixture(autouse=True)
def no_injected_adapter():
    agent_model.set_model(None)
    yield
    agent_model.set_model(None)


# --------------------------------------------------------------------------- #
# the seam
# --------------------------------------------------------------------------- #
def test_no_adapter_is_injected_by_default():
    assert agent_model.injected() is False


def test_an_injected_adapter_runs_instead_of_the_provider(monkeypatch):
    def unexpected(*_a, **_k):
        raise AssertionError("the provider must not be reached while a model is set")

    monkeypatch.setattr(provider, "model", unexpected)
    agent_model.set_model(lambda system, tools, messages, max_tokens:
                          iter([("stop", "end_turn", {})]))
    assert agent_model.injected() is True
    assert list(agent_model.run_model([], [], [], 64)) == [("stop", "end_turn", {})]


def test_an_injected_adapter_needs_no_credentials():
    """A scripted model is the whole point of the seam: availability must not
    ask the provider whether a key exists."""
    agent_model.set_model(lambda *_a: iter(()))
    assert agent_model.availability() == (True, None)


def test_without_an_adapter_availability_is_the_provider_s_answer(monkeypatch):
    asked = []
    monkeypatch.setattr(provider, "availability",
                        lambda name: asked.append(name) or (False, "no key"))
    assert agent_model.availability() == (False, "no key")
    assert asked == [agent_config.model]


def test_without_an_adapter_the_provider_streams_the_turn(monkeypatch):
    seen = []
    monkeypatch.setattr(provider, "model",
                        lambda *args: seen.append(args) or iter([("stop", None, {})]))
    assert list(agent_model.run_model(["sys"], ["tool"], ["msg"], 128)) == [("stop", None, {})]
    assert seen == [(["sys"], ["tool"], ["msg"], 128)]


# --------------------------------------------------------------------------- #
# arguments, accumulated then parsed
# --------------------------------------------------------------------------- #
def test_a_tool_called_with_no_arguments_at_all_gets_an_empty_object():
    """The API sends no input_json_delta for a tool whose arguments are all
    optional, and `{}` is what the tool must then be called with."""
    assert agent_model._arguments("") == {}
    assert agent_model._arguments("   ") == {}


def test_partial_json_is_parsed_once_it_is_whole():
    assert agent_model._arguments('{"sql": "SELECT 1"}') == {"sql": "SELECT 1"}


def test_arguments_that_never_became_valid_json_are_reported_as_unparseable():
    """None, and not an exception: the loop answers the model with a tool
    error so it can try again."""
    assert agent_model._arguments('{"sql": "SELE') is None


def test_arguments_that_are_json_but_not_an_object_are_unparseable_too():
    assert agent_model._arguments("[1, 2]") is None
    assert agent_model._arguments('"just a string"') is None


# --------------------------------------------------------------------------- #
# usage, merged from the two places the SDK reports it
# --------------------------------------------------------------------------- #
def test_usage_merges_the_input_side_and_the_output_side():
    usage = {}
    agent_model._usage(usage, SimpleNamespace(input_tokens=120, output_tokens=0,
                                              cache_read_input_tokens=4096))
    agent_model._usage(usage, SimpleNamespace(output_tokens=42))
    assert usage == {"input_tokens": 120, "output_tokens": 42,
                     "cache_read_input_tokens": 4096}


def test_usage_fields_the_sdk_did_not_send_are_left_out():
    assert agent_model._usage({}, SimpleNamespace(output_tokens=None)) == {}
    assert agent_model._usage({}, object()) == {}


# --------------------------------------------------------------------------- #
# the adapter: raw stream -> the five internal events
# --------------------------------------------------------------------------- #
def test_a_turn_of_narration_and_one_tool_call_becomes_the_five_events(scripted):
    scripted([
        _message_start(input_tokens=120, output_tokens=0, cache_read_input_tokens=4096),
        _text_block_start(0),
        _text("Let me "),
        _text("check."),
        _block_stop(0),
        _tool_block_start(1, "toolu_1", "run_sql"),
        _json('{"sql": "SELECT ', 1),
        _json('1"}', 1),
        _block_stop(1),
        _message_delta("tool_use", output_tokens=42),
    ])
    assert list(agent_model.anthropic_model([], [], [], 1024)) == [
        ("text", "Let me "),
        ("text", "check."),
        ("tool_start", "toolu_1", "run_sql"),
        ("tool_args", "toolu_1", '{"sql": "SELECT '),
        ("tool_args", "toolu_1", '1"}'),
        ("tool_end", "toolu_1", {"sql": "SELECT 1"}),
        ("stop", "tool_use", {"input_tokens": 120, "output_tokens": 42,
                              "cache_read_input_tokens": 4096}),
    ]


def test_two_tool_calls_in_one_turn_keep_their_arguments_apart(scripted):
    """The blocks interleave by index on the wire; the ids must not."""
    scripted([
        _tool_block_start(0, "toolu_a", "run_sql"),
        _tool_block_start(1, "toolu_b", "add_panel"),
        _json('{"sql":', 0),
        _json('{"title":', 1),
        _json(' "SELECT 1"}', 0),
        _json(' "Nodes"}', 1),
        _block_stop(0),
        _block_stop(1),
        _message_delta("tool_use", output_tokens=9),
    ])
    events = list(agent_model.anthropic_model([], [], [], 1024))
    assert ("tool_end", "toolu_a", {"sql": "SELECT 1"}) in events
    assert ("tool_end", "toolu_b", {"title": "Nodes"}) in events


def test_a_tool_called_with_no_argument_deltas_ends_with_an_empty_object(scripted):
    scripted([
        _tool_block_start(0, "toolu_1", "list_clusters"),
        _block_stop(0),
        _message_delta("tool_use", output_tokens=3),
    ])
    assert list(agent_model.anthropic_model([], [], [], 1024)) == [
        ("tool_start", "toolu_1", "list_clusters"),
        ("tool_end", "toolu_1", {}),
        ("stop", "tool_use", {"output_tokens": 3}),
    ]


def test_arguments_that_did_not_parse_reach_the_loop_as_none(scripted):
    scripted([
        _tool_block_start(0, "toolu_1", "run_sql"),
        _json('{"sql": "SELE', 0),
        _block_stop(0),
        _message_delta("tool_use", output_tokens=3),
    ])
    events = list(agent_model.anthropic_model([], [], [], 1024))
    assert events[-2] == ("tool_end", "toolu_1", None)


def test_empty_text_deltas_and_unknown_events_produce_nothing(scripted):
    """The SDK emits structural and aggregate events the loop has no use for;
    forwarding them would show up as empty bubbles on the page."""
    scripted([
        _text_block_start(0),
        _text(""),
        SimpleNamespace(type="text"),            # the SDK's own aggregate event
        SimpleNamespace(type="message_stop"),
        _block_stop(0),
        _block_stop(7),                          # a block this adapter never opened
        _json("{}", 7),                          # a delta for one, likewise
        _message_delta("end_turn", output_tokens=1),
    ])
    assert list(agent_model.anthropic_model([], [], [], 1024)) == [
        ("stop", "end_turn", {"output_tokens": 1})]


def test_a_turn_that_reports_no_stop_reason_at_all_still_stops(scripted):
    scripted([_text("hello")])
    assert list(agent_model.anthropic_model([], [], [], 1024)) == [
        ("text", "hello"), ("stop", None, {})]


def test_a_later_message_delta_does_not_erase_the_stop_reason(scripted):
    scripted([
        _message_delta("max_tokens", output_tokens=4000),
        _message_delta(None, output_tokens=4096),
    ])
    assert list(agent_model.anthropic_model([], [], [], 1024))[-1] == (
        "stop", "max_tokens", {"output_tokens": 4096})


def test_the_request_carries_the_configured_model_effort_and_the_turn_s_budget(scripted):
    messages = scripted([_message_delta("end_turn", output_tokens=1)])
    system = [{"type": "text", "text": "you are"}]
    tools = [{"name": "run_sql"}]
    turn = [{"role": "user", "content": "hi"}]
    list(agent_model.anthropic_model(system, tools, turn, 777))

    sent = messages.calls[0]
    assert sent["model"] == agent_config.model
    assert sent["max_tokens"] == 777
    assert sent["system"] == system and sent["tools"] == tools and sent["messages"] == turn
    assert sent["output_config"] == {"effort": agent_config.effort}


# --------------------------------------------------------------------------- #
# failures, mapped exactly as the query plane maps them
# --------------------------------------------------------------------------- #
def test_a_rate_limited_stream_is_the_same_sentence_the_query_plane_serves(scripted):
    response = SimpleNamespace(status_code=429, headers={}, text="", request=None)
    scripted([], error=anthropic.RateLimitError("slow down", response=response, body=None))
    with pytest.raises(QueryUnavailable, match="rate limited"):
        list(agent_model.anthropic_model([], [], [], 1024))


def test_a_client_with_no_credentials_fails_before_the_first_event(scripted):
    scripted([], raise_on_call=TypeError("expected str, got NoneType"))
    with pytest.raises(QueryUnavailable, match="credentials"):
        list(agent_model.anthropic_model([], [], [], 1024))
