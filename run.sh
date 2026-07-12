#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PYTHON_BIN="${PYTHON:-python3}"
VENV_DIR="${VENV:-venv}"
MODE="${1:-backend}"

# Make launchd / redirected logs flush promptly.
export PYTHONUNBUFFERED="${PYTHONUNBUFFERED:-1}"

usage() {
  cat <<USAGE
Usage: ./run.sh [backend|prod|frontend|dev|setup|test|check-port]

Commands:
  backend   Ensure backend prerequisites, then run FastAPI on http://localhost:8888
  prod      Build frontend into ./static, then run backend on http://localhost:8888
  frontend  Run Vite frontend on http://localhost:5173
  dev       Print two-terminal development commands
  setup     Create config.py, Python venv, install Python and frontend dependencies
  test      Run pytest inside the local venv
  check-port  Fail if backend port is already occupied

Environment:
  PYTHON    Python executable to use when creating venv (default: python3)
  VENV      Virtualenv directory (default: venv)
USAGE
}

ensure_config() {
  if [[ ! -f config.py ]]; then
    cp config.example.py config.py
    echo "Created config.py from config.example.py"
  else
    echo "config.py already exists"
  fi
}

ensure_static() {
  mkdir -p static/assets
  if [[ ! -f static/index.html ]]; then
    echo "static/index.html not found."
    echo "  Dev mode: run ./run.sh frontend in another terminal and open http://localhost:5173"
    echo "  Single-port mode: run ./run.sh prod to build frontend first."
  fi
}

ensure_venv() {
  if [[ ! -x "$VENV_DIR/bin/python" ]]; then
    echo "Creating virtualenv: $VENV_DIR"
    "$PYTHON_BIN" -m venv "$VENV_DIR"
  fi
}

install_backend_deps() {
  ensure_venv
  "$VENV_DIR/bin/pip" install -r requirements.txt
}

ensure_backend_ready() {
  ensure_config
  ensure_static
  ensure_venv
  if ! "$VENV_DIR/bin/python" - <<'PY' >/dev/null 2>&1
import fastapi, uvicorn, aiosqlite
PY
  then
    echo "Backend dependencies look incomplete; installing requirements.txt"
    "$VENV_DIR/bin/pip" install -r requirements.txt
  fi
}

backend_port() {
  "$VENV_DIR/bin/python" - <<'PY'
try:
    from config import config
    print(getattr(config, "port", 8888))
except Exception:
    print(8888)
PY
}

check_port_free() {
  ensure_config
  ensure_venv
  local port
  port="$(backend_port)"
  local pids
  pids="$(lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "Port ${port} is already in use by PID(s): ${pids}" >&2
    echo "If using launchd service, run: ./install.sh uninstall" >&2
    echo "If using dev mode, stop the old backend: lsof -tiTCP:${port} -sTCP:LISTEN | xargs kill" >&2
    return 1
  fi
}

case "$MODE" in
  backend|run)
    check_port_free
    ensure_backend_ready
    exec "$VENV_DIR/bin/python" run.py
    ;;
  prod)
    ensure_config
    ensure_venv
    if [[ ! -d frontend/node_modules ]]; then
      npm --prefix frontend install
    fi
    npm --prefix frontend run build
    ensure_backend_ready
    exec "$VENV_DIR/bin/python" run.py
    ;;
  check-port)
    check_port_free
    ;;
  frontend)
    if [[ ! -d frontend/node_modules ]]; then
      npm --prefix frontend install
    fi
    exec npm --prefix frontend run dev
    ;;
  dev)
    echo "Run these in two terminals:"
    echo "  ./run.sh backend"
    echo "  ./run.sh frontend"
    ;;
  setup)
    ensure_config
    install_backend_deps
    npm --prefix frontend install
    ;;
  test)
    ensure_config
    ensure_venv
    exec "$VENV_DIR/bin/python" -m pytest
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    echo "Unknown command: $MODE" >&2
    usage >&2
    exit 2
    ;;
esac
