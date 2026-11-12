#!/usr/bin/env bash
# require-pr-on-blocker.sh — PreToolUse (matcher: Bash) push guard.
#
# Blocks a `git push` to a protected branch while the state file (default
# .planning/STATE.md) lists an UNRESOLVED push blocker. Pushes to any other
# branch pass. Exit 2 = block (stderr is shown to Claude); exit 0 = allow.
#
# Config: <repo>/.claude/guard-push.json (every key optional)
#   protectedBranches  default ["main","master","production"]  (shell globs OK: "release/*")
#   stateFile          default ".planning/STATE.md"
#   blockerSection     default "### Blockers/Concerns"
#   tokens             default ["push blocker","do NOT git push"]   (case-insensitive)
#
# Blocker rule: inside the section (heading -> next heading of same or higher
# level, fenced code ignored) a blocker is a TOP-LEVEL bullet ("- " at column 0)
# whose block (the bullet plus its indented continuation lines) contains a
# token. It is resolved when any line of THAT bullet's block starts with
# "RESOLVED:" (optionally after "- " / "**"). Active = blocker and not resolved.
# The push is refused only when some git push in the command is a HIT (below,
# including every "cannot be proven safe" case) AND a blocker is active; with no
# active blocker every push passes, unprovable or not.
#
# Push detection (text based, no shell is run): finds `git push` after leading
# separators, wrappers (`command`, `rtk`, `sudo`, `time`, env assignments), an
# absolute /usr/bin/git, and git's global options (`-c k=v`, `-C dir`,
# `--no-pager`). Quoted text is data (a commit message that mentions
# "git push origin main" is not a push); `$'...'` / `$"..."` are quotes too. The
# body of every `$(...)`, backtick and `<(...)` is scanned as code, also inside
# "..."; a heredoc inside one is data only when a data-only reader reads it
# (cat head tail wc uniq grep egrep fgrep cut tr fold fmt nl base64 jq) whose
# stage runs nothing (see stage_execs below) and its pipeline is not code, so the usual `git commit -m "$(cat <<'EOF' ...
# EOF)"` message stays data while `$(./x <<'EOF' ...)` or `$(sed ... <<EOF)` is
# scanned as code. A
# substitution stands in its word as one opaque `$`, so it cannot shift the
# positionals. Remote = first positional; every later
# positional is a refspec and its DESTINATION (after ":") is compared with the
# protected list. A remote or refspec holding `$`, a backtick, `{`, a glob, or a
# refspec starting with `~` cannot be proven safe and counts as a hit, by
# design even for `git push $(echo origin) feat/work`. --all/--mirror count.
# A push with no refspec ("git push", "git push origin") resolves the repo's
# config the way git does: remote.<r>.push / remote.<r>.mirror set -> hit;
# push.default matching -> hit; upstream/tracking -> branch.<cur>.merge decides
# (unset -> hit); simple/current/unset -> the CURRENT branch decides; detached
# HEAD -> hit. `git -c` / `--config-env` with a push.* key makes a bare push a
# hit; with a remote.* / branch.* key, or any GIT_CONFIG*= assignment in the
# command, every push is a hit. --dry-run and --tags-only pass.
#
# Code pipelines: a pipeline (stages joined by | or |&, cut only by ; && || &
# and newline; parens and redirections such as 2>&1 are transparent) is CODE
# when, in some stage, after VAR=val, redirections and shell keywords (if, case
# ... in PATTERN), builtin, coproc, function, select, time...):
#   - the command word holds `$`, a backtick, `~` or `{...}` (unprovable), or
#   - the command word is a non-executing command (the readers above plus sort
#     tee echo printf git gh ls test [ true false) that is made to run
#     something: an output process substitution `>(...)` or `>$(...)`, an
#     input `<(...)` whose body runs code, a program-naming option
#     (--compress-program, --use-compress-program, --program, --exec), or a
#     `git -c` key that runs a program (alias.*, *.command, core.pager...), or
#   - the command word is anything else and ANY word of the stage is eval,
#     source, ".", an interpreter (sh bash zsh ... su python node perl ruby php
#     lua watch parallel), or find's -exec/-execdir/-ok/-okdir, or
#   - the command word is a wrapper (env command exec nice nohup timeout sudo
#     doas busybox stdbuf time xargs setsid flock chroot unbuffer script watch
#     parallel caffeinate ionice chrt taskset) followed by an unprovable word
#     or a command-string option (-c, --command, -S, --split-string).
# Then every quoted string, -c payload, here-string, heredoc body and
# process/command substitution in that pipeline is scanned as code, at any
# depth: `echo '...' | bash`, `bash <<< '...'`, `bash < <(...)`, `source <(...)`,
# `find . -exec sh -c '...'`, `$SHELL <<< '...'`. If a code pipeline also
# expands a variable or substitution (`x=$(...); eval "$x"`), the WHOLE command
# is scanned as code. A GIT_CONFIG*= assignment anywhere (also before
# `bash -c '...'`) makes every push in the command a hit.
#
# Known gaps (text parsing, not a shell): text that reaches a shell outside the
# command (a temp file then `bash f`, `curl ... | sh`, a variable exported in an
# EARLIER command and eval'd now) is not seen; a word split
# hidden in an OPTION value (`-o $X`, `--repo=$(...)`) is not seen; `$'\x67it'`
# escapes are not decoded (the fast path needs a literal "git"); a `case`
# pattern ")" inside `$(...)` can end it early; a top-level heredoc body is
# scanned as commands (false positives, never misses).
#
# Failure policy: not a push -> always exit 0, even if this script breaks. Looks
# like a push -> any internal error (no jq/python3, bad config, awk failure,
# crash, SIGTERM) exits 2. Portable to bash 3.2 (macOS) and Linux.

set -u

IN_PLAY=0   # 1 once the input looks like a git push: undecided exits become 2
DECIDED=0   # 1 once allow/deny made a deliberate decision

