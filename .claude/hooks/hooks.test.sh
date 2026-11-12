#!/usr/bin/env bash
# hooks.test.sh — self-contained tests for the hook scripts in this folder.
#
#   bash hooks.test.sh                   # tests with the bash that runs this file
#   /bin/bash hooks.test.sh              # on macOS: bash 3.2, the oldest supported
#   HOOK_TEST_SHELL=/path/to/bash bash hooks.test.sh
#
# Every case builds a throwaway git repo under mktemp -d, writes fixture files,
# pipes a REAL hook JSON payload into the script and checks exit code / output.
# Needs: bash, git, awk, grep, sed, tr, head, wc, iconv, python3 (payload check
# only; one case is skipped without it). Nothing outside the temp dir is touched.

# shellcheck disable=SC2016,SC2086,SC2088  # single-quoted commands, word-split tool lists and literal ~ in commands are intentional
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
SH=${HOOK_TEST_SHELL:-${BASH:-bash}}
SH=$(command -v "$SH") || { echo "no such shell: $SH" >&2; exit 2; }
TMP=$(mktemp -d "${TMPDIR:-/tmp}/hooks-test.XXXXXX") || exit 2
TMP=$(cd "$TMP" && pwd -P)
trap 'rm -rf "$TMP"' EXIT

# Hermetic git: no user/system config, no prompts, fixed identity.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE

PASS=0; FAIL=0
ok() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$1"; [ -n "${2:-}" ] && printf '        %s\n' "$2"; return 0; }

# ------------------------------------------------------------------ helpers
jesc() {   # JSON-escape a string
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\t'/\\t}
  printf '%s' "$s"
}
payload() {   # PreToolUse payload: <command> <cwd>
  printf '{"session_id":"abc123","transcript_path":"/tmp/t.jsonl","cwd":"%s","permission_mode":"default","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"%s","description":"test"},"tool_use_id":"toolu_01"}' "$(jesc "$2")" "$(jesc "$1")"
}
session_payload() {   # SessionStart payload: <source> <cwd>
  printf '{"session_id":"abc123","transcript_path":"/tmp/t.jsonl","cwd":"%s","hook_event_name":"SessionStart","source":"%s","model":"claude-sonnet-5-5"}' "$(jesc "$2")" "$1"
}
put() { mkdir -p "$(dirname "$1")"; cat > "$1"; }

mk_repo() {   # <dir> [branch]  (one empty commit)
  mkdir -p "$1"
  ( cd "$1" && git init -q . && git symbolic-ref HEAD "refs/heads/${2:-main}" \
    && git config user.email t@t && git config user.name t && git config commit.gpgsign false \
    && git commit -q --allow-empty -m init ) >/dev/null 2>&1
}

RC=0; STDOUT=""; STDERR=""
run_hook() {   # <script> <cwd> <stdin> [env-prefix words...]
  local script=$1 cwd=$2 input=$3
  shift 3
  ( cd "$cwd" && printf '%s' "$input" | "$@" "$SH" "$HERE/$script" ) >"$TMP/stdout" 2>"$TMP/stderr"
  RC=$?
  STDOUT=$(cat "$TMP/stdout"); STDERR=$(cat "$TMP/stderr")
}

guard() {   # <name> <want-rc> <repo> <command> [env-prefix words...]
  local name=$1 want=$2 repo=$3 cmd=$4
  shift 4
  run_hook require-pr-on-blocker.sh "$repo" "$(payload "$cmd" "$repo")" "$@"
  if [ "$RC" = "$want" ]; then ok "$name"; else bad "$name" "want exit $want, got $RC; command: $cmd; stderr: ${STDERR:0:160}"; fi
}
guard_raw() {   # <name> <want-rc> <repo> <raw stdin>
  run_hook require-pr-on-blocker.sh "$3" "$4"
  if [ "$RC" = "$2" ]; then ok "$1"; else bad "$1" "want exit $2, got $RC; stderr: ${STDERR:0:160}"; fi
}
stderr_has() {   # <name> <needle>   (checks the last run)
  case $STDERR in *"$2"*) ok "$1" ;; *) bad "$1" "stderr lacks [$2]: ${STDERR:0:300}" ;; esac
}
stderr_lacks() {
  case $STDERR in *"$2"*) bad "$1" "stderr unexpectedly has [$2]" ;; *) ok "$1" ;; esac
}

mk_shim() {   # <name> <tools...>  -> prints a dir holding only symlinks to those tools
  local d="$TMP/shim-$1" t p
  shift
  mkdir -p "$d"
  for t in "$@"; do
    p=$(command -v "$t" 2>/dev/null) || continue
    [ -x "$p" ] && ln -sf "$p" "$d/$t"
  done
  printf '%s' "$d"
}
BASE_TOOLS="cat tr sed grep awk git head tail wc cut sort iconv env sh date rm mkdir ls sleep kill cp"

# ------------------------------------------------------------ STATE fixtures
state_active() { put "$1/.planning/STATE.md" <<'EOF'
# Project State

## Current focus

Ship the thing.

### Blockers/Concerns

- **Migration 0056 push blocker (2026-10-13): do NOT `git push origin master:production` until applied.** Hard deploy gate.
  Progress 2026-10-13: first numbered 0055.

- Advisory note, not a blocker: upgrade eslint later.
  - sub-bullet detail

### Decisions

- Use Postgres.
EOF
}
state_resolved8() { put "$1/.planning/STATE.md" <<'EOF'
# Project State

### Blockers/Concerns

- Migration 0057 PUSH BLOCKER (2026-10-15): hold pushes until applied.
  line 1
  line 2
  line 3
  line 4
  line 5
  line 6
  line 7
  RESOLVED: 2026-10-16 — applied to both databases.

### Decisions
EOF
}

# ============================================================ push guard ==
echo "== bash under test: $("$SH" --version | head -1)"
echo "== push guard"

R=$TMP/r-main; mk_repo "$R" main; state_active "$R"
F=$TMP/r-feat; mk_repo "$F" feat/work; state_active "$F"

