import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeHandoffWriter, ExportWriteError } from "./node-writer";
import { ExportPathError } from "./paths";
import type { HandoffPlan } from "./types";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONLY TESTS IN lib/export THAT TOUCH A REAL DISK.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Everything else in this directory is pure and runs with no filesystem. These
 * exist because two of the failure modes the writer defends against are
 * INVISIBLE to a pure test — a symlink is not a string, and `git init`
 * preserving a pre-existing `.git/hooks/` is not a string either. Both were
 * found by an adversarial review that demonstrated them working, so both get a
 * regression test that would fail if the guard were removed.
 */

/** git is present in this repo's toolchain; skip cleanly if a CI image lacks it. */
function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const GIT_AVAILABLE = hasGit();

const FULL_SHA = /^[0-9a-f]{40}$/;

let target: string;

beforeEach(async () => {
  target = await mkdtemp(join(tmpdir(), "idea-check-export-test-"));
});

afterEach(async () => {
  await rm(target, { recursive: true, force: true });
});

function plan(overrides: Partial<HandoffPlan> = {}): HandoffPlan {
  return {
    repoName: "demo-repo",
    files: [
      { path: "README.md", contents: "# Demo\n" },
      { path: ".planning/ROADMAP.md", contents: "# Roadmap\n" },
    ],
    commitMessage: "Initial handoff export\n\nGenerated.",
    readiness: {
      level: "partial",
      passedPhaseKeys: [],
      phaseCount: 8,
      factCount: 1,
      reason: "1 fact.",
    },
    notEstablishedKeys: [],
    lowConfidenceKeys: [],
    unrecognizedKeys: [],
    ...overrides,
  };
}

describe("createNodeHandoffWriter — the happy path", () => {
  it("writes every file under the repo directory", async () => {
    const result = await createNodeHandoffWriter()({
      targetDir: target,
      plan: plan(),
    });

    expect(result.repoDir).toBe(join(target, "demo-repo"));
    expect(result.written).toEqual(["README.md", ".planning/ROADMAP.md"]);
    await expect(
      readFile(join(result.repoDir, "README.md"), "utf8")
    ).resolves.toBe("# Demo\n");
    await expect(
      readFile(join(result.repoDir, ".planning/ROADMAP.md"), "utf8")
    ).resolves.toBe("# Roadmap\n");
  });

  it.skipIf(!GIT_AVAILABLE)(
    "produces one commit on main, authored by the export",
    async () => {
      const result = await createNodeHandoffWriter()({
        targetDir: target,
        plan: plan(),
      });

      expect(result.git.status).toBe("committed");
      if (result.git.status !== "committed") {
        return;
      }
      expect(result.git.branch).toBe("main");
      expect(result.git.sha).toMatch(FULL_SHA);

      const show = execFileSync(
        "git",
        ["log", "--format=%H%n%an%n%ae%n%s", "-1"],
        { cwd: result.repoDir, encoding: "utf8" }
      )
        .trim()
        .split("\n");
      expect(show[0]).toBe(result.git.sha);
      expect(show[1]).toBe("idea-check export");
      expect(show[3]).toBe("Initial handoff export");

      const status = execFileSync("git", ["status", "--porcelain"], {
        cwd: result.repoDir,
        encoding: "utf8",
      });
      // Nothing left unstaged means every generated file made it into the commit.
      expect(status.trim()).toBe("");
    }
  );
});

describe("createNodeHandoffWriter — fail-closed", () => {
  it("refuses a non-empty repo directory rather than mixing into it", async () => {
    const repoDir = join(target, "demo-repo");
    await createNodeHandoffWriter()({ targetDir: target, plan: plan() });

    await expect(
      createNodeHandoffWriter()({ targetDir: target, plan: plan() })
    ).rejects.toThrow(ExportWriteError);
    // ...and the first export is still intact.
    await expect(readFile(join(repoDir, "README.md"), "utf8")).resolves.toBe(
      "# Demo\n"
    );
  });

  it("refuses an empty target directory path", async () => {
    await expect(
      createNodeHandoffWriter()({ targetDir: "   ", plan: plan() })
    ).rejects.toThrow(ExportWriteError);
  });

  it("REFUSES a plan containing a .git path — the RCE guard", async () => {
    // Verified attack: the writer puts files down BEFORE `git init`, and
    // `git init` preserves an existing .git/hooks/, so this file would execute
    // during the export's own first commit. --no-verify does not cover
    // post-commit. Rejected before anything is written.
    await expect(
      createNodeHandoffWriter()({
        targetDir: target,
        plan: plan({
          files: [
            { path: "README.md", contents: "# Demo\n" },
            {
              path: ".git/hooks/post-commit",
              contents: "#!/bin/sh\ntouch /tmp/pwned\n",
            },
          ],
        }),
      })
    ).rejects.toThrow(ExportPathError);
  });
});

describe("createNodeHandoffWriter — symlinks, which no string check can see", () => {
  it("does not write through a symlinked file out of the repo", async () => {
    // Every containment check in paths.ts is string arithmetic, and a string is
    // blind to a link. Plant `repo/README.md -> outside/victim.md` and the
    // default writeFile flag ('w') follows it and overwrites the victim.
    const repoDir = join(target, "demo-repo");
    await createNodeHandoffWriter()({
      targetDir: target,
      plan: plan({ files: [{ path: "keep.md", contents: "x\n" }] }),
    });
    await rm(join(repoDir, "keep.md"));
    await writeFile(join(target, "victim.md"), "ORIGINAL\n", "utf8");
    await symlink(join(target, "victim.md"), join(repoDir, "README.md"));

    await createNodeHandoffWriter()({
      targetDir: target,
      plan: plan({ files: [{ path: "README.md", contents: "REPLACED\n" }] }),
      overwrite: true,
    });

    // The victim outside the repo is untouched; the link was replaced by a real
    // file inside the repo.
    await expect(readFile(join(target, "victim.md"), "utf8")).resolves.toBe(
      "ORIGINAL\n"
    );
    await expect(readFile(join(repoDir, "README.md"), "utf8")).resolves.toBe(
      "REPLACED\n"
    );
  });

  it("refuses when a DIRECTORY component is a symlink out of the repo", async () => {
    // `flag: "wx"` only protects the final component. A symlinked parent needs
    // the realpath check.
    const repoDir = join(target, "demo-repo");
    await createNodeHandoffWriter()({
      targetDir: target,
      plan: plan({ files: [{ path: "keep.md", contents: "x\n" }] }),
    });
    await rm(join(repoDir, ".planning"), { recursive: true, force: true });
    await writeFile(join(target, "marker"), "", "utf8");
    await symlink(target, join(repoDir, ".planning"), "dir");

    await expect(
      createNodeHandoffWriter()({
        targetDir: target,
        plan: plan({
          files: [{ path: ".planning/ROADMAP.md", contents: "escaped\n" }],
        }),
        overwrite: true,
      })
    ).rejects.toThrow(ExportPathError);
  });
});
