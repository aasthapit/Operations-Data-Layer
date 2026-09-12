# Store contract gaps found while porting the API

Places where an endpoint in `data-layer/app/api/` needs something the `Store` contract (`app/store/base.py`, `docs/redis-keyspace.md`) does not offer.
Nothing here was worked around by changing `base.py`; each is composed from the primitives that do exist, and each is recorded so the reviewer can decide whether the contract should grow.

## 1. No counter for distinct applications

`GET /api/insights/summary` reports `applications`: the number of distinct `app_name` values across application-class namespaces.
Every other counter on that response comes from an `HLEN` / `SCARD` / `ZCOUNT`, in keeping with the keyspace doc's rule that fleet counters never load rows.
This one cannot: the store exposes `namespaces(ns_class="application")`, which materialises every application namespace in the fleet (order 10^5 rows at the target scale) only to take the size of a set of names.
The information is already in Redis as the set of `idx:ns:app:<app>` keys, so a cheap answer exists (a counter hash of application names, or a `SCAN` over that prefix), but nothing in the contract surfaces it.
Until it does, the tile is paid for with a full read of the namespace index.
If that becomes the slow part of the overview, the fix is a fleet counter, not a change in the router.

## 2. No fleet counter for kinds that are not fleet-indexed

`GET /api/insights/resources?kind=...` answers over any collected kind.
For the ten fleet-indexed kinds it is one hash read.
For every other kind (`configmaps`, `secrets`, `services`, `ingresses`, `networkpolicies`, `cronjobs`, `horizontalpodautoscalers`) the rows live only in each cluster's `resources` section, and the keyspace doc says such a query "iterates clusters and stops at the requested limit".
Stopping early would make the response's `total` field a restatement of `limit` rather than a count, and `total` is what tells a caller whether the page it is looking at is the whole answer.
So `_scan_resources` walks every cluster (in chunks of 25, in name order, materialising only the first `limit` rows) and counts all matches: `total` is exact and memory is bounded, but the read cost is the whole fleet's inventory sections rather than a prefix of them.
A per-kind fleet counter, or an explicit "approximate total" in the contract, would let this endpoint stop early honestly.
The single-cluster form (`?cluster=`), which is what the dashboard actually calls, is one section read either way.

## 3. Namespaces have no index by namespace name

`GET /api/applications/{app}` falls back to matching the namespace name when no namespace carries that `app` label, exactly as the SQL version did.
The store indexes namespaces by class, team and `app_name`, but not by name, so that fallback is a read of every application namespace in the fleet followed by an in-process filter.
In practice the collector sets `app_name` to the namespace name whenever the label is absent (`collector/collect.py`), so the fallback is close to dead code and the cost is theoretical.
It is listed because a reader of the router will wonder why one branch is indexed and the other is a scan.