# shellcheck disable=SC2329  # invoked through the EXIT trap
on_exit() {
  local rc=$?
  [ "$DECIDED" = 1 ] && return
  if [ "$IN_PLAY" = 1 ]; then
    printf '%s\n' "BLOCKED: the push guard hit an internal error (exit $rc) while checking a git push and refuses to guess. Retry; if it persists, run the hook by hand: echo '{...}' | bash .claude/hooks/require-pr-on-blocker.sh" >&2
    exit 2
  fi
  exit 0
}
trap on_exit EXIT
trap 'exit 143' HUP INT TERM

allow() { DECIDED=1; exit 0; }
deny() { DECIDED=1; printf '%s\n' "$1" >&2; exit 2; }
fail_closed() {
  deny "BLOCKED: the push guard could not evaluate this git push ($1), so it is refusing it.
Fix the cause (guard config: .claude/guard-push.json; needs jq or python3, plus awk, grep, sed, tr) and retry."
}

# ---------------------------------------------------------------- read input
INPUT=$(cat) || INPUT=""
# Fast path: nothing without the word "push" can be a git push.
case $INPUT in *push*) ;; *) allow ;; esac

LOOSE_RE='(^|[^[:alnum:]_-])git([^[:alnum:]_-].*)?[^[:alnum:]_-]push([^[:alnum:]_-]|$)'
if printf '%s' "$INPUT" | tr '\n' ' ' | sed -e 's/\\[nrt]/ /g' | grep -Eq "$LOOSE_RE"; then
  IN_PLAY=1
fi

PARSER=""
if command -v jq >/dev/null 2>&1 && jq -n 1 >/dev/null 2>&1; then
  PARSER=jq
elif command -v python3 >/dev/null 2>&1 && python3 -I -c 'import json' >/dev/null 2>&1; then
  PARSER=python3
fi
if [ -z "$PARSER" ]; then
  [ "$IN_PLAY" = 1 ] && fail_closed "neither jq nor python3 is installed, so the hook input cannot be parsed"
  allow
fi

IFS= read -r -d '' PY_GET <<'PY'
import json, sys
d = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace"))
for k in sys.argv[1].split("."):
    d = d.get(k) if isinstance(d, dict) else None
if isinstance(d, str):
    sys.stdout.buffer.write(d.encode("utf-8", "replace"))
PY

# json_get <dotted.path> : prints the string at that path of $INPUT (empty if absent)
json_get() {
  if [ "$PARSER" = jq ]; then
    printf '%s' "$INPUT" | jq -r --arg p "$1" '(try getpath($p | split(".")) catch null) | select(type == "string")'
  else
    printf '%s' "$INPUT" | python3 -I -c "$PY_GET" "$1"
  fi
}

TOOL=""; COMMAND=""; CWD_IN=""
if ! TOOL=$(json_get tool_name) || ! COMMAND=$(json_get tool_input.command) || ! CWD_IN=$(json_get cwd); then
  [ "$IN_PLAY" = 1 ] && fail_closed "the hook input is not valid JSON"
  allow
fi
if [ -n "$TOOL" ] && [ "$TOOL" != "Bash" ]; then allow; fi
[ -n "$COMMAND" ] || allow
case $COMMAND in *git*push*) ;; *) allow ;; esac

