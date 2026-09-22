"""
Question -> SQL: the prompt that is sent, and every way the call can fail.

`app/query/llm.py` is the one place that talks to the Messages API for the
query plane, and the agent streams from the same client, so its error mapping
is the single place a broken key, a rate limit or an unreachable API turns into
a sentence the dashboard can show. These tests pin that mapping exception by
exception, and they pin the request itself - the cached system block, the
question, and the retry that feeds the previous error back - because the whole
feature is the prompt.

No network is touched: `_get_client` is replaced with a recording double whose
`messages.parse` returns whatever the test wants, including the SDK's own
exception classes.
"""
from types import SimpleNamespace

import anthropic
import pytest

from app.query import llm
from app.query.config import query_config
from app.query.errors import QueryUnavailable

PLAN = llm.SqlPlan(sql="SELECT 1", explanation="one", assumptions=[], confidence=0.9)
SCHEMA = "TABLE clusters(name VARCHAR)"


def _sdk_response(status=500):
    """The bare shape `anthropic.APIStatusError` reads off a response."""
    return SimpleNamespace(status_code=status, headers={}, text="", request=None)


class _Messages:
    def __init__(self, answer):
        self.answer = answer
        self.calls = []

    def parse(self, **kwargs):
        self.calls.append(kwargs)
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


class _Client:
    def __init__(self, answer):
        self.messages = _Messages(answer)


@pytest.fixture(autouse=True)
def no_injected_generator(monkeypatch):
    """The module's two globals are process-wide; no test may leak either."""
    monkeypatch.setattr(llm, "_generator", None)
    monkeypatch.setattr(llm, "_client", None)


def _client_returning(monkeypatch, answer):
    client = _Client(answer)
    monkeypatch.setattr(llm, "_get_client", lambda: client)
    return client


# --------------------------------------------------------------------------- #
# the request
# --------------------------------------------------------------------------- #
def test_the_schema_travels_in_a_cached_system_block_and_the_question_does_not(monkeypatch):
    """Everything stable is marked ephemeral so the second question onwards
    pays for the question only; the question itself must stay out of it."""
    client = _client_returning(monkeypatch, SimpleNamespace(
        stop_reason="end_turn", parsed_output=PLAN, usage=None))
    llm._anthropic_generate("how many clusters?", SCHEMA)

    sent = client.messages.calls[0]
    system = sent["system"][0]
    assert system["cache_control"] == {"type": "ephemeral"}
    assert SCHEMA in system["text"]
    assert str(query_config.max_rows) in system["text"]
    assert "how many clusters?" not in system["text"]
    assert sent["messages"] == [{"role": "user", "content": "Question: how many clusters?"}]
    assert sent["model"] == query_config.model
    assert sent["max_tokens"] == query_config.max_tokens
    assert sent["output_format"] is llm.SqlPlan


def test_a_retry_hands_the_model_back_the_sql_that_failed(monkeypatch):
    client = _client_returning(monkeypatch, SimpleNamespace(
        stop_reason="end_turn", parsed_output=PLAN, usage=None))
    llm._anthropic_generate("how many clusters?", SCHEMA,
                            "SELECT * FROM cluster\nerror: no such table: cluster")

    content = client.messages.calls[0]["messages"][0]["content"]
    assert "Question: how many clusters?" in content
    assert "did not work" in content
    assert "no such table: cluster" in content


def test_the_user_message_is_the_bare_question_when_nothing_failed_yet():
    assert llm._user_message("q", None) == "Question: q"
    assert llm._user_message("q", "") == "Question: q"


# --------------------------------------------------------------------------- #
# the answer
# --------------------------------------------------------------------------- #
def test_a_parsed_plan_is_returned_unchanged(monkeypatch):
    _client_returning(monkeypatch, SimpleNamespace(
        stop_reason="end_turn", parsed_output=PLAN,
        usage=SimpleNamespace(input_tokens=10, output_tokens=5,
                              cache_read_input_tokens=1000)))
    assert llm._anthropic_generate("q", SCHEMA) is PLAN


def test_a_refusal_says_the_model_declined_and_names_the_category(monkeypatch):
    _client_returning(monkeypatch, SimpleNamespace(
        stop_reason="refusal", parsed_output=None,
        stop_details=SimpleNamespace(category="prompt_injection")))
    with pytest.raises(QueryUnavailable, match=r"declined to answer this question \(prompt_injection\)"):
        llm._anthropic_generate("q", SCHEMA)


def test_a_refusal_without_a_category_still_reads_as_a_refusal(monkeypatch):
    _client_returning(monkeypatch, SimpleNamespace(
        stop_reason="refusal", parsed_output=None, stop_details=None))
    with pytest.raises(QueryUnavailable) as err:
        llm._anthropic_generate("q", SCHEMA)
    assert str(err.value) == "the model declined to answer this question"


