#!/usr/bin/env bash
# Post-edit check for the Codex (Stop) and Cursor (afterFileEdit) hooks.
#
# Runs `bun run verify` (lint + type-check + ruff). It used to format the whole repository and
# run `bun run test:types`, which deletes apps/chat/.next/dev/types under a running dev server.
# `verify` never does that, so this hook is safe beside `next dev`. It does not format anything:
# format the file you edited with the editor (Biome) or `bun run format`.
#
# The hook passes the tool name ("codex" or "cursor") as $1. It is not used.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

bun run verify
