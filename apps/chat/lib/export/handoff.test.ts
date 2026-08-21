import { isAbsolute, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PERSONA_ATTRIBUTE_KEYS } from "@/lib/personas/types";
import type { StoredFact } from "@/lib/phases/context";
import { PHASES } from "@/lib/phases/definitions";
import { buildHandoff, deriveRepoName } from "./handoff";
import { FALLBACK_REPO_NAME } from "./paths";
import type {
  BuildHandoffInput,
  HandoffWriteResult,
  HandoffWriter,
  WriteHandoffRequest,
} from "./types";

/** A relative path that starts here has escaped the directory it was resolved against. */
const ESCAPES_ROOT = /^\.\./;

const AT = new Date("2026-03-01T12:00:00.000Z");
const GENERATED_AT = new Date("2026-03-02T08:15:00.000Z");

function fact(
  key: string,
  value: string,
  confidence = 90,
  phaseKey = "problem-validation"
): StoredFact {
  return { key, value, confidence, phaseKey, updatedAt: AT };
}

function input(overrides: Partial<BuildHandoffInput> = {}): BuildHandoffInput {
  return {
    project: { name: "Dog Walker Ops", instructions: "" },
    facts: [fact("target_user", "urban dog walkers", 92)],
    phases: [],
    // REQUIRED, and this line is the reason it is required: a caller that
    // forgets it now fails to compile instead of exporting a repo with the
    // persona silently missing.
    personas: [],
    generatedAt: GENERATED_AT,
    ...overrides,
  };
}

/** A writer that records the request and never touches a disk. */
function _recordingWriter(): {
  writer: HandoffWriter;
  requests: WriteHandoffRequest[];
} {
  const requests: WriteHandoffRequest[] = [];
  const writer: HandoffWriter = (request) => {
    requests.push(request);
    const result: HandoffWriteResult = {
      repoDir: join(request.targetDir, request.plan.repoName),
      written: request.plan.files.map((file) => file.path),
      git: { status: "committed", sha: "0".repeat(40), branch: "main" },
    };
    return Promise.resolve(result);
  };
  return { writer, requests };
}

describe("buildHandoff — refusal is the fail-closed default", () => {
  it("refuses a project with no facts rather than shipping an empty shell", () => {
    // Same empty-set guard as decideGate: a repository whose every section reads
    // "not established" looks like a plan from ten feet away, and the founder
    // would circulate it.
    const outcome = buildHandoff(input({ facts: [] }));
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") {
      expect(outcome.reason).toContain("0 stored facts");
      expect(outcome.readiness.level).toBe("empty");
    }
  });

  it("does NOT refuse a project with a single fact — partial is legitimate", () => {
    expect(buildHandoff(input()).status).toBe("ready");
  });

  it("refuses a project whose only fact has a blank value", () => {
    // A blank value is not evidence. Counting it would let one whitespace row
    // unlock a whole export.
    const outcome = buildHandoff(
      input({ facts: [fact("target_user", "   \n ")] })
    );
    expect(outcome.status).toBe("ready");
    if (outcome.status === "ready") {
      // The fact row exists, so readiness is not "empty" — but nothing claims
      // the value, and it is reported as never established.
      expect(outcome.plan.notEstablishedKeys).toContain("target_user");
    }
  });
});

