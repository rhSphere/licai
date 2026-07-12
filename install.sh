#!/usr/bin/env bash
# Install licai (理财助手) as a macOS launchd LaunchAgent.
# Generates a personalized plist from the template and registers it with launchd.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE="$DIR/com.licai.plist.example"
PLIST_NAME="com.licai.plist"
GENERATED="$DIR/$PLIST_NAME"
TARGET="$HOME/Library/LaunchAgents/$PLIST_NAME"
ACTION="${1:-install}"
DOMAIN="gui/$(id -u)"

usage() {
    cat <<USAGE
Usage: ./install.sh [install|uninstall|restart|status]

Commands:
  install    Generate plist, install to ~/Library/LaunchAgents, and start service
  uninstall  Stop service and remove plist from ~/Library/LaunchAgents
  restart    Reinstall and restart service
  status     Print launchctl status for com.licai

Service URL: http://localhost:8888
Logs:
  tail -f "$DIR/logs/stdout.log"
  tail -f "$DIR/logs/stderr.log"
USAGE
}

stop_service() {
    launchctl bootout "$DOMAIN" "$TARGET" 2>/dev/null || true
}

backend_port() {
    "$DIR/venv/bin/python" - <<'PY'
try:
    from config import config
    print(getattr(config, "port", 8888))
except Exception:
    print(8888)
PY
}

assert_port_free() {
    local port pids
    port="$(backend_port)"
    pids="$(lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$pids" ]; then
        echo "Port ${port} is already in use by PID(s): ${pids}" >&2
        echo "Stop the dev backend first: lsof -tiTCP:${port} -sTCP:LISTEN | xargs kill" >&2
        echo "Or use the existing backend and do not run install." >&2
        exit 1
    fi
}

case "$ACTION" in
    -h|--help|help)
        usage
        exit 0
        ;;
    uninstall)
        stop_service
        rm -f "$TARGET"
        echo "Uninstalled com.licai."
        exit 0
        ;;
    status)
        launchctl print "$DOMAIN/com.licai" 2>/dev/null || {
            echo "com.licai is not loaded."
            exit 1
        }
        exit 0
        ;;
    install|restart)
        ;;
    *)
        echo "Unknown action: $ACTION" >&2
        usage >&2
        exit 2
        ;;
esac

if [ ! -f "$TEMPLATE" ]; then
    echo "Template not found: $TEMPLATE"
    exit 1
fi

mkdir -p "$DIR/logs" "$DIR/backups"

if [ ! -x "$DIR/run.sh" ]; then
    chmod +x "$DIR/run.sh"
fi

# Prepare local runtime before registering launchd. run.sh is idempotent and will
# create config.py / venv if missing. Build the frontend once during install so
# the launchd backend can serve a usable single-port UI from ./static on :8888.
"$DIR/run.sh" setup
npm --prefix "$DIR/frontend" run build

# Substitute __PROJECT_PATH__ with the absolute project path
sed "s|__PROJECT_PATH__|$DIR|g" "$TEMPLATE" > "$GENERATED"

# Stop if already running
stop_service

# Give launchd a moment to stop the previous instance, then refuse to install if
# some other dev backend still owns the port. This avoids an endless
# spawn-scheduled loop with "address already in use".
sleep 1
assert_port_free

# Copy to LaunchAgents and load
cp "$GENERATED" "$TARGET"
launchctl bootstrap "$DOMAIN" "$TARGET"
launchctl kickstart -k "$DOMAIN/com.licai" 2>/dev/null || true

echo "Done! Service installed and started."
echo "  View logs: tail -f $DIR/logs/stderr.log"
echo "  Status:    ./install.sh status"
echo "  Stop:      launchctl bootout $DOMAIN $TARGET"
echo "  Start:     launchctl bootstrap $DOMAIN $TARGET"
echo "  Uninstall: ./install.sh uninstall"
echo "  URL:       http://localhost:8888"
