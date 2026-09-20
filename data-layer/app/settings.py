"""Runtime configuration, all overridable via environment."""
import os


class Settings:
    # Redis is the store: a pull cache of OCP inventory and utilization, never
    # a system of record. The keyspace is documented in docs/redis-keyspace.md.
    redis_url: str = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
    # Key prefix, so one Redis can hold several environments side by side.
    redis_prefix: str = os.environ.get("REDIS_PREFIX", "odl")
    # Per-cluster keys expire, so a cluster that is never collected again ages
    # out instead of lingering forever (the server runs with `noeviction`, which
    # never drops keys on its own). 0 disables expiry.
    redis_ttl_seconds: int = int(os.environ.get("REDIS_TTL_SECONDS", "86400"))
    # The fleet config. May contain `hubs:` (ACM discovery), `clusters:` (a
    # direct list of OCP endpoints), and `defaults:` (shared auth/TLS).
    # ODL_CONFIG is the preferred name; HUBS_CONFIG is kept as an alias.
    config_path: str = os.environ.get(
        "ODL_CONFIG", os.environ.get("HUBS_CONFIG", "/app/config/hubs.yaml")
    )
    # The OCP API manifest: which resources are collected from every cluster,
    # how namespaces are classified, ownership labels, health thresholds.
    manifest_path: str = os.environ.get(
        "ODL_MANIFEST", "/app/config/ocp-api-manifest.yaml"
    )

    # How often the collector polls the fleet (seconds). Reads are always served
    # from Redis; this only controls how fresh that cache is.
    refresh_interval_seconds: int = int(
        os.environ.get("REFRESH_INTERVAL_SECONDS", "120")
    )
    # Whether this instance collects at all. A read-only API (a dev server on
    # the host, or API pods separated from collector pods) sets this to false:
    # no startup sweep, no scheduler, and a refresh is handed to the collectors
    # through the refresh queue (docs/redis-keyspace.md).
    collector_enabled: bool = os.environ.get("COLLECTOR_ENABLED", "true") == "true"
    # What this process is in a split deployment: `api` (read-only, never
    # collects), `worker` (headless collector, no HTTP) or `all` (both in one
    # process, which is what docker-compose and a dev host run). The image's
    # entrypoint sets it; nothing here branches on it, it is reported so an
    # operator reading /api/status can tell which pod answered.
    role: str = os.environ.get("ODL_ROLE", "all")
    # The headless collector's heartbeat: how often it touches the file below,
    # publishes its presence and drains the refresh queue. The file's age is
    # the liveness probe (`python -m app.worker --check`), so it has to be
    # short enough for a probe interval and long enough to survive a busy loop.
    worker_tick_seconds: int = int(os.environ.get("ODL_WORKER_TICK_SECONDS", "5"))
    # Under a read-only root filesystem /tmp is the one writable path, which is
    # also where HOME points in the image.
    worker_heartbeat: str = os.environ.get("ODL_WORKER_HEARTBEAT", "/tmp/odl-worker.heartbeat")
    # Run a collection sweep once at startup.
    refresh_on_startup: bool = os.environ.get("REFRESH_ON_STARTUP", "true") == "true"
    # Clusters are collected in parallel; this bounds the fan-out (and the
    # number of concurrent connections to cluster API servers).
    # Each worker holds one cluster's raw objects in memory while it parses
    # them (tens of MB for a large cluster), which is what bounds this.
    collect_workers: int = int(os.environ.get("COLLECT_WORKERS", "8"))
    # Run several collector processes side by side: "i/n" makes this instance
    # collect only the clusters whose name hashes to shard i of n (0-based).
    # Every shard writes its own clusters to the shared Redis; shard 0 does
    # the end-of-sweep housekeeping. Empty = the whole fleet.
    collect_shard: str = os.environ.get("COLLECT_SHARD", "")
    # Which ACM hubs this instance owns: a comma-separated list of hub names,
    # empty = every configured hub. One collector per hub is the unit that
    # scales to an estate of several hubs with ~100 clusters each: the process
    # holds only that hub's credentials, discovers only its ManagedClusters,
    # and prunes only its own clusters. Composes with COLLECT_SHARD, which then
    # partitions the owned hubs' clusters further.
    collect_hubs: tuple = tuple(
        name.strip() for name in os.environ.get("COLLECT_HUBS", "").split(",") if name.strip()
    )
    # Within one cluster the manifest's resource kinds are fetched concurrently;
    # this bounds that fan-out. Against a real cluster over a network the
    # sequential sum of ~30 round trips (plus pages) is what makes a sweep slow,
    # so this is the first knob to turn. Keep it modest: the API server's
    # priority-and-fairness limits apply per identity.
    collect_fetch_workers: int = int(os.environ.get("COLLECT_FETCH_WORKERS", "6"))
    # Page size for list calls against a cluster (large clusters have thousands
    # of pods / secrets; paging keeps API-server memory bounded).
    list_page_size: int = int(os.environ.get("LIST_PAGE_SIZE", "500"))

    # OCP versions below this floor fail the `version-supported` health check.
    supported_floor: str = os.environ.get("SUPPORTED_FLOOR", "4.15.0")

    # The dimension the dashboard groups and filters by first: hub (ACM hub,
    # the natural unit of a real estate), region, datacenter or environment.
    primary_dimension: str = os.environ.get("ODL_PRIMARY_DIMENSION", "hub")
    if primary_dimension not in ("hub", "region", "datacenter", "environment"):
        raise ValueError("ODL_PRIMARY_DIMENSION must be hub, region, datacenter or environment")

    # History is kept in three tiers per cluster, each trimmed by time rather
    # than by row count: every sweep for SNAPSHOT_RAW_HOURS, one row per hour
    # for SNAPSHOT_HOURLY_DAYS, one row per day for SNAPSHOT_DAILY_DAYS. The
    # windows are what a trend question asks for ("crash loops per hour over
    # the last day", "warning events per day over the last month"); the row
    # count a sweep interval produces is an implementation detail.
    snapshot_raw_hours: int = int(os.environ.get("SNAPSHOT_RAW_HOURS", "48"))
    snapshot_hourly_days: int = int(os.environ.get("SNAPSHOT_HOURLY_DAYS", "90"))
    snapshot_daily_days: int = int(os.environ.get("SNAPSHOT_DAILY_DAYS", "730"))
    # A hard safety cap on the raw tier only, so a pathologically short sweep
    # interval cannot grow one cluster's per-sweep history without bound.
    # Sized for the default window: 48h at a 2-minute sweep is 1440 rows.
    snapshot_retention: int = int(os.environ.get("SNAPSHOT_RETENTION", "2000"))


settings = Settings()