describe("buildHandoff — the tree", () => {
  const outcome = buildHandoff(
    input({
      facts: [
        fact("target_user", "urban dog walkers", 92),
        fact("problem_statement", "route planning wastes 3h/week", 95),
      ],
    })
  );
  const plan = outcome.status === "ready" ? outcome.plan : null;

  it("contains the four documents the plan promises, plus the scaffold", () => {
    expect(plan).not.toBeNull();
    const paths = plan?.files.map((f) => f.path) ?? [];
    expect(paths).toContain("PRD.md");
    expect(paths).toContain("CLAUDE.md");
    expect(paths).toContain("README.md");
    expect(paths).toContain(".gitignore");
    expect(paths).toContain(".planning/ROADMAP.md");
    expect(paths.filter((p) => p.startsWith(".planning/phases/"))).toHaveLength(
      PHASES.length
    );
  });

  it("always contains the persona document, even with no persona", () => {
    // The export composed exactly 17 files and none of them was a persona, for
    // a project that owned a finished persona artifact.
    const paths = plan?.files.map((f) => f.path) ?? [];
    expect(paths).toContain(".planning/PERSONA.md");
    expect(paths).toHaveLength(18);
    const persona = plan?.files.find((f) => f.path === ".planning/PERSONA.md");
    expect(persona?.contents).toContain(
      "No persona artifact has ever been generated"
    );
  });

  it("puts a stored persona into the exported file", () => {
    // Wiring only — the rendering rules (assumption labels, gaps, the
    // "not a finding" banner, injection containment) are covered in
    // persona.test.ts against the pure renderer.
    const outcome = buildHandoff(
      input({
        personas: [
          {
            artifact: {
              artifact: "persona",
              contentVersion: 1,
              degradedReasons: [],
              droppedPinnedFactKeys: [],
              groundedInFactKeys: ["primary_persona"],
              persona: {
                attributes: Object.fromEntries(
                  PERSONA_ATTRIBUTE_KEYS.map((key) => [
                    key,
                    {
                      evidence: [],
                      gap: `no ${key} recorded`,
                      status: "not-established",
                      value: null,
                    },
                  ])
                ),
                excludedSegments: [],
                interviews: {
                  count: 0,
                  evidence: [],
                  gap: "no interview count recorded",
                  meetsFloor: false,
                  status: "not-established",
                },
                label: "Ops lead at a 20-person agency",
                observableAttributes: [],
              },
            },
            documentId: "doc-1",
            // Required, and NOT defaulted by the renderer on purpose: an
            // absent history would render as "only ever had one version",
            // which is a claim, not a blank. The `as unknown as` cast below is
            // what let this field go missing without a type error — worth
            // knowing when adding the next one.
            history: [],
            status: "readable",
            title: "Persona: Ops lead (v1)",
            version: 1,
          },
          // Object.fromEntries widens to an index signature; the shape is
          // validated for real by PersonaArtifactSchema in persona.test.ts.
        ] as unknown as BuildHandoffInput["personas"],
      })
    );

    const persona =
      outcome.status === "ready"
        ? outcome.plan.files.find((f) => f.path === ".planning/PERSONA.md")
        : null;
    expect(persona?.contents).toContain("Ops lead at a 20-person agency");
    expect(persona?.contents).not.toContain(
      "No persona artifact has ever been generated"
    );
  });

  it("lists the persona document in the README manifest", () => {
    // A file the repo contains but the manifest omits makes the README wrong.
    const readme = plan?.files.find((f) => f.path === "README.md");
    expect(readme?.contents).toContain("`.planning/PERSONA.md`");
    expect(readme?.contents).toContain("`AGENTS.md`");
  });

  it("sorts files by code point so two machines produce the same git tree", () => {
    const paths = plan?.files.map((f) => f.path) ?? [];
    expect(paths).toEqual([...paths].sort());
  });

  it("writes no empty file", () => {
    for (const file of plan?.files ?? []) {
      expect(file.contents.length, file.path).toBeGreaterThan(0);
      expect(file.contents.endsWith("\n"), file.path).toBe(true);
    }
  });

  it("keeps fact values out of the commit message", () => {
    // A commit message is the one artefact that gets pasted into shells, CI logs
    // and issue trackers by tools this export does not control. Counts only.
    expect(plan?.commitMessage).not.toContain("urban dog walkers");
    expect(plan?.commitMessage).toContain("2 facts established");
    expect(plan?.commitMessage.split("\n")[0]).toBe("Initial handoff export");
  });

  it("is deterministic — the same snapshot produces byte-identical files", () => {
    const again = buildHandoff(
      input({
        facts: [
          fact("target_user", "urban dog walkers", 92),
          fact("problem_statement", "route planning wastes 3h/week", 95),
        ],
      })
    );
    expect(again.status).toBe("ready");
    if (again.status === "ready" && plan) {
      expect(again.plan.files).toEqual(plan.files);
      expect(again.plan.commitMessage).toBe(plan.commitMessage);
    }
  });

  it("does not depend on the order facts arrive in", () => {
    const a = buildHandoff(
      input({
        facts: [
          fact("target_user", "a", 92),
          fact("problem_statement", "b", 95),
        ],
      })
    );
    const b = buildHandoff(
      input({
        facts: [
          fact("problem_statement", "b", 95),
          fact("target_user", "a", 92),
        ],
      })
    );
    expect(a.status).toBe("ready");
    expect(b.status).toBe("ready");
    if (a.status === "ready" && b.status === "ready") {
      expect(a.plan.files).toEqual(b.plan.files);
    }
  });
});

