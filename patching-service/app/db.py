"""Engine, session, and database bootstrap for the patching system of record."""
import time

import psycopg2
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

from .settings import settings

Base = declarative_base()
engine = create_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def _wait_for_postgres(retries=30, delay=2):
    for _attempt in range(retries):
        try:
            psycopg2.connect(host=settings.pg_host, port=settings.pg_port,
                             user=settings.pg_user, password=settings.pg_password,
                             dbname="postgres").close()
            return
        except Exception:  # noqa: BLE001
            time.sleep(delay)
    raise RuntimeError("postgres never became reachable")


def _quoted_identifier(name: str) -> str:
    """`name` as a SQL identifier: wrapped in double quotes, with any embedded
    double quote doubled. That is PostgreSQL's own rule, and the same thing
    psycopg2's `sql.Identifier` emits - written out here because rendering a
    `sql.Identifier` needs a live libpq connection to render against.
    """
    return '"' + name.replace('"', '""') + '"'


def ensure_database():
    """Create the dedicated `patching` database if it does not exist yet."""
    _wait_for_postgres()
    conn = psycopg2.connect(host=settings.pg_host, port=settings.pg_port,
                            user=settings.pg_user, password=settings.pg_password,
                            dbname="postgres")
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (settings.pg_db,))
    if not cur.fetchone():
        # CREATE DATABASE takes no bind parameter, so PG_DB cannot be passed as
        # one. It is quoted as an identifier instead of interpolated raw: the
        # environment decides the NAME of the database, never the statement.
        cur.execute(f"CREATE DATABASE {_quoted_identifier(settings.pg_db)}")
    cur.close()
    conn.close()


def init_db():
    from . import models  # noqa: F401
    Base.metadata.create_all(bind=engine)


def get_session():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
