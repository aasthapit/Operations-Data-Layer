"""
The headless collector: its probe, its startup order and its shutdown.

The loop is driven directly rather than through a container, so the store is
fakeredis and the collecting half of startup is replaced by a recorder - what
is under test is that the worker comes up in the right order, keeps its
heartbeat fresh, publishes presence, and leaves cleanly when told to.
"""
import os
import subprocess
import sys
import threading
import time

import fakeredis
import pytest

from app import worker
from app.collector import runner
from app.settings import settings
from app.store import set_store
from app.store.redis_store import RedisStore

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


# --------------------------------------------------------------------------- #
# the probe
# --------------------------------------------------------------------------- #
def test_check_reads_the_heartbeat_age(tmp_path, capsys):
    beat = tmp_path / "odl-worker.heartbeat"

    assert worker.check(30, str(beat)) == 1
    assert "heartbeat" in capsys.readouterr().err

    beat.write_text("")
    assert worker.check(30, str(beat)) == 0

    os.utime(beat, (time.time() - 120, time.time() - 120))
    assert worker.check(30, str(beat)) == 1
    assert "120s old (max 30s)" in capsys.readouterr().err
    assert worker.check(300, str(beat)) == 0


def test_check_defaults_to_the_configured_heartbeat(tmp_path, monkeypatch):
    beat = tmp_path / "beat"
    beat.write_text("")
    monkeypatch.setattr(settings, "worker_heartbeat", str(beat))
    assert worker.check(30) == 0


def test_check_imports_neither_the_collector_nor_redis(tmp_path):
    """The probe runs every few seconds for the life of the pod, so it stats
    one file and nothing else: no store connection to fail on, no collector to
    import. A subprocess is the only honest way to assert that."""
    beat = tmp_path / "beat"
    beat.write_text("")
    script = ("import sys; from app import worker; code = worker.main(['--check']); "
              "print(','.join(m for m in ('app.collector.runner', 'app.store', 'redis') "
              "if m in sys.modules)); sys.exit(code)")
    done = subprocess.run([sys.executable, "-c", script], cwd=ROOT, capture_output=True,
                          text=True, timeout=60,
                          env={**os.environ, "ODL_WORKER_HEARTBEAT": str(beat)})
    assert done.returncode == 0, done.stderr
    assert done.stdout.strip() == ""


def test_check_exit_code_is_the_probe_contract(tmp_path):
    beat = tmp_path / "beat"
    beat.write_text("")
    os.utime(beat, (time.time() - 60, time.time() - 60))
    stale = subprocess.run([sys.executable, "-m", "app.worker", "--check"], cwd=ROOT,
                           capture_output=True, text=True, timeout=60,
                           env={**os.environ, "ODL_WORKER_HEARTBEAT": str(beat)})
    assert stale.returncode == 1 and "old" in stale.stderr
    fresh = subprocess.run([sys.executable, "-m", "app.worker", "--check", "--max-age", "120"],
                           cwd=ROOT, capture_output=True, text=True, timeout=60,
                           env={**os.environ, "ODL_WORKER_HEARTBEAT": str(beat)})
    assert fresh.returncode == 0


# --------------------------------------------------------------------------- #
# the loop
# --------------------------------------------------------------------------- #
@pytest.fixture
def worker_env(tmp_path, monkeypatch):
    """A worker whose store is fakeredis and whose collecting half is recorded
    rather than run. Yields the record of what startup did, in order."""
    from app import startup

    store = RedisStore(fakeredis.FakeRedis(), prefix="odl", snapshot_retention=10)
    set_store(store)
    monkeypatch.setattr(settings, "worker_heartbeat", str(tmp_path / "beat"))
    monkeypatch.setattr(settings, "worker_tick_seconds", 1)
    monkeypatch.setattr(settings, "collect_hubs", ())
    monkeypatch.setattr(settings, "collect_shard", "")

    order = []
    monkeypatch.setattr(startup, "wait_for_redis", lambda *a, **k: order.append("redis"))
    monkeypatch.setattr(startup, "start_collecting",
                        lambda manifest, consume_refresh_queue=True: order.append(
                            f"collect(queue={consume_refresh_queue})"))
    yield {"store": store, "order": order, "beat": tmp_path / "beat"}
    set_store(None)


def test_the_worker_comes_up_beats_and_stops(worker_env):
    store, order, beat = worker_env["store"], worker_env["order"], worker_env["beat"]
    instance = runner.instance_name()

    done = []
    thread = threading.Thread(target=lambda: done.append(worker.serve()), daemon=True)
    thread.start()
    deadline = time.time() + 10
    while time.time() < deadline and not store.collectors():
        time.sleep(0.05)

    # Redis first, then the collecting half - and it must not start a second
    # queue consumer, because this loop is one.
    assert order == ["redis", "collect(queue=False)"]
    assert beat.exists() and time.time() - beat.stat().st_mtime < 5
    live = store.collectors()
    assert [c["instance"] for c in live] == [instance]

    # SIGTERM's effect, raised the way a test can: the loop leaves promptly,
    # exits 0, and takes its presence with it.
    worker._stopping.set()
    thread.join(timeout=5)
    assert not thread.is_alive() and done == [0]
    assert store.collectors() == []


def test_a_signal_sets_the_stop_flag(worker_env):
    import signal

    worker._stopping.clear()
    worker._on_signal(signal.SIGTERM, None)
    assert worker._stopping.is_set()


def test_the_worker_drains_the_queue_as_it_beats(worker_env, monkeypatch):
    from app.collector import coordination

    store = worker_env["store"]
    collected = []
    monkeypatch.setattr(coordination, "_collect", lambda fn, what: collected.append(what))

    done = []
    thread = threading.Thread(target=lambda: done.append(worker.serve()), daemon=True)
    thread.start()
    deadline = time.time() + 10
    while time.time() < deadline and not store.collectors():
        time.sleep(0.05)
    store.request_refresh(full=True, origin="api-1")
    while time.time() < deadline and not collected:
        time.sleep(0.05)
    worker._stopping.set()
    thread.join(timeout=5)

    assert collected == ["sweep"] and done == [0]


def test_main_routes_check_without_starting_anything(tmp_path, monkeypatch):
    beat = tmp_path / "beat"
    beat.write_text("")
    monkeypatch.setattr(settings, "worker_heartbeat", str(beat))
    monkeypatch.setattr(worker, "serve", lambda: pytest.fail("--check must not serve"))
    assert worker.main(["--check"]) == 0