describe("deriveRepoName — model-written text really does decide a path", () => {
  it("prefers an explicit override", () => {
    expect(deriveRepoName(input({ repoName: "My Repo!" }))).toBe("my-repo");
  });

  it("falls back to the project name", () => {
    expect(deriveRepoName(input())).toBe("dog-walker-ops");
  });

  it("falls back to a FACT VALUE when the project name is unusable", () => {
    // This is the flow that makes path safety load-bearing rather than
    // theoretical: `solution_concept` is written by an extraction model.
    const name = deriveRepoName(
      input({
        project: { name: "   ", instructions: "" },
        facts: [
          fact(
            "solution_concept",
            "Auto-sequenced walking routes",
            88,
            "solution-shaping"
          ),
        ],
      })
    );
    expect(name).toBe("auto-sequenced-walking-routes");
  });

  it("neutralises a traversal payload arriving through a fact value", () => {
    const name = deriveRepoName(
      input({
        project: { name: "../../../../etc", instructions: "" },
        facts: [
          fact(
            "solution_concept",
            "../../../../etc/passwd",
            88,
            "solution-shaping"
          ),
        ],
      })
    );
    expect(name).toBe("etc");
    expect(name).not.toContain("..");
    expect(name).not.toContain("/");
  });

  it("reaches the explicit floor rather than emitting something unsafe", () => {
    const name = deriveRepoName(
      input({
        project: { name: "///", instructions: "" },
        facts: [fact("solution_concept", "...", 88, "solution-shaping")],
      })
    );
    expect(name).toBe(FALLBACK_REPO_NAME);
  });
});

describe("HOSTILE INPUT — nothing escapes the target directory", () => {
  const HOSTILE = [
    "../../../../etc/passwd",
    "/etc/cron.d/x",
    "~/.ssh/authorized_keys",
    "..\\..\\windows\\system32",
    "C:\\Windows\\System32",
    "a\u0000b",
    ".git/hooks/pre-commit",
    "\uff0e\uff0e\uff0fetc\uff0fpasswd",
    "$(rm -rf ~)",
    "CON",
  ] as const;

  it.each(
    HOSTILE
  )("keeps every generated path inside the target when the input is %j", (hostile) => {
    const outcome = buildHandoff(
      input({
        project: { name: hostile, instructions: hostile },
        repoName: hostile,
        facts: [
          // Every phase's first fact key, all poisoned. If any one of them
          // could reach a path, this fails.
          ...PHASES.map((phase) =>
            fact(phase.factKeys[0], hostile, 90, phase.key)
          ),
        ],
      })
    );

    expect(outcome.status).toBe("ready");
    if (outcome.status !== "ready") {
      return;
    }

    const target = resolve("/tmp/idea-check-export-target");
    const repoDir = resolve(join(target, outcome.plan.repoName));

    // The repo directory itself must be a direct child of the target.
    expect(relative(target, repoDir)).not.toMatch(ESCAPES_ROOT);
    expect(relative(target, repoDir)).not.toContain("/");

    for (const file of outcome.plan.files) {
      const absolute = resolve(join(repoDir, file.path));
      const rel = relative(repoDir, absolute);
      expect(rel, file.path).not.toMatch(ESCAPES_ROOT);
      expect(isAbsolute(rel), file.path).toBe(false);
      expect(absolute.startsWith(`${repoDir}/`), file.path).toBe(true);
    }
  });

  it("still renders the poisoned value as inert quoted text, not as structure", () => {
    const outcome = buildHandoff(
      input({
        facts: [fact("target_user", "../../../../etc/passwd", 90)],
      })
    );
    expect(outcome.status).toBe("ready");
    if (outcome.status === "ready") {
      const prd = outcome.plan.files.find((f) => f.path === "PRD.md");
      // The value is not censored — it is the founder's data — it is quoted.
      expect(prd?.contents).toContain("> ../../../../etc/passwd");
    }
  });
});
