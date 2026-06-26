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

    # Number of historical health snapshots kept per cluster (for the timeline).
    snapshot_retention: int = int(os.environ.get("SNAPSHOT_RETENTION", "500"))


settings = Settings()
