"""
Dashboards and batches, over the same two-cluster fixture as the query tests.

Three things are being proved here, and they are different kinds of thing:

  * **the format** - what a definition may be, and that a definition that
    cannot possibly run is refused when it is saved, with the field path of the
    thing that is wrong;
  * **the contract** - list, read, save, delete and run over HTTP, against a
    fake-Redis store, including that a built-in cannot be overwritten and that
    an unset variable leaves the selector usable instead of failing the page;
  * **the built-ins themselves** - every panel of every shipped dashboard is
    executed against the fixture snapshot, so a column that gets renamed in the
    schema breaks a test rather than a dashboard in production.

The app under test is assembled from the two routers, as in test_query_api.py:
the routers are the unit, and booting the whole application would wait for
Redis and start the collector.
"""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import dashboards as dashboards_api
from app.api import query as query_api
from app.query import dashboards as dash
from app.query.config import query_config
from app.query.service import BatchQuery, run_batch
from app.query.snapshot import manager
from app.store import set_store
from tests.test_query_snapshot import build_store

RUNAWAY = ("WITH RECURSIVE counter(n) AS ("
           "  SELECT 1 UNION ALL SELECT n + 1 FROM counter WHERE n < 2000000000"
           ") SELECT count(*) FROM counter")


def definition(**overrides) -> dict:
    """A minimal valid saved dashboard; each test breaks one thing about it."""
    body = {
        "id": "my-view",
        "title": "My view",
        "description": "clusters of one hub",
        "variables": [{"name": "hub", "label": "Hub", "type": "select", "required": True,
                       "sql": "SELECT DISTINCT hub_name AS value FROM clusters ORDER BY 1"}],
        "panels": [{"id": "clusters", "title": "Clusters in {{hub}}",
                    "sql": "SELECT name FROM clusters WHERE hub_name = {{hub}} ORDER BY name"}],
    }
    body.update(overrides)
    return body


@pytest.fixture(scope="module")
def store(manifest):
    return build_store(manifest)


@pytest.fixture(autouse=True)
def client(store):
    """The two routers, the fixture store, and no leftover snapshot."""
    set_store(store)
    manager.reset()
    app = FastAPI()
    app.include_router(query_api.router)
    app.include_router(dashboards_api.router)
    with TestClient(app) as test_client:
        yield test_client
    for saved in list(store.dashboards()):
        store.dashboard_delete(saved.get("id", ""))
    set_store(None)
    manager.reset()


def errors_of(response) -> dict:
    """{field: message} from a 400 the models produced."""
    assert response.status_code == 400, response.text
    return {e["field"]: e["error"] for e in response.json()["detail"]}


# --------------------------------------------------------------------------- #
# the format
# --------------------------------------------------------------------------- #
def test_a_definition_gets_the_defaults_the_front_end_relies_on():
    parsed = dash.parse_dashboard(definition())
    panel = parsed.panels[0]
    assert (panel.w, panel.h, panel.limit) == (6, 2, None)
    assert panel.chart == {"type": "auto"}
    assert parsed.builtin is False and parsed.updated_at is None and parsed.updated_by is None
    assert parsed.variables[0].multi is False and parsed.variables[0].default is None
    assert parsed.as_dict()["panels"][0]["title"] == "Clusters in {{hub}}"


def test_the_id_in_the_path_wins_over_the_id_in_the_body():
    """A definition copy-pasted from another dashboard becomes this one."""
    parsed = dash.parse_dashboard(definition(id="somewhere-else"), dashboard_id="my-view")
    assert parsed.id == "my-view"


def test_the_chart_object_is_passed_through_untouched():
    """The backend has no opinion about charts; the front end owns that field."""
    chart = {"type": "line", "x": "hour", "series": "hub_name", "anything": [1, 2]}
    body = definition()
    body["panels"][0]["chart"] = chart
    assert dash.parse_dashboard(body).panels[0].chart == chart


