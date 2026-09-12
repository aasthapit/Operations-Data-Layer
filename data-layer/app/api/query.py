"""
Ad-hoc questions: natural language in, SQL and rows out.

Four endpoints, one idea: the fleet state is also a small relational database
(`app/query/`), so a question that no purpose-built endpoint answers can still
be answered - and the SQL that produced the answer always comes back with it,
because a number nobody can check is worth very little.

  GET  /api/query/schema           the tables, columns and semantics, plus
                                   what the current snapshot holds
  POST /api/query/sql              run one SELECT yourself
  POST /api/query/ask              ask a question; the model writes the SELECT
  POST /api/query/refresh-snapshot rebuild the snapshot from the store now
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..query import schema as query_schema
from ..query.config import query_config
from ..query.errors import QueryExecutionError, QueryRejected, QueryTimeout, QueryUnavailable
from ..query.service import AskFailed, ask, run_sql
from ..query.snapshot import manager
from ..store import Store
from .deps import get_store_dep

router = APIRouter(prefix="/api/query", tags=["query"])


class SqlRequest(BaseModel):
    sql: str = Field(min_length=1, description="A single DuckDB SELECT over the snapshot.")
    limit: int | None = Field(default=None, ge=1,
                              description="Row cap for this query (bounded by ODL_QUERY_MAX_ROWS).")


class AskRequest(BaseModel):
    question: str = Field(min_length=1, description="A question about the fleet, in English.")
    limit: int | None = Field(default=None, ge=1, description="Row cap for the answer.")


@router.get("/schema")
def get_schema(store: Store = Depends(get_store_dep)):
    """The semantic layer the model sees, and the state of the snapshot.

    Building the snapshot here (rather than reporting an empty one) means the
    row counts describe data that is actually queryable right now.
    """
    manager.get(store)
    return {
        **query_schema.describe(),
        "snapshot": manager.info().as_dict(),
        "limits": {
            "max_rows": query_config.max_rows,
            "timeout_seconds": query_config.timeout_seconds,
        },
    }


@router.post("/sql")
def post_sql(body: SqlRequest, store: Store = Depends(get_store_dep)):
    """Run one read-only SELECT. The response carries the SQL that ran."""
    try:
        return run_sql(body.sql, body.limit, store).as_dict()
    except QueryRejected as e:
        raise HTTPException(400, e.reason) from e
    except QueryTimeout as e:
        raise HTTPException(504, str(e)) from e
    except QueryExecutionError as e:
        raise HTTPException(400, str(e)) from e


@router.post("/ask")
def post_ask(body: AskRequest, store: Store = Depends(get_store_dep)):
    """Answer a question in SQL: the query, the rows, and how it was read."""
    try:
        return ask(body.question, body.limit, store).as_dict()
    except QueryUnavailable as e:
        raise HTTPException(503, str(e)) from e
    except QueryTimeout as e:
        raise HTTPException(504, str(e)) from e
    except AskFailed as e:
        # The question was understood but the SQL would not run, twice. Hand
        # back what was tried so the user (or the next prompt change) can see.
        raise HTTPException(422, e.as_dict()) from e


@router.post("/refresh-snapshot")
def refresh_snapshot(store: Store = Depends(get_store_dep)):
    """Rebuild the snapshot from the store (the collector does this per sweep)."""
    return {"snapshot": manager.refresh(store).as_dict()}
