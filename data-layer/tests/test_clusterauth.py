"""
Resolving a bearer token for a cluster from its configured auth.

The username/password case is the one with real behaviour in it: OpenShift's
API server does not take basic auth, so `oc login -u -p` runs an OAuth
"challenging client" flow and fishes the token out of a redirect fragment.
These tests drive that flow over a stubbed `requests` - the two calls it makes,
the headers and the query it sends, what it does with a 401, and what it does
with a redirect that carries no token - because getting any of it subtly wrong
shows up as a whole fleet going unreachable at the next sweep.

The token cache is exercised too: a sweep must not re-authenticate once per
cluster, and `invalidate` has to actually force the next one.
"""
import urllib.parse

import pytest

from app import clusterauth
from app.clusterauth import AuthError, resolve_bearer_token

API = "https://api.ocp-east-1.example.com:6443"
AUTHORIZE = "https://oauth-openshift.apps.ocp-east-1.example.com/oauth/authorize"


class _Response:
    def __init__(self, status_code=200, payload=None, headers=None):
        self.status_code = status_code
        self._payload = payload
        self.headers = headers or {}

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


def _redirect(token="sha256~abc123"):
    location = f"https://oauth-openshift.example.com/oauth/token/implicit#access_token={token}"
    return _Response(302, headers={"Location": location})


@pytest.fixture(autouse=True)
def empty_cache():
    clusterauth._CACHE.clear()
    yield
    clusterauth._CACHE.clear()


@pytest.fixture
def oauth(monkeypatch):
    """A cluster whose OAuth server answers the challenge flow. Returns the
    recorded calls so a test can assert what went over the wire."""
    calls = []
    answers = {
        "discovery": _Response(200, {"authorization_endpoint": AUTHORIZE}),
        "authorize": _redirect(),
    }

    def fake_get(url, **kwargs):
        calls.append((url, kwargs))
        which = "discovery" if url.endswith("oauth-authorization-server") else "authorize"
        answer = answers[which]
        if isinstance(answer, Exception):
            raise answer
        return answer

    monkeypatch.setattr(clusterauth.requests, "get", fake_get)
    return type("OAuth", (), {"calls": calls, "answers": answers})()


# --------------------------------------------------------------------------- #
# dispatch by auth type
# --------------------------------------------------------------------------- #
def test_a_configured_token_is_returned_as_is():
    assert resolve_bearer_token(API, {"type": "token", "token": "sha256~t"}) == "sha256~t"


def test_token_auth_without_a_token_names_the_missing_field():
    with pytest.raises(AuthError, match="auth.type=token requires 'token'"):
        resolve_bearer_token(API, {"type": "token"})


def test_kubeconfig_auth_resolves_no_bearer_token():
    """The kubernetes client loads the credentials itself in that case."""
    assert resolve_bearer_token(API, {"type": "kubeconfig"}) is None
    assert resolve_bearer_token(API, {}) is None
    assert resolve_bearer_token(API, None) is None


def test_password_auth_without_both_halves_names_the_missing_fields():
    with pytest.raises(AuthError, match="requires 'username' and 'password'"):
        resolve_bearer_token(API, {"type": "password", "username": "svc"})
    with pytest.raises(AuthError, match="requires 'username' and 'password'"):
        resolve_bearer_token(API, {"type": "password", "password": "s3cr3t"})


def test_an_unknown_auth_type_is_rejected_by_name():
    with pytest.raises(AuthError, match="unsupported auth.type: saml"):
        resolve_bearer_token(API, {"type": "saml"})


# --------------------------------------------------------------------------- #
# the oc login challenge flow
# --------------------------------------------------------------------------- #
def test_a_password_grant_discovers_the_oauth_server_then_takes_the_token_from_the_fragment(oauth):
    token = resolve_bearer_token(API, {"type": "password", "username": "svc",
                                       "password": "s3cr3t"})
    assert token == "sha256~abc123"

    discovery_url, discovery_kwargs = oauth.calls[0]
    assert discovery_url == f"{API}/.well-known/oauth-authorization-server"
    assert discovery_kwargs["verify"] is True and discovery_kwargs["timeout"] == 15

    authorize_url, authorize_kwargs = oauth.calls[1]
    assert authorize_url == AUTHORIZE
    assert authorize_kwargs["params"] == {"client_id": "openshift-challenging-client",
                                          "response_type": "token"}
    # Without the CSRF header OpenShift answers a login form instead of a
    # challenge, and without allow_redirects=False requests would follow the
    # 302 and throw the fragment away.
    assert authorize_kwargs["headers"] == {"X-CSRF-Token": "1"}
    assert authorize_kwargs["auth"] == ("svc", "s3cr3t")
    assert authorize_kwargs["allow_redirects"] is False


