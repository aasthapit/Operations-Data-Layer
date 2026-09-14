"""
Query-plane configuration, all overridable via environment.

Kept separate from `app.settings` because these knobs belong to the
natural-language query feature only, and because the values are read by the
guard and the executor, which must not depend on the collector's settings.
"""
import os


class QueryConfig:
    # Hard ceiling on rows returned by any query. The guard rewrites the SQL
    # so the database never produces more than this, rather than trimming
    # afterwards (a 10M-row aggregate would otherwise be materialised first).
    max_rows: int = int(os.environ.get("ODL_QUERY_MAX_ROWS", "500"))

    # Wall-clock budget for one query. DuckDB is interrupted when it expires.
    timeout_seconds: float = float(os.environ.get("ODL_QUERY_TIMEOUT_SECONDS", "10"))

    # The model that writes the SQL, and how hard it is asked to think.
    model: str = os.environ.get("ODL_QUERY_MODEL", "claude-opus-5")
    effort: str = os.environ.get("ODL_QUERY_EFFORT", "medium")
    max_tokens: int = int(os.environ.get("ODL_QUERY_MAX_TOKENS", "4096"))

    # A changed fleet marks the SQL snapshot stale; it is then rebuilt in the
    # background at most this often while queries keep using the last build.
    # With several collectors sweeping, the marker changes every few seconds,
    # and rebuilding a large fleet per request is what made the Query page hang.
    rebuild_seconds: float = float(os.environ.get("ODL_QUERY_REBUILD_SECONDS", "60"))

    # Attempts per question: the first try plus one retry with the error fed
    # back. More than two turns rarely fixes anything a human would not.
    max_attempts: int = int(os.environ.get("ODL_QUERY_MAX_ATTEMPTS", "2"))


query_config = QueryConfig()
