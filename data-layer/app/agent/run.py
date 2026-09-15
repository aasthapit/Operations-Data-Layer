"""
The loop: turns in, AG-UI events out.

One turn is one model call. The model narrates and calls tools; we stream both
as they arrive, execute the tool calls in order, feed the results back, and go
round again while the model asks for more. The whole run is a synchronous
generator of event dicts - the Anthropic SDK is synchronous, and a generator is
the smallest thing that can be driven from a worker thread by the endpoint
without either of them knowing about the other.

Three properties are worth stating, because the front end depends on them:

  * **the state is always consistent.** Our copy starts as the STATE_SNAPSHOT,
    every accepted mutation is a STATE_DELTA, and nothing else touches it - so
    the browser's copy equals ours at every event, and a client that missed
    nothing never has to re-fetch.
  * **a mutation's delta precedes its result.** The panel exists in the state
    before the tool result that describes it arrives, so a client can render on
    the delta alone and use the result only for narration.
  * **a failure is an event, not a broken stream.** Once the response has begun
    there is no status code left to send, so every way this can end - no
    credentials, the turn limit, the wall clock, a disconnect, a bug - is a
    RUN_ERROR with a code, and then the stream ends.

Bounds: `ODL_AGENT_MAX_TURNS` turns, `ODL_AGENT_TIMEOUT_SECONDS` of wall clock
checked before every model call and every tool, and the cancel flag the
endpoint sets when the browser goes away.
"""
from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable, Iterator, Sequence

from ..query.errors import QueryUnavailable
from ..store import Store
from . import events, prompt
from . import tools as agent_tools
from .config import agent_config
from .messages import (
    RunAgentInput,
    assistant_message,
    new_id,
    prepend_to_last_user,
    to_anthropic,
    tool_message,
    wire,
)
from .model import run_model, set_model  # noqa: F401 - set_model is the package's seam
from .state import normalise_state
from .tools import ToolContext

log = logging.getLogger("odl.agent.run")

MODEL_STEP = "model"

__all__ = ["AgentRun", "set_model", "stream_run"]


class _Stop(Exception):
    """A reason to end the run early, carrying the RUN_ERROR it becomes."""

    code = "internal"

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class _Cancelled(_Stop):
    code = "cancelled"


class _Expired(_Stop):
    code = "timeout"


class _TurnLimit(_Stop):
    code = "limit"


