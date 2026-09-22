"""
The API process: what it refuses to start without, what it starts beside
itself, and what it serves.

`app/main.py` is small but it is the only place the pieces are wired together,
and every line of it is a production decision: the manifest and the built-in
dashboards are validated before anything is served (a broken one is a startup
error naming the file, not a 500 at somebody's first request), Redis must
answer because every read comes from it, the collector runs only where it is
enabled, and the built dashboard is mounted last so it cannot shadow the API.

Redis is fakeredis behind the real store and the collector seams are replaced,
so these tests need no Redis, no cluster and no credentials. The module is
re-imported per test where the import itself is under test (the static mount
is decided at import time).
"""
import importlib
import logging
import sys
import time
from types import SimpleNamespace

import fakeredis
import pytest
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.testclient import TestClient

from app import main
from app.settings import settings
from app.store import set_store
from app.store.redis_store import RedisStore


@pytest.fixture(autouse=True)
def store():
    """Every read is served from Redis, so there has to be one to ping."""
    st = RedisStore(fakeredis.FakeRedis(), prefix="odl")
    set_store(st)
    yield st
    set_store(None)


@pytest.fixture
def quiet_warmup(monkeypatch):
    """The snapshot warm-up is a background courtesy; it is tested on its own."""
    monkeypatch.setattr(main, "_warm_query_snapshot", lambda: None)


@pytest.fixture
def collector(monkeypatch):
    """The collector, recorded instead of started."""
    calls = []
    monkeypatch.setattr(main, "start_collecting", lambda m: calls.append(("start", m)))
    monkeypatch.setattr(main, "stop_scheduler", lambda: calls.append(("stop_scheduler",)))
    monkeypatch.setattr(main, "stop_background", lambda: calls.append(("stop_background",)))
    return calls


def _reimport(monkeypatch, static_dir):
    """Import app/main.py afresh with STATIC_DIR set, since the static mount is
    an import-time decision. monkeypatch restores the original module."""
    monkeypatch.setenv("STATIC_DIR", str(static_dir))
    monkeypatch.delitem(sys.modules, "app.main", raising=False)
    return importlib.import_module("app.main")


# --------------------------------------------------------------------------- #
# startup
# --------------------------------------------------------------------------- #
def test_a_read_only_api_comes_up_without_starting_a_collector(monkeypatch, collector,
                                                               quiet_warmup):
    monkeypatch.setattr(settings, "collector_enabled", False)
    with TestClient(main.app) as client:
        assert client.get("/healthz").json() == {"status": "ok"}
    assert collector == []


def test_a_collecting_api_starts_the_collector_and_stops_it_on_the_way_out(
        monkeypatch, collector, quiet_warmup):
    monkeypatch.setattr(settings, "collector_enabled", True)
    with TestClient(main.app):
        assert [c[0] for c in collector] == ["start"]
    assert [c[0] for c in collector] == ["start", "stop_scheduler", "stop_background"]


def test_the_collector_is_handed_the_manifest_that_was_just_validated(
        monkeypatch, collector, quiet_warmup):
    loaded = SimpleNamespace(source="config/ocp-api-manifest.yaml",
                             enabled_keys=lambda: ["nodes", "pods"])
    monkeypatch.setattr(main, "get_manifest", lambda: loaded)
    monkeypatch.setattr(settings, "collector_enabled", True)
    with TestClient(main.app):
        pass
    assert collector[0] == ("start", loaded)


def test_a_manifest_that_does_not_parse_stops_startup(monkeypatch, collector, quiet_warmup):
    """Fail fast and name the file, rather than serving an API that answers
    every question with an empty fleet."""
    def broken():
        raise RuntimeError("manifest: resources.pods.enabled must be a boolean")

    monkeypatch.setattr(main, "get_manifest", broken)
    with pytest.raises(RuntimeError, match="resources.pods.enabled"):
        with TestClient(main.app):
            pass
    assert collector == []


def test_a_broken_built_in_dashboard_stops_startup(monkeypatch, collector, quiet_warmup):
    """Built-in dashboards ship inside the image, so a bad one is an image
    problem an operator should see immediately."""
    def broken():
        raise ValueError("fleet-trends.yaml: panel 2 has no sql")

    monkeypatch.setattr(main, "builtin_dashboards", broken)
    with pytest.raises(ValueError, match="fleet-trends.yaml"):
        with TestClient(main.app):
            pass
    assert collector == []


def test_a_redis_that_never_answers_stops_startup(monkeypatch, collector, quiet_warmup):
    def never():
        raise RuntimeError("redis never became reachable")

    monkeypatch.setattr(main, "wait_for_redis", never)
    with pytest.raises(RuntimeError, match="redis never became reachable"):
        with TestClient(main.app):
            pass
    assert collector == []


