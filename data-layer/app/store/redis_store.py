"""
Redis implementation of the store contract.

Redis is a read cache fed by pull: the collector is the only writer and
replaces one cluster at a time in a single MULTI/EXEC, so a reader never sees
half a cluster. `docs/redis-keyspace.md` is the human description of the same
keyspace; keep the two in step.

Three ideas carry the design:

* **Per-cluster detail is a handful of compressed blobs**, not one key per
  object. A 20k-object cluster is ten `sec:<section>` strings, and an endpoint
  that wants nodes never decompresses the resources section.
* **Fleet-wide questions are served by fleet indexes**, never by scanning every
  cluster. Each cluster contributes members to those indexes on write and
  removes exactly those members on the next write: the `ledger` key records
  what it contributed, and the next write reverses it inside the same
  transaction. Shared entries (an operator name, an image) are refcounted so
  one cluster dropping them does not unpublish another cluster's.
* **Nothing is evicted, things expire.** The server runs `noeviction`;
  per-cluster keys carry a TTL so a cluster that is never collected again ages
  out. Every fleet-index read therefore tolerates a member whose row is gone.

No Lua: every write is a MULTI/EXEC pipeline, which keeps the store usable
against fakeredis in tests and against Redis Cluster in production (per-cluster
keys share the hash tag `{c:<name>}`, fleet keys share `{fleet}`).
"""
from __future__ import annotations

import hashlib
import json
import logging
import time
import zlib
from collections.abc import Iterable
from datetime import UTC, date, datetime

import redis

from ..collector.parsers import split_image
from ..settings import settings
from .base import CLUSTER_DIMENSIONS, DATETIME_FIELDS, FLEET_INDEXED_KINDS, SECTIONS, Row, Store

log = logging.getLogger("odl.store")

# Index members are joined with this separator. Kubernetes object names,
# namespaces and cluster names cannot contain it, so the join is unambiguous.
SEP = "|"

# How many collection runs are kept in the `runs` list.
RUNS_KEPT = 200

# Kinds whose rows may carry certificate expiry.
_CERT_KEYS = ("secrets", "configmaps")

_Z = b"z:"          # marks a zlib-compressed payload


# --------------------------------------------------------------------------- #
# encoding
# --------------------------------------------------------------------------- #
def _json_default(o):
    if isinstance(o, datetime | date):
        return o.isoformat()
    if isinstance(o, set | frozenset):
        return sorted(o)
    return str(o)


def _dumps(obj) -> bytes:
    """Compact JSON; datetimes become ISO 8601 strings."""
    return json.dumps(obj, separators=(",", ":"), default=_json_default).encode()


def _pack(obj) -> bytes:
    """Compressed JSON, for the payloads that dominate the memory footprint."""
    return _Z + zlib.compress(_dumps(obj), 6)


def _unpack(raw: bytes | None):
    """Inverse of `_pack`; also reads an uncompressed payload."""
    if not raw:
        return None
    if raw.startswith(_Z):
        raw = zlib.decompress(raw[len(_Z):])
    return json.loads(raw)


def _as_datetime(value) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _row(data: dict) -> Row:
    """A stored dict as a `Row`, with the datetime-valued fields restored.

    Only top-level fields are restored: nested JSON (a resource `summary`, a
    workload's containers) was already strings before Redis and stays so.
    """
    row = Row(data)
    for field in DATETIME_FIELDS:
        if row.get(field) is not None:
            row[field] = _as_datetime(row[field])
    return row


def _rows(items: Iterable[dict] | None) -> list[Row]:
    return [_row(item) for item in (items or [])]


def _member(*parts) -> str:
    """Join the parts of an index member, refusing anything ambiguous."""
    out = []
    for part in parts:
        text = "" if part is None else str(part)
        if SEP in text:
            raise ValueError(f"cannot index {text!r}: it contains {SEP!r}")
        out.append(text)
    return SEP.join(out)


def _split(member: bytes | str, count: int) -> list[str] | None:
    """Inverse of `_member`; None if the member does not have `count` parts."""
    text = member.decode() if isinstance(member, bytes) else member
    parts = text.split(SEP)
    return parts if len(parts) == count else None


def _text(value: bytes | str | None) -> str | None:
    if isinstance(value, bytes):
        return value.decode()
    return value


def _int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _epoch(value) -> float | None:
    dt = _as_datetime(value)
    return dt.timestamp() if dt else None


_GLOB_SPECIALS = str.maketrans({c: f"\\{c}" for c in "*?[]\\"})


def _glob_contains(needle: str) -> str:
    """A `HSCAN MATCH` pattern matching any field containing `needle`."""
    return f"*{needle.translate(_GLOB_SPECIALS)}*"


def _sha1(text: str) -> str:
    return hashlib.sha1(text.encode(), usedforsecurity=False).hexdigest()


