"""
Cache-aside for computed fleet views.

Fleet-wide answers (health by dimension, the applications list, the insight
counters, version spread, capacity) are computed from every cluster's rows
and cost seconds on a large fleet, yet they can only change when a cluster is
written. The store keeps a generation counter that every cluster write bumps;
a computed view is stored next to the generation it was computed from and
served as long as the generation has not moved. Between sweeps every
dashboard visit is therefore a single Redis GET; during a sweep the cache
misses as clusters land, which is today's behaviour.
"""
from __future__ import annotations

import hashlib
import json
from collections.abc import Callable

from ..store import Store

TTL_SECONDS = 15 * 60


def cache_key(name: str, **params) -> str:
    """`applications:<sha1 of the sorted parameters>`; parameters that are
    None or empty do not change the key."""
    # False is a real filter value (assigned=false), so only "absent" is dropped
    clean = {k: v for k, v in sorted(params.items()) if v is not None and v != "" and v != []}
    digest = hashlib.sha1(json.dumps(clean, sort_keys=True, default=str).encode()).hexdigest()[:16]
    return f"{name}:{digest}" if clean else name


def cached(store: Store, key: str, compute: Callable[[], dict], ttl_seconds: int = TTL_SECONDS) -> dict:
    """Return the cached body for `key` if it was computed at the current
    generation, else compute, store and return it. A store that cannot cache
    (or a cache read error) simply computes."""
    try:
        generation = store.generation()
        entry = store.cache_get(key)
    except Exception:  # noqa: BLE001 - caching is an optimisation, never a failure
        return compute()
    if entry and entry.get("gen") == generation:
        return entry["body"]
    body = compute()
    try:
        store.cache_set(key, {"gen": generation, "body": body}, ttl_seconds)
    except Exception:  # noqa: BLE001
        pass
    return body
