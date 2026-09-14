"""
The store contract: what the collector writes and what the API reads.

There is exactly one implementation (`redis_store.RedisStore`), but the API
and the collector only ever depend on this interface, so the storage engine
is a swappable detail. `docs/redis-keyspace.md` is the human description of
the same contract; keep the two in step.

Rows are plain dicts with attribute access (`Row`), carrying the same field
names the former ORM columns had, so serializers keep working unchanged.
Datetime-valued fields (`created_at`, `started_at`, `expires_at`,
`last_synced`, `snapshot_at`, `finished_at`, `at`) are restored to
timezone-aware datetimes on read.

History is the one part of the store that is not "the state as of the last
sweep": `snapshots` keeps a per-cluster time series at three resolutions and
`changes` an append-only log of what changed between sweeps. See
`store/history.py` for the model and `docs/redis-keyspace.md` for the keys.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterable
from datetime import datetime

# Per-cluster detail sections. Each is stored as one compressed blob.
SECTIONS = (
    "operators", "nodes", "namespaces", "workloads", "workload_images", "workload_refs",
    "pod_issues", "resources", "resource_status", "health_checks",
)

# Resource kinds that are also indexed fleet-wide (see docs/redis-keyspace.md).
FLEET_INDEXED_KINDS = (
    "resourcequotas", "machineconfigpools", "clusterserviceversions", "subscriptions",
    "persistentvolumeclaims", "persistentvolumes", "storageclasses", "routes", "events",
    "clusterrolebindings",
)

# Cluster list filters that map to `idx:cluster:<dim>:<value>` sets.
CLUSTER_DIMENSIONS = ("region", "datacenter", "environment", "hub", "version", "status")

DATETIME_FIELDS = frozenset({
    "created_at", "started_at", "expires_at", "last_synced", "snapshot_at", "finished_at",
    "at",
})


class Row(dict):
    """A dict whose keys are also attributes; a missing key reads as None."""

    __slots__ = ()

    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError:
            return None


class Store(ABC):
    """Everything the collector writes and the API reads. See the module docstring."""

    # ------------------------------------------------------------------ write
    @abstractmethod
    def begin_run(self, trigger: str) -> str:
        """Record the start of a sweep; returns the run id."""

    @abstractmethod
    def finish_run(self, run_id: str, **fields) -> None:
        """Complete a sweep record: finished_at, duration_ms, hubs_total,
        clusters_total, clusters_ok, clusters_failed, error."""

    @abstractmethod
    def upsert_hub(self, name: str, **fields) -> None:
        """Create or update a hub row: region, datacenter, managed_count,
        reachable, last_synced, last_error. Only given fields change."""

    @abstractmethod
    def persist_cluster(self, hub_name: str, collected: dict, checks: list[dict],
                        overall: str, score: int, counts: dict,
                        now: datetime | None = None) -> None:
        """Atomically replace one cluster: summary, every section, its fleet
        index contributions, a health snapshot appended to each history tier,
        and a change record for everything that differs from the last sweep.
        `collected` is the collector document; `checks` the health-check rows;
        `counts` has passed/warned/failed. `now` is the instant the sweep is
        recorded at, which a test or a backfill may supply."""

    @abstractmethod
    def update_summary(self, name: str, **fields) -> None:
        """Set a few summary fields of an existing cluster without rewriting
        it (e.g. `timings` measured after the write). No-op for an unknown cluster."""

    @abstractmethod
    def delete_cluster(self, name: str) -> None:
        """Remove a cluster and every fleet index member it contributed."""

    @abstractmethod
    def prune_vanished(self, seen: dict[str, set[str]]) -> list[str]:
        """Drop clusters no longer discovered on a *reachable* hub. `seen`
        maps hub name -> cluster names discovered this sweep. Returns the
        names removed. Clusters under unreachable hubs are kept."""

    @abstractmethod
    def finalize_sweep(self) -> None:
        """End-of-sweep housekeeping (refcount cleanup, cache invalidation)."""

    @abstractmethod
    def try_lock(self, name: str, ttl_ms: int) -> bool:
        """Single-flight lock for an on-demand refresh of one cluster."""

    @abstractmethod
    def unlock(self, name: str) -> None: ...

    # ------------------------------------------------------- generation + cache
    @abstractmethod
    def generation(self) -> int:
        """A counter that changes whenever any cluster is written or removed.
        Computed fleet views are cached against it (see api/cache.py)."""

    @abstractmethod
    def cache_get(self, key: str) -> dict | None:
        """A cached computed view {gen, body} or None."""

    @abstractmethod
    def cache_set(self, key: str, value: dict, ttl_seconds: int) -> None: ...

    # --------------------------------------------------------------- progress
    @abstractmethod
    def set_progress(self, instance: str, progress: dict, ttl_seconds: int) -> None:
        """Publish one collector instance's sweep progress (running, total,
        done, ok, failed, started_at, trigger, hubs). Expires after `ttl_seconds`
        so a dead collector disappears from the aggregate."""

    @abstractmethod
    def clear_progress(self, instance: str) -> None: ...

    @abstractmethod
    def progress_all(self) -> list[dict]:
        """Every collector instance's last published progress, each with `instance`."""

    # ------------------------------------------------------------------- runs
    @abstractmethod
    def last_run(self) -> dict | None:
        """{at: datetime|None, ok: bool, trigger: str} of the last sweep."""

    @abstractmethod
    def runs(self, limit: int = 20) -> list[Row]:
        """Newest-first collection runs (id, trigger, started_at, finished_at,
        duration_ms, hubs_total, clusters_total, clusters_ok, clusters_failed, error)."""

    # ------------------------------------------------------------- hubs/clusters
    @abstractmethod
    def hubs(self) -> list[Row]: ...

    @abstractmethod
    def cluster_names(self) -> list[str]:
        """Sorted names of known clusters."""

    @abstractmethod
    def get_cluster(self, name: str) -> Row | None:
        """The summary row (former `clusters` columns) or None."""

    @abstractmethod
    def clusters(self, names: Iterable[str] | None = None, **filters) -> list[Row]:
        """Summary rows, sorted by name. `filters` are CLUSTER_DIMENSIONS
        (region, datacenter, environment, hub, version, status) and are
        intersected. `names` restricts to the given clusters."""

    @abstractmethod
    def section(self, name: str, section: str) -> list[Row]:
        """One detail section of one cluster ([] if absent)."""

    @abstractmethod
    def sections(self, name: str, keys: Iterable[str]) -> dict[str, list[Row]]:
        """Several sections of one cluster in one round trip."""

    @abstractmethod
    def section_across(self, section: str, names: Iterable[str] | None = None) -> dict[str, list[Row]]:
        """One section for many clusters (all known if `names` is None), one
        round trip. Each row carries `cluster_name`."""

    @abstractmethod
    def snapshots(self, name: str, limit: int = 100, resolution: str = "sweep",
                  since=None, until=None) -> list[Row]:
        """One cluster's history, oldest first.

        `resolution` picks the tier: 'sweep' (every collection, kept hours),
        'hour' or 'day' (rolled up, kept months and years - see
        `store/history.py`). Without `since` / `until` the last `limit` rows
        come back; with them, the rows inside that window. Bounds may be
        datetimes, epoch seconds or ISO 8601 strings."""

    @abstractmethod
    def snapshots_across(self, names: Iterable[str], resolution: str = "sweep",
                         since=None, until=None,
                         limit_per_cluster: int = 2000) -> dict[str, list[Row]]:
        """The same history for many clusters in one round trip: cluster name
        -> rows, oldest first. Clusters with no history are left out."""

    @abstractmethod
    def changes(self, name: str, limit: int = 200, since=None) -> list[Row]:
        """One cluster's change log, newest first: rows of
        {cluster_name, at, kind, subject, before, after, message} where `kind`
        is one of `history.KINDS`."""

    @abstractmethod
    def changes_across(self, names: Iterable[str] | None = None, since=None,
                       limit_per_cluster: int = 200) -> list[Row]:
        """The fleet's change log, newest first, at most `limit_per_cluster`
        records per cluster (all known clusters when `names` is None)."""

    # ----------------------------------------------------------- fleet views
    @abstractmethod
    def namespaces(self, ns_class: str | None = None, team: str | None = None,
                   app_name: str | None = None, clusters: Iterable[str] | None = None) -> list[Row]:
        """Namespace rows fleet-wide from the `ns` index (each with
        `cluster_name`). Filters intersect; `clusters` restricts to those."""

    @abstractmethod
    def top_namespaces(self, by: str = "cpu", limit: int = 10) -> list[Row]:
        """Highest live usage namespaces fleet-wide (`by` = cpu | memory)."""

    @abstractmethod
    def nodes(self, clusters: Iterable[str] | None = None) -> list[Row]:
        """Node rows fleet-wide from the `nodes` index (each with `cluster_name`)."""

    @abstractmethod
    def top_nodes(self, by: str = "cpu", limit: int = 10) -> list[Row]:
        """Highest utilisation-percent nodes fleet-wide; rows carry `value` (percent)."""

    @abstractmethod
    def operator_index(self, operator: str) -> dict[str, Row]:
        """cluster name -> operator row for one cluster operator."""

    @abstractmethod
    def operator_names(self) -> list[str]: ...

    @abstractmethod
    def pod_issues(self, ns_class: str | None = None, clusters: Iterable[str] | None = None) -> list[Row]:
        """Pod issue rows fleet-wide (each with `cluster_name`)."""

    @abstractmethod
    def pod_issue_counts(self) -> dict[str, int]:
        """{platform: n, application: n} without loading the rows."""

    @abstractmethod
    def fleet_resources(self, key: str, status: str | None = None,
                        clusters: Iterable[str] | None = None) -> list[Row]:
        """Resource rows of a FLEET_INDEXED_KINDS kind (each with `cluster_name`).
        With `status`, only the status set is loaded."""

    @abstractmethod
    def fleet_resource_count(self, key: str, status: str | None = None) -> int:
        """Counter from HLEN / SCARD, never from loading rows."""

    @abstractmethod
    def certificates(self, before: float | None = None, after: float | None = None) -> list[Row]:
        """Certificate-bearing resource rows ordered by expiry. `before` /
        `after` are epoch seconds bounds on `expires_at` (inclusive)."""

    @abstractmethod
    def certificate_count(self, before: float | None = None, after: float | None = None) -> int: ...

    @abstractmethod
    def images(self, needle: str | None = None) -> list[str]:
        """Distinct image strings fleet-wide, optionally containing `needle`
        (case-insensitive substring)."""

    @abstractmethod
    def image_usages(self, image: str) -> list[Row]:
        """Workload usages of one exact image string: rows with cluster_name,
        namespace, workload_kind, workload_name, container, image (+ registry,
        repository, tag, digest)."""

    @abstractmethod
    def references(self, kind: str, name: str) -> list[Row]:
        """Workloads referencing a Secret / ConfigMap / PVC / ServiceAccount of
        that name: rows with cluster_name, namespace, workload_kind,
        workload_name, ref_kind, ref_name, via."""
