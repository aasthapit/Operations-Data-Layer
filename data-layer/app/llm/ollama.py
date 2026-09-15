"""
A model on the operator's own machine, via Ollama's native chat API.

The reason to have this at all is that nothing about the fleet leaves the
building: the schema, the cluster names, the questions people ask about an
estate and the SQL that answers them all stay on localhost. The price is that
everything a hosted SDK does for us has to be done here - there is no client,
no structured-output parser, no stream of typed events - so this module is
exactly that translation and nothing else:

  * `generate` asks for one JSON object matching `SqlPlan`'s schema, using
    Ollama's `format` parameter, and parses it;
  * `model` streams a turn and maps Ollama's chunks onto the five internal
    events the agent loop consumes, so the loop cannot tell the difference;
  * `availability` answers `GET /api/agent` from the daemon's model list,
    without loading any weights.

Four properties of the API drive the shape of the code:

  * **the context window is per request.** `options.num_ctx` defaults to a
    couple of thousand tokens and anything above it is dropped silently, which
    for us means a truncated semantic layer and confident SQL over columns
    that do not exist. It is sent on every call (see `app.llm.config`).
  * **a tool call arrives whole.** There is no partial-JSON stream: one chunk
    carries the name and the already-parsed arguments, so the `tool_args`
    event is re-made from them. The loop wants that string - it is the
    thread's record of the call - and the front end renders it as it lands.
  * **thinking is a separate channel.** `message.thinking` deltas are dropped
    rather than narrated: AG-UI has THINKING events and the Generate view
    could show them one day, but the loop's event contract has no room for
    them today, and narrating a model's scratchpad as if it were its answer
    would be worse than saying nothing.
  * **failures are HTTP.** A refused connection, a model that was never
    pulled and a turn that outstays its budget are three different things an
    operator can fix, so they get three different messages rather than one
    stack trace.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from collections.abc import Iterator, Sequence
from contextlib import contextmanager

import requests
from pydantic import ValidationError

from ..agent.config import agent_config
from ..query import llm as query_llm
from ..query.config import query_config
from ..query.errors import QueryUnavailable
from .config import EFFORTS, THINK_OFF, llm_config

log = logging.getLogger("odl.llm.ollama")

# The daemon is local: it accepts a connection at once or not at all, so only
# the read budget needs to be generous.
CONNECT_TIMEOUT = 5.0

# What a capability probe may spend. `availability()` is called by
# GET /api/agent on every page load, so it must never be why a page waits.
PROBE_TIMEOUT = 2.0

_lock = threading.Lock()
_session: requests.Session | None = None
# model name -> what /api/show said about it. See `_shown`.
_capabilities: dict[str, dict] = {}


# --------------------------------------------------------------------------- #
# talking to the daemon
# --------------------------------------------------------------------------- #
def _http() -> requests.Session:
    """One session per process. A run calls the daemon a dozen times; a kept
    connection is the difference between a turn and a turn plus a handshake."""
    global _session
    with _lock:
        if _session is None:
            _session = requests.Session()
        return _session


def _url(path: str) -> str:
    return f"{llm_config.base_url}{path}"


def _unreachable() -> str:
    return (f"Ollama is not reachable at {llm_config.base_url} "
            f"(start it with `ollama serve`)")


def _too_slow() -> str:
    return f"the local model did not answer within {llm_config.timeout_seconds:g} s"


@contextmanager
def _mapped_errors() -> Iterator[None]:
    """Every way the call can fail, as something a person can act on.

    It wraps the streaming loop as well as the request, because a read timeout
    can land halfway through a turn and means the same thing there.
    """
    try:
        yield
    except requests.exceptions.ReadTimeout as e:
        raise QueryUnavailable(_too_slow()) from e
    except requests.exceptions.ConnectionError as e:    # refused, DNS, connect timeout
        raise QueryUnavailable(_unreachable()) from e
    except requests.exceptions.Timeout as e:
        raise QueryUnavailable(_too_slow()) from e
    except requests.RequestException as e:
        raise QueryUnavailable(f"the Ollama call failed: {e}") from e


def _error_text(response) -> str:
    """Ollama's own explanation of a failed request, if it gave one."""
    try:
        payload = response.json()
    except ValueError:
        return (response.text or "").strip()[:200]
    if isinstance(payload, dict):
        return str(payload.get("error") or "").strip()
    return str(payload)[:200]


