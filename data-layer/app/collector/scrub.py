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

Cost matters here as much as policy. Secrets and ConfigMaps are the heaviest
kinds the collector reads (ADR-0003, Finding 1) and every one of their values
used to be handed to `cryptography` to see whether it happened to be a
certificate. It almost never is: a value is a password, a properties file, a
keystore or a tarball. So the x509 parser is now reached only through
`looks_like_cert`, which is byte comparisons on an already-decoded value and
can never hide a certificate - a PEM certificate cannot exist without the
BEGIN CERTIFICATE marker. Sizes and certificate facts are also taken in one
pass, so a Secret value is base64-decoded once rather than twice.
"""
import base64
import binascii
from datetime import UTC, datetime

from cryptography import x509
from cryptography.hazmat.primitives import hashes

PEM_CERT_BEGIN = b"-----BEGIN CERTIFICATE-----"
PEM_CERT_END = b"-----END CERTIFICATE-----"
# Key names that mean "certificate" even when the PEM does not start at byte 0
# (openssl-emitted bundles carry Bag Attributes or comments before the marker).
CERT_KEY_SUFFIXES = (".crt", ".pem", ".cer", ".cert", "ca-bundle", "ca.crt")
TLS_SECRET_TYPES = ("kubernetes.io/tls",)
# Certificates parsed from one key. A trust bundle holds hundreds of CAs whose
# facts nobody reads individually, and each one is an x509 parse plus a row in
# Redis; the first few are what identify the bundle. Facts from a bundle that
# was cut here carry "truncated": True.
MAX_CERTS_PER_KEY = 20
# Whitespace allowed before the marker, and how far we look for it. A PEM file
# may start with a newline; nothing legitimate starts with a kilobyte of them.
_WHITESPACE = frozenset(b" \t\r\n\v\f")
_MAX_PEM_OFFSET = 16


def _b64_size(value: str) -> int:
    """Decoded byte size of a base64 Secret value (falls back to raw length)."""
    try:
        return len(base64.b64decode(value, validate=False))
    except (binascii.Error, ValueError, TypeError):
        return len(value or "")


def _decode(value, b64: bool) -> bytes | None:
    """One data-map value as bytes (None when it is not decodable base64)."""
    if b64:
        try:
            return base64.b64decode(value, validate=False)
        except (binascii.Error, ValueError, TypeError):
            return None
    return value.encode() if isinstance(value, str) else value


def _walk_data(data: dict | None, binary_data: dict | None, b64: bool,
               certs: bool, secret_type: str | None) -> tuple[list[dict], int, list[dict]]:
    """The single pass behind `scrub_data`, `cert_facts_from_data` and
    `scrub_data_and_certs`: decode each value once, measure it, and look for
    certificates only when asked and only when the value could hold one."""
    keys: list[dict] = []
    facts: list[dict] = []
    total = 0
    for k, raw in sorted((data or {}).items()):
        value = _decode(raw, b64)
        size = len(value) if value is not None else len(raw or "")
        keys.append({"key": k, "bytes": size})
        total += size
        if not certs or value is None:
            continue
        if not looks_like_cert(k, value, secret_type):
            continue
        for fact in parse_cert_facts(value):
            fact["key"] = k
            facts.append(fact)
    # binaryData is never scanned for certificates: a certificate arrives as
    # PEM text under `data`, and a binary value is by definition not that.
    for k, raw in sorted((binary_data or {}).items()):
        size = _b64_size(raw)
        keys.append({"key": k, "bytes": size, "binary": True})
        total += size
    return keys, total, facts


def scrub_data(data: dict | None, binary_data: dict | None = None,
               b64: bool = False) -> tuple[list[dict], int]:
    """Return ([{key, bytes}], total_bytes) for a ConfigMap / Secret `data` map.
    Values are measured, never returned."""
    keys, total, _ = _walk_data(data, binary_data, b64, certs=False, secret_type=None)
    return keys, total


def scrub_data_and_certs(data: dict | None, binary_data: dict | None = None,
                         b64: bool = False, secret_type: str | None = None
                         ) -> tuple[list[dict], int, list[dict]]:
    """`scrub_data` and `cert_facts_from_data` in one pass over the values.

    The parsers use this: a Secret's values are otherwise base64-decoded twice,
    once to be measured and once to be examined.
    """
    return _walk_data(data, binary_data, b64, certs=True, secret_type=secret_type)


def _pem_at_start(value: bytes) -> bool:
    """The PEM marker at the start of the value, tolerating leading whitespace.

    Deliberately not `value.lstrip().startswith(...)`: lstrip copies the whole
    value, and this runs for every key of every Secret and ConfigMap in the
    fleet - megabytes of copying per cluster to answer a question about the
    first 27 bytes.
    """
    limit = min(len(value), _MAX_PEM_OFFSET)
    i = 0
    while i < limit and value[i] in _WHITESPACE:
        i += 1
    return value.startswith(PEM_CERT_BEGIN, i)


def looks_like_cert(key: str, value: bytes, secret_type: str | None = None) -> bool:
    """Whether this value is worth handing to the x509 parser.

    True when the value starts with the PEM certificate marker, or - for a key
    whose name says "certificate", or any key of a `kubernetes.io/tls` Secret -
    when the marker appears anywhere inside it. Both are byte scans, no
    allocation and no `cryptography`. Nothing is hidden by this: a value with
    no BEGIN CERTIFICATE marker cannot parse into a certificate, so the answer
    is the same as parsing it and getting nothing back - just without the cost.
    """
    if _pem_at_start(value):
        return True
    if key.lower().endswith(CERT_KEY_SUFFIXES) or secret_type in TLS_SECRET_TYPES:
        return PEM_CERT_BEGIN in value
    return False


def _first_certs(pem: bytes, limit: int) -> tuple[bytes, bool]:
    """The first `limit` PEM blocks of a bundle, and whether any were dropped.

    Truncating the bytes before parsing is the point: parsing 300 certificates
    to then keep 20 would cost exactly what the cap is meant to save.
    """
    end = -1
    for _ in range(limit):
        end = pem.find(PEM_CERT_END, end + 1)
        if end == -1:
            return pem, False
    cut = pem.find(PEM_CERT_BEGIN, end)
    if cut == -1:
        return pem, False
    return pem[:cut], True


def parse_cert_facts(pem: bytes, limit: int = MAX_CERTS_PER_KEY) -> list[dict]:
    """Parse the first `limit` certificates of a PEM bundle into non-sensitive
    facts. Facts from a bundle that had more carry "truncated": True."""
    pem, truncated = _first_certs(pem, limit)
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
    if truncated:
        for fact in facts:
            fact["truncated"] = True
    return facts


def cert_facts_from_data(data: dict | None, b64: bool, secret_type: str | None = None) -> list[dict]:
    """Extract certificate facts from the PEM-looking keys of a data map."""
    return _walk_data(data, None, b64, certs=True, secret_type=secret_type)[2]


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
