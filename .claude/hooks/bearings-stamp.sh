#!/usr/bin/env bash
# bearings-stamp.sh — stamp the orientation map with the current HEAD so the
# SessionStart guard (bearings-check.sh) can measure drift. Idempotent.
# Usage: bash .claude/hooks/bearings-stamp.sh [path/to/map.md]
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
MAP="${1:-$(python3 -c 'import json;print(json.load(open(".claude/bearings.json")).get("map","RECONSTRUCTION.md"))')}"
SHA=$(git rev-parse HEAD); DATE=$(date +%F)
python3 - "$MAP" "$SHA" "$DATE" <<'PY'
import re, sys
p, sha, date = sys.argv[1:]
t = open(p, encoding="utf-8").read()
t = re.sub(r"<!-- bearings-sha: [0-9a-f]+ -->\n?", "", t)
t = re.sub(r"<!-- bearings-date: \d{4}-\d{2}-\d{2} -->\n?", "", t)
stamp = f"<!-- bearings-sha: {sha} -->\n<!-- bearings-date: {date} -->\n"
lines = t.split("\n", 1)
if lines[0].startswith("# "):
    t = lines[0] + "\n" + stamp + (lines[1] if len(lines) > 1 else "")
else:
    t = stamp + t
open(p, "w", encoding="utf-8").write(t)
print(f"stamped {p} @ {sha[:10]} {date}")
PY
