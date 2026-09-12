"""
Natural-language queries over the fleet state.

The store is Redis, which answers the questions the API was built for but
cannot answer an arbitrary one ("which teams run an image on clusters in
eu-west that are still on 4.15?"). This package gives those questions a
relational surface:

    Redis  --(after every sweep)-->  DuckDB snapshot  <--SQL--  question

DuckDB is an in-process library, not a service, so the deployment stays
Redis-only. The tables it exposes are the tables the data layer always had
(the former Postgres schema, see `schema.py`), so the docs, the dashboard's
mental model and the SQL an LLM writes all agree.

Three pieces, each independently testable:

  * `schema.py`   - the tables, columns and curated notes: the semantic layer
                    the model reads, and the allowlist the guard enforces.
  * `snapshot.py` - builds (and caches) the DuckDB snapshot from the store.
  * `guard.py`    - the security boundary: one read-only SELECT, known tables,
                    no file or catalog functions, a bounded LIMIT.

`llm.py` turns a question into SQL and `service.py` runs the generate ->
validate -> execute loop, retrying once with the error fed back.
"""
from .errors import QueryExecutionError, QueryRejected, QueryTimeout, QueryUnavailable

__all__ = ["QueryExecutionError", "QueryRejected", "QueryTimeout", "QueryUnavailable", "invalidate"]


def invalidate() -> None:
    """Drop the cached snapshot; the next query rebuilds it from the store.

    Called by the collector at the end of a sweep. Importing lazily keeps
    `app.query` free of a DuckDB import for callers that only need the
    exception types.
    """
    from .snapshot import invalidate as _invalidate
    _invalidate()