# --------------------------------------------------------------------------- #
# the row shapes that used to be ORM columns
# --------------------------------------------------------------------------- #
SUMMARY_PASSTHROUGH = (
    "region", "datacenter", "environment", "cloud", "vendor", "platform", "cluster_id",
    "infrastructure_name", "api_url", "control_plane_topology", "infrastructure_topology",
    "network_type", "cluster_network", "service_network", "apps_domain", "desired_version",
    "channel", "upgrade_percent", "kube_version",
)
CAPACITY_FIELDS = (
    "cpu_capacity", "cpu_allocatable", "cpu_requests", "cpu_limits", "cpu_usage",
    "memory_capacity", "memory_allocatable", "memory_requests", "memory_limits",
    "memory_usage", "pods_capacity",
)
# Section rows carry exactly these fields (plus `cluster_name`), the columns the
# former ORM tables had - plus `value` / `levels` on a health check, which are
# what it measured and the levels that applied. Anything else the collector
# document holds is derived state the API never read.
SECTION_FIELDS: dict[str, frozenset[str]] = {
    "operators": frozenset({
        "name", "version", "available", "progressing", "degraded", "critical", "message"}),
    "nodes": frozenset({
        "name", "roles", "ready", "schedulable", "conditions", "kubelet_version", "os_image",
        "kernel_version", "container_runtime", "architecture", "instance_type", "zone",
        "internal_ip", "cpu_capacity", "cpu_allocatable", "cpu_usage", "memory_capacity",
        "memory_allocatable", "memory_usage", "ephemeral_storage_allocatable", "pods_capacity",
        "pods_running", "images_count", "images_bytes", "taints", "created_at"}),
    "namespaces": frozenset({
        "name", "ns_class", "app_name", "team", "tier", "labels", "annotations", "requester",
        "display_name", "phase", "status", "workloads_total", "replicas_desired",
        "replicas_ready", "pods_total", "pods_running", "pods_pending", "pods_failed",
        "pods_succeeded", "restarts_total", "pod_issues", "cpu_requests", "cpu_limits",
        "cpu_usage", "memory_requests", "memory_limits", "memory_usage", "resource_counts",
        "images", "created_at", "environment", "assigned"}),
    "workloads": frozenset({
        "namespace", "ns_class", "kind", "name", "replicas_desired", "replicas_ready",
        "replicas_available", "replicas_updated", "status", "containers", "images",
        "config_refs", "service_account", "node_selector", "strategy", "labels", "conditions",
        "created_at"}),
    "workload_images": frozenset({
        "namespace", "workload_kind", "workload_name", "container", "image", "registry",
        "repository", "tag", "digest"}),
    "workload_refs": frozenset({
        "namespace", "workload_kind", "workload_name", "ref_kind", "ref_name", "via"}),
    "pod_issues": frozenset({
        "namespace", "ns_class", "name", "node", "phase", "reason", "message", "restarts",
        "owner_kind", "owner_name", "containers_ready", "started_at"}),
    "resources": frozenset({
        "key", "kind", "api_group", "namespace", "ns_class", "name", "status", "expires_at",
        "labels", "summary", "created_at"}),
    "resource_status": frozenset({"key", "status", "count", "duration_ms", "error"}),
    "health_checks": frozenset({"name", "title", "status", "severity", "message",
                                "value", "levels"}),
}
_OPERATOR_INDEX_FIELDS = ("version", "available", "progressing", "degraded", "critical", "message")


