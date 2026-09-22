"""
The generic resource access layer, over a stubbed api_client.

`kube.get_json` asks the kubernetes client for the *raw* urllib3 response
(`_preload_content=False`) and parses the bytes itself with orjson, so these
tests stand in for the client exactly where that contract lives: a fake
`call_api` that hands back an object with `.data` bytes, and - for a non-2xx -
that raises `ApiException(http_resp=...)` the way `rest.py` does for a
non-preloaded response. The last test pins that assumption against the real
urllib3 response class, so a client or urllib3 upgrade that breaks it fails
here rather than in a sweep.
"""
import base64
import io
import json
import pathlib
import threading

import orjson
import pytest
import urllib3
from kubernetes.client.exceptions import ApiException

from app import kube
from app.settings import settings


# --------------------------------------------------------------------------- #
# stubs
# --------------------------------------------------------------------------- #
class _Resp:
    """What urllib3 returns when the client does not preload the content."""

    def __init__(self, payload: bytes, status: int = 200, reason: str = "OK"):
        self.data = payload
        self.status = status
        self.reason = reason
        self.released = False

    def getheaders(self):
        return {"content-type": "application/json"}

    def release_conn(self):
        self.released = True


class FakeApiClient:
    """Replays queued responses and records how it was called."""

    def __init__(self, *responses):
        self.queued = list(responses)
        self.calls: list[dict] = []
        self.responses: list[_Resp] = []

    def call_api(self, path, method, query_params=None, header_params=None,
                 auth_settings=None, _return_http_data_only=None,
                 _preload_content=None, _request_timeout=None, **kwargs):
        self.calls.append({
            "path": path, "method": method, "query": list(query_params or []),
            "headers": dict(header_params or {}), "auth": list(auth_settings or []),
            "data_only": _return_http_data_only, "preload": _preload_content,
            "timeout": _request_timeout, "extra": kwargs,
        })
        nxt = self.queued.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        self.responses.append(nxt)
        return nxt


def _page(items, cont=None) -> _Resp:
    body = {"apiVersion": "v1", "kind": "SecretList",
            "metadata": {"resourceVersion": "1", **({"continue": cont} if cont else {})},
            "items": items}
    return _Resp(orjson.dumps(body))


def _obj(name="ocp-1") -> dict:
    return {"apiVersion": "config.openshift.io/v1", "kind": "ClusterVersion",
            "metadata": {"name": name}, "spec": {"channel": "stable-4.16"}}


def _api_error(status: int, reason: str) -> ApiException:
    """Built the way rest.py builds it for a non-preloaded response."""
    return ApiException(http_resp=_Resp(b'{"message":"nope"}', status=status, reason=reason))


def _bundle(*responses) -> kube.ApiBundle:
    return kube.ApiBundle(FakeApiClient(*responses))


# --------------------------------------------------------------------------- #
# list_resource
# --------------------------------------------------------------------------- #
def test_list_resource_follows_pagination_into_one_list():
    p1 = _page([{"metadata": {"name": "a"}}, {"metadata": {"name": "b"}}], cont="TOKEN")
    p2 = _page([{"metadata": {"name": "c"}}])
    b = _bundle(p1, p2)

    items = kube.list_resource(b, "/api/v1", "secrets")

    assert [i["metadata"]["name"] for i in items] == ["a", "b", "c"]
    first, second = b.api_client.calls
    assert first["path"] == "/api/v1/secrets" and first["method"] == "GET"
    assert ("limit", settings.list_page_size) in first["query"]
    assert not [q for q in first["query"] if q[0] == "continue"]
    # the second page carries the continue token and the same page size
    assert ("continue", "TOKEN") in second["query"]
    assert ("limit", settings.list_page_size) in second["query"]


def test_list_resource_keeps_the_client_contract_the_parsing_depends_on():
    b = _bundle(_page([]))
    kube.list_resource(b, "/api/v1", "pods")
    call = b.api_client.calls[0]
    # raw bytes back, one value returned, JSON asked for, bearer auth, timeout kept
    assert call["preload"] is False and call["data_only"] is True
    assert call["headers"]["Accept"] == "application/json"
    assert call["auth"] == ["BearerToken"]
    assert call["timeout"] == kube.REQUEST_TIMEOUT_SECONDS
    # and the connection goes back to the pool
    assert all(r.released for r in b.api_client.responses)