@pytest.mark.parametrize("field,panel,expected_field", [
    ("sql", {"id": "p", "title": "t", "sql": "   "}, "panels.0.sql"),
    ("id", {"id": "Not A Slug", "title": "t", "sql": "SELECT 1"}, "panels.0.id"),
    ("w", {"id": "p", "title": "t", "sql": "SELECT 1", "w": 13}, "panels.0.w"),
    ("h", {"id": "p", "title": "t", "sql": "SELECT 1", "h": 0}, "panels.0.h"),
    ("title", {"id": "p", "title": "", "sql": "SELECT 1"}, "panels.0.title"),
])
def test_a_panel_field_is_refused_with_its_own_path(field, panel, expected_field):
    with pytest.raises(dash.DashboardInvalid) as excinfo:
        dash.parse_dashboard(definition(variables=[], panels=[panel]))
    assert expected_field in {e["field"] for e in excinfo.value.errors}


def test_a_panel_limit_above_the_row_cap_is_refused():
    panel = {"id": "p", "title": "t", "sql": "SELECT 1", "limit": query_config.max_rows + 1}
    with pytest.raises(dash.DashboardInvalid) as excinfo:
        dash.parse_dashboard(definition(variables=[], panels=[panel]))
    assert excinfo.value.errors[0]["field"] == "panels.0.limit"


def test_duplicate_panel_ids_are_refused():
    panels = [{"id": "p", "title": "a", "sql": "SELECT 1"},
              {"id": "p", "title": "b", "sql": "SELECT 2"}]
    with pytest.raises(dash.DashboardInvalid) as excinfo:
        dash.parse_dashboard(definition(variables=[], panels=panels))
    assert excinfo.value.errors[0] == {"field": "panels.1.id", "error": "duplicate panel id 'p'"}


def test_more_panels_than_a_page_can_hold_are_refused():
    panels = [{"id": f"p{n}", "title": "t", "sql": "SELECT 1"} for n in range(dash.MAX_PANELS + 1)]
    with pytest.raises(dash.DashboardInvalid) as excinfo:
        dash.parse_dashboard(definition(variables=[], panels=panels))
    assert "panels" in {e["field"] for e in excinfo.value.errors}


@pytest.mark.parametrize("panel,expected_field", [
    ({"id": "p", "title": "t", "sql": "SELECT * FROM clusters WHERE hub_name = {{nope}}"},
     "panels.0.sql"),
    ({"id": "p", "title": "Clusters in {{nope}}", "sql": "SELECT 1"}, "panels.0.title"),
])
def test_a_panel_may_only_use_declared_variables(panel, expected_field):
    with pytest.raises(dash.DashboardInvalid) as excinfo:
        dash.parse_dashboard(definition(panels=[panel]))
    found = {e["field"]: e["error"] for e in excinfo.value.errors}
    assert expected_field in found
    assert "'{{nope}}' is not a declared variable" in found[expected_field]
    assert "declared: hub" in found[expected_field]


def test_a_placeholder_with_a_modifier_is_refused_where_it_is_written():
    panel = {"id": "p", "title": "t", "sql": "SELECT * FROM clusters WHERE hub_name = {{hub:raw}}"}
    with pytest.raises(dash.DashboardInvalid) as excinfo:
        dash.parse_dashboard(definition(panels=[panel]))
    assert "not a variable" in excinfo.value.errors[0]["error"]
    assert excinfo.value.errors[0]["field"] == "panels.0.sql"


def test_an_options_query_may_not_use_a_variable():
    """Options and panels resolve in one batch, so a chained selector cannot
    work; refusing it is better than resolving nothing at run time."""
    variables = [{"name": "hub", "sql": "SELECT DISTINCT hub_name AS value FROM clusters"},
                 {"name": "cluster",
                  "sql": "SELECT name AS value FROM clusters WHERE hub_name = {{hub}}"}]
    panels = [{"id": "p", "title": "t", "sql": "SELECT {{cluster}} AS c"}]
    with pytest.raises(dash.DashboardInvalid) as excinfo:
        dash.parse_dashboard(definition(variables=variables, panels=panels))
    assert excinfo.value.errors[0]["field"] == "variables.1.sql"
    assert "one batch" in excinfo.value.errors[0]["error"]


