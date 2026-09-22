"""
The MCP server, over a mocked data-layer API.

Every tool here is a thin, *literal* translation of a question into one REST
call, and that is exactly what can rot: a renamed query parameter, a path that
lost its prefix, or a filter that is sent as an empty string and narrows a
fleet-wide answer to nothing. The agent never sees any of that - it sees a tool
that returns something plausible - so the translation is what these tests pin,
tool by tool: the method, the path and the parameters that actually go on the
wire.

`server._client` is swapped for an httpx client on a `MockTransport` that
echoes the request back as JSON, so the assertions are about the request the
data layer would have received. No API, no network, no Redis.
"""
import importlib
import json
import runpy
import sys

import httpx
import pytest
from mcp.server.fastmcp import FastMCP

import server

SERVER_PATH = server.__file__


@pytest.fixture
def api(monkeypatch):
    """A data layer that echoes each request back, with per-path overrides."""
    overrides: dict[str, object] = {}
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        answer = overrides.get(request.url.path)
        if isinstance(answer, Exception):
            raise answer
        if answer is not None:
            return answer
        body = json.loads(request.content) if request.content else None
        return httpx.Response(200, json={"method": request.method,
                                         "path": request.url.path,
                                         "params": dict(request.url.params),
                                         "body": body})

    client = httpx.Client(transport=httpx.MockTransport(handler),
                          base_url="http://data-layer:18000")
    monkeypatch.setattr(server, "_client", client)
    yield type("Api", (), {"overrides": overrides, "seen": seen})()
    client.close()


