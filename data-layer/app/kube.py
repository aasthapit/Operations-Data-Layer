"""
Thin wrappers around the Kubernetes client.

The collector talks to two kinds of cluster:
  * hubs - reached via a kubeconfig file on disk (mounted from the fleet)
  * managed clusters - reached via a kubeconfig pulled from a Secret on the hub

Everything funnels through `ApiBundle`, which carries the typed clients we need.
Pointing this at a real ACM hub later is purely a matter of supplying real
kubeconfigs - no code changes.
"""
import base64
import tempfile
from dataclasses import dataclass

import yaml
from kubernetes import client, config


@dataclass
class ApiBundle:
    api_client: client.ApiClient

    @property
    def core(self):
        return client.CoreV1Api(self.api_client)

    @property
    def apps(self):
        return client.AppsV1Api(self.api_client)

    @property
    def custom(self):
        return client.CustomObjectsApi(self.api_client)


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


# --- OpenShift / ACM custom resource accessors --------------------------------
OCP_GROUP = "config.openshift.io"
ACM_GROUP = "cluster.open-cluster-management.io"


def get_clusterversion(b: ApiBundle):
    return b.custom.get_cluster_custom_object(
        OCP_GROUP, "v1", "clusterversions", "version"
    )


def list_clusteroperators(b: ApiBundle):
    return b.custom.list_cluster_custom_object(
        OCP_GROUP, "v1", "clusteroperators"
    ).get("items", [])


def get_infrastructure(b: ApiBundle):
    return b.custom.get_cluster_custom_object(
        OCP_GROUP, "v1", "infrastructures", "cluster"
    )


def list_managedclusters(b: ApiBundle):
    return b.custom.list_cluster_custom_object(
        ACM_GROUP, "v1", "managedclusters"
    ).get("items", [])


def read_kubeconfig_secret(b: ApiBundle, namespace: str, name: str) -> str:
    secret = b.core.read_namespaced_secret(name, namespace)
    raw = (secret.data or {}).get("kubeconfig")
    if raw is None:
        raise KeyError(f"secret {namespace}/{name} has no 'kubeconfig' key")
    return base64.b64decode(raw).decode()


def parse_kubeconfig(kubeconfig: str) -> dict:
    return yaml.safe_load(kubeconfig)