@pytest.mark.parametrize("variable,expected_field", [
    ({"name": "1bad", "sql": "SELECT 1 AS value"}, "variables.0.name"),
    ({"name": "hub", "type": "select"}, "variables.0"),
    ({"name": "hub", "type": "number", "sql": "SELECT 1 AS value"}, "variables.0"),
    ({"name": "hub", "type": "colour"}, "variables.0.type"),
])
def test_a_variable_is_refused_with_its_own_path(variable, expected_field):
    with pytest.raises(dash.DashboardInvalid) as excinfo:
        dash.parse_dashboard(definition(variables=[variable],
                                        panels=[{"id": "p", "title": "t", "sql": "SELECT 1"}]))
    assert expected_field in {e["field"] for e in excinfo.value.errors}


def test_a_dashboard_id_must_be_a_slug():
    with pytest.raises(dash.DashboardInvalid) as excinfo:
        dash.parse_dashboard(definition(id="My Dashboard"))
    assert excinfo.value.errors[0]["field"] == "id"


def test_an_unknown_field_is_refused_rather_than_silently_dropped():
    with pytest.raises(dash.DashboardInvalid) as excinfo:
        dash.parse_dashboard(definition(panel=[]))          # 'panel', not 'panels'
    assert "panel" in {e["field"] for e in excinfo.value.errors}


# --------------------------------------------------------------------------- #
# the built-ins
# --------------------------------------------------------------------------- #
BUILTINS = sorted(dash.builtin_dashboards())


def test_the_built_ins_are_the_four_we_ship():
    assert BUILTINS == ["application-overview", "cluster-overview", "fleet-trends", "hub-overview"]
    for dashboard in dash.builtin_dashboards().values():
        assert dashboard.builtin is True
        assert dashboard.panels and dashboard.description
        assert all(panel.chart for panel in dashboard.panels)


def test_a_broken_built_in_file_is_a_startup_error_naming_it(tmp_path, monkeypatch):
    (tmp_path / "broken.yaml").write_text(
        "id: broken\ntitle: Broken\npanels:\n  - id: p\n    title: t\n"
        "    sql: SELECT * FROM clusters WHERE hub_name = {{nope}}\n")
    monkeypatch.setattr(dash, "BUILTIN_DIR", str(tmp_path))
    monkeypatch.setattr(dash, "_builtins", None)
    with pytest.raises(RuntimeError) as excinfo:
        dash.builtin_dashboards(reload=True)
    assert "broken.yaml" in str(excinfo.value) and "panels.0.sql" in str(excinfo.value)


@pytest.mark.parametrize("dashboard_id", BUILTINS)
def test_every_built_in_panel_runs_against_the_fixture(dashboard_id, client):
    """The built-ins are executed, not merely parsed: every panel's SQL has to
    pass the guard and run against the real schema.

    The variables are filled from the dashboard's own option queries, so this
    stays true of a fixture with different names in it.
    """
    first = client.post(f"/api/dashboards/{dashboard_id}/run", json={"params": {}}).json()
    params = {name: variable["options"][0]["value"]
              for name, variable in first["variables"].items() if variable["options"]}

    body = client.post(f"/api/dashboards/{dashboard_id}/run", json={"params": params}).json()
    definition_ = body["dashboard"]
    assert len(body["results"]) == len(definition_["panels"])
    for panel in definition_["panels"]:
        result = body["results"][panel["id"]]
        assert "error" not in result, f"{dashboard_id}/{panel['id']}: {result.get('error')}"
        assert result["columns"] and result["generation"] == body["generation"]
        assert result["row_count"] == len(result["rows"])


def test_a_built_in_dashboard_answers_about_one_hub(client):
    body = client.post("/api/dashboards/hub-overview/run",
                       json={"params": {"hub": "hub-east"}}).json()
    assert body["params"] == {"hub": "hub-east"}
    assert [o["value"] for o in body["variables"]["hub"]["options"]] == ["hub-east", "hub-west"]
    clusters = body["results"]["clusters"]
    assert clusters["columns"][:3] == ["name", "status", "version"]
    assert [row[0] for row in clusters["rows"]] == ["ocp-east-1"]        # west is the other hub
    assert body["results"]["expiring-certificates"]["rows"][0][2] == "api-tls"
    assert body["snapshot"]["generation"] == body["generation"]


