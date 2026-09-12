"""
Plumbing shared by every router.

The routers never build a store themselves: they take it as a FastAPI
dependency that resolves the process-wide singleton on each request, so a test
can swap in a fake-Redis store with `app.store.set_store(...)` and the very same
routers answer from it.
"""
from ..store import Store, get_store


def get_store_dep() -> Store:
    """FastAPI dependency: the process-wide store, resolved per request."""
    return get_store()


def order_key(*values):
    """Sort key that puts None last, the way `ORDER BY` did in Postgres.

    Rows are plain dicts now, so a column that used to be NULL reads as None and
    Python refuses to compare it with a string. Sorting through this helper keeps
    the row order the API has always returned (Postgres defaults to NULLS LAST
    on an ascending sort).
    """
    return tuple((v is None, v) for v in values)
