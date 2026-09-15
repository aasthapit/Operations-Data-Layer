"""
The one place that knows which provider is in use.

A provider is three functions, and they are the complete list of things the
data layer asks a model to do:

    generate(question, schema_text, error_feedback) -> SqlPlan
    model(system_blocks, tools, messages, max_tokens) -> Iterator[ModelEvent]
    availability(model_name) -> (bool, reason or None)

Both planes call these and neither of them names a vendor, so adding a third
provider is a module plus a branch here - and the test seams
(`llm.set_generator`, `model.set_model`) keep their priority over all of it,
because a scripted model must stay scriptable whatever is configured.

The backend is imported on use rather than at module load. That is not
laziness: the Anthropic backend reaches into the query plane, the query plane
asks this module who to call, and importing both providers eagerly would make
that circle real - as well as importing an SDK nobody selected.
"""
from __future__ import annotations

from collections.abc import Iterator, Sequence
from types import ModuleType
from typing import TYPE_CHECKING

from .config import llm_config

if TYPE_CHECKING:                       # pragma: no cover - annotations only
    from ..query.llm import SqlPlan


def backend() -> ModuleType:
    """The module that speaks to the configured provider."""
    if llm_config.uses_ollama():
        from . import ollama
        return ollama
    from . import anthropic
    return anthropic


def generate(question: str, schema_text: str,
             error_feedback: str | None = None) -> SqlPlan:
    """Turn one question into a SQL plan."""
    return backend().generate(question, schema_text, error_feedback)


def model(system_blocks: Sequence[dict], tools: Sequence[dict],
          messages: Sequence[dict], max_tokens: int) -> Iterator[tuple]:
    """Stream one agent turn as the loop's internal events."""
    return backend().model(system_blocks, tools, messages, max_tokens)


def availability(model_name: str | None = None) -> tuple[bool, str | None]:
    """Can a model be called at all, and if not, why not (text for the user)."""
    return backend().availability(model_name)