def test_a_number_variable_falls_back_to_its_default_and_can_be_overridden(client):
    """`INTERVAL ({{days}}) DAY` is the reason numbers must arrive as numbers."""
    default = client.post("/api/dashboards/fleet-trends/run", json={"params": {}}).json()
    assert default["params"] == {"days": 7}
    assert default["results"]["crashloops-per-hub"]["row_count"] > 0

    narrow = client.post("/api/dashboards/fleet-trends/run",
                         json={"params": {"days": "2"}}).json()        # a text box sends a string
    assert narrow["params"] == {"days": 2}
    assert (narrow["results"]["crashloops-per-hub"]["row_count"]
            <= default["results"]["crashloops-per-hub"]["row_count"])


def test_a_variable_that_is_not_a_number_is_a_400(client):
    response = client.post("/api/dashboards/fleet-trends/run", json={"params": {"days": "lots"}})
    assert response.status_code == 400
    assert "days" in response.json()["detail"]


# --------------------------------------------------------------------------- #
# running, with and without a variable
# --------------------------------------------------------------------------- #
def test_an_unset_variable_leaves_the_selector_usable(client):
    """The UI has to draw the selector before anyone can pick a hub, so the
    options come back and only the panels that need the value are errors."""
    body = client.post("/api/dashboards/hub-overview/run", json={"params": {}}).json()
    assert body["params"] == {"hub": None}
    assert body["variables"]["hub"]["options"]                  # the selector can be drawn
    assert body["results"]["clusters"] == {"error": "variable hub is not set"}
    assert all(r == {"error": "variable hub is not set"} for r in body["results"].values())


def test_a_panel_that_needs_no_variable_still_runs_when_one_is_unset(client):
    """Only the panels that reference the missing variable wait for it."""
    body = definition(panels=[
        {"id": "needs-hub", "title": "t", "sql": "SELECT name FROM clusters WHERE hub_name = {{hub}}"},
        {"id": "free", "title": "t", "sql": "SELECT count(*) AS clusters FROM clusters"},
    ])
    client.put("/api/dashboards/my-view", json=body)
    results = client.post("/api/dashboards/my-view/run", json={"params": {}}).json()["results"]
    assert results["needs-hub"] == {"error": "variable hub is not set"}
    assert results["free"]["rows"] == [[2]]


def test_a_failing_panel_does_not_fail_the_dashboard(client):
    body = definition(variables=[], panels=[
        {"id": "good", "title": "t", "sql": "SELECT count(*) AS clusters FROM clusters"},
        {"id": "bad", "title": "t", "sql": "SELECT no_such_column FROM clusters"},
        {"id": "refused", "title": "t", "sql": "SELECT * FROM read_csv('/etc/passwd')"},
    ])
    client.put("/api/dashboards/my-view", json=body)
    results = client.post("/api/dashboards/my-view/run", json={}).json()["results"]
    assert results["good"]["rows"] == [[2]]
    assert "no_such_column" in results["bad"]["error"]
    # the SQL that was tried, as the guard normalised it (the row cap included)
    assert results["bad"]["sql"] == "SELECT no_such_column FROM clusters LIMIT 500"
    assert "table functions are not allowed" in results["refused"]["error"]


def test_a_variable_value_cannot_escape_its_quotes(client):
    """The same property as tests/test_query_params.py, end to end: a hub named
    with a quote and a comment marker is a value, not syntax."""
    body = client.post("/api/dashboards/hub-overview/run",
                       json={"params": {"hub": "hub-east' OR '1'='1"}}).json()
    clusters = body["results"]["clusters"]
    assert clusters["rows"] == []                       # no such hub, and no rows leaked
    assert "'hub-east'' OR ''1''=''1'" in clusters["sql"]


def test_a_multi_variable_becomes_an_in_list(client):
    body = definition(
        variables=[{"name": "envs", "type": "select", "multi": True,
                    "sql": "SELECT DISTINCT environment AS value FROM clusters ORDER BY 1"}],
        panels=[{"id": "p", "title": "t",
                 "sql": "SELECT name FROM clusters WHERE environment IN {{envs}} ORDER BY name"}])
    client.put("/api/dashboards/my-view", json=body)
    result = client.post("/api/dashboards/my-view/run",
                         json={"params": {"envs": ["prod"]}}).json()["results"]["p"]
    assert [row[0] for row in result["rows"]] == ["ocp-east-1", "ocp-west-1"]
    assert "IN ('prod')" in result["sql"]


