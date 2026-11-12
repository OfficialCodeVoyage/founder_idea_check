#!/usr/bin/env bash
# bearings-check.sh — SessionStart freshness guard for the project orientation layer.
#
# Prints ≤6 lines to stdout (which enters Claude's context on SessionStart):
#   1. Orientation pointer + staleness of RECONSTRUCTION.md
#   2. Staleness of .planning/codebase/*.md (gsd-map-codebase output)
#   3. Dead path-scoped rules (globs matching zero tracked files), if any
# ALWAYS exits 0. Never blocks. Fails LOUD on an unreachable stamp SHA — an
# unguarded `git rev-list <bad>..HEAD` prints nothing and reads as "0 behind".
#
# Config: .claude/bearings.json (map, codebaseDir, scopedPaths, maxDays, maxCommits)

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" || exit 0
CFG=.claude/bearings.json
[ -f "$CFG" ] || exit 0
command -v python3 >/dev/null 2>&1 || { echo "bearings: python3 missing — freshness check skipped"; exit 0; }

python3 - "$CFG" <<'PY'
import json, os, re, subprocess, sys, glob, datetime, itertools

cfg = json.load(open(sys.argv[1]))
MAP = cfg.get("map", "RECONSTRUCTION.md")
CB  = cfg.get("codebaseDir", ".planning/codebase")
SCOPED = cfg.get("scopedPaths", [])
MAX_DAYS = int(cfg.get("maxDays", 30))
MAX_COMMITS = int(cfg.get("maxCommits", 150))
out = []

def git(*a):
    r = subprocess.run(["git", *a], capture_output=True, text=True)
    return r.returncode, r.stdout.strip()

def reachable(sha):
    return sha and git("cat-file", "-e", f"{sha}^{{commit}}")[0] == 0

def commits_since(sha):
    rc, n = git("rev-list", "--count", f"{sha}..HEAD", "--", *SCOPED)
    return int(n) if rc == 0 and n.isdigit() else None

def days_since(iso):
    try:
        d = datetime.date.fromisoformat(iso[:10])
        return (datetime.date.today() - d).days
    except Exception:
        return None

def verdict(days, commits, unreachable):
    stale = (days is not None and days > MAX_DAYS) or (commits is not None and commits > MAX_COMMITS)
    tag = "STALE — refresh before trusting" if stale else "current"
    if unreachable:
        tag += " (stamp SHA unreachable: rebase/shallow — date only)"
    return tag

# --- 1. main map ---
if os.path.isfile(MAP):
    txt = open(MAP, encoding="utf-8", errors="replace").read(4000)
    sha  = (re.search(r"bearings-sha:\s*([0-9a-f]{7,40})", txt) or [None, None])[1]
    date = (re.search(r"bearings-date:\s*(\d{4}-\d{2}-\d{2})", txt) or [None, None])[1]
    if sha or date:
        unr = bool(sha) and not reachable(sha)
        commits = commits_since(sha) if (sha and not unr) else None
        days = days_since(date) if date else None
        bits = []
        if date: bits.append(f"stamped {date}")
        if commits is not None: bits.append(f"{commits} scoped commits behind")
        elif days is not None: bits.append(f"{days} days old")
        out.append(f"Orientation: {MAP} — {', '.join(bits)} — {verdict(days, commits, unr)}")
    else:
        out.append(f"Orientation: {MAP} — UNSTAMPED (run bearings stamp)")
else:
    out.append(f"Orientation: {MAP} missing")

# --- 2. codebase maps (gsd-map-codebase stamps: <!-- refreshed: YYYY-MM-DD --> / last_mapped_commit: sha) ---
maps = sorted(f for f in glob.glob(os.path.join(CB, "*.md")))
if maps:
    dates, shas = [], []
    for f in maps:
        t = open(f, encoding="utf-8", errors="replace").read(1500)
        m = re.search(r"refreshed:\s*(\d{4}-\d{2}-\d{2})", t)
        if m: dates.append(m.group(1))
        m = re.search(r"last_mapped_commit:\s*([0-9a-f]{7,40})", t)
        if m: shas.append(m.group(1))
    if dates:
        oldest = min(dates)
        days = days_since(oldest)
        sha = min(shas, key=lambda s: 0) if shas else None  # any; they're normally identical
        unr = bool(sha) and not reachable(sha)
        commits = commits_since(sha) if (sha and not unr) else None
        detail = f"{commits} scoped commits behind" if commits is not None else f"{days} days old"
        out.append(f"Codebase maps: {CB}/ ({len(maps)} docs) — oldest refreshed {oldest}, {detail} — {verdict(days, commits, unr)}")
    else:
        out.append(f"Codebase maps: {CB}/ ({len(maps)} docs) — UNSTAMPED, treat as unknown age")

# --- 3. dead rules ---
def expand_braces(p):
    m = re.search(r"\{([^{}]*)\}", p)
    if not m: return [p]
    pre, post = p[:m.start()], p[m.end():]
    return [x for alt in m.group(1).split(",") for x in expand_braces(pre + alt + post)]

rc, tracked = git("ls-files")
tracked = tracked.splitlines() if rc == 0 else []
import fnmatch
def matches(g):
    # translate ** semantics: fnmatch treats * as matching '/', which approximates ** well enough here
    pat = g.replace("**/", "*").replace("**", "*")
    return any(fnmatch.fnmatch(t, pat) or fnmatch.fnmatch(t, g) for t in tracked)

dead = []
n_rules = 0
for rf in sorted(glob.glob(".claude/rules/**/*.md", recursive=True)):
    n_rules += 1
    t = open(rf, encoding="utf-8", errors="replace").read(2000)
    fm = re.match(r"^---\n(.*?)\n---", t, re.S)
    if not fm: continue
    globs = re.findall(r'^\s*-\s*["\']?([^"\'\n]+?)["\']?\s*$', fm.group(1), re.M)
    for g in globs:
        if not any(matches(x) for x in expand_braces(g)):
            dead.append(f"{os.path.basename(rf)}: {g}")
if n_rules:
    out.append(f"Rules: {n_rules} in .claude/rules/, {len(dead)} dead glob(s)" + ("" if not dead else " → " + "; ".join(dead[:3])))

print("\n".join(out[:6]))
PY
exit 0