def test_a_trailing_slash_on_the_api_url_does_not_double_up(oauth):
    resolve_bearer_token(API + "/", {"type": "password", "username": "svc",
                                     "password": "s3cr3t"})
    assert oauth.calls[0][0] == f"{API}/.well-known/oauth-authorization-server"


def test_tls_verification_choices_reach_both_requests(oauth):
    resolve_bearer_token(API, {"type": "password", "username": "svc", "password": "s3cr3t"},
                         verify="/etc/pki/ca.crt")
    assert [kwargs["verify"] for _url, kwargs in oauth.calls] == \
        ["/etc/pki/ca.crt", "/etc/pki/ca.crt"]


def test_bad_credentials_are_reported_with_the_user_and_the_cluster(oauth):
    oauth.answers["authorize"] = _Response(401)
    with pytest.raises(AuthError, match=f"invalid credentials for svc at {API}"):
        resolve_bearer_token(API, {"type": "password", "username": "svc", "password": "wrong"})


def test_a_redirect_without_an_access_token_is_an_auth_error_carrying_the_status(oauth):
    oauth.answers["authorize"] = _Response(
        302, headers={"Location": "https://oauth.example.com/login?then=%2Foauth"})
    with pytest.raises(AuthError, match=r"did not return a token \(status 302\)"):
        resolve_bearer_token(API, {"type": "password", "username": "svc", "password": "s"})


def test_an_answer_with_no_location_header_at_all_is_an_auth_error(oauth):
    oauth.answers["authorize"] = _Response(200)
    with pytest.raises(AuthError, match="did not return a token"):
        resolve_bearer_token(API, {"type": "password", "username": "svc", "password": "s"})


def test_an_oauth_server_that_cannot_be_discovered_fails_loudly(oauth):
    oauth.answers["discovery"] = _Response(503)
    with pytest.raises(RuntimeError, match="HTTP 503"):
        resolve_bearer_token(API, {"type": "password", "username": "svc", "password": "s"})


def test_a_token_with_url_escapes_in_the_fragment_survives_parsing(oauth):
    raw = "sha256~a+b/c=="
    oauth.answers["authorize"] = _redirect(urllib.parse.quote(raw, safe=""))
    assert resolve_bearer_token(
        API, {"type": "password", "username": "svc", "password": "s"}) == raw


# --------------------------------------------------------------------------- #
# the token cache
# --------------------------------------------------------------------------- #
def test_a_sweep_authenticates_once_per_user_and_cluster(oauth):
    auth = {"type": "password", "username": "svc", "password": "s3cr3t"}
    first = resolve_bearer_token(API, auth)
    second = resolve_bearer_token(API, auth)
    assert first == second
    assert len(oauth.calls) == 2, "the second cluster reused the cached token"


def test_each_cluster_gets_its_own_cache_entry(oauth):
    auth = {"type": "password", "username": "svc", "password": "s3cr3t"}
    resolve_bearer_token(API, auth)
    resolve_bearer_token("https://api.ocp-west-1.example.com:6443", auth)
    assert set(clusterauth._CACHE) == {
        (API, "svc"), ("https://api.ocp-west-1.example.com:6443", "svc")}
    assert len(oauth.calls) == 4


def test_an_expired_cache_entry_is_replaced_rather_than_served(oauth):
    clusterauth._CACHE[(API, "svc")] = ("stale-token", 0)
    token = resolve_bearer_token(API, {"type": "password", "username": "svc",
                                       "password": "s3cr3t"})
    assert token == "sha256~abc123"


def test_invalidating_forces_the_next_call_to_re_authenticate(oauth):
    auth = {"type": "password", "username": "svc", "password": "s3cr3t"}
    resolve_bearer_token(API, auth)
    clusterauth.invalidate(API, "svc")
    assert (API, "svc") not in clusterauth._CACHE

    oauth.answers["authorize"] = _redirect("sha256~rotated")
    assert resolve_bearer_token(API, auth) == "sha256~rotated"


def test_invalidating_something_that_was_never_cached_is_harmless():
    clusterauth.invalidate(API, "nobody")
