"""
The application itself: how it starts, what it mounts, and its probe.

Small, but the bits that are wrong silently. Startup has to create the
database *before* the tables, or a first deploy fails on a database that is
not there yet; and the probe has to be answerable without touching Postgres,
or a database blip turns into every pod being restarted at once.
"""
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

from app import main


def test_startup_creates_the_database_before_it_creates_the_tables(monkeypatch, engine):
    order = []
    monkeypatch.setattr(main, "ensure_database", lambda: order.append("database"))
    monkeypatch.setattr(main, "init_db", lambda: order.append("tables"))
    with TestClient(main.app) as client:
        assert client.get("/healthz").json() == {"status": "ok"}
    assert order == ["database", "tables"]


def test_a_postgres_that_never_comes_up_stops_startup(monkeypatch):
    def never():
        raise RuntimeError("postgres never became reachable")

    monkeypatch.setattr(main, "ensure_database", never)
    try:
        with TestClient(main.app):
            pass
    except RuntimeError as e:
        assert "postgres never became reachable" in str(e)
    else:
        raise AssertionError("startup continued without a database")


def test_the_probe_answers_without_asking_the_database(client):
    """A database blip must not restart every pod at once."""
    assert client.get("/healthz").json() == {"status": "ok"}


def test_the_patching_routes_are_mounted_under_api(client):
    paths = {route.path for route in client.app.routes if hasattr(route, "path")}
    assert {"/api/jobs", "/api/jobs/{job_id}", "/api/jobs/{job_id}/audit",
            "/api/jobs/{job_id}/approve", "/api/jobs/{job_id}/events",
            "/api/report", "/healthz"} <= paths


def test_the_dashboard_may_call_the_service_from_anywhere():
    assert CORSMiddleware in {m.cls for m in main.app.user_middleware}


def test_the_openapi_document_names_the_service():
    schema = main.app.openapi()
    assert schema["info"]["title"] == "Patching Service"
    assert schema["info"]["version"] == "0.1.0"
