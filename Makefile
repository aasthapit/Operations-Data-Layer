PY := fleet/.venv/bin/python
DLPY := data-layer/.venv/bin/python
HONCHO := data-layer/.venv/bin/honcho

# .env (copied from .env.example by `make dev-venv`) is read by docker compose,
# by honcho, and here, so every port is defined once.
-include .env
export
ODL_API_PORT ?= 18000
ODL_REDIS_PORT ?= 16379
DEV_API_PORT ?= 18002

.PHONY: help fleet-venv fleet-up fleet-down fleet-seed fleet-status acm-up acm-down acm-status acm-smoke \
        up down logs rebuild ps reset dl-venv test lint rbac \
        dev-venv dev dev-core dev-api dev-ui dev-mcp dev-down collect redis-cli sql ask \
        local local-remote local-api local-ui local-mcp local-redis redis-up redis-down redis-ping

help:
	@echo "Operations Data Layer"
	@echo ""
	@echo "  make fleet-venv    create the python venv used to drive the fleet"
	@echo "  make fleet-up      create + seed the kind fleet (2 hubs, 8 managed clusters)"
	@echo "  make fleet-status  show which clusters exist"
	@echo "  make fleet-seed    re-seed the fleet without recreating clusters"
	@echo "  make fleet-down    delete all kind clusters"
	@echo "                     (FLEET_CLUSTERS=hub-east,ocp-east-1,... limits any fleet command to a subset)"
	@echo ""
	@echo "  make acm-up        create the real ACM/OCM test topology (2 hubs, 4 Tekton spokes)"
	@echo "  make acm-smoke     ManifestWork -> PipelineRun end-to-end smoke test"
	@echo "  make acm-status    show ACM topology state"
	@echo "  make acm-down      delete the ACM topology clusters"
	@echo ""
	@echo "  make up            build + start the data layer stack (redis, api, dashboard)"
	@echo "  make down          stop the stack"
	@echo "  make logs          tail api logs"
	@echo "  make reset         down + fleet-down (full teardown)"
	@echo ""
	@echo "  make dl-venv       create the data-layer venv (tests, lint, manifest tooling)"
	@echo "  make test          run the data-layer unit tests"
	@echo "  make lint          ruff over the data layer"
	@echo "  make rbac          regenerate deploy/rbac from the OCP API manifest"
	@echo ""
	@echo "  make dev-venv      one-time: venvs, honcho, dashboard node_modules, .env from .env.example"
	@echo "  make dev           run everything ad hoc with honcho: redis + collector (containers),"
	@echo "                     hot-reloading API, Vite dashboard and MCP server on the host"
	@echo "  make dev-core      the same without the MCP server"
	@echo "  make dev-api       just the host API (read-only, hot reload) against the running Redis"
	@echo "  make dev-ui        just the Vite dashboard against DEV_API_PORT"
	@echo "  make dev-mcp       just the MCP server (streamable-http) against DEV_API_PORT"
	@echo "  make dev-down      stop the redis + collector containers"
	@echo ""
	@echo "  make local         no Docker at all: local redis-server, API + collector, Vite dashboard, MCP"
	@echo "                     (needs ODL_CONFIG pointing at real clusters, see clusters.example.yaml)"
	@echo "  make local-remote  the same against a live Redis (REDIS_URL in .env), no local redis-server"
	@echo "  make local-api     just the API + collector on the host (REDIS_URL / ODL_CONFIG from .env)"
	@echo "  make local-ui      just the Vite dashboard      make local-mcp   just the MCP server"
	@echo "  make redis-up      just Redis, in a container (127.0.0.1:ODL_REDIS_PORT, persisted volume)"
	@echo "  make redis-down    stop it (data stays in the volume)"
	@echo "  make redis-ping    check REDIS_URL from .env (auth, TLS) before starting anything"
	@echo "  make collect       trigger a fleet sweep on the collector (ODL_API_PORT)"
	@echo "  make redis-cli     open redis-cli inside the redis container"
	@echo "  make sql Q='select ...'   run guarded SQL over the fleet snapshot"
	@echo "  make ask Q='which ...'    ask in English (needs ANTHROPIC_API_KEY)"
	@echo ""
	@echo "  Dashboard:  http://localhost:8080      API docs: http://localhost:18000/docs"
	@echo "  (ODL_API_PORT / ODL_DASHBOARD_PORT move the host ports so a second stack can run;"
	@echo "   with .env in place the defaults above come from it)"

fleet-venv:
	python3 -m venv fleet/.venv && fleet/.venv/bin/pip install -q --upgrade pip pyyaml cryptography

fleet-up:
	$(PY) fleet/fleet.py up

fleet-down:
	$(PY) fleet/fleet.py down

fleet-seed:
	$(PY) fleet/fleet.py seed

fleet-status:
	$(PY) fleet/fleet.py status

acm-up:
	$(PY) fleet/acm.py up

acm-down:
	$(PY) fleet/acm.py down

acm-status:
	$(PY) fleet/acm.py status

acm-smoke:
	$(PY) fleet/acm.py smoke

up:
	docker compose up -d --build

down:
	docker compose down

rebuild:
	docker compose up -d --build api dashboard

logs:
	docker compose logs -f api

