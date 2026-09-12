"""
The guard: the only thing between a generated string and the database.

The snapshot is a read-only copy of data we already serve over HTTP, so the
threat is not disclosure - it is a query that writes, attaches another
database, reads a file off the pod ("SELECT * FROM read_csv('/etc/passwd')"),
reaches the network, or never finishes. The guard is therefore a whitelist,
not a blacklist of bad words, and it works on a parse tree rather than on
text: `sqlglot` parses the statement in DuckDB's dialect and we inspect what
it actually is.

The rules, in order:

 1. exactly one statement (no `SELECT 1; DROP TABLE clusters`);
 2. the statement is a SELECT, a WITH ... SELECT, or a set operation of
    those - every DDL / DML / ATTACH / COPY / INSTALL / LOAD / PRAGMA / SET /
    CALL / DESCRIBE / SHOW node is rejected wherever it appears;
 3. every table is one of `schema.ALLOWED_TABLES` or a CTE defined in the
    same query, unqualified (a catalog or schema prefix is refused);
 4. no table functions (`read_csv(...)`, `duckdb_settings()`, `glob(...)`,
    `query(...)`) and no file, catalog, environment or extension functions
    anywhere in the tree;
 5. no path-like or URL string literals;
 6. a LIMIT is present and is at most `max_limit` - added when missing,
    lowered when too high, so the engine never materialises more rows than
    the caller may receive.

The normalised SQL that comes back is what runs, and what the API shows the
user. Nothing else may be executed: `service.run_sql` is the only executor and
it calls `validate` first.
"""
from __future__ import annotations

from sqlglot import exp, parse
from sqlglot.errors import ParseError, TokenError

from .errors import QueryRejected
from .schema import ALLOWED_TABLES

# Statement types that must never appear, at any depth. Looked up by name so a
# sqlglot upgrade that renames or drops one cannot break the import.
_FORBIDDEN_NODE_NAMES = (
    "Create", "Insert", "Update", "Delete", "Drop", "Alter", "TruncateTable", "Merge",
    "Copy", "Attach", "Detach", "Install", "LoadData", "Export", "Pragma", "Set", "Use",
    "Grant", "Command", "Describe", "Show", "Transaction", "Commit", "Rollback", "Cache",
    "Uncache", "Refresh", "Analyze", "Into",
)
_FORBIDDEN_NODES = tuple(getattr(exp, name) for name in _FORBIDDEN_NODE_NAMES
                         if hasattr(exp, name))

# Functions that reach outside the snapshot: files, the catalog, the
# environment, other engines, or dynamic SQL.
_FORBIDDEN_FUNCTIONS = frozenset({
    "getenv", "glob", "query", "query_table", "current_setting", "set_config",
    "sniff_csv", "checkpoint", "force_checkpoint", "install", "load", "shell",
    "file_search", "seq_scan", "tbl_summary",
})
# ... and whole families of them.
_FORBIDDEN_FUNCTION_PREFIXES = (
    "read_", "write_", "scan_", "duckdb_", "pragma_", "pg_", "sqlite_", "postgres_",
    "mysql_", "iceberg_", "delta_", "parquet_", "arrow_", "st_", "http_", "aws_", "azure_",
)

# Schemes and extensions that only make sense if the query is trying to read a
# file or a URL. A bare `'x.json'` is not enough - `ILIKE '%.json'` is a
# legitimate filter - so a separator or a scheme has to be there too. http(s)
# is deliberately absent: route hosts and api_url legitimately carry it, and a
# URL can only be *fetched* through a function that rule 4 already refuses.
_FORBIDDEN_SCHEMES = ("s3://", "gs://", "gcs://", "r2://", "hf://", "azure://", "abfss://",
                      "file://", "ftp://")
_FILE_SUFFIXES = (".csv", ".tsv", ".parquet", ".json", ".jsonl", ".ndjson", ".duckdb",
                  ".db", ".sqlite", ".arrow", ".ipc", ".xlsx", ".txt", ".gz", ".zst")


def _reject(reason: str):
    raise QueryRejected(reason)


