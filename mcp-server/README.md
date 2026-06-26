# Operations Data Layer - MCP server

An MCP server that wraps the data layer's REST API, so an agent (Claude Code,
Claude Desktop, or any MCP client) can ask about the fleet in natural language:
*"which prod clusters are unhealthy?"*, *"what's the blast radius if the ingress
operator at 4.15.18 is buggy?"*, *"what OCP versions are we running?"*.

## Tools

| Tool | What it answers |
|---|---|
| `fleet_overview` | totals, status counts, upgrading, hub status, last sweep |
| `health_summary(group_by)` | health rolled up by region/datacenter/environment/hub/version |
| `list_clusters(...)` | filterable cluster list (region, environment, status, version, team, hub) |
| `get_cluster(name)` | full detail: operators, apps, health checks |
| `cluster_health(name)` | just the precondition checks + score |
| `cluster_timeline(name)` | health-score history over recent sweeps |
| `version_distribution` | OCP version spread across the fleet |
| `operator_versions(name?)` | per-operator version spread / drift |
| `blast_radius(...)` | clusters + apps + teams impacted by a bad version/operator |
| `refresh_data` | trigger a fresh collection sweep |

## Run it locally over stdio (recommended for Claude Code)

```sh
cd mcp-server
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

Register it in your project's `.mcp.json` (a sample is in this directory):

```json
{
  "mcpServers": {
    "operations-data-layer": {
      "command": "mcp-server/.venv/bin/python",
      "args": ["mcp-server/server.py"],
      "env": {
        "MCP_API_BASE": "http://localhost:18000",
        "MCP_TRANSPORT": "stdio"
      }
    }
  }
}
```

Restart Claude Code; the `operations-data-layer` tools become available.
(`MCP_API_BASE` is the data layer API - `http://localhost:18000` for the local
stack.)

## Run it containerized over HTTP

```sh
docker compose up -d mcp
# MCP endpoint: http://localhost:18080/mcp  (streamable-http)
```

Point an HTTP-capable MCP client at `http://localhost:18080/mcp`. Inside the
compose network the server reaches the API as `http://api:8000`.

## Quick check

```sh
MCP_API_BASE=http://localhost:18000 .venv/bin/python - <<'PY'
import server
print(server.fleet_overview()["counts"])
print(server.blast_radius(ocp_version="4.15.18")["summary"]["clusters_impacted"])
PY
```
