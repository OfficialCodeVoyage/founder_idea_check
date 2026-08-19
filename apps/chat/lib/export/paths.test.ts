import { describe, expect, it } from "vitest";
import {
  assertSafeRelativePath,
  assertSafeTree,
  assertWithinRoot,
  checkRelativePath,
  ExportPathError,
  FALLBACK_REPO_NAME,
  MAX_SEGMENT_LENGTH,
  pickRepoName,
  slugifySegment,
} from "./paths";

/**
 * THE HOSTILE CORPUS.
 *
 * Every entry is a real technique, not a hypothetical: classic dot-dot
 * traversal, the Node "poison null byte" truncation, Windows drive and UNC
 * prefixes, home expansion, URL-encoded and double-encoded separators, Unicode
 * look-alike separators (FULLWIDTH SOLIDUS, FRACTION SLASH, DIVISION SLASH),
 * a bidi override that hides the real extension from a human reader, Windows
 * reserved device names, trailing dots and spaces that Win32 silently strips,
 * and `.git/` targets that would rewrite the repository the export just made.
 *
 * The assertion is deliberately about the OUTPUT ALPHABET rather than about
 * each individual string: slugifySegment may emit only [a-z0-9-], so traversal
 * is unrepresentable rather than filtered. A blacklist would have to be
 * re-audited for every new encoding; an allow-list does not.
 */
const HOSTILE_INPUTS = [
  "../../../../etc/passwd",
  "..",
  "../",
  "....//....//etc/passwd",
  "..\\..\\windows\\system32",
  "/etc/cron.d/backdoor",
  "//evil/share/payload",
  "\\\\evil\\share\\payload",
  "C:\\Windows\\System32\\drivers\\etc\\hosts",
  "c:/windows/system32",
  "~/.ssh/authorized_keys",
  "~root",
  ".git/hooks/pre-commit",
  ".git",
  ".gitignore",
  "..%2f..%2fetc%2fpasswd",
  "%2e%2e%2f%2e%2e%2f",
  "..%252f..%252f",
  "a\u0000b.md",
  "\u0000",
  "report\u0000.md.sh",
  "\uff0e\uff0e\uff0fetc\uff0fpasswd",
  "..\u2215..\u2215etc",
  "..\u2044..\u2044etc",
  "file\u202ednm.exe",
  "CON",
  "con.txt",
  "PRN",
  "aux",
  "NUL.md",
  "COM1",
  "com\u00b9",
  "LPT9",
  "trailing.",
  "trailing ",
  "   ",
  "",
  "\t\n\r",
  "$(rm -rf ~)",
  "`whoami`",
  "; rm -rf /",
  "a".repeat(5000),
  "\u0000/../..",
  "node_modules/.bin/x",
  "-rf",
  "--upload-pack=touch pwned",
  // MANGLED-PATH: reconstitutes into "../" if a filter merely REMOVES "../".
  // Only an allow-list survives this one.
  "..././",
  "...\\.\\",
  "..;/etc/passwd",
  // U+2024 ONE DOT LEADER — renders as a full stop, is not one.
  "\u2024\u2024/etc",
  // Overlong UTF-8 encoding of "../" (PayloadsAllTheThings).
  "%c0%ae%c0%ae%c0%af",
  "%uff0e%uff0e%u2215",
  // Drive-RELATIVE, which path.win32.isAbsolute reports as NOT absolute.
  "C:foo",
  "\\\\?\\C:\\evil",
  // NTFS alternate data streams.
  "notes.md:evil",
  "notes.md::$DATA",
  // Devices both sanitize-filename and filenamify miss.
  "CONIN$",
  "CONOUT$",
  "CLOCK$",
  // Invisible: BOM, zero-width space, RTL isolate.
  "\ufeffbom",
  "a\u200bb",
  "\u2066a\u2069",
  // Non-Latin: must produce SOMETHING safe or nothing, never a separator.
  "中文项目",
  "🚀🚀",
] as const;

/** The complete alphabet slugifySegment is permitted to emit. */
const SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TRAILING_HYPHEN = /-$/;
const DOT_DOT_SEGMENT_REASON = /".." segment/;
const DUPLICATE_PATH_REASON = /duplicate path/;
const COLLISION_REASON = /same file on a case-insensitive/;

