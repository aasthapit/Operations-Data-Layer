"""
The model, behind a seam the tests can replace.

The loop does not know it is talking to Anthropic. It consumes a stream of
five internal events:

    ("text", delta)             narration, as it is written
    ("tool_start", id, name)    a tool call begins
    ("tool_args", id, delta)    its arguments, as partial JSON
    ("tool_end", id, args)      the arguments, parsed (None if they were not JSON)
    ("stop", stop_reason, usage)  the turn is over

That is the whole contract, and it is what makes the loop testable without a
network call: `set_model(fn)` swaps in a scripted adapter exactly as
`llm.set_generator` does for the query plane, and every ordering property of
the event stream can then be asserted deterministically.

The Anthropic adapter maps the raw stream events one to one - there is no
buffering of a whole message, because the point of the feature is that the page
fills in while the model is still writing. The client and the exception mapping
are the query plane's (`app.query.llm`), so credentials are resolved once per
process and a missing key reads the same here as it does on `/api/query/ask`.
"""
from __future__ import annotations

import json
import logging
from collections.abc import Callable, Iterator, Sequence

from ..query import llm
from ..query.errors import QueryUnavailable
from .config import agent_config

log = logging.getLogger("odl.agent.model")

# (system_blocks, tools, messages, max_tokens) -> stream of the events above.
ModelEvent = tuple
Adapter = Callable[[Sequence[dict], Sequence[dict], Sequence[dict], int], Iterator[ModelEvent]]

_adapter: Adapter | None = None

# The usage counters a run reports. The SDK sends them in two places - the
# input side at message_start, the output side at message_delta - so they are
# merged as they arrive rather than read off a final message that streaming
# never produces.
_USAGE_FIELDS = ("input_tokens", "output_tokens", "cache_read_input_tokens")


def set_model(fn: Adapter | None) -> None:
    """Replace the adapter (tests, or another provider). None restores it."""
    global _adapter
    _adapter = fn


def injected() -> bool:
    """Whether a replacement adapter is in place - no credentials are needed then."""
    return _adapter is not None


def availability() -> tuple[bool, str | None]:
    """Can a run start at all, and if not, why not (the text the API serves)."""
    if _adapter is not None:
        return True, None
    try:
        llm._get_client()
    except QueryUnavailable as e:
        return False, str(e)
    return True, None


def run_model(system_blocks: Sequence[dict], tools: Sequence[dict],
              messages: Sequence[dict], max_tokens: int) -> Iterator[ModelEvent]:
    """One turn. Yields internal events; raises QueryUnavailable if it cannot run."""
    adapter = _adapter or anthropic_model
    return adapter(system_blocks, tools, messages, max_tokens)


# --------------------------------------------------------------------------- #
# the Anthropic adapter
# --------------------------------------------------------------------------- #
def _usage(into: dict, usage) -> dict:
    for field in _USAGE_FIELDS:
        value = getattr(usage, field, None)
        if value is not None:
            into[field] = value
    return into


def _arguments(text: str):
    """A tool call's accumulated partial JSON, parsed. None when it is not JSON.

    No input_json_delta at all means an empty object: a tool whose arguments
    are all optional is called with `{}` and the API sends no deltas for it.
    """
    try:
        value = json.loads(text.strip() or "{}")
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def anthropic_model(system_blocks: Sequence[dict], tools: Sequence[dict],
                    messages: Sequence[dict], max_tokens: int) -> Iterator[ModelEvent]:
    """Stream one turn from the Messages API, as internal events."""
    client = llm._get_client()
    usage: dict = {}
    stop_reason: str | None = None
    # index -> [name, id, [partial json, ...]] for the tool_use blocks in flight.
    open_blocks: dict[int, list] = {}
    with llm.mapped_errors(), client.messages.stream(
            model=agent_config.model,
            max_tokens=max_tokens,
            system=list(system_blocks),
            tools=list(tools),
            messages=list(messages),
            output_config={"effort": agent_config.effort}) as stream:
        for event in stream:
            kind = getattr(event, "type", None)
            if kind == "message_start":
                _usage(usage, event.message.usage)
            elif kind == "content_block_start":
                block = event.content_block
                if block.type == "tool_use":
                    open_blocks[event.index] = [block.name, block.id, []]
                    yield ("tool_start", block.id, block.name)
            elif kind == "content_block_delta":
                delta = event.delta
                if delta.type == "text_delta" and delta.text:
                    yield ("text", delta.text)
                elif delta.type == "input_json_delta":
                    block = open_blocks.get(event.index)
                    if block is not None and delta.partial_json:
                        block[2].append(delta.partial_json)
                        yield ("tool_args", block[1], delta.partial_json)
            elif kind == "content_block_stop":
                block = open_blocks.pop(event.index, None)
                if block is not None:
                    yield ("tool_end", block[1], _arguments("".join(block[2])))
            elif kind == "message_delta":
                stop_reason = getattr(event.delta, "stop_reason", None) or stop_reason
                _usage(usage, event.usage)
    log.info("turn finished (%s): %s", stop_reason,
             ", ".join(f"{k}={v}" for k, v in usage.items()) or "no usage reported")
    yield ("stop", stop_reason, usage)
