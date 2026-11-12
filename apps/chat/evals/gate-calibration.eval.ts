import { evalite } from "evalite";
import { getLanguageModel } from "@/lib/ai/providers";
import { config } from "@/lib/config";
import { PHASE_ONE } from "@/lib/phases/definitions";
import { evaluateGate } from "@/lib/phases/gate";
import {
  createModelGateJudge,
  type ModelUsage,
} from "@/lib/phases/model-adapters";
import { loadPersonaPrompt, loadPrompt } from "@/lib/phases/runtime";
import type { GateDecisionValue } from "@/lib/phases/types";
import { type GateFixture, PHASE_ONE_FIXTURES } from "./fixtures/gate-phase-01";

/**
 * STEP 4 — GATE CALIBRATION.
 *
 * The plan calls this the thing most likely to kill the project: a gate strict
 * enough to BE the product, permissive enough that a founder finishes eight
 * phases instead of churning at phase two. This file is the measurement.
 *
 * WHY EVALITE AND NOT PROMPTFOO (the plan named promptfoo):
 *  - The gate returns a three-valued ENUM, not prose. promptfoo's `llm-rubric`
 *    grades prose with a second model. Using it here would add a grader that
 *    drifts in order to measure a judge that drifts — the plan's own stated
 *    risk, imported voluntarily. Exact enum equality has no grader at all.
 *  - evalite is already a dependency, already wired to `.env.local` through
 *    evals/setup.ts, and already excluded from `test:unit` (which runs with all
 *    AI keys unset, deliberately).
 *  - Its sqlite history is the drift record Step 4 actually needs: the same
 *    fixtures re-run after a prompt or model change, compared to last time.
 * Revisit if we ever need to grade the assistant's PROSE (its refusal copy) —
 * that is a rubric job and promptfoo would earn its place there.
 *
 * MODEL: pinned to config.ai.workflows.chat, the same model the live gate uses.
 * Calibrating a model the product does not run would measure nothing. If these
 * numbers come out lenient, the first lever is raising THIS model, not editing
 * prompts.
 *
 * COST, measured rather than estimated (see the token totals this eval prints):
 * 12 fixtures x 2 runs = 24 judge calls = ~90,700 input + ~23,300 output
 * tokens, i.e. ~3,780 in / ~970 out per gate call. That per-call figure is the
 * one worth remembering: it is what every assessed founder turn costs.
 *
 * RESULTS as of 2026-08-19 on gpt-5.6-terra:
 *   no bad transcript advances  100%   (4/4 bad BLOCK on both runs)
 *   exact verdict               100%   (12/12)
 *   within band                 100%
 *   deterministic                92%   (11/12)
 * The single wobble is a GOOD fixture flipping PASS<->WARN between runs, and it
 * has moved fixture between runs — so it is a rate of about 1 in 12, not one
 * bad fixture. It has never flipped toward advance on a bad or mediocre
 * transcript, which is the direction that would matter.
 *
 * RESULTS as of 2026-11-12, after the judge started seeing document markers
 * (with the instruction that assistant-written documents are not founder
 * evidence): no bad transcript advances 100% (4/4), exact verdict 83% (10/12),
 * within band 83%, deterministic 92%. Cost 91,884 in / 25,224 out tokens. Both
 * misses are GOOD fixtures judged WARN instead of PASS on the advisory criterion
 * that interviewees independently described the same problem — stricter, never
 * toward advancing a weak transcript. Not yet separated from model drift since
 * August; an A/B run with and without the marker instruction would tell.
 */

const GATE_MODEL_ID = config.ai.workflows.chat;

/** Two runs of the identical input. Determinism is a scored property here. */
const RUNS_PER_FIXTURE = 2;

type FixtureResult = {
  id: string;
  band: GateFixture["band"];
  tests: string;
  expected: GateDecisionValue;
  acceptable: GateDecisionValue[];
  /** One entry per run, in order. */
  decisions: GateDecisionValue[];
  /** The verdict scored against `expected`. */
  decision: GateDecisionValue;
  deterministic: boolean;
  /** First run's reason — the sentence that names the rule that fired. */
  reason: string;
  missing: string[];
  /** Tokens this fixture cost across all of its runs. BYOK: the spend is the
   *  user's, and "is the gate worth what it costs" needs a meter to answer. */
  inputTokens: number;
  outputTokens: number;
};

async function runFixture(fixture: GateFixture): Promise<FixtureResult> {
  const model = await getLanguageModel(GATE_MODEL_ID);
  const usage: ModelUsage[] = [];
  const judge = createModelGateJudge({
    model,
    onUsage: (u) => usage.push(u),
  });
  const input = {
    phase: PHASE_ONE,
    personaPrompt: loadPersonaPrompt(),
    phasePrompt: loadPrompt(PHASE_ONE.promptFile),
    transcript: fixture.transcript,
    facts: fixture.facts,
  };

  const decisions: GateDecisionValue[] = [];
  let firstReason = "";
  let firstMissing: string[] = [];

  // Sequential on purpose: two concurrent identical calls can share a provider
  // cache and agree for the wrong reason, which would score as determinism the
  // product does not have.
  for (let i = 0; i < RUNS_PER_FIXTURE; i++) {
    const verdict = await evaluateGate({ judge }, input);
    decisions.push(verdict.decision);
    if (i === 0) {
      firstReason = verdict.reason;
      firstMissing = verdict.missing;
    }
  }

  return {
    id: fixture.id,
    band: fixture.band,
    tests: fixture.tests,
    expected: fixture.expected,
    acceptable: fixture.acceptable,
    decisions,
    decision: decisions[0] as GateDecisionValue,
    deterministic: new Set(decisions).size === 1,
    reason: firstReason,
    missing: firstMissing,
    inputTokens: usage.reduce((n, u) => n + (u.inputTokens ?? 0), 0),
    outputTokens: usage.reduce((n, u) => n + (u.outputTokens ?? 0), 0),
  };
}

evalite<GateFixture, FixtureResult, GateDecisionValue>(
  `Gate calibration — phase 1 (${GATE_MODEL_ID})`,
  {
    data: async () =>
      PHASE_ONE_FIXTURES.map((fixture) => ({
        input: fixture,
        expected: fixture.expected,
      })),
    task: runFixture,
    scorers: [
      {
        name: "Exact verdict",
        description:
          "The gate returned exactly the verdict this transcript should produce.",
        scorer: ({ output }) => (output.decision === output.expected ? 1 : 0),
      },
      {
        name: "Within band",
        description:
          "The verdict is at least defensible for this transcript. Anything below 1 here is a calibration failure, not a wobble.",
        scorer: ({ output }) =>
          output.acceptable.includes(output.decision) ? 1 : 0,
      },
      {
        name: "Deterministic",
        description:
          "The same transcript judged twice produced the same verdict.",
        scorer: ({ output }) => (output.deterministic ? 1 : 0),
      },
      {
        name: "No bad transcript advances",
        description:
          "THE PRODUCT PROPERTY. A `bad` fixture must BLOCK on every run. Scored 1 for non-bad fixtures so the number reads as a pass rate over the bad band.",
        scorer: ({ output }) => {
          if (output.band !== "bad") {
            return 1;
          }
          return output.decisions.every((d) => d === "BLOCK") ? 1 : 0;
        },
      },
    ],
  }
);
