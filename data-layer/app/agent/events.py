"""
The AG-UI wire format: one event per `data:` line, field names as the spec
writes them.

This is a contract with the browser, so it is deliberately a module of small
builders rather than a dependency. The `ag-ui-protocol` package models exactly
these events, but it pins `pydantic>=2.11` and the service pins 2.10.4;
swapping it in later means deleting this file and importing theirs, which is
why the builders are the only place an event dict is constructed.

Two rules the builders enforce so callers cannot get them wrong:

  * the field names are camelCase (`threadId`, `toolCallId`, `parentMessageId`)
    even though everything else in this codebase is snake_case - they cross the
    wire and the client reads them verbatim;
  * `timestamp` is milliseconds since the epoch, stamped here, so every event
    carries one and no caller has to remember to.

`sse()` is the framing: SSE separates events with a blank line, so the payload
must be a single line - `json.dumps` escapes newlines inside strings, which is
what makes that true for a SQL string or a stack trace.
"""
from __future__ import annotations

import json
import time
from collections.abc import Mapping, Sequence
from typing import Any


class EventType:
    """Every event this API emits. Kept as constants so a typo is an error."""

    RUN_STARTED = "RUN_STARTED"
    RUN_FINISHED = "RUN_FINISHED"
    RUN_ERROR = "RUN_ERROR"
    STEP_STARTED = "STEP_STARTED"
    STEP_FINISHED = "STEP_FINISHED"
    STATE_SNAPSHOT = "STATE_SNAPSHOT"
    STATE_DELTA = "STATE_DELTA"
    TEXT_MESSAGE_START = "TEXT_MESSAGE_START"
    TEXT_MESSAGE_CONTENT = "TEXT_MESSAGE_CONTENT"
    TEXT_MESSAGE_END = "TEXT_MESSAGE_END"
    TOOL_CALL_START = "TOOL_CALL_START"
    TOOL_CALL_ARGS = "TOOL_CALL_ARGS"
    TOOL_CALL_END = "TOOL_CALL_END"
    TOOL_CALL_RESULT = "TOOL_CALL_RESULT"
    MESSAGES_SNAPSHOT = "MESSAGES_SNAPSHOT"


# What a RUN_ERROR may say went wrong. The client picks its wording from the
# code, not from the message, so the set is closed.
ERROR_CODES = ("unavailable", "limit", "timeout", "internal", "cancelled")


def _event(event_type: str, **fields: Any) -> dict:
    return {"type": event_type, "timestamp": int(time.time() * 1000), **fields}


# --------------------------------------------------------------------------- #
# the run
# --------------------------------------------------------------------------- #
def run_started(thread_id: str, run_id: str) -> dict:
    return _event(EventType.RUN_STARTED, threadId=thread_id, runId=run_id)


def run_finished(thread_id: str, run_id: str, result: Mapping) -> dict:
    """The last event of a healthy run. `result` is the run's own accounting."""
    return _event(EventType.RUN_FINISHED, threadId=thread_id, runId=run_id,
                  result=dict(result))


def run_error(message: str, code: str) -> dict:
    """The last event of a failed run. Never a broken stream, always this."""
    if code not in ERROR_CODES:
        raise ValueError(f"unknown run error code {code!r}; one of {', '.join(ERROR_CODES)}")
    return _event(EventType.RUN_ERROR, message=message, code=code)


def step_started(step_name: str) -> dict:
    return _event(EventType.STEP_STARTED, stepName=step_name)


def step_finished(step_name: str) -> dict:
    return _event(EventType.STEP_FINISHED, stepName=step_name)


# --------------------------------------------------------------------------- #
# state
# --------------------------------------------------------------------------- #
def state_snapshot(snapshot: Mapping) -> dict:
    """The whole state. Sent once, right after RUN_STARTED, as the baseline."""
    return _event(EventType.STATE_SNAPSHOT, snapshot=dict(snapshot))


def state_delta(delta: Sequence[Mapping]) -> dict:
    """A change to the state, as RFC 6902 operations against the baseline."""
    return _event(EventType.STATE_DELTA, delta=[dict(op) for op in delta])


# --------------------------------------------------------------------------- #
# messages
# --------------------------------------------------------------------------- #
def text_message_start(message_id: str, role: str = "assistant") -> dict:
    return _event(EventType.TEXT_MESSAGE_START, messageId=message_id, role=role)


def text_message_content(message_id: str, delta: str) -> dict:
    """One chunk of narration. An empty delta is not an event - it is nothing."""
    if not delta:
        raise ValueError("a TEXT_MESSAGE_CONTENT delta may not be empty")
    return _event(EventType.TEXT_MESSAGE_CONTENT, messageId=message_id, delta=delta)


def text_message_end(message_id: str) -> dict:
    return _event(EventType.TEXT_MESSAGE_END, messageId=message_id)


def messages_snapshot(messages: Sequence[Mapping]) -> dict:
    """The whole thread, in AG-UI shape, for the client to send back verbatim."""
    return _event(EventType.MESSAGES_SNAPSHOT, messages=[dict(m) for m in messages])


# --------------------------------------------------------------------------- #
# tool calls
# --------------------------------------------------------------------------- #
def tool_call_start(tool_call_id: str, tool_call_name: str, parent_message_id: str) -> dict:
    return _event(EventType.TOOL_CALL_START, toolCallId=tool_call_id,
                  toolCallName=tool_call_name, parentMessageId=parent_message_id)


def tool_call_args(tool_call_id: str, delta: str) -> dict:
    """Partial JSON, exactly as the model streams it. The client may render it."""
    if not delta:
        raise ValueError("a TOOL_CALL_ARGS delta may not be empty")
    return _event(EventType.TOOL_CALL_ARGS, toolCallId=tool_call_id, delta=delta)


def tool_call_end(tool_call_id: str) -> dict:
    return _event(EventType.TOOL_CALL_END, toolCallId=tool_call_id)


def tool_call_result(message_id: str, tool_call_id: str, content: str,
                     role: str = "tool") -> dict:
    """What the tool answered, as the compact JSON string the model will read."""
    return _event(EventType.TOOL_CALL_RESULT, messageId=message_id, toolCallId=tool_call_id,
                  content=content, role=role)


# --------------------------------------------------------------------------- #
# framing
# --------------------------------------------------------------------------- #
def sse(event: Mapping) -> str:
    """One event as a server-sent event frame."""
    return "data: " + json.dumps(event, default=str) + "\n\n"
