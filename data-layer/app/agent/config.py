"""
What one agent run may spend, all overridable via environment.

Separate from `query_config` on purpose: a composing agent and a one-shot SQL
writer want different models and different budgets, and the question "how many
turns did that cost?" must be answerable without reading the query plane's
settings. The per-query timeout is *not* duplicated here - a panel's SQL is an
ordinary query and is bounded by `ODL_QUERY_TIMEOUT_SECONDS` like every other.
"""
import os

from ..query.config import query_config
from ..query.dashboards import MAX_PANELS


def _int(name: str, default: int, low: int, high: int) -> int:
    """An integer setting, clamped to a range a run can survive."""
    try:
        value = int(os.environ.get(name, default))
    except ValueError:
        return default
    return max(low, min(value, high))


class AgentConfig:
    # The model that composes, and how hard it is asked to think. Defaulting
    # to the query plane's model keeps a single-model deployment simple.
    model: str = os.environ.get("ODL_AGENT_MODEL") or query_config.model
    effort: str = os.environ.get("ODL_AGENT_EFFORT", "medium")

    # Output cap per turn. A turn is narration plus a tool call or two, so
    # this is generous; a long SQL panel is a few hundred tokens.
    max_tokens: int = _int("ODL_AGENT_MAX_TOKENS", 4096, 256, 64_000)

    # A turn is one model call. Six panels is roughly six to ten turns, so
    # twelve leaves room to fix a couple of failed queries and no more: a loop
    # that has not converged by then is not going to.
    max_turns: int = _int("ODL_AGENT_MAX_TURNS", 12, 1, 60)

    # How many panels one generated dashboard may hold. Never above the
    # dashboard format's own cap - a definition the agent builds must be a
    # definition `PUT /api/dashboards/{id}` would accept.
    max_panels: int = _int("ODL_AGENT_MAX_PANELS", 12, 1, MAX_PANELS)

    # Wall clock for the whole run, model time included. The browser is
    # holding a stream open; a run that outstays this ends as a RUN_ERROR the
    # page can render rather than as a connection that goes quiet.
    timeout_seconds: float = float(os.environ.get("ODL_AGENT_TIMEOUT_SECONDS", "150"))

    def as_limits(self) -> dict:
        """The subset `GET /api/agent` publishes, so a client can pre-empt them."""
        return {"max_turns": self.max_turns, "max_panels": self.max_panels,
                "timeout_seconds": self.timeout_seconds}


agent_config = AgentConfig()