def _statement(sql: str) -> exp.Expression:
    """Parse one statement, or explain why that is not what we got."""
    if not sql or not sql.strip():
        _reject("the query is empty")
    try:
        statements = [s for s in parse(sql, dialect="duckdb") if s is not None]
    except (ParseError, TokenError) as e:
        # `from None`: the parser's own traceback adds nothing for the caller.
        raise QueryRejected(
            f"the query is not valid DuckDB SQL: {str(e).splitlines()[0]}") from None
    if not statements:
        _reject("the query is empty")
    if len(statements) > 1:
        _reject("only one statement may be sent; found "
                f"{len(statements)} separated by ';'")
    return statements[0]


def _check_kind(statement: exp.Expression) -> None:
    """Only a read: SELECT, WITH ... SELECT, or a set operation of those."""
    if not isinstance(statement, exp.Select | exp.SetOperation):
        kind = type(statement).__name__.upper()
        _reject(f"only SELECT queries are allowed (got {kind})")


def _check_no_forbidden_nodes(statement: exp.Expression) -> None:
    for node in statement.find_all(*_FORBIDDEN_NODES):
        kind = type(node).__name__.upper()
        _reject(f"only SELECT queries are allowed; {kind} is not permitted")


def _cte_names(statement: exp.Expression) -> set[str]:
    return {cte.alias_or_name.lower() for cte in statement.find_all(exp.CTE)}


def _check_tables(statement: exp.Expression) -> None:
    known = _cte_names(statement)
    for table in statement.find_all(exp.Table):
        if not isinstance(table.this, exp.Identifier):
            _reject("table functions are not allowed; query the snapshot tables directly")
        if table.catalog and table.catalog.lower() != "memory":
            _reject(f"catalog-qualified names are not allowed: {table.catalog}.{table.name}")
        if table.db and table.db.lower() != "main":
            _reject(f"schema-qualified names are not allowed: {table.db}.{table.name}")
        name = table.name.lower()
        if name not in ALLOWED_TABLES and name not in known:
            _reject(f"unknown table '{table.name}'. Available tables: "
                    f"{', '.join(sorted(ALLOWED_TABLES))}")


def _function_name(node: exp.Func) -> str:
    if isinstance(node, exp.Anonymous):
        return str(node.this or "").lower()
    try:
        return str(node.sql_name() or "").lower()
    except Exception:  # noqa: BLE001 - an exotic node must not crash the guard
        return type(node).__name__.lower()


def _check_functions(statement: exp.Expression) -> None:
    for node in statement.find_all(exp.Func):
        name = _function_name(node)
        if name in _FORBIDDEN_FUNCTIONS or name.startswith(_FORBIDDEN_FUNCTION_PREFIXES):
            _reject(f"the function {name}() is not allowed")


def _check_literals(statement: exp.Expression) -> None:
    for literal in statement.find_all(exp.Literal):
        if not literal.is_string:
            continue
        value = str(literal.this).strip()
        low = value.lower()
        if low.startswith(_FORBIDDEN_SCHEMES):
            _reject(f"URLs are not allowed in a query: {value[:60]}")
        looks_like_path = low.startswith(("/", "./", "../", "~/", "\\\\"))
        if looks_like_path or ("/" in low and low.endswith(_FILE_SUFFIXES)):
            _reject(f"file paths are not allowed in a query: {value[:60]}")


def _apply_limit(statement: exp.Expression, max_limit: int) -> exp.Expression:
    """Guarantee a top-level LIMIT of at most `max_limit`.

    Rewriting the SQL (instead of truncating the result) is what keeps a
    careless aggregate from materialising a million rows first.
    """
    limit = statement.args.get("limit")
    if limit is None:
        return statement.limit(max_limit)
    value = limit.expression
    if isinstance(value, exp.Literal) and not value.is_string and value.this.isdigit():
        if int(value.this) <= max_limit:
            return statement
    limit.set("expression", exp.Literal.number(max_limit))
    return statement


def validate(sql: str, max_limit: int) -> str:
    """Return the normalised SQL, or raise QueryRejected with a reason.

    `max_limit` is both the row ceiling and the value written into the query.
    """
    if max_limit < 1:
        raise ValueError("max_limit must be at least 1")
    statement = _statement(sql)
    _check_kind(statement)
    _check_no_forbidden_nodes(statement)
    _check_tables(statement)
    _check_functions(statement)
    _check_literals(statement)
    statement = _apply_limit(statement, max_limit)
    return statement.sql(dialect="duckdb")
