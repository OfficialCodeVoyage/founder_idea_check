/**
 * The PURE half of the FOUNDER-ASSERTED fact write path: what a founder is
 * allowed to put into the ledger by hand, and what that assertion is worth.
 *
 * Split out of phase-queries.ts for exactly the reason fact-upsert.ts was —
 * phase-queries transitively imports `server-only`, so a test cannot import it
 * at all. The rules here decide whether a claim enters the ledger the gate
 * reads, which is the last place in this codebase that should be untested. No
 * db handle, no `server-only`, no network, no clock.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS PATH EXISTS AT ALL
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every fact in the live database was extractor-written; not one row has
 * `origin = 'founder'` from anything but a correction. Since the gate learned
 * to classify a criterion as `offline-only` (lib/phases/gate.ts,
 * `instrumentQuestion`), it stops asking a founder for numbers they cannot have
 * and asks instead for the INSTRUMENT — who you will talk to, how many, what
 * you will ask, and the pass/fail threshold fixed before any data arrives. That
 * left the obvious hole: the founder goes and runs it, and there is no way back
 * in. Their only route was pasting five field logs into chat and hoping the
 * extractor guessed right.
 *
 * The file that owns the correction path (app/actions/correct-fact.ts) used to
 * say a "new fact" button is laundering in its purest form — a claim with no
 * turn behind it, entering the ledger the gate reads. That objection is real
 * and this module is the answer to it, not a waiver of it:
 *
 *   - the key must be one the phase's own extractor could have written, so the
 *     founder cannot invent vocabulary the criteria do not use;
 *   - `origin` is 'founder', so `renderFacts` tells the JUDGE ", asserted by
 *     the founder, not extracted" and it can be weighed as the weaker evidence
 *     it is;
 *   - the confidence is fixed HERE and is not readable from the input, so
 *     nobody types their way past their own gate;
 *   - and an assertion can never overwrite an extracted fact (see
 *     `assertProjectFact` in phase-queries.ts).
 *
 * Nothing here advances a phase. The gate still judges, and still refuses.
 */
import { MIN_FACT_CONFIDENCE } from "../phases/extract";
import { FACT_KEY_PATTERN } from "../phases/types";

/** Matches the correction path's limit, which matches `value`'s realistic use. */
export const MAX_ASSERTED_FACT_VALUE = 2000;

/**
 * THE CONFIDENCE EVERY FOUNDER-ASSERTED FACT CARRIES, DECIDED BY THE SYSTEM.
 *
 * `MIN_FACT_CONFIDENCE` is the score below which the extractor discards a fact
 * as noise — the extraction prompt says in as many words that "a survey answer
 * or 'people would love this' scores below it and will be discarded". A
 * founder's own assertion enters at exactly that floor: the weakest standing
 * anything in this ledger is permitted to have, and strictly below the 50 an
 * extracted fact defaults to, so an assertion can never outrank an extraction
 * of the same claim.
 *
 * IMPORTED, NOT COPIED, so the two cannot drift. If the extractor's floor moves
 * the assertion floor moves with it, and the sentence above stays true.
 *
 * A KNOWN AWKWARDNESS, RECORDED RATHER THAN HIDDEN: `confidence` is documented
 * everywhere else — including in every exported FACTS.md — as "the extractor's
 * own certainty at the moment it recorded the fact", and for these rows no
 * extractor ever ran. The column is NOT NULL and there is no migration in this
 * work, so the row must carry some number. 40 is the least misleading one
 * available, and `renderFacts` prints the founder annotation directly beside it
 * so the judge never sees the number unqualified.
 */
export const FOUNDER_ASSERTION_CONFIDENCE = MIN_FACT_CONFIDENCE;

declare const FOUNDER_FACT_WRITE: unique symbol;

