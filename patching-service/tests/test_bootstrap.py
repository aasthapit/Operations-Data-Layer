"""
Coming up: waiting for Postgres, creating the database, creating the tables.

The service owns durable state, so its startup is the part that must not be
clever. It waits for the server rather than crash-looping the pod, it creates
its own database the first time rather than needing a DBA, and it creates the
tables from the models so a schema change ships with the image. All three are
stubbed here at the psycopg2 boundary: the point is the sequence and the
arguments, not a live server.
"""
from types import SimpleNamespace

import pytest

from app import db as db_module
from app.settings import settings


class _Cursor:
    def __init__(self, rows):
        self.rows = list(rows)
        self.executed = []
        self.closed = False

    def execute(self, sql, params=None):
        self.executed.append((sql, params))

    def fetchone(self):
        return self.rows.pop(0) if self.rows else None

    def close(self):
        self.closed = True


class _Connection:
    def __init__(self, rows=()):
        self.cursors = [_Cursor(rows)]
        self.autocommit = False
        self.closed = False

    def cursor(self):
        return self.cursors[0]

    def close(self):
        self.closed = True


@pytest.fixture
def postgres(monkeypatch):
    """psycopg2, recorded. `connections` is what each connect() will return."""
    calls = []
    connections = []

    def connect(**kwargs):
        calls.append(kwargs)
        answer = connections.pop(0) if connections else _Connection()
        if isinstance(answer, Exception):
            raise answer
        return answer

    monkeypatch.setattr(db_module.psycopg2, "connect", connect)
    monkeypatch.setattr(db_module.time, "sleep", lambda _s: None)
    return SimpleNamespace(calls=calls, connections=connections)


# --------------------------------------------------------------------------- #
# waiting for the server
# --------------------------------------------------------------------------- #
def test_the_wait_ends_as_soon_as_postgres_answers(postgres):
    db_module._wait_for_postgres()
    assert len(postgres.calls) == 1
    assert postgres.calls[0] == {"host": settings.pg_host, "port": settings.pg_port,
                                 "user": settings.pg_user, "password": settings.pg_password,
                                 "dbname": "postgres"}


def test_the_wait_connects_to_the_maintenance_database_not_our_own(postgres):
    """`patching` may not exist yet; connecting to it to find out would be the
    bootstrap problem this exists to solve."""
    db_module._wait_for_postgres()
    assert postgres.calls[0]["dbname"] == "postgres" != settings.pg_db


def test_a_server_that_is_still_starting_is_waited_for_not_given_up_on(postgres):
    postgres.connections.extend([RuntimeError("starting up"),
                                 RuntimeError("starting up"),
                                 _Connection()])
    db_module._wait_for_postgres(retries=5, delay=0)
    assert len(postgres.calls) == 3


def test_a_server_that_never_answers_is_a_startup_error(postgres):
    postgres.connections.extend([RuntimeError("no route to host")] * 3)
    with pytest.raises(RuntimeError, match="postgres never became reachable"):
        db_module._wait_for_postgres(retries=3, delay=0)
    assert len(postgres.calls) == 3


# --------------------------------------------------------------------------- #
# creating the database
# --------------------------------------------------------------------------- #
def test_creating_the_database_asks_first_and_commits_outside_a_transaction(monkeypatch):
    """CREATE DATABASE cannot run inside a transaction block, which is what
    autocommit is for here."""
    opened = []

    def connect(**kwargs):
        conn = _Connection(rows=[])       # pg_database has no such row yet
        opened.append(conn)
        return conn

    monkeypatch.setattr(db_module.psycopg2, "connect", connect)
    monkeypatch.setattr(db_module.time, "sleep", lambda _s: None)
    db_module.ensure_database()

    _probe, bootstrap = opened
    assert bootstrap.autocommit is True
    statements = [sql for sql, _params in bootstrap.cursor().executed]
    assert statements[0].startswith("SELECT 1 FROM pg_database")
    assert bootstrap.cursor().executed[0][1] == (settings.pg_db,)
    assert statements[1] == f'CREATE DATABASE "{settings.pg_db}"'
    assert bootstrap.cursor().closed and bootstrap.closed


def test_a_restart_finds_the_database_already_there_and_leaves_it_alone(monkeypatch):
    opened = []

    def connect(**kwargs):
        conn = _Connection(rows=[(1,)])   # pg_database already has the row
        opened.append(conn)
        return conn

    monkeypatch.setattr(db_module.psycopg2, "connect", connect)
    monkeypatch.setattr(db_module.time, "sleep", lambda _s: None)
    db_module.ensure_database()

    _probe, bootstrap = opened
    statements = [sql for sql, _params in bootstrap.cursor().executed]
    assert len(statements) == 1 and statements[0].startswith("SELECT 1 FROM pg_database")


# --------------------------------------------------------------------------- #
# creating the tables
# --------------------------------------------------------------------------- #
def test_the_tables_are_created_from_the_models(engine):
    """`engine` already ran init_db; what matters is that every model the
    service declares became a table, so a new model ships with the image."""
    from sqlalchemy import inspect
    assert set(inspect(engine).get_table_names()) == \
        set(db_module.Base.metadata.tables) == \
        {"patch_jobs", "patch_tasks", "audit_events"}


def test_creating_the_tables_twice_is_harmless(engine):
    """Every pod runs it at startup, and they start together."""
    db_module.init_db()
    db_module.init_db()


# --------------------------------------------------------------------------- #
# the request-scoped session
# --------------------------------------------------------------------------- #
def test_a_request_gets_a_session_and_always_gives_it_back(engine, monkeypatch):
    """A leaked session keeps a pooled connection, which is how a service runs
    out of them under load; the dependency's `finally` is what prevents it."""
    closed = []
    sessions = db_module.get_session()
    session = next(sessions)
    assert session.get_bind() is engine

    monkeypatch.setattr(session, "close", lambda: closed.append(True))
    assert next(sessions, None) is None       # exhausting it runs the finally
    assert closed == [True]