def test_running_a_dashboard_that_does_not_exist_is_a_404(client):
    assert client.post("/api/dashboards/nope/run", json={}).status_code == 404


# --------------------------------------------------------------------------- #
# CRUD
# --------------------------------------------------------------------------- #
def test_the_list_puts_the_built_ins_first_each_sorted_by_title(client):
    client.put("/api/dashboards/my-view", json=definition(title="Zulu"))
    client.put("/api/dashboards/another", json=definition(id="another", title="Alpha"))

    rows = client.get("/api/dashboards").json()["dashboards"]
    assert [r["builtin"] for r in rows] == [True] * len(BUILTINS) + [False, False]
    assert [r["title"] for r in rows[:len(BUILTINS)]] == sorted(
        r["title"] for r in rows[:len(BUILTINS)])
    assert [r["title"] for r in rows[len(BUILTINS):]] == ["Alpha", "Zulu"]

    summary = next(r for r in rows if r["id"] == "my-view")
    assert summary["panels"] == 1 and summary["variables"] == ["hub"]
    assert summary["description"] == "clusters of one hub" and summary["updated_at"]


def test_a_saved_dashboard_round_trips(client):
    saved = client.put("/api/dashboards/my-view", json=definition()).json()
    assert saved["id"] == "my-view" and saved["builtin"] is False
    assert saved["updated_at"] and saved["updated_by"] is None

    fetched = client.get("/api/dashboards/my-view").json()
    assert fetched == saved
    # and what came back can be saved again unchanged (the editor's round trip)
    assert client.put("/api/dashboards/my-view", json=fetched).status_code == 200


def test_saving_under_a_new_id_moves_the_definition_there(client):
    client.put("/api/dashboards/clone", json=definition(id="my-view"))
    assert client.get("/api/dashboards/clone").json()["id"] == "clone"
    assert client.get("/api/dashboards/my-view").status_code == 404


def test_an_invalid_definition_is_a_400_naming_the_field(client):
    body = definition(panels=[{"id": "p", "title": "t", "sql": ""}])
    assert "panels.0.sql" in errors_of(client.put("/api/dashboards/my-view", json=body))


def test_a_built_in_cannot_be_overwritten_or_deleted(client):
    for response in (client.put("/api/dashboards/hub-overview", json=definition(id="hub-overview")),
                     client.delete("/api/dashboards/hub-overview")):
        assert response.status_code == 409
        assert "clone it under another id" in response.json()["detail"]
    # and it is still the built-in
    assert client.get("/api/dashboards/hub-overview").json()["builtin"] is True


def test_deleting_removes_it_once(client):
    client.put("/api/dashboards/my-view", json=definition())
    first = client.delete("/api/dashboards/my-view")
    second = client.delete("/api/dashboards/my-view")
    assert first.json() == {"deleted": "my-view"}
    assert second.status_code == 404
    assert client.get("/api/dashboards/my-view").status_code == 404


def test_an_unknown_dashboard_is_a_404(client):
    assert client.get("/api/dashboards/nope").status_code == 404


def test_a_stored_definition_that_no_longer_validates_explains_itself(client, store):
    """Written by an older format, or edited in Redis: it must not 500, and it
    must not take the list endpoint down with it."""
    store.dashboard_set("legacy", {"id": "legacy", "title": "Legacy",
                                   "panels": [{"id": "p", "title": "t", "sql": "SELECT 1",
                                               "w": 99}]})
    assert "panels.0.w" in errors_of(client.get("/api/dashboards/legacy"))
    assert "legacy" not in {r["id"] for r in client.get("/api/dashboards").json()["dashboards"]}


# --------------------------------------------------------------------------- #
# POST /api/query/batch
# --------------------------------------------------------------------------- #
def test_a_batch_answers_every_query_against_one_snapshot(client):
    body = client.post("/api/query/batch", json={
        "queries": [
            {"id": "clusters", "sql": "SELECT name FROM clusters WHERE hub_name = {{hub}}"},
            {"id": "count", "sql": "SELECT count(*) AS n FROM clusters", "limit": 1},
        ],
        "params": {"hub": "hub-east"},
    }).json()

    assert set(body["results"]) == {"clusters", "count"}
    assert body["results"]["clusters"]["rows"] == [["ocp-east-1"]]
    assert body["results"]["count"]["rows"] == [[2]]
    assert body["snapshot"]["generation"] == body["generation"]
    # one moment: every result reports the same build
    assert {r["generation"] for r in body["results"].values()} == {body["generation"]}


