"""
The guard is the security boundary, so every rejection path is tested.

A miss here is not a wrong answer, it is a query that writes, reads a file off
the pod, or never returns - so the tests are written as "this must be refused,
and the caller must be told why".
"""
import pytest

from app.query.errors import QueryRejected
from app.query.guard import validate
from app.query.schema import ALLOWED_TABLES


def reason(sql, max_limit=100) -> str:
    with pytest.raises(QueryRejected) as excinfo:
        validate(sql, max_limit)
    return excinfo.value.reason


# --------------------------------------------------------------------------- #
# what must pass
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("sql", [
    "SELECT name FROM clusters",
    "SELECT c.name, n.name FROM clusters AS c JOIN nodes AS n ON n.cluster_name = c.name",
    ("WITH bad AS (SELECT name FROM clusters WHERE overall_status = 'critical') "
     "SELECT count(*) FROM bad"),
    "SELECT * FROM clusters UNION ALL SELECT * FROM clusters",
    "SELECT * FROM main.clusters",
    "SELECT region, count(*) FROM clusters GROUP BY region HAVING count(*) > 1",
    "SELECT name FROM clusters WHERE name ILIKE '%prod%' ORDER BY name",
    "SELECT json_extract_string(summary, '$.package') FROM resources",
    "SELECT name FROM clusters WHERE last_synced > now() - INTERVAL 1 DAY",
])
def test_reads_are_allowed(sql):
    assert validate(sql, 100).startswith(("SELECT", "WITH"))


def test_every_allowlisted_table_is_queryable():
    for table in sorted(ALLOWED_TABLES):
        assert validate(f"SELECT * FROM {table}", 10)


def test_a_cte_may_shadow_nothing_but_is_still_allowed():
    sql = validate("WITH totals AS (SELECT 1 AS n) SELECT * FROM totals", 10)
    assert "totals" in sql


# --------------------------------------------------------------------------- #
# the LIMIT
# --------------------------------------------------------------------------- #
def test_limit_is_added_when_missing():
    assert validate("SELECT name FROM clusters", 25).endswith("LIMIT 25")


def test_limit_is_capped_when_too_high():
    assert validate("SELECT name FROM clusters LIMIT 100000", 25).endswith("LIMIT 25")


def test_a_smaller_limit_is_kept():
    assert validate("SELECT name FROM clusters LIMIT 5", 25).endswith("LIMIT 5")


def test_a_computed_limit_is_replaced():
    assert validate("SELECT name FROM clusters LIMIT 10 + 90", 25).endswith("LIMIT 25")


def test_limit_applies_to_a_set_operation():
    sql = validate("SELECT name FROM clusters UNION SELECT name FROM hubs", 7)
    assert sql.endswith("LIMIT 7")


def test_a_limit_inside_a_subquery_does_not_count_as_the_outer_one():
    sql = validate("SELECT * FROM (SELECT name FROM clusters LIMIT 3) AS t", 25)
    assert sql.endswith("LIMIT 25")


def test_max_limit_must_be_positive():
    with pytest.raises(ValueError):
        validate("SELECT 1", 0)


# --------------------------------------------------------------------------- #
# statements that are not reads
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("sql,word", [
    ("DROP TABLE clusters", "DROP"),
    ("CREATE TABLE evil AS SELECT 1", "CREATE"),
    ("CREATE OR REPLACE VIEW v AS SELECT 1", "CREATE"),
    ("INSERT INTO clusters (name) VALUES ('x')", "INSERT"),
    ("UPDATE clusters SET name = 'x'", "UPDATE"),
    ("DELETE FROM clusters", "DELETE"),
    ("ALTER TABLE clusters ADD COLUMN x INTEGER", "ALTER"),
    ("ATTACH 'evil.db' AS evil", "ATTACH"),
    ("DETACH evil", "DETACH"),
    ("COPY clusters TO 'out.csv'", "COPY"),
    ("INSTALL httpfs", "INSTALL"),
    ("LOAD httpfs", "COMMAND"),
    ("PRAGMA database_list", "PRAGMA"),
    ("SET memory_limit = '8GB'", "SET"),
    ("CALL pragma_version()", "COMMAND"),
    ("DESCRIBE clusters", "DESCRIBE"),
    ("SHOW TABLES", "SHOW"),
    ("USE memory.main", "USE"),
])
def test_only_select_is_allowed(sql, word):
    message = reason(sql)
    assert "only SELECT queries are allowed" in message
    assert word in message


