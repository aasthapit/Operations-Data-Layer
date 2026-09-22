"""
The startup every process shares.

The point of `app/startup.py` is that the API and the headless worker cannot
drift apart: both refuse to come up on a missing Redis, a missing fleet config
or a missing application registry, and both fail with a message that names the
fix. These tests pin those refusals and the order of the checks, because a
process that comes up and quietly collects nothing is the failure mode the
module exists to prevent.

Nothing here touches a real Redis, a real cluster or a gitignored file: the
store is a stub, and the collector seams (`run_collection`, `start_scheduler`,
`start_background`) record that they were called.
"""
import logging
import os
import threading
from types import SimpleNamespace

import pytest

from app import startup
from app.settings import settings
from app.store import set_store


class _Store:
    """A store whose ping can be made to fail as often as a test likes."""

    def __init__(self, failures=0):
        self.failures = failures
        self.pings = 0

    def ping(self):
        self.pings += 1
        if self.pings <= self.failures:
            raise ConnectionError("redis is not up yet")
        return True


@pytest.fixture(autouse=True)
def no_sleeping(monkeypatch):
    """The retry loop's delay is behaviour under test, not wall clock to spend."""
    slept = []
    monkeypatch.setattr(startup.time, "sleep", slept.append)
    return slept


@pytest.fixture
def store():
    st = _Store()
    set_store(st)
    yield st
    set_store(None)


# --------------------------------------------------------------------------- #
# logging
# --------------------------------------------------------------------------- #
def test_every_process_logs_in_the_same_format(monkeypatch):
    seen = {}
    monkeypatch.setattr(logging, "basicConfig", lambda **kw: seen.update(kw))
    startup.configure_logging()
    assert seen == {"level": logging.INFO, "format": startup.LOG_FORMAT}


# --------------------------------------------------------------------------- #
# redis
# --------------------------------------------------------------------------- #
def test_waiting_for_redis_returns_on_the_first_answer(store, no_sleeping):
    startup.wait_for_redis()
    assert store.pings == 1 and no_sleeping == []


def test_waiting_for_redis_retries_before_it_gives_up(store, no_sleeping):
    store.failures = 2
    startup.wait_for_redis(retries=5, delay=0.25)
    assert store.pings == 3 and no_sleeping == [0.25, 0.25]


def test_a_redis_that_never_answers_is_a_startup_error(store, no_sleeping):
    store.failures = 99
    with pytest.raises(RuntimeError, match="redis never became reachable"):
        startup.wait_for_redis(retries=3, delay=1)
    assert store.pings == 3 and no_sleeping == [1, 1, 1]


# --------------------------------------------------------------------------- #
# fleet config
# --------------------------------------------------------------------------- #
def test_an_existing_fleet_config_satisfies_the_check(monkeypatch, tmp_path):
    path = tmp_path / "hubs.yaml"
    path.write_text("hubs: []\n")
    monkeypatch.setattr(settings, "config_path", str(path))
    startup.require_fleet_config()          # no exception is the assertion


def test_a_missing_fleet_config_names_the_env_var_and_the_examples(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "config_path", str(tmp_path / "absent.yaml"))
    with pytest.raises(RuntimeError) as err:
        startup.require_fleet_config()
    message = str(err.value)
    assert "ODL_CONFIG" in message and "COLLECTOR_ENABLED=false" in message
    assert "acm.example.yaml" in message and "clusters.example.yaml" in message


# --------------------------------------------------------------------------- #
# application mapping
# --------------------------------------------------------------------------- #
def _manifest(source):
    return SimpleNamespace(applications={"source": source})


def test_label_based_ownership_needs_no_mapping_file(monkeypatch):
    def unexpected(_manifest):
        raise AssertionError("the mapping must not be read when ownership is labels")

    monkeypatch.setattr("app.appmap.get_appmap", unexpected)
    startup.require_application_mapping(_manifest("labels"))


