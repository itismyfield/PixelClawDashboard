#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNTIME_ROOT="$HOME/.local/share/pixel-claw-dashboard"
RELEASES_DIR="$RUNTIME_ROOT/releases"
CURRENT_LINK="$RUNTIME_ROOT/current"
STATE_ROOT="$HOME/.local/state/pixel-claw-dashboard"
PROD_DB_DIR="$STATE_ROOT/prod"
PROD_DB_PATH="$PROD_DB_DIR/pixel-claw-dashboard.sqlite"
LOG_DIR="$STATE_ROOT/logs"
SMOKE_PORT="${PCD_SMOKE_PORT:-8793}"
LABEL="com.pixelclaw.dashboard"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
LAUNCHD_DOMAIN="gui/$(id -u)"
STAMP="$(date +%Y%m%d-%H%M%S)"
RELEASE_DIR="$RELEASES_DIR/$STAMP"
SOURCE_DB_PATH="$REPO_ROOT/pixel-claw-dashboard.sqlite"

mkdir -p "$RELEASES_DIR" "$PROD_DB_DIR" "$LOG_DIR"

cd "$REPO_ROOT"
pnpm build

mkdir -p "$RELEASE_DIR"

for item in dist server package.json pnpm-lock.yaml tsconfig.json tsconfig.node.json vite.config.ts .env .env.example; do
  if [[ -e "$REPO_ROOT/$item" ]]; then
    rsync -a "$REPO_ROOT/$item" "$RELEASE_DIR/"
  fi
done

ln -sfn "$REPO_ROOT/node_modules" "$RELEASE_DIR/node_modules"

if [[ ! -f "$PROD_DB_PATH" && -f "$SOURCE_DB_PATH" ]]; then
  sqlite3 "$SOURCE_DB_PATH" ".backup '$PROD_DB_PATH'"
fi

SMOKE_DB_PATH="$RELEASE_DIR/.smoke.sqlite"
SMOKE_LOG_PATH="$RELEASE_DIR/.smoke.log"
rm -f "$SMOKE_DB_PATH" "$SMOKE_DB_PATH-shm" "$SMOKE_DB_PATH-wal" "$SMOKE_LOG_PATH"
if [[ -f "$PROD_DB_PATH" ]]; then
  sqlite3 "$PROD_DB_PATH" ".backup '$SMOKE_DB_PATH'"
elif [[ -f "$SOURCE_DB_PATH" ]]; then
  sqlite3 "$SOURCE_DB_PATH" ".backup '$SMOKE_DB_PATH'"
fi

PORT="$SMOKE_PORT" \
HOST="127.0.0.1" \
DB_PATH="$SMOKE_DB_PATH" \
NODE_PATH="$RELEASE_DIR/node_modules" \
/opt/homebrew/bin/node --import tsx server/server-main.ts >"$SMOKE_LOG_PATH" 2>&1 &
SMOKE_PID=$!
cleanup() {
  kill "$SMOKE_PID" 2>/dev/null || true
}
trap cleanup EXIT

for _ in {1..30}; do
  if curl -fsS "http://127.0.0.1:$SMOKE_PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -fsS "http://127.0.0.1:$SMOKE_PORT/health" >/dev/null 2>&1; then
  echo "PCD smoke healthcheck failed. See $SMOKE_LOG_PATH" >&2
  exit 1
fi

kill "$SMOKE_PID" 2>/dev/null || true
wait "$SMOKE_PID" 2>/dev/null || true
trap - EXIT

ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"

if launchctl print "$LAUNCHD_DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl kickstart -k "$LAUNCHD_DOMAIN/$LABEL"
else
  launchctl bootstrap "$LAUNCHD_DOMAIN" "$PLIST_PATH"
  launchctl kickstart -k "$LAUNCHD_DOMAIN/$LABEL"
fi

echo "Promoted PCD stable release: $RELEASE_DIR"
echo "Current symlink: $CURRENT_LINK"