# --------------------------------------------------------------------------- #
# every tool: what it asks the data layer for
#
# (tool, kwargs, method, path, params). A parameter left at its default and
# absent from `params` is one the tool must NOT send: an empty string would be
# a filter matching nothing.
# --------------------------------------------------------------------------- #
CALLS = [
    # fleet health
    (server.fleet_overview, {}, "GET", "/api/health/overview", {}),
    (server.insights_summary, {}, "GET", "/api/insights/summary", {}),
    (server.health_summary, {"group_by": "environment"}, "GET", "/api/health/summary",
     {"group_by": "environment"}),
    (server.health_summary, {}, "GET", "/api/health/summary", {"group_by": "region"}),
    (server.list_clusters, {"region": "us-east-1", "status": "critical", "team": "payments"},
     "GET", "/api/clusters",
     {"region": "us-east-1", "status": "critical", "team": "payments"}),
    (server.list_clusters, {}, "GET", "/api/clusters", {}),
    (server.get_cluster, {"name": "ocp-east-1"}, "GET", "/api/clusters/ocp-east-1", {}),
    (server.cluster_health, {"name": "ocp-east-1"}, "GET",
     "/api/clusters/ocp-east-1/health", {}),
    (server.cluster_timeline, {"name": "ocp-east-1", "resolution": "hour",
                               "since": "2025-03-01T00:00:00Z"},
     "GET", "/api/clusters/ocp-east-1/timeline",
     {"resolution": "hour", "since": "2025-03-01T00:00:00Z"}),
    (server.recent_changes, {"cluster": "ocp-east-1", "kind": "version"}, "GET",
     "/api/insights/changes", {"cluster": "ocp-east-1", "kind": "version"}),

    # inventory
    (server.cluster_nodes, {"name": "ocp-east-1"}, "GET", "/api/clusters/ocp-east-1/nodes", {}),
    (server.cluster_namespaces, {"name": "ocp-east-1", "ns_class": "application"},
     "GET", "/api/clusters/ocp-east-1/namespaces", {"class": "application"}),
    (server.cluster_workloads, {"name": "ocp-east-1", "namespace": "payments", "detail": True},
     "GET", "/api/clusters/ocp-east-1/workloads",
     {"namespace": "payments", "detail": "true"}),
    (server.inventory, {"kind": "routes", "cluster": "ocp-east-1", "limit": 50},
     "GET", "/api/insights/resources",
     {"kind": "routes", "cluster": "ocp-east-1", "limit": "50"}),
    (server.what_is_collected, {}, "GET", "/api/manifest", {}),
    (server.resource_availability, {}, "GET", "/api/manifest/availability", {}),

    # applications
    (server.list_applications, {"team": "payments", "tier": "critical"}, "GET",
     "/api/applications", {"team": "payments", "tier": "critical"}),
    (server.applications_summary, {"group_by": "region"}, "GET",
     "/api/applications/summary", {"group_by": "region"}),
    (server.get_application, {"app": "payments"}, "GET", "/api/applications/payments", {}),

    # versions and blast radius
    (server.version_distribution, {}, "GET", "/api/versions", {}),
    (server.operator_versions, {"name": "ingress"}, "GET", "/api/versions/operators",
     {"name": "ingress"}),
    (server.operator_versions, {}, "GET", "/api/versions/operators", {}),
    (server.olm_operators, {"name": "elasticsearch-operator", "cluster": "ocp-east-1"},
     "GET", "/api/insights/olm-operators",
     {"name": "elasticsearch-operator", "cluster": "ocp-east-1"}),
    (server.blast_radius, {"ocp_version": "4.15.30", "degraded_only": True},
     "GET", "/api/blast-radius", {"ocp_version": "4.15.30", "degraded_only": "true"}),
    (server.blast_radius, {"image": "nginx:1.19"}, "GET", "/api/blast-radius",
     {"image": "nginx:1.19"}),

    # insights
    (server.expiring_certificates, {"within_days": 7, "include_valid": True},
     "GET", "/api/insights/certificates", {"within_days": "7", "include_valid": "true"}),
    (server.expiring_certificates, {}, "GET", "/api/insights/certificates", {}),
    (server.pod_issues, {"cluster": "ocp-east-1", "reason": "CrashLoopBackOff"},
     "GET", "/api/insights/pod-issues",
     {"cluster": "ocp-east-1", "reason": "CrashLoopBackOff"}),
    (server.quota_pressure, {"cluster": "ocp-east-1", "min_percent": 80},
     "GET", "/api/insights/quotas", {"cluster": "ocp-east-1", "min_percent": "80"}),
    (server.quota_pressure, {}, "GET", "/api/insights/quotas", {}),
    (server.machine_config_pools, {"status": "degraded"}, "GET",
     "/api/insights/machine-config-pools", {"status": "degraded"}),
    (server.storage_summary, {"storage_class": "gp3"}, "GET", "/api/insights/storage",
     {"storage_class": "gp3"}),
    (server.find_routes, {"host": "payments.apps"}, "GET", "/api/insights/routes",
     {"host": "payments.apps"}),
    (server.warning_events, {"namespace": "payments", "limit": 10}, "GET",
     "/api/insights/events", {"namespace": "payments", "limit": "10"}),
    (server.image_usage, {"image": "nginx", "group_by": "registry"}, "GET",
     "/api/insights/images", {"image": "nginx", "group_by": "registry"}),
    (server.config_references, {"kind": "Secret", "name": "payments-tls"}, "GET",
     "/api/insights/references", {"kind": "Secret", "name": "payments-tls"}),
    (server.cluster_admins, {"cluster": "ocp-east-1"}, "GET",
     "/api/insights/cluster-admins", {"cluster": "ocp-east-1"}),

    # utilization
    (server.top_namespaces_by_usage, {"by": "memory", "limit": 5, "ns_class": "application"},
     "GET", "/api/metrics/top-namespaces",
     {"by": "memory", "limit": "5", "class": "application"}),
    (server.top_nodes_by_usage, {}, "GET", "/api/metrics/top-nodes",
     {"by": "cpu", "limit": "10"}),
    (server.cluster_utilization, {"name": "ocp-east-1"}, "GET",
     "/api/metrics/cluster/ocp-east-1/utilization", {}),
    (server.capacity_headroom, {"group_by": "region"}, "GET", "/api/metrics/capacity",
     {"group_by": "region"}),

    # ad-hoc questions
    (server.fleet_schema, {}, "GET", "/api/query/schema", {}),
    (server.list_dashboards, {}, "GET", "/api/dashboards", {}),

    # writes
    (server.refresh_data, {}, "POST", "/api/refresh", {}),
    (server.refresh_cluster, {"name": "ocp-east-1"}, "POST",
     "/api/clusters/ocp-east-1/refresh", {}),
]


@pytest.mark.parametrize("tool, kwargs, method, path, params", CALLS,
                         ids=lambda v: v.__name__ if callable(v) else None)
