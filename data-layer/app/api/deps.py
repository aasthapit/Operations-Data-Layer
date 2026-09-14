"""
Plumbing shared by every router.

The routers never build a store themselves: they take it as a FastAPI
dependency that resolves the process-wide singleton on each request, so a test
can swap in a fake-Redis store with `app.store.set_store(...)` and the very same
routers answer from it.
"""
from fastapi import HTTPException

from ..store import Store, get_store
from ..store.history import KINDS, RESOLUTIONS

# Query-parameter documentation shared by the history endpoints, so the one
# sentence describing a tier is written once.
RESOLUTION_DOC = ("sweep (every collection, last 48h) | hour (last 90 days) | "
                  "day (last 2 years)")
KIND_DOC = "filter to one change kind: " + " | ".join(KINDS)


def get_store_dep() -> Store:
    """FastAPI dependency: the process-wide store, resolved per request."""
    return get_store()


def resolution(value: str) -> str:
    """A history tier name, or a 400 naming the ones that exist."""
    if value not in RESOLUTIONS:
        raise HTTPException(400, f"resolution must be one of {', '.join(RESOLUTIONS)}")
    return value


def order_key(*values):
    """Sort key that puts None last, the way `ORDER BY` did in Postgres.

    Rows are plain dicts now, so a column that used to be NULL reads as None and
    Python refuses to compare it with a string. Sorting through this helper keeps
    the row order the API has always returned (Postgres defaults to NULLS LAST
    on an ascending sort).
    """
    return tuple((v is None, v) for v in values)
