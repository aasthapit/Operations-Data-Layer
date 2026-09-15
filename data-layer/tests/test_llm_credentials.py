"""
Credentials are checked when the client is built, not when the first request
fails.

SDK 1.x constructs a client with no key at all and only complains when it
assembles the request headers, so without this check `available()` and
GET /api/agent would answer "yes" on a box with no credentials and every run
would then end in an error the user cannot act on.
"""
import pytest

from app.query import llm
from app.query.errors import QueryUnavailable

CREDENTIAL_VARS = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")


@pytest.fixture(autouse=True)
def fresh_client(monkeypatch):
    """Each test builds its own client; none leaks into the next."""
    monkeypatch.setattr(llm, "_client", None)
    monkeypatch.setattr(llm, "_generator", None)
    yield
    monkeypatch.setattr(llm, "_client", None)


def _no_auto_discovery(monkeypatch):
    for name in CREDENTIAL_VARS:
        monkeypatch.delenv(name, raising=False)
    # A developer's own `ant auth login` profile or workload identity must not
    # make this test pass on their machine and fail in CI.
    import anthropic._client as sdk_client
    monkeypatch.setattr(sdk_client, "default_credentials", lambda *a, **k: None, raising=False)


def test_a_client_with_no_credentials_is_unavailable(monkeypatch):
    _no_auto_discovery(monkeypatch)
    with pytest.raises(QueryUnavailable, match="credentials"):
        llm._get_client()
    assert llm.available() is False


def test_an_api_key_in_the_environment_makes_the_client_available(monkeypatch):
    _no_auto_discovery(monkeypatch)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    assert llm._get_client().api_key == "sk-ant-test"
    assert llm.available() is True