/**
 * The insert payload for one founder-asserted fact.
 *
 * BRANDED ON PURPOSE. The brand is uninhabitable outside this module, so
 * `planFactAssertion` is the only thing in the program that can produce one of
 * these — and it is the only thing that sets `confidence`. A caller who wanted
 * to smuggle a confidence in would have to hand-build this object, and the type
 * refuses it at compile time (fact-assertion.test.ts pins that with a
 * `@ts-expect-error`). The read-only path stays read-only structurally, not by
 * everyone remembering to.
 */
export type FounderFactWrite = {
  readonly key: string;
  readonly phaseKey: string;
  readonly value: string;
  readonly confidence: number;
  readonly [FOUNDER_FACT_WRITE]: true;
};

/**
 * Why an assertion was refused. Each names a specific thing, because a refusal
 * that says "invalid input" is the failure mode this whole product is a
 * reaction to.
 */
export type AssertionRefusal =
  | "key-not-permitted"
  | "value-blank"
  | "value-too-long";

/**
 * THE HOUSE IDIOM: the refused arm carries NO WRITE PAYLOAD.
 *
 * Not a write with a zero confidence, not one with an empty key — nothing a
 * caller could read a value off. Six separate bugs in this codebase were all a
 * zero standing in for an unknown, so "this assertion is not going to be
 * stored" is a state with no storable fields at all. Same shape as
 * `GateVerdictView` in lib/phases/rail.ts and `AttemptDetail` in
 * lib/phases/attempt-history.ts.
 */
export type FactAssertionPlan =
  | { ok: true; write: FounderFactWrite }
  | { ok: false; reason: AssertionRefusal; detail: string };

/**
 * Only what the plan needs to know about a phase: which key vocabulary it owns.
 * Structural rather than `PhaseDefinition` so a test can state the two fields
 * it cares about instead of building a whole phase.
 */
export type AssertionPhase = {
  key: string;
  factKeys: readonly string[];
};

function refuse(reason: AssertionRefusal, detail: string): FactAssertionPlan {
  return { ok: false, reason, detail };
}

/**
 * PURE. Decides whether one hand-entered fact may be written, and with what.
 *
 * `key` and `value` are typed `unknown` deliberately. This is the boundary a
 * form post arrives at, and typing it as `string` would only mean the lie is
 * told one frame earlier.
 *
 * The key is normalized the SAME WAY `sanitizeFacts` normalizes an extracted
 * one — trim, lowercase, then `FACT_KEY_PATTERN` — so the two write paths
 * cannot disagree about whether `Interview_Count` and `interview_count` are the
 * same fact. They share a UNIQUE (projectId, key) index; a disagreement there
 * would show up as a duplicate row nothing can reconcile.
 *
 * NOTE WHAT IS NOT READ: `confidence`. Not from the input, not from anywhere a
 * caller controls. See FOUNDER_ASSERTION_CONFIDENCE above for why that is the
 * hinge the whole feature turns on.
 */
export function planFactAssertion(input: {
  phase: AssertionPhase;
  key: unknown;
  value: unknown;
}): FactAssertionPlan {
  const { phase } = input;

  const key =
    typeof input.key === "string" ? input.key.trim().toLowerCase() : "";
  if (!(FACT_KEY_PATTERN.test(key) && phase.factKeys.includes(key))) {
    return refuse(
      "key-not-permitted",
      `"${key || String(input.key)}" is not one of the facts this phase records. Pick one of: ${phase.factKeys.join(", ")}.`
    );
  }

  const value = typeof input.value === "string" ? input.value.trim() : "";
  if (value.length === 0) {
    return refuse(
      "value-blank",
      "Write what you found. A fact with no wording is not evidence, and the gate would count it as one."
    );
  }
  if (value.length > MAX_ASSERTED_FACT_VALUE) {
    return refuse(
      "value-too-long",
      `A fact must be under ${MAX_ASSERTED_FACT_VALUE} characters. This is the one sentence you would defend, not the field notes behind it.`
    );
  }

  return {
    ok: true,
    write: {
      key,
      phaseKey: phase.key,
      value,
      confidence: FOUNDER_ASSERTION_CONFIDENCE,
    } as FounderFactWrite,
  };
}
