PY := fleet/.venv/bin/python

.PHONY: help fleet-venv fleet-up fleet-down fleet-seed fleet-status up down logs rebuild ps reset

help:
	@echo "Operations Data Layer"
	@echo ""
	@echo "  make fleet-venv    create the python venv used to drive the fleet"
	@echo "  make fleet-up      create + seed the kind fleet (2 hubs, 8 managed clusters)"
	@echo "  make fleet-status  show which clusters exist"
	@echo "  make fleet-seed    re-seed the fleet without recreating clusters"
	@echo "  make fleet-down    delete all kind clusters"
	@echo ""
	@echo "  make up            build + start the data layer stack (db, api, dashboard)"
	@echo "  make down          stop the stack"
	@echo "  make logs          tail api logs"
	@echo "  make reset         down + fleet-down (full teardown)"
	@echo ""
	@echo "  Dashboard:  http://localhost:8080      API docs: http://localhost:8000/docs"

fleet-venv:
	python3 -m venv fleet/.venv && fleet/.venv/bin/pip install -q --upgrade pip pyyaml

fleet-up:
	$(PY) fleet/fleet.py up

fleet-down:
	$(PY) fleet/fleet.py down

fleet-seed:
	$(PY) fleet/fleet.py seed

fleet-status:
	$(PY) fleet/fleet.py status

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