ps:
	docker compose ps

reset: down fleet-down
	@echo "stack and fleet torn down"

dl-venv:
	python3 -m venv data-layer/.venv && data-layer/.venv/bin/pip install -q --upgrade pip \
		&& data-layer/.venv/bin/pip install -q -r data-layer/requirements-dev.txt

test:
	cd data-layer && .venv/bin/python -m pytest -q

lint:
	cd data-layer && .venv/bin/ruff check app tests

rbac:
	cd data-layer && ODL_MANIFEST=config/ocp-api-manifest.yaml .venv/bin/python -m app.manifest rbac \
		> ../deploy/rbac/odl-collector-readonly.yaml && echo "wrote deploy/rbac/odl-collector-readonly.yaml"

# ---- ad-hoc development (honcho) -------------------------------------------
# The venvs are created on demand: running any dev/local target on a fresh
# checkout performs the one-time setup first instead of failing on a missing
# data-layer/.venv/bin/honcho.
$(DLPY):
	$(MAKE) dl-venv

$(HONCHO): | $(DLPY)
	$(MAKE) dev-venv

dev dev-core dev-api dev-ui dev-mcp: $(HONCHO)
local local-remote local-api local-ui local-mcp local-redis: $(HONCHO)
redis-ping sql ask test lint rbac: $(DLPY)

dev-venv:
	@command -v python3 >/dev/null || (echo "python3 (3.12+) is required"; exit 1)
	@command -v npm >/dev/null || (echo "node + npm (22+) are required for the dashboard"; exit 1)
	@test -d data-layer/.venv || $(MAKE) dl-venv
	data-layer/.venv/bin/pip install -q honcho
	@test -d mcp-server/.venv || (python3 -m venv mcp-server/.venv && mcp-server/.venv/bin/pip install -q --upgrade pip)
	mcp-server/.venv/bin/pip install -q -r mcp-server/requirements.txt
	cd dashboard && npm install --no-audit --no-fund
	@test -f .env || (cp .env.example .env && echo "wrote .env from .env.example (edit the ports if they clash)")

dev:
	$(HONCHO) start

dev-core:
	$(HONCHO) start redis collector api ui

dev-api:
	$(HONCHO) start api

dev-ui:
	$(HONCHO) start ui

dev-mcp:
	$(HONCHO) start mcp

dev-down:
	docker compose stop api redis

# ---- no Docker at all (Procfile.local) --------------------------------------
local:
	$(HONCHO) -f Procfile.local start

local-remote:
	@test -n "$(REDIS_URL)" || (echo "set REDIS_URL in .env (e.g. rediss://user:pass@host:6380/0)"; exit 1)
	$(HONCHO) -f Procfile.local start api ui mcp

local-api:
	$(HONCHO) -f Procfile.local start api

local-ui:
	$(HONCHO) -f Procfile.local start ui

local-mcp:
	$(HONCHO) -f Procfile.local start mcp

local-redis:
	$(HONCHO) -f Procfile.local start redis

# Redis alone, in a container: for `make local-remote` with
# REDIS_URL=redis://localhost:$(ODL_REDIS_PORT)/0 when you have real clusters but no Redis.
redis-up:
	docker compose up -d redis
	@echo "redis at redis://localhost:$(ODL_REDIS_PORT)/0  (make redis-cli to inspect)"

redis-down:
	docker compose stop redis

# Verifies the connection string (password, ACL user, TLS) without printing it.
redis-ping:
	@$(DLPY) -c "import os, redis; u = os.environ.get('REDIS_URL') or 'redis://localhost:$(ODL_REDIS_PORT)/0'; \
	r = redis.Redis.from_url(u); r.ping(); k = r.connection_pool.connection_kwargs; \
	print('ok:', k.get('host'), k.get('port'), 'db', k.get('db'), 'user', k.get('username') or '(default)', \
	'tls', bool(k.get('ssl_cert_reqs') is not None or u.startswith('rediss://')), 'keys', r.dbsize())"

# API_PORT picks the container API by default; `make collect API_PORT=18002` targets a host API.
API_PORT ?= $(ODL_API_PORT)

collect:
	curl -s -X POST http://localhost:$(API_PORT)/api/refresh && echo

redis-cli:
	docker compose exec redis redis-cli

# make sql Q="select name, overall_status from clusters order by 1"
sql:
	@test -n "$(Q)" || (echo "usage: make sql Q='select ...'"; exit 1)
	@curl -s -X POST http://localhost:$(API_PORT)/api/query/sql -H 'content-type: application/json' \
		--data-binary "$$(printf '%s' '$(Q)' | $(DLPY) -c 'import json,sys; print(json.dumps({"sql": sys.stdin.read()}))')" \
		| $(DLPY) -m json.tool

# make ask Q="which clusters are critical and why"
ask:
	@test -n "$(Q)" || (echo "usage: make ask Q='which ...'"; exit 1)
	@curl -s -X POST http://localhost:$(API_PORT)/api/query/ask -H 'content-type: application/json' \
		--data-binary "$$(printf '%s' '$(Q)' | $(DLPY) -c 'import json,sys; print(json.dumps({"question": sys.stdin.read()}))')" \
		| $(DLPY) -m json.tool
