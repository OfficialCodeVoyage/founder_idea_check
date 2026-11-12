#!/usr/bin/env bash
# restore-state.sh — SessionStart hook (wire it with matcher "compact").
#
# After a /compact, re-injects the "## Current focus" section of
# .planning/STATE.md into the new context: one header line, then the section
# (its heading up to the next "## " heading), at most 4000 bytes in total.
# Prints nothing when source != compact, the file is missing, or the section is
# missing or empty. Informational: ALWAYS exits 0 and never blocks.
# Needs only POSIX tools (jq / python3 are optional and used only to read input).

trap 'exit 0' EXIT

MAX=4000
HEADER="Restored after compaction from .planning/STATE.md (Current focus):"

INPUT=$(cat 2>/dev/null) || INPUT=""
[ -n "$INPUT" ] || exit 0

# input_field <name>: first non-empty of jq, python3, then a sed fallback
input_field() {
  local v=""
  if command -v jq >/dev/null 2>&1; then
    v=$(printf '%s' "$INPUT" | jq -r --arg k "$1" '.[$k] // empty | select(type == "string")' 2>/dev/null) || v=""
  fi
  if [ -z "$v" ] && command -v python3 >/dev/null 2>&1; then
    v=$(printf '%s' "$INPUT" | python3 -I -c 'import json,sys
d = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace"))
v = d.get(sys.argv[1]) if isinstance(d, dict) else None
sys.stdout.buffer.write(v.encode("utf-8", "replace") if isinstance(v, str) else b"")' "$1" 2>/dev/null) || v=""
  fi
  if [ -z "$v" ]; then
    v=$(printf '%s' "$INPUT" | tr -d '\n' | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" 2>/dev/null) || v=""
  fi
  printf '%s' "$v"
}

[ "$(input_field source)" = "compact" ] || exit 0

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || ROOT=""
if [ -z "$ROOT" ]; then
  CWD_IN=$(input_field cwd)
  if [ -n "$CWD_IN" ] && [ -d "$CWD_IN" ]; then ROOT=$CWD_IN; else ROOT=$PWD; fi
fi
STATE="$ROOT/.planning/STATE.md"
[ -f "$STATE" ] && [ -r "$STATE" ] || exit 0

IFS= read -r -d '' AWK_SECTION <<'AWK'
{
  line = $0; sub(/\r$/, "", line)
  inf = infence
  if (line ~ /^[ ]*(```|~~~)/) infence = !infence
  if (!inf && line ~ /^#+[ \t]/) {
    match(line, /^#+/); lvl = RLENGTH
    if (insec && lvl <= 2) exit
    if (!insec && lvl == 2) {
      title = tolower(substr(line, lvl + 1)); sub(/^[ \t]+/, "", title)
      if (title ~ /^current focus([^a-z0-9]|$)/) insec = 1
    }
  }
  if (insec) print line
}
AWK
BODY=$(awk "$AWK_SECTION" "$STATE" 2>/dev/null) || exit 0
[ -n "$BODY" ] || exit 0

OUT=$(printf '%s\n%s' "$HEADER" "$BODY")
LEN=$(printf '%s' "$OUT" | wc -c | tr -d '[:space:]')
case $LEN in ''|*[!0-9]*) LEN=0 ;; esac
if [ "$LEN" -ge "$MAX" ]; then   # +1 byte for the final newline
  CUT=$(printf '%s' "$OUT" | head -c $((MAX - 20)))
  if command -v iconv >/dev/null 2>&1; then   # drop a multibyte character cut in half
    CUT2=$(printf '%s' "$CUT" | iconv -f UTF-8 -t UTF-8 -c 2>/dev/null) && [ -n "$CUT2" ] && CUT=$CUT2
  fi
  OUT=$(printf '%s\n[truncated]' "$CUT")
fi
printf '%s\n' "$OUT"
exit 0
