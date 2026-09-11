import os
import sys
from datetime import UTC, datetime, timedelta

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
os.environ.setdefault("ODL_MANIFEST", os.path.join(ROOT, "config", "ocp-api-manifest.yaml"))
os.environ.setdefault("ODL_CONFIG", os.path.join(ROOT, "config", "hubs.yaml"))

from app.manifest import load_manifest  # noqa: E402


@pytest.fixture(scope="session")
def manifest():
    return load_manifest()


def make_cert_pem(cn="test.example.com", days=365, ca=False, sans=("test.example.com",)):
    """A self-signed certificate PEM valid for `days` from now (negative = expired)."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])
    now = datetime.now(UTC)
    builder = (x509.CertificateBuilder()
               .subject_name(name).issuer_name(name).public_key(key.public_key())
               .serial_number(x509.random_serial_number())
               .not_valid_before(now - timedelta(days=400))
               .not_valid_after(now + timedelta(days=days))
               .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True))
    if sans:
        builder = builder.add_extension(
            x509.SubjectAlternativeName([x509.DNSName(s) for s in sans]), critical=False)
    cert = builder.sign(key, hashes.SHA256())
    return cert.public_bytes(serialization.Encoding.PEM), key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption())
