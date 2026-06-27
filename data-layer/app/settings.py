"""Runtime configuration, all overridable via environment."""
import os


class Settings:
    database_url: str = os.environ.get(
        "DATABASE_URL", "postgresql+psycopg2://odl:odl@localhost:5432/odl"
    )
    # The fleet config. May contain `hubs:` (ACM discovery), `clusters:` (a
    # direct list of OCP endpoints), and `defaults:` (shared auth/TLS).
    # ODL_CONFIG is the preferred name; HUBS_CONFIG is kept as an alias.
    config_path: str = os.environ.get(
        "ODL_CONFIG", os.environ.get("HUBS_CONFIG", "/app/config/hubs.yaml")
    )

    # How often the collector polls the fleet (seconds). Reads are always served
    # from Postgres; this only controls how fresh that cache is.
    refresh_interval_seconds: int = int(
        os.environ.get("REFRESH_INTERVAL_SECONDS", "120")
    )
    # Run a collection sweep once at startup.
    refresh_on_startup: bool = os.environ.get("REFRESH_ON_STARTUP", "true") == "true"

    # OCP versions below this floor fail the `version-supported` health check.
    supported_floor: str = os.environ.get("SUPPORTED_FLOOR", "4.15.0")

    # Metrics plane (Thanos Query / Prometheus-compatible PromQL endpoint).
    # In production this is the ACM hub's Thanos Querier, or a Grafana
    # datasource-proxy URL if you only have Grafana access (see docs/onboarding.md).
    thanos_url: str = os.environ.get("THANOS_URL", "http://thanos-query:10902")
    # Auth for a secured metrics endpoint (pick one).
    thanos_token: str = os.environ.get("THANOS_TOKEN", "")          # Bearer token (e.g. Grafana service-account token)
    thanos_basic_auth: str = os.environ.get("THANOS_BASIC_AUTH", "")  # "user:password"
    thanos_verify_tls: bool = os.environ.get("THANOS_VERIFY_TLS", "true") == "true"
    # Which PromQL dialect the metric expressions use:
    #   local = our generator's odl_* series; kube = standard kube/OCP series.
    metrics_profile: str = os.environ.get("METRICS_PROFILE", "local")

    # Number of historical health snapshots kept per cluster (for the timeline).
    snapshot_retention: int = int(os.environ.get("SNAPSHOT_RETENTION", "500"))


settings = Settings()
