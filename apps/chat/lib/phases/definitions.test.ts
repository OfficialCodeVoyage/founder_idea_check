import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FIRST_PHASE_KEY,
  getNextPhase,
  getPhaseByKey,
  getPhaseByOrder,
  PHASES,
} from "./definitions";
import { PHASE_COUNT, PhaseDefinitionSchema } from "./types";

/**
 * Resolved from this file, NOT from process.cwd(): runtime.ts can rely on cwd
 * because Next always runs from apps/chat, but a test runner may be invoked from
 * the monorepo root. lib/phases -> ../.. -> apps/chat.
 */
const PROMPTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "prompts"
);

/** Same stripping the loader applies before the text reaches the model. */
function stripComments(markdown: string): string {
  return markdown.replace(/<!--[\s\S]*?-->/g, "").trim();
}

function readPhasePrompt(relPath: string): string {
  return readFileSync(join(PROMPTS_DIR, relPath), "utf8");
}

/**
 * ~4 chars per token, the repo's own heuristic (lib/ai/token-utils.test.ts).
 * The persona block is already ~1,750 tokens on every turn; a phase brief over
 * this would put the standing system prompt past ~4k before a single fact is
 * injected. Not a style rule — a budget.
 */
const MAX_PROMPT_CHARS = 6000;

/** The gate, not the model, decides advance — every brief must say so. */
const RE_NO_SELF_ADVANCE = /may not advance the founder/i;

