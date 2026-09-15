"""
Variable substitution: the one place a caller's value becomes SQL text.

There is no database here on purpose. `substitute` is a pure function, and the
properties that matter - a quote cannot escape its literal, a missing value is
an error rather than an empty string, a list becomes a tuple - are properties
of the text it produces. The guard is tested separately; these tests are about
what it is handed.
"""
import pytest

from app.query.guard import validate
from app.query.params import (
    MissingParam,
    ParamError,
    placeholders,
    sql_literal,
    substitute,
)


# --------------------------------------------------------------------------- #
# literals
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("value,expected", [
    ("man01paa", "'man01paa'"),
    ("", "''"),
    ("it's", "'it''s'"),
    ("back\\slash", "'back\\slash'"),          # not an escape in a SQL literal
    (7, "7"),
    (-3, "-3"),
    (7.5, "7.5"),
    (True, "TRUE"),
    (False, "FALSE"),
    (None, "NULL"),
    (["a", "b"], "('a', 'b')"),
    ([1, 2.5, None, True], "(1, 2.5, NULL, TRUE)"),
    ((), "(NULL)"),
    ([], "(NULL)"),
])
def test_a_value_becomes_one_literal(value, expected):
    assert sql_literal(value) == expected


def test_a_bool_is_not_a_number():
    """bool is a subclass of int, so the order of the checks is load-bearing."""
    assert sql_literal(True) == "TRUE" and sql_literal(1) == "1"


def test_a_datetime_becomes_a_quoted_iso_string():
    from datetime import UTC, datetime
    assert sql_literal(datetime(2026, 9, 14, 12, 30, tzinfo=UTC)) == "'2026-09-14T12:30:00+00:00'"


@pytest.mark.parametrize("value", [float("inf"), float("nan")])
def test_a_non_finite_number_is_refused(value):
    with pytest.raises(ParamError):
        sql_literal(value)


@pytest.mark.parametrize("value", [{"a": 1}, {1, 2}, object()])
def test_a_value_that_is_not_a_scalar_or_a_list_is_refused(value):
    with pytest.raises(ParamError):
        sql_literal(value)


def test_a_nested_list_is_refused():
    with pytest.raises(ParamError, match="another list"):
        sql_literal([["a"]])


def test_a_nul_byte_is_refused():
    with pytest.raises(ParamError, match="NUL"):
        sql_literal("man\x0001")


# --------------------------------------------------------------------------- #
# substitution
# --------------------------------------------------------------------------- #
def test_placeholders_are_replaced_by_literals():
    sql = "SELECT * FROM clusters WHERE hub_name = {{hub}} AND nodes_total > {{nodes}}"
    assert substitute(sql, {"hub": "man01paa", "nodes": 3}) == (
        "SELECT * FROM clusters WHERE hub_name = 'man01paa' AND nodes_total > 3")


def test_the_same_variable_may_appear_more_than_once():
    sql = "SELECT {{hub}} AS hub FROM clusters WHERE hub_name = {{hub}}"
    assert substitute(sql, {"hub": "a"}) == "SELECT 'a' AS hub FROM clusters WHERE hub_name = 'a'"


def test_a_list_substitutes_as_an_in_tuple():
    sql = "SELECT name FROM clusters WHERE environment IN {{envs}}"
    assert substitute(sql, {"envs": ["prod", "stage"]}) == (
        "SELECT name FROM clusters WHERE environment IN ('prod', 'stage')")


def test_an_empty_list_matches_nothing_instead_of_being_a_syntax_error():
    assert substitute("... IN {{envs}}", {"envs": []}) == "... IN (NULL)"


def test_unknown_parameters_are_ignored():
    """One params object serves a whole dashboard; a panel uses a few of them."""
    assert substitute("SELECT {{a}}", {"a": 1, "b": 2, "unused": "x"}) == "SELECT 1"


def test_a_placeholder_with_no_value_names_itself():
    with pytest.raises(MissingParam) as excinfo:
        substitute("SELECT * FROM clusters WHERE hub_name = {{hub}}", {"other": 1})
    assert excinfo.value.name == "hub"
    assert "hub" in str(excinfo.value)


def test_none_is_null_not_a_missing_value():
    assert substitute("... = {{hub}}", {"hub": None}) == "... = NULL"


def test_sql_without_placeholders_is_unchanged():
    sql = "SELECT count(*) FROM clusters"
    assert substitute(sql, {"hub": "a"}) == sql


def test_a_struct_literal_is_not_a_placeholder():
    """DuckDB's `{...}` syntax must survive; only `{{name}}` is a placeholder."""
    sql = "SELECT {'a': 1} AS s FROM clusters"
    assert substitute(sql, {}) == sql


@pytest.mark.parametrize("bad", ["{{hub:raw}}", "{{ hub }}", "{{}}", "{{2hub}}", "{{hub-name}}"])
def test_a_placeholder_that_is_not_a_name_is_refused(bad):
    """There is no `:raw` modifier and there never will be one: a hole that can
    carry SQL is the injection point the guard exists to remove."""
    with pytest.raises(ParamError, match="not a variable"):
        substitute(f"SELECT * FROM clusters WHERE hub_name = {bad}", {"hub": "a"})
    with pytest.raises(ParamError):
        placeholders(bad)


def test_placeholders_lists_the_names_in_order_once_each():
    assert placeholders("{{b}} {{a}} {{b}}") == ["b", "a"]
    assert placeholders("SELECT 1") == []


# --------------------------------------------------------------------------- #
# injection attempts
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("attack", [
    "x' OR '1'='1",
    "x'; DROP TABLE clusters; --",
    "x' UNION SELECT * FROM read_csv('/etc/passwd') --",
    "x'--",
    "x'/*",
    "'",
    "''",
])
def test_a_quote_cannot_escape_its_literal(attack):
    """Whatever the value is, it stays one string: the statement still has the
    shape it was written with, and the guard sees that shape."""
    from sqlglot import exp, parse_one

    sql = substitute("SELECT name FROM clusters WHERE hub_name = {{hub}}", {"hub": attack})
    assert attack.replace("'", "''") in sql         # the value, doubled quotes and all
    tree = parse_one(validate(sql, 10), dialect="duckdb")
    # the attack is a string, not syntax: one SELECT, one comparison, and the
    # whole payload sitting inside a single literal
    assert len(list(tree.find_all(exp.Select))) == 1
    assert len(list(tree.find_all(exp.EQ))) == 1
    assert [literal.this for literal in tree.find_all(exp.Literal)
            if literal.is_string] == [attack]


def test_an_injected_statement_is_not_two_statements():
    sql = substitute("SELECT {{v}}", {"v": "a'; DELETE FROM clusters"})
    assert sql == "SELECT 'a''; DELETE FROM clusters'"
    validate(sql, 10)                   # one statement, so the guard accepts it
