"""
Shared fixtures for the patching system of record.

The service runs on Postgres, but every table it declares (String, Integer,
Text, JSON, timezone-aware DateTime) is ordinary SQLAlchemy that SQLite serves
too, so the tests run the *real* models and the real session - only the engine
is swapped. That keeps the schema under test the one `models.py` declares
rather than a stub that can drift from it, and it means the tests need no
database server, which is what lets them run in CI.

`StaticPool` is what makes an in-memory SQLite survive: without it every
connection would get its own empty database.
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

from app import db as db_module  # noqa: E402


@pytest.fixture
def engine(monkeypatch):
    """A fresh, empty database per test, created through `init_db` itself."""
    eng = create_engine("sqlite+pysqlite://",
                        connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    monkeypatch.setattr(db_module, "engine", eng)
    monkeypatch.setattr(db_module, "SessionLocal",
                        sessionmaker(bind=eng, autoflush=False, expire_on_commit=False))
    db_module.init_db()
    yield eng
    eng.dispose()


@pytest.fixture
def session(engine):
    """A session on the test database, for assertions that go behind the API."""
    db = db_module.SessionLocal()
    yield db
    db.close()


@pytest.fixture
def client(engine):
    """The real app. Constructed without the lifespan context, because startup
    is where the Postgres bootstrap lives and it is tested on its own."""
    from app.main import app
    return TestClient(app)
