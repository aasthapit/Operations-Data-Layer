"""
The six tools, against the same two-cluster fixture as the query tests.

What is being proved is the boundary, not the model: every tool validates its
arguments, runs its SQL through the guard and the snapshot before it changes
anything, and answers a failure with a result the model can act on instead of
an exception that would end the run. So each tool is asserted twice - once
where it works, once where it is given something wrong - and the state is
checked after both.
"""
import pytest

from app.agent.state import empty_state
from app.agent.tools import CELL_CHARS, ToolContext, execute
from app.query.snapshot import manager
from app.store import set_store
from tests.test_query_snapshot import build_store

CLUSTERS = "SELECT name, region, overall_status FROM clusters ORDER BY name"
COUNT = "SELECT count(*) AS clusters FROM clusters"
HUB_OPTIONS = "SELECT DISTINCT hub_name AS value FROM clusters ORDER BY 1"


@pytest.fixture(scope="module")
def store(manifest):
    return build_store(manifest)


@pytest.fixture(autouse=True)
def snapshot(store):
    """The fixture store, and no snapshot inherited from another test."""
    set_store(store)
    manager.reset()
    yield
    set_store(None)
    manager.reset()


@pytest.fixture
def context(store):
    return ToolContext(state=empty_state(), store=store)


def call(context, tool, **arguments):
    return execute(tool, arguments, context)


def add_clusters_panel(context, title="Clusters", **overrides):
    return call(context, "add_panel", **{"title": title, "sql": CLUSTERS, **overrides})


def panels(context):
    return context.state["dashboard"]["panels"]


# --------------------------------------------------------------------------- #
# preview_sql
# --------------------------------------------------------------------------- #
def test_preview_returns_the_shape_of_the_answer(context):
    outcome = call(context, "preview_sql", sql=CLUSTERS)
    assert outcome.result["columns"] == ["name", "region", "overall_status"]
    assert outcome.result["column_types"][0] == "VARCHAR"
    assert outcome.result["row_count"] == 2
    assert outcome.result["truncated"] is False
    assert isinstance(outcome.result["elapsed_ms"], int)
    assert outcome.ops == []                     # it looks, it does not touch


def test_preview_caps_how_much_of_a_cell_the_model_is_shown(context):
    outcome = call(context, "preview_sql", sql="SELECT repeat('x', 400) AS long_value")
    assert len(outcome.result["rows"][0][0]) == CELL_CHARS


def test_a_query_the_guard_refuses_comes_back_as_a_result(context):
    outcome = call(context, "preview_sql", sql="DROP TABLE clusters")
    assert "only SELECT queries are allowed" in outcome.result["error"]
    assert outcome.result["sql"] == "DROP TABLE clusters"
    assert outcome.failed


def test_a_query_duckdb_cannot_run_comes_back_as_a_result(context):
    outcome = call(context, "preview_sql", sql="SELECT nope FROM clusters")
    assert "nope" in outcome.result["error"]
    assert "clusters" in outcome.result["sql"]


def test_an_unknown_tool_and_a_bad_argument_are_results_too(context):
    assert "no tool called 'invent_panel'" in call(context, "invent_panel").result["error"]
    assert "sql" in call(context, "preview_sql").result["error"]          # missing field
    assert "colour" in call(context, "preview_sql", sql=CLUSTERS,
                            colour="red").result["error"]                 # unknown field
    assert execute("preview_sql", "not an object", context).failed


# --------------------------------------------------------------------------- #
# set_dashboard
# --------------------------------------------------------------------------- #
def test_set_dashboard_replaces_the_title_and_the_description(context):
    outcome = call(context, "set_dashboard", title="Hub east", description="Everything on it")
    assert outcome.ops == [
        {"op": "replace", "path": "/dashboard/title", "value": "Hub east"},
        {"op": "replace", "path": "/dashboard/description", "value": "Everything on it"},
    ]
    assert context.state["dashboard"]["title"] == "Hub east"


def test_a_description_that_was_not_given_is_left_alone(context):
    call(context, "set_dashboard", title="Hub east", description="Everything on it")
    outcome = call(context, "set_dashboard", title="Hub west")
    assert len(outcome.ops) == 1
    assert context.state["dashboard"]["description"] == "Everything on it"


