"""The guarantee: no ConfigMap / Secret / env value survives parsing."""
import base64
import json

from app.collector import parsers, scrub
from tests.conftest import make_cert_pem

SECRET_VALUE = "hunter2-super-secret"
CM_VALUE = "feature.flags=on\napi.key=DO-NOT-LEAK"


def _walk(obj):
    """Every string anywhere inside a nested structure."""
    if isinstance(obj, dict):
        for v in obj.values():
            yield from _walk(v)
    elif isinstance(obj, list | tuple | set):
        for v in obj:
            yield from _walk(v)
    elif isinstance(obj, str):
        yield obj


def test_secret_values_never_survive(manifest):
    pem, key = make_cert_pem(days=10)
    sec = {
        "metadata": {"name": "app-credentials", "namespace": "payments",
                     "annotations": {"kubectl.kubernetes.io/last-applied-configuration":
                                     json.dumps({"data": {"password": SECRET_VALUE}})}},
        "type": "kubernetes.io/tls",
        "data": {"password": base64.b64encode(SECRET_VALUE.encode()).decode(),
                 "tls.crt": base64.b64encode(pem).decode(),
                 "tls.key": base64.b64encode(key).decode()},
    }
    row = parsers.parse_secret(sec, manifest)
    blob = json.dumps(row, default=str)
    assert SECRET_VALUE not in blob
    assert "BEGIN CERTIFICATE" not in blob
    assert "PRIVATE KEY" not in blob
    assert base64.b64encode(SECRET_VALUE.encode()).decode() not in blob
    assert "last-applied-configuration" not in blob
    # facts are kept
    assert [k["key"] for k in row["summary"]["keys"]] == ["password", "tls.crt", "tls.key"]
    assert row["summary"]["keys"][0]["bytes"] == len(SECRET_VALUE)
    assert row["status"] == "expiring"
    assert row["expires_at"] is not None
    assert row["summary"]["certificates"][0]["subject"] == "CN=test.example.com"
    assert row["summary"]["certificates"][0]["san_count"] == 1


def test_configmap_values_never_survive(manifest):
    pem, _ = make_cert_pem(cn="corp-ca", days=-5, ca=True, sans=())
    cm = {"metadata": {"name": "app-config", "namespace": "payments"},
          "data": {"application.properties": CM_VALUE, "ca-bundle.crt": pem.decode()},
          "binaryData": {"blob.bin": base64.b64encode(b"\x00\x01binary").decode()}}
    row = parsers.parse_configmap(cm, manifest)
    blob = json.dumps(row, default=str)
    assert "DO-NOT-LEAK" not in blob and CM_VALUE not in blob
    assert "BEGIN CERTIFICATE" not in blob
    assert {k["key"]: k["bytes"] for k in row["summary"]["keys"]} == {
        "application.properties": len(CM_VALUE), "ca-bundle.crt": len(pem), "blob.bin": 8}
    assert row["status"] == "expired"
    assert row["summary"]["certificates"][0]["is_ca"] is True


