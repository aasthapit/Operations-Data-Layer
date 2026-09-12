"""Storage for the collected fleet state. See base.py for the contract."""
from .base import CLUSTER_DIMENSIONS, FLEET_INDEXED_KINDS, SECTIONS, Row, Store

__all__ = ["CLUSTER_DIMENSIONS", "FLEET_INDEXED_KINDS", "SECTIONS", "Row", "Store", "get_store"]

_store: Store | None = None


def get_store() -> Store:
    """Process-wide store singleton (created lazily from settings)."""
    global _store
    if _store is None:
        from .redis_store import RedisStore
        _store = RedisStore.from_settings()
    return _store


def set_store(store: Store | None) -> None:
    """Replace the singleton (tests)."""
    global _store
    _store = store
