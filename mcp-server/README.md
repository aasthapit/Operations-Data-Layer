# Operations Data Layer - MCP server

An MCP server that wraps the data layer's REST API, so an agent (Claude Code,
Claude Desktop, or any MCP client) can ask about the fleet in natural language:
*"which prod clusters are unhealthy?"*, *"what's the blast radius if the ingress
operator at 4.15.18 is buggy?"*, *"what OCP versions are we running?"*.

## Tools

| Tool | What it answers |
|---|---|
| `fleet_overview` · `insights_summary` · `health_summary(group_by)` | how is the fleet, what needs attention, health by region/env/version |
| `list_clusters(...)` · `get_cluster(name)` · `cluster_health` · `cluster_timeline` | clusters, full detail (platform config, capacity, nodes, namespaces, checks), history |
| `cluster_nodes` · `cluster_namespaces(class)` · `cluster_workloads(detail)` · `inventory(kind)` | per-cluster inventory; any collected kind fleet-wide |
| `what_is_collected` · `resource_availability` | the OCP API manifest and what each cluster actually served |
| `list_applications(...)` · `get_application(app)` | applications (application namespaces) across the fleet |
| `version_distribution` · `operator_versions` · `olm_operators` | OCP, cluster-operator and OLM version spread / drift |
| `blast_radius(operator / ocp_version / olm_operator / image)` | clusters, apps, teams, workloads impacted |
| `expiring_certificates` · `pod_issues` · `quota_pressure` · `machine_config_pools` · `storage_summary` · `find_routes` · `warning_events` · `image_usage` · `config_references` · `cluster_admins` | the insights |
| `top_namespaces_by_usage` · `top_nodes_by_usage` · `cluster_utilization` · `capacity_headroom` | utilization from `metrics.k8s.io` |
| `refresh_data` | trigger a fresh collection sweep of the whole fleet |
| `refresh_cluster(name)` | re-collect one cluster now and wait for it, without sweeping the fleet (404 unknown cluster, 409 already refreshing) |
| `ask_fleet(question)` · `run_fleet_sql(sql, limit)` · `fleet_schema()` | ad-hoc questions answered in SQL over a snapshot of the fleet state |
| `list_dashboards()` · `run_dashboard(id, params_json)` | saved multi-panel dashboards: several of those queries answered together against one snapshot |

Nothing an agent can retrieve contains ConfigMap / Secret values, certificate material or env values - those are scrubbed before storage.

### SQL vs the shaped tools

Every tool above `refresh_cluster` answers one known question, and is cheaper and more stable than SQL: prefer it whenever the question fits.
`ask_fleet`, `run_fleet_sql` and `fleet_schema` exist for the rest - an arbitrary join or aggregation no shaped tool covers, such as "which teams run an image on clusters still on 4.15 in eu-west?" or "which clusters have both a degraded operator and a certificate expiring this month?".
Call `fleet_schema()` first to see the tables and columns, then `ask_fleet` to let the model write the SQL, or `run_fleet_sql` directly if you already know the query (to re-run or refine what `ask_fleet` produced, or when you want exact control over the joins and columns).
Both `ask_fleet` and `run_fleet_sql` return the SQL that ran along with the rows - always show it to the user next to the answer so they can check it.
Only a single read-only `SELECT` (or `WITH ... SELECT`) over the allowlisted tables is accepted; anything that writes, reads files or reaches outside the snapshot is rejected, and every query is row-capped and time-limited.

`list_dashboards()` and `run_dashboard(id, params_json)` are the rounded version of the same thing: a dashboard is several guarded queries answered together against one snapshot, so one call gives a whole picture of a hub, an application, a cluster or the fleet's trends.
The run returns each variable's valid options, so a wrong or missing parameter tells you what to pick instead of failing; a panel that fails does not fail the rest.
See [docs/nl-query.md](../docs/nl-query.md) and [ADR-0002](../docs/adr/0002-natural-language-queries.md) for the full design.

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
print(server.expiring_certificates()["count"], "certs expiring")
PY
```
