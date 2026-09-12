"""
Failure modes of a natural-language query, as distinct types.

They exist because each maps to a different HTTP status and a different
message to the user: a rejected query is the caller's fault (400), a timeout
is the query's fault (504), a missing API key is the operator's fault (503),
and a generated query that does not run is ours to retry (422 after the
retry).
"""


class QueryRejected(Exception):
    """The SQL did not pass the guard. `reason` is safe to show the user."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class QueryExecutionError(Exception):
    """DuckDB refused to run or failed to finish the (validated) query."""


class QueryTimeout(QueryExecutionError):
    """The query ran longer than ODL_QUERY_TIMEOUT_SECONDS and was interrupted."""


class QueryUnavailable(Exception):
    """Question -> SQL translation is not available (no credentials, API down)."""