# --------------------------------------------------------------------------- #
# keys
# --------------------------------------------------------------------------- #
class Keys:
    """Key builders. Per-cluster keys share the hash tag `{c:<name>}` and fleet
    keys `{fleet}`, so a cluster's own write is single-slot under Redis Cluster."""

    def __init__(self, prefix: str = "odl"):
        self.prefix = prefix
        self._fleet = f"{prefix}:{{fleet}}"

    # -- per cluster
    def cluster(self, name: str) -> str:
        return f"{self.prefix}:{{c:{name}}}"

    def summary(self, name: str) -> str:
        return f"{self.cluster(name)}:summary"

    def section(self, name: str, section: str) -> str:
        return f"{self.cluster(name)}:sec:{section}"

    def snapshots(self, name: str) -> str:
        return f"{self.cluster(name)}:snapshots"

    def ledger(self, name: str) -> str:
        return f"{self.cluster(name)}:ledger"

    def lock(self, name: str) -> str:
        return f"{self.cluster(name)}:lock"

    def cluster_keys(self, name: str) -> list[str]:
        """Every key that lives and dies with one cluster (the lock has its own TTL)."""
        return [self.ledger(name), *self.expiring_keys(name)]

    def expiring_keys(self, name: str) -> list[str]:
        """The keys REDIS_TTL_SECONDS applies to. The ledger is deliberately not
        one of them: it is what lets `prune_vanished` unpublish an expired
        cluster's fleet-index members, so it must outlive the data it describes."""
        return [self.summary(name), self.snapshots(name),
                *(self.section(name, s) for s in SECTIONS)]

    # -- fleet
    @property
    def clusters(self) -> str:
        return f"{self._fleet}:clusters"

    @property
    def hubs(self) -> str:
        return f"{self._fleet}:hubs"

    def cluster_dim(self, dim: str, value: str) -> str:
        return f"{self._fleet}:idx:cluster:{dim}:{value}"

    def op(self, operator: str) -> str:
        return f"{self._fleet}:idx:op:{operator}"

    @property
    def ops(self) -> str:
        return f"{self._fleet}:idx:ops"

    @property
    def ns(self) -> str:
        return f"{self._fleet}:ns"

    def ns_app(self, app: str) -> str:
        return f"{self._fleet}:idx:ns:app:{app}"

    def ns_team(self, team: str) -> str:
        return f"{self._fleet}:idx:ns:team:{team}"

    def ns_class(self, ns_class: str) -> str:
        return f"{self._fleet}:idx:ns:class:{ns_class}"

    def ns_usage(self, by: str) -> str:
        return f"{self._fleet}:idx:ns:{'mem' if _is_memory(by) else 'cpu'}"

    @property
    def nodes(self) -> str:
        return f"{self._fleet}:nodes"

    def node_usage(self, by: str) -> str:
        return f"{self._fleet}:idx:node:{'mem_pct' if _is_memory(by) else 'cpu_pct'}"

    def podissues(self, ns_class: str) -> str:
        return f"{self._fleet}:podissues:{ns_class}"

    def res(self, key: str) -> str:
        return f"{self._fleet}:res:{key}"

    def res_status(self, key: str, status: str) -> str:
        return f"{self._fleet}:res:{key}:status:{status}"

    @property
    def certs(self) -> str:
        return f"{self._fleet}:certs"

    @property
    def cert_expires(self) -> str:
        return f"{self._fleet}:idx:cert:expires"

    @property
    def images(self) -> str:
        return f"{self._fleet}:idx:images"

    @property
    def image_names(self) -> str:
        return f"{self._fleet}:idx:image:names"

    def image(self, image: str) -> str:
        return f"{self._fleet}:idx:image:{_sha1(image)}"

    def ref(self, kind: str, name: str) -> str:
        return f"{self._fleet}:idx:ref:{kind}:{name}"

    @property
    def runs(self) -> str:
        return f"{self._fleet}:runs"

    @property
    def run_last(self) -> str:
        return f"{self._fleet}:run:last"


def _is_memory(by: str | None) -> bool:
    return str(by or "").lower().startswith("mem")


