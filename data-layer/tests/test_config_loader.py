"""Fleet config: hubs by kubeconfig or by api_url + auth, with shared defaults."""
import pytest

from app.config_loader import load_config


def _write(tmp_path, text):
    path = tmp_path / "fleet.yaml"
    path.write_text(text)
    return str(path)


def test_hub_with_api_url_merges_the_default_auth(tmp_path, monkeypatch):
    monkeypatch.setenv("OCP_PASSWORD", "s3cret")
    cfg = load_config(_write(tmp_path, """
defaults:
  auth: {type: password, username: svc, password: "${OCP_PASSWORD}"}
  insecure_skip_tls_verify: true
hubs:
  - name: acm-east
    region: us-east-1
    api_url: https://api.acm-east.example.com:6443
  - name: acm-west
    api_url: https://api.acm-west.example.com:6443
    auth: {type: token, token: t0k3n}
    managed_access: shared
    insecure_skip_tls_verify: false
"""))
    east, west = cfg.hubs
    assert east.api_url.startswith("https://") and east.kubeconfig is None
    assert east.auth == {"type": "password", "username": "svc", "password": "s3cret"}
    assert east.insecure_skip_tls_verify is True and east.managed_access == "auto"
    assert west.auth["type"] == "token" and west.auth["username"] == "svc"   # merged over defaults
    assert west.managed_access == "shared" and west.insecure_skip_tls_verify is False


def test_hub_with_kubeconfig_is_unchanged(tmp_path):
    cfg = load_config(_write(tmp_path, """
hubs:
  - {name: hub-east, region: us-east-1, datacenter: iad1, kubeconfig: /fleet/hub-east.kubeconfig}
"""))
    hub = cfg.hubs[0]
    assert hub.kubeconfig == "/fleet/hub-east.kubeconfig" and hub.api_url is None
    assert hub.auth == {} and hub.managed_access == "auto"


def test_hub_needs_a_way_in(tmp_path):
    with pytest.raises(ValueError, match="needs 'kubeconfig' or 'api_url'"):
        load_config(_write(tmp_path, "hubs:\n  - {name: nowhere}\n"))
    with pytest.raises(ValueError, match="managed_access"):
        load_config(_write(tmp_path,
                           "hubs:\n  - {name: h, api_url: https://h, managed_access: magic}\n"))


def test_defaults_managed_access_and_url_template_apply_to_every_hub(tmp_path):
    cfg = load_config(_write(tmp_path, """
defaults:
  auth: {type: token, token: t}
  managed_access: shared
  managed_api_url: "https://api.{name}.ocp.example.net:6443"
hubs:
  - {name: a, api_url: https://a}
  - {name: b, api_url: https://b, managed_access: auto}
"""))
    a, b = cfg.hubs
    assert a.managed_access == "shared" and b.managed_access == "auto"
    assert a.managed_api_url == b.managed_api_url == "https://api.{name}.ocp.example.net:6443"
