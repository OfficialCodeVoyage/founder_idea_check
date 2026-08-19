import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * PATH SAFETY. The only file in lib/export that is allowed to be paranoid.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * THE THREAT. Two of the strings that decide file paths in this feature are not
 * ours:
 *
 *   1. `Project.name` — typed by the founder, and in some flows suggested by a
 *      model from the first message.
 *   2. Fact VALUES — written by an extraction model into `ProjectFact.value`
 *      with no shape constraint beyond `text NOT NULL`. deriveRepoName() falls
 *      back to the `solution_concept` fact when a project has no usable name,
 *      so a fact value genuinely can decide a directory name.
 *
 * A fact value of `../../../../etc/passwd` must not escape the target
 * directory. Neither must `/etc/cron.d/x`, `~/.ssh/authorized_keys`,
 * `C:\Windows\System32`, `.git/hooks/pre-commit`, or `a\0b`.
 *
 * THE STRATEGY: two layers, and neither is allowed to be the only one.
 *
 *   • ALLOW-LIST BY CONSTRUCTION. slugifySegment() emits only [a-z0-9-]. It
 *     cannot produce `.`, `/`, `\`, `~`, `:` or NUL, so no amount of cleverness
 *     in the input reaches a separator. This is a whitelist, not a blacklist:
 *     blacklists lose to normalisation tricks (`..%2f`, `..\`, `\uFF0F`
 *     FULLWIDTH SOLIDUS, `\u202E` RTL override) and to whatever the next
 *     Unicode revision adds.
 *
 *   • DENY-LIST AS A TRIPWIRE. checkRelativePath() re-validates every path in
 *     the tree, including the ones WE hard-coded, and assertSafeTree() runs it
 *     over the whole plan before any writer sees it. The literals are safe
 *     today; the tripwire is there for the day someone interpolates a variable
 *     into one and nobody notices.
 *
 * The node writer adds a third layer (assertWithinRoot on the resolved absolute
 * path) because defence in depth is cheap here and a bug in this file ships a
 * file outside the founder's chosen directory.
 *
 * PURE. `node:path` performs no I/O; it is string arithmetic. Nothing in this
 * file reads, writes, or stats anything.
 */

/** Thrown when a path fails validation. Never caught inside lib/export. */
export class ExportPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportPathError";
  }
}

/**
 * Longest slug we emit. 64 keeps `repoName` comfortably inside the 255-byte
 * per-component limit on ext4/APFS/NTFS even after a `-2` de-duplication
 * suffix, and keeps the total path short enough to survive Windows' 260-char
 * MAX_PATH for a repo nested a few directories deep.
 */
export const MAX_SEGMENT_LENGTH = 64;

/**
 * Cap on a whole relative path. Well below Windows MAX_PATH (260) so that a
 * repo written into a deep target directory still fits.
 */
export const MAX_RELATIVE_PATH_LENGTH = 180;

/** Used when every candidate name slugifies to nothing. Never interpolated. */
export const FALLBACK_REPO_NAME = "founder-handoff";

/**
 * Combining marks left behind by NFKD. Stripped so "café" → "cafe".
 *
 * `\p{M}` rather than the U+0300-U+036F block: the block covers only Latin
 * diacritics, so a Devanagari or Hebrew mark would survive the fold and then be
 * eaten by NOT_ALLOWED anyway — but only after having survived the one step
 * where two spellings of the same name are meant to converge.
 */
const COMBINING_MARKS = /\p{M}/gu;

/** Everything outside the allow-list collapses to a single hyphen. */
const NOT_ALLOWED = /[^a-z0-9]+/g;

const LEADING_OR_TRAILING_HYPHEN = /^-+|-+$/g;

/**
 * Windows reserved DEVICE names. Creating `CON` or `LPT1.md` on Windows either
 * fails or opens a device rather than a file, so the whole export would break
 * on one founder's machine and nowhere else. The superscript digits are real:
 * `COM²` is a valid device alias, and both `filenamify` and `sanitize-filename`
 * carry them in their test corpora.
 *
 * `CONIN$`, `CONOUT$` and `CLOCK$` are devices too, and are the ones BOTH
 * `sanitize-filename` and `filenamify` miss — their patterns stop at `nul`.
 *
 * Matched against the STEM (text before the first dot), because `NUL.txt` is
 * still the NUL device.
 */
const WINDOWS_RESERVED_STEM =
  /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i;

/**
 * Trailing dots and spaces are silently STRIPPED by the Win32 API, so `foo.`
 * and `foo` are the same file there and different files everywhere else. A
 * generated tree that relies on the difference is a tree that corrupts itself
 * on one platform only.
 */
const TRAILING_DOT_OR_SPACE = /[. ]$/;

/**
 * Control characters (C0 + DEL + C1). `\r` in a filename is a classic log- and
 * terminal-spoofing vector, and NUL truncates the path at the syscall boundary
 * — the historic Node "poison null byte" bug, where "a\0.txt" passed a `.txt`
 * check and then opened "a".
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters IS the rule here — the lint catches them appearing by accident, and deleting them would delete the guard described above.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Invisible formatting characters: zero-width marks, bidi overrides, the BOM,
 * and the Unicode line/paragraph separators.
 *
 * These are NOT control characters, so CONTROL_CHARS does not see them. A
 * filename containing U+202E RIGHT-TO-LEFT OVERRIDE renders to a human as a
 * completely different name from the one on disk — the Trojan Source technique
 * (CVE-2021-42574). A generated repository is exactly the artefact where "the
 * file you see is the file you get" has to hold, because the next thing to read
 * it is a coding agent acting on the founder's behalf.
 */
const INVISIBLE_FORMAT_CHARS =
  /[\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/u;

const INVISIBLE_FORMAT_CHARS_GLOBAL = new RegExp(
  INVISIBLE_FORMAT_CHARS.source,
  "gu"
);

/** `C:` / `c:` style drive prefixes, which are absolute on Windows only. */
const WINDOWS_DRIVE_PREFIX = /^[a-z]:/i;

/**
 * A colon anywhere in a segment. On Windows it opens an NTFS ALTERNATE DATA
 * STREAM: `notes.md:evil` and `notes.md::$DATA` are payloads attached to
 * `notes.md`, invisible to `dir` and to most editors. On POSIX it is a legal
 * filename character, which is exactly why it is easy to forget.
 */
const COLON = /:/;

/**
 * THE `.git` GUARD, and the reason it is not paranoia.
 *
 * node-writer.ts writes every file in the plan and THEN runs `git init`, and
 * `git init` PRESERVES a `.git/hooks/` directory that already exists. So a
 * single tree entry at `.git/hooks/post-commit` is arbitrary code execution on
 * the machine doing the export, triggered by the export's own first commit.
 * `--no-verify` does not help: it suppresses `pre-commit` and `commit-msg`, not
 * `post-commit`.
 *
 * Nothing in buildHandoff() currently derives a path from untrusted input, so
 * this is a tripwire rather than a live hole — which is precisely when it must
 * be installed. (node-writer.ts closes the same hole a second way, with
 * `core.hooksPath` pointed at nothing.)
 *
 * FOLDED before comparison: on macOS and Windows `.GIT` IS `.git`, and git
 * itself treats several zero-width-padded spellings as equivalent there.
 */
function gitFold(segment: string): string {
  return segment
    .normalize("NFKD")
    .replace(INVISIBLE_FORMAT_CHARS_GLOBAL, "")
    .toLowerCase();
}

/**
 * Directory names that must never appear in a generated tree at any depth.
 *
 * `.git` for the RCE above. `.github` is not here on purpose: workflow files
 * are inert until the repo is pushed to GitHub, and a founder may legitimately
 * want them later.
 */
const FORBIDDEN_SEGMENTS = new Set([".git"]);

/**
 * PURE. Reduce an arbitrary, possibly hostile string to a single safe path
 * segment, or return `null` when nothing usable survives.
 *
 * Returning `null` rather than a default is deliberate: the caller has to make
 * the fallback decision explicitly and visibly. A silent default inside here
 * would mean `slugifySegment("../../etc")` and `slugifySegment("My Project")`
 * both quietly produce something plausible, and the first case would stop
 * looking like the attack it is.
 *
 * The output alphabet is [a-z0-9-] with no leading/trailing hyphen, which
 * makes every dangerous construct unrepresentable rather than merely filtered.
 */
export function slugifySegment(raw: string): string | null {
  const slug = raw
    // NFKD first so that composed and decomposed forms of the same character
    // cannot slugify differently, and so full-width look-alikes (U+FF0F
    // FULLWIDTH SOLIDUS, U+FF0E FULLWIDTH FULL STOP) fold to their ASCII
    // originals BEFORE the allow-list runs. Folding after the allow-list would
    // be useless; folding before it means the ASCII form is what gets rejected.
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(NOT_ALLOWED, "-")
    .replace(LEADING_OR_TRAILING_HYPHEN, "")
    .slice(0, MAX_SEGMENT_LENGTH)
    // Slicing can leave a trailing hyphen behind, so trim again. Order matters:
    // trim, slice, trim.
    .replace(LEADING_OR_TRAILING_HYPHEN, "");

  if (slug.length === 0) {
    return null;
  }
  // A pure-digit or reserved-device slug is legal on POSIX but hostile on
  // Windows. Rejecting is safe because the caller always has a fallback.
  if (WINDOWS_RESERVED_STEM.test(slug)) {
    return null;
  }
  return slug;
}

/**
 * PURE. Pick a repo directory name from an ordered list of candidates.
 *
 * Candidates are tried in order and the first one that survives slugification
 * wins; if none does, FALLBACK_REPO_NAME is used. Callers pass the project name
 * first and a fact value second — see deriveRepoName in handoff.ts.
 */
export function pickRepoName(candidates: readonly string[]): string {
  for (const candidate of candidates) {
    const slug = slugifySegment(candidate);
    if (slug) {
      return slug;
    }
  }
  return FALLBACK_REPO_NAME;
}

/**
 * PURE. Validate a POSIX-relative path. Returns `null` when the path is safe,
 * or a human-readable reason when it is not.
 *
 * Returns a reason string rather than a boolean because the reason ends up in
 * the thrown error, and "path escapes the repo root" is debuggable while
 * "invalid path" is not — the same discipline decideGate() applies to verdicts.
 */
// The deny-list is deliberately TWO flat lists — rules about the whole path,
// then rules about each segment — and nothing more. Each rule carries its own
// reason string and none of them is factored into a shared helper: scattering a
// deny-list across a file is exactly how a rule goes missing in review.

/** Rules that apply to the path as a whole. */
function checkWholePath(path: string): string | null {
  if (path.length === 0) {
    return "path is empty";
  }
  if (path.length > MAX_RELATIVE_PATH_LENGTH) {
    return `path is longer than ${MAX_RELATIVE_PATH_LENGTH} characters`;
  }
  if (CONTROL_CHARS.test(path)) {
    // Checked before anything else: a NUL truncates the path at the syscall,
    // so every check after it would be validating a different string from the
    // one the kernel sees.
    return "path contains a control character or NUL byte";
  }
  if (INVISIBLE_FORMAT_CHARS.test(path)) {
    // The name a human reviews must be the name the kernel opens.
    return "path contains an invisible or bidirectional formatting character";
  }
  if (path.includes("\\")) {
    // A backslash is a separator on Windows and a literal on POSIX. Allowing it
    // means `a\..\b` is one segment here and an escape there.
    return "path contains a backslash";
  }
  if (isAbsolute(path) || path.startsWith("/")) {
    return "path is absolute";
  }
  if (WINDOWS_DRIVE_PREFIX.test(path)) {
    // Catches `C:\x` AND the drive-RELATIVE `C:x`, which `path.win32.isAbsolute`
    // reports as NOT absolute — the CVE-2026-31802 class in node-tar.
    return "path starts with a Windows drive letter";
  }
  if (path.startsWith("~")) {
    // Not dangerous to fs.writeFile, but it is dangerous the moment a human or
    // a shell touches the path, and generated repos get handled by both.
    return "path starts with a home-directory reference";
  }
  return null;
}

/** Rules that apply to one `/`-separated segment. */
function checkSegment(segment: string): string | null {
  if (segment.length === 0) {
    return "path contains an empty segment";
  }
  if (segment === "." || segment === "..") {
    return `path contains a "${segment}" segment`;
  }
  if (segment.length > MAX_SEGMENT_LENGTH + 16) {
    // +16 so hard-coded names like "OPEN-QUESTIONS.md" are comfortable while
    // an interpolated slug (capped at MAX_SEGMENT_LENGTH) still fits.
    return `path segment "${segment}" is too long`;
  }
  if (TRAILING_DOT_OR_SPACE.test(segment)) {
    return `path segment "${segment}" ends with a dot or space`;
  }
  if (COLON.test(segment)) {
    return `path segment "${segment}" contains a colon (NTFS alternate data stream)`;
  }
  if (FORBIDDEN_SEGMENTS.has(gitFold(segment))) {
    // The RCE guard. See the FORBIDDEN_SEGMENTS comment: a tree entry under
    // .git/hooks/ executes on the machine running the export.
    return `path segment "${segment}" would write inside the repository's own git directory`;
  }
  const stem = segment.split(".")[0];
  if (WINDOWS_RESERVED_STEM.test(stem)) {
    return `path segment "${segment}" is a reserved device name`;
  }
  return null;
}