guard "non-push command -> allow" 0 "$R" "ls -la"
guard "word push but not git -> allow" 0 "$R" "npm run push-assets"
guard "git status -> allow" 0 "$R" "git status"
guard "push to feature branch -> allow" 0 "$R" "git push origin feat/work"
guard "push -u feature branch -> allow" 0 "$R" "git push -u origin chore/fix-260101"
guard "git push origin main + active blocker -> block" 2 "$R" "git push origin main"
stderr_has "block message names the blocker" "Migration 0056 push blocker"
stderr_has "block message shows the safe flow" "git checkout -b chore/<slug>-<YYMMDD>"
stderr_has "block message mentions gh pr create" "gh pr create"
stderr_has "block message explains RESOLVED" "RESOLVED: <YYYY-MM-DD>"
guard "git push origin production (bare) -> block" 2 "$R" "git push origin production"
guard "git push origin master -> block" 2 "$R" "git push origin master"
guard "HEAD:main -> block" 2 "$R" "git push origin HEAD:main"
guard "-f +main -> block" 2 "$R" "git push -f origin +main"
guard "--force origin main -> block" 2 "$R" "git push --force origin main"
guard "--force-with-lease origin main -> block" 2 "$R" "git push --force-with-lease origin main"
guard "main --force-with-lease=main:abc -> block" 2 "$R" "git push origin main --force-with-lease=main:abc123"
guard "-u origin main -> block" 2 "$R" "git push -u origin main"
guard "feature:main (x:<b>) -> block" 2 "$R" "git push origin feat/work:main"
guard "src:refs/heads/main -> block" 2 "$R" "git push origin feat/work:refs/heads/main"
guard "bare refs/heads/production -> block" 2 "$R" "git push origin refs/heads/production"
guard "master:production (dest protected) -> block" 2 "$R" "git push origin master:production"
guard "main:other (dest is not protected) -> allow" 0 "$R" "git push origin main:other"
guard "delete via :main -> block" 2 "$R" "git push origin :main"
guard "--delete origin main -> block" 2 "$R" "git push --delete origin main"
guard "quoted 'main' -> block" 2 "$R" "git push origin 'main'"
guard "other remote name (upstream main) -> block" 2 "$R" "git push upstream main"
guard "remote NAMED production, feature branch -> allow" 0 "$R" "git push production feat/work"
guard "--all -> block" 2 "$R" "git push --all origin"
guard "--mirror -> block" 2 "$R" "git push --mirror origin"
guard "shell expansion as refspec -> block" 2 "$R" 'git push origin $BRANCH'
guard "command substitution as refspec -> block" 2 "$R" 'git push origin "$(git branch --show-current)"'
guard "glob refspec -> block" 2 "$R" "git push origin 'refs/heads/*:refs/heads/*'"
guard "-o option value skipped, feature -> allow" 0 "$R" "git push -o ci.skip origin feat/work"
guard "-o option value skipped, main -> block" 2 "$R" "git push -o ci.skip origin main"
guard "feature push with 2>&1 -> allow" 0 "$R" "git push origin feat/work 2>&1"
guard "tab-separated 'git<TAB>push' -> block" 2 "$R" $'git\tpush\torigin\tmain'
guard "backslash line continuation -> block" 2 "$R" $'git push \\\n  origin main'
guard "--repo=origin form (all positionals are refspecs) -> block" 2 "$R" "git push --repo=origin main"
guard "--tags only (no branch is pushed) on protected branch -> allow" 0 "$R" "git push origin --tags"
guard "--tags together with an explicit main -> block" 2 "$R" "git push origin --tags main"
guard "--follow-tags on protected branch (pushes the branch) -> block" 2 "$R" "git push --follow-tags"
guard "/usr/bin/git -C . push origin main -> block" 2 "$R" "/usr/bin/git -C . push origin main"
guard "rtk git push origin main -> block" 2 "$R" "rtk git push origin main"
guard "command git push origin main -> block" 2 "$R" "command git push origin main"
guard "git -c k=v push origin main -> block" 2 "$R" "git -c push.default=simple push origin main"
guard "git -c with quoted spaces -> block" 2 "$R" 'git -c user.name="A B" push origin main'
guard "git -C quoted dir with space -> block" 2 "$R" 'git -C "/tmp/my dir/x" push origin main'
guard "git --no-pager push -> block" 2 "$R" "git --no-pager push origin main"
guard "env prefix with quoted value -> block" 2 "$R" 'GIT_SSH_COMMAND="ssh -i k" git push origin main'
guard "cd x && git push origin main -> block" 2 "$R" "cd x && git push origin main"
guard "semicolon chain -> block" 2 "$R" "git add -A; git commit -m x; git push origin main"
guard "newline chain -> block" 2 "$R" $'git add -A\ngit push origin main'
guard "feature push then main push -> block" 2 "$R" "git push origin feat/work && git push origin main"
guard "dry-run then real main push -> block" 2 "$R" "git push --dry-run origin main && git push origin main"
guard "background push (&) -> block" 2 "$R" "git push origin main &"
guard "subshell (git push ...) -> block" 2 "$R" "(cd x && git push origin main)"
guard "bash -c '...' nested push -> block" 2 "$R" "bash -c 'git push origin main'"
guard "eval \"...\" nested push -> block" 2 "$R" 'eval "git push origin production"'
guard "python3 -c payload with a nested push -> block" 2 "$R" "python3 -c \"import os; os.system('git push origin main')\""
guard "bash -lc payload with a nested push -> block" 2 "$R" 'bash -lc "cd x && git push origin production"'
guard "sh -c 'git push' (bare, nested) on protected branch -> block" 2 "$R" "sh -c 'git push'"
guard "sh -c 'git push' (bare, nested) on feature branch -> allow" 0 "$F" "sh -c 'git push'"
guard "nested shell inside a nested shell -> block" 2 "$R" "bash -c \"bash -c 'git push origin main'\""
guard "time/sudo/nohup wrappers -> block" 2 "$R" "time sudo -u deploy nohup git push origin main"
guard "commit message mentioning 'git push origin main' -> allow" 0 "$R" 'git commit -m "never run git push origin main by hand"'
guard "heredoc commit message mentioning a push -> allow" 0 "$R" $'git commit -m "$(cat <<\'EOF\'\nFix docs: do NOT git push origin master:production\nEOF\n)"'
guard "PR body mentioning a push -> allow" 0 "$R" 'gh pr create --title t --body "Do not git push origin master directly"'
guard "echo of a push command -> allow" 0 "$R" 'echo "git push origin main"'
guard "grep -e for a push command -> allow" 0 "$R" 'grep -e "git push origin main" docs/DEPLOYMENT.md'
guard "known limit: unquoted heredoc body is scanned as commands -> block" 2 "$R" $'cat > notes.md <<\'EOF\'\ngit push origin main\nEOF'
guard "trailing shell comment mentioning main -> allow" 0 "$R" "git push origin feat/work # not main"
guard "text after # is a comment, push main before it -> block" 2 "$R" "git push origin main # trailing"
guard "commented-out push -> allow" 0 "$R" "echo hi #; git push origin main"
guard "quoted # is not a comment -> block" 2 "$R" "bash -c 'echo \"#\"; git push origin main'"
guard "main-feature (longer name) -> allow" 0 "$R" "git push origin main-feature"
guard "feat/mainx -> allow" 0 "$R" "git push origin feat/mainx"
guard "prod/main sub-path -> allow" 0 "$R" "git push origin prod/main"
guard "--dry-run origin main -> allow" 0 "$R" "git push --dry-run origin main"
guard "-n origin main -> allow" 0 "$R" "git push -n origin main"
guard "--all --dry-run -> allow" 0 "$R" "git push --all --dry-run origin"
guard "git commit mentioning push, on main -> allow" 0 "$R" 'git commit -m "docs: explain git push"'
guard "git log --grep push -> allow" 0 "$R" "git log --grep push"
guard "mygit push origin main (not git) -> allow" 0 "$R" "mygit push origin main"
guard "git-lfs push origin main (not git) -> allow" 0 "$R" "git-lfs push origin main"
run_hook require-pr-on-blocker.sh "$R" '{"tool_name":"Write","tool_input":{"file_path":"/x","content":"git push origin main"},"cwd":"/x"}'
if [ "$RC" = 0 ]; then ok "Write tool containing 'git push origin main' -> allow"; else bad "Write tool containing 'git push origin main' -> allow" "got $RC"; fi

