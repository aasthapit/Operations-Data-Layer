"""
Thin wrappers around the Kubernetes client.

The collector talks to two kinds of cluster:
  * hubs - reached via a kubeconfig file on disk (mounted from the fleet)
  * managed clusters - reached via a kubeconfig pulled from a Secret on the hub,
    or directly via a bearer token (see clusterauth.py)

Everything funnels through `ApiBundle`. Resources are read generically -
`list_resource` / `get_resource` speak to any API group by path and return
plain dicts - so a new resource kind is a registry entry, not a new client.
Pointing this at a real ACM hub is purely a matter of supplying real
kubeconfigs / tokens; no code changes.

Two things here are about cost rather than reach:

**We deserialise the response ourselves.** The generated client would decode
the body to `str` and hand it to `json.loads`, then walk the result once more
through its own `deserialize("object")`. Every byte a cluster returns passes
through that, and a large cluster returns ~120 MB per sweep (ADR-0003,
Finding 1), so it is the collector's single hottest loop. Asking `call_api`
for `_preload_content=False` gives the raw urllib3 response instead; we read
`.data` (bytes) and parse with `orjson`, which is ~1.8x the throughput of the
client's path on a 50 MB list and skips the intermediate `str` entirely.
Error handling is unchanged: the client still raises `ApiException` with the
status and reason for a non-2xx, so `_translate` keeps mapping 404 / 403 to
the two "this cluster cannot answer that" errors.

**Every call is measured.** `ApiBundle.stats` accumulates requests, bytes,
objects, HTTP time and parse time per `stat_key` (the manifest key the
collector is fetching, defaulting to the request path). That is what makes
"where does the collector's time go - network or CPU?" answerable per cluster
and per kind instead of guessable, which is the question that decides whether
a Go collector is worth writing. Kinds are fetched concurrently, so the
accumulator takes a lock.
"""
import base64
import tempfile
import threading
import time
from dataclasses import dataclass, field

import orjson
import yaml
from kubernetes import client, config
from kubernetes.client.exceptions import ApiException

from .settings import settings

# Wall-clock budget for one request (connect + read), as before.
REQUEST_TIMEOUT_SECONDS = 60


class ResourceUnavailable(RuntimeError):
    """The API group / kind is not served by this cluster (HTTP 404)."""


class ResourceForbidden(RuntimeError):
    """The collector's identity may not read this resource (HTTP 403)."""


def _new_stat() -> dict:
    """The per-key counters. `bytes` is wire-length after transfer decoding."""
    return {"requests": 0, "bytes": 0, "objects": 0, "parse_ms": 0.0, "fetch_ms": 0.0}


@dataclass
class ApiBundle:
    api_client: client.ApiClient
    # stat_key -> {"requests", "bytes", "objects", "parse_ms", "fetch_ms"}
    stats: dict[str, dict] = field(default_factory=dict)

    def __post_init__(self):
        # Not a dataclass field: a lock is neither comparable nor printable,
        # and the bundle is constructed positionally all over the collector.
        self._stats_lock = threading.Lock()

    @property
    def core(self):
        return client.CoreV1Api(self.api_client)

    def record(self, stat_key: str, *, requests: int = 1, nbytes: int = 0, objects: int = 0,
               fetch_ms: float = 0.0, parse_ms: float = 0.0) -> None:
        """Add one request's measurements to `stat_key`.

        In practice one thread owns one key (one kind per fetch worker), but
        the dict itself is shared, so the mutation is done under a lock.
        """
        with self._stats_lock:
            entry = self.stats.get(stat_key)
            if entry is None:
                entry = self.stats[stat_key] = _new_stat()
            entry["requests"] += requests
            entry["bytes"] += nbytes
            entry["objects"] += objects
            # Rounded as they accumulate: microsecond precision is noise here,
            # and these end up in a JSON document.
            entry["fetch_ms"] = round(entry["fetch_ms"] + fetch_ms, 3)
            entry["parse_ms"] = round(entry["parse_ms"] + parse_ms, 3)

    def reset_stats(self) -> None:
        """Forget every measurement (the collector calls this per sweep, so a
        bundle reused across sweeps reports the sweep it is in)."""
        with self._stats_lock:
            self.stats.clear()


def bundle_from_file(path: str) -> ApiBundle:
    return ApiBundle(config.new_client_from_config(config_file=path))


def bundle_from_kubeconfig_str(kubeconfig: str) -> ApiBundle:
    # The client loads from a path; write the kubeconfig to a temp file. (kind's
    # internal kubeconfigs embed certs inline, so the temp file is self-contained.)
    with tempfile.NamedTemporaryFile("w", suffix=".kubeconfig", delete=False) as f:
        f.write(kubeconfig)
        path = f.name
    return ApiBundle(config.new_client_from_config(config_file=path))


