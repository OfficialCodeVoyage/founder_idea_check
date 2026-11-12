#!/usr/bin/env bash
# test-integrity: fail a change that makes the test suite weaker. CI runs it on pull requests.
#
#   scripts/test-integrity.sh <base> [head]      head defaults to HEAD
#
# Compares the merge-base of <base> and <head> with <head>, in the repository of the current
# directory, and fails when the change
#   1. deletes a test file,
#   2. adds a skip or focus marker to a test file (it.only, describe.skip, test.fixme, xit,
#      pytest.mark.skip, pytest.skip, pytest.mark.xfail, unittest.skip, ...), or
#   3. lowers the total number of test cases (TypeScript: it( / test( declarations in
#      *.test.ts, *.test.tsx, *.e2e.ts; Python: `def test_` in apps/research/tests).
#
# Rules 1 and 3 are waived when TEST_REMOVAL_APPROVED=true. CI sets it when a maintainer has put
# the label `test-removal-approved` on the pull request. Rule 2 is never waived.
#
# Exit codes: 0 ok, 1 the change weakens the tests, 2 usage or git error.
#
# Limits, stated so nobody trusts it more than it deserves: it counts declarations, not
# assertions, so it cannot see a test whose body was emptied; and a pull request can edit this
# script, so the review of changes under scripts/ and .github/ is part of the guard.
set -uo pipefail

label="test-removal-approved"
approved="${TEST_REMOVAL_APPROVED:-false}"

die() {
  echo "test-integrity: $*" >&2
  exit 2
}

[ "$#" -ge 1 ] || die "usage: scripts/test-integrity.sh <base> [head]"
root="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git repository"
cd "$root" || die "cannot enter $root"

head="$(git rev-parse --verify --quiet "${2:-HEAD}^{commit}")" || die "head '${2:-HEAD}' is not a commit"
base_tip="$(git rev-parse --verify --quiet "$1^{commit}")" ||
  die "base '$1' is not available; fetch it first (git fetch --no-tags --depth=1 origin <sha>)"
base="$(git merge-base "$base_tip" "$head" 2>/dev/null || true)"
[ -n "$base" ] || base="$base_tip"

# --- what counts as a test file, and what counts as a skip -------------------------------------

is_ts_test() {
  case "$1" in
    *.test.ts | *.test.tsx | *.e2e.ts) return 0 ;;
  esac
  return 1
}

is_py_test() {
  case "$1" in
    apps/research/tests/__init__.py) return 1 ;;
    apps/research/tests/*.py) return 0 ;;
  esac
  return 1
}

is_test_file() { is_ts_test "$1" || is_py_test "$1"; }

# A character class instead of \b: git's regex flavour differs between macOS and Linux.
ts_skip_re='(^|[^[:alnum:]_.])(it|test|describe)\.(only|skip|skipIf|fixme)([^[:alnum:]_]|$)|(^|[^[:alnum:]_.])(xit|xtest|xdescribe|fit|fdescribe)\('
py_skip_re='pytest\.mark\.(skip|skipif|xfail)|pytest\.skip\(|unittest\.skip'
ts_case_re='(^|[^[:alnum:]_.])(it|test)(\.each)?[(`]'
py_case_re='^[[:space:]]*(async[[:space:]]+)?def[[:space:]]+test_'

skip_re_for() {
  if is_ts_test "$1"; then printf '%s' "$ts_skip_re"; else printf '%s' "$py_skip_re"; fi
}

# count_in_blob <rev> <path> <regex>: occurrences of the regex in one file at one revision.
count_in_blob() {
  git show "$1:$2" 2>/dev/null | grep -oE "$3" | wc -l | tr -d ' '
}

# count_cases <rev> <ts|py>: test-case declarations in the whole tree at one revision.
count_cases() {
  if [ "$2" = ts ]; then
    git grep -ohE "$ts_case_re" "$1" -- ':(glob)**/*.test.ts' ':(glob)**/*.test.tsx' ':(glob)**/*.e2e.ts' | wc -l | tr -d ' '
  else
    git grep -ohE "$py_case_re" "$1" -- ':(glob)apps/research/tests/**/*.py' | wc -l | tr -d ' '
  fi
}