export function checkRelativePath(path: string): string | null {
  const whole = checkWholePath(path);
  if (whole) {
    return whole;
  }
  for (const segment of path.split("/")) {
    const reason = checkSegment(segment);
    if (reason) {
      return reason;
    }
  }
  return null;
}

/** PURE. Throwing form of checkRelativePath. */
export function assertSafeRelativePath(path: string): void {
  const reason = checkRelativePath(path);
  if (reason) {
    throw new ExportPathError(`Refusing to export "${path}": ${reason}.`);
  }
}

/**
 * PURE. A key under which two DIFFERENT path strings are the SAME FILE on a
 * case-insensitive or Unicode-folding filesystem.
 *
 * The double case-fold is node-tar's (`src/normalize-unicode.ts`, approach
 * only — node-tar is BlueOak-1.0.0 and no code was copied). Lowercasing alone
 * is not enough: uppercasing after it also expands ligatures and sharp-s, so
 * `ﬁle`/`file` and `straße`/`strasse` collide, which is what APFS and NTFS
 * actually do. That collision class is CVE-2026-23950 in node-tar.
 */
export function collisionKey(path: string): string {
  return path.normalize("NFD").toLocaleLowerCase("en").toLocaleUpperCase("en");
}

/**
 * PURE. The choke point. Every path in a HandoffPlan passes through here
 * before any writer sees it, and duplicates are a hard error.
 *
 * DUPLICATES ARE FATAL, not last-write-wins: two entries for `PRD.md` mean one
 * of the two documents the founder is about to rely on has silently vanished,
 * and the only honest response to "which one did you want?" is to stop.
 *
 * COLLISIONS ARE THE SAME BUG WEARING A DIFFERENT SPELLING. `README.md` and
 * `readme.md` are two distinct strings and one single file on macOS and
 * Windows, so on those platforms the second write silently destroys the first —
 * exactly the outcome the duplicate rule exists to prevent, except it only
 * happens on the founder's laptop and never in CI.
 */
