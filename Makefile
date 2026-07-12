SHELL := /bin/bash

PYTHON ?= python3
VENV ?= venv
PIP := $(VENV)/bin/pip
PY := $(VENV)/bin/python
FRONTEND_DIR := frontend

.DEFAULT_GOAL := help
.PHONY: help setup setup-backend setup-frontend dev dev-backend dev-frontend run build build-frontend verify-pages test lint clean demo demo-restore demo-peek check-config ensure-static

help:
	@echo "licai development commands"
	@echo ""
	@echo "  make setup          Create config.py, Python venv, install Python and frontend deps"
	@echo "  make dev            Print commands for running backend and frontend in two terminals"
	@echo "  make dev-backend    Run FastAPI backend on http://localhost:8888"
	@echo "  make dev-frontend   Run Vite frontend on http://localhost:5173"
	@echo "  make dev-stop       Stop local dev backend on configured port"
	@echo "  make build          Build frontend into ./static"
	@echo "  make verify-pages   Lint new page components and build frontend"
	@echo "  make run            Run backend serving ./static"
	@echo "  make test           Run pytest"
	@echo "  make lint           Run frontend lint"
	@echo "  make demo           Replace portfolio.db with demo data, backing up existing DB"
	@echo "  make demo-restore   Restore DB backed up by demo mode"
	@echo "  make demo-peek      Create portfolio.demo.db without replacing portfolio.db"
	@echo "  make clean          Remove local caches and build output"

setup: setup-backend setup-frontend

setup-backend: check-config
	@if [ ! -d "$(VENV)" ]; then \
		$(PYTHON) -m venv $(VENV); \
	fi
	$(PIP) install -r requirements.txt

setup-frontend:
	npm --prefix $(FRONTEND_DIR) install

check-config:
	@if [ ! -f config.py ]; then \
		cp config.example.py config.py; \
		echo "Created config.py from config.example.py"; \
	else \
		echo "config.py already exists"; \
	fi

ensure-static:
	@mkdir -p static/assets
	@if [ ! -f static/index.html ]; then \
		echo "static/index.html not found; dev mode is OK if you also run: make dev-frontend"; \
		echo "for single-port production mode, run: make build"; \
	fi

dev:
	@echo "Run these in two terminals:"
	@echo "  make dev-backend"
	@echo "  make dev-frontend"
	@echo "Do not run make dev-backend when ./install.sh service is installed."

dev-backend: check-config ensure-static
	./run.sh backend

dev-frontend:
	./run.sh frontend

dev-stop:
	@port=8888; \
	pids=$$(lsof -tiTCP:$$port -sTCP:LISTEN 2>/dev/null || true); \
	if [ -n "$$pids" ]; then echo "Stopping backend on $$port: $$pids"; kill $$pids; else echo "No backend listening on $$port"; fi

build build-frontend:
	npm --prefix $(FRONTEND_DIR) run build

verify-pages:
	cd $(FRONTEND_DIR) && npm exec eslint \
		src/components/DataBackup.jsx \
		src/components/DCAManager.jsx \
		src/components/BrokerSettings.jsx \
		src/components/SystemHealth.jsx \
		src/components/MarketAIInsights.jsx \
		src/components/ThesisReview.jsx \
		src/components/Settings.jsx
	npm --prefix $(FRONTEND_DIR) run build

run: check-config ensure-static
	./run.sh backend

test:
	@if [ ! -x "$(PY)" ]; then \
		echo "Missing $(PY). Run: make setup-backend"; \
		exit 1; \
	fi
	$(PY) -m pytest

lint:
	npm --prefix $(FRONTEND_DIR) run lint

demo: check-config
	@if [ ! -x "$(PY)" ]; then \
		echo "Missing $(PY). Run: make setup-backend"; \
		exit 1; \
	fi
	$(PY) scripts/seed_demo.py --use

demo-restore: check-config
	@if [ ! -x "$(PY)" ]; then \
		echo "Missing $(PY). Run: make setup-backend"; \
		exit 1; \
	fi
	$(PY) scripts/seed_demo.py --restore

demo-peek: check-config
	@if [ ! -x "$(PY)" ]; then \
		echo "Missing $(PY). Run: make setup-backend"; \
		exit 1; \
	fi
	$(PY) scripts/seed_demo.py --peek

clean:
	rm -rf .pytest_cache
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
	rm -rf static/assets static/index.html static/manifest.json static/sw.js static/icon-192.svg static/icon-512.svg
