"""
The hosted provider, behind the provider interface.

There is no new behaviour here, and deliberately no moved code either. The two
Anthropic calls stay where they were written - the SQL writer in
`app.query.llm`, the streaming adapter in `app.agent.model` - because both are
written against the Messages API's own shapes and belong next to the prompt and
the loop they serve. What this module adds is the three functions every
provider exposes, so `app.llm.provider` can choose without either plane
knowing which provider it got.

The two modules are reached by attribute and never by importing their
functions: the tests replace `llm._get_client` to prove what a box with no
credentials answers, and a `from ... import` here would keep the original.
"""
from __future__ import annotations

from collections.abc import Iterator, Sequence

from ..agent import model as agent_model
from ..query import llm
from ..query.errors import QueryUnavailable


def generate(question: str, schema_text: str,
             error_feedback: str | None = None) -> llm.SqlPlan:
    """One question, one SQL plan, as structured output from the Messages API."""
    return llm._anthropic_generate(question, schema_text, error_feedback)


def model(system_blocks: Sequence[dict], tools: Sequence[dict],
          messages: Sequence[dict], max_tokens: int) -> Iterator[tuple]:
    """One agent turn, streamed from the Messages API."""
    return agent_model.anthropic_model(system_blocks, tools, messages, max_tokens)


def availability(model_name: str | None = None) -> tuple[bool, str | None]:
    """Credentials, resolved once per process. The model name plays no part:
    a key that works works for every model, and asking the API whether one
    exists would cost a request on every page load."""
    try:
        llm._get_client()
    except QueryUnavailable as e:
        return False, str(e)
    return True, None
