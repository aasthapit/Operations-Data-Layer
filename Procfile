# Ad-hoc development runner (honcho). `make dev-venv` once, then `make dev`
# (or `honcho start <names...>` for a subset). Ports and tunables come from
# .env, which docker compose reads too, so one file drives both.
#
# The kind clusters resolve only inside Docker's `kind` network, so collection
# always runs in a container (`collector` below is the compose `api` service).
# Everything else runs on the host against the same Redis, exposed on
# ODL_REDIS_PORT: a hot-reloading read-only API, the Vite dev server for the
# dashboard, and the MCP server.
redis:     docker compose up --no-log-prefix redis
collector: docker compose up --no-log-prefix --no-deps api
api:       sh -c 'cd data-layer && COLLECTOR_ENABLED=false REDIS_URL=redis://localhost:${ODL_REDIS_PORT:-16379}/0 ODL_MANIFEST=config/ocp-api-manifest.yaml ODL_CONFIG=config/hubs.yaml exec .venv/bin/uvicorn app.main:app --reload --host 127.0.0.1 --port ${DEV_API_PORT:-18002}'
ui:        sh -c 'cd dashboard && VITE_PROXY_TARGET=http://localhost:${DEV_API_PORT:-18002} VITE_PATCHING_TARGET=http://localhost:${ODL_PATCHING_PORT:-18010} PORT=${DEV_UI_PORT:-5174} exec npm run dev'
mcp:       sh -c 'cd mcp-server && MCP_API_BASE=http://localhost:${DEV_API_PORT:-18002} MCP_TRANSPORT=streamable-http MCP_HOST=127.0.0.1 MCP_PORT=${DEV_MCP_PORT:-18082} exec .venv/bin/python server.py'