def test_list_resource_passes_selectors_namespace_and_page_size():
    b = _bundle(_page([]))
    kube.list_resource(b, "/api/v1", "pods", namespace="payments",
                       field_selector="status.phase!=Running",
                       label_selector="odl.io/team=payments", page_size=42)
    call = b.api_client.calls[0]
    assert call["path"] == "/api/v1/namespaces/payments/pods"
    assert ("fieldSelector", "status.phase!=Running") in call["query"]
    assert ("labelSelector", "odl.io/team=payments") in call["query"]
    assert ("limit", 42) in call["query"]


# --------------------------------------------------------------------------- #
# stats
# --------------------------------------------------------------------------- #
def test_stats_accumulate_every_page_under_one_key():
    p1 = _page([{"metadata": {"name": "a"}}, {"metadata": {"name": "b"}}], cont="T")
    p2 = _page([{"metadata": {"name": "c"}}])
    b = _bundle(p1, p2)

    kube.list_resource(b, "/api/v1", "secrets", stat_key="secrets")

    assert list(b.stats) == ["secrets"]
    entry = b.stats["secrets"]
    assert entry["requests"] == 2
    assert entry["objects"] == 3
    assert entry["bytes"] == len(p1.data) + len(p2.data)
    assert entry["parse_ms"] >= 0.0 and entry["fetch_ms"] >= 0.0
    assert set(entry) == {"requests", "bytes", "objects", "parse_ms", "fetch_ms"}


def test_stats_key_defaults_to_the_request_path():
    b = _bundle(_page([{"metadata": {"name": "a"}}]))
    kube.list_resource(b, "/apis/route.openshift.io/v1", "routes")
    assert list(b.stats) == ["/apis/route.openshift.io/v1/routes"]


def test_reset_stats_clears_the_accumulator():
    b = _bundle(_page([]), _page([]))
    kube.list_resource(b, "/api/v1", "pods", stat_key="pods")
    b.reset_stats()
    assert b.stats == {}
    kube.list_resource(b, "/api/v1", "pods", stat_key="pods")
    assert b.stats["pods"]["requests"] == 1


