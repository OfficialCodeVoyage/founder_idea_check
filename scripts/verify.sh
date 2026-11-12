#!/usr/bin/env bash
# verify: lint + type-check every TypeScript workspace, lint the Python sidecar.
# Run it before saying work is done. CI runs the same script.
#
# Safe beside a running `next dev`. Unlike `bun run test:types`, it never deletes
# apps/chat/.next/dev/types. It writes only gitignored files: apps/chat/.next/types,
# apps/chat/next-env.d.ts and tsconfig.tsbuildinfo.
#
# Not checked here: Python formatting (11 files are not ruff-formatted, some vendored on
# purpose; see apps/research/pyproject.toml) and tests (bun run test:unit, pytest).
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chat_bin="$root/apps/chat/node_modules/.bin"
failed=()
skipped=()

if [ ! -x "$chat_bin/tsc" ] || [ ! -x "$chat_bin/next" ]; then
  echo "verify: dependencies are not installed. Run: bun install --frozen-lockfile" >&2
  exit 2
fi

step() {
  local name="$1" dir="$2"
  shift 2
  printf '\n== %s\n' "$name"
  if (cd "$root/$dir" && "$@"); then
    echo "ok: $name"
  else
    failed+=("$name")
  fi
}

chat_types() {
  "$chat_bin/next" typegen . >/dev/null && "$chat_bin/tsc" --noEmit
}

step "apps/chat lint (ultracite check)" apps/chat bun run lint
step "apps/chat types (next typegen + tsc)" apps/chat chat_types
step "packages/thread lint (biome check)" packages/thread bun run lint
step "packages/thread types (tsc)" packages/thread bun run test:types

py="$root/apps/research/.venv/bin/python"
if [ -x "$py" ]; then
  step "apps/research lint (ruff check)" apps/research "$py" -m ruff check app tests
else
  skipped+=("apps/research ruff check: no apps/research/.venv (setup: apps/research/README.md)")
fi

echo
for s in ${skipped[@]+"${skipped[@]}"}; do echo "SKIPPED: $s"; done
if [ "${#failed[@]}" -gt 0 ]; then
  for f in "${failed[@]}"; do echo "FAILED: $f"; done
  echo "verify: ${#failed[@]} check(s) failed"
  exit 1
fi
echo "verify: all checks passed${skipped[0]+ (${#skipped[@]} skipped)}"
