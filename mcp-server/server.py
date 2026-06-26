"""
Operations Data Layer - MCP server.

Wraps the data layer's REST API as MCP tools so an agent can ask about fleet
health, versions, and blast radius in natural language.

Transport is selectable via MCP_TRANSPORT (stdio | sse | streamable-http).
stdio is the default and is what Claude Code / Claude Desktop use locally.

Config:
  MCP_API_BASE   base URL of the data layer API (default http://localhost:18000)
  MCP_TRANSPORT  stdio (default) | sse | streamable-http
"""
import os

import httpx
from mcp.server.fastmcp import FastMCP

API_BASE = os.environ.get("MCP_API_BASE", "http://localhost:18000").rstrip("/")
TRANSPORT = os.environ.get("MCP_TRANSPORT", "stdio")

# host/port only matter for the http/sse transports.
mcp = FastMCP(
    "operations-data-layer",
    host=os.environ.get("MCP_HOST", "127.0.0.1"),
    port=int(os.environ.get("MCP_PORT", "8000")),
)
_client = httpx.Client(base_url=API_BASE, timeout=30.0)


def _get(path: str, params: dict | None = None):
    try:
        r = _client.get(path, params={k: v for k, v in (params or {}).items()
                                      if v not in (None, "", False)})
        r.raise_for_status()
        return r.json()
    except httpx.HTTPStatusError as e:
        return {"error": f"{e.response.status_code} {e.response.text}"}
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


def _post(path: str):
    try:
        r = _client.post(path)
        r.raise_for_status()
        return r.json()
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


@mcp.tool()
def fleet_overview() -> dict:
    """Fleet-wide health summary: total clusters, counts by status
    (healthy/warning/critical/unknown), how many are upgrading, hub status, and
    info about the last collection sweep. Start here for "how is the fleet?"."""
    return _get("/api/health/overview")


@mcp.tool()
def health_summary(group_by: str = "region") -> dict:
    """Health rolled up by a dimension. group_by is one of:
    region, datacenter, environment, hub, version. Returns per-group counts and
    a rollup status. Use for "which regions/environments are unhealthy?"."""
    return _get("/api/health/summary", {"group_by": group_by})


@mcp.tool()
def list_clusters(region: str = "", environment: str = "", status: str = "",
                  version: str = "", team: str = "", hub: str = "") -> dict:
    """List clusters, optionally filtered. status is
    healthy|warning|critical|unknown. team filters to clusters running an app
    owned by that team. Returns a summary per cluster (status, version, region,
    checks, nodes)."""
    return _get("/api/clusters", {
        "region": region, "environment": environment, "status": status,
        "version": version, "team": team, "hub": hub})


@mcp.tool()
def get_cluster(name: str) -> dict:
    """Full detail for one cluster: version/upgrade state, every cluster
    operator and its condition, the applications running on it, and all
    precondition health-check results."""
    return _get(f"/api/clusters/{name}")


@mcp.tool()
def cluster_health(name: str) -> dict:
    """Just the precondition health checks and overall status/score for one
    cluster (lighter than get_cluster)."""
    return _get(f"/api/clusters/{name}/health")


@mcp.tool()
def cluster_timeline(name: str) -> dict:
    """Health-score history for one cluster over recent collection sweeps - use
    to see whether a cluster is improving, degrading, or mid-upgrade."""
    return _get(f"/api/clusters/{name}/timeline")


@mcp.tool()
def version_distribution() -> dict:
    """How OCP versions are spread across the fleet, with the clusters on each
    version and the channels in use. Use for "what versions are we running?"."""
    return _get("/api/versions")


@mcp.tool()
def operator_versions(name: str = "") -> dict:
    """Version spread per cluster operator across the fleet (optionally one
    operator by name). Operators reporting more than one version are drifting -
    usually a partial rollout."""
    return _get("/api/versions/operators", {"name": name})


@mcp.tool()
def blast_radius(operator: str = "", operator_version: str = "",
                 ocp_version: str = "", degraded_only: bool = False) -> dict:
    """Impact analysis. Given a bad OCP version and/or a cluster operator
    (optionally pinned to a version), return the clusters carrying it and the
    applications + teams riding on top of those clusters. Supply at least one of
    operator or ocp_version. Set degraded_only=true to limit to clusters where
    the operator is currently degraded. Use for "if operator X v1.2 is buggy,
    what's affected?"."""
    return _get("/api/blast-radius", {
        "operator": operator, "operator_version": operator_version,
        "ocp_version": ocp_version, "degraded_only": degraded_only})


@mcp.tool()
def refresh_data() -> dict:
    """Trigger an on-demand collection sweep of the fleet (runs in the
    background). Use when you want the freshest data before answering."""
    return _post("/api/refresh")


if __name__ == "__main__":
    mcp.run(transport=TRANSPORT)
