#!/usr/bin/env bash
# One-command local dev server, deliberately NOT routed through turbo.
#
# Why not `turbo run dev`: turbo.json runs in strict env mode, so it forwards
# only the variables listed in its globalEnv/env arrays. A freshly pasted key
# that is not in that list is silently stripped before Next ever starts. This
# script loads the repo-root .env.local directly, so every variable in that
# file reaches the app.
#
# Why APP_URL is exported: better-auth builds trustedOrigins from APP_URL (or
# falls back to http://localhost:3000). Running on any other port without
# APP_URL makes every cookie-bearing POST to /api/auth — sign-out included —
# fail with 403 INVALID_ORIGIN.
#
# Why --hostname localhost: without it `next dev` listens on every interface,
# and /api/dev-login hands a 30-day session for the founder's real account to
# whoever reaches it — anyone on the same Wi-Fi. `localhost` rather than
# 127.0.0.1 because sign-in and its cookie are documented on
# http://localhost:PORT, and that is the origin APP_URL names.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"

PORT="${PORT:-3100}"
export PORT
export APP_URL="${APP_URL:-http://localhost:${PORT}}"

cd "$APP_DIR"

# Non-fatal env validation: missing optional keys warn instead of exiting, so
# the app still boots with no AI provider key at all.
bun scripts/check-env.ts --dev

echo "▶ http://localhost:${PORT}   (sign in: http://localhost:${PORT}/api/dev-login)"

exec bunx dotenv-cli -e "$REPO_ROOT/.env.local" -- \
  bash "$SCRIPT_DIR/with-db.sh" bunx next dev --hostname localhost --port "$PORT"
