"""
Resolve a bearer token for an OpenShift cluster from its configured auth.

The interesting case is username/password. OpenShift's API server does not
accept HTTP basic auth; `oc login -u user -p pass` actually performs an OAuth2
"challenging client" flow against the cluster's OAuth server and pulls a bearer
token out of the redirect. We reproduce exactly that flow so a single service
account (user/pass) can be pointed at the whole fleet.

Tokens are cached briefly so we don't re-authenticate on every collection sweep.
"""
import threading
import time
import urllib.parse

import requests

_CACHE: dict[tuple, tuple] = {}      # (api_url, username) -> (token, expires_at)
_CACHE_TTL = 1800                    # 30 minutes
_lock = threading.Lock()


class AuthError(RuntimeError):
    pass


def resolve_bearer_token(api_url: str, auth: dict, verify=True) -> str | None:
    """Return a bearer token for the given auth, or None for kubeconfig auth."""
    atype = (auth or {}).get("type", "kubeconfig")
    if atype == "token":
        token = auth.get("token")
        if not token:
            raise AuthError("auth.type=token requires 'token'")
        return token
    if atype == "password":
        username = auth.get("username")
        password = auth.get("password")
        if not username or not password:
            raise AuthError("auth.type=password requires 'username' and 'password'")
        return _password_grant(api_url, username, password, verify)
    if atype == "kubeconfig":
        return None
    raise AuthError(f"unsupported auth.type: {atype}")


def _password_grant(api_url, username, password, verify) -> str:
    key = (api_url, username)
    now = time.time()
    with _lock:
        cached = _CACHE.get(key)
        if cached and cached[1] > now:
            return cached[0]

    token = _oauth_challenge(api_url, username, password, verify)
    with _lock:
        _CACHE[key] = (token, now + _CACHE_TTL)
    return token


def _oauth_challenge(api_url, username, password, verify) -> str:
    """The `oc login` challenge flow: discover the OAuth server, then request a
    token with a challenging client and basic credentials."""
    # 1. discover the cluster's OAuth authorization endpoint
    meta = requests.get(
        f"{api_url.rstrip('/')}/.well-known/oauth-authorization-server",
        verify=verify, timeout=15,
    )
    meta.raise_for_status()
    authorize = meta.json()["authorization_endpoint"]

    # 2. ask for an implicit token as the openshift-challenging-client; OpenShift
    #    answers a 302 whose Location fragment carries the access_token.
    resp = requests.get(
        authorize,
        params={"client_id": "openshift-challenging-client",
                "response_type": "token"},
        headers={"X-CSRF-Token": "1"},
        auth=(username, password),
        allow_redirects=False,
        verify=verify,
        timeout=15,
    )
    if resp.status_code == 401:
        raise AuthError(f"invalid credentials for {username} at {api_url}")
    location = resp.headers.get("Location", "")
    fragment = urllib.parse.urlparse(location).fragment
    token = urllib.parse.parse_qs(fragment).get("access_token", [None])[0]
    if not token:
        raise AuthError(
            f"OAuth challenge did not return a token (status {resp.status_code})")
    return token


def invalidate(api_url, username):
    with _lock:
        _CACHE.pop((api_url, username), None)