describe("slugifySegment — the allow-list that makes traversal unrepresentable", () => {
  it.each(
    HOSTILE_INPUTS
  )("never emits an unsafe character for %j", (hostile) => {
    const slug = slugifySegment(hostile);
    if (slug === null) {
      return;
    }
    expect(slug).toMatch(SAFE_SLUG);
    expect(slug).not.toContain("/");
    expect(slug).not.toContain("\\");
    expect(slug).not.toContain("..");
    expect(slug).not.toContain("~");
    expect(slug).not.toContain("\u0000");
    expect(slug.length).toBeLessThanOrEqual(MAX_SEGMENT_LENGTH);
  });

  it("reduces the canonical traversal payload to inert text", () => {
    // Not "rejects": the point is that the dangerous PARTS cannot survive, so
    // whatever is left is a harmless directory name.
    expect(slugifySegment("../../../../etc/passwd")).toBe("etc-passwd");
  });

  it("returns null for input with nothing usable in it", () => {
    expect(slugifySegment("...")).toBeNull();
    expect(slugifySegment("///")).toBeNull();
    expect(slugifySegment("   ")).toBeNull();
    expect(slugifySegment("")).toBeNull();
  });

  it("rejects Windows reserved device names, with or without an extension", () => {
    expect(slugifySegment("CON")).toBeNull();
    expect(slugifySegment("nul")).toBeNull();
    expect(slugifySegment("COM1")).toBeNull();
    // "com¹" NFKD-folds to "com1", which is the whole reason the fold runs
    // BEFORE the allow-list rather than after it.
    expect(slugifySegment("com\u00b9")).toBeNull();
    // ...but only when the device name is the WHOLE segment.
    expect(slugifySegment("con-artist")).toBe("con-artist");
  });

  it("folds unicode separators to ASCII before filtering, not after", () => {
    // U+FF0F FULLWIDTH SOLIDUS. If the fold happened after the allow-list this
    // would survive as a separator on some filesystems.
    expect(slugifySegment("a\uff0fb")).toBe("a-b");
    expect(slugifySegment("caf\u00e9 corner")).toBe("cafe-corner");
  });

  it("caps length and never leaves a trailing hyphen after the cap", () => {
    const slug = slugifySegment(`${"a".repeat(MAX_SEGMENT_LENGTH)} tail`);
    expect(slug).not.toBeNull();
    expect(slug as string).toHaveLength(MAX_SEGMENT_LENGTH);
    expect(slug as string).not.toMatch(TRAILING_HYPHEN);
  });

  it("strips leading and trailing hyphens so a name never looks like a flag", () => {
    // "-rf" reaching a CLI as a bare argument is how a directory name becomes a
    // flag. The leading hyphen is removed at the source.
    expect(slugifySegment("-rf")).toBe("rf");
    expect(slugifySegment("--upload-pack=touch pwned")).toBe(
      "upload-pack-touch-pwned"
    );
  });
});

describe("pickRepoName — ordered candidates with an explicit floor", () => {
  it("takes the first candidate that survives slugification", () => {
    expect(pickRepoName(["", "...", "Dog Walker Ops"])).toBe("dog-walker-ops");
  });

  it("falls back rather than returning something unsafe", () => {
    expect(pickRepoName(["../..", "///", "CON"])).toBe(FALLBACK_REPO_NAME);
  });

  it("falls back when there are no candidates at all", () => {
    expect(pickRepoName([])).toBe(FALLBACK_REPO_NAME);
  });
});