# --------------------------------------------------------------------------- #
# add_panel
# --------------------------------------------------------------------------- #
def test_a_panel_gets_an_id_from_its_title_and_the_chart_shape_the_ui_expects(context):
    outcome = add_clusters_panel(context, title="Clusters by region", chart="bars",
                                 x="region", y=["clusters"], w=12, h=3)
    assert outcome.result["id"] == "clusters-by-region"
    panel = panels(context)[0]
    assert panel["chart"] == {"type": "bars", "x": "region", "y": ["clusters"],
                              "series": None, "stack": False}
    assert (panel["w"], panel["h"]) == (12, 3)
    assert outcome.ops == [{"op": "add", "path": "/dashboard/panels/-", "value": panel}]


def test_a_panel_reports_the_columns_and_a_few_rows_of_its_own_answer(context):
    outcome = add_clusters_panel(context)
    assert outcome.result["columns"] == ["name", "region", "overall_status"]
    assert outcome.result["row_count"] == 2
    assert len(outcome.result["sample_rows"]) == 2
    assert outcome.result["sample_rows"][0][0] == "ocp-east-1"


def test_a_panel_without_a_size_gets_the_formats_defaults(context):
    add_clusters_panel(context)
    assert (panels(context)[0]["w"], panels(context)[0]["h"]) == (6, 2)
    assert panels(context)[0]["chart"] == {"type": "auto", "x": "", "y": [], "series": None,
                                           "stack": False}


def test_two_panels_with_the_same_title_do_not_collide(context):
    add_clusters_panel(context)
    add_clusters_panel(context)
    assert [p["id"] for p in panels(context)] == ["clusters", "clusters-2"]


def test_a_title_with_nothing_sluggable_in_it_still_gets_an_id(context):
    assert add_clusters_panel(context, title="???").result["id"] == "panel"


def test_a_panel_whose_sql_fails_changes_nothing(context):
    outcome = add_clusters_panel(context)
    broken = call(context, "add_panel", title="Broken", sql="SELECT nope FROM clusters")
    assert broken.failed and broken.ops == []
    assert broken.result["sql"].startswith("SELECT")
    assert [p["id"] for p in panels(context)] == [outcome.result["id"]]


def test_the_panel_cap_is_refused_with_a_message_that_says_what_to_do(context):
    context.max_panels = 2
    add_clusters_panel(context, title="One")
    add_clusters_panel(context, title="Two")
    outcome = add_clusters_panel(context, title="Three")
    assert "cap" in outcome.result["error"] and "update_panel" in outcome.result["error"]
    assert len(panels(context)) == 2


def test_a_panel_may_not_ask_for_more_rows_than_the_query_plane_allows(context):
    outcome = add_clusters_panel(context, limit=10_000)
    assert "limit" in outcome.result["error"]
    assert panels(context) == []


# --------------------------------------------------------------------------- #
# update_panel and remove_panel
# --------------------------------------------------------------------------- #
def test_an_update_keeps_the_panel_id_and_its_place(context):
    add_clusters_panel(context, title="One")
    add_clusters_panel(context, title="Two")
    outcome = call(context, "update_panel", id="one", title="Clusters and regions", chart="bars")
    assert outcome.result["id"] == "one"
    assert [p["id"] for p in panels(context)] == ["one", "two"]
    assert panels(context)[0]["title"] == "Clusters and regions"
    assert panels(context)[0]["chart"]["type"] == "bars"
    assert outcome.ops[0]["path"] == "/dashboard/panels/0"


def test_an_update_only_changes_what_it_was_given(context):
    add_clusters_panel(context, title="One", description="the fleet", w=12)
    call(context, "update_panel", id="one", sql=COUNT)
    panel = panels(context)[0]
    assert (panel["description"], panel["w"], panel["title"]) == ("the fleet", 12, "One")
    assert panel["sql"] == COUNT


def test_an_update_whose_sql_fails_leaves_the_old_panel_alone(context):
    add_clusters_panel(context, title="One")
    outcome = call(context, "update_panel", id="one", sql="SELECT nope FROM clusters")
    assert outcome.failed and outcome.ops == []
    assert panels(context)[0]["sql"] == CLUSTERS


