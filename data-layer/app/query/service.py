"""
Run SQL against the snapshot, and answer questions with it.

`run_sql` is the only place SQL is executed, and it validates first - there is
no path from a generated string to DuckDB that skips the guard. Around the
execution it puts the two limits that keep one query from hurting the process:
a wall-clock timeout (DuckDB is interrupted from a timer thread) and the row
cap the guard wrote into the statement.

`run_batch` is the same execution, several times over one snapshot build: a
dashboard asks a dozen questions about one moment, so its panels must not each
see a different rebuild. It takes the connection once, runs every query on a
cursor of it, reports one `generation` for all of them, and keeps going when
one query fails - a broken panel is a broken panel, not a broken dashboard.

`ask` is the self-correcting loop: generate, validate, execute; if the guard
refuses the SQL or DuckDB cannot run it, tell the model exactly what went
wrong and let it try once more. Two attempts is deliberate - a model that
cannot fix its own query with the error in hand will not fix it on the third
try either, and the caller is better served by seeing the failure.
"""
from __future__ import annotations

import decimal
import logging
import threading
import time
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, datetime

import duckdb

from ..store import Store
from .config import query_config
from .errors import QueryExecutionError, QueryRejected, QueryTimeout
from .guard import validate
from .llm import SqlPlan, generate_sql
from .schema import schema_text
from .snapshot import manager, render_live_values

log = logging.getLogger("odl.query.service")


@dataclass
class QueryResult:
    sql: str                        # the normalised SQL that actually ran
    columns: list[str]
    # The DuckDB type of each column, as the engine names it ('VARCHAR',
    # 'BIGINT', 'DOUBLE', 'TIMESTAMP', 'BOOLEAN', 'DECIMAL(2,1)', ...), aligned
    # with `columns`. A caller rendering the answer needs it: a TIMESTAMP first
    # column and a numeric second one is a time series, two VARCHARs are a
    # table, and nothing in the values themselves says which - JSON has no
    # types and a timestamp arrives as a string.
    column_types: list[str]
    rows: list[list]
    row_count: int
    truncated: bool                 # the row cap may have cut the answer short
    elapsed_ms: int
    generation: int                 # which snapshot build answered

    def as_dict(self) -> dict:
        return {
            "sql": self.sql, "columns": self.columns, "column_types": self.column_types,
            "rows": self.rows, "row_count": self.row_count, "truncated": self.truncated,
            "elapsed_ms": self.elapsed_ms, "generation": self.generation,
        }


@dataclass
class Attempt:
    sql: str
    error: str

    def as_dict(self) -> dict:
        return {"sql": self.sql, "error": self.error}


@dataclass
class AskResult:
    question: str
    sql: str
    explanation: str
    assumptions: list[str]
    confidence: float
    result: QueryResult
    attempts: int
    failed_attempts: list[Attempt] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "question": self.question, "sql": self.sql, "explanation": self.explanation,
            "assumptions": list(self.assumptions), "confidence": self.confidence,
            "attempts": self.attempts,
            "failed_attempts": [a.as_dict() for a in self.failed_attempts],
            "result": self.result.as_dict(),
        }


class AskFailed(Exception):
    """Every attempt produced SQL that would not run. Carries the evidence."""

    def __init__(self, question: str, attempts: list[Attempt], plan: SqlPlan | None):
        last = attempts[-1] if attempts else None
        super().__init__(last.error if last else "no SQL could be generated")
        self.question = question
        self.attempts = attempts
        self.plan = plan

    def as_dict(self) -> dict:
        last = self.attempts[-1] if self.attempts else None
        return {
            "question": self.question,
            "error": last.error if last else str(self),
            "sql": last.sql if last else None,
            "explanation": self.plan.explanation if self.plan else None,
            "attempts": [a.as_dict() for a in self.attempts],
        }


# --------------------------------------------------------------------------- #
# executing
# --------------------------------------------------------------------------- #
def _jsonable(value):
    """DuckDB values -> something FastAPI can serialise."""
    if value is None or isinstance(value, str | int | float | bool):
        return value
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, bytes | bytearray | memoryview):
        return bytes(value).decode("utf-8", "replace")
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, list | tuple | set):
        return [_jsonable(v) for v in value]
    return str(value)


def effective_limit(limit: int | None) -> int:
    """What the caller asked for, bounded by the hard row cap."""
    if limit is None:
        return query_config.max_rows
    return max(1, min(int(limit), query_config.max_rows))


def _interrupt(cursor) -> None:
    """Stop a query that outstayed its budget, from the timer thread.

    It can fire just as the query finishes and the cursor closes; losing that
    race is normal and must not surface as a thread traceback.
    """
    try:
        cursor.interrupt()
    except Exception as e:  # noqa: BLE001
        log.debug("interrupt raced with the query finishing: %s", e)


def _execute(conn, validated: str, cap: int, timeout: float, generation: int) -> QueryResult:
    """Run already-validated SQL on a cursor of `conn`, bounded by `timeout`.

    The cursor, not the connection: DuckDB connections are not thread-safe but
    their cursors are independent, and a cursor is also what can be interrupted
    without touching anything else running on the same snapshot. Taking the
    connection as an argument is what lets a batch run every one of its queries
    against a single build (see `run_batch`).
    """
    cursor = conn.cursor()
    timer = threading.Timer(timeout, _interrupt, args=(cursor,))
    timer.daemon = True
    t0 = time.time()
    try:
        timer.start()
        cursor.execute(validated)
        description = cursor.description or []
        columns = [d[0] for d in description]
        # d[1] is a DuckDBPyType; its str() is the SQL type name.
        column_types = [str(d[1]) for d in description]
        rows = [[_jsonable(v) for v in row] for row in cursor.fetchall()]
    except duckdb.InterruptException as e:
        raise QueryTimeout(
            f"the query was still running after {timeout:g}s and was cancelled") from e
    except duckdb.Error as e:
        raise QueryExecutionError(str(e).strip().splitlines()[0]) from e
    finally:
        timer.cancel()
        cursor.close()
    elapsed = int((time.time() - t0) * 1000)
    return QueryResult(sql=validated, columns=columns, column_types=column_types, rows=rows,
                       row_count=len(rows), truncated=len(rows) >= cap, elapsed_ms=elapsed,
                       generation=generation)


