"""
How the processes of a split deployment agree on who collects.

In one process (`ODL_ROLE=all`) a refresh is a function call. Split into an API
pod and collector pods it is not: `POST /api/refresh` lands on a process that
holds no cluster credentials and runs no scheduler, and the only honest answers
there are "handed to a live collector" or "nobody is collecting". Two Redis
keys carry that, both described in docs/redis-keyspace.md:

* **presence** - every process that collects republishes itself under
  `odl:{fleet}:collector:<instance>` with a TTL of a few ticks. Liveness is
  then expiry: a collector that is killed stops existing without anybody having
  to clean up after it, and `GET /api/status` lists whoever is left.
* **the refresh queue** - a capped stream that a process appends to and every
  collector reads independently. A consumer starts at *now*, so a restart never
  replays yesterday's requests; it skips entries it published itself, so a
  collecting API that already swept locally does not sweep twice; and it
  coalesces one tick's fleet-wide entries into a single sweep, because three
  people pressing Refresh want one sweep, not three.

Ownership is the collector's existing rule, unchanged: a single-cluster request
is acted on by the collector that owns the cluster's hub (`COLLECT_HUBS`) and
whose shard the name hashes into (`COLLECT_SHARD`), so exactly one process
picks it up and a cluster nobody has collected yet is ignored.

Collecting happens on a thread of its own, never on the caller's: the caller is
a heartbeat loop that a minutes-long sweep must not block.
"""
import logging
import threading

from .. import __version__
from ..settings import settings
from ..store import Store
from . import runner
from .runner import instance_name, utcnow

log = logging.getLogger("odl.coordination")

# When this process started collecting, so presence says how long a collector
# has been up rather than only that it answered a moment ago.
_STARTED_AT = utcnow()

_background: threading.Thread | None = None
_stop = threading.Event()


def presence_ttl() -> int:
    """Three ticks plus a margin: a collector may miss one tick to a long
    Redis call without being declared dead, and a killed one disappears within
    a handful of seconds."""
    return max(15, 3 * settings.worker_tick_seconds + 5)


def presence(role: str | None = None) -> dict:
    """What this collector publishes about itself."""
    return {"instance": instance_name(), "role": role or settings.role,
            "hubs": list(runner.owned_hubs()), "shard": settings.collect_shard or None,
            "started_at": _STARTED_AT, "at": utcnow(), "version": __version__}


def publish_presence(store: Store, role: str | None = None) -> None:
    try:
        store.set_collector(instance_name(), presence(role), presence_ttl())
    except Exception as e:  # noqa: BLE001 - presence is a courtesy, never a failure
        log.debug("publishing presence failed: %s", e)


def clear_presence(store: Store) -> None:
    try:
        store.clear_collector(instance_name())
    except Exception as e:  # noqa: BLE001
        log.debug("clearing presence failed: %s", e)


def _collect(fn, what: str) -> None:
    """Run one sweep or refresh off the caller's thread. `run_collection` and
    `refresh_cluster` are already single-flight, so a request arriving while
    one runs is dropped rather than queued behind it."""
    threading.Thread(target=fn, name=f"odl-refresh-{what}", daemon=True).start()


class RefreshConsumer:
    """One collector's cursor over the refresh queue.

    Constructed at *now*: everything already in the stream belongs to a past
    this process is not responsible for.
    """

    def __init__(self, store: Store, instance: str | None = None):
        self.instance = instance or instance_name()
        self.after_id = self._cursor(store)

    @staticmethod
    def _cursor(store: Store) -> str:
        try:
            return store.refresh_cursor()
        except Exception as e:  # noqa: BLE001 - an unreachable Redis is the tick's problem
            log.debug("reading the refresh cursor failed: %s", e)
            return "0-0"

    def consume(self, store: Store) -> int:
        """Act on everything queued since the last call; returns how many
        entries this collector handled."""
        try:
            entries = store.refresh_requests(self.after_id)
        except Exception as e:  # noqa: BLE001
            log.debug("reading the refresh queue failed: %s", e)
            return 0
        if not entries:
            return 0
        self.after_id = entries[-1]["id"]
        mine = [e for e in entries if e["origin"] != self.instance]
        if not mine:
            return 0

        handled = 0
        sweeps = [e for e in mine if not e["cluster"]]
        if sweeps:
            full = any(e["full"] for e in sweeps)
            log.info("refresh queue: %d fleet request(s) -> one sweep (full=%s)",
                     len(sweeps), full)
            # "manual" so the sweep forces every cluster instead of skipping
            # the ones collected within the interval, exactly as a refresh
            # issued on this process would.
            _collect(lambda: runner.run_collection("manual", full), "sweep")
            handled += len(sweeps)
        for entry in mine:
            name = entry["cluster"]
            if not name or not self._owns(store, name):
                continue
            log.info("refresh queue: refreshing %s (full=%s)", name, entry["full"])
            _collect(lambda n=name, f=entry["full"]: runner.refresh_cluster(n, f), name)
            handled += 1
        return handled

    def _owns(self, store: Store, name: str) -> bool:
        """Whether this collector is the one responsible for that cluster."""
        try:
            known = store.get_cluster(name)
        except Exception as e:  # noqa: BLE001
            log.debug("refresh queue: reading %s failed: %s", name, e)
            return False
        if known is None:
            log.debug("refresh queue: unknown cluster %s; ignoring", name)
            return False
        if not runner.in_shard(name, runner._shard()):
            return False
        return runner.owns_hub(known.hub_name, runner.owned_hubs())


def tick(store: Store, consumer: RefreshConsumer, role: str | None = None) -> None:
    """One beat of a collector: say you are alive, then drain the queue."""
    publish_presence(store, role)
    consumer.consume(store)


def start_background(role: str | None = None) -> threading.Thread:
    """`all` mode: the process both serves HTTP and collects, so presence and
    the queue need a small thread beside the scheduler. The headless worker
    ticks from its own main loop instead."""
    global _background
    if _background is not None:
        return _background
    from ..store import get_store

    def loop():
        store = get_store()
        consumer = RefreshConsumer(store)
        while True:
            tick(store, consumer, role)
            if _stop.wait(settings.worker_tick_seconds):
                return

    _stop.clear()
    _background = threading.Thread(target=loop, name="odl-coordination", daemon=True)
    _background.start()
    log.info("refresh queue consumer started (every %ss)", settings.worker_tick_seconds)
    return _background


def stop_background() -> None:
    """Stop the `all`-mode thread and withdraw this process's presence."""
    global _background
    _stop.set()
    _background = None
    from ..store import get_store
    try:
        clear_presence(get_store())
    except Exception as e:  # noqa: BLE001
        log.debug("clearing presence at shutdown failed: %s", e)
