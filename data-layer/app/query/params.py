"""
Variables in SQL: `{{name}}` in, a SQL literal out.

A dashboard panel is a query with holes in it ("the clusters of THIS hub"),
and the holes have to be filled before the guard sees the statement - the
guard validates what will actually run, so substitution happens first and
`validate` gets the final text.

That makes this module the one place where caller-supplied values become part
of a SQL statement, so it is deliberately small, pure and total:

  * a value becomes a *literal*, never a fragment. A string is single-quoted
    with its quotes doubled, a number is a number, a bool is TRUE / FALSE,
    None is NULL, a list is a parenthesised tuple of the same. There is no
    `{{name:raw}}` escape hatch and there never will be one: a hole that can
    carry SQL is an injection point, and the whole point of the guard is that
    no such point exists.
  * a placeholder with no value is an error naming it, not an empty string.
    Silently substituting nothing turns `WHERE hub = {{hub}}` into a syntax
    error at best and into `WHERE hub = ''` at worst.
  * unknown parameters are ignored, so one `params` object can serve a whole
    dashboard whose panels each use a few of its variables.

Nothing here talks to the database, so it is unit-testable on its own
(tests/test_query_params.py), which is exactly what one wants of the function
that builds SQL text out of user input. The guard is still the boundary: a
value that escapes its quotes would still have to parse as a single read-only
SELECT over the allowed tables to reach DuckDB.
"""
from __future__ import annotations

import math
import re
from collections.abc import Mapping
from datetime import date, datetime

# A variable name, as it appears between the braces and in a dashboard's
# `variables` list. The same spelling rule as an identifier, so a name is
# always safe to show in an error message and to use as a JSON key.
NAME_PATTERN = r"[A-Za-z_][A-Za-z0-9_]*"
_NAME_RE = re.compile(rf"^{NAME_PATTERN}$")

# What we substitute, and what we merely notice. The loose pattern exists so a
# malformed placeholder (`{{hub:raw}}`, `{{ hub }}`, `{{}}`) is reported as the
# mistake it is instead of being left in the text to fail later as a parse
# error nobody can explain. It cannot match across braces, so DuckDB struct
# literals are left alone.
_PLACEHOLDER_RE = re.compile(rf"\{{\{{({NAME_PATTERN})\}}\}}")
_LOOSE_PLACEHOLDER_RE = re.compile(r"\{\{([^{}]*)\}\}")

_MAX_LIST = 1000                # a tuple longer than this is a mistake, not a filter


class ParamError(Exception):
    """A placeholder could not be filled. The message is safe to show the user."""


class MissingParam(ParamError):
    """No value was supplied for a placeholder. Carries the name it wanted."""

    def __init__(self, name: str):
        super().__init__(f"no value for variable '{name}'")
        self.name = name


def quote(text: str) -> str:
    """A SQL string literal: single-quoted, with inner quotes doubled.

    Doubling the quote is the standard's own escape and the only one DuckDB
    applies inside an ordinary string literal - a backslash is a backslash
    there, so there is no second escape to get wrong. A NUL byte is refused
    rather than encoded: it cannot occur in fleet data and it is the one
    character that can truncate a string on the way to the engine.
    """
    if "\x00" in text:
        raise ParamError("a value may not contain a NUL byte")
    return "'" + text.replace("'", "''") + "'"


def sql_literal(value) -> str:
    """One Python value as one SQL literal. The whole escaping story is here."""
    if value is None:
        return "NULL"
    if isinstance(value, bool):             # before int: bool is an int
        return "TRUE" if value else "FALSE"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ParamError(f"{value!r} is not a finite number")
        return repr(value)
    if isinstance(value, str):
        return quote(value)
    if isinstance(value, datetime | date):
        return quote(value.isoformat())
    if isinstance(value, list | tuple):
        return _tuple_literal(value)
    raise ParamError(f"a {type(value).__name__} cannot be used as a SQL value")


def _tuple_literal(values) -> str:
    """`('a', 'b')` - ready for an IN list.

    An empty list becomes `(NULL)` rather than `()`: `()` is a syntax error,
    while `x IN (NULL)` is the correct answer to "none of them" (it matches
    nothing, which is what an empty selection means).
    """
    if len(values) > _MAX_LIST:
        raise ParamError(f"a list value may hold at most {_MAX_LIST} items, got {len(values)}")
    if not values:
        return "(NULL)"
    parts = []
    for item in values:
        if isinstance(item, list | tuple):
            raise ParamError("a list value may not contain another list")
        parts.append(sql_literal(item))
    return "(" + ", ".join(parts) + ")"


def placeholders(sql: str) -> list[str]:
    """The variable names `sql` uses, in order of first appearance.

    Raises `ParamError` for anything shaped like a placeholder that is not one,
    so a dashboard carrying `{{hub:raw}}` is refused when it is saved rather
    than when it is run.
    """
    seen: list[str] = []
    for match in _LOOSE_PLACEHOLDER_RE.finditer(sql or ""):
        name = match.group(1)
        if not _NAME_RE.match(name):
            raise ParamError(
                f"{match.group(0)!r} is not a variable: a placeholder is {{{{name}}}} with no "
                f"spaces and no modifiers (names match {NAME_PATTERN})")
        if name not in seen:
            seen.append(name)
    return seen


def substitute(sql: str, params: Mapping[str, object] | None = None) -> str:
    """`sql` with every `{{name}}` replaced by the SQL literal of `params[name]`.

    Unknown parameters are ignored; a placeholder with no value raises
    `MissingParam`, which the API turns into a 400 naming the variable.
    """
    values = params or {}
    placeholders(sql)                       # reject malformed placeholders first

    def replace(match: re.Match) -> str:
        name = match.group(1)
        if name not in values:
            raise MissingParam(name)
        try:
            return sql_literal(values[name])
        except MissingParam:
            raise
        except ParamError as e:
            raise ParamError(f"variable '{name}': {e}") from e

    return _PLACEHOLDER_RE.sub(replace, sql or "")