def run_sql(sql: str, limit: int | None = None, store: Store | None = None) -> QueryResult:
    """Validate, then run, one SELECT against the snapshot."""
    cap = effective_limit(limit)
    validated = validate(sql, cap)
    conn = manager.get(store)
    return _execute(conn, validated, cap, query_config.timeout_seconds,
                    manager.info().generation)


# --------------------------------------------------------------------------- #
# batches
# --------------------------------------------------------------------------- #
# A dashboard is several questions about one moment, so the panels of a
# dashboard must not each see a different snapshot: a batch takes the
# connection once and runs every query on a cursor of it, and every result
# reports the same `generation`. The wall budget is a multiple of the
# single-query timeout rather than a sum of them, because 24 slow panels
# should fail as a slow dashboard, not as a request that runs for four
# minutes.
BATCH_BUDGET_FACTOR = 3


@dataclass
class BatchQuery:
    """One query of a batch. `sql` is final text - variables are already gone."""
    id: str
    sql: str
    limit: int | None = None


@dataclass
class BatchRun:
    # id -> QueryResult.as_dict(), or {"error": reason, "sql": the sql it tried}
    results: dict[str, dict]
    generation: int


def batch_budget() -> float:
    """The wall-clock budget one batch may spend, over all of its queries."""
    return BATCH_BUDGET_FACTOR * query_config.timeout_seconds


def run_batch(queries: Sequence[BatchQuery], store: Store | None = None,
              budget: float | None = None) -> BatchRun:
    """Run several validated-on-the-way-in queries against one snapshot build.

    One failing query is not a failing batch: its id carries the reason and the
    SQL that produced it, and the rest of the panels still render. The same is
    true of the budget - the queries that got to run keep their answers, and
    the ones that did not say so.
    """
    conn = manager.get(store)
    generation = manager.info().generation
    budget = batch_budget() if budget is None else budget
    deadline = time.time() + budget
    results: dict[str, dict] = {}
    for query in queries:
        cap = effective_limit(query.limit)
        remaining = deadline - time.time()
        if remaining <= 0:
            results[query.id] = {
                "error": f"the batch spent its {budget:g}s budget before this query ran",
                "sql": query.sql,
            }
            continue
        try:
            validated = validate(query.sql, cap)
        except QueryRejected as e:
            results[query.id] = {"error": e.reason, "sql": query.sql}
            continue
        try:
            timeout = min(query_config.timeout_seconds, remaining)
            results[query.id] = _execute(conn, validated, cap, timeout, generation).as_dict()
        except QueryExecutionError as e:         # QueryTimeout is one of these
            log.info("batch query %r failed: %s", query.id, e)
            results[query.id] = {"error": str(e), "sql": validated}
    return BatchRun(results=results, generation=generation)


# --------------------------------------------------------------------------- #
# asking
# --------------------------------------------------------------------------- #
def _feedback(plan: SqlPlan, error: str) -> str:
    return (f"This SQL:\n{plan.sql}\n\n"
            f"failed with:\n{error}\n\n"
            "Rewrite it so it runs. Use only the tables and columns in the schema, "
            "and keep the same intent.")


def _question_text(question: str, store: Store | None) -> str:
    """The question, plus the values the fleet actually uses.

    Knowing that the environment is spelled 'prod' and the region
    'eu-west-1' is the difference between an answer and an empty result, and
    those values change with the fleet - so they go here, in the volatile half
    of the prompt, rather than into the cached schema prefix.
    """
    try:
        live = render_live_values(manager.live_values(store))
    except Exception as e:  # noqa: BLE001 - hints are a bonus, never a requirement
        log.debug("live values unavailable: %s", e)
        return question
    return f"{question}\n\n{live}" if live else question


def ask(question: str, limit: int | None = None, store: Store | None = None) -> AskResult:
    """Answer a natural-language question, retrying once on a bad query."""
    question = (question or "").strip()
    if not question:
        raise AskFailed("", [], None)

    question_text = _question_text(question, store)
    attempts: list[Attempt] = []
    feedback: str | None = None
    plan: SqlPlan | None = None
    for attempt in range(1, max(1, query_config.max_attempts) + 1):
        plan = generate_sql(question_text, schema_text(), feedback)
        try:
            result = run_sql(plan.sql, limit, store)
        except QueryTimeout:
            raise               # a rerun would only time out again, slower
        except (QueryRejected, QueryExecutionError) as e:
            error = e.reason if isinstance(e, QueryRejected) else str(e)
            log.info("attempt %d for %r failed: %s", attempt, question[:80], error)
            attempts.append(Attempt(sql=plan.sql, error=error))
            feedback = _feedback(plan, error)
            continue
        return AskResult(question=question, sql=result.sql, explanation=plan.explanation,
                         assumptions=list(plan.assumptions), confidence=plan.confidence,
                         result=result, attempts=attempt, failed_attempts=attempts)
    raise AskFailed(question, attempts, plan)
