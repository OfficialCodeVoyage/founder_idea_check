#!/usr/bin/env bash
# PostToolUse (Edit|Write): format ONLY the file that changed, with Biome's formatter.
#
# Format only, never lint fixes: `ultracite fix` would also delete an import that was
# added one edit before its first use. Files Biome is told to ignore (components/ui and
# the other vendored folders in apps/chat/biome.jsonc) are skipped by
# --no-errors-on-unmatched. Python is not touched here.
#
# Replaces upstream's scripts/ai-post-codegen.sh hook, which formatted the whole repo and
# ran `bun run test:types` (it deletes apps/chat/.next/dev/types under a live dev server)
# after every edit. Never blocks: always exits 0.
set -u

input="$(cat)"
file="$(printf '%s' "$input" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
print(((d.get("tool_input") or {}).get("file_path")) or "")' 2>/dev/null)" || exit 0
[ -n "$file" ] || exit 0

case "$file" in
  *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs | *.json | *.jsonc | *.css) ;;
  *) exit 0 ;;
esac

root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
case "$file" in
  "$root"/*) rel="${file#"$root"/}" ;;
  /*) exit 0 ;;
  *) rel="$file" ;;
esac

case "$rel" in
  apps/chat/*) pkg="apps/chat" ;;
  packages/thread/*) pkg="packages/thread" ;;
  *) exit 0 ;;
esac

biome="$root/apps/chat/node_modules/.bin/biome"
[ -x "$biome" ] || exit 0
[ -f "$root/$rel" ] || exit 0

(cd "$root/$pkg" && "$biome" format --write --no-errors-on-unmatched "${rel#"$pkg"/}" >/dev/null 2>&1)
exit 0
