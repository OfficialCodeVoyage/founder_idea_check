import { PHASE_THREE } from "@/lib/phases/definitions-discovery";

/**
 * WHEN TO REGENERATE THE PERSONA. Pure, so it is testable with no key, no
 * database and no model.
 *
 * THE DEFECT THIS FIXES. `regeneratePersona` worked and was reachable from
 * nothing: `persona.regenerate` had no caller anywhere in the repo — no
 * component, no route handler, no server action — and `runPostTurnPhasePass`
 * never called it. So phase 3 (`user-personas`) passed its gate with an empty
 * `Document` table and the canvas reading "Personas 0". The feature was built,
 * tested, and unreachable.
 *
 * WHY IT IS NOT SIMPLY "REGENERATE EVERY TURN". A persona costs one call to the
 * strong model — the same one the gate judge uses — over up to 1,800 tokens of
 * facts and 12,000 of transcript. Paying that on every turn of every phase
 * would be most of a turn's cost for an artifact that had not changed.
 */

export type PersonaTriggerInput = {
  /** The phase the post-turn pass just assessed. */
  phaseKey: string;
  /** Whether the gate actually reached a verdict this turn. */
  assessed: boolean;
  /** The gate's decision, or null when it did not reach one. */
  decision: "PASS" | "WARN" | "BLOCK" | null;
  /** How many project facts this turn's extraction wrote or revised. */
  factsChanged: number;
  /** Whether any fact is stored at all. */
  factsStored: number;
  /** Newest `ProjectFact.updatedAt`, or null when nothing is stored. */
  latestFactUpdatedAt: Date | null;
  /** Newest stored persona version's createdAt, or null when there is none. */
  latestVersionCreatedAt: Date | null;
};

export type PersonaTriggerDecision = {
  regenerate: boolean;
  /** Named so a debug log says which rule fired, never just true/false. */
  why:
    | "not-assessed"
    | "not-phase-three"
    | "no-facts-stored"
    | "facts-changed-this-turn"
    | "no-new-input"
    | "no-version-yet"
    | "facts-changed-since-version"
    | "version-is-current";
};

/**
 * PURE. Total over its input.
 *
 * THE ORDER IS LOAD-BEARING. `factsChanged` is a FIRST-HAND FACT about this
 * turn; the timestamp comparison below it is a GUESS ACROSS TWO CLOCKS —
 * `ProjectFact.updatedAt` is written by Postgres (`sql\`now()\`` in
 * fact-upsert.ts) and `Document.createdAt` by Node (`nextVersionCreatedAt` in
 * artifact.ts). If the comparison ran first, a deployment whose database clock
 * trailed the app clock would resolve a fact-changing turn to
 * "version-is-current" and silently skip a regeneration that was certainly
 * needed — the same shape as defaulting a null to 0, expressed in timestamps.
 * A guess must never overrule a fact.
 */
export function decidePersonaRegeneration(
  input: PersonaTriggerInput
): PersonaTriggerDecision {
  if (!input.assessed) {
    return { regenerate: false, why: "not-assessed" };
  }
  if (input.phaseKey !== PHASE_THREE.key) {
    return { regenerate: false, why: "not-phase-three" };
  }
  if (input.factsStored === 0) {
    // `buildPersonaPrompt` refuses below PHASE_THREE.gate.minFactsRequired
    // anyway; not paying for the call is the cheaper way to reach the same "no".
    return { regenerate: false, why: "no-facts-stored" };
  }
  if (input.factsChanged > 0) {
    return { regenerate: true, why: "facts-changed-this-turn" };
  }
  // Only a turn that changed NOTHING has to ask whether the stored persona is
  // already the record of the stored facts.
  if (input.decision === "BLOCK") {
    return { regenerate: false, why: "no-new-input" };
  }
  if (input.latestVersionCreatedAt === null) {
    return { regenerate: true, why: "no-version-yet" };
  }
  if (
    input.latestFactUpdatedAt !== null &&
    input.latestFactUpdatedAt.getTime() > input.latestVersionCreatedAt.getTime()
  ) {
    return { regenerate: true, why: "facts-changed-since-version" };
  }
  return { regenerate: false, why: "version-is-current" };
}