# ------------------------------------------------- find `git push` in command
# Three scan modes. Mode a (the command) and mode s (a substitution body) are
# quote-aware: quoted text is DATA, so a commit message, PR body or echo that
# merely mentions "git push origin main" is not a push, and a quoted argument
# with spaces stays one token ("git -C 'my dir' push origin main"). Mode b
# dissolves every quote: all of its text is CODE.
# A "code pipeline" is a pipeline (stages joined by | or |&; cut only by ; && ||
# & and newline; parens and redirections are transparent) in which some stage's
# command word, after VAR=val, redirections and the wrappers env, command, exec,
# nice, nohup, timeout, sudo, doas, busybox, stdbuf, time and xargs, is eval,
# source, ".", or an interpreter (is_interp). Its whole raw text, plus its
# heredoc bodies, comes back as an "N" line and is scanned in mode b, so every
# quoted string, here-string, heredoc, -c payload and substitution in it is
# code, at any depth. The body of every $(...), backtick and <(...) / >(...)
# comes back as an "S" line (scanned in mode s). In mode s a heredoc body is
# data unless its pipeline is code (an unquoted-delimiter body still has its
# substitutions scanned); in mode a it is scanned as commands (known limit).
# A GIT_CONFIG*= assignment prints a "G" line. Newlines in a payload travel as
# \003. Output: one tab-separated record per `git push`:
#   dry all repo cfg positional...   (cfg: 0 none, 1 push.* via -c, 2 remote.*/branch.*/GIT_CONFIG*)
IFS= read -r -d '' AWK_PUSH <<'AWK'
function prot(c) {
  if (c == " " || c == "\t" || c == "\r") return "\001"
  if (c == ";" || c == "&" || c == "|" || c == "(" || c == ")" || c == "`") return "\002"
  if (c == "\n") return "\003"
  return c
}
function enc(x) { gsub("\n", "\003", x); return x }
function emit(body, kind) { if (body ~ /[^ \t\n]/) print kind "\t" enc(body) }
# hd_find: heredoc body starts at p; returns the index of the last character of
# the delimiter line (HD_LS = where that line starts), or 0 when there is none.
function hd_find(s, p, n, delim, strip,   e, line, rest) {
  while (p <= n) {
    rest = substr(s, p); e = index(rest, "\n")
    if (e == 0) { line = rest; e = n + 1 } else { line = substr(rest, 1, e - 1); e = p + e - 1 }
    if (strip) sub(/^\t+/, "", line)
    if (line == delim) { HD_LS = p; return e - 1 }
    p = e + 1
  }
  return 0
}
# hd_delim: i is at "<<"; sets HD_D (delimiter, "" = none), HD_S (<<-), HD_Q
# (quoted: body is literal); returns the index just past the delimiter word.
function hd_delim(s, i, n,   j, c, e) {
  j = i + 2; HD_S = 0; HD_Q = 0; HD_D = ""
  if (substr(s, j, 1) == "-") { HD_S = 1; j++ }
  while (j <= n && substr(s, j, 1) ~ /[ \t]/) j++
  while (j <= n) {
    c = substr(s, j, 1)
    if (c ~ /[ \t\n;&|()<>]/) break
    if (c == "'" || c == "\"") {
      HD_Q = 1; e = index(substr(s, j + 1), c)
      if (e == 0) { HD_D = ""; return i + 2 }   # unterminated: let the quote open normally
      HD_D = HD_D substr(s, j + 1, e - 1); j += e + 1; continue
    }
    if (c == "\\") { HD_Q = 1; HD_D = HD_D substr(s, j + 1, 1); j += 2; continue }
    HD_D = HD_D c; j++
  }
  return j
}
# sub_paren: i is just past "$(" (or "<(" / ">("). Returns the index of the
# matching ")" (n + 1 when unterminated) and sets SUBBODY to the raw text in
# between. Quote-, nesting-, comment- and heredoc-aware, so a ")" or "'" in
# quoted text or a heredoc body does not count.
function sub_paren(s, i, n,    start, sp, st, c, j, nh, hdl, hds, k, e, p0) {
  start = i; sp = 1; st[1] = "("; nh = 0
  for (; i <= n; i++) {
    c = substr(s, i, 1)
    if (st[sp] == "\"" || st[sp] == "`") {
      if (c == "\\") { i++; continue }
      if (c == st[sp]) sp--
      else if (st[sp] == "\"" && c == "`") st[++sp] = "`"
      else if (st[sp] == "\"" && c == "$" && substr(s, i + 1, 1) == "(") { i++; st[++sp] = "(" }
      continue
    }
    if (c == "\\") { i++; continue }
    if (c == "'") { j = index(substr(s, i + 1), "'"); if (j == 0) i = n; else i += j; continue }
    if (c == "\"" || c == "`" || c == "(") { st[++sp] = c; continue }
    if (c == ")") { if (--sp == 0) { SUBBODY = substr(s, start, i - start); return i }; continue }
    if (c == "#" && (i == start || substr(s, i - 1, 1) ~ /[ \t\n;&|(]/)) {   # comment
      while (i < n && substr(s, i + 1, 1) != "\n") i++
      continue
    }
    if (c == "<" && substr(s, i + 1, 1) == "<") {
      if (substr(s, i + 2, 1) == "<") { i += 2; continue }   # here-string
      j = hd_delim(s, i, n)
      if (HD_D != "") { nh++; hdl[nh] = HD_D; hds[nh] = HD_S }
      i = j - 1; continue
    }
    if (c == "\n" && nh > 0) {
      p0 = i + 1
      for (k = 1; k <= nh; k++) {
        e = hd_find(s, p0, n, hdl[k], hds[k])
        if (e == 0) break
        i = e; p0 = e + 2
      }
      nh = 0; continue
    }
  }
  SUBBODY = substr(s, start); return n + 1
}
# sub_tick: i is just past an opening backtick; returns the closing one (n + 1
# when unterminated) and sets SUBBODY (\` \\ \$ unescaped).
function sub_tick(s, i, n,    c, c2, body) {
  body = ""
  for (; i <= n; i++) {
    c = substr(s, i, 1)
    if (c == "\\" && i < n) {
      c2 = substr(s, i + 1, 1)
      if (c2 == "`" || c2 == "\\" || c2 == "$") body = body c2; else body = body c c2
      i++; continue
    }
    if (c == "`") { SUBBODY = body; return i }
    body = body c
  }
  SUBBODY = body; return n + 1
}
# hd_subs: an unquoted-delimiter heredoc body is data, but its substitutions run.
function hd_subs(b,   n, j, c) {
  n = length(b)
  for (j = 1; j <= n; j++) {
    c = substr(b, j, 1)
    if (c == "\\") { j++; continue }
    if (c == "$" && substr(b, j + 1, 1) == "(") { j = sub_paren(b, j + 2, n); emit(SUBBODY, "S"); continue }
    if (c == "`") { j = sub_tick(b, j + 1, n); emit(SUBBODY, "S") }
  }
}
function cfg_class(v,   k) {   # 2 = remote.* / branch.*, 1 = push.*, 0 = other
  k = tolower(v); sub(/=.*/, "", k)
  if (k ~ /^(remote|branch)\./) return 2
  if (k ~ /^push\./) return 1
  return 0
}
function maxi(a, b) { return a > b ? a : b }
function is_git(w) {
  if (w == "git") return 1
  return (length(w) > 4 && substr(w, length(w) - 3) == "/git")
}
function is_interp(w,   b) {   # runs its arguments / stdin as code
  b = w; sub(/^.*\//, "", b)
  return (b ~ /^(sh|bash|zsh|dash|ksh|csh|tcsh|fish|su|node|nodejs|deno|bun|perl|ruby|php|lua|watch|parallel)$/ || b ~ /^python[0-9.]*$/)
}
function is_wrapper(b) { return (b ~ /^(env|command|exec|nice|nohup|timeout|sudo|doas|busybox|stdbuf|time|xargs|setsid|flock|chroot|unbuffer|script|watch|parallel|caffeinate|ionice|chrt|taskset)$/) }
# data-only readers: a heredoc fed to one of these is data (mode s)
function is_reader(b) { return (b ~ /^(cat|head|tail|wc|uniq|grep|egrep|fgrep|cut|tr|fold|fmt|nl|base64|jq)$/) }
# non-executing commands: their plain words are data even when one says "bash"
# (stage_execs still catches the ways they CAN run something)
function is_safe_cmd(b) { return (is_reader(b) || b ~ /^(sort|tee|echo|printf|git|gh|ls|test|\[|true|false)$/) }
function unprovable(w) { return (w ~ /[$`~]/ || w ~ /\{.*\}/) }   # an expansion decides what runs
function base(w,   b) { b = w; sub(/^.*\//, "", b); return b }
function code_tok(w,   b) {
  b = base(w)
  return (b == "eval" || b == "source" || w == "." || is_interp(b) || w ~ /^-(exec|execdir|ok|okdir)$/)
}
# stage_word: index in w[1..nw] of the stage's command word (0 = none), after
# VAR=val, redirections (+ target), parens (\005) and shell keywords.
function stage_word(w, nw,   m, incase) {
  incase = 0
  for (m = 1; m <= nw; m++) {
    if (incase) { if (w[m] == "\005") incase = 0; continue }   # case WORD in PATTERN)
    if (w[m] == "\005") continue
    if (w[m] ~ /^[A-Za-z_][A-Za-z0-9_]*=/) continue                   # VAR=val
    if (w[m] ~ /^[0-9]*&?(>>?|<<?<?|<>)&?$/) { m++; continue }       # redirection + its target
    if (w[m] ~ /^[0-9]*&?(>>?|<<?<?|<>)/) continue                    # redirection with the target attached
    if (w[m] == "case") { incase = 1; continue }
    if (w[m] ~ /^(\{|\}|!|if|then|else|elif|fi|do|done|while|until|esac|coproc|builtin|function|select|in|time)$/) continue
    return m
  }
  return 0
}
# stage_execs: 1 when a non-executing command w[c] is made to run something: an
# output process substitution / redirect into a substitution (">$" token), an
# input process substitution whose body is code ("<$!" token), a
# program-naming option, or a `git -c` key that runs a program (alias.*,
# *.command, *.program, core.pager, core.hooksPath...) / any `--config-env`.
function stage_execs(w, nw, c,   m) {
  for (m = c + 1; m <= nw; m++) {
    if (w[m] ~ /^[0-9]*>>?\$$/ || w[m] ~ /^[0-9]*<\$!$/) return 1
    if (w[m] ~ /^--(compress-program|use-compress-program|program|exec)(=|$)/) return 1
  }
  if (base(w[c]) == "git")
    for (m = c + 1; m <= nw && w[m] ~ /^-/; m++) {
      if (w[m] ~ /^--config-env/) return 1                      # value comes from the env: unprovable
      if (w[m] == "-c" && m < nw && git_cfg_runs(w[m + 1])) return 1
      if (w[m] ~ /^-c./ && git_cfg_runs(substr(w[m], 3))) return 1
    }
  return 0
}
# git_cfg_runs: 1 when a `git -c key=value` can make git run a program
function git_cfg_runs(kv,   k, v) {
  k = tolower(kv); v = ""
  if (index(k, "=") > 0) { v = substr(kv, index(kv, "=") + 1); sub(/=.*/, "", k) }
  return (k ~ /^alias\./ || k ~ /(command|program|helper|textconv|cmd|editor|pager|hookspath|fsmonitor|askpass|proxy)$/ || v ~ /^!/)
}
# reader_stage: 1 when stage text x is read by a data-only reader that runs nothing
function reader_stage(x,   nw, w, m) {
  nw = split(x, w, " "); m = stage_word(w, nw)
  return (m > 0 && !unprovable(w[m]) && is_reader(base(w[m])) && !stage_execs(w, nw, m))
}
# body_code: 1 when a process-substitution body names something that runs code
function body_code(b,   nw, ww, k) {
  nw = split(b, ww, /[ \t\n;&|()'"]+/)
  for (k = 1; k <= nw; k++) if (code_tok(ww[k]) || (k == 1 && unprovable(ww[k]))) return 1
  return 0
}
# code_pl: 1 when pipeline x (tokens; stages split by \004, parens \005) runs
# code. Per stage: an unprovable command word -> code; a non-executing command
# (is_safe_cmd) -> data unless stage_execs; otherwise ANY eval / source / . /
# interpreter / find -exec token, an unprovable word after a wrapper, or a
# wrapper option that takes a command string (-c, --command, -S,
# --split-string) makes it code.
function code_pl(x,   ns, stg, k, nw, w, m, c, b, wrap) {
  ns = split(x, stg, "\004")
  for (k = 1; k <= ns; k++) {
    nw = split(stg[k], w, " ")
    c = stage_word(w, nw)
    if (c == 0) continue
    if (unprovable(w[c])) return 1
    b = base(w[c])
    if (is_safe_cmd(b)) { if (stage_execs(w, nw, c)) return 1; continue }
    wrap = is_wrapper(b)
    for (m = c; m <= nw; m++) {
      if (code_tok(w[m])) return 1
      if (wrap && m > c && (unprovable(w[m]) || w[m] ~ /^(-[A-Za-z]*[cS]|-S.+|--command(=.*)?|--split-string(=.*)?)$/)) return 1
    }
  }
  return 0
}
function takes_value(o) {
  return (o == "-c" || o == "-C" || o == "--git-dir" || o == "--work-tree" || o == "--namespace" || o == "--super-prefix" || o == "--config-env" || o == "--attr-source")
}
function close_pl(endpos, next_start) {   # ends the current pipeline at endpos
  npl++; plraw[npl] = substr(s, plstart, endpos - plstart); plstart = next_start
  t = t " ; "
}
{ s = s $0 "\n" }
END {
  gsub("\003", "\n", s)
  n = length(s); t = ""; q = ""; ansi = 0; pans = 0; gce = 0
  kind = (mode == "b") ? "N" : "S"
  hdm = (mode != "b")   # heredocs are recognised in modes a and s
  npl = 0; plstart = 1; nh = 0; whole = 0
  for (i = 1; i <= n; i++) {
    c = substr(s, i, 1)
    if (q != "") {
      if (c == q) { q = ""; ansi = 0; continue }
      if ((ansi || q == "\"") && c == "\\" && i < n) { i++; t = t prot(substr(s, i, 1)); continue }
      if (q == "\"" && c == "$" && substr(s, i + 1, 1) == "(") { i = sub_paren(s, i + 2, n); emit(SUBBODY, kind); t = t "$"; continue }
      if (q == "\"" && c == "`") { i = sub_tick(s, i + 1, n); emit(SUBBODY, kind); t = t "$"; continue }
      t = t prot(c)
      continue
    }
    if (c == "\\") {
      if (i < n) { i++; c = substr(s, i, 1); if (c == "\n") t = t " "; else t = t prot(c) }
      continue
    }
    if (c == "$") {
      c2 = substr(s, i + 1, 1)
      if (c2 == "(") { i = sub_paren(s, i + 2, n); emit(SUBBODY, kind); t = t "$"; continue }
      if (c2 == "'" || c2 == "\"") { pans = (c2 == "'"); continue }   # $'...' / $"...": a quote
    }
    if (c == "`") { i = sub_tick(s, i + 1, n); emit(SUBBODY, kind); t = t "$"; continue }
    if ((c == "<" || c == ">") && substr(s, i + 1, 1) == "(") {      # process substitution
      t = t c; i = sub_paren(s, i + 2, n); emit(SUBBODY, kind)
      t = t "$" ((c == "<" && body_code(SUBBODY)) ? "!" : ""); continue
    }
    if (c == "'" || c == "\"") {
      if (mode != "b") { q = c; ansi = pans } else t = t " "
      pans = 0
      continue
    }
    if (c == "<" && substr(s, i + 1, 2) == "<<") { t = t "<<<"; i += 2; continue }   # here-string
    if (hdm && c == "<" && substr(s, i + 1, 1) == "<") {
      j = hd_delim(s, i, n)
      if (HD_D != "") {
        cs = t; sub("^.*[;\004]", "", cs)
        nh++; hdl[nh] = HD_D; hds[nh] = HD_S; hdq[nh] = HD_Q
        hst[nh] = length(t) - length(cs) + 1   # where the heredoc's stage starts in t
        dd = HD_D; gsub(/[^A-Za-z0-9_.-]/, "_", dd); t = t "<<" dd
        i = j - 1; continue
      }
    }
    if (c == "\n" && nh > 0) {   # heredoc bodies belong to the pipeline this newline ends
      p0 = i + 1; last = 0
      for (k = 1; k <= nh; k++) {
        e = hd_find(s, p0, n, hdl[k], hds[k])
        if (e == 0) break
        body = substr(s, p0, HD_LS - p0)
        cs = substr(t, hst[k]); sub("\004.*$", "", cs)   # the whole stage that reads it
        hdr[k] = reader_stage(cs)
        plhd[npl + 1] = plhd[npl + 1] "\n" body
        if (mode == "s") {
          if (!hdr[k]) emit(body, "N")      # an unknown reader may run it: code
          else if (!hdq[k]) hd_subs(body)   # data, but an unquoted body still expands $(...)
        }
        last = e; p0 = e + 2
      }
      nh = 0
      close_pl(i, (mode == "s" && last) ? last + 1 : i + 1)
      if (mode == "s" && last) i = last   # mode s: the body was handled above
      continue
    }
    if (c == "|") {
      if (substr(s, i + 1, 1) == "|") { close_pl(i, i + 2); i++; continue }
      if (substr(s, i + 1, 1) == "&") i++
      t = t " \004 "; continue
    }
    if (c == "&") {
      if (substr(s, i + 1, 1) == "&") { close_pl(i, i + 2); i++; continue }
      if (substr(t, length(t), 1) ~ /[<>]/ || substr(s, i + 1, 1) == ">") { t = t c; continue }   # 2>&1, &>f
      close_pl(i, i + 1); continue
    }
    if (c == ";" || c == "\n") { close_pl(i, i + 1); continue }
    if (c == "(" || c == ")") { t = t " \005 "; continue }
    if (c == "\r" || (c == "!" && mode == "b")) c = " "   # mode b: `!cmd` (negation, git alias) is a command
    if (c == "#" && mode != "b" && (t == "" || substr(t, length(t), 1) == " ")) {   # shell comment
      while (i < n && substr(s, i + 1, 1) != "\n") i++
      continue
    }
    t = t c
  }
  close_pl(n + 1, n + 1)
  split(t, pl, ";")
  for (kp = 1; kp <= npl; kp++) {
    if (mode != "b" && code_pl(pl[kp])) {
      emit(plraw[kp], "N"); if (kp in plhd) emit(plhd[kp], "N")
      # code that expands a variable or substitution (x=$(...); eval "$x") may run
      # any text of the command: scan the whole command as code, once
      if (!whole && pl[kp] ~ /[$`]/) { whole = 1; emit(s, "N") }
    }
    nseg = split(pl[kp], seg, "[\004\005]")
    for (k = 1; k <= nseg; k++) {
      nt = split(seg[k], tok, " ")
      for (i = 1; i <= nt; i++) {
        if (tok[i] ~ /^GIT_CONFIG[A-Za-z0-9_]*=/) {   # env config for any later git, nested scans too
          if (!gce) print "G"
          gce = 1
        }
        if (!is_git(tok[i])) continue
        cfg = gce ? 2 : 0
        j = i + 1
        while (j <= nt && substr(tok[j], 1, 1) == "-") {
          o = tok[j]
          if (o == "-c" || o == "--config-env") { if (j < nt) cfg = maxi(cfg, cfg_class(tok[j + 1])); j += 2; continue }
          if (substr(o, 1, 13) == "--config-env=") cfg = maxi(cfg, cfg_class(substr(o, 14)))
          else if (substr(o, 1, 2) == "-c" && length(o) > 2) cfg = maxi(cfg, cfg_class(substr(o, 3)))
          if (takes_value(o)) j += 2; else j++
        }
        if (j > nt || tok[j] != "push") continue
        dry = 0; all = 0; repo = 0; tags = 0; np = 0; skip = 0; dd = 0
        split("", pos)
        for (m = j + 1; m <= nt; m++) {
          a = tok[m]
          if (skip) { skip = 0; continue }
          if (a ~ /^[0-9]*&?(>>?|<<?<?)&?$/) { skip = 1; continue }
          if (a ~ /^[0-9]*&?(>>?|<<?<?)./) continue
          if (!dd && a == "--") { dd = 1; continue }
          if (!dd && substr(a, 1, 1) == "-" && length(a) > 1) {
            if (a == "--dry-run") dry = 1
            else if (a == "--all" || a == "--mirror" || a == "--branches") all = 1
            else if (a == "--tags") tags = 1
            else if (a == "-o" || a == "--push-option" || a == "--receive-pack" || a == "--exec") skip = 1
            else if (a == "--repo") { repo = 1; skip = 1 }
            else if (substr(a, 1, 7) == "--repo=") repo = 1
            else if (a ~ /^-[A-Za-z0-9]+$/ && index(a, "n") > 0) dry = 1
            continue
          }
          pos[++np] = a
        }
        if (tags && !all && cfg < 2 && np <= (repo ? 0 : 1)) continue   # tags only: no branch is pushed
        printf "%d\t%d\t%d\t%d", dry, all, repo, cfg
        for (m = 1; m <= np; m++) printf "\t%s", pos[m]
        printf "\n"
      }
    }
  }
}
AWK

RECORDS=""; QP=(); QM=(); GCE=0   # GCE: some scan saw a GIT_CONFIG*= assignment   # work list of nested payloads (QM: awk mode to scan each in)
ingest() {   # <awk output>: records go to RECORDS, N/S payloads onto the work list
  local line
  while IFS= read -r line; do
    case $line in
      '') ;;
      G) GCE=1 ;;
      N$'\t'*) QP[${#QP[@]}]=${line#N?}; QM[${#QM[@]}]=b ;;
      S$'\t'*) QP[${#QP[@]}]=${line#S?}; QM[${#QM[@]}]=s ;;
      *) RECORDS="$RECORDS$line"$'\n' ;;
    esac
  done <<EOF_A
$1
EOF_A
}
OUT_A=$(printf '%s' "$COMMAND" | awk -v mode=a "$AWK_PUSH") || fail_closed "awk failed while parsing the command"
ingest "$OUT_A"
QI=0
while [ "$QI" -lt "${#QP[@]}" ]; do
  # the input has "git...push" in it (fast path above), so an unscanned rest is doubt: fail closed
  if [ "$QI" -ge 100 ]; then fail_closed "more than 100 nested shell payloads"; fi
  OUT_N=$(printf '%s' "${QP[$QI]}" | awk -v mode="${QM[$QI]}" "$AWK_PUSH") || fail_closed "awk failed while parsing a nested shell payload"
  ingest "$OUT_N"
  QI=$((QI + 1))
done
[ -n "$RECORDS" ] || allow   # no `git push` found
IN_PLAY=1   # it IS a git push from here on

# -------------------------------------------------------------- repo + config
IS_REPO=0   # 1 when ROOT is a real git work tree (its config can be read)
ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || ROOT=""
if [ -z "$ROOT" ] && [ -n "$CWD_IN" ] && [ -d "$CWD_IN" ]; then
  ROOT=$(git -C "$CWD_IN" rev-parse --show-toplevel 2>/dev/null) || ROOT=""
fi
[ -n "$ROOT" ] && IS_REPO=1
if [ -z "$ROOT" ]; then
  if [ -n "$CWD_IN" ] && [ -d "$CWD_IN" ]; then ROOT=$CWD_IN; else ROOT=$PWD; fi
fi

PROTECTED=(); TOKENS=(); STATE_REL=".planning/STATE.md"; HEADING="### Blockers/Concerns"
HAVE_KB=0; HAVE_KT=0
CFG="$ROOT/.claude/guard-push.json"
if [ -f "$CFG" ]; then
  IFS= read -r -d '' PY_CFG <<'PY'
import json, sys
with open(sys.argv[1], "rb") as f:
    d = json.loads(f.read().decode("utf-8"))
if not isinstance(d, dict):
    sys.exit(3)
out = []
v = d.get("protectedBranches")
if isinstance(v, list):
    out.append("KB")
    out += ["B\t" + x for x in v if isinstance(x, str)]
v = d.get("tokens")
if isinstance(v, list):
    out.append("KT")
    out += ["T\t" + x for x in v if isinstance(x, str)]
v = d.get("stateFile")
if isinstance(v, str):
    out.append("S\t" + v)
v = d.get("blockerSection")
if isinstance(v, str):
    out.append("H\t" + v)
sys.stdout.buffer.write(("\n".join(out) + "\n").encode("utf-8"))
PY
  IFS= read -r -d '' JQ_CFG <<'JQ'
if type != "object" then error("config must be a JSON object") else
  (if (.protectedBranches | type) == "array" then "KB", (.protectedBranches[] | select(type == "string") | "B\t" + .) else empty end),
  (if (.tokens | type) == "array" then "KT", (.tokens[] | select(type == "string") | "T\t" + .) else empty end),
  (if (.stateFile | type) == "string" then "S\t" + .stateFile else empty end),
  (if (.blockerSection | type) == "string" then "H\t" + .blockerSection else empty end)
end
JQ
  if [ "$PARSER" = jq ]; then
    CFG_LINES=$(jq -r "$JQ_CFG" "$CFG" 2>/dev/null) || fail_closed "$CFG is not a valid JSON object"
  else
    CFG_LINES=$(python3 -I -c "$PY_CFG" "$CFG" 2>/dev/null) || fail_closed "$CFG is not a valid JSON object"
  fi
  while IFS=$'\t' read -r k v; do
    case $k in
      KB) HAVE_KB=1 ;;
      KT) HAVE_KT=1 ;;
      B) PROTECTED[${#PROTECTED[@]}]=$v ;;
      T) TOKENS[${#TOKENS[@]}]=$v ;;
      S) [ -n "$v" ] && STATE_REL=$v ;;
      H) [ -n "$v" ] && HEADING=$v ;;
    esac
  done <<EOF_CFG
$CFG_LINES
EOF_CFG
fi
[ "$HAVE_KB" = 1 ] || PROTECTED=(main master production)
[ "$HAVE_KT" = 1 ] || TOKENS=("push blocker" "do NOT git push")
[ "${#PROTECTED[@]}" -gt 0 ] || allow   # config protects nothing

# ------------------------------------------- does any git push hit a protected branch?
is_protected() {
  local p
  for p in "${PROTECTED[@]}"; do
    # shellcheck disable=SC2254  # the config value is meant to be a glob
    case $1 in $p) return 0 ;; esac
  done
  return 1
}

CUR=""; CUR_DONE=0
current_branch() {   # sets CUR ("" = detached HEAD or unknown)
  if [ "$CUR_DONE" = 0 ]; then
    CUR=$(git -C "$ROOT" symbolic-ref --short -q HEAD 2>/dev/null) || CUR=""
    CUR_DONE=1
  fi
}

HIT=""
ref_hit() {   # $1 = refspec token; sets HIT and returns 0 when it can reach a protected branch
  local r=${1#+} dst
  if [ "$r" = ":" ]; then HIT="every matching branch (git push origin :)"; return 0; fi
  # anywhere in the word: an expansion can split it or move text across the ":"
  case $r in
    *'$'*|*'`'*|*'{'*|'~'*|*'*'*|*'?'*|*'['*)
      HIT="$1 (a glob or shell expansion that cannot be proven safe)"; return 0 ;;
  esac
  case $r in *:*) dst=${r#*:} ;; *) dst=$r ;; esac
  dst=${dst#refs/heads/}
  dst=${dst#heads/}
  case $dst in
    '~'*)
      HIT="$1 (a tilde expansion that cannot be proven safe)"; return 0 ;;
    HEAD|@)
      current_branch
      if [ -z "$CUR" ]; then HIT="HEAD (current branch unknown)"; return 0; fi
      if is_protected "$CUR"; then HIT=$CUR; return 0; fi
      return 1 ;;
    '') return 1 ;;
  esac
  if is_protected "$dst"; then HIT=$dst; return 0; fi
  return 1
}

CV=""
git_cfg() {   # <git config args...>: sets CV; returns 0 set, 1 unset, 2 unreadable
  local rc
  CV=$(git -C "$ROOT" config "$@" 2>/dev/null); rc=$?
  case $rc in 0) return 0 ;; 1) CV=""; return 1 ;; *) CV=""; return 2 ;; esac
}

bare_hit() {   # <remote from the command line or ""> <repo flag>; a push with no refspec
  local r=$1 k rc pd
  current_branch
  if [ -z "$CUR" ]; then HIT="the current branch (detached HEAD or unknown)"; return 0; fi
  if [ "$IS_REPO" = 1 ]; then
    if [ "$2" = 1 ]; then   # --repo=<x>: the remote is not tracked, so any remote's push config counts
      git_cfg --get-regexp '^remote\..*\.(push|mirror)$'; rc=$?
      if [ "$rc" != 1 ]; then HIT="a remote.*.push / remote.*.mirror setting (bare push with --repo)"; return 0; fi
    else
      if [ -z "$r" ]; then
        for k in "branch.$CUR.pushRemote" remote.pushDefault "branch.$CUR.remote"; do
          git_cfg --get "$k"; rc=$?
          if [ "$rc" = 2 ]; then HIT="the current branch (git config is unreadable)"; return 0; fi
          if [ -n "$CV" ]; then r=$CV; break; fi
        done
        [ -n "$r" ] || r=origin
      fi
      git_cfg --get-all "remote.$r.push"; rc=$?
      if [ "$rc" != 1 ]; then HIT="remote.$r.push is configured (a bare push follows it)"; return 0; fi
      git_cfg --bool --get "remote.$r.mirror"; rc=$?
      if [ "$rc" = 2 ] || [ "$CV" = true ]; then HIT="remote.$r.mirror (a bare push mirrors every branch)"; return 0; fi
    fi
    git_cfg --get push.default; rc=$?
    if [ "$rc" = 2 ]; then HIT="the current branch (git config is unreadable)"; return 0; fi
    pd=$CV
    case $pd in
      matching) HIT="every matching branch (push.default=matching)"; return 0 ;;
      upstream|tracking)
        git_cfg --get "branch.$CUR.merge"; rc=$?
        if [ "$rc" = 2 ] || [ -z "$CV" ]; then HIT="the upstream of $CUR (push.default=$pd, branch.$CUR.merge unset)"; return 0; fi
        k=${CV#refs/heads/}
        if is_protected "$k"; then HIT="$k (upstream of $CUR, push.default=$pd)"; return 0; fi
        return 1 ;;
      nothing) return 1 ;;
      ''|simple|current) ;;
      *) HIT="the current branch (unknown push.default=$pd)"; return 0 ;;
    esac
  fi
  if is_protected "$CUR"; then HIT="$CUR (the current branch)"; return 0; fi
  return 1
}

check_records() {   # reads $RECORDS; sets HIT; returns 0 on a protected push
  local rec dry all repo cfg start nf idx remote
  local -a f
  while IFS= read -r rec; do
    [ -n "$rec" ] || continue
    IFS=$'\t' read -r -a f <<< "$rec"
    dry=${f[0]}; all=${f[1]}; repo=${f[2]}; cfg=${f[3]}; nf=${#f[@]}
    [ "$GCE" = 1 ] && cfg=2   # a GIT_CONFIG*= assignment anywhere in the command (any scan)
    [ "$dry" = 1 ] && continue
    if [ "$all" = 1 ]; then HIT="all branches (--all / --mirror)"; return 0; fi
    if [ "$cfg" = 2 ]; then HIT="git -c / GIT_CONFIG changes the push target (a remote.* / branch.* key or GIT_CONFIG* env)"; return 0; fi
    remote=""
    if [ "$repo" = 1 ]; then start=4; else start=5; [ "$nf" -gt 4 ] && remote=${f[4]}; fi   # f[4] is the remote unless --repo was used
    case $remote in
      *'$'*|*'`'*|*'{'*|*'*'*|*'?'*|*'['*)
        HIT="remote $remote (a shell expansion that cannot be proven safe)"; return 0 ;;
    esac
    if [ "$nf" -le "$start" ]; then                      # no refspec: config decides
      if [ "$cfg" = 1 ]; then HIT="git -c / GIT_CONFIG changes the push target (push.* on a bare push)"; return 0; fi
      bare_hit "$remote" "$repo" && return 0
    else
      idx=$start
      while [ "$idx" -lt "$nf" ]; do
        ref_hit "${f[$idx]}" && return 0
        idx=$((idx + 1))
      done
    fi
  done <<EOF_REC
$RECORDS
EOF_REC
  return 1
}

check_records || allow

# --------------------------------------------------------- active blocker scan
case $STATE_REL in /*) STATE_PATH=$STATE_REL ;; *) STATE_PATH="$ROOT/$STATE_REL" ;; esac
[ -e "$STATE_PATH" ] || allow                       # no state file: nothing to gate on
if [ ! -f "$STATE_PATH" ] || [ ! -r "$STATE_PATH" ]; then
  fail_closed "$STATE_PATH exists but is not a readable file"
fi

IFS= read -r -d '' AWK_BLOCKER <<'AWK'
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
function norm(s) { s = tolower(s); gsub(/[ \t]+/, " ", s); return trim(s) }
function is_resolved(s) { return (s ~ /^[ \t]*([-*+][ \t]*)?(\*\*)?RESOLVED:/) }
function add(s) { if (is_resolved(s)) resolved = 1; btext = btext " " norm(s) }
function flush(   i, hit) {
  if (!inblock) return
  inblock = 0; hit = 0
  for (i = 1; i <= nt; i++) if (index(btext, tok[i]) > 0) { hit = 1; break }
  if (hit && !resolved) { active++; if (active == 1) first = bfirst }
}
BEGIN {
  nt = 0
  n = split(ENVIRON["HOOK_TOKENS"], raw, "\n")
  for (i = 1; i <= n; i++) { t = norm(raw[i]); if (t != "") tok[++nt] = t }
  h = trim(ENVIRON["HOOK_HEADING"]); hl = 0
  if (match(h, /^#+/)) { hl = RLENGTH; h = substr(h, RLENGTH + 1) }
  h = norm(h)
  insec = 0; infence = 0; inblock = 0; blank = 0; active = 0; first = ""
}
{
  line = $0; sub(/\r$/, "", line)
  inf = infence
  if (line ~ /^[ ]*(```|~~~)/) infence = !infence
  if (!inf && line ~ /^#+[ \t]/) {
    match(line, /^#+/); lvl = RLENGTH
    title = norm(substr(line, lvl + 1))
    if (insec && lvl <= seclvl) { flush(); insec = 0 }
    if (!insec) {
      if ((hl == 0 || lvl == hl) && (title == h || (index(title, h) == 1 && substr(title, length(h) + 1, 1) !~ /^[a-z0-9]/))) { insec = 1; seclvl = lvl; blank = 0 }
      next
    }
    flush(); next
  }
  if (!insec) next
  if (inf) { if (inblock) add(line); next }
  if (line ~ /^[ \t]*$/) { blank = 1; next }
  if (line ~ /^[-*+][ \t]/) {
    flush(); inblock = 1; resolved = 0; btext = ""
    bfirst = line; sub(/^[-*+][ \t]+/, "", bfirst)
    add(line); blank = 0; next
  }
  if (line ~ /^[ \t]/) { if (inblock) add(line); blank = 0; next }
  if (inblock && !blank) { add(line); next }
  flush(); blank = 0
}
END { flush(); print active; if (active > 0) print first }
AWK

TOKENS_NL=""
if [ "${#TOKENS[@]}" -gt 0 ]; then
  for t in "${TOKENS[@]}"; do TOKENS_NL="$TOKENS_NL$t"$'\n'; done
fi
BL=$(HOOK_HEADING="$HEADING" HOOK_TOKENS="$TOKENS_NL" awk "$AWK_BLOCKER" "$STATE_PATH") || fail_closed "awk failed while reading $STATE_PATH"
BL_COUNT=${BL%%$'\n'*}
case $BL_COUNT in ''|*[!0-9]*) fail_closed "unexpected output while reading $STATE_PATH" ;; esac
[ "$BL_COUNT" -gt 0 ] || allow

BL_FIRST=${BL#*$'\n'}
if [ "${#BL_FIRST}" -gt 200 ]; then
  BL_FIRST=${BL_FIRST:0:200}
  if command -v iconv >/dev/null 2>&1; then   # drop a multibyte character cut in half
    BL_TMP=$(printf '%s' "$BL_FIRST" | iconv -f UTF-8 -t UTF-8 -c 2>/dev/null) && BL_FIRST=$BL_TMP
  fi
  BL_FIRST="$BL_FIRST..."
fi

deny "BLOCKED: this command pushes to a protected branch ($HIT) while $STATE_REL lists $BL_COUNT unresolved push blocker(s).

First active blocker (section \"$HEADING\"):
  $BL_FIRST

Push a feature branch and open a PR instead:
  git checkout -b chore/<slug>-<YYMMDD>
  git push -u origin chore/<slug>-<YYMMDD>
  gh pr create --title \"...\" --body \"...\"

To clear a blocker once its condition is resolved, add a line inside that bullet in $STATE_REL:
  RESOLVED: <YYYY-MM-DD> — <one-line summary>
Keep the blocker entry itself; the RESOLVED line is the audit trail.
(False positive? Quoted text is ignored; an unquoted heredoc body or a -c/-e script that only mentions git push is scanned, so reword it or write the file with the Write tool.)"
