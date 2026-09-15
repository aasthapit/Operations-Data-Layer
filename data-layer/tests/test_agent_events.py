"""
The wire format and the shared state: the two things the browser depends on.

Field names are the contract here. A renamed key in `events.py` is not a
refactor, it is a client that silently stops rendering, so every event is
asserted by name and the SSE framing is asserted as text. The patch applier is
tested beside them because the same property ties the two together: the state
the browser reconstructs from STATE_SNAPSHOT plus the STATE_DELTAs has to be
the state the server holds.
"""
import json

import pytest

from app.agent import events
from app.agent.state import (
    EMPTY_DASHBOARD,
    PatchError,
    apply_ops,
    empty_state,
    normalise_state,
)
from app.query.dashboards import DashboardInvalid

PANEL = {"id": "clusters", "title": "Clusters", "sql": "SELECT name FROM clusters",
         "description": None, "chart": {"type": "auto", "x": "", "y": [], "series": None,
                                        "stack": False}, "w": 6, "h": 2, "limit": None}


def fields(event: dict) -> set:
    """The event's own fields: everything but the envelope."""
    return set(event) - {"type", "timestamp"}


# --------------------------------------------------------------------------- #
# the events
# --------------------------------------------------------------------------- #
def test_every_event_carries_its_type_and_a_millisecond_timestamp():
    event = events.run_started("t-1", "r-1")
    assert event["type"] == "RUN_STARTED"
    assert isinstance(event["timestamp"], int)
    assert event["timestamp"] > 1_700_000_000_000      # ms, not seconds


def test_the_run_events_use_the_names_the_client_reads():
    assert fields(events.run_started("t-1", "r-1")) == {"threadId", "runId"}
    finished = events.run_finished("t-1", "r-1", {"turns": 2})
    assert fields(finished) == {"threadId", "runId", "result"}
    assert finished["result"] == {"turns": 2}
    assert fields(events.step_started("model")) == {"stepName"}
    assert events.step_finished("model")["stepName"] == "model"


def test_a_run_error_carries_a_code_from_the_closed_set():
    error = events.run_error("no credentials", "unavailable")
    assert (error["message"], error["code"]) == ("no credentials", "unavailable")
    with pytest.raises(ValueError):
        events.run_error("something", "oops")


def test_the_message_events_use_camel_case_ids():
    assert fields(events.text_message_start("m-1")) == {"messageId", "role"}
    assert events.text_message_start("m-1")["role"] == "assistant"
    assert fields(events.text_message_content("m-1", "hi")) == {"messageId", "delta"}
    assert fields(events.text_message_end("m-1")) == {"messageId"}
    snapshot = events.messages_snapshot([{"id": "m-1", "role": "user", "content": "hi"}])
    assert snapshot["messages"][0]["role"] == "user"


def test_an_empty_delta_is_not_an_event():
    # A client that renders every delta would draw an empty bubble; the loop
    # must not emit one, so the builder refuses.
    with pytest.raises(ValueError):
        events.text_message_content("m-1", "")
    with pytest.raises(ValueError):
        events.tool_call_args("tc-1", "")


def test_the_tool_call_events_use_the_names_the_client_reads():
    assert fields(events.tool_call_start("tc-1", "add_panel", "m-1")) == {
        "toolCallId", "toolCallName", "parentMessageId"}
    assert fields(events.tool_call_args("tc-1", '{"tit')) == {"toolCallId", "delta"}
    assert fields(events.tool_call_end("tc-1")) == {"toolCallId"}
    result = events.tool_call_result("tr-1", "tc-1", '{"id":"clusters"}')
    assert fields(result) == {"messageId", "toolCallId", "content", "role"}
    assert result["role"] == "tool"


def test_the_state_events_carry_a_snapshot_and_rfc_6902_operations():
    assert events.state_snapshot({"dashboard": {}})["snapshot"] == {"dashboard": {}}
    delta = events.state_delta([{"op": "add", "path": "/dashboard/panels/-", "value": PANEL}])
    assert delta["delta"][0]["path"] == "/dashboard/panels/-"


# --------------------------------------------------------------------------- #
# framing
# --------------------------------------------------------------------------- #
def test_one_event_is_one_data_frame():
    frame = events.sse(events.run_started("t-1", "r-1"))
    assert frame.startswith("data: ") and frame.endswith("\n\n")
    assert json.loads(frame[len("data: "):])["runId"] == "r-1"


def test_a_newline_inside_a_value_cannot_split_a_frame():
    # SQL is multi-line, and a raw newline in the payload would end the event
    # half way through. json.dumps escaping it is what keeps that impossible.
    frame = events.sse(events.tool_call_args("tc-1", "SELECT name\nFROM clusters"))
    assert frame.count("\n") == 2                       # the two that end the frame
    assert json.loads(frame[len("data: "):])["delta"] == "SELECT name\nFROM clusters"


