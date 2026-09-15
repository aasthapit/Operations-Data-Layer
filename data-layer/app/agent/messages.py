"""
The thread, in two dialects: AG-UI on the wire, Anthropic blocks in the loop.

The API holds no session. The browser keeps the thread - the messages and the
state - and sends all of it back on every follow-up, which is what makes this
endpoint scale like every other one here and survive a restart. The price is
that a thread has to round-trip losslessly through the client, so the two
conversions in this module are exact inverses over what a run produces:

    AG-UI messages --to_anthropic--> what the model sees
    what the run produced --wire()--> MESSAGES_SNAPSHOT --to_anthropic--> the same blocks

The mapping itself is small. A user message is text; an assistant message is
its text plus one `tool_use` block per tool call, with the arguments parsed
from the JSON string AG-UI carries them as; a tool message is a `tool_result`
block, and consecutive tool messages become *one* user message, because that
is how the Messages API expects a turn's results to arrive. `system` and
`developer` messages are dropped: the system prompt is ours, not the client's.

Consecutive same-role messages are merged for the same reason - the API wants
one message per turn, and a merged pair is what the model would have seen
anyway.
"""
from __future__ import annotations

import json
import uuid
from collections.abc import Mapping, Sequence
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

# Roles we understand. Anything else (a `developer` note, a client-side
# `system` preamble) is dropped rather than smuggled into the model's context.
USER = "user"
ASSISTANT = "assistant"
TOOL = "tool"


def new_id(prefix: str) -> str:
    """A short, unique message or run id. Ids cross the wire; they stay boring."""
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


# --------------------------------------------------------------------------- #
# the AG-UI shapes
# --------------------------------------------------------------------------- #
class ToolCallFunction(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str
    arguments: str = Field(default="{}", description="The call's arguments, as a JSON string.")


class ToolCall(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    type: Literal["function"] = "function"
    function: ToolCallFunction


class AgentMessage(BaseModel):
    """One message of the thread, as AG-UI writes it (camelCase on the wire)."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    id: str = Field(default_factory=lambda: new_id("m"))
    role: str
    content: str | None = None
    tool_calls: list[ToolCall] = Field(default_factory=list, alias="toolCalls")
    tool_call_id: str | None = Field(default=None, alias="toolCallId")

    def wire(self) -> dict:
        """The message as the client sends and receives it, without empty fields."""
        out: dict = {"id": self.id, "role": self.role, "content": self.content or ""}
        if self.tool_calls:
            out["toolCalls"] = [call.model_dump(mode="json") for call in self.tool_calls]
        if self.tool_call_id is not None:
            out["toolCallId"] = self.tool_call_id
        return out


class RunAgentInput(BaseModel):
    """The AG-UI request body. Unknown keys are ignored, as the protocol says."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    thread_id: str = Field(default_factory=lambda: new_id("t"), alias="threadId")
    run_id: str = Field(default_factory=lambda: new_id("r"), alias="runId")
    parent_run_id: str | None = Field(default=None, alias="parentRunId")
    state: dict | None = None
    messages: list[AgentMessage] = Field(default_factory=list)
    tools: list[Any] = Field(default_factory=list)
    context: list[Any] = Field(default_factory=list)
    forwarded_props: dict = Field(default_factory=dict, alias="forwardedProps")

    def ends_with_a_user_message(self) -> bool:
        """A run answers a question, so the thread has to end with one."""
        return bool(self.messages) and self.messages[-1].role == USER


# --------------------------------------------------------------------------- #
# building the messages a run produces
# --------------------------------------------------------------------------- #
def assistant_message(message_id: str, text: str, calls: Sequence[Mapping]) -> AgentMessage:
    """One model turn as AG-UI sees it: what it said, and what it called."""
    return AgentMessage(
        id=message_id, role=ASSISTANT, content=text or "",
        tool_calls=[ToolCall(id=call["id"],
                             function=ToolCallFunction(name=call["name"],
                                                       arguments=call["arguments"]))
                    for call in calls])


def tool_message(message_id: str, tool_call_id: str, content: str) -> AgentMessage:
    return AgentMessage(id=message_id, role=TOOL, content=content, tool_call_id=tool_call_id)


# --------------------------------------------------------------------------- #
# AG-UI -> Anthropic
# --------------------------------------------------------------------------- #
def _arguments(text: str) -> dict:
    """A tool call's arguments as an object.

    Unparseable arguments are an empty object rather than an exception: the
    string came back through a browser, and a thread that cannot be replayed
    would make every follow-up fail with nothing the user could do about it.
    The tool validates the result either way.
    """
    try:
        value = json.loads(text or "{}")
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _blocks(message: AgentMessage) -> tuple[str, list[dict]] | None:
    """One AG-UI message as (role, content blocks) for the Messages API."""
    text = (message.content or "").strip()
    if message.role == USER:
        return (USER, [{"type": "text", "text": message.content}]) if text else None
    if message.role == ASSISTANT:
        blocks: list[dict] = [{"type": "text", "text": message.content}] if text else []
        blocks += [{"type": "tool_use", "id": call.id, "name": call.function.name,
                    "input": _arguments(call.function.arguments)}
                   for call in message.tool_calls]
        return (ASSISTANT, blocks) if blocks else None
    if message.role == TOOL and message.tool_call_id:
        # A tool result is a *user* block: it is what the conversation hands
        # back to the model, not something the model said.
        return (USER, [{"type": "tool_result", "tool_use_id": message.tool_call_id,
                        "content": message.content or ""}])
    return None                                 # system, developer, anything else


def to_anthropic(messages: Sequence[AgentMessage]) -> list[dict]:
    """The thread as Messages API input, one message per turn."""
    out: list[dict] = []
    for message in messages:
        converted = _blocks(message)
        if converted is None:
            continue
        role, blocks = converted
        if out and out[-1]["role"] == role:
            out[-1]["content"].extend(blocks)
        else:
            out.append({"role": role, "content": blocks})
    return out


def prepend_to_last_user(messages: list[dict], text: str) -> bool:
    """Put `text` in front of the last thing the user said. False if there is none.

    In front of the *text*, not as a new block, because a user message can also
    carry the previous turn's tool results and those have to stay at its front.
    """
    if not text:
        return False
    for message in reversed(messages):
        if message["role"] != USER:
            continue
        for block in reversed(message["content"]):
            if block.get("type") == "text":
                block["text"] = f"{text}\n\n{block['text']}"
                return True
    return False


def wire(messages: Sequence[AgentMessage]) -> list[dict]:
    """A list of messages as MESSAGES_SNAPSHOT carries them."""
    return [message.wire() for message in messages]