class AgentRun:
    """One `POST /api/agent/run`, as a generator of AG-UI events.

    The object outlives the generator so a caller (a test, the eval) can read
    the state the run ended with; the endpoint only needs `events()`.
    """

    def __init__(self, payload: RunAgentInput, store: Store | None = None,
                 is_cancelled: Callable[[], bool] | None = None):
        # Raises DashboardInvalid when the client sent a state that is not a
        # dashboard; the endpoint turns that into a 422, before the stream.
        self.payload = payload
        self.state = normalise_state(payload.state)
        self.context = ToolContext(state=self.state, store=store)
        self.is_cancelled = is_cancelled or (lambda: False)
        self.turns = 0
        self.tool_calls = 0
        self.usage: dict = {}
        self.produced: list = []          # the messages this run added to the thread
        self._started = 0.0
        self._deadline = 0.0

    # -- accounting --------------------------------------------------------
    @property
    def panels(self) -> int:
        return len(self.state["dashboard"]["panels"])

    def result(self) -> dict:
        return {
            "turns": self.turns,
            "tool_calls": self.tool_calls,
            "panels": self.panels,
            "elapsed_ms": int((time.time() - self._started) * 1000),
            "usage": {"input_tokens": self.usage.get("input_tokens", 0),
                      "output_tokens": self.usage.get("output_tokens", 0),
                      "cache_read_input_tokens": self.usage.get("cache_read_input_tokens", 0)},
        }

    def _check(self) -> None:
        """The two ways a run ends that have nothing to do with the model."""
        if self.is_cancelled():
            raise _Cancelled("the client disconnected")
        if time.time() > self._deadline:
            raise _Expired(f"the run outstayed its {agent_config.timeout_seconds:g}s budget")

    def _commit_state(self) -> None:
        """Tools replace the state wholesale; keep our handle on the current one."""
        self.state = self.context.state

    # -- the stream --------------------------------------------------------
    def events(self) -> Iterator[dict]:
        self._started = time.time()
        self._deadline = self._started + agent_config.timeout_seconds
        yield events.run_started(self.payload.thread_id, self.payload.run_id)
        yield events.state_snapshot(self.state)
        try:
            yield from self._turns()
        except _Stop as e:
            log.info("run %s ended early (%s): %s", self.payload.run_id, e.code, e.message)
            yield events.run_error(e.message, e.code)
            return
        except QueryUnavailable as e:
            yield events.run_error(str(e), "unavailable")
            return
        except Exception as e:  # noqa: BLE001 - a bug is still a RUN_ERROR, never a dead stream
            log.exception("run %s failed", self.payload.run_id)
            yield events.run_error(f"the run failed: {e}", "internal")
            return
        yield events.messages_snapshot(wire(list(self.payload.messages) + self.produced))
        yield events.run_finished(self.payload.thread_id, self.payload.run_id, self.result())

    def _turns(self) -> Iterator[dict]:
        conversation = to_anthropic(self.payload.messages)
        prepend_to_last_user(conversation, prompt.live_values(self.context.store))
        system = prompt.system_blocks()
        definitions = agent_tools.definitions()

        for turn in range(1, agent_config.max_turns + 1):
            self._check()
            self.turns = turn
            message_id = new_id("msg")
            text, calls, stop_reason = "", [], None

            yield events.step_started(MODEL_STEP)
            stream = run_model(system, definitions, conversation, agent_config.max_tokens)
            text_open = False
            for event in stream:
                self._check()
                kind = event[0]
                if kind == "text":
                    if not text_open:
                        yield events.text_message_start(message_id)
                        text_open = True
                    text += event[1]
                    yield events.text_message_content(message_id, event[1])
                elif kind == "tool_start":
                    if text_open:
                        yield events.text_message_end(message_id)
                        text_open = False
                    calls.append({"id": event[1], "name": event[2], "parts": [], "input": None})
                    yield events.tool_call_start(event[1], event[2], message_id)
                elif kind == "tool_args":
                    call = _call(calls, event[1])
                    if call is not None:
                        call["parts"].append(event[2])
                        yield events.tool_call_args(event[1], event[2])
                elif kind == "tool_end":
                    call = _call(calls, event[1])
                    if call is not None:
                        call["input"] = event[2]
                        yield events.tool_call_end(event[1])
                elif kind == "stop":
                    stop_reason = event[1]
                    _add_usage(self.usage, event[2])
            if text_open:
                yield events.text_message_end(message_id)
            yield events.step_finished(MODEL_STEP)

            self._record_assistant(conversation, message_id, text, calls)
            if not calls:
                break
            yield from self._run_tools(conversation, calls)
            if stop_reason != "tool_use":
                break
        else:
            raise _TurnLimit(f"the run reached its limit of {agent_config.max_turns} model "
                             f"turns; the dashboard holds what it built so far")

    def _record_assistant(self, conversation: list[dict], message_id: str, text: str,
                          calls: list[dict]) -> None:
        """The turn, in both dialects: the thread we send back, and the model's."""
        for call in calls:
            call["arguments"] = "".join(call["parts"]) or "{}"
        self.produced.append(assistant_message(message_id, text, calls))
        blocks: list[dict] = [{"type": "text", "text": text}] if text.strip() else []
        blocks += [{"type": "tool_use", "id": call["id"], "name": call["name"],
                    "input": call["input"] if isinstance(call["input"], dict) else {}}
                   for call in calls]
        if blocks:
            conversation.append({"role": "assistant", "content": blocks})

    def _run_tools(self, conversation: list[dict], calls: list[dict]) -> Iterator[dict]:
        """Execute a turn's tool calls, in order, streaming what each one did."""
        results = []
        for call in calls:
            self._check()
            self.tool_calls += 1
            outcome = agent_tools.execute(call["name"], call["input"], self.context)
            self._commit_state()
            # Compact: this string is both a wire event and the model's next
            # input, so every space in it is paid for twice.
            content = json.dumps(outcome.result, default=str, separators=(",", ":"))
            if outcome.ops:
                # Before the result, always: the panel is in the state by the
                # time the client is told about it.
                yield events.state_delta(outcome.ops)
            result_id = new_id("tr")
            yield events.tool_call_result(result_id, call["id"], content)
            self.produced.append(tool_message(result_id, call["id"], content))
            results.append({"type": "tool_result", "tool_use_id": call["id"], "content": content})
        conversation.append({"role": "user", "content": results})


def _call(calls: Sequence[dict], tool_call_id: str) -> dict | None:
    return next((c for c in calls if c["id"] == tool_call_id), None)


def _add_usage(total: dict, usage) -> None:
    if not isinstance(usage, dict):
        return
    for field, value in usage.items():
        if isinstance(value, int):
            total[field] = total.get(field, 0) + value


def stream_run(payload: RunAgentInput, store: Store | None = None,
               is_cancelled: Callable[[], bool] | None = None) -> Iterator[dict]:
    """One run's events. The endpoint's entry point."""
    return AgentRun(payload, store, is_cancelled).events()