# --------------------------------------------------------------------------- #
# the store
# --------------------------------------------------------------------------- #
class RedisStore(Store):
    """The store contract over a single Redis (or Redis Cluster) endpoint."""

    def __init__(self, client: redis.Redis, prefix: str = "odl", ttl_seconds: int = 0,
                 snapshot_retention: int = 500):
        self.r = client
        self.keys = Keys(prefix)
        self.ttl_seconds = max(0, int(ttl_seconds))
        self.snapshot_retention = max(1, int(snapshot_retention))

    @classmethod
    def from_settings(cls) -> RedisStore:
        client = redis.Redis.from_url(settings.redis_url, decode_responses=False)
        return cls(client, prefix=settings.redis_prefix,
                   ttl_seconds=settings.redis_ttl_seconds,
                   snapshot_retention=settings.snapshot_retention)

    def ping(self) -> bool:
        """Liveness, used by the API's startup wait."""
        return bool(self.r.ping())

    # ------------------------------------------------------------------ write
    def persist_cluster(self, hub_name: str, collected: dict, checks: list[dict],
                        overall: str, score: int, counts: dict) -> None:
        name = collected["name"]
        _member(name)                       # fail fast on a name we cannot index
        now = datetime.now(UTC)
        k = self.keys

        summary = _summary_row(name, hub_name, collected, overall, score, counts, now)
        sections = _section_rows(name, collected, checks)
        snapshot = _snapshot_row(name, summary, collected, now)
        entries, image_names = self._contributions(name, summary, sections)

        previous = _unpack(self.r.get(k.ledger(name))) or []
        pipe = self.r.pipeline(transaction=True)
        _reverse(pipe, previous)
        pipe.delete(k.summary(name))
        pipe.hset(k.summary(name), mapping={f: _dumps(v) for f, v in summary.items()})
        for section, rows in sections.items():
            pipe.set(k.section(name, section), _pack(rows))
        pipe.zadd(k.snapshots(name), {_dumps(snapshot): now.timestamp()})
        pipe.zremrangebyrank(k.snapshots(name), 0, -self.snapshot_retention - 1)
        _apply(pipe, entries)
        if image_names:
            # Not ledgered: the lowercase field is shared by every cluster using
            # the image, so it is dropped only when its refcount hits zero.
            pipe.hset(k.image_names, mapping=image_names)
        pipe.set(k.ledger(name), _pack([[op, key, member] for op, key, member, _ in entries]))
        pipe.sadd(k.clusters, name)
        if self.ttl_seconds:
            for key in k.expiring_keys(name):
                pipe.expire(key, self.ttl_seconds)
        pipe.execute()

    def delete_cluster(self, name: str) -> None:
        k = self.keys
        previous = _unpack(self.r.get(k.ledger(name))) or []
        pipe = self.r.pipeline(transaction=True)
        _reverse(pipe, previous)
        pipe.delete(*k.cluster_keys(name), k.lock(name))
        pipe.srem(k.clusters, name)
        pipe.execute()

    def prune_vanished(self, seen: dict[str, set[str]]) -> list[str]:
        names = self.cluster_names()
        if not names:
            return []
        pipe = self.r.pipeline(transaction=False)
        for name in names:
            pipe.hget(self.keys.summary(name), "hub_name")
        removed = []
        for name, raw in zip(names, pipe.execute(), strict=True):
            if raw is None:
                # Every per-cluster key expired: the cluster was never collected
                # again, so drop its name from the fleet set too.
                log.info("pruning cluster %s: its keys expired", name)
                removed.append(name)
                continue
            hub = json.loads(raw)
            if hub in seen and name not in seen[hub]:
                log.info("pruning cluster %s: no longer discovered on hub %s", name, hub)
                removed.append(name)
        for name in removed:
            self.delete_cluster(name)
        return removed

    def finalize_sweep(self) -> None:
        """Drop refcounted entries nobody contributed this sweep."""
        self._drop_dead_refcounts(self.keys.ops)
        dead = self._drop_dead_refcounts(self.keys.images)
        if dead:
            self.r.hdel(self.keys.image_names, *dead)

    def _drop_dead_refcounts(self, key: str) -> list[str]:
        dead = [field for field, count in self._hscan(key) if _int(count) <= 0]
        if dead:
            self.r.hdel(key, *dead)
        return [f.decode() for f in dead]

    def try_lock(self, name: str, ttl_ms: int) -> bool:
        return bool(self.r.set(self.keys.lock(name), _dumps({"at": datetime.now(UTC)}),
                               nx=True, px=ttl_ms))

    def unlock(self, name: str) -> None:
        self.r.delete(self.keys.lock(name))

    # --------------------------------------------------------- contributions
    def _contributions(self, name: str, summary: dict,
                       sections: dict[str, list[dict]]) -> tuple[list[tuple], dict[str, str]]:
        """Every fleet-index member this cluster publishes, plus the image-name
        aliases (which are refcounted rather than ledgered).

        Entries are `(op, key, member, payload)` and are deduplicated: the same
        member contributed twice would otherwise be reversed twice.
        """
        k = self.keys
        entries: dict[tuple[str, str, str], tuple] = {}

        def add(op, key, member, payload=None):
            entries[(op, key, member)] = (op, key, member, payload)

        # -- cluster dimensions: the list filters are SINTER over these
        dims = {"region": summary.get("region"), "datacenter": summary.get("datacenter"),
                "environment": summary.get("environment"), "hub": summary.get("hub_name"),
                "version": summary.get("ocp_version"), "status": summary.get("overall_status")}
        for dim in CLUSTER_DIMENSIONS:
            value = dims.get(dim)
            if value:
                add("sadd", k.cluster_dim(dim, value), name)

        # -- cluster operators
        for row in sections["operators"]:
            operator = row.get("name")
            if not operator:
                continue
            add("hset", k.op(operator), name,
                _dumps({f: row.get(f) for f in _OPERATOR_INDEX_FIELDS}))
            add("hincr", k.ops, operator, 1)

        # -- namespaces (applications, blast radius, top-N)
        for row in sections["namespaces"]:
            if not row.get("name"):
                continue
            member = _member(name, row["name"])
            add("hset", k.ns, member, _dumps(row))
            for key, value in ((k.ns_class, row.get("ns_class")), (k.ns_team, row.get("team")),
                               (k.ns_app, row.get("app_name"))):
                if value:
                    add("sadd", key(value), member)
            if row.get("cpu_usage") is not None:
                add("zadd", k.ns_usage("cpu"), member, float(row["cpu_usage"]))
            if row.get("memory_usage") is not None:
                add("zadd", k.ns_usage("memory"), member, float(row["memory_usage"]))

        # -- nodes, scored by utilisation percent so top-N is a ZREVRANGE
        for row in sections["nodes"]:
            if not row.get("name"):
                continue
            member = _member(name, row["name"])
            add("hset", k.nodes, member, _dumps(row))
            for by, usage, allocatable in (("cpu", "cpu_usage", "cpu_allocatable"),
                                           ("memory", "memory_usage", "memory_allocatable")):
                used, capacity = row.get(usage), row.get(allocatable)
                if used is None or not capacity:
                    continue
                add("zadd", k.node_usage(by), member, 100.0 * float(used) / float(capacity))

        # -- pod issues, split by namespace class so HLEN answers the counters
        for row in sections["pod_issues"]:
            ns_class = row.get("ns_class")
            if not ns_class:
                continue
            member = _member(name, row.get("namespace"), row.get("name"))
            add("hset", k.podissues(ns_class), member, _dumps(row))

        # -- inventory: the fleet-indexed kinds, and anything with a certificate
        for row in sections["resources"]:
            key = row.get("key")
            if key in FLEET_INDEXED_KINDS:
                member = _member(name, row.get("namespace"), row.get("name"))
                add("hset", k.res(key), member, _dumps(row))
                if row.get("status"):
                    add("sadd", k.res_status(key, row["status"]), member)
            if key in _CERT_KEYS and row.get("expires_at"):
                member = _member(name, row.get("namespace"), key, row.get("name"))
                add("hset", k.certs, member, _dumps(row))
                add("zadd", k.cert_expires, member, _epoch(row["expires_at"]))

        # -- images: refcounted so one cluster dropping an image keeps the others
        image_names: dict[str, str] = {}
        for row in sections["workload_images"]:
            image = row.get("image")
            if not image:
                continue
            lowered = image.lower()
            image_names[lowered] = image
            add("hincr", k.images, lowered, 1)
            add("sadd", k.image(image),
                _member(name, row.get("namespace"), row.get("workload_kind"),
                        row.get("workload_name"), row.get("container")))

        # -- configuration references (who mounts this Secret?)
        for row in sections["workload_refs"]:
            kind, ref_name = row.get("ref_kind"), row.get("ref_name")
            if not kind or not ref_name:
                continue
            add("sadd", k.ref(kind, ref_name),
                _member(name, row.get("namespace"), row.get("workload_kind"),
                        row.get("workload_name"), row.get("via")))

        return list(entries.values()), image_names

    # ------------------------------------------------------------------- runs
    def begin_run(self, trigger: str) -> str:
        run_id = f"{int(time.time() * 1000)}-{trigger}"
        row = {"id": run_id, "trigger": trigger, "started_at": datetime.now(UTC),
               "finished_at": None, "duration_ms": None, "hubs_total": 0, "clusters_total": 0,
               "clusters_ok": 0, "clusters_failed": 0, "error": None}
        pipe = self.r.pipeline(transaction=True)
        pipe.lpush(self.keys.runs, _dumps(row))
        pipe.ltrim(self.keys.runs, 0, RUNS_KEPT - 1)
        pipe.execute()
        return run_id

    def finish_run(self, run_id: str, **fields) -> None:
        entries = self.r.lrange(self.keys.runs, 0, RUNS_KEPT - 1)
        for index, raw in enumerate(entries):
            row = json.loads(raw)
            if row.get("id") != run_id:
                continue
            row.update(fields)
            if not row.get("finished_at"):
                row["finished_at"] = datetime.now(UTC)
            pipe = self.r.pipeline(transaction=True)
            pipe.lset(self.keys.runs, index, _dumps(row))
            pipe.set(self.keys.run_last, _dumps({
                "at": row["finished_at"], "ok": not row.get("error"),
                "trigger": row.get("trigger")}))
            pipe.execute()
            return
        # The run aged out of the list; the "last run" answer still matters.
        self.r.set(self.keys.run_last, _dumps({
            "at": fields.get("finished_at") or datetime.now(UTC),
            "ok": not fields.get("error"), "trigger": run_id.split("-", 1)[-1]}))

    def last_run(self) -> dict | None:
        raw = self.r.get(self.keys.run_last)
        if not raw:
            return None
        data = json.loads(raw)
        return {"at": _as_datetime(data.get("at")), "ok": bool(data.get("ok")),
                "trigger": data.get("trigger")}

    def runs(self, limit: int = 20) -> list[Row]:
        raw = self.r.lrange(self.keys.runs, 0, max(0, limit - 1))
        return [_row(json.loads(item)) for item in raw]

    # ----------------------------------------------------------- hubs/clusters
    def upsert_hub(self, name: str, **fields) -> None:
        raw = self.r.hget(self.keys.hubs, name)
        row = json.loads(raw) if raw else {}
        row.update(fields)
        row["name"] = name
        self.r.hset(self.keys.hubs, name, _dumps(row))

    def hubs(self) -> list[Row]:
        raw = self.r.hgetall(self.keys.hubs)
        rows = [_row(json.loads(value)) for value in raw.values()]
        return sorted(rows, key=lambda r: r.get("name") or "")

    def cluster_names(self) -> list[str]:
        return sorted(m.decode() for m in self.r.smembers(self.keys.clusters))

    def get_cluster(self, name: str) -> Row | None:
        return _summary(self.r.hgetall(self.keys.summary(name)))

    def clusters(self, names: Iterable[str] | None = None, **filters) -> list[Row]:
        sets = []
        for dim in CLUSTER_DIMENSIONS:
            # `hub` is the dimension name; the summary field is `hub_name`.
            value = filters.get(dim) or (filters.get("hub_name") if dim == "hub" else None)
            if value:
                sets.append(self.keys.cluster_dim(dim, value))
        if sets:
            selected = {m.decode() for m in self.r.sinter(sets)}
        else:
            selected = set(self.cluster_names())
        if names is not None:
            selected &= set(names)
        ordered = sorted(selected)
        if not ordered:
            return []
        pipe = self.r.pipeline(transaction=False)
        for name in ordered:
            pipe.hgetall(self.keys.summary(name))
        rows = [_summary(raw) for raw in pipe.execute()]
        return [row for row in rows if row is not None]

    # --------------------------------------------------------------- sections
    def section(self, name: str, section: str) -> list[Row]:
        return _rows(_unpack(self.r.get(self.keys.section(name, section))))

    def sections(self, name: str, keys: Iterable[str]) -> dict[str, list[Row]]:
        wanted = list(keys)
        if not wanted:
            return {}
        pipe = self.r.pipeline(transaction=False)
        for section in wanted:
            pipe.get(self.keys.section(name, section))
        return {section: _rows(_unpack(blob))
                for section, blob in zip(wanted, pipe.execute(), strict=True)}

    def section_across(self, section: str,
                       names: Iterable[str] | None = None) -> dict[str, list[Row]]:
        wanted = sorted(names) if names is not None else self.cluster_names()
        if not wanted:
            return {}
        pipe = self.r.pipeline(transaction=False)
        for name in wanted:
            pipe.get(self.keys.section(name, section))
        out = {}
        for name, blob in zip(wanted, pipe.execute(), strict=True):
            if blob is None:       # never collected, or aged out
                continue
            out[name] = _rows(_unpack(blob))
        return out

    def snapshots(self, name: str, limit: int = 100) -> list[Row]:
        raw = self.r.zrange(self.keys.snapshots(name), -max(1, limit), -1)
        return [_row(json.loads(item)) for item in raw]

    # ----------------------------------------------------------- fleet views
    def namespaces(self, ns_class: str | None = None, team: str | None = None,
                   app_name: str | None = None,
                   clusters: Iterable[str] | None = None) -> list[Row]:
        k = self.keys
        keep = _cluster_filter(clusters)
        sets = [key(value) for key, value in ((k.ns_class, ns_class), (k.ns_team, team),
                                              (k.ns_app, app_name)) if value]
        if sets:
            members = self.r.sinter(sets) if len(sets) > 1 else self.r.smembers(sets[0])
            members = sorted(m for m in members if keep(m))
            values = self.r.hmget(k.ns, members) if members else []
        else:
            raw = self.r.hgetall(k.ns)
            values = [value for field, value in sorted(raw.items()) if keep(field)]
        rows = [_row(json.loads(value)) for value in values if value]
        return sorted(rows, key=lambda r: (r.get("cluster_name") or "", r.get("name") or ""))

    def top_namespaces(self, by: str = "cpu", limit: int = 10) -> list[Row]:
        return self._top(self.keys.ns_usage(by), self.keys.ns, limit)

    def nodes(self, clusters: Iterable[str] | None = None) -> list[Row]:
        keep = _cluster_filter(clusters)
        raw = self.r.hgetall(self.keys.nodes)
        rows = [_row(json.loads(value)) for field, value in sorted(raw.items()) if keep(field)]
        return sorted(rows, key=lambda r: (r.get("cluster_name") or "", r.get("name") or ""))

    def top_nodes(self, by: str = "cpu", limit: int = 10) -> list[Row]:
        return self._top(self.keys.node_usage(by), self.keys.nodes, limit)

    def _top(self, index: str, hash_key: str, limit: int) -> list[Row]:
        """Highest-scoring members of a ZSET, with their rows; `value` = score."""
        scored = self.r.zrevrange(index, 0, max(0, limit - 1), withscores=True)
        if not scored:
            return []
        values = self.r.hmget(hash_key, [member for member, _ in scored])
        rows = []
        for (_, score), value in zip(scored, values, strict=True):
            if not value:          # the cluster aged out; the index member has not
                continue
            row = _row(json.loads(value))
            row["value"] = score
            rows.append(row)
        return rows

    def operator_index(self, operator: str) -> dict[str, Row]:
        raw = self.r.hgetall(self.keys.op(operator))
        return {field.decode(): _row(json.loads(value)) for field, value in raw.items()}

    def operator_names(self) -> list[str]:
        return sorted(field.decode() for field, count in self._hscan(self.keys.ops)
                      if _int(count) > 0)

    def pod_issues(self, ns_class: str | None = None,
                   clusters: Iterable[str] | None = None) -> list[Row]:
        keep = _cluster_filter(clusters)
        classes = [ns_class] if ns_class else ["application", "platform"]
        pipe = self.r.pipeline(transaction=False)
        for cls in classes:
            pipe.hgetall(self.keys.podissues(cls))
        rows = []
        for raw in pipe.execute():
            rows += [_row(json.loads(value)) for field, value in sorted(raw.items())
                     if keep(field)]
        return sorted(rows, key=lambda r: (r.get("cluster_name") or "",
                                           r.get("namespace") or "", r.get("name") or ""))

    def pod_issue_counts(self) -> dict[str, int]:
        pipe = self.r.pipeline(transaction=False)
        classes = ("platform", "application")
        for cls in classes:
            pipe.hlen(self.keys.podissues(cls))
        return dict(zip(classes, pipe.execute(), strict=True))

    def fleet_resources(self, key: str, status: str | None = None,
                        clusters: Iterable[str] | None = None) -> list[Row]:
        keep = _cluster_filter(clusters)
        if status:
            members = sorted(m for m in self.r.smembers(self.keys.res_status(key, status))
                             if keep(m))
            if not members:
                return []
            values = self.r.hmget(self.keys.res(key), members)
        else:
            raw = self.r.hgetall(self.keys.res(key))
            values = [value for field, value in sorted(raw.items()) if keep(field)]
        rows = [_row(json.loads(value)) for value in values if value]
        return sorted(rows, key=lambda r: (r.get("cluster_name") or "",
                                           r.get("namespace") or "", r.get("name") or ""))

    def fleet_resource_count(self, key: str, status: str | None = None) -> int:
        if status:
            return int(self.r.scard(self.keys.res_status(key, status)))
        return int(self.r.hlen(self.keys.res(key)))

    def certificates(self, before: float | None = None,
                     after: float | None = None) -> list[Row]:
        members = self.r.zrangebyscore(self.keys.cert_expires, _lo(after), _hi(before))
        if not members:
            return []
        values = self.r.hmget(self.keys.certs, members)
        return [_row(json.loads(value)) for value in values if value]

    def certificate_count(self, before: float | None = None,
                          after: float | None = None) -> int:
        return int(self.r.zcount(self.keys.cert_expires, _lo(after), _hi(before)))

    def images(self, needle: str | None = None) -> list[str]:
        pattern = _glob_contains(needle.lower()) if needle else None
        fields = [field for field, count in self._hscan(self.keys.images, match=pattern)
                  if _int(count) > 0]
        if not fields:
            return []
        originals = self.r.hmget(self.keys.image_names, fields)
        return sorted({_text(original) or field.decode()
                       for field, original in zip(fields, originals, strict=True)})

    def image_usages(self, image: str) -> list[Row]:
        parts = split_image(image)
        rows = []
        for member in self.r.smembers(self.keys.image(image)):
            fields = _split(member, 5)
            if not fields:
                continue
            cluster, namespace, kind, workload, container = fields
            rows.append(_row({"cluster_name": cluster, "namespace": namespace,
                              "workload_kind": kind, "workload_name": workload,
                              "container": container, **parts}))
        return sorted(rows, key=lambda r: (r["cluster_name"], r["namespace"],
                                           r["workload_name"], r["container"]))

    def references(self, kind: str, name: str) -> list[Row]:
        rows = []
        for member in self.r.smembers(self.keys.ref(kind, name)):
            fields = _split(member, 5)
            if not fields:
                continue
            cluster, namespace, workload_kind, workload_name, via = fields
            rows.append(_row({"cluster_name": cluster, "namespace": namespace,
                              "workload_kind": workload_kind, "workload_name": workload_name,
                              "ref_kind": kind, "ref_name": name, "via": via}))
        return sorted(rows, key=lambda r: (r["cluster_name"], r["namespace"],
                                           r["workload_name"], r["via"]))

    # ---------------------------------------------------------------- helpers
    def _hscan(self, key: str, match: str | None = None):
        """Every field/value of a hash, a page at a time (never HGETALL: these
        hashes are fleet-sized)."""
        cursor = 0
        while True:
            cursor, batch = self.r.hscan(key, cursor, match=match, count=500)
            yield from batch.items()
            if cursor == 0:
                return