def test_a_tool_asks_the_data_layer_for_exactly_one_thing(tool, kwargs, method, path,
                                                          params, api):
    answer = tool(**kwargs)
    assert answer["method"] == method
    assert answer["path"] == path
    assert answer["params"] == params
    assert len(api.seen) == 1


def test_every_tool_registered_with_mcp_is_covered_by_this_file():
    """A new tool must arrive with its call pinned, or it is untested wiring
    an agent will happily use."""
    registered = {t.name for t in server.mcp._tool_manager.list_tools()}
    exercised = {tool.__name__ for tool, *_rest in CALLS} | {
        "ask_fleet", "run_fleet_sql", "run_dashboard"}
    assert registered == exercised


def test_empty_filters_are_dropped_rather_than_narrowing_the_answer_to_nothing(api):
    """`status=""` would be a filter matching no cluster at all, so a tool
    called with its defaults must send no filter."""
    server.list_clusters()
    assert api.seen[0].url.query == b""


def test_a_false_flag_is_dropped_but_a_true_one_is_sent(api):
    server.blast_radius(ocp_version="4.15.30", degraded_only=False)
    assert "degraded_only" not in dict(api.seen[0].url.params)


# --------------------------------------------------------------------------- #
# the ad-hoc question tools, which POST a JSON body
# --------------------------------------------------------------------------- #
def test_a_question_is_posted_as_a_body_and_not_as_a_query_string(api):
    answer = server.ask_fleet("which teams run nginx on 4.15?")
    assert answer["method"] == "POST" and answer["path"] == "/api/query/ask"
    assert answer["body"] == {"question": "which teams run nginx on 4.15?"}


def test_sql_the_agent_wrote_is_posted_with_its_row_limit(api):
    answer = server.run_fleet_sql("SELECT name FROM clusters", limit=25)
    assert answer["path"] == "/api/query/sql"
    assert answer["body"] == {"sql": "SELECT name FROM clusters", "limit": 25}


def test_a_dashboard_runs_with_the_variables_it_was_given(api):
    answer = server.run_dashboard("hub-overview", '{"hub": "man01paa"}')
    assert answer["path"] == "/api/dashboards/hub-overview/run"
    assert answer["body"] == {"params": {"hub": "man01paa"}}


def test_a_dashboard_with_no_variables_runs_on_its_defaults(api):
    assert server.run_dashboard("fleet-trends")["body"] == {"params": {}}
    assert server.run_dashboard("fleet-trends", "   ")["body"] == {"params": {}}


def test_params_that_are_not_json_are_explained_without_calling_the_api(api):
    answer = server.run_dashboard("hub-overview", "{hub: man01paa}")
    assert "params_json is not valid JSON" in answer["error"]
    assert api.seen == [], "a malformed parameter should not reach the data layer"


def test_params_that_are_json_but_not_an_object_are_rejected(api):
    answer = server.run_dashboard("hub-overview", '["man01paa"]')
    assert answer["error"] == "params_json must be a JSON object of variable values"
    assert api.seen == []


# --------------------------------------------------------------------------- #
# failures, as something an agent can read out loud
# --------------------------------------------------------------------------- #
def test_a_get_that_404s_returns_the_status_and_the_body(api):
    api.overrides["/api/clusters/ocp-ghost-9"] = httpx.Response(
        404, json={"detail": "cluster ocp-ghost-9 not found"})
    answer = server.get_cluster("ocp-ghost-9")
    assert answer["error"].startswith("404 ")
    assert "ocp-ghost-9 not found" in answer["error"]


def test_a_data_layer_that_is_not_running_is_reported_and_not_raised(api):
    """An MCP tool that raises kills the agent's turn; an error field does not."""
    api.overrides["/api/health/overview"] = httpx.ConnectError("connection refused")
    answer = server.fleet_overview()
    assert "connection refused" in answer["error"]


def test_a_500_from_the_api_is_reported_too(api):
    api.overrides["/api/insights/summary"] = httpx.Response(500, text="internal error")
    assert server.insights_summary()["error"].startswith("500 ")


def test_a_refresh_that_cannot_be_posted_is_reported(api):
    api.overrides["/api/refresh"] = httpx.ConnectError("connection refused")
    assert "connection refused" in server.refresh_data()["error"]


def test_a_refresh_the_api_rejected_is_reported(api):
    api.overrides["/api/refresh"] = httpx.Response(409, text="a sweep is already running")
    assert "error" in server.refresh_data()