def test_a_failing_query_does_not_fail_the_batch(client):
    body = client.post("/api/query/batch", json={"queries": [
        {"id": "ok", "sql": "SELECT count(*) AS n FROM clusters"},
        {"id": "broken", "sql": "SELECT nope FROM clusters"},
        {"id": "refused", "sql": "DROP TABLE clusters"},
        {"id": "also-ok", "sql": "SELECT count(*) AS n FROM hubs"},
    ]}).json()

    assert body["results"]["ok"]["rows"] == [[2]]
    assert body["results"]["also-ok"]["rows"] == [[2]]
    assert "nope" in body["results"]["broken"]["error"]
    assert body["results"]["broken"]["sql"].startswith("SELECT nope FROM clusters")
    assert "only SELECT queries are allowed" in body["results"]["refused"]["error"]
    assert body["results"]["refused"]["sql"] == "DROP TABLE clusters"


def test_the_guard_sees_the_substituted_sql(client):
    """Substitution happens before validation, so a value cannot smuggle a
    table function past the guard."""
    body = client.post("/api/query/batch", json={
        "queries": [{"id": "q", "sql": "SELECT name FROM clusters WHERE name = {{n}}"}],
        "params": {"n": "x' UNION SELECT * FROM read_csv('/etc/passwd') --"},
    }).json()
    assert body["results"]["q"]["rows"] == []
    assert "read_csv" in body["results"]["q"]["sql"]         # as a string, inside a literal


def test_a_missing_variable_is_a_400_naming_it(client):
    response = client.post("/api/query/batch", json={
        "queries": [{"id": "q", "sql": "SELECT * FROM clusters WHERE hub_name = {{hub}}"}]})
    assert response.status_code == 400
    assert "hub" in response.json()["detail"]


def test_duplicate_query_ids_are_refused(client):
    response = client.post("/api/query/batch", json={"queries": [
        {"id": "q", "sql": "SELECT 1"}, {"id": "q", "sql": "SELECT 2"}]})
    assert response.status_code == 400
    assert "duplicate query id 'q'" in response.json()["detail"]


def test_a_batch_is_bounded_in_size(client):
    queries = [{"id": f"q{n}", "sql": "SELECT 1"} for n in range(query_api.MAX_BATCH_QUERIES + 1)]
    assert client.post("/api/query/batch", json={"queries": queries}).status_code == 422
    assert client.post("/api/query/batch", json={"queries": []}).status_code == 422


def test_every_query_obeys_the_row_cap(client):
    body = client.post("/api/query/batch", json={"queries": [
        {"id": "capped", "sql": "SELECT name FROM clusters ORDER BY name", "limit": 1}]}).json()
    result = body["results"]["capped"]
    assert result["sql"].endswith("LIMIT 1")
    assert result["row_count"] == 1 and result["truncated"] is True


def test_a_batch_that_spends_its_budget_reports_the_queries_it_never_ran(store, monkeypatch):
    """The budget bounds the whole batch, not each query: the queries that ran
    keep their answers and the rest say why they have none."""
    monkeypatch.setattr(query_config, "timeout_seconds", 0.2)       # budget = 0.6s
    queries = [BatchQuery(id=f"slow{n}", sql=RUNAWAY) for n in range(4)]
    queries.append(BatchQuery(id="never", sql="SELECT count(*) FROM clusters"))

    run = run_batch(queries, store)
    assert "cancelled" in run.results["slow0"]["error"]
    assert "budget" in run.results["never"]["error"]
    assert run.results["never"]["sql"] == "SELECT count(*) FROM clusters"


def test_a_slow_query_is_cancelled_and_the_others_still_answer(store, monkeypatch):
    monkeypatch.setattr(query_config, "timeout_seconds", 0.3)
    run = run_batch([BatchQuery(id="slow", sql=RUNAWAY),
                     BatchQuery(id="fast", sql="SELECT count(*) AS n FROM clusters")], store)
    assert "cancelled" in run.results["slow"]["error"]
    assert run.results["fast"]["rows"] == [[2]]
