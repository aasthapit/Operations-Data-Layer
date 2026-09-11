PY := fleet/.venv/bin/python
DLPY := data-layer/.venv/bin/python

.PHONY: help fleet-venv fleet-up fleet-down fleet-seed fleet-status acm-up acm-down acm-status acm-smoke \
        up down logs rebuild ps reset dl-venv test lint rbac

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
	@echo "  make up            build + start the data layer stack (db, api, dashboard)"
	@echo "  make down          stop the stack"
	@echo "  make logs          tail api logs"
	@echo "  make reset         down + fleet-down (full teardown)"
	@echo ""
	@echo "  make dl-venv       create the data-layer venv (tests, lint, manifest tooling)"
	@echo "  make test          run the data-layer unit tests"
	@echo "  make lint          ruff over the data layer"
	@echo "  make rbac          regenerate deploy/rbac from the OCP API manifest"
	@echo ""
	@echo "  Dashboard:  http://localhost:8080      API docs: http://localhost:18000/docs"

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
