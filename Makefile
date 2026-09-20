PY := fleet/.venv/bin/python
DLPY := data-layer/.venv/bin/python
HONCHO := data-layer/.venv/bin/honcho

# Container engine: docker, else podman. `make redis-up` needs only the
# engine; the compose stack needs `docker compose` or `podman compose`
# (podman-compose or docker-compose installed). Override with COMPOSE=...
ENGINE ?= $(shell command -v docker >/dev/null 2>&1 && echo docker || (command -v podman >/dev/null 2>&1 && echo podman))
COMPOSE ?= $(ENGINE) compose
REDIS_CONTAINER ?= odl-redis

# Virtualenvs: uv when available (it also fetches Python 3.12 if the machine
# lacks it), otherwise python3 -m venv. `uv venv` creates no pip inside the
# venv, so every install goes through `uv pip install --python <venv>`.
UV := $(shell command -v uv 2>/dev/null)
ifdef UV
venv = $(UV) venv -q --python 3.12 $(1)
pipi = $(UV) pip install -q --python $(1)/bin/python
else
venv = python3 -m venv $(1) && $(1)/bin/pip install -q --upgrade pip
pipi = $(1)/bin/pip install -q
endif

# .env (copied from .env.example by `make dev-venv`) is read by docker compose,
# by honcho, and here, so every port is defined once.
-include .env
export
ODL_API_PORT ?= 18000
ODL_REDIS_PORT ?= 16379
DEV_API_PORT ?= 18002

# ---- container images and the pod ------------------------------------------
# Built from data-layer/ and dashboard/ (docs/containers.md). IMAGE_PREFIX is
# the registry or namespace the tags carry; localhost is what podman looks for
# when `podman kube play` sees imagePullPolicy: IfNotPresent.
IMAGE_PREFIX ?= localhost
IMAGE_TAG ?= latest
BACKEND_IMAGE = $(IMAGE_PREFIX)/odl-backend:$(IMAGE_TAG)
DASHBOARD_IMAGE = $(IMAGE_PREFIX)/odl-dashboard:$(IMAGE_TAG)

# Build arguments are passed through ONLY when set, so an unset variable means
# the Dockerfile's own default rather than an empty --build-arg that overrides
# it with nothing. Set them in .env or on the command line:
#   make images PYTHON_IMAGE=registry.access.redhat.com/ubi9/python-312 \
#               NGINX_IMAGE=registry.access.redhat.com/ubi9/nginx-124 \
#               PIP_INDEX_URL=https://nexus.example.com/repository/pypi/simple \
#               NPM_REGISTRY=https://nexus.example.com/repository/npm/
BUILD_ARGS = $(foreach v,PYTHON_IMAGE NODE_IMAGE NGINX_IMAGE DIST PIP_INDEX_URL \
                         PIP_EXTRA_INDEX_URL PIP_TRUSTED_HOST NPM_REGISTRY, \
               $(if $($(v)),--build-arg $(v)=$($(v))))

POD_FILE ?= deploy/pod/odl-pod.yaml

.PHONY: help fleet-venv fleet-up fleet-down fleet-seed fleet-status acm-up acm-down acm-status acm-smoke \
        up down logs rebuild ps reset dl-venv test lint rbac \
        images image-backend image-dashboard images-push pod-up pod-down pod-logs pod-render \
        dev-venv dev dev-core dev-api dev-ui dev-mcp dev-down collect redis-cli sql ask \
        local local-remote local-api local-ui local-mcp local-redis local-hubs redis-up redis-down redis-ping check-config deps

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
	@echo "  make images        build odl-backend + odl-dashboard (IMAGE_PREFIX, IMAGE_TAG;"
	@echo "                     DIST=prebuilt compiles the UI on the host first)"
	@echo "  make image-backend / make image-dashboard   just one of them"
	@echo "  make images-push   push both to IMAGE_PREFIX"
	@echo "  make pod-up        run the three-container pod with podman (POD_FILE=... to pick a manifest)"
	@echo "  make pod-logs      follow the pod's logs      make pod-down   stop and remove it"
	@echo "  make pod-render    regenerate deploy/pod/odl-pod-with-redis.yaml from odl-pod.yaml"
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
	@echo "  make local-hubs    one collector process per ACM hub from ODL_CONFIG (ports from 18010), plus UI and MCP"
	@echo "  make redis-up      just Redis, in a container via docker or podman (127.0.0.1:ODL_REDIS_PORT, persisted volume)"
	@echo "  make redis-down    stop it (data stays in the volume)"
	@echo "  make redis-ping    check REDIS_URL from .env (auth, TLS) before starting anything"
	@echo "  make check-config  try the fleet config like the collector does: hub login, ManagedClusters, cluster access"
	@echo "  make collect       trigger a fleet sweep on the collector (ODL_API_PORT)"
	@echo "  make redis-cli     open redis-cli inside the redis container"
	@echo "  make sql Q='select ...'   run guarded SQL over the fleet snapshot"
	@echo "  make ask Q='which ...'    ask in English (needs ANTHROPIC_API_KEY)"
	@echo ""
	@echo "  Dashboard:  http://localhost:8080      API docs: http://localhost:18000/docs"
	@echo "  (ODL_API_PORT / ODL_DASHBOARD_PORT move the host ports so a second stack can run;"
	@echo "   with .env in place the defaults above come from it)"