def test_a_single_cluster_refresh_reports_the_status_the_api_answered(api):
    """404 means the cluster was never discovered and 409 that a refresh of it
    is already running - both are things to say, not to crash on."""
    api.overrides["/api/clusters/ocp-ghost-9/refresh"] = httpx.Response(
        404, text="not discovered")
    assert server.refresh_cluster("ocp-ghost-9")["error"] == "404 not discovered"

    api.overrides["/api/clusters/ocp-east-1/refresh"] = httpx.ConnectError("no route to host")
    assert "no route to host" in server.refresh_cluster("ocp-east-1")["error"]


def test_a_rejected_question_carries_the_api_s_own_explanation_and_status(api):
    """The query plane's 4xx bodies explain themselves ("the model declined",
    "only a single SELECT is allowed"); repeating the status alone would throw
    away the one thing the agent could act on."""
    api.overrides["/api/query/sql"] = httpx.Response(
        400, json={"detail": "only a single SELECT (or WITH ... SELECT) is allowed"})
    answer = server.run_fleet_sql("DROP TABLE clusters")
    assert answer == {"error": "only a single SELECT (or WITH ... SELECT) is allowed",
                      "status": 400}


def test_a_rejected_question_whose_body_is_not_json_falls_back_to_the_text(api):
    api.overrides["/api/query/ask"] = httpx.Response(502, text="upstream timed out")
    assert server.ask_fleet("q") == {"error": "upstream timed out", "status": 502}


def test_a_rejected_question_with_no_body_at_all_still_reports_the_status(api):
    api.overrides["/api/query/ask"] = httpx.Response(503)
    assert server.ask_fleet("q") == {"error": "503", "status": 503}


def test_a_question_asked_of_a_data_layer_that_is_down_has_no_status_to_report(api):
    api.overrides["/api/query/ask"] = httpx.ConnectError("connection refused")
    answer = server.ask_fleet("q")
    assert "connection refused" in answer["error"] and "status" not in answer


# --------------------------------------------------------------------------- #
# configuration
# --------------------------------------------------------------------------- #
def _reimport(monkeypatch, **env):
    """server.py afresh under the given environment, the way a process start
    reads it. The caller closes the new module's client."""
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delitem(sys.modules, "server", raising=False)
    return importlib.import_module("server")


def test_the_api_base_comes_from_the_environment_without_a_trailing_slash(monkeypatch):
    """Doubling the slash would turn every path into `//api/...`, which some
    ingresses answer with a redirect the client does not follow."""
    fresh = _reimport(monkeypatch, MCP_API_BASE="http://odl.svc:18000/")
    try:
        assert fresh.API_BASE == "http://odl.svc:18000"
        assert str(fresh._client.base_url) == "http://odl.svc:18000"
    finally:
        fresh._client.close()


def test_the_defaults_are_a_local_data_layer_over_stdio(monkeypatch):
    for name in ("MCP_API_BASE", "MCP_TRANSPORT", "MCP_HOST", "MCP_PORT"):
        monkeypatch.delenv(name, raising=False)
    fresh = _reimport(monkeypatch)
    try:
        assert fresh.API_BASE == "http://localhost:18000"
        assert fresh.TRANSPORT == "stdio"
        assert fresh.mcp.settings.host == "127.0.0.1" and fresh.mcp.settings.port == 8000
    finally:
        fresh._client.close()


def test_the_http_transports_bind_where_the_environment_says(monkeypatch):
    fresh = _reimport(monkeypatch, MCP_TRANSPORT="streamable-http",
                      MCP_HOST="0.0.0.0", MCP_PORT="9100")
    try:
        assert fresh.TRANSPORT == "streamable-http"
        assert fresh.mcp.settings.host == "0.0.0.0" and fresh.mcp.settings.port == 9100
    finally:
        fresh._client.close()


def test_running_the_module_starts_the_configured_transport(monkeypatch):
    """`python server.py` is how the container and Claude Desktop start it, and
    stdio versus http is the one thing that must not be hard coded."""
    started = []
    monkeypatch.setenv("MCP_TRANSPORT", "sse")
    monkeypatch.setattr(FastMCP, "run",
                        lambda self, transport=None, **kw: started.append(transport))
    namespace = runpy.run_path(SERVER_PATH, run_name="__main__")
    namespace["_client"].close()
    assert started == ["sse"]