# --------------------------------------------------------------------------- #
# row builders
# --------------------------------------------------------------------------- #
def _summary_row(name: str, hub_name: str, collected: dict, overall: str, score: int,
                 counts: dict, now: datetime) -> dict:
    """The former `clusters` row, field for field."""
    cap = collected.get("capacity") or {}
    row = {"name": name, "hub_name": hub_name, "display_name": name}
    row.update({field: collected.get(field) for field in SUMMARY_PASSTHROUGH})
    row.update({field: cap.get(field) for field in CAPACITY_FIELDS})
    row.update({
        "ocp_version": collected.get("version") or collected.get("label_version"),
        "upgrading": bool(collected.get("upgrading")),
        "available_updates": collected.get("available_updates") or [],
        "nodes_total": collected.get("nodes_total", 0),
        "nodes_ready": collected.get("nodes_ready", 0),
        "pods_total": cap.get("pods_total", 0) or 0,
        "pods_running": cap.get("pods_running", 0) or 0,
        "metrics_available": bool(cap.get("metrics_available")),
        "namespaces_application": collected.get("namespaces_application", 0) or 0,
        "namespaces_platform": collected.get("namespaces_platform", 0) or 0,
        "workloads_total": collected.get("workloads_total", 0) or 0,
        "pod_issues_total": collected.get("pod_issues_total", 0) or 0,
        "certs_expiring_total": collected.get("certs_expiring_total", 0) or 0,
        "managed_available": bool(collected.get("managed_available", True)),
        "overall_status": overall,
        "health_score": score,
        "checks_passed": counts["passed"],
        "checks_warned": counts["warned"],
        "checks_failed": counts["failed"],
        "reachable": collected.get("reachable", True),
        "last_error": collected.get("error"),
        "collect_ms": collected.get("collect_ms"),
        "last_synced": now,
    })
    return row


