"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { correctProjectFact, deleteProjectFact } from "@/lib/db/phase-queries";
import { getProjectById } from "@/lib/db/queries";

/**
 * The founder corrects or removes one extracted fact.
 *
 * WHAT THIS DELIBERATELY CANNOT DO: change a fact's KEY, change its CONFIDENCE,
 * or create a fact from nothing. The key is identity — half of the
 * (projectId, key) unique index. Confidence is the extractor's own certainty at
 * the moment it recorded the fact, a sentence the exported FACTS.md ships
 * verbatim, and it is the one dial that would let a founder pass their own gate
 * on an assumption. And a "new fact" button is laundering in its purest form:
 * a claim with no turn behind it, entering the ledger the gate reads.
 *
 * What a correction changes is the value and the PROVENANCE. `origin` becomes
 * `founder`, `renderFacts` marks it in the judge's own prompt, and the
 * extractor stops overwriting it (`reconcileFacts`).
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