def _check(response, model_name: str) -> None:
    """A failed request as the thing the operator has to do about it."""
    if response.status_code < 400:
        return
    detail = _error_text(response)
    if response.status_code == 404 and "model" in detail.lower():
        raise QueryUnavailable(f"model {model_name} is not pulled "
                               f"(`ollama pull {model_name}`)")
    raise QueryUnavailable(f"Ollama returned {response.status_code}"
                           + (f": {detail}" if detail else ""))


def _shown(model_name: str) -> dict:
    """What `/api/show` says the model is, cached for the life of the process.

    Cached because it is consulted before every request and the answer is a
    property of the pulled weights: it cannot change without an `ollama pull`,
    and a restart after one is cheap. A probe that fails is not cached and not
    an error - not knowing only costs the `think` flag.
    """
    with _lock:
        cached = _capabilities.get(model_name)
    if cached is not None:
        return cached
    shown = {"capabilities": [], "family": ""}
    try:
        response = _http().post(_url("/api/show"), json={"name": model_name},
                                timeout=(CONNECT_TIMEOUT, PROBE_TIMEOUT))
        if response.status_code >= 400:
            return shown
        payload = response.json()
    except (requests.RequestException, ValueError) as e:
        log.debug("cannot read the capabilities of %s: %s", model_name, e)
        return shown
    shown = {"capabilities": list(payload.get("capabilities") or []),
             "family": str((payload.get("details") or {}).get("family") or "")}
    with _lock:
        _capabilities[model_name] = shown
    return shown


def _think(model_name: str, effort: str):
    """The `think` value for this model and this effort, or None to omit it.

    gpt-oss takes the effort word itself; other thinking models take a
    boolean; a model with no thinking capability is sent nothing, because
    there the field is an error rather than a no-op.
    """
    if llm_config.think == THINK_OFF:
        return None
    shown = _shown(model_name)
    if "thinking" not in shown["capabilities"]:
        return None
    if "gptoss" in shown["family"] or model_name.startswith("gpt-oss"):
        return effort if effort in EFFORTS else "medium"
    return True


def _body(model_name: str, messages: list[dict], max_tokens: int, effort: str,
          stream: bool) -> dict:
    body = {
        "model": model_name,
        "messages": messages,
        "stream": stream,
        # num_ctx is the one that matters; num_predict keeps a turn from
        # running away the way max_tokens does on the hosted path.
        "options": {"num_ctx": llm_config.num_ctx, "num_predict": max_tokens},
    }
    thinking = _think(model_name, effort)
    if thinking is not None:
        body["think"] = thinking
    return body


# --------------------------------------------------------------------------- #
# question -> SQL
# --------------------------------------------------------------------------- #
def generate(question: str, schema_text: str,
             error_feedback: str | None = None) -> query_llm.SqlPlan:
    """One question, one SQL plan, in a single non-streaming call.

    The prompt is the hosted path's, minus the cache marker there is nothing
    here to cache: the same instructions, the same schema, the same user
    message including the error fed back on a retry - so a prompt change is
    measured on both providers at once.
    """
    model_name = query_config.model
    system = (query_llm._INSTRUCTIONS.format(max_rows=query_config.max_rows)
              + "\n\n" + schema_text)
    body = _body(model_name,
                 [{"role": "system", "content": system},
                  {"role": "user",
                   "content": query_llm._user_message(question, error_feedback)}],
                 query_config.max_tokens, query_config.effort, stream=False)
    # The schema of what we want back. Ollama constrains the decoding to it,
    # which is what makes a 20B model answer with a plan rather than prose.
    body["format"] = query_llm.SqlPlan.model_json_schema()

    started = time.time()
    with _mapped_errors():
        response = _http().post(_url("/api/chat"), json=body,
                                timeout=(CONNECT_TIMEOUT, llm_config.timeout_seconds))
        _check(response, model_name)
        payload = response.json()

    content = ((payload.get("message") or {}).get("content") or "").strip()
    try:
        plan = query_llm.SqlPlan.model_validate_json(content)
    except ValidationError as e:
        # Not a retryable SQL error: `service.ask` retries queries that do not
        # run, and there is no query here to feed back.
        log.info("the local model answered with something that is not a plan: %.200s", content)
        raise QueryUnavailable("the local model returned no valid SQL plan") from e
    log.info("generated SQL for %r in %.1fs (in %s, out %s)", question[:80],
             time.time() - started, payload.get("prompt_eval_count"),
             payload.get("eval_count"))
    return plan