def _section_rows(name: str, collected: dict, checks: list[dict]) -> dict[str, list[dict]]:
    """The ten detail sections, each row restricted to the former ORM columns."""
    out: dict[str, list[dict]] = {}
    for section in SECTIONS:
        allowed = SECTION_FIELDS[section]
        if section == "resource_status":
            # A dict keyed by manifest key, unlike every other section.
            source = (collected.get("resource_status") or {}).items()
            out[section] = [{"cluster_name": name, "key": key,
                             **{f: v for f, v in row.items() if f in allowed}}
                            for key, row in source]
            continue
        # Every other section is a list under its own name in the document;
        # the health checks are computed alongside it, not part of it.
        items = checks if section == "health_checks" else collected.get(section)
        out[section] = [{"cluster_name": name,
                         **{f: v for f, v in row.items() if f in allowed}}
                        for row in (items or [])]
    return out


def _snapshot_row(name: str, summary: dict, collected: dict, now: datetime) -> dict:
    cap = collected.get("capacity") or {}
    return {
        "cluster_name": name,
        "overall_status": summary["overall_status"],
        "health_score": summary["health_score"],
        "checks_passed": summary["checks_passed"],
        "checks_warned": summary["checks_warned"],
        "checks_failed": summary["checks_failed"],
        "ocp_version": summary["ocp_version"],
        "upgrading": summary["upgrading"],
        "cpu_usage": cap.get("cpu_usage"),
        "cpu_allocatable": cap.get("cpu_allocatable"),
        "memory_usage": cap.get("memory_usage"),
        "memory_allocatable": cap.get("memory_allocatable"),
        "pods_running": summary["pods_running"],
        "pod_issues": summary["pod_issues_total"],
        "snapshot_at": now,
    }