# bare pushes: the current branch decides
guard "bare 'git push' on protected branch -> block" 2 "$R" "git push"
guard "'git push origin' (no refspec) on protected branch -> block" 2 "$R" "git push origin"
guard "'git push -u origin HEAD' on protected branch -> block" 2 "$R" "git push -u origin HEAD"
guard "bare 'git push 2>&1' on protected branch -> block" 2 "$R" "git push 2>&1"
guard "bare 'git push' on feature branch -> allow" 0 "$F" "git push"
guard "'git push -u origin HEAD' on feature branch -> allow" 0 "$F" "git push -u origin HEAD"
guard "'git push origin' on feature branch -> allow" 0 "$F" "git push origin"
guard "feature branch HEAD:main -> block" 2 "$F" "git push origin HEAD:main"
guard "feature branch explicit main -> block" 2 "$F" "git push origin main"
D=$TMP/r-detached; mk_repo "$D" main; state_active "$D"; ( cd "$D" && git checkout -q --detach ) >/dev/null 2>&1
guard "bare push on detached HEAD -> block (branch unknown)" 2 "$D" "git push"

# A: $'...' / $"..." quoting
guard "\$'git' push origin main -> block" 2 "$F" "\$'git' push origin main"
guard "\$\"git\" push origin main -> block" 2 "$F" '$"git" push origin main'
guard "git push origin \$'main' -> block" 2 "$F" "git push origin \$'main'"
guard "git push origin \$'feat/work' -> allow" 0 "$F" "git push origin \$'feat/work'"
guard "\$'it\\'s' escape does not hide a later push -> block" 2 "$F" "echo \$'it\\'s'; git push origin main"

# B: command substitution is one opaque word; its body is scanned as code
guard "git push \$(echo origin) main (feature branch) -> block" 2 "$F" 'git push $(echo origin) main'
guard "git push \`echo origin\` main (feature branch) -> block" 2 "$F" 'git push `echo origin` main'
guard "git push --repo=\$(echo origin) main -> block" 2 "$F" 'git push --repo=$(echo origin) main'
guard "git push \$(echo origin) feat/work -> block (remote unprovable, deliberate)" 2 "$F" 'git push $(echo origin) feat/work'
guard "bare git push \$REMOTE on feature branch -> block (remote unprovable)" 2 "$F" 'git push $REMOTE'
guard "echo \$(git push origin main) -> block (nested scanned)" 2 "$F" 'echo $(git push origin main)'
guard "echo \"\$(git push origin main)\" -> block (substitution in \"...\" is code)" 2 "$F" 'echo "$(git push origin main)"'
guard "echo \"\`git push origin main\`\" -> block" 2 "$F" 'echo "`git push origin main`"'
guard "nested \$(\$(git push origin main)) -> block" 2 "$F" 'echo "$(echo "$(git push origin main)")"'
guard "git push origin feat/work \"\$(date)\" -> block (unprovable refspec)" 2 "$F" 'git push origin feat/work "$(date)"'
guard "git commit -m \"\$(date)\" && git push origin feat/work -> allow" 0 "$F" 'git commit -m "$(date)" && git push origin feat/work'
guard "echo \$(ls) && git push origin feat/work -> allow" 0 "$F" 'echo $(ls) && git push origin feat/work'
guard "substitution with ) and ' in quotes keeps the segment -> block" 2 "$F" 'echo "$(echo ")" '"'"')'"'"')" && git push origin main'
guard "heredoc commit msg with (parens) and don't, then push main -> block" 2 "$R" $'git commit -m "$(cat <<\'EOF\'\nfix(auth): don\'t git push origin main (ever)\nEOF\n)" && git push origin main'
guard "heredoc commit msg with (parens) and don't, then push feature -> allow" 0 "$R" $'git commit -m "$(cat <<\'EOF\'\nfix(auth): don\'t git push origin main (ever)\nEOF\n)" && git push origin feat/work'
guard "heredoc fed to bash inside a substitution is scanned -> block" 2 "$F" $'x=$(bash <<\'EOF\'\ngit push origin main\nEOF\n)'
guard "bash -c with a substitution holding a push -> block" 2 "$F" "bash -c 'echo \$(git push origin main)'"
# a plain cat heredoc is data, unless the substitution's output is run as code
guard "eval \"\$(cat <<'EOF' push EOF)\" -> block" 2 "$R" $'eval "$(cat <<\'EOF\'\ngit push origin main\nEOF\n)"'
guard "bash -c \"\$(cat <<'EOF' push EOF)\" -> block" 2 "$R" $'bash -c "$(cat <<\'EOF\'\ngit push origin main\nEOF\n)"'
guard "\$(cat <<'EOF' push EOF) | bash -> block" 2 "$R" $'$(cat <<\'EOF\'\ngit push origin main\nEOF\n) | bash'
guard "echo \"\$(cat <<'EOF' push EOF)\" | sudo -u x /bin/sh -> block" 2 "$R" $'echo "$(cat <<\'EOF\'\ngit push origin main\nEOF\n)" | sudo -u x /bin/sh'
guard "x=\$(eval \"\$(cat <<'EOF' push EOF)\") (inner level is code) -> block" 2 "$R" $'x=$(eval "$(cat <<\'EOF\'\ngit push origin main\nEOF\n)")'
guard "\$(echo \"\$(cat <<'EOF' push EOF)\" | bash) (inner piped) -> block" 2 "$R" $'x=$(echo "$(cat <<\'EOF\'\ngit push origin main\nEOF\n)" | bash)'
guard "commit -m \"\$(cat <<'EOF' ... EOF)\" stays data -> allow" 0 "$R" $'git commit -m "$(cat <<\'EOF\'\ndo NOT git push origin master:production\nEOF\n)"'
guard "gh pr create --body \"\$(cat <<'EOF' ... EOF)\" -> allow" 0 "$R" $'gh pr create --body "$(cat <<\'EOF\'\nnever git push origin main\nEOF\n)"'
guard "printf '%s' \"\$(cat <<'EOF' ... EOF)\" -> allow" 0 "$R" $'printf \'%s\' "$(cat <<\'EOF\'\ngit push origin main\nEOF\n)"'