describe("checkRelativePath — the tripwire over paths we generated ourselves", () => {
  it.each([
    "README.md",
    "PRD.md",
    ".planning/ROADMAP.md",
    ".planning/phases/01-problem-validation.md",
    ".gitignore",
  ])("accepts the generated path %s", (path) => {
    expect(checkRelativePath(path)).toBeNull();
  });

  it.each([
    ["", "path is empty"],
    ["/etc/passwd", "path is absolute"],
    ["../escape.md", 'path contains a ".." segment'],
    ["a/../../b.md", 'path contains a ".." segment'],
    ["./a.md", 'path contains a "." segment'],
    ["a//b.md", "path contains an empty segment"],
    ["a\\b.md", "path contains a backslash"],
    ["~/notes.md", "path starts with a home-directory reference"],
    ["C:/Windows/x.md", "path starts with a Windows drive letter"],
    ["a\u0000.md", "path contains a control character or NUL byte"],
    ["a\r\n.md", "path contains a control character or NUL byte"],
    ["dir/CON.md", 'path segment "CON.md" is a reserved device name'],
    ["dir/notes.md ", 'path segment "notes.md " ends with a dot or space'],
    ["dir/notes.", 'path segment "notes." ends with a dot or space'],
  ])("rejects %j with a specific reason", (path, expected) => {
    expect(checkRelativePath(path)).toBe(expected);
  });

  it("rejects an over-long path rather than letting the filesystem decide", () => {
    const long = `${"a/".repeat(200)}x.md`;
    expect(checkRelativePath(long)).toContain("longer than");
  });

  it("names the rule that fired, because an unexplained refusal is undebuggable", () => {
    // Same discipline as decideGate(): every rejection interpolates the specific
    // failing thing at the point of decision.
    expect(() => assertSafeRelativePath("../x.md")).toThrow(ExportPathError);
    expect(() => assertSafeRelativePath("../x.md")).toThrow(
      DOT_DOT_SEGMENT_REASON
    );
  });
});

