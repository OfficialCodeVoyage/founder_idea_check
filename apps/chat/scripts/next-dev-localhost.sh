#!/usr/bin/env bash
# Starts `next dev` bound to localhost with IC_DEV_SERVER_LOCALHOST_ONLY=1, the
# marker without which /api/dev-login answers 404
# (app/api/dev-login/route.ts::isStartedBoundToLocalhost). Extra arguments are
# passed on to `next dev`.
#
# WHY IT REFUSES A HOSTNAME ARGUMENT. A package script's extra arguments are
# appended after `--hostname localhost`, and Next takes the LAST `-H`. So
# `bun run dev --hostname 0.0.0.0` used to listen on every interface with the
# marker still set, and a machine on the same Wi-Fi that sent
# `Host: localhost` and `X-Forwarded-For: 127.0.0.1` got a 30-day session for
# the founder's account. The marker is only true while the bind is, so the
# bind cannot be overridden here: to listen elsewhere, run `next dev` yourself,
# without the marker, and the dev sign-in stays off.
set -euo pipefail

for arg in "$@"; do
  case "$arg" in
    -H* | --hostname | --hostname=*)
      echo "Refusing to start: this script binds the dev server to localhost for /api/dev-login, so it does not take a hostname ($arg). Run 'next dev' directly to listen elsewhere; the dev sign-in is then off." >&2
      exit 2
      ;;
  esac
done

# The app's own Next first (what `bunx next` resolved to before), then PATH,
# which is where a package manager's run puts it in a scaffolded project.
NEXT_BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/node_modules/.bin/next"
if [ ! -x "$NEXT_BIN" ]; then
  NEXT_BIN=next
fi

exec env IC_DEV_SERVER_LOCALHOST_ONLY=1 "$NEXT_BIN" dev --hostname localhost "$@"