# code pipelines: text fed to an interpreter (pipe, here-string, heredoc, <(...)) is code
HD=$'"$(cat <<\'EOF\'\ngit push origin master\nEOF\n)"'
guard "echo '...' | bash -> block" 2 "$F" "echo 'git push origin master' | bash"
guard "printf '...' | sh -> block" 2 "$F" "printf 'git push origin master' | sh"
guard "bash <<< '...' -> block" 2 "$F" "bash <<< 'git push origin master'"
guard "bash -s <<< '...' -> block" 2 "$F" "bash -s <<< 'git push origin master'"
guard "bash < <(echo '...') -> block" 2 "$F" "bash < <(echo 'git push origin master')"
guard "bash /dev/stdin <<< '...' -> block" 2 "$F" "bash /dev/stdin <<< 'git push origin master'"
guard "echo \"\$(cat heredoc)\" |& bash -> block" 2 "$F" "echo $HD |& bash"
guard "echo \"\$(cat heredoc)\" | env bash -> block" 2 "$F" "echo $HD | env bash"
guard "echo \"\$(cat heredoc)\" 2>&1 | bash -> block" 2 "$F" "echo $HD 2>&1 | bash"
guard "bash <<< \"\$(cat heredoc)\" -> block" 2 "$F" "bash <<< $HD"
guard "source <(echo '...') -> block" 2 "$F" "source <(echo 'git push origin master')"
guard ". /dev/stdin <<< '...' -> block" 2 "$F" ". /dev/stdin <<< 'git push origin master'"
guard "| sudo -u x /bin/bash -> block" 2 "$F" "echo 'git push origin master' | sudo -u x /bin/bash"
guard "| xargs sh -> block" 2 "$F" "echo 'git push origin master' | xargs sh"
guard "| nohup bash -> block" 2 "$F" "echo 'git push origin master' | nohup bash"
guard "|& env -i sh -> block" 2 "$F" "echo 'git push origin master' |& env -i sh"
guard "bash -c \"echo '...' | sh\" -> block" 2 "$F" "bash -c \"echo 'git push origin master' | sh\""
guard "commit -m \"\$(echo '...' | bash)\" -> block" 2 "$F" "git commit -m \"\$(echo 'git push origin master' | bash)\""
guard "top-level bash heredoc with an apostrophe in it -> block" 2 "$F" $'bash <<\'EOF\'\necho don\'t\ngit push origin master\nEOF'
guard "echo '...' | (bash) subshell stage -> block" 2 "$F" "echo 'git push origin master' | (bash)"
guard "python3 -c os.system(push) -> block" 2 "$F" "python3 -c \"import os; os.system('git push origin master')\""
guard "node -e execSync(push) -> block" 2 "$F" "node -e \"require('child_process').execSync('git push origin master')\""
guard "bash -c \"bash -c '...'\" -> block" 2 "$F" "bash -c \"bash -c 'git push origin master'\""
guard "sh -c 'echo git push origin master | bash' -> block" 2 "$F" "sh -c 'echo git push origin master | bash'"
# data-only pipelines stay data
guard "git commit -m '...' -> allow" 0 "$F" "git commit -m 'git push origin master'"
guard "echo '...' -> allow" 0 "$F" "echo 'git push origin master'"
guard "gh pr create --body '...' -> allow" 0 "$F" "gh pr create --body 'do not git push origin master'"
guard "grep '...' docs/CI.md | head -> allow" 0 "$F" "grep 'git push origin master' docs/CI.md | head"
guard "echo '...' | grep bash -> allow" 0 "$F" "echo 'git push origin master' | grep bash"
guard "printf '%s' \"\$(cat <<EOF...)\" > notes.txt -> allow" 0 "$F" $'printf \'%s\' "$(cat <<EOF\ngit push origin master\nEOF\n)" > notes.txt'
guard "echo \"\$(cat <<EOF...)\" | tee log.txt -> allow" 0 "$F" $'echo "$(cat <<EOF\ngit push origin master\nEOF\n)" | tee log.txt'
guard "git commit -F <(printf '...') -> allow" 0 "$F" "git commit -F <(printf 'git push origin master')"
guard "unquoted heredoc body: its \$(...) still runs -> block" 2 "$F" $'echo "$(cat <<EOF\nnote $(git push origin master)\nEOF\n)"'

# heredoc in a substitution is data only for a data-only reader (cat, tee, grep...)
guard "\$(./x <<'EOF' push EOF) -> block (unknown reader)" 2 "$F" $'echo "$(./x <<\'EOF\'\ngit push origin master\nEOF\n)"'
guard "\$(make <<EOF push EOF) -> block" 2 "$F" $'echo "$(make <<EOF\ngit push origin master\nEOF\n)"'
guard "\$(sed -f - <<'EOF' ...) -> block (sed can exec)" 2 "$F" $'echo "$(sed -f - x <<\'EOF\'\ngit push origin master\nEOF\n)"'
guard "\$(\$RUN <<'EOF' ...) -> block (unprovable reader)" 2 "$F" $'echo "$($RUN <<\'EOF\'\ngit push origin master\nEOF\n)"'
# interpreter anywhere in a stage, find -exec, unprovable command words
guard "find . -exec sh -c '...' \\; -> block" 2 "$F" "find . -exec sh -c 'git push origin master' \\;"
guard "find . -execdir bash -c '...' \\; -> block" 2 "$F" "find . -execdir bash -c 'git push origin master' \\;"
guard "parallel bash ::: '...' -> block" 2 "$F" "parallel bash ::: 'git push origin master'"
guard "mycmd bash <<< '...' -> block" 2 "$F" "mycmd bash <<< 'git push origin master'"
guard "\$SHELL <<< '...' -> block" 2 "$F" "\$SHELL <<< 'git push origin master'"
guard "\${CMD} -c '...' -> block" 2 "$F" "\${CMD} -c 'git push origin master'"
guard "~/bin/run <<< '...' -> block" 2 "$F" "~/bin/run <<< 'git push origin master'"
guard "\"\$X\" '...' -> block" 2 "$F" "\"\$X\" 'git push origin master'"
guard "{ba,}sh <<< '...' (brace command word) -> block" 2 "$F" "{ba,}sh <<< 'git push origin master'"
guard "sudo \$SH <<< '...' (unprovable after a wrapper) -> block" 2 "$F" "sudo \$SH <<< 'git push origin master'"
guard "setsid bash <<< '...' -> block" 2 "$F" "setsid bash <<< 'git push origin master'"
guard "flock /tmp/l sh -c '...' -> block" 2 "$F" "flock /tmp/l sh -c 'git push origin master'"
guard "watch -n1 '...' -> block" 2 "$F" "watch -n1 'git push origin master'"
guard "builtin eval '...' -> block" 2 "$F" "builtin eval 'git push origin master'"
guard "coproc bash <<< '...' -> block" 2 "$F" "coproc bash <<< 'git push origin master'"
guard "case x in x) bash <<< '...';; esac -> block" 2 "$F" "case x in x) bash <<< 'git push origin master';; esac"
guard "x=\$(echo '...'); eval \"\$x\" -> block (variable indirection)" 2 "$F" "x=\$(echo 'git push origin master'); eval \"\$x\""
guard "x='...'; bash -c \"\$x\" -> block" 2 "$F" "x='git push origin master'; bash -c \"\$x\""
# non-executing commands stay data
guard "ls bash -> allow" 0 "$F" "ls bash"
guard "git commit -m 'use bash' -> allow" 0 "$F" "git commit -m 'use bash'"
guard "echo '...' | tee out.txt | wc -l -> allow" 0 "$F" "echo 'git push origin master' | tee out.txt | wc -l"
guard "git log --grep='...' -> allow" 0 "$F" "git log --grep='git push origin master'"
guard "git commit -m \"\$(cat <<'EOF' push EOF)\" -> allow" 0 "$F" $'git commit -m "$(cat <<\'EOF\'\ngit push origin master\nEOF\n)"'
guard "\$(grep x <<'EOF' push EOF) -> allow (data reader)" 0 "$F" $'echo "$(grep x <<\'EOF\'\ngit push origin master\nEOF\n)"'