def test_a_present_mapping_is_described_at_startup(monkeypatch, caplog):
    monkeypatch.setattr("app.appmap.get_appmap",
                        lambda _m: SimpleNamespace(describe=lambda: "3 namespaces"))
    with caplog.at_level(logging.INFO, logger="odl.startup"):
        startup.require_application_mapping(_manifest("mapping"))
    assert "3 namespaces" in caplog.text


def test_a_mapping_the_manifest_requires_but_nobody_mounted_is_a_startup_error(monkeypatch):
    def missing(_m):
        raise FileNotFoundError("/app/config/app-map.json")

    monkeypatch.setattr("app.appmap.get_appmap", missing)
    monkeypatch.setattr("app.appmap.resolve_path", lambda _m: "/app/config/app-map.json")
    with pytest.raises(RuntimeError) as err:
        startup.require_application_mapping(_manifest("mapping"))
    message = str(err.value)
    assert "/app/config/app-map.json" in message and "ODL_APP_MAP" in message
    assert isinstance(err.value.__cause__, FileNotFoundError)


# --------------------------------------------------------------------------- #
# start_collecting: what a collecting process does, and in what order
# --------------------------------------------------------------------------- #
@pytest.fixture
def seams(monkeypatch):
    """Every side effect of start_collecting, recorded instead of performed."""
    calls = []
    swept = threading.Event()

    def sweep(reason):
        calls.append(f"sweep:{reason}")
        swept.set()

    monkeypatch.setattr(startup, "require_fleet_config", lambda: calls.append("config"))
    monkeypatch.setattr(startup, "validate_hub_selection", lambda: calls.append("hubs"))
    monkeypatch.setattr(startup, "require_application_mapping",
                        lambda _m: calls.append("appmap"))
    monkeypatch.setattr(startup, "run_collection", sweep)
    monkeypatch.setattr(startup, "start_scheduler", lambda: calls.append("scheduler"))
    monkeypatch.setattr("app.collector.coordination.start_background",
                        lambda: calls.append("background"))
    return SimpleNamespace(calls=calls, swept=swept)


def test_a_collector_checks_it_can_collect_before_it_schedules_anything(monkeypatch, seams):
    monkeypatch.setattr(settings, "refresh_on_startup", True)
    startup.start_collecting(_manifest("labels"))
    assert seams.swept.wait(5), "the startup sweep thread never ran"
    # The sweep runs on a thread of its own, so its position in the list is not
    # fixed; the checks before the scheduler and the scheduler itself are.
    assert seams.calls[:3] == ["config", "hubs", "appmap"]
    assert "sweep:startup" in seams.calls
    ordered = [c for c in seams.calls if not c.startswith("sweep:")]
    assert ordered == ["config", "hubs", "appmap", "scheduler", "background"]


def test_the_startup_sweep_is_skipped_when_it_was_turned_off(monkeypatch, seams):
    monkeypatch.setattr(settings, "refresh_on_startup", False)
    startup.start_collecting(_manifest("labels"))
    assert seams.calls == ["config", "hubs", "appmap", "scheduler", "background"]


def test_the_headless_worker_ticks_from_its_own_loop_instead(monkeypatch, seams):
    """`python -m app.worker` is itself the presence/refresh-queue thread, so
    start_collecting must not start a second one beside it."""
    monkeypatch.setattr(settings, "refresh_on_startup", False)
    startup.start_collecting(_manifest("labels"), consume_refresh_queue=False)
    assert seams.calls == ["config", "hubs", "appmap", "scheduler"]


def test_a_fleet_config_that_is_missing_stops_startup_before_the_scheduler(monkeypatch, seams):
    def boom():
        raise RuntimeError("fleet config not found")

    monkeypatch.setattr(startup, "require_fleet_config", boom)
    with pytest.raises(RuntimeError, match="fleet config not found"):
        startup.start_collecting(_manifest("labels"))
    assert "scheduler" not in seams.calls and "background" not in seams.calls


def test_the_config_path_the_check_reads_is_the_one_settings_resolved():
    """ODL_CONFIG is what the operator sets; the check must read that and not
    a second copy of the default."""
    assert startup.settings is settings
    assert os.path.basename(settings.config_path).endswith(".yaml")
