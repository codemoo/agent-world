#!/bin/bash
# Agent World — persistent daemon startup script
# Used by launchd plist or manual invocation.
#
# Usage:
#   ./scripts/start-daemon.sh          # foreground (for launchd)
#   ./scripts/start-daemon.sh &         # background manual

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_DIR"

# Load nvm if available (needed for launchd which has minimal PATH)
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  source "$NVM_DIR/nvm.sh" --no-use
  nvm use default --silent 2>/dev/null || true
fi

# Ensure logs directory exists
mkdir -p "$PROJECT_DIR/logs"

# Default env vars (can be overridden)
export AGENT_WORLD_API_TOKEN="${AGENT_WORLD_API_TOKEN:-72f5a0a8ddf56f4971ac2bb3fafedc76}"
export PAPERCLIP_API_URL="${PAPERCLIP_API_URL:-http://127.0.0.1:3100}"
export PAPERCLIP_API_KEY="${PAPERCLIP_API_KEY:-local}"
export PAPERCLIP_SYNC_INTERVAL_MS="${PAPERCLIP_SYNC_INTERVAL_MS:-10000}"
export PAPERCLIP_COMPANY_ID="${PAPERCLIP_COMPANY_ID:-fb73545e-a0ec-41ee-849a-64ec31b81776}"

exec node server/index.js