def _summary(raw: dict) -> Row | None:
    """A summary HASH back into a row. Every field is JSON, so ints stay ints."""
    if not raw:
        return None
    return _row({field.decode(): json.loads(value) for field, value in raw.items()})


# --------------------------------------------------------------------------- #
# ledger
# --------------------------------------------------------------------------- #
def _apply(pipe, entries: Iterable[tuple]) -> None:
    for op, key, member, payload in entries:
        if op == "sadd":
            pipe.sadd(key, member)
        elif op == "hset":
            pipe.hset(key, member, payload)
        elif op == "zadd":
            pipe.zadd(key, {member: payload})
        elif op == "hincr":
            pipe.hincrby(key, member, payload)


def _reverse(pipe, ledger: Iterable[list]) -> None:
    """Undo exactly what this cluster contributed on its previous write."""
    for entry in ledger:
        op, key, member = entry[0], entry[1], entry[2]
        if op == "sadd":
            pipe.srem(key, member)
        elif op == "hset":
            pipe.hdel(key, member)
        elif op == "zadd":
            pipe.zrem(key, member)
        elif op == "hincr":
            pipe.hincrby(key, member, -1)


# --------------------------------------------------------------------------- #
# member filtering
# --------------------------------------------------------------------------- #
def _cluster_filter(clusters: Iterable[str] | None):
    """A predicate over `<cluster>|...` index members, built once per read."""
    if clusters is None:
        return lambda member: True
    prefixes = tuple(f"{name}{SEP}".encode() for name in clusters)
    if not prefixes:
        return lambda member: False
    return lambda member: member.startswith(prefixes)


def _lo(after: float | None):
    return "-inf" if after is None else after


def _hi(before: float | None):
    return "+inf" if before is None else before