# --------------------------------------------------------------------------- #
# Anthropic shapes -> Ollama shapes
# --------------------------------------------------------------------------- #
def system_message(system_blocks: Sequence[dict]) -> str:
    """The system blocks as one string, cache markers dropped.

    There is no prompt cache here to mark: every call re-reads the whole
    system prompt, which is also why the local path is slower per turn.
    """
    return "\n\n".join(block.get("text") or "" for block in system_blocks
                       if block.get("text"))


def _text_of(content) -> str:
    """A tool result's content as a string, whatever shape it arrived in."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(part.get("text") or "" for part in content
                         if isinstance(part, dict) and part.get("type") == "text")
    return json.dumps(content, default=str)


def _assistant(blocks: Sequence[dict], names: dict[str, str]) -> dict:
    """An assistant turn: what it said, plus the calls it made."""
    text, calls = [], []
    for block in blocks:
        if block.get("type") == "text":
            text.append(block.get("text") or "")
        elif block.get("type") == "tool_use":
            call_id = str(block.get("id") or "")
            names[call_id] = str(block.get("name") or "")
            calls.append({"id": call_id,
                          "function": {"name": names[call_id],
                                       "arguments": block.get("input") or {}}})
    message: dict = {"role": "assistant", "content": "\n".join(t for t in text if t)}
    if calls:
        message["tool_calls"] = calls
    return message


def _user(blocks: Sequence[dict], names: dict[str, str]) -> list[dict]:
    """A user turn: one `tool` message per result it carries, then its text.

    Ollama wants the tool's *name* on the result, and the Anthropic shape only
    carries the id of the call - so the ids are resolved against the tool_use
    blocks seen earlier in the same thread, which is why this walk is ordered.
    """
    out, text = [], []
    for block in blocks:
        if block.get("type") == "tool_result":
            call_id = str(block.get("tool_use_id") or "")
            out.append({"role": "tool", "tool_call_id": call_id,
                        "tool_name": names.get(call_id, ""),
                        "content": _text_of(block.get("content"))})
        elif block.get("type") == "text":
            text.append(block.get("text") or "")
    joined = "\n\n".join(t for t in text if t)
    if joined:
        out.append({"role": "user", "content": joined})
    return out


def to_messages(system_blocks: Sequence[dict], messages: Sequence[dict]) -> list[dict]:
    """The thread the loop holds, as the flat message list Ollama takes."""
    out: list[dict] = []
    system = system_message(system_blocks)
    if system:
        out.append({"role": "system", "content": system})
    names: dict[str, str] = {}
    for message in messages:
        role = message.get("role")
        content = message.get("content")
        if isinstance(content, str):
            out.append({"role": role, "content": content})
        elif role == "assistant":
            out.append(_assistant(content or [], names))
        else:
            out.extend(_user(content or [], names))
    return out


def to_tools(tools: Sequence[dict]) -> list[dict]:
    """The tool definitions, in the function-calling shape Ollama takes.

    The schema itself is unchanged: it is generated from the tools' pydantic
    models, so what the model is told about and what we accept cannot drift,
    whichever provider is reading it.
    """
    return [{"type": "function",
             "function": {"name": tool.get("name"),
                          "description": tool.get("description") or "",
                          "parameters": tool.get("input_schema") or {}}}
            for tool in tools]


# --------------------------------------------------------------------------- #
# the agent turn
# --------------------------------------------------------------------------- #
def _arguments(value):
    """A tool call's arguments as an object. None when they are not one.

    Ollama hands them over already parsed, but a model that answers with a
    JSON *string* is common enough to be worth reading; anything else becomes
    None, which the loop reports back as a tool error the model can fix.
    """
    if isinstance(value, str):
        try:
            value = json.loads(value or "{}")
        except ValueError:
            return None
    return value if isinstance(value, dict) else None


def _tool_call(call: dict, index: int) -> Iterator[tuple]:
    """One tool call, as the three events the loop expects.

    The id is Ollama's when it sent one and `call_<n>` when it did not (some
    models omit it); it only has to be unique within the turn, because that is
    all the loop matches on.
    """
    function = call.get("function") or {}
    call_id = str(call.get("id") or f"call_{index}")
    arguments = _arguments(function.get("arguments"))
    yield ("tool_start", call_id, str(function.get("name") or ""))
    yield ("tool_args", call_id, json.dumps(arguments if arguments is not None else {}))
    yield ("tool_end", call_id, arguments)


def _stop_reason(calls: int, done_reason: str | None) -> str:
    """Why the turn ended, in the loop's vocabulary.

    A turn with a tool call in it is `tool_use`, because that is what tells
    the loop to run the tools and come back; `length` is Ollama's word for
    hitting `num_predict`, which is what the hosted path calls `max_tokens`.
    """
    if calls:
        return "tool_use"
    return "max_tokens" if done_reason == "length" else "end_turn"


def _events(lines: Iterator[bytes]) -> Iterator[tuple]:
    """Ollama's newline-delimited chunks as the loop's five internal events."""
    usage: dict = {}
    calls = 0
    stop_reason = "end_turn"
    for line in lines:
        if not line:
            continue
        try:
            chunk = json.loads(line)
        except ValueError:
            log.debug("ignoring a chunk that is not JSON: %.80s", line)
            continue
        message = chunk.get("message") or {}
        if message.get("content"):
            yield ("text", message["content"])
        if message.get("thinking"):
            # Dropped on purpose; see the module docstring.
            log.debug("thinking: %.120s", message["thinking"])
        for call in message.get("tool_calls") or []:
            calls += 1
            yield from _tool_call(call, calls)
        if chunk.get("done"):
            usage = {"input_tokens": chunk.get("prompt_eval_count") or 0,
                     "output_tokens": chunk.get("eval_count") or 0}
            stop_reason = _stop_reason(calls, chunk.get("done_reason"))
    log.info("turn finished (%s): %d tool calls, in %s, out %s", stop_reason, calls,
             usage.get("input_tokens"), usage.get("output_tokens"))
    yield ("stop", stop_reason, usage)


def model(system_blocks: Sequence[dict], tools: Sequence[dict],
          messages: Sequence[dict], max_tokens: int) -> Iterator[tuple]:
    """Stream one turn from the local model, as internal events."""
    model_name = agent_config.model
    body = _body(model_name, to_messages(system_blocks, messages), max_tokens,
                 agent_config.effort, stream=True)
    if tools:
        body["tools"] = to_tools(tools)
    with _mapped_errors():
        response = _http().post(_url("/api/chat"), json=body, stream=True,
                                timeout=(CONNECT_TIMEOUT, llm_config.timeout_seconds))
        _check(response, model_name)
        yield from _events(response.iter_lines())


# --------------------------------------------------------------------------- #
# can it run at all
# --------------------------------------------------------------------------- #
def _bare(name: str) -> str:
    """A model name without the tag Ollama adds when you do not give one."""
    return name[: -len(":latest")] if name.endswith(":latest") else name


def _pulled(payload, wanted: str) -> bool:
    models = payload.get("models") if isinstance(payload, dict) else None
    names = {_bare(str(entry.get("name") or "")) for entry in (models or [])}
    return _bare(wanted) in names


def availability(model_name: str | None = None) -> tuple[bool, str | None]:
    """Is the daemon up and the model pulled, without loading it.

    `/api/tags` is a directory read - it never touches the weights - which is
    what lets `GET /api/agent` ask on every page load. The budget is two
    seconds: a daemon that is up answers in milliseconds, and one that is not
    should not hold the page.
    """
    wanted = model_name or llm_config.ollama_model
    try:
        response = _http().get(_url("/api/tags"), timeout=PROBE_TIMEOUT)
    except requests.exceptions.ReadTimeout:
        return False, (f"Ollama did not answer within {PROBE_TIMEOUT:g} s at "
                       f"{llm_config.base_url}")
    except requests.RequestException:
        return False, _unreachable()
    if response.status_code >= 400:
        detail = _error_text(response)
        return False, (f"Ollama returned {response.status_code}"
                       + (f": {detail}" if detail else ""))
    try:
        payload = response.json()
    except ValueError:
        return False, "Ollama answered /api/tags with something that is not JSON"
    if not _pulled(payload, wanted):
        return False, f"model {wanted} is not pulled (`ollama pull {wanted}`)"
    return True, None