def test_record_is_safe_from_several_threads():
    b = kube.ApiBundle(FakeApiClient())
    keys = [f"kind-{i}" for i in range(4)]

    def hammer(key):
        for _ in range(500):
            b.record(key, nbytes=10, objects=1, fetch_ms=0.1, parse_ms=0.05)

    threads = [threading.Thread(target=hammer, args=(k,)) for k in keys for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert sorted(b.stats) == keys
    for key in keys:
        entry = b.stats[key]
        assert entry["requests"] == 1000 and entry["bytes"] == 10_000 and entry["objects"] == 1000


# --------------------------------------------------------------------------- #
# error mapping
# --------------------------------------------------------------------------- #
def test_404_and_403_become_the_two_collector_errors():
    b = _bundle(_api_error(404, "Not Found"))
    with pytest.raises(kube.ResourceUnavailable) as unavailable:
        kube.list_resource(b, "/apis/machineconfiguration.openshift.io/v1",
                           "machineconfigpools")
    assert "machineconfigpools" in str(unavailable.value)

    b = _bundle(_api_error(403, "Forbidden"))
    with pytest.raises(kube.ResourceForbidden):
        kube.list_resource(b, "/api/v1", "secrets")

    b = _bundle(_api_error(500, "Internal Server Error"))
    with pytest.raises(RuntimeError) as other:
        kube.list_resource(b, "/api/v1", "pods")
    assert "HTTP 500" in str(other.value)
    assert not isinstance(other.value, kube.ResourceUnavailable | kube.ResourceForbidden)


def test_get_resource_maps_errors_and_names_the_object():
    b = _bundle(_api_error(403, "Forbidden"))
    with pytest.raises(kube.ResourceForbidden) as e:
        kube.get_resource(b, "/apis/config.openshift.io/v1", "clusterversions", "version")
    assert "/apis/config.openshift.io/v1/clusterversions/version" in str(e.value)


def test_a_body_that_is_not_json_is_an_error_naming_the_path():
    b = _bundle(_Resp(b"<html>gateway timeout</html>"))
    with pytest.raises(RuntimeError) as e:
        kube.list_resource(b, "/api/v1", "pods")
    assert "/api/v1/pods" in str(e.value) and "not JSON" in str(e.value)
    # the request is still counted, so a broken cluster shows its bytes
    assert b.stats["/api/v1/pods"]["requests"] == 1


# --------------------------------------------------------------------------- #
# get_resource
# --------------------------------------------------------------------------- #
def test_get_resource_returns_the_object_and_counts_it_as_one():
    b = _bundle(_Resp(orjson.dumps(_obj())))
    got = kube.get_resource(b, "/apis/config.openshift.io/v1", "clusterversions", "version")
    assert got["metadata"]["name"] == "ocp-1"
    call = b.api_client.calls[0]
    assert call["path"] == "/apis/config.openshift.io/v1/clusterversions/version"
    assert call["query"] == []
    assert b.stats[call["path"]] == {
        "requests": 1, "bytes": len(b.api_client.responses[0].data), "objects": 1,
        "parse_ms": b.stats[call["path"]]["parse_ms"], "fetch_ms": b.stats[call["path"]]["fetch_ms"]}


def test_get_json_parses_utf8_bytes_the_client_would_have_decoded():
    payload = {"metadata": {"name": "ingress"}, "message": "café · ünicode"}
    b = _bundle(_Resp(json.dumps(payload).encode()))
    assert kube.get_json(b, "/apis/config.openshift.io/v1/ingresses/cluster") == payload


# --------------------------------------------------------------------------- #
# the assumption the whole approach rests on
# --------------------------------------------------------------------------- #
def test_apiexception_still_reads_status_from_a_raw_urllib3_response():
    """`_preload_content=False` means rest.py builds ApiException from the raw
    urllib3 response, so `_translate` depends on that object exposing status,
    reason, data and getheaders(). Pin it."""
    raw = urllib3.HTTPResponse(body=io.BytesIO(b'{"message":"forbidden"}'), status=403,
                               reason="Forbidden",
                               headers={"content-type": "application/json"},
                               preload_content=False)
    e = ApiException(http_resp=raw)
    assert e.status == 403 and e.reason == "Forbidden"
    assert isinstance(kube._translate(e, "secrets"), kube.ResourceForbidden)


# --------------------------------------------------------------------------- #
# building a client for a cluster
# --------------------------------------------------------------------------- #
def test_a_bundle_from_a_kubeconfig_file_wraps_the_client_the_loader_built(monkeypatch):
    seen = {}

    def load(config_file):
        seen["path"] = config_file
        return "api-client"

    monkeypatch.setattr(kube.config, "new_client_from_config", load)
    bundle = kube.bundle_from_file("/fleet/hub-east.kubeconfig")
    assert bundle.api_client == "api-client"
    assert seen["path"] == "/fleet/hub-east.kubeconfig"
    assert bundle.stats == {}


def test_a_kubeconfig_that_only_exists_in_memory_is_written_out_for_the_loader(monkeypatch):
    """ACM hands the managed cluster's kubeconfig over as a Secret value, and
    the client can only load one from a path."""
    written = {}

    def load(config_file):
        written["path"] = config_file
        written["content"] = pathlib.Path(config_file).read_text()
        return "api-client"

    monkeypatch.setattr(kube.config, "new_client_from_config", load)
    kubeconfig = "apiVersion: v1\nclusters: []\n"
    assert kube.bundle_from_kubeconfig_str(kubeconfig).api_client == "api-client"
    assert written["content"] == kubeconfig
    assert written["path"].endswith(".kubeconfig")


def test_an_endpoint_bundle_carries_the_bearer_token_and_verifies_tls():
    bundle = kube.bundle_from_endpoint("https://api.ocp-east-1.example.com:6443",
                                       "sha256~abc")
    cfg = bundle.api_client.configuration
    assert cfg.host == "https://api.ocp-east-1.example.com:6443"
    assert cfg.api_key == {"authorization": "Bearer sha256~abc"}
    assert cfg.verify_ssl is True and cfg.ssl_ca_cert is None


def test_a_custom_ca_is_used_instead_of_the_system_trust_store():
    cfg = kube.bundle_from_endpoint("https://api.example.com:6443", "t",
                                    ca_cert="/etc/pki/ingress-ca.crt").api_client.configuration
    assert cfg.ssl_ca_cert == "/etc/pki/ingress-ca.crt" and cfg.verify_ssl is True


def test_turning_verification_off_also_silences_the_warning_it_would_print_per_request():
    """Thousands of InsecureRequestWarning lines per sweep would bury the log
    the operator actually has to read."""
    silenced = []
    original = urllib3.disable_warnings
    urllib3.disable_warnings = lambda category=None: silenced.append(category)
    try:
        cfg = kube.bundle_from_endpoint("https://api.example.com:6443", "t",
                                        verify=False).api_client.configuration
    finally:
        urllib3.disable_warnings = original
    assert cfg.verify_ssl is False
    assert silenced == [urllib3.exceptions.InsecureRequestWarning]


def test_the_core_api_is_built_on_the_bundle_s_own_client():
    bundle = _bundle()
    assert bundle.core.api_client is bundle.api_client


# --------------------------------------------------------------------------- #
# ACM hub accessors
# --------------------------------------------------------------------------- #
def test_managed_clusters_are_listed_under_their_own_stat_key():
    b = _bundle(_page([{"metadata": {"name": "ocp-east-1"}}]))
    assert [c["metadata"]["name"] for c in kube.list_managedclusters(b)] == ["ocp-east-1"]
    assert b.api_client.calls[0]["path"] == \
        "/apis/cluster.open-cluster-management.io/v1/managedclusters"
    assert list(b.stats) == ["managedclusters"]


class _Core:
    def __init__(self, data):
        self.data = data
        self.read = []

    def read_namespaced_secret(self, name, namespace):
        self.read.append((namespace, name))
        return type("Secret", (), {"data": self.data})()


def test_a_hub_secret_yields_the_managed_cluster_s_kubeconfig(monkeypatch):
    core = _Core({"kubeconfig": base64.b64encode(b"apiVersion: v1\n").decode()})
    monkeypatch.setattr(kube.ApiBundle, "core", property(lambda self: core))
    b = _bundle()
    assert kube.read_kubeconfig_secret(b, "ocp-east-1", "ocp-east-1-admin-kubeconfig") == \
        "apiVersion: v1\n"
    assert core.read == [("ocp-east-1", "ocp-east-1-admin-kubeconfig")]


def test_a_secret_without_a_kubeconfig_key_names_the_secret(monkeypatch):
    """ACM's secret layout differs by version; the message has to say which
    secret was wrong, not just that something was."""
    monkeypatch.setattr(kube.ApiBundle, "core", property(lambda self: _Core({"tls.crt": "x"})))
    with pytest.raises(KeyError, match="ocp-east-1/admin has no 'kubeconfig' key"):
        kube.read_kubeconfig_secret(_bundle(), "ocp-east-1", "admin")


def test_a_secret_with_no_data_at_all_is_the_same_error(monkeypatch):
    monkeypatch.setattr(kube.ApiBundle, "core", property(lambda self: _Core(None)))
    with pytest.raises(KeyError, match="no 'kubeconfig' key"):
        kube.read_kubeconfig_secret(_bundle(), "ns", "admin")


def test_a_kubeconfig_is_parsed_as_yaml():
    parsed = kube.parse_kubeconfig("apiVersion: v1\nclusters:\n- name: hub\n")
    assert parsed["clusters"] == [{"name": "hub"}]


# --------------------------------------------------------------------------- #
# answers that are JSON but not an object
# --------------------------------------------------------------------------- #
def test_a_json_array_where_an_object_was_expected_names_the_path_and_the_type():
    """A proxy or an auth portal answering with something else must not be fed
    to a parser that assumes `.get`."""
    b = _bundle(_Resp(b'["not", "an", "object"]'))
    with pytest.raises(RuntimeError, match=r"/api/v1/nodes: expected a JSON object, got list"):
        kube.get_json(b, "/api/v1/nodes")
    # The bytes still count: a sweep's transfer stats must not lie because one
    # cluster answered badly.
    assert b.stats["/api/v1/nodes"]["bytes"] == len(b.api_client.responses[0].data)