def test_an_unknown_panel_id_names_the_ones_that_exist(context):
    add_clusters_panel(context, title="One")
    for tool in ("update_panel", "remove_panel"):
        outcome = call(context, tool, id="two")
        assert "no panel 'two'" in outcome.result["error"] and "one" in outcome.result["error"]


def test_remove_panel_takes_the_panel_out(context):
    add_clusters_panel(context, title="One")
    add_clusters_panel(context, title="Two")
    outcome = call(context, "remove_panel", id="one")
    assert outcome.result == {"removed": "one"}
    assert outcome.ops == [{"op": "remove", "path": "/dashboard/panels/0"}]
    assert [p["id"] for p in panels(context)] == ["two"]


# --------------------------------------------------------------------------- #
# add_variable
# --------------------------------------------------------------------------- #
def test_a_select_variable_brings_its_options_and_its_default_into_the_params(context):
    outcome = call(context, "add_variable", name="hub", label="Hub", sql=HUB_OPTIONS,
                   default="hub-east")
    assert outcome.result == {"name": "hub", "options": ["hub-east", "hub-west"]}
    assert context.state["params"] == {"hub": "hub-east"}
    assert [op["path"] for op in outcome.ops] == ["/dashboard/variables/-", "/params/hub"]
    assert outcome.ops[1]["op"] == "add"


def test_a_variable_a_panel_uses_is_substituted_before_the_guard_sees_it(context):
    call(context, "add_variable", name="hub", sql=HUB_OPTIONS, default="hub-east")
    outcome = add_clusters_panel(
        context, title="Clusters of {{hub}}",
        sql="SELECT name FROM clusters WHERE hub_name = {{hub}} ORDER BY name")
    assert outcome.result["row_count"] == 1
    assert "{{hub}}" in panels(context)[0]["sql"]          # the panel keeps the placeholder


def test_a_variable_with_no_value_tells_the_model_what_to_do_about_it(context):
    call(context, "add_variable", name="hub", sql=HUB_OPTIONS)      # no default
    outcome = add_clusters_panel(context, sql="SELECT name FROM clusters WHERE "
                                             "hub_name = {{hub}}")
    assert "no value" in outcome.result["error"]
    assert "default" in outcome.result["error"] and "ask the user" in outcome.result["error"]
    assert panels(context) == []


def test_a_panel_may_not_use_a_variable_that_was_never_declared(context):
    outcome = add_clusters_panel(context, sql="SELECT name FROM clusters WHERE "
                                             "hub_name = {{hub}}")
    assert "not a variable of this dashboard" in outcome.result["error"]
    assert "add_variable" in outcome.result["error"]


def test_an_options_query_may_not_itself_use_a_variable(context):
    call(context, "add_variable", name="hub", sql=HUB_OPTIONS, default="hub-east")
    outcome = call(context, "add_variable", name="cluster",
                   sql="SELECT name AS value FROM clusters WHERE hub_name = {{hub}}")
    assert "may not use variables" in outcome.result["error"]
    assert len(context.state["dashboard"]["variables"]) == 1


def test_an_options_query_without_a_value_column_is_refused(context):
    outcome = call(context, "add_variable", name="hub",
                   sql="SELECT DISTINCT hub_name FROM clusters")
    assert "column named 'value'" in outcome.result["error"]


def test_a_select_without_an_options_query_is_refused_by_the_variable_model(context):
    outcome = call(context, "add_variable", name="hub", default="hub-east")
    assert "needs a sql query for its options" in outcome.result["error"]


def test_a_variable_cannot_be_declared_twice(context):
    call(context, "add_variable", name="hub", sql=HUB_OPTIONS, default="hub-east")
    outcome = call(context, "add_variable", name="hub", sql=HUB_OPTIONS)
    assert "already a variable" in outcome.result["error"]


def test_a_text_variable_needs_no_options_and_still_sets_its_default(context):
    outcome = call(context, "add_variable", name="team", type="text", default="payments")
    assert outcome.result == {"name": "team", "options": []}
    assert context.state["params"]["team"] == "payments"