def test_env_values_dropped_but_refs_kept(manifest):
    dep = {
        "metadata": {"name": "api", "namespace": "payments", "labels": {"odl.io/team": "payments"}},
        "spec": {"replicas": 3, "template": {"spec": {
            "serviceAccountName": "api-sa",
            "imagePullSecrets": [{"name": "regcred"}],
            "containers": [{"name": "app", "image": "quay.io/acme/api:1.2.3",
                            "command": ["/bin/app", "--token", SECRET_VALUE],
                            "args": ["--password=" + SECRET_VALUE],
                            "env": [{"name": "LOG_LEVEL", "value": SECRET_VALUE},
                                    {"name": "DB_URL", "valueFrom": {"secretKeyRef": {
                                        "name": "app-credentials", "key": "url"}}},
                                    {"name": "FLAGS", "valueFrom": {"configMapKeyRef": {
                                        "name": "app-config", "key": "flags"}}},
                                    {"name": "NODE", "valueFrom": {"fieldRef": {
                                        "fieldPath": "spec.nodeName"}}}],
                            "envFrom": [{"configMapRef": {"name": "shared"}},
                                        {"secretRef": {"name": "shared-secret"}}]}],
            "volumes": [{"name": "tls", "secret": {"secretName": "app-tls"}},
                        {"name": "data", "persistentVolumeClaim": {"claimName": "app-data"}}]}}},
        "status": {"readyReplicas": 3, "availableReplicas": 3, "updatedReplicas": 3},
    }
    w = parsers.parse_workload(dep, "Deployment", manifest)
    blob = json.dumps(w, default=str)
    assert SECRET_VALUE not in blob
    env = {e["name"]: e.get("from") for e in w["containers"][0]["env"]}
    assert env["LOG_LEVEL"] == {"kind": "literal"}
    assert env["DB_URL"] == {"kind": "Secret", "name": "app-credentials", "key": "url"}
    assert env["FLAGS"] == {"kind": "ConfigMap", "name": "app-config", "key": "flags"}
    assert env["NODE"] == {"kind": "field", "path": "spec.nodeName"}
    refs = {(r["kind"], r["name"], r["via"]) for r in w["config_refs"]}
    assert refs == {
        ("Secret", "app-credentials", "env"), ("ConfigMap", "app-config", "env"),
        ("ConfigMap", "shared", "envFrom"), ("Secret", "shared-secret", "envFrom"),
        ("Secret", "app-tls", "volume"), ("PersistentVolumeClaim", "app-data", "volume"),
        ("Secret", "regcred", "imagePullSecret"), ("ServiceAccount", "api-sa", "serviceAccount")}
    assert w["status"] == "healthy" and w["images"] == ["quay.io/acme/api:1.2.3"]


def test_annotations_allowlist(manifest):
    ann = {"openshift.io/requester": "alice", "kubectl.kubernetes.io/last-applied-configuration": "{...}",
           "custom/whatever": "x"}
    assert scrub.scrub_annotations(ann, manifest.keep_annotations) == {"openshift.io/requester": "alice"}


def test_parse_cert_facts_ignores_garbage():
    assert scrub.parse_cert_facts(b"not a pem") == []
    assert scrub.cert_facts_from_data({"tls.crt": "!!!not-base64"}, b64=True) == []


def test_looks_like_cert_is_a_byte_check_that_hides_nothing():
    pem = b"-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----\n"
    # the marker at the start, whitespace tolerated, whatever the key is called
    assert scrub.looks_like_cert("anything", pem)
    assert scrub.looks_like_cert("anything", b"\n\n  " + pem)
    # a certificate-shaped key name reaches past a preamble
    assert scrub.looks_like_cert("ca-bundle.crt", b"Bag Attributes\n" + pem)
    assert scrub.looks_like_cert("whatever", b"Bag Attributes\n" + pem,
                                 "kubernetes.io/tls")
    # and nothing without the marker is worth parsing, whatever it is called
    assert not scrub.looks_like_cert("tls.crt", b"not a certificate")
    assert not scrub.looks_like_cert("tls.key", b"-----BEGIN PRIVATE KEY-----\nMIIE",
                                     "kubernetes.io/tls")
    assert not scrub.looks_like_cert("application.properties", b"db.password=hunter2")
    assert not scrub.looks_like_cert("x", b" " * 64 + pem)   # not "at the start"


def test_a_capped_bundle_still_leaks_nothing(manifest):
    pem, _ = make_cert_pem(cn="corp-ca", days=10, ca=True, sans=())
    cm = {"metadata": {"name": "trusted-ca-bundle", "namespace": "openshift-config"},
          "data": {"ca-bundle.crt": (pem * (scrub.MAX_CERTS_PER_KEY + 3)).decode()}}
    row = parsers.parse_configmap(cm, manifest)
    blob = json.dumps(row, default=str)
    assert "BEGIN CERTIFICATE" not in blob
    assert len(row["summary"]["certificates"]) == scrub.MAX_CERTS_PER_KEY
    # the expiry still comes from the certificates that were read
    assert row["status"] == "expiring" and row["expires_at"] is not None