# a non-executing command made to run something: >(...), program options, git -c
guard "tee >(bash) <<< '...' -> block" 2 "$F" "tee >(bash) <<< 'git push origin master'"
guard "echo '...' | tee >(sh) -> block" 2 "$F" "echo 'git push origin master' | tee >(sh)"
guard "sort --compress-program=bash <<< '...' -> block" 2 "$F" "sort --compress-program=bash <<< 'git push origin master'"
guard "sort --compress-program bash x <<< '...' -> block" 2 "$F" "sort --compress-program bash x <<< 'git push origin master'"
guard "cat < <(bash <<< '...') -> block (code <(...))" 2 "$F" "cat < <(bash <<< 'git push origin master')"
guard "\$(cat <<'EOF' > >(bash) ...) -> block (reader writes to a shell)" 2 "$F" $'echo "$(cat <<\'EOF\' > >(bash)\ngit push origin master\nEOF\n)"'
guard "\$(sort <<'EOF' ...) -> block (sort is no longer a reader)" 2 "$F" $'echo "$(sort <<\'EOF\'\ngit push origin master\nEOF\n)"'
guard "git -c alias.x='!git push origin master' x -> block" 2 "$F" "git -c alias.x='!git push origin master' x"
guard "git -c core.pager='sh -c \"...\"' log -> block" 2 "$F" "git -c core.pager='sh -c \"git push origin master\"' log"
guard "git -c user.email=x commit -m '...' -> allow (key runs nothing)" 0 "$F" "git -c user.email=x commit -m 'git push origin main later' && git push origin feat/work"
# wrappers that take a command string
guard "flock /tmp/l -c '...' -> block" 2 "$F" "flock /tmp/l -c 'git push origin master'"
guard "flock --command '...' /tmp/l -> block" 2 "$F" "flock --command 'git push origin master' /tmp/l"
guard "script -c '...' /dev/null -> block" 2 "$F" "script -c 'git push origin master' /dev/null"
guard "su -c '...' -> block" 2 "$F" "su -c 'git push origin master'"
guard "su -s /bin/sh -c '...' -> block" 2 "$F" "su -s /bin/sh -c 'git push origin master'"
guard "env -S 'bash -c \"...\"' -> block" 2 "$F" "env -S 'bash -c \"git push origin master\"'"
guard "env --split-string='...' -> block" 2 "$F" "env --split-string='git push origin master'"
# still data
guard "sort -u x | tee out.txt -> allow" 0 "$F" "sort -u x | tee out.txt"
guard "cat x | tee >(wc -l) > y -> allow" 0 "$F" "cat x | tee >(wc -l) > y"
guard "script -q /dev/null -> allow" 0 "$F" "script -q /dev/null; git push origin feat/work"
guard "env -i PATH=/usr/bin git status -> allow" 0 "$F" "env -i PATH=/usr/bin git status; git push origin feat/work"
guard "flock /tmp/l git fetch -> allow" 0 "$F" "flock /tmp/l git fetch && git push origin feat/work"
guard "git commit -m \"\$(sort x | head -1)\" -> allow" 0 "$F" 'git commit -m "$(sort x | head -1)" && git push origin feat/work'
guard "git commit -F <(printf '...') + feature push -> allow" 0 "$F" "git commit -F <(printf 'git push origin master') && git push origin feat/work"

# C: brace expansion and tilde
guard "git push origin {main,x} -> block" 2 "$F" 'git push origin {main,x}'
guard "git push origin feat/{a,b} -> block (unprovable, deliberate)" 2 "$F" 'git push origin feat/{a,b}'
guard "git push origin HEAD~1:feat/work -> allow (~ in the source)" 0 "$F" 'git push origin HEAD~1:feat/work'
guard "git push origin x:~main -> block (~ starts the destination)" 2 "$F" 'git push origin x:~main'

# D1: git -c / --config-env / GIT_CONFIG_* (feature branch: a plain bare push is allowed)
guard "git -c remote.origin.push=...:main push origin -> block" 2 "$F" 'git -c remote.origin.push=refs/heads/feat/work:refs/heads/main push origin'
guard "git -c push.default=upstream push -> block" 2 "$F" 'git -c push.default=upstream push'
guard "git --config-env=push.default=PD push origin -> block" 2 "$F" 'git --config-env=push.default=PD push origin'
guard "git --config-env push.default=PD push -> block" 2 "$F" 'git --config-env push.default=PD push'
guard "GIT_CONFIG_PARAMETERS=... git push -> block" 2 "$F" "GIT_CONFIG_PARAMETERS=\"'push.default=upstream'\" git push"
guard "export GIT_CONFIG_COUNT=...; git push origin feat/work -> block" 2 "$F" 'export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.mirror GIT_CONFIG_VALUE_0=true; git push origin feat/work'
guard "git -c user.email=x push origin feat/work -> allow" 0 "$F" 'git -c user.email=x push origin feat/work'
guard "git -c push.default=simple push origin feat/work -> allow (refspec wins)" 0 "$F" 'git -c push.default=simple push origin feat/work'
guard "git -c remote.origin.mirror=true push origin feat/work -> block" 2 "$F" 'git -c remote.origin.mirror=true push origin feat/work'
guard "git -c Branch.feat/work.pushRemote=x push origin feat/work -> block (case-insensitive)" 2 "$F" 'git -c Branch.feat/work.pushRemote=x push origin feat/work'
guard "git -c remote.origin.push=... push --dry-run -> allow" 0 "$F" 'git -c remote.origin.push=refs/heads/feat/work:refs/heads/main push --dry-run origin'
guard "GIT_CONFIG_PARAMETERS=... bash -c 'git push' -> block (env reaches nested scan)" 2 "$F" "GIT_CONFIG_PARAMETERS=\"'push.default=upstream'\" bash -c 'git push'"
guard "GIT_CONFIG_PARAMETERS=... sh -c 'git push origin' -> block" 2 "$F" "GIT_CONFIG_PARAMETERS=\"'remote.origin.push=refs/heads/x:refs/heads/main'\" sh -c 'git push origin'"
guard "FOO=bar bash -c 'git push origin feat/work' -> allow" 0 "$F" "FOO=bar bash -c 'git push origin feat/work'"

# nested-payload cap: past 100 unscanned payloads the guard fails closed
subs() { local k=0 out=""; while [ "$k" -lt "$1" ]; do out="$out \$(a)"; k=$((k + 1)); done; printf '%s' "$out"; }
guard "101 substitutions (git...push in the text) -> fail closed" 2 "$F" "echo legitimate push$(subs 101)"
guard "99 substitutions, no git push -> allow" 0 "$F" "echo legitimate push$(subs 99)"

# D2: a bare push resolves the repo's own config
P=$TMP/r-cfg-push; mk_repo "$P" feat/work; state_active "$P"
git -C "$P" config remote.origin.push refs/heads/feat/work:refs/heads/main
guard "repo remote.origin.push + bare git push -> block" 2 "$P" "git push"
guard "repo remote.origin.push + bare git push --dry-run -> allow" 0 "$P" "git push --dry-run"
guard "repo remote.origin.push + explicit feature refspec -> allow" 0 "$P" "git push origin feat/work"
P=$TMP/r-cfg-pushremote; mk_repo "$P" feat/work; state_active "$P"
git -C "$P" config branch.feat/work.pushRemote fork; git -C "$P" config remote.fork.push refs/heads/feat/work:refs/heads/main
guard "branch pushRemote=fork with remote.fork.push + bare push -> block" 2 "$P" "git push"
guard "same repo, explicit remote origin (no push config) -> allow" 0 "$P" "git push origin"
P=$TMP/r-cfg-up; mk_repo "$P" feat/work; state_active "$P"
git -C "$P" config push.default upstream; git -C "$P" config branch.feat/work.remote origin
guard "push.default=upstream, merge unset -> block" 2 "$P" "git push"
git -C "$P" config branch.feat/work.merge refs/heads/main
guard "push.default=upstream, branch merges main -> block" 2 "$P" "git push"
git -C "$P" config branch.feat/work.merge refs/heads/feat/work
guard "push.default=upstream, branch merges feat/work -> allow" 0 "$P" "git push"
git -C "$P" config push.default matching
guard "push.default=matching + bare push -> block" 2 "$P" "git push"
git -C "$P" config push.default simple
guard "push.default=simple + bare push on feature branch -> allow" 0 "$P" "git push"