def test_a_second_statement_is_refused():
    assert "only one statement" in reason("SELECT 1; DROP TABLE clusters")


def test_an_empty_query_is_refused():
    assert "empty" in reason("   ")


def test_unparseable_sql_is_refused_with_the_parser_message():
    assert "not valid DuckDB SQL" in reason("SELECT * FROM")


# --------------------------------------------------------------------------- #
# tables
# --------------------------------------------------------------------------- #
def test_an_unknown_table_is_refused_and_the_known_ones_are_listed():
    message = reason("SELECT * FROM pg_tables")
    assert "unknown table 'pg_tables'" in message
    assert "clusters" in message and "workload_images" in message


def test_a_file_used_as_a_table_is_an_unknown_table():
    assert "unknown table" in reason("SELECT * FROM 'inventory.csv'")


def test_a_foreign_catalog_is_refused():
    assert "catalog-qualified" in reason("SELECT * FROM other.main.clusters")


def test_a_foreign_schema_is_refused():
    assert "schema-qualified" in reason("SELECT * FROM information_schema.tables")


@pytest.mark.parametrize("sql", [
    "SELECT * FROM read_csv('/etc/passwd')",
    "SELECT * FROM read_csv_auto('/etc/passwd')",
    "SELECT * FROM read_parquet('s3://bucket/x.parquet')",
    "SELECT * FROM read_json_auto('/tmp/x.json')",
    "SELECT * FROM glob('/etc/*')",
    "SELECT * FROM duckdb_settings()",
    "SELECT * FROM duckdb_extensions()",
    "SELECT * FROM query('SELECT 1')",
    "SELECT * FROM postgres_scan('host=db', 'public', 'users')",
    "SELECT * FROM sqlite_scan('/data/app.db', 'users')",
])
def test_table_functions_are_refused(sql):
    assert "table functions are not allowed" in reason(sql)


# --------------------------------------------------------------------------- #
# functions and literals
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("sql,name", [
    ("SELECT getenv('ANTHROPIC_API_KEY')", "getenv"),
    ("SELECT current_setting('home_directory')", "current_setting"),
    ("SELECT read_blob('/etc/shadow')", "read_blob"),
    ("SELECT name FROM clusters WHERE name = pg_backend_pid()", "pg_backend_pid"),
    ("SELECT * FROM clusters WHERE name IN (SELECT getenv('HOME'))", "getenv"),
])
def test_dangerous_functions_are_refused(sql, name):
    assert f"the function {name}() is not allowed" in reason(sql)


def test_ordinary_functions_are_fine():
    validate("SELECT upper(name), round(cpu_usage, 2), coalesce(team, 'none') "
             "FROM namespaces", 10)


@pytest.mark.parametrize("sql", [
    "SELECT * FROM clusters WHERE name = '/etc/passwd'",
    "SELECT * FROM clusters WHERE name = './secrets.json'",
    "SELECT * FROM clusters WHERE name = '../../etc/hosts'",
    "SELECT * FROM clusters WHERE name = '/var/data/export.parquet'",
])
def test_file_paths_are_refused(sql):
    assert "file paths are not allowed" in reason(sql)


@pytest.mark.parametrize("sql", [
    "SELECT * FROM clusters WHERE name = 's3://bucket/data.csv'",
    "SELECT * FROM clusters WHERE name = 'file:///etc/passwd'",
])
def test_remote_urls_are_refused(sql):
    assert "URLs are not allowed" in reason(sql)


def test_https_and_extensions_in_real_data_are_not_mistaken_for_files():
    """Route hosts and api_url carry https://, and '%.json' is a filter."""
    validate("SELECT * FROM clusters WHERE api_url LIKE 'https://api.%'", 10)
    validate("SELECT * FROM resources WHERE name LIKE '%.json'", 10)
    validate("SELECT * FROM workload_images WHERE image ILIKE '%quay.io/acme/api%'", 10)