def bundle_from_endpoint(api_url: str, token: str, verify=True,
                         ca_cert: str = None) -> ApiBundle:
    """Build a client for a live OCP endpoint authenticated with a bearer token
    (the token a service account's user/pass resolves to via OAuth)."""
    cfg = client.Configuration()
    cfg.host = api_url
    cfg.api_key = {"authorization": f"Bearer {token}"}
    cfg.verify_ssl = bool(verify)
    if ca_cert:
        cfg.ssl_ca_cert = ca_cert
    if not verify:
        import urllib3
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    return ApiBundle(client.ApiClient(cfg))


# --- generic resource access ---------------------------------------------------
def _translate(e: ApiException, what: str):
    if e.status == 404:
        return ResourceUnavailable(f"{what}: not served by this cluster")
    if e.status == 403:
        return ResourceForbidden(f"{what}: forbidden for the collector identity")
    return RuntimeError(f"{what}: HTTP {e.status} {e.reason}")


def get_json(b: ApiBundle, path: str, query: list | None = None,
             stat_key: str | None = None) -> dict:
    """GET `path` and return the decoded body.

    `_preload_content=False` makes `call_api` hand back the raw urllib3
    response rather than a decoded-and-deserialised object; the body is read
    once as bytes and parsed by orjson. A non-2xx is still raised by the
    client as `ApiException` (built from that same raw response), so callers
    keep catching exactly what they caught before.
    """
    key = stat_key or path
    t0 = time.perf_counter()
    resp = b.api_client.call_api(
        path, "GET",
        query_params=query or [],
        header_params={"Accept": "application/json"},
        auth_settings=["BearerToken"],
        _return_http_data_only=True,
        _preload_content=False,
        _request_timeout=REQUEST_TIMEOUT_SECONDS,
    )
    try:
        raw = resp.data or b""
    finally:
        # Reading `.data` to the end normally returns the connection to the
        # pool by itself; saying so explicitly costs nothing and keeps a
        # short-read path from leaking a connection.
        release = getattr(resp, "release_conn", None)
        if release is not None:
            release()
    fetch_ms = (time.perf_counter() - t0) * 1000

    t1 = time.perf_counter()
    try:
        body = orjson.loads(raw) if raw else {}
    except orjson.JSONDecodeError as e:
        b.record(key, nbytes=len(raw), fetch_ms=fetch_ms)
        raise RuntimeError(f"{path}: response was not JSON ({e})") from e
    parse_ms = (time.perf_counter() - t1) * 1000
    if not isinstance(body, dict):
        b.record(key, nbytes=len(raw), fetch_ms=fetch_ms, parse_ms=parse_ms)
        raise RuntimeError(f"{path}: expected a JSON object, got {type(body).__name__}")

    items = body.get("items")
    b.record(key, nbytes=len(raw), objects=len(items) if isinstance(items, list) else 1,
             fetch_ms=fetch_ms, parse_ms=parse_ms)
    return body


def resource_path(base_path: str, plural: str, namespace: str | None = None,
                  name: str | None = None) -> str:
    path = base_path
    if namespace:
        path += f"/namespaces/{namespace}"
    path += f"/{plural}"
    if name:
        path += f"/{name}"
    return path


def list_resource(b: ApiBundle, base_path: str, plural: str, namespace: str | None = None,
                  field_selector: str | None = None, label_selector: str | None = None,
                  page_size: int | None = None, stat_key: str | None = None) -> list[dict]:
    """List a resource (cluster-wide unless `namespace`), following pagination.

    Every page is measured under the same `stat_key`, so the stats entry for a
    kind covers the whole list however many round trips it took.
    """
    path = resource_path(base_path, plural, namespace)
    what = path
    items: list[dict] = []
    cont = None
    page_size = page_size or settings.list_page_size
    while True:
        query = [("limit", page_size)]
        if cont:
            query.append(("continue", cont))
        if field_selector:
            query.append(("fieldSelector", field_selector))
        if label_selector:
            query.append(("labelSelector", label_selector))
        try:
            body = get_json(b, path, query, stat_key=stat_key or path)
        except ApiException as e:
            raise _translate(e, what) from e
        items.extend(body.get("items") or [])
        cont = (body.get("metadata") or {}).get("continue")
        if not cont:
            return items


def get_resource(b: ApiBundle, base_path: str, plural: str, name: str,
                 namespace: str | None = None, stat_key: str | None = None) -> dict:
    path = resource_path(base_path, plural, namespace, name)
    try:
        return get_json(b, path, [], stat_key=stat_key or path)
    except ApiException as e:
        raise _translate(e, path) from e


# --- ACM hub accessors ------------------------------------------------------------
ACM_GROUP = "cluster.open-cluster-management.io"


def list_managedclusters(b: ApiBundle):
    return list_resource(b, f"/apis/{ACM_GROUP}/v1", "managedclusters",
                         stat_key="managedclusters")


def read_kubeconfig_secret(b: ApiBundle, namespace: str, name: str) -> str:
    secret = b.core.read_namespaced_secret(name, namespace)
    raw = (secret.data or {}).get("kubeconfig")
    if raw is None:
        raise KeyError(f"secret {namespace}/{name} has no 'kubeconfig' key")
    return base64.b64decode(raw).decode()


def parse_kubeconfig(kubeconfig: str) -> dict:
    return yaml.safe_load(kubeconfig)