# --------------------------------------------------------------------------- #
# normalising the state
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("raw", [None, {}, {"dashboard": None}, {"dashboard": {}},
                                 {"unknown": "ignored"}])
def test_an_absent_state_becomes_the_empty_dashboard(raw):
    assert normalise_state(raw) == {"dashboard": EMPTY_DASHBOARD, "params": {}}


def test_a_state_that_is_sent_back_survives_the_round_trip():
    state = {"dashboard": {**EMPTY_DASHBOARD, "title": "Hub east", "panels": [PANEL]},
             "params": {"hub": "hub-east"}}
    assert normalise_state(state) == state


def test_a_draft_with_a_blank_title_starts_as_the_untitled_dashboard():
    """The page sends {title: ""} before anything was generated; that is a new
    dashboard, not a broken one, and a cleared title field mid-run is the same."""
    draft = {"dashboard": {"id": "generated", "title": "", "description": "",
                           "variables": [], "panels": []}, "params": {}}
    state = normalise_state(draft)
    assert state["dashboard"]["title"] == EMPTY_DASHBOARD["title"]
    assert state["dashboard"]["id"] == "generated"
    with_panels = {"dashboard": {**EMPTY_DASHBOARD, "title": "   ", "panels": [PANEL]}}
    assert normalise_state(with_panels)["dashboard"]["panels"] == [PANEL]


def test_a_state_whose_dashboard_is_not_one_is_refused():
    # The endpoint turns this into a 422: a run that started from a broken
    # definition could never produce a good one.
    with pytest.raises(DashboardInvalid):
        normalise_state({"dashboard": {"id": "Not A Slug", "title": "x"}})


def test_stored_only_fields_are_left_out_of_the_state():
    state = normalise_state({"dashboard": {**EMPTY_DASHBOARD, "updated_at": "2026-01-01T00:00:00",
                                           "updated_by": "someone"}})
    assert "updated_at" not in state["dashboard"]


# --------------------------------------------------------------------------- #
# the patch applier
# --------------------------------------------------------------------------- #
def test_add_appends_to_an_array_and_sets_an_object_key():
    state = apply_ops(empty_state(), [
        {"op": "add", "path": "/dashboard/panels/-", "value": PANEL},
        {"op": "add", "path": "/params/hub", "value": "hub-east"},
    ])
    assert state["dashboard"]["panels"] == [PANEL]
    assert state["params"] == {"hub": "hub-east"}


def test_replace_and_remove_address_a_panel_by_index():
    state = apply_ops(empty_state(), [{"op": "add", "path": "/dashboard/panels/-", "value": PANEL}])
    other = {**PANEL, "title": "Nodes"}
    state = apply_ops(state, [{"op": "replace", "path": "/dashboard/panels/0", "value": other}])
    assert state["dashboard"]["panels"][0]["title"] == "Nodes"
    state = apply_ops(state, [{"op": "remove", "path": "/dashboard/panels/0"}])
    assert state["dashboard"]["panels"] == []


def test_a_patch_is_applied_to_a_copy_and_all_or_nothing():
    original = empty_state()
    with pytest.raises(PatchError):
        apply_ops(original, [{"op": "replace", "path": "/dashboard/title", "value": "Hub east"},
                             {"op": "remove", "path": "/dashboard/panels/7"}])
    assert original == empty_state()            # the first operation did not stick


@pytest.mark.parametrize("op", [
    {"op": "copy", "path": "/dashboard/title", "value": "x"},        # unsupported operation
    {"op": "replace", "path": "dashboard/title", "value": "x"},      # not a pointer
    {"op": "replace", "path": "", "value": {}},                      # the whole document
    {"op": "replace", "path": "/dashboard/title"},                   # no value
    {"op": "replace", "path": "/dashboard/nope", "value": "x"},      # nothing to replace
    {"op": "remove", "path": "/params/absent"},                      # nothing to remove
    {"op": "replace", "path": "/dashboard/panels/0", "value": {}},   # past the end
    {"op": "add", "path": "/dashboard/panels/first", "value": {}},   # not an index
])
def test_the_applier_refuses_anything_it_was_not_built_for(op):
    with pytest.raises(PatchError):
        apply_ops(empty_state(), [op])


def test_a_pointer_token_can_carry_an_escaped_slash():
    state = apply_ops(empty_state(), [{"op": "add", "path": "/params/a~1b", "value": 1}])
    assert state["params"] == {"a/b": 1}