# --- walk the diff ------------------------------------------------------------------------------

deleted=()
skipped=()
changed_tests=0

while IFS=$'\t' read -r status path_a path_b; do
  [ -n "${status:-}" ] || continue
  case "$status" in
    D*)
      if is_test_file "$path_a"; then deleted+=("$path_a"); fi
      continue
      ;;
    R*) old_path="$path_a"; new_path="$path_b" ;;
    C*) old_path=""; new_path="$path_b" ;;
    A*) old_path=""; new_path="$path_a" ;;
    *) old_path="$path_a"; new_path="$path_a" ;;
  esac
  is_test_file "$new_path" || continue
  changed_tests=$((changed_tests + 1))
  re="$(skip_re_for "$new_path")"
  before=0
  if [ -n "$old_path" ]; then before="$(count_in_blob "$base" "$old_path" "$re")"; fi
  after="$(count_in_blob "$head" "$new_path" "$re")"
  if [ "$after" -gt "$before" ]; then
    skipped+=("$new_path: $((after - before)) new skip or focus marker(s)")
  fi
done < <(git diff --name-status -M "$base" "$head")

if [ "$changed_tests" -eq 0 ] && [ "${#deleted[@]}" -eq 0 ]; then
  echo "test-integrity: ok (no test file changed)"
  exit 0
fi

ts_before="$(count_cases "$base" ts)"
ts_after="$(count_cases "$head" ts)"
py_before="$(count_cases "$base" py)"
py_after="$(count_cases "$head" py)"
dropped=0
if [ "$ts_after" -lt "$ts_before" ] || [ "$py_after" -lt "$py_before" ]; then dropped=1; fi

# --- report -------------------------------------------------------------------------------------

failures=()
waived=()

if [ "${#skipped[@]}" -gt 0 ]; then
  failures+=("A change adds a skip or focus marker to a test file:
$(printf '  - %s\n' "${skipped[@]}")
How to fix: remove every .only (it silently disables the rest of the file). Make a skipped test
pass instead of skipping it. If the test is obsolete, delete it, which needs the maintainer label
'$label'. Skip markers are never waived by the label.")
fi

if [ "${#deleted[@]}" -gt 0 ]; then
  text="A change deletes a test file:
$(printf '  - %s\n' "${deleted[@]}")
How to fix: restore the file, or move its cases into another test file. If the code under test
was removed on purpose, say so in the pull request description and ask a maintainer to add the
label '$label'."
  if [ "$approved" = true ]; then waived+=("$text"); else failures+=("$text"); fi
fi

if [ "$dropped" -eq 1 ]; then
  text="The number of test cases went down:
  TypeScript (it/test in *.test.ts, *.test.tsx, *.e2e.ts): $ts_before -> $ts_after
  Python (def test_ in apps/research/tests):               $py_before -> $py_after
How to fix: put back the tests you removed, or replace them with ones that cover the same
behaviour. If the removal is intentional (the feature is gone), explain it in the pull request
description and ask a maintainer to add the label '$label'."
  if [ "$approved" = true ]; then waived+=("$text"); else failures+=("$text"); fi
fi

for text in ${waived[@]+"${waived[@]}"}; do
  echo "test-integrity: allowed by the '$label' label"
  echo "$text"
  echo
done

if [ "${#failures[@]}" -gt 0 ]; then
  for text in "${failures[@]}"; do
    echo "test-integrity: FAILED"
    echo "$text"
    echo
  done
  if [ "${GITHUB_ACTIONS:-}" = true ]; then
    echo "::error title=Test integrity::This change weakens the test suite. The job log says what and how to fix it."
  fi
  exit 1
fi

echo "test-integrity: ok (TypeScript cases $ts_before -> $ts_after, Python cases $py_before -> $py_after, $changed_tests test file(s) changed)"