# hook cwd decides the repo: subdirectory, worktree, no repo at all
mkdir -p "$R/pkg/deep"
run_hook require-pr-on-blocker.sh "$R/pkg/deep" "$(payload "git push origin main" "$R/pkg/deep")"
if [ "$RC" = 2 ]; then ok "hook cwd in a subdirectory finds the repo root -> block"; else bad "hook cwd in a subdirectory finds the repo root -> block" "got $RC"; fi
W=$TMP/r-wt-main; mk_repo "$W" main; state_active "$W"
( cd "$W" && git add -A && git commit -q -m state && git worktree add -q -b feat/wt "$TMP/wt-feature" ) >/dev/null 2>&1
guard "worktree uses its own checked-out STATE.md -> block" 2 "$TMP/wt-feature" "git push origin main"
state_resolved8 "$TMP/wt-feature"
guard "worktree with its own RESOLVED -> allow" 0 "$TMP/wt-feature" "git push origin main"
guard "main checkout is still blocked -> block" 2 "$W" "git push origin main"
N=$TMP/not-a-repo; mkdir -p "$N"; state_active "$N"
guard "outside any repo, state file in cwd is honored -> block" 2 "$N" "git push origin main"
guard "outside any repo, feature push -> allow" 0 "$N" "git push origin feat/x"

# blocker parsing
X=$TMP/r-x; mk_repo "$X" main
guard "no STATE.md -> allow" 0 "$X" "git push origin main"
state_resolved8 "$X"
guard "RESOLVED 8 lines below the bullet -> allow" 0 "$X" "git push origin main"
put "$X/.planning/STATE.md" <<'EOF'
## Current focus

There is a push blocker mentioned here: do NOT git push origin master.

### Blockers/Concerns

- None right now.

### Decisions

- Old push blocker from last year, do NOT git push.
EOF
guard "blocker text outside the Blockers section -> allow" 0 "$X" "git push origin main"
put "$X/.planning/STATE.md" <<'EOF'
# State

### Blockers/Concerns

- First push blocker (2026-01-01): hold.
  RESOLVED: 2026-01-02 — done.

- Second push blocker (2026-02-01): hold again.
  Progress: nothing yet.
EOF
guard "first bullet resolved, second active -> block" 2 "$X" "git push origin main"
stderr_has "message names the SECOND bullet" "Second push blocker"
stderr_lacks "message does not name the resolved bullet" "First push blocker"
put "$X/.planning/STATE.md" <<'EOF'
### Blockers/Concerns

- First push blocker: still open.
  Progress: waiting.

- Second push blocker: closed.
  RESOLVED: 2026-02-02 — done.
EOF
guard "RESOLVED in the NEXT bullet does not clear the first -> block" 2 "$X" "git push origin main"
stderr_has "message names the FIRST bullet" "First push blocker"
put "$X/.planning/STATE.md" <<'EOF'
### Blockers/Concerns

- Hold pushes (push blocker) until the DB migration lands.
  - RESOLVED: 2026-03-03 — migration applied.
EOF
guard "RESOLVED in a nested sub-bullet clears its bullet -> allow" 0 "$X" "git push origin main"
put "$X/.planning/STATE.md" <<'EOF'
### Blockers/Concerns

- Hold pushes (push blocker) until the DB migration lands.
  **RESOLVED:** 2026-03-03 — migration applied.
EOF
guard "bold **RESOLVED:** clears the blocker -> allow" 0 "$X" "git push origin main"
put "$X/.planning/STATE.md" <<'EOF'
### Blockers/Concerns

- Hold pushes (push blocker) until the DB migration lands.
  Not RESOLVED: yet, the word is mid-line.
  resolved: lowercase does not count either.
EOF
guard "mid-line / lowercase 'resolved:' does not clear -> block" 2 "$X" "git push origin main"
put "$X/.planning/STATE.md" <<'EOF'
### Blockers/Concerns

```bash
# looks like a heading but sits in a code fence
echo hi
```

- The Push Blocker is real.
EOF
guard "# line inside a code fence does not end the section -> block" 2 "$X" "git push origin main"
put "$X/.planning/STATE.md" <<'EOF'
### Blockers/Concerns

#### Details

- DO NOT GIT PUSH ORIGIN MASTER until reviewed.
EOF
guard "case-insensitive token + deeper sub-heading stays in section -> block" 2 "$X" "git push origin main"
put "$X/.planning/STATE.md" <<'EOF'
### Blockers/Concerns (open items)

- push blocker: heading has a suffix.
EOF
guard "heading with a suffix still matches -> block" 2 "$X" "git push origin main"
put "$X/.planning/STATE.md" <<'EOF'
### Blockers/Concerns

- Fine for now.

## Next steps

- A push blocker mentioned under a higher-level heading.
EOF
guard "higher-level heading ends the section -> allow" 0 "$X" "git push origin main"
printf '### Blockers/Concerns\r\n\r\n- Windows push blocker\r\n  continued\r\n' > "$X/.planning/STATE.md"
guard "CRLF file, active blocker, no trailing newline issue -> block" 2 "$X" "git push origin main"
printf '### Blockers/Concerns\n\n- Windows push blocker\n  RESOLVED: 2026-01-01 — ok' > "$X/.planning/STATE.md"
guard "section runs to EOF without trailing newline -> allow" 0 "$X" "git push origin main"
put "$X/.planning/STATE.md" <<'EOF'
### Blockers/Concerns

- Prose that mentions a push blocker only after a blank line is not part of the bullet.

RESOLVED: 2026-01-01 — stray unindented line after a blank line, not part of the bullet.
EOF
guard "RESOLVED in a later unindented paragraph does not clear -> block" 2 "$X" "git push origin main"
long=$(printf '%0260d' 0 | tr 0 x)
put "$X/.planning/STATE.md" <<EOF
### Blockers/Concerns

- push blocker $long END_OF_LONG_LINE
EOF
guard "very long blocker -> block" 2 "$X" "git push origin main"
stderr_has "long blocker is truncated with an ellipsis" "..."
stderr_lacks "tail of the long blocker is cut" "END_OF_LONG_LINE"

