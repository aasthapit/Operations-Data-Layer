"""
The headless collector: `python -m app.worker`.

It is the same collector the API runs in `all` mode, with the HTTP half taken
away. That is the whole point of splitting the deployment: the pods that hold
the fleet's credentials and do minutes-long sweeps are not the pods that answer
a dashboard, so they scale, restart and fail on their own terms.

Startup is `app.startup.start_collecting`, shared with the API so the two
cannot drift. Then a loop that, every `ODL_WORKER_TICK_SECONDS`:

  * touches the heartbeat file, which is what the liveness probe reads,
  * republishes this collector's presence in Redis,
  * drains the refresh queue (see `app/collector/coordination.py`).

`--check` is that probe, and it is deliberately the thinnest thing in the
codebase: it stats one file. It runs every few seconds for the life of the pod,
so it imports neither the collector nor Redis, and it cannot fail because the
store is briefly unreachable - a collector waiting on Redis is not a collector
that should be killed and restarted into the same wait.
"""
import argparse
import logging
import os
import signal
import sys
import threading
import time

from .settings import settings

log = logging.getLogger("odl.worker")

# Set by SIGTERM / SIGINT. A module global rather than a local so a test can
# drive the loop to a stop without raising signals at the test runner.
_stopping = threading.Event()


# --------------------------------------------------------------------------- #
# the probe
# --------------------------------------------------------------------------- #
def check(max_age: float, path: str | None = None) -> int:
    """0 when the heartbeat is younger than `max_age` seconds, 1 otherwise."""
    path = path or settings.worker_heartbeat
    try:
        age = time.time() - os.stat(path).st_mtime
    except OSError as e:
        print(f"worker heartbeat {path}: {e.strerror or e}", file=sys.stderr)
        return 1
    if age > max_age:
        print(f"worker heartbeat {path} is {age:.0f}s old (max {max_age:.0f}s)",
              file=sys.stderr)
        return 1
    return 0


# --------------------------------------------------------------------------- #
# the loop
# --------------------------------------------------------------------------- #
def _on_signal(signum, _frame) -> None:
    log.info("%s: stopping", signal.Signals(signum).name)
    _stopping.set()


def _install_signal_handlers() -> threading.Event:
    _stopping.clear()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _on_signal)
        except ValueError:
            # Not the main thread: a test driving the loop directly stops it
            # through the event instead.
            log.debug("no signal handler for %s off the main thread", sig)
    return _stopping


def _touch(path: str) -> None:
    """Move the heartbeat's mtime forward, creating it the first time. Written
    empty on purpose: the probe reads the timestamp, never the contents."""
    try:
        with open(path, "a"):
            os.utime(path, None)
    except OSError as e:
        log.warning("cannot write the heartbeat %s: %s", path, e)


def serve() -> int:
    """Collect until a signal says to stop. Always returns 0: a collector that
    is asked to go away has done nothing wrong."""
    # Imported here, not at the top, so `--check` stays a stat() of one file.
    from .collector import coordination
    from .collector.runner import instance_name
    from .manifest import get_manifest
    from .scheduler import stop_scheduler
    from .startup import start_collecting, wait_for_redis
    from .store import get_store

    manifest = get_manifest()          # fail fast on a bad manifest
    log.info("manifest %s: %d resources enabled", manifest.source, len(manifest.enabled_keys()))
    wait_for_redis()
    # The worker is its own queue consumer, so the startup shared with the API
    # must not start a second one.
    start_collecting(manifest, consume_refresh_queue=False)

    store = get_store()
    instance = instance_name()
    consumer = coordination.RefreshConsumer(store, instance)
    stopping = _install_signal_handlers()
    tick = max(1, settings.worker_tick_seconds)
    log.info("worker %s up: tick %ss, heartbeat %s", instance, tick, settings.worker_heartbeat)
    try:
        while True:
            _touch(settings.worker_heartbeat)
            coordination.tick(store, consumer)
            if stopping.wait(tick):
                break
    finally:
        # A sweep may be in flight and is abandoned: every cluster is written
        # in one transaction, so what it finished is already durable and what
        # it did not will be collected again by whoever comes next.
        stop_scheduler()
        coordination.clear_presence(store)
        try:
            store.clear_progress(instance)
        except Exception as e:  # noqa: BLE001 - shutdown must not fail on the store
            log.debug("clearing progress failed: %s", e)
    log.info("worker %s stopped", instance)
    return 0


# --------------------------------------------------------------------------- #
# entry point
# --------------------------------------------------------------------------- #
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m app.worker",
        description="Headless Operations Data Layer collector.")
    parser.add_argument("--check", action="store_true",
                        help="liveness probe: exit 0 when the heartbeat file is fresh")
    parser.add_argument("--max-age", type=float, default=30,
                        help="how old the heartbeat may be for --check (seconds, default 30)")
    args = parser.parse_args(argv)
    if args.check:
        return check(args.max_age)
    from .startup import configure_logging
    configure_logging()
    return serve()


if __name__ == "__main__":
    code = main()
    logging.shutdown()
    # A sweep in flight holds pool threads the interpreter would otherwise
    # join on the way out, and a cluster that stopped answering can hold one
    # for the length of its timeout. The orchestrator's grace period is
    # shorter than that, and nothing here needs an orderly teardown, so leave
    # now rather than be killed later.
    os._exit(code)
