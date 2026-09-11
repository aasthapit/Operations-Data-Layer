"""
Scrubbing - the one place that decides what sensitive material never leaves
the collector.

Policy (not configurable):
  * ConfigMap / Secret values are replaced by their key names and byte sizes.
  * Certificate PEMs are parsed into facts (subject, issuer, validity) and the
    PEM itself is discarded.
  * Container env `value`s are dropped; names and valueFrom references stay.
  * Annotations are dropped unless allow-listed (last-applied-configuration can
    carry a whole Secret).

Every function here is pure and is exercised by tests/test_scrub.py, which is
the guarantee that no value survives into a parsed dict.
"""
import base64
import binascii
from datetime import UTC, datetime

from cryptography import x509
from cryptography.hazmat.primitives import hashes

PEM_CERT_BEGIN = b"-----BEGIN CERTIFICATE-----"
CERT_KEY_SUFFIXES = (".crt", ".pem", ".cer", ".cert")
TLS_SECRET_TYPES = ("kubernetes.io/tls",)


def _b64_size(value: str) -> int:
    """Decoded byte size of a base64 Secret value (falls back to raw length)."""
    try:
        return len(base64.b64decode(value, validate=False))
    except (binascii.Error, ValueError, TypeError):
        return len(value or "")


def scrub_data(data: dict | None, binary_data: dict | None = None,
               b64: bool = False) -> tuple[list[dict], int]:
    """Return ([{key, bytes}], total_bytes) for a ConfigMap / Secret `data` map.
    Values are measured, never returned."""
    keys = []
    total = 0
    for k, v in sorted((data or {}).items()):
        size = _b64_size(v) if b64 else len(v or "")
        keys.append({"key": k, "bytes": size})
        total += size
    for k, v in sorted((binary_data or {}).items()):
        size = _b64_size(v)
        keys.append({"key": k, "bytes": size, "binary": True})
        total += size
    return keys, total


def looks_like_cert(key: str, value: bytes) -> bool:
    return key.lower().endswith(CERT_KEY_SUFFIXES) or value.lstrip().startswith(PEM_CERT_BEGIN)


def parse_cert_facts(pem: bytes) -> list[dict]:
    """Parse every certificate in a PEM bundle into non-sensitive facts."""
    try:
        certs = x509.load_pem_x509_certificates(pem)
    except (ValueError, TypeError):
        return []
    facts = []
    for c in certs:
        try:
            san = c.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
            san_count = len(san)
        except x509.ExtensionNotFound:
            san_count = 0
        try:
            is_ca = c.extensions.get_extension_for_class(x509.BasicConstraints).value.ca
        except x509.ExtensionNotFound:
            is_ca = False
        facts.append({
            "subject": c.subject.rfc4514_string(),
            "issuer": c.issuer.rfc4514_string(),
            "not_before": c.not_valid_before_utc.isoformat(),
            "not_after": c.not_valid_after_utc.isoformat(),
            "san_count": san_count,
            "is_ca": bool(is_ca),
            "fingerprint_sha256": c.fingerprint(hashes.SHA256()).hex()[:16],
        })
    return facts


def cert_facts_from_data(data: dict | None, b64: bool, secret_type: str | None = None) -> list[dict]:
    """Extract certificate facts from the PEM-looking keys of a data map."""
    facts = []
    for key, raw in sorted((data or {}).items()):
        if raw is None:
            continue
        if b64:
            try:
                value = base64.b64decode(raw, validate=False)
            except (binascii.Error, ValueError, TypeError):
                continue
        else:
            value = raw.encode() if isinstance(raw, str) else raw
        if not (looks_like_cert(key, value) or secret_type in TLS_SECRET_TYPES):
            continue
        for fact in parse_cert_facts(value):
            fact["key"] = key
            facts.append(fact)
    return facts


def earliest_expiry(facts: list[dict]) -> datetime | None:
    """The soonest not_after across certificate facts (leaf certs matter most,
    but an expired CA is just as fatal, so consider all)."""
    dates = []
    for f in facts:
        try:
            dates.append(datetime.fromisoformat(f["not_after"]))
        except (KeyError, ValueError):
            continue
    if not dates:
        return None
    d = min(dates)
    return d if d.tzinfo else d.replace(tzinfo=UTC)


def scrub_env(env: list | None) -> list[dict]:
    """Keep env var names and where they come from; drop literal values."""
    out = []
    for e in env or []:
        entry = {"name": e.get("name")}
        vf = e.get("valueFrom") or {}
        if "secretKeyRef" in vf:
            entry["from"] = {"kind": "Secret", "name": vf["secretKeyRef"].get("name"),
                             "key": vf["secretKeyRef"].get("key")}
        elif "configMapKeyRef" in vf:
            entry["from"] = {"kind": "ConfigMap", "name": vf["configMapKeyRef"].get("name"),
                             "key": vf["configMapKeyRef"].get("key")}
        elif "fieldRef" in vf:
            entry["from"] = {"kind": "field", "path": vf["fieldRef"].get("fieldPath")}
        elif "resourceFieldRef" in vf:
            entry["from"] = {"kind": "resource", "resource": vf["resourceFieldRef"].get("resource")}
        elif "value" in e:
            entry["from"] = {"kind": "literal"}       # the value itself is dropped
        out.append(entry)
    return out


def scrub_env_from(env_from: list | None) -> list[dict]:
    out = []
    for e in env_from or []:
        if "secretRef" in e:
            out.append({"kind": "Secret", "name": e["secretRef"].get("name")})
        elif "configMapRef" in e:
            out.append({"kind": "ConfigMap", "name": e["configMapRef"].get("name")})
    return out


def scrub_annotations(annotations: dict | None, keep: list[str] | tuple) -> dict:
    keep = set(keep or ())
    return {k: v for k, v in (annotations or {}).items() if k in keep}