fleet-venv:
	$(call venv,fleet/.venv) && $(call pipi,fleet/.venv) pyyaml cryptography

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
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

rebuild:
	$(COMPOSE) up -d --build api dashboard

logs:
	$(COMPOSE) logs -f api

ps:
	$(COMPOSE) ps

reset: down fleet-down
	@echo "stack and fleet torn down"

dl-venv:
	$(call venv,data-layer/.venv) && $(call pipi,data-layer/.venv) -r data-layer/requirements-dev.txt

test:
	cd data-layer && .venv/bin/python -m pytest -q

lint:
	cd data-layer && .venv/bin/ruff check app tests

rbac:
	cd data-layer && ODL_MANIFEST=config/ocp-api-manifest.yaml .venv/bin/python -m app.manifest rbac \
		> ../deploy/rbac/odl-collector-readonly.yaml && echo "wrote deploy/rbac/odl-collector-readonly.yaml"

# ---- container images -------------------------------------------------------
# Two images, one per directory. docs/containers.md covers the build arguments
# for a corporate registry (UBI bases, pip and npm mirrors).
images: image-backend image-dashboard

image-backend:
	@test -n "$(ENGINE)" || (echo "docker or podman is required"; exit 1)
	$(ENGINE) build -t $(BACKEND_IMAGE) $(BUILD_ARGS) data-layer
	@echo "built $(BACKEND_IMAGE)"

# DIST=prebuilt compiles the bundle on the host and copies it in, for a build
# environment that cannot reach an npm registry. The default compiles in the
# image and needs nothing installed here.
image-dashboard:
	@test -n "$(ENGINE)" || (echo "docker or podman is required"; exit 1)
ifeq ($(DIST),prebuilt)
	@command -v npm >/dev/null || (echo "node + npm (22+) are required for DIST=prebuilt"; exit 1)
	cd dashboard && npm install --no-audit --no-fund && npm run build
endif
	$(ENGINE) build -t $(DASHBOARD_IMAGE) $(BUILD_ARGS) dashboard
	@echo "built $(DASHBOARD_IMAGE)"

images-push:
	@test "$(IMAGE_PREFIX)" != "localhost" || \
		(echo "set IMAGE_PREFIX to a registry, e.g. make images-push IMAGE_PREFIX=quay.io/acme"; exit 1)
	$(ENGINE) push $(BACKEND_IMAGE)
	$(ENGINE) push $(DASHBOARD_IMAGE)

# ---- the pod ----------------------------------------------------------------
# podman only: `kube play` has no docker equivalent. POD_FILE picks the
# manifest - odl-pod-with-redis.yaml brings its own Redis.
PODMAN_REQUIRED = @command -v podman >/dev/null || \
	(echo "podman is required for the pod (this machine's engine is '$(ENGINE)'); with docker use 'make up', or apply $(POD_FILE) to a Kubernetes cluster"; exit 1)

pod-up:
	$(PODMAN_REQUIRED)
	podman kube play $(POD_FILE)
	@echo "dashboard at http://localhost:8080   (make pod-logs, make pod-down)"