describe("checkRelativePath — the rules added after the security review", () => {
  it("REFUSES to write inside the repository's own git directory", () => {
    // THE RCE. node-writer writes every file and THEN runs `git init`, and
    // `git init` preserves a `.git/hooks/` that is already there — so this entry
    // would execute during the export's own first commit. `--no-verify` does not
    // cover post-commit.
    expect(checkRelativePath(".git/hooks/post-commit")).toContain(
      "git directory"
    );
    expect(checkRelativePath(".git/hooks/pre-commit")).toContain(
      "git directory"
    );
    expect(checkRelativePath(".git/config")).toContain("git directory");
    expect(checkRelativePath(".git")).toContain("git directory");
  });

  it("folds case and invisible characters before deciding it is not .git", () => {
    // On macOS and Windows `.GIT` IS `.git`.
    expect(checkRelativePath(".GIT/config")).toContain("git directory");
    expect(checkRelativePath(".Git/hooks/post-commit")).toContain(
      "git directory"
    );
    // The zero-width-padded spelling is caught one rule EARLIER, by the
    // invisible-character check. Both rules are kept: this one would still be
    // the only thing standing if the invisible list ever missed a code point.
    expect(checkRelativePath(".g​it/config")).toContain("invisible");
  });

  it("still allows .gitignore and .github, which are ordinary files", () => {
    expect(checkRelativePath(".gitignore")).toBeNull();
    expect(checkRelativePath(".gitattributes")).toBeNull();
    expect(checkRelativePath(".github/workflows/ci.yml")).toBeNull();
  });

  it("rejects an NTFS alternate data stream", () => {
    expect(checkRelativePath("notes.md:evil")).toContain("colon");
    expect(checkRelativePath("notes.md::$DATA")).toContain("colon");
  });

  it("rejects a drive-RELATIVE Windows path, which is not 'absolute'", () => {
    // path.win32.isAbsolute("C:foo") === false. This is the CVE-2026-31802
    // class: the check everyone writes does not fire.
    expect(checkRelativePath("C:foo")).toContain("Windows drive letter");
  });

  it("rejects a bidi override that would disguise the filename", () => {
    // Trojan Source, CVE-2021-42574: the name a human reviews must be the name
    // the kernel opens.
    expect(checkRelativePath("a‮gnp.exe")).toContain("invisible");
    expect(checkRelativePath("﻿README.md")).toContain("invisible");
  });

  it.each([
    "CONIN$",
    "CONOUT$",
    "CLOCK$",
    "CONIN$.md",
  ])("rejects the device name %s that other libraries miss", (name) => {
    expect(checkRelativePath(name)).toContain("reserved device name");
  });

  it("allows LPT10, which is NOT a device", () => {
    // Negative control: the pattern must be `lpt[0-9]`, not `lpt\d+`.
    expect(checkRelativePath("LPT10.txt")).toBeNull();
  });

  it("does not go quadratic on a dots-and-spaces bomb", () => {
    // filenamify@7.0.2 takes 12.2s on this shape because its trailing-strip is
    // /[. ]+$/. Ours is a single-character `/[. ]$/`, which cannot backtrack.
    const bomb = `${". ".repeat(15_000)}x`;
    const started = performance.now();
    checkRelativePath(bomb);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("assertSafeTree — the choke point", () => {
  it("accepts a well-formed tree", () => {
    expect(() =>
      assertSafeTree([{ path: "PRD.md" }, { path: ".planning/ROADMAP.md" }])
    ).not.toThrow();
  });

  it("rejects the whole tree when any one path is unsafe", () => {
    expect(() =>
      assertSafeTree([{ path: "PRD.md" }, { path: "../../../etc/passwd" }])
    ).toThrow(ExportPathError);
  });

  it("treats a duplicate path as fatal, never as last-write-wins", () => {
    // Silently keeping one of two PRD.md entries means one of the documents the
    // founder is about to rely on has vanished with no signal.
    expect(() =>
      assertSafeTree([{ path: "PRD.md" }, { path: "PRD.md" }])
    ).toThrow(DUPLICATE_PATH_REASON);
  });

  it.each([
    ["README.md", "readme.md"],
    ["Notes.md", "NOTES.md"],
    ["straße.md", "strasse.md"],
    ["ﬁle.md", "file.md"],
    ["café.md", "café.md"],
  ])("treats %s and %s as the same file, because the filesystem will", (a, b) => {
    // Same bug as a duplicate, wearing a different spelling: on macOS and
    // Windows the second write destroys the first, and only on the founder's
    // laptop — never in CI. This is CVE-2026-23950 in node-tar.
    expect(() => assertSafeTree([{ path: a }, { path: b }])).toThrow(
      COLLISION_REASON
    );
  });

  it("does NOT collide Turkish dotted I with i", () => {
    // The fold must be aggressive, not wrong. `İ` and `i` are different files
    // everywhere, and refusing a legitimate tree is also a failure.
    expect(() =>
      assertSafeTree([{ path: "İstanbul.md" }, { path: "istanbul.md" }])
    ).not.toThrow();
  });

  it("accepts the real generated tree unchanged", () => {
    expect(() =>
      assertSafeTree([
        { path: "README.md" },
        { path: "PRD.md" },
        { path: "CLAUDE.md" },
        { path: "AGENTS.md" },
        { path: ".gitignore" },
        { path: ".gitattributes" },
        { path: ".planning/ROADMAP.md" },
        { path: ".planning/FACTS.md" },
        { path: ".planning/OPEN-QUESTIONS.md" },
        { path: ".planning/phases/01-problem-validation.md" },
      ])
    ).not.toThrow();
  });
});

describe("assertWithinRoot — the resolved-path layer", () => {
  it("accepts a child of the root", () => {
    expect(assertWithinRoot("/tmp/out", "/tmp/out/repo/PRD.md")).toBe(
      "/tmp/out/repo/PRD.md"
    );
  });

  it("accepts the root itself", () => {
    expect(assertWithinRoot("/tmp/out", "/tmp/out")).toBe("/tmp/out");
  });

  it("rejects a path that resolves above the root", () => {
    expect(() => assertWithinRoot("/tmp/out", "/tmp/out/../etc")).toThrow(
      ExportPathError
    );
  });

  it("rejects a sibling whose name merely starts with the root's name", () => {
    // The naive containment test is `child.startsWith(root)`, and it is wrong:
    // "/tmp/output-evil" starts with "/tmp/out".
    expect(() => assertWithinRoot("/tmp/out", "/tmp/output-evil/x")).toThrow(
      ExportPathError
    );
  });

  it("rejects an unrelated absolute path", () => {
    expect(() => assertWithinRoot("/tmp/out", "/etc/passwd")).toThrow(
      ExportPathError
    );
  });
});