def test_redis_is_waited_for_before_the_collector_is_started(monkeypatch, quiet_warmup):
    order = []
    monkeypatch.setattr(main, "wait_for_redis", lambda: order.append("redis"))
    monkeypatch.setattr(main, "start_collecting", lambda _m: order.append("collector"))
    monkeypatch.setattr(main, "stop_scheduler", lambda: None)
    monkeypatch.setattr(main, "stop_background", lambda: None)
    monkeypatch.setattr(settings, "collector_enabled", True)
    with TestClient(main.app):
        pass
    assert order == ["redis", "collector"]


# --------------------------------------------------------------------------- #
# the snapshot warm-up
# --------------------------------------------------------------------------- #
def test_the_query_snapshot_is_warmed_after_the_startup_sweep_has_written_something(
        monkeypatch):
    slept, built = [], []
    monkeypatch.setattr(time, "sleep", slept.append)
    monkeypatch.setattr("app.query.snapshot.get_snapshot", lambda: built.append(1))
    main._warm_query_snapshot()
    assert slept == [5] and built == [1]


def test_a_warm_up_that_fails_is_a_log_line_and_not_a_dead_process(monkeypatch, caplog):
    """Warming is a courtesy: an empty store at startup must not take the API
    down, it just means the first Query page visit pays for the build."""
    def boom():
        raise RuntimeError("no collection run yet")

    monkeypatch.setattr(time, "sleep", lambda _s: None)
    monkeypatch.setattr("app.query.snapshot.get_snapshot", boom)
    with caplog.at_level(logging.INFO, logger="odl"):
        main._warm_query_snapshot()
    assert "no collection run yet" in caplog.text


def test_the_warm_up_runs_on_a_daemon_thread_so_it_cannot_hold_startup_open(
        monkeypatch, collector):
    started = []
    monkeypatch.setattr(main, "_warm_query_snapshot", lambda: started.append("warm"))
    monkeypatch.setattr(settings, "collector_enabled", False)
    with TestClient(main.app):
        pass
    for _ in range(50):
        if started:
            break
        time.sleep(0.02)
    assert started == ["warm"]


# --------------------------------------------------------------------------- #
# what is served
# --------------------------------------------------------------------------- #
def test_every_plane_of_the_api_is_mounted():
    prefixes = {r.path for r in main.app.routes if hasattr(r, "path")}
    for expected in ("/api/clusters", "/api/applications", "/api/health/overview",
                     "/api/versions", "/api/blast-radius", "/api/insights/summary",
                     "/api/metrics/capacity", "/api/manifest", "/api/refresh",
                     "/api/query/schema", "/api/dashboards", "/api/agent",
                     "/healthz"):
        assert expected in prefixes, f"{expected} is not routed"


def test_fleet_wide_json_is_compressed_and_the_dashboard_may_call_from_anywhere():
    installed = {m.cls for m in main.app.user_middleware}
    assert GZipMiddleware in installed and CORSMiddleware in installed


def test_the_openapi_document_names_the_service_and_its_version():
    schema = main.app.openapi()
    assert schema["info"]["title"] == "Operations Data Layer"
    assert schema["info"]["version"] == main.__version__


# --------------------------------------------------------------------------- #
# the built dashboard
# --------------------------------------------------------------------------- #
def test_the_built_dashboard_is_served_from_the_directory_the_image_mounts(
        monkeypatch, tmp_path):
    (tmp_path / "index.html").write_text("<!doctype html><title>ODL</title>")
    fresh = _reimport(monkeypatch, tmp_path)
    client = TestClient(fresh.app)          # no lifespan: the mount is what is under test
    assert client.get("/").text.startswith("<!doctype html>")
    assert any(getattr(r, "name", None) == "dashboard" for r in fresh.app.routes)


def test_the_dashboard_mount_does_not_shadow_the_api(monkeypatch, tmp_path):
    """It is mounted at "/" and last, so an API path still reaches its router."""
    (tmp_path / "index.html").write_text("<!doctype html>")
    fresh = _reimport(monkeypatch, tmp_path)
    client = TestClient(fresh.app)
    assert client.get("/healthz").json() == {"status": "ok"}


def test_nothing_is_mounted_when_the_image_carries_no_dashboard(monkeypatch, tmp_path):
    fresh = _reimport(monkeypatch, tmp_path / "never-built")
    assert not any(getattr(r, "name", None) == "dashboard" for r in fresh.app.routes)
    assert TestClient(fresh.app).get("/").status_code == 404


# --------------------------------------------------------------------------- #
# CORS
# --------------------------------------------------------------------------- #
def test_cors_is_open_by_default_and_narrows_to_named_origins(monkeypatch):
    """The wildcard is for the laptop, where Vite serves the UI from another
    port; a deployment names its Route and nothing else gets an answer."""
    assert main.cors_origins("") == ["*"]
    assert main.cors_origins("https://odl.apps.example.com, https://ops.example.com") == [
        "https://odl.apps.example.com", "https://ops.example.com"]
    monkeypatch.setenv("ODL_CORS_ORIGINS", "https://a.example")
    assert main.cors_origins() == ["https://a.example"]
    cors = next(m for m in main.app.user_middleware if m.cls is CORSMiddleware)
    assert cors.kwargs["allow_origins"] == ["*"]      # the app built with no env set