pod-down:
	$(PODMAN_REQUIRED)
	podman kube play --down $(POD_FILE)

pod-logs:
	$(PODMAN_REQUIRED)
	podman pod logs -f odl

# odl-pod-with-redis.yaml is generated from odl-pod.yaml; edit that one.
pod-render:
	@deploy/pod/render.sh

# ---- ad-hoc development (honcho) -------------------------------------------
# The venvs are created on demand: running any dev/local target on a fresh
# checkout performs the one-time setup first instead of failing on a missing
# data-layer/.venv/bin/honcho.
$(DLPY):
	$(MAKE) dl-venv

$(HONCHO): | $(DLPY)
	$(MAKE) dev-venv

dev dev-core dev-api dev-ui dev-mcp: deps
local local-remote local-api local-ui local-mcp local-redis local-hubs: deps
redis-ping sql ask test lint rbac check-config: $(DLPY)

dev-venv: deps
	@command -v npm >/dev/null || (echo "node + npm (22+) are required for the dashboard"; exit 1)
	cd dashboard && npm install --no-audit --no-fund
	@test -f .env || (cp .env.example .env && echo "wrote .env from .env.example (edit the ports if they clash)")

# Python dependencies, synced every time (cheap with uv, seconds with pip): a
# `git pull` that adds a package must never leave a venv behind. Every
# dev/local target depends on this.
deps:
	@test -n "$(UV)" || command -v python3 >/dev/null || (echo "python3 (3.12+) or uv is required"; exit 1)
	@test -d data-layer/.venv || $(call venv,data-layer/.venv)
	$(call pipi,data-layer/.venv) -r data-layer/requirements-dev.txt honcho
	@test -d mcp-server/.venv || $(call venv,mcp-server/.venv)
	$(call pipi,mcp-server/.venv) -r mcp-server/requirements.txt

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
	$(COMPOSE) stop api redis

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

# One collector per hub on this machine: generates Procfile.hubs from the hubs
# in ODL_CONFIG (each owning one hub via COLLECT_HUBS, ports 18010, 18011, ...),
# then runs them with the dashboard and MCP pointed at the first.
local-hubs:
	@test -n "$(REDIS_URL)" || (echo "set REDIS_URL in .env (e.g. redis://localhost:16379/0)"; exit 1)
	@cd data-layer && ODL_CONFIG=$${ODL_CONFIG:-$$([ -f config/acm.yaml ] && echo config/acm.yaml || echo config/clusters.yaml)} \
		.venv/bin/python scripts/gen_procfile_hubs.py > ../Procfile.hubs
	@echo "--- Procfile.hubs"; cat Procfile.hubs; echo "---"
	$(HONCHO) -f Procfile.hubs start

# Redis alone, in a container: for `make local-remote` with
# REDIS_URL=redis://localhost:$(ODL_REDIS_PORT)/0 when you have real clusters but no Redis.
redis-up:
	@test -n "$(ENGINE)" || (echo "docker or podman is required"; exit 1)
	@$(ENGINE) start $(REDIS_CONTAINER) >/dev/null 2>&1 || $(ENGINE) run -d --name $(REDIS_CONTAINER) \
		-p 127.0.0.1:$(ODL_REDIS_PORT):6379 -v $(REDIS_CONTAINER)-data:/data docker.io/library/redis:7-alpine \
		redis-server --save 60 1 --appendonly no --maxmemory-policy noeviction >/dev/null
	@echo "redis ($(ENGINE) container $(REDIS_CONTAINER)) at redis://localhost:$(ODL_REDIS_PORT)/0  (make redis-cli to inspect)"

redis-down:
	$(ENGINE) stop $(REDIS_CONTAINER)

# Logs in to every hub / cluster in ODL_CONFIG the way the collector will and
# prints what fails (TLS, identity provider, RBAC, unreachable clusters).
check-config:
	@cd data-layer && ODL_CONFIG=$${ODL_CONFIG:-$$([ -f config/acm.yaml ] && echo config/acm.yaml || echo config/clusters.yaml)} \
		.venv/bin/python scripts/check_fleet_config.py

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
	@$(ENGINE) exec -it $(REDIS_CONTAINER) redis-cli 2>/dev/null || $(COMPOSE) exec redis redis-cli

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
