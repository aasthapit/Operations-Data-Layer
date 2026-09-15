"""
Which provider answers, and what the local one needs to be told.

The choice lives here, on its own, because three modules depend on it and none
of them should depend on each other: the query plane and the agent read their
default model from it, and `app.llm.provider` reads which backend to call. All
of it is environment, so a deployment picks a provider without a code change.

The Ollama settings are not optional extras; each one is a trap avoided:

  * **`num_ctx` is per request.** Ollama's default context window is a couple
    of thousand tokens, the semantic layer is far larger than that, and what
    does not fit is dropped *silently* - which shows up as SQL over columns
    that do not exist rather than as an error. It is sent on every call.
  * **the budgets are minutes.** A 20B model on a laptop spends tens of
    seconds on a turn, and the first call also loads the weights; a hosted
    model's timeouts would turn a working setup into a stream of timeouts.
  * **`think` depends on the model.** gpt-oss takes an effort word, other
    thinking models take a boolean, and a model that cannot think at all
    rejects the field - so `auto` asks the daemon before sending anything.
"""
import os

ANTHROPIC = "anthropic"
OLLAMA = "ollama"

# What each provider costs in time. A hosted model writes a turn in seconds; a
# local one is an order of magnitude slower, and a six-panel run has to be
# allowed to finish rather than die halfway with panels already on the page.
ANTHROPIC_MODEL = "claude-opus-5"
ANTHROPIC_AGENT_TIMEOUT = 150.0
OLLAMA_MODEL = "gpt-oss:20b"
OLLAMA_AGENT_TIMEOUT = 600.0

# `ODL_OLLAMA_THINK`: follow the model's own capabilities, or never think.
THINK_AUTO = "auto"
THINK_OFF = "off"

# The effort words both planes already use, and the ones gpt-oss understands.
EFFORTS = ("low", "medium", "high")


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


class LlmConfig:
    # anthropic (the default) or ollama. Anything else is treated as anthropic
    # rather than as a startup error: a typo must not take the API down.
    provider: str = (os.environ.get("ODL_LLM_PROVIDER") or ANTHROPIC).strip().lower()

    # Where the Ollama daemon listens. From inside the containers this is
    # http://host.docker.internal:11434 - the daemon runs on the host, and the
    # container's own localhost is not it.
    base_url: str = (os.environ.get("OLLAMA_BASE_URL") or "http://localhost:11434").rstrip("/")

    # The local model, and the default of ODL_QUERY_MODEL / ODL_AGENT_MODEL
    # when the provider is ollama. It must support tools for the agent.
    ollama_model: str = os.environ.get("ODL_OLLAMA_MODEL") or OLLAMA_MODEL

    # The context window asked for per request; see the module docstring.
    num_ctx: int = _int("ODL_OLLAMA_NUM_CTX", 32768)

    # HTTP read budget for one call to the daemon.
    timeout_seconds: float = _float("ODL_OLLAMA_TIMEOUT_SECONDS", 300)

    think: str = (os.environ.get("ODL_OLLAMA_THINK") or THINK_AUTO).strip().lower()

    def uses_ollama(self) -> bool:
        return self.provider == OLLAMA

    def default_model(self) -> str:
        """The model a plane uses when it does not name one itself."""
        return self.ollama_model if self.uses_ollama() else ANTHROPIC_MODEL

    def default_agent_timeout(self) -> float:
        """The wall clock one agent run gets when nobody set one."""
        return OLLAMA_AGENT_TIMEOUT if self.uses_ollama() else ANTHROPIC_AGENT_TIMEOUT


llm_config = LlmConfig()