# config file
C=$TMP/r-cfg; mk_repo "$C" main; state_active "$C"
put "$C/.claude/guard-push.json" <<'EOF'
{"protectedBranches": ["trunk"]}
EOF
guard "config protectedBranches [trunk]: push main -> allow" 0 "$C" "git push origin main"
guard "config protectedBranches [trunk]: push trunk -> block" 2 "$C" "git push origin trunk"
put "$C/.claude/guard-push.json" <<'EOF'
{"protectedBranches": ["release/*", "main"]}
EOF
guard "glob protected branch release/* matches release/1.2 -> block" 2 "$C" "git push origin release/1.2"
guard "glob release/* does not match 'release' -> allow" 0 "$C" "git push origin release"
put "$C/.claude/guard-push.json" <<'EOF'
{"protectedBranches": []}
EOF
guard "config protects nothing -> allow" 0 "$C" "git push origin main"
put "$C/.claude/guard-push.json" <<'EOF'
{ this is not json
EOF
guard "invalid config -> fail closed on any git push" 2 "$C" "git push origin feat/x"
stderr_has "invalid config message names the file" "guard-push.json"
guard "invalid config does not touch non-push commands" 0 "$C" "ls -la"
put "$C/.claude/guard-push.json" <<'EOF'
{"protectedBranches": ["main"], "stateFile": "docs/STATE.md", "blockerSection": "## Freeze", "tokens": ["FREEZE"]}
EOF
put "$C/docs/STATE.md" <<'EOF'
# Docs state

## Freeze

- Code freeze until Friday.
EOF
guard "custom stateFile + section + token -> block" 2 "$C" "git push origin main"
put "$C/docs/STATE.md" <<'EOF'
## Freeze

- Code freeze until Friday.
  RESOLVED: 2026-05-05 — freeze lifted.
EOF
guard "custom stateFile, RESOLVED -> allow" 0 "$C" "git push origin main"
put "$C/.claude/guard-push.json" <<'EOF'
{"protectedBranches": ["main"], "tokens": []}
EOF
guard "empty token list -> nothing is a blocker -> allow" 0 "$C" "git push origin main"

# malformed hook input
guard_raw "garbage stdin without 'push' -> allow" 0 "$R" "not json at all"
guard_raw "garbage stdin that looks like git push -> fail closed" 2 "$R" "git push origin main (not json)"
guard_raw "empty stdin -> allow" 0 "$R" ""

# parser availability: jq missing (python3 fallback), both missing, broken awk
PY_TOOLS="$BASE_TOOLS python3"
SHIM_NOJQ=$(mk_shim nojq $PY_TOOLS)
SHIM_NONE=$(mk_shim none $BASE_TOOLS)
if [ -x "$SHIM_NOJQ/python3" ]; then
  guard "no jq (python3 fallback): push main -> block" 2 "$R" "git push origin main" /usr/bin/env PATH="$SHIM_NOJQ"
  guard "no jq (python3 fallback): push feature -> allow" 0 "$R" "git push origin feat/work" /usr/bin/env PATH="$SHIM_NOJQ"
  guard "no jq (python3 fallback): non-push -> allow" 0 "$R" "ls" /usr/bin/env PATH="$SHIM_NOJQ"
  guard "no jq (python3 fallback): config file is read (tokens [] -> allow)" 0 "$C" "git push origin main" /usr/bin/env PATH="$SHIM_NOJQ"
  put "$C/.claude/guard-push.json" <<'EOF'
{"protectedBranches": ["trunk"]}
EOF
  guard "no jq (python3 fallback): config override trunk -> block" 2 "$C" "git push origin trunk" /usr/bin/env PATH="$SHIM_NOJQ"
  guard "no jq (python3 fallback): unicode command, push main -> block" 2 "$R" 'git commit -m "résumé — café" && git push origin main' /usr/bin/env PATH="$SHIM_NOJQ"
else
  bad "python3 shim could not be built; jq-less case not exercised"
fi
guard "no jq and no python3: git push -> fail closed" 2 "$R" "git push origin feat/work" /usr/bin/env PATH="$SHIM_NONE"
stderr_has "no parser message says what to install" "neither jq nor python3"
guard "no jq and no python3: non-push command -> allow" 0 "$R" "ls -la" /usr/bin/env PATH="$SHIM_NONE"
guard "no jq and no python3: 'push' without git -> allow" 0 "$R" "npm run push-assets" /usr/bin/env PATH="$SHIM_NONE"

SHIM_AWK=$(mk_shim badawk $BASE_TOOLS python3 jq)
rm -f "$SHIM_AWK/awk"; printf '#!/bin/sh\nexit 1\n' > "$SHIM_AWK/awk"; chmod +x "$SHIM_AWK/awk"
guard "awk broken: git push -> fail closed" 2 "$R" "git push origin feat/work" /usr/bin/env PATH="$SHIM_AWK"
guard "awk broken: non-push -> allow" 0 "$R" "ls -la" /usr/bin/env PATH="$SHIM_AWK"

# SIGTERM mid-evaluation (timeout kill) must fail closed, not open
SHIM_TERM=$(mk_shim term $BASE_TOOLS python3 jq)
rm -f "$SHIM_TERM/git"
printf '#!/bin/sh\nkill -TERM "$(cat "$PIDF")"\nsleep 1\nexit 0\n' > "$SHIM_TERM/git"; chmod +x "$SHIM_TERM/git"
( cd "$R" && printf '%s' "$(payload "git push origin feat/work" "$R")" \
  | PIDF="$TMP/hookpid" PATH="$SHIM_TERM" /bin/sh -c 'echo $$ > "$PIDF"; exec "$0" "$1"' "$SH" "$HERE/require-pr-on-blocker.sh" ) >/dev/null 2>"$TMP/stderr"
RC=$?; STDERR=$(cat "$TMP/stderr")
if [ "$RC" = 2 ]; then ok "SIGTERM while evaluating a git push -> exit 2 (fail closed)"; else bad "SIGTERM while evaluating a git push -> exit 2 (fail closed)" "got $RC: ${STDERR:0:160}"; fi

# self-check of the payload helper (so a wrong escape cannot hide a failure)
if command -v python3 >/dev/null 2>&1; then
  got=$(payload $'say "hi"\\n\tgit push' "/x y" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["tool_input"]["command"] == "say \"hi\"\\n\tgit push" and d["cwd"] == "/x y")')
  if [ "$got" = True ]; then ok "test helper: payload() round-trips quotes, backslashes, newlines"; else bad "test helper: payload() round-trips quotes, backslashes, newlines" "got $got"; fi
else
  ok "test helper: payload() round-trip check skipped (no python3)"
fi

# ======================================================== restore-state.sh ==
echo "== restore-state"
S=$TMP/r-restore; mk_repo "$S" main
put "$S/.planning/STATE.md" <<'EOF'
# Project State

## Overview

Not this section.

## Current focus

Ship the billing rewrite.

```bash
## this is inside a code fence and must not end the section
echo hi
```

### Next action

- Finish the webhook handler.

## After this

NOT-IN-OUTPUT
EOF
run_hook restore-state.sh "$S" "$(session_payload compact "$S")"
first=${STDOUT%%$'\n'*}
if [ "$RC" = 0 ] && [ "$first" = "Restored after compaction from .planning/STATE.md (Current focus):" ]; then ok "compact: first line is the header, exit 0"; else bad "compact: first line is the header, exit 0" "rc=$RC first=[$first]"; fi
case $STDOUT in *"## Current focus"*"Ship the billing rewrite."*"Finish the webhook handler."*) ok "compact: prints the section (heading, body, sub-heading, fence)" ;; *) bad "compact: prints the section" "$STDOUT" ;; esac
case $STDOUT in *"inside a code fence"*) ok "compact: '## ' inside a code fence does not end the section" ;; *) bad "compact: '## ' inside a code fence does not end the section" "$STDOUT" ;; esac
case $STDOUT in *"NOT-IN-OUTPUT"*|*"Not this section"*) bad "compact: other sections excluded" "$STDOUT" ;; *) ok "compact: other sections excluded" ;; esac
for src in startup resume clear; do
  run_hook restore-state.sh "$S" "$(session_payload $src "$S")"
  if [ "$RC" = 0 ] && [ -z "$STDOUT" ]; then ok "source=$src prints nothing, exit 0"; else bad "source=$src prints nothing, exit 0" "rc=$RC out=[$STDOUT]"; fi
