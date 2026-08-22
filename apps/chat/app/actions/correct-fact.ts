"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { planFactAssertion } from "@/lib/db/fact-assertion";
import {
  assertProjectFact,
  correctProjectFact,
  deleteProjectFact,
  getProjectPhases,
} from "@/lib/db/phase-queries";
import { getProjectById } from "@/lib/db/queries";
import { resolveCurrentPhase } from "@/lib/phases/advance";

/**
 * The founder corrects, removes, or asserts one fact.
 *
 * WHAT A CORRECTION DELIBERATELY CANNOT DO: change a fact's KEY, or change its
 * CONFIDENCE. The key is identity — half of the (projectId, key) unique index.
 * Confidence is the extractor's own certainty at the moment it recorded the
 * fact, a sentence the exported FACTS.md ships verbatim, and it is the one dial
 * that would let a founder pass their own gate on an assumption.
 *
 * What a correction changes is the value and the PROVENANCE. `origin` becomes
 * `founder`, `renderFacts` marks it in the judge's own prompt, and the
 * extractor stops overwriting it (`reconcileFacts`).
 *
 * THIS FILE USED TO SAY a "new fact" button is laundering in its purest form —
 * a claim with no turn behind it, entering the ledger the gate reads. That was
 * right about the button it was refusing, and `assertFact` below is not that
 * button. The gate now classifies a criterion as `offline-only` and asks for
 * the INSTRUMENT rather than the value; a founder who goes away, runs five
 * interviews and comes back had NO WAY IN except pasting field logs into chat
 * and hoping the extractor picked them up. What makes the entry path safe is
 * not that it is hard to reach, it is that:
 *
 *   - the key must be one the CURRENT phase's own extractor could have written;
 *   - the value is marked `origin = 'founder'`, so the judge is told it was
 *     asserted rather than observed, and can weigh it as the weaker evidence
 *     it is;
 *   - the confidence is fixed by the system and is unreadable from the request;
 *   - and it can never overwrite an extracted fact.
 *
 * Nothing here advances a phase. The gate still judges, and still refuses.
 *
 * Ownership is checked the way save-simulation-profile.ts checks it, including
 * its refusal to distinguish "does not exist" from "not yours".
 */

export type FactEditResult =
  | { status: "saved" }
  | { status: "unauthorized" }
  | { status: "not-found" }
  | { status: "invalid"; detail: string };

const MAX_FACT_VALUE = 2000;

async function authorize(
  projectId: string
): Promise<{ ok: true } | { ok: false; result: FactEditResult }> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return { ok: false, result: { status: "unauthorized" } };
  }
  const project = await getProjectById({ id: projectId });
  if (!project || project.userId !== session.user.id) {
    return { ok: false, result: { status: "not-found" } };
  }
  return { ok: true };
}

export async function correctFact({
  projectId,
  key,
  value,
}: {
  projectId: string;
  key: string;
  value: string;
}): Promise<FactEditResult> {
  const allowed = await authorize(projectId);
  if (!allowed.ok) {
    return allowed.result;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    // An empty correction is a deletion wearing an edit's clothes, and the two
    // have different consequences — deleting can drop a phase below its
    // minimum fact count. Make the founder choose.
    return {
      status: "invalid",
      detail:
        "A fact cannot be blank. Delete it instead if it is not true — that is a different decision, and it can change whether the phase still passes.",
    };
  }
  if (trimmed.length > MAX_FACT_VALUE) {
    return {
      status: "invalid",
      detail: `A fact must be under ${MAX_FACT_VALUE} characters.`,
    };
  }

  const changed = await correctProjectFact({ projectId, key, value: trimmed });
  if (changed === 0) {
    return { status: "not-found" };
  }
  revalidatePath(`/project/${projectId}/facts`);
  return { status: "saved" };
}

/**
 * THE OUTCOME OF ONE HAND-ENTERED FACT.
 *
 * NOTE WHICH ARM CARRIES THE CONFIDENCE: only `recorded`, and it is the number
 * the database actually took, echoed back so the UI states a written fact
 * rather than a hoped-for one. Every other arm has no confidence field at all —
 * not a zero, not a null. "Nothing was stored" is a state with no stored
 * values, the same discipline as `FactAssertionPlan` in lib/db/fact-assertion.ts
 * and `GateVerdictView` in lib/phases/rail.ts.
 */
export type FactAssertionOutcome =
  | { status: "recorded"; key: string; confidence: number }
  | { status: "key-already-held"; detail: string }
  | { status: "invalid"; detail: string }
  | { status: "unauthorized" }
  | { status: "not-found" };

/**
 * The founder writes down something they went and found out.
 *
 * THE VOCABULARY IS THE CURRENT PHASE'S, not the union of all eight. The gate
 * that asked for the instrument is this phase's gate, and the results of
 * running it belong to it. Offering phase 7's keys to a founder in phase 1
 * would let assertions accumulate ahead of the questions that motivate them.
 *
 * Resolved server-side from the phase rows rather than trusted from the form:
 * the dropdown narrows what a founder can pick, it does not decide what the
 * server will accept. Same `resolveCurrentPhase` the system prompt and the rail
 * use, so the three cannot disagree about which phase this is.
 *
 * There is no `confidence` parameter, and adding one would not help a caller:
 * `planFactAssertion` reads `key` and `value` and nothing else, and the payload
 * it returns is the only thing `assertProjectFact` will accept.
 */
export async function assertFact({
  projectId,
  key,
  value,
}: {
  projectId: string;
  key: string;
  value: string;
}): Promise<FactAssertionOutcome> {
  const allowed = await authorize(projectId);
  if (!allowed.ok) {
    // Both refusals are shapes this outcome already has, and they mean the
    // same thing here as they do for a correction.
    return allowed.result.status === "unauthorized"
      ? { status: "unauthorized" }
      : { status: "not-found" };
  }

  const rows = await getProjectPhases({ projectId });
  const { phase } = resolveCurrentPhase(
    rows.map((row) => ({
      phaseKey: row.phaseKey,
      status: row.status as "locked" | "active" | "passed",
    }))
  );

  const plan = planFactAssertion({ phase, key, value });
  if (!plan.ok) {
    return { status: "invalid", detail: plan.detail };
  }

  const written = await assertProjectFact({ projectId, write: plan.write });
  if (written === "key-already-held") {
    return {
      status: "key-already-held",
      detail: `"${plan.write.key}" already holds a fact. Correct that one instead — a correction keeps the extractor's own confidence rather than replacing it with yours.`,
    };
  }

  revalidatePath(`/project/${projectId}/facts`);
  return {
    status: "recorded",
    key: plan.write.key,
    confidence: plan.write.confidence,
  };
}

export async function deleteFact({
  projectId,
  key,
}: {
  projectId: string;
  key: string;
}): Promise<FactEditResult> {
  const allowed = await authorize(projectId);
  if (!allowed.ok) {
    return allowed.result;
  }
  const removed = await deleteProjectFact({ projectId, key });
  if (removed === 0) {
    return { status: "not-found" };
  }
  revalidatePath(`/project/${projectId}/facts`);
  return { status: "saved" };
}