def test_an_answer_with_no_plan_in_it_reports_the_stop_reason(monkeypatch):
    """max_tokens in the middle of the structured output is the usual cause,
    and the stop reason is what tells an operator to raise the cap."""
    _client_returning(monkeypatch, SimpleNamespace(
        stop_reason="max_tokens", parsed_output=None, usage=None))
    with pytest.raises(QueryUnavailable, match=r"no SQL \(stop_reason=max_tokens\)"):
        llm._anthropic_generate("q", SCHEMA)


# --------------------------------------------------------------------------- #
# the error mapping, which the agent shares
# --------------------------------------------------------------------------- #
def test_a_call_that_works_passes_straight_through():
    with llm.mapped_errors():
        value = 1
    assert value == 1


@pytest.mark.parametrize("error, expected", [
    # SDK 1.x builds a client with no credentials and only fails when it
    # assembles the headers - with a TypeError, not an AuthenticationError.
    (TypeError("expected str, got NoneType"), "credentials"),
    (anthropic.AuthenticationError("bad key", response=_sdk_response(401), body=None),
     "credentials"),
    (anthropic.RateLimitError("slow down", response=_sdk_response(429), body=None),
     "rate limited"),
    (anthropic.APIStatusError("boom", response=_sdk_response(503), body=None),
     "returned 503"),
    (anthropic.APIConnectionError(message="no route", request=None), "unreachable"),
    (anthropic.AnthropicError("something else entirely"), "something else entirely"),
])
def test_every_sdk_failure_becomes_a_sentence_the_api_can_serve(error, expected):
    with pytest.raises(QueryUnavailable, match=expected):
        with llm.mapped_errors():
            raise error


def test_an_error_that_is_not_the_sdk_s_is_left_alone():
    """A bug in our own code must not be reported to the user as "the model
    is unavailable"."""
    with pytest.raises(ZeroDivisionError):
        with llm.mapped_errors():
            _ = 1 / 0


def test_the_mapping_keeps_the_original_failure_as_the_cause():
    original = anthropic.RateLimitError("slow down", response=_sdk_response(429), body=None)
    with pytest.raises(QueryUnavailable) as err:
        with llm.mapped_errors():
            raise original
    assert err.value.__cause__ is original


def test_a_failing_call_is_mapped_on_the_way_out_of_the_generator(monkeypatch):
    _client_returning(monkeypatch, anthropic.AuthenticationError(
        "bad key", response=_sdk_response(401), body=None))
    with pytest.raises(QueryUnavailable, match="credentials"):
        llm._anthropic_generate("q", SCHEMA)


# --------------------------------------------------------------------------- #
# the client
# --------------------------------------------------------------------------- #
def test_a_client_that_cannot_even_be_constructed_is_reported_as_missing_credentials(monkeypatch):
    import anthropic as sdk

    def boom():
        raise RuntimeError("no config directory")

    monkeypatch.setattr(sdk, "Anthropic", boom)
    with pytest.raises(QueryUnavailable, match="credentials"):
        llm._get_client()


def test_a_client_the_sdk_built_without_any_credentials_is_unavailable(monkeypatch):
    """SDK 1.x constructs happily with nothing at all, so the check has to be
    here and not at the first request."""
    import anthropic as sdk

    monkeypatch.setattr(sdk, "Anthropic", lambda: SimpleNamespace(
        api_key=None, auth_token=None, credentials=None))
    with pytest.raises(QueryUnavailable, match="credentials"):
        llm._get_client()


def test_the_client_is_built_once_and_reused(monkeypatch):
    import anthropic as sdk
    built = []

    def build():
        built.append(1)
        return SimpleNamespace(api_key="sk-ant-test", auth_token=None)

    monkeypatch.setattr(sdk, "Anthropic", build)
    first = llm._get_client()
    assert llm._get_client() is first and built == [1]


# --------------------------------------------------------------------------- #
# the injectable seam
# --------------------------------------------------------------------------- #
def test_an_injected_generator_answers_instead_of_the_provider(monkeypatch):
    def scripted(question, schema_text, error_feedback=None):
        return llm.SqlPlan(sql=f"-- {question}", explanation="scripted")

    def unexpected(*_a, **_k):
        raise AssertionError("the provider must not be reached while a generator is set")

    monkeypatch.setattr(llm.provider, "generate", unexpected)
    llm.set_generator(scripted)
    try:
        assert llm.generate_sql("q", SCHEMA).sql == "-- q"
        assert llm.available() is True
    finally:
        llm.set_generator(None)


def test_without_a_generator_the_configured_provider_answers(monkeypatch):
    seen = []
    monkeypatch.setattr(llm.provider, "generate",
                        lambda *args: seen.append(args) or PLAN)
    assert llm.generate_sql("q", SCHEMA, "feedback") is PLAN
    assert seen == [("q", SCHEMA, "feedback")]


def test_availability_without_a_generator_is_the_provider_s_answer(monkeypatch):
    monkeypatch.setattr(llm.provider, "availability", lambda _m: (False, "no key"))
    assert llm.available() is False
    monkeypatch.setattr(llm.provider, "availability", lambda _m: (True, None))
    assert llm.available() is True