done
run_hook restore-state.sh "$S" '{"hook_event_name":"SessionStart"}'
if [ "$RC" = 0 ] && [ -z "$STDOUT" ]; then ok "no source field prints nothing"; else bad "no source field prints nothing" "rc=$RC out=[$STDOUT]"; fi
run_hook restore-state.sh "$S" 'garbage'
if [ "$RC" = 0 ] && [ -z "$STDOUT" ]; then ok "garbage stdin: nothing, exit 0"; else bad "garbage stdin: nothing, exit 0" "rc=$RC out=[$STDOUT]"; fi
run_hook restore-state.sh "$S" ''
if [ "$RC" = 0 ] && [ -z "$STDOUT" ]; then ok "empty stdin: nothing, exit 0"; else bad "empty stdin: nothing, exit 0" "rc=$RC out=[$STDOUT]"; fi
M=$TMP/r-nostate; mk_repo "$M" main
run_hook restore-state.sh "$M" "$(session_payload compact "$M")"
if [ "$RC" = 0 ] && [ -z "$STDOUT" ]; then ok "missing STATE.md: nothing, exit 0"; else bad "missing STATE.md: nothing, exit 0" "rc=$RC out=[$STDOUT]"; fi
put "$M/.planning/STATE.md" <<'EOF'
# State

## Something else

text
EOF
run_hook restore-state.sh "$M" "$(session_payload compact "$M")"
if [ "$RC" = 0 ] && [ -z "$STDOUT" ]; then ok "STATE.md without a Current focus section: nothing, exit 0"; else bad "STATE.md without a Current focus section: nothing, exit 0" "rc=$RC out=[$STDOUT]"; fi
put "$M/.planning/STATE.md" <<'EOF'
## Current Focus

Capitalised heading works.
EOF
run_hook restore-state.sh "$M" "$(session_payload compact "$M")"
case $STDOUT in *"Capitalised heading works."*) ok "heading match is case-insensitive" ;; *) bad "heading match is case-insensitive" "rc=$RC out=[$STDOUT]" ;; esac
{ printf '## Current focus\n\n'; i=0; while [ $i -lt 400 ]; do i=$((i + 1)); printf 'line %s — ünïcode 日本語 filler filler filler\n' "$i"; done; printf '\n## Next\n\nafter\n'; } > "$M/.planning/STATE.md"
run_hook restore-state.sh "$M" "$(session_payload compact "$M")"
bytes=$(printf '%s\n' "$STDOUT" | wc -c | tr -d ' ')
if [ "$RC" = 0 ] && [ "$bytes" -le 4000 ] && [ "$bytes" -gt 3000 ]; then ok "oversized section: output is $bytes bytes (<= 4000)"; else bad "oversized section: output <= 4000" "rc=$RC bytes=$bytes"; fi
case $STDOUT in *"[truncated]") ok "oversized section: ends with a truncation marker" ;; *) bad "oversized section: ends with a truncation marker" "tail=[${STDOUT: -40}]" ;; esac
if printf '%s' "$STDOUT" | iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1; then ok "oversized section: output is still valid UTF-8"; else bad "oversized section: output is still valid UTF-8"; fi
first=${STDOUT%%$'\n'*}
if [ "$first" = "Restored after compaction from .planning/STATE.md (Current focus):" ]; then ok "oversized section: header line kept"; else bad "oversized section: header line kept" "[$first]"; fi
if [ -x "$SHIM_NONE/sed" ]; then
  run_hook restore-state.sh "$S" "$(session_payload compact "$S")" /usr/bin/env PATH="$SHIM_NONE"
  case $STDOUT in "Restored after compaction"*) ok "no jq/python3: sed fallback still reads source=compact" ;; *) bad "no jq/python3: sed fallback reads source" "rc=$RC out=[$STDOUT]" ;; esac
fi
sub=$S/pkg; mkdir -p "$sub"
run_hook restore-state.sh "$sub" "$(session_payload compact "$sub")"
case $STDOUT in "Restored after compaction"*) ok "run from a subdirectory: finds the repo root" ;; *) bad "run from a subdirectory: finds the repo root" "[$STDOUT]" ;; esac

# ========================================================== bearings-check ==
echo "== bearings-check / bearings-stamp"
B=$TMP/r-bearings; mk_repo "$B" main
mkdir -p "$B/src" "$B/.claude"
echo "x" > "$B/src/a.txt"
printf '# Map\n\nWhere things live.\n' > "$B/RECONSTRUCTION.md"
printf '{"map":"RECONSTRUCTION.md","codebaseDir":".planning/codebase","scopedPaths":["src"],"maxDays":30,"maxCommits":150}\n' > "$B/.claude/bearings.json"
( cd "$B" && git add -A && git commit -q -m code ) >/dev/null 2>&1
out=$(cd "$B" && "$SH" "$HERE/bearings-stamp.sh" 2>&1); rc=$?
case $out in "stamped RECONSTRUCTION.md @ "*) if [ $rc = 0 ]; then ok "bearings-stamp.sh stamps the map with HEAD"; else bad "bearings-stamp.sh exit code" "rc=$rc"; fi ;; *) bad "bearings-stamp.sh stamps the map" "rc=$rc out=$out" ;; esac
head_sha=$(cd "$B" && git rev-parse HEAD)
if grep -q "bearings-sha: $head_sha" "$B/RECONSTRUCTION.md"; then ok "stamp holds the full HEAD sha"; else bad "stamp holds the full HEAD sha"; fi
run_hook bearings-check.sh "$B" "$(session_payload startup "$B")"
case $STDOUT in *"Orientation:"*) if [ $RC = 0 ]; then ok "bearings-check: exit 0 and prints 'Orientation:'"; else bad "bearings-check exit code" "rc=$RC"; fi ;; *) bad "bearings-check prints Orientation:" "rc=$RC out=[$STDOUT]" ;; esac
case $STDOUT in *"current"*) ok "bearings-check: freshly stamped map is 'current'" ;; *) bad "bearings-check: freshly stamped map is 'current'" "[$STDOUT]" ;; esac
printf '# Map\n<!-- bearings-sha: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef -->\n<!-- bearings-date: %s -->\n' "$(date +%F)" > "$B/RECONSTRUCTION.md"
run_hook bearings-check.sh "$B" "$(session_payload startup "$B")"
case $STDOUT in *"unreachable"*) if [ $RC = 0 ]; then ok "bearings-check: bogus sha -> says 'unreachable', exit 0"; else bad "bearings-check bogus sha exit code" "rc=$RC"; fi ;; *) bad "bearings-check: bogus sha -> 'unreachable'" "rc=$RC out=[$STDOUT]" ;; esac
printf '# Map\n' > "$B/RECONSTRUCTION.md"
run_hook bearings-check.sh "$B" "$(session_payload startup "$B")"
case $STDOUT in *"UNSTAMPED"*) ok "bearings-check: unstamped map is reported" ;; *) bad "bearings-check: unstamped map is reported" "out=[$STDOUT]" ;; esac
rm -f "$B/.claude/bearings.json"
run_hook bearings-check.sh "$B" "$(session_payload startup "$B")"
if [ "$RC" = 0 ] && [ -z "$STDOUT" ]; then ok "bearings-check: no bearings.json -> silent, exit 0"; else bad "bearings-check: no bearings.json -> silent, exit 0" "rc=$RC out=[$STDOUT]"; fi

# ================================================================= summary ==
echo
echo "== summary: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
