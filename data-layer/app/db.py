"""Database engine, session management, and additive schema sync."""
import logging

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import declarative_base, sessionmaker
from sqlalchemy.schema import CreateColumn

from .settings import settings

log = logging.getLogger("odl.db")

engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    pool_size=5,
    max_overflow=10,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
Base = declarative_base()

# Tables from earlier schema versions that no longer exist in the model.
_LEGACY_TABLES = ("applications",)


def init_db():
    # Models are imported for their side effect of registering on Base.metadata.
    from . import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _sync_schema()


def _sync_schema():
    """Add columns that exist in the models but not yet in the database.

    Every table here is either replaced wholesale on each sweep or append-only,
    so additive `ALTER TABLE ... ADD COLUMN` is all the migration we need; a
    full migration tool would be weight without benefit at this stage.
    """
    insp = inspect(engine)
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            if not insp.has_table(table.name):
                continue
            existing = {c["name"] for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name in existing:
                    continue
                ddl = CreateColumn(col).compile(dialect=engine.dialect)
                conn.execute(text(f'ALTER TABLE "{table.name}" ADD COLUMN {ddl}'))
                log.info("schema: added %s.%s", table.name, col.name)
        for legacy in _LEGACY_TABLES:
            if insp.has_table(legacy):
                conn.execute(text(f'DROP TABLE "{legacy}"'))
                log.info("schema: dropped legacy table %s", legacy)


def get_session():
    """FastAPI dependency yielding a session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
