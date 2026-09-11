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
"""
import base64
import tempfile
from dataclasses import dataclass

import yaml
from kubernetes import client, config
from kubernetes.client.exceptions import ApiException

from .settings import settings


class ResourceUnavailable(RuntimeError):
    """The API group / kind is not served by this cluster (HTTP 404)."""


class ResourceForbidden(RuntimeError):
    """The collector's identity may not read this resource (HTTP 403)."""


@dataclass
class ApiBundle:
    api_client: client.ApiClient

    @property
    def core(self):
        return client.CoreV1Api(self.api_client)


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


def _call(b: ApiBundle, path: str, query: list) -> dict:
    return b.api_client.call_api(
        path, "GET",
        query_params=query,
        header_params={"Accept": "application/json"},
        response_type="object",
        auth_settings=["BearerToken"],
        _return_http_data_only=True,
        _request_timeout=60,
    )


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
                  page_size: int | None = None) -> list[dict]:
    """List a resource (cluster-wide unless `namespace`), following pagination."""
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
            body = _call(b, path, query)
        except ApiException as e:
            raise _translate(e, what) from e
        items.extend(body.get("items") or [])
        cont = (body.get("metadata") or {}).get("continue")
        if not cont:
            return items


def get_resource(b: ApiBundle, base_path: str, plural: str, name: str,
                 namespace: str | None = None) -> dict:
    path = resource_path(base_path, plural, namespace, name)
    try:
        return _call(b, path, [])
    except ApiException as e:
        raise _translate(e, path) from e


# --- ACM hub accessors ------------------------------------------------------------
ACM_GROUP = "cluster.open-cluster-management.io"


def list_managedclusters(b: ApiBundle):
    return list_resource(b, f"/apis/{ACM_GROUP}/v1", "managedclusters")


def read_kubeconfig_secret(b: ApiBundle, namespace: str, name: str) -> str:
    secret = b.core.read_namespaced_secret(name, namespace)
    raw = (secret.data or {}).get("kubeconfig")
    if raw is None:
        raise KeyError(f"secret {namespace}/{name} has no 'kubeconfig' key")
    return base64.b64decode(raw).decode()


def parse_kubeconfig(kubeconfig: str) -> dict:
    return yaml.safe_load(kubeconfig)