describe("the eight phase definitions", () => {
  it("has exactly PHASE_COUNT phases", () => {
    expect(PHASES).toHaveLength(PHASE_COUNT);
  });

  it("has orders 1..8, unique and contiguous", () => {
    const orders = PHASES.map((p) => p.order);

    expect(orders).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(orders).size).toBe(PHASE_COUNT);
  });

  it("has unique phase keys", () => {
    const keys = PHASES.map((p) => p.key);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("starts at problem validation", () => {
    expect(FIRST_PHASE_KEY).toBe("problem-validation");
    expect(getPhaseByOrder(1)?.key).toBe(FIRST_PHASE_KEY);
  });

  it("still validates against PhaseDefinitionSchema", () => {
    for (const phase of PHASES) {
      expect(() => PhaseDefinitionSchema.parse(phase)).not.toThrow();
    }
  });
});

describe("exit criteria", () => {
  it("gives every phase at least one criterion", () => {
    for (const phase of PHASES) {
      expect(phase.exitCriteria.length).toBeGreaterThan(0);
    }
  });

  it("keeps criterion ids unique within a phase", () => {
    for (const phase of PHASES) {
      const ids = phase.exitCriteria.map((c) => c.id);

      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("gives every phase at least one BLOCKING criterion", () => {
    for (const phase of PHASES) {
      const blocking = phase.exitCriteria.filter(
        (c) => c.severity === "blocking"
      );

      expect(blocking.length).toBeGreaterThan(0);
    }
  });

  /**
   * The gate judge only ever sees a transcript and the fact store. It cannot
   * verify that another phase completed, and there is no validator registry for
   * `custom`. Either type would be an unanswerable criterion — which, with
   * tolerateBlockingPartials at 0, is a permanent BLOCK.
   */
  it("uses no unjudgeable criterion type", () => {
    for (const phase of PHASES) {
      for (const criterion of phase.exitCriteria) {
        expect(criterion.type).not.toBe("phase-completed");
        expect(criterion.type).not.toBe("custom");
      }
    }
  });

  it("says what does not satisfy it, in a description long enough to judge", () => {
    for (const phase of PHASES) {
      for (const criterion of phase.exitCriteria) {
        expect(criterion.description.length).toBeGreaterThan(40);
      }
    }
  });
});

describe("criteria are answerable — the fact vocabulary lines up", () => {
  /**
   * The extractor may only write keys listed in phase.factKeys (sanitizeFacts).
   * A criterion naming a key outside that list demands a fact that can never be
   * stored: the founder answers correctly and the gate blocks anyway.
   */
  it("names only fact keys the phase's extractor may write", () => {
    for (const phase of PHASES) {
      const vocabulary = new Set(phase.factKeys);

      for (const criterion of phase.exitCriteria) {
        if (criterion.type === "artifact-exists") {
          expect(
            vocabulary.has(criterion.factKey),
            `${phase.key}/${criterion.id} needs "${criterion.factKey}"`
          ).toBe(true);
        }
        if (criterion.type === "metric-threshold") {
          expect(
            vocabulary.has(criterion.metric),
            `${phase.key}/${criterion.id} needs "${criterion.metric}"`
          ).toBe(true);
        }
      }
    }
  });

  /**
   * ProjectFact is UNIQUE (projectId, key). A key claimed by two phases would
   * let the later phase's extractor overwrite the earlier phase's fact through
   * the same upsert conflict target.
   */
  it("keeps fact vocabularies disjoint across phases", () => {
    const owner = new Map<string, string>();

    for (const phase of PHASES) {
      for (const key of phase.factKeys) {
        const previous = owner.get(key);

        expect(
          previous,
          `fact key "${key}" is claimed by both ${previous} and ${phase.key}`
        ).toBeUndefined();
        owner.set(key, phase.key);
      }
    }
  });

  it("keeps requirement ids unique across the whole workflow", () => {
    const seen = new Set<string>();

    for (const phase of PHASES) {
      for (const criterion of phase.exitCriteria) {
        if (criterion.type === "requirement-satisfied") {
          expect(seen.has(criterion.requirementId)).toBe(false);
          seen.add(criterion.requirementId);
        }
      }
    }
  });
});

describe("gate configuration", () => {
  it("never tolerates a blocking criterion sitting at partial", () => {
    for (const phase of PHASES) {
      expect(phase.gate.tolerateBlockingPartials).toBe(0);
      expect(phase.gate.enabled).toBe(true);
    }
  });
});

describe("prompt files", () => {
  /** The classic missing-prompt 500: readFileSync throws, the route dies. */
  it("exists on disk for every phase", () => {
    for (const phase of PHASES) {
      expect(() => readPhasePrompt(phase.promptFile)).not.toThrow();
    }
  });

  it("has content left after the provenance comments are stripped", () => {
    for (const phase of PHASES) {
      const body = stripComments(readPhasePrompt(phase.promptFile));

      expect(body.length).toBeGreaterThan(500);
    }
  });

  it("stays inside the per-turn token budget", () => {
    for (const phase of PHASES) {
      const body = stripComments(readPhasePrompt(phase.promptFile));

      expect(
        body.length,
        `${phase.promptFile} is ${body.length} chars`
      ).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    }
  });

  it("announces its own position in the workflow", () => {
    for (const phase of PHASES) {
      const body = stripComments(readPhasePrompt(phase.promptFile));

      expect(body).toContain(`Phase ${phase.order} of ${PHASE_COUNT}`);
    }
  });

  it("tells the model it may not advance the founder itself", () => {
    for (const phase of PHASES) {
      const body = stripComments(readPhasePrompt(phase.promptFile));

      expect(body).toMatch(RE_NO_SELF_ADVANCE);
    }
  });

  /** Two phases must not accidentally point at the same brief. */
  it("is a distinct file per phase", () => {
    const files = PHASES.map((p) => p.promptFile);

    expect(new Set(files).size).toBe(files.length);
  });
});

describe("lookup helpers", () => {
  it("finds a phase by key and by order", () => {
    for (const phase of PHASES) {
      expect(getPhaseByKey(phase.key)).toBe(phase);
      expect(getPhaseByOrder(phase.order)).toBe(phase);
    }
  });

  it("returns undefined for keys and orders that do not exist", () => {
    expect(getPhaseByKey("fundraising")).toBeUndefined();
    expect(getPhaseByOrder(0)).toBeUndefined();
    expect(getPhaseByOrder(PHASE_COUNT + 1)).toBeUndefined();
  });

  /**
   * EVERY PHASE MUST HAVE SOMETHING THE INTERVIEW CAN ACTUALLY CLOSE.
   *
   * A phase whose blocking criteria ALL need fieldwork has no move available in
   * conversation at all — the interviewer would have nothing to ask on the first
   * turn, and the founder would be told to go and do fieldwork before the phase
   * had established what the fieldwork was for. Phase 4 is the tight case and
   * the reason `pre-registered-threshold` is classified in-conversation: stating
   * the threshold BEFORE the test is the one thing a founder can do at a desk,
   * and it is the thing that makes the eventual result mean anything.
   */
  it("gives every phase at least one blocking criterion closable in conversation", () => {
    for (const phase of PHASES) {
      const answerable = phase.exitCriteria.filter(
        (c) => c.severity === "blocking" && c.closure === "in-conversation"
      );
      expect(
        answerable.length,
        `phase ${phase.order} (${phase.key}) has no blocking criterion a founder can close by answering`
      ).toBeGreaterThan(0);
    }
  });

  it("classifies every criterion explicitly rather than by default", () => {
    // The schema defaults `closure` to in-conversation, which is the fail-closed
    // direction — but a phase that simply forgot to classify would then quietly
    // re-acquire the deadlock. Every criterion states it.
    for (const phase of PHASES) {
      for (const c of phase.exitCriteria) {
        expect(["in-conversation", "offline-only"]).toContain(c.closure);
      }
    }
  });

  it("walks the whole workflow in order and stops at the end", () => {
    const walked: string[] = [];
    let current = getPhaseByKey(FIRST_PHASE_KEY);

    while (current) {
      walked.push(current.key);
      current = getNextPhase(current.key);
    }

    expect(walked).toEqual(PHASES.map((p) => p.key));
    expect(getNextPhase("go-to-market")).toBeUndefined();
    expect(getNextPhase("not-a-phase")).toBeUndefined();
  });
});