export function assertSafeTree(files: readonly { path: string }[]): void {
  const seen = new Set<string>();
  const folded = new Map<string, string>();
  for (const file of files) {
    assertSafeRelativePath(file.path);
    if (seen.has(file.path)) {
      throw new ExportPathError(
        `Refusing to export: duplicate path "${file.path}" in the generated tree.`
      );
    }
    const key = collisionKey(file.path);
    const clash = folded.get(key);
    if (clash !== undefined) {
      throw new ExportPathError(
        `Refusing to export: "${file.path}" and "${clash}" are the same file on a case-insensitive or Unicode-folding filesystem.`
      );
    }
    seen.add(file.path);
    folded.set(key, file.path);
  }
}

/**
 * The third layer, used by node-writer.ts on the RESOLVED absolute path.
 *
 * PURE — `resolve` and `relative` are string arithmetic, no fs. It exists
 * because the first two layers reason about the string we generated, and this
 * one reasons about the path the syscall will actually receive after the
 * platform has had its say (symlink-free, but normalisation-complete).
 *
 * `relative(root, child)` starting with ".." is the standard containment test;
 * the `isAbsolute` arm catches the Windows case where the two paths are on
 * different drives and `relative` returns an absolute path instead.
 */
export function assertWithinRoot(rootDir: string, candidate: string): string {
  const root = resolve(rootDir);
  const child = resolve(candidate);
  if (child === root) {
    return child;
  }
  const rel = relative(root, child);
  if (rel.length === 0 || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new ExportPathError(
      `Refusing to write "${candidate}": it resolves outside the export root "${root}".`
    );
  }
  if (isAbsolute(rel)) {
    throw new ExportPathError(
      `Refusing to write "${candidate}": it resolves to a different volume from the export root "${root}".`
    );
  }
  return child;
}
