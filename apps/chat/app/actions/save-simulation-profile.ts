"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDocumentById, getProjectById } from "@/lib/db/queries";
import {
  deleteSimulationProfile,
  getSimulationProfiles,
  upsertSimulationProfile,
} from "@/lib/db/simulation-queries";
import { PERSONA_DOCUMENT_KIND } from "@/lib/personas/artifact";
import { MAX_SIMULATION_SEATS } from "@/lib/research/simulation";

/**
 * THE WRITE PATH FOR FOUNDER-ATTRIBUTABLE ASSUMPTIONS.
 *
 * Modelled line-for-line on run-simulation.ts, including its refusal to
 * distinguish "does not exist" from "not yours".
 *
 * The `kind === PERSONA_DOCUMENT_KIND` check is the one `persona.router.ts` does
 * not need and this does: a seat pointed at a code or sheet document would
 * produce an `orphan-profile`-shaped gap the founder could never clear, because
 * nothing in the UI would show them the row they had to fix.
 */

/**
 * MIRRORS THE COLUMN LIMITS AND THE CHECK CONSTRAINTS, so a bad value comes back
 * as a field-level message instead of a Postgres error. `handle` is
 * varchar(64) and `mbti` varchar(8); gender and country stay free text but are
 * bounded anyway — they are interpolated into an OASIS agent prompt verbatim.
 */
const ProfileSchema = z.object({
  age: z.number().int().min(13).max(120),
  country: z.string().trim().min(1).max(120),
  gender: z.string().trim().min(1).max(60),
  handle: z.string().trim().min(1).max(64),
  id: z.string().uuid().optional(),
  /**
   * BLANK COLLAPSES TO NULL HERE, before min(1) is ever applied. The form tells
   * the founder to leave MBTI blank if they do not know it, and an empty
   * `<Input>` submits `""` — validating that against `min(1)` would make the
   * documented answer a field error. `""` is not "unspecified" and must not
   * survive past this boundary.
   */
  mbti: z
    .string()
    .max(8)
    .transform((value) => value.trim() || null)
    .nullable(),
  personaDocumentId: z.string().uuid(),
  projectId: z.string().uuid(),
});

export type SaveSimulationProfileInput = z.input<typeof ProfileSchema>;

export type SaveSimulationProfileResult =
  | { status: "saved" }
  | { status: "unauthorized" }
  | { status: "not-found" }
  | { status: "invalid"; problems: string[] }
  | { status: "handle-taken"; handle: string }
  | { status: "seat-limit"; limit: number };

/** Postgres unique-violation. Read from the driver code, never the message. */
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

async function requireOwnedProjectAndPersona({
  projectId,
  personaDocumentId,
  userId,
}: {
  projectId: string;
  personaDocumentId: string;
  userId: string;
}): Promise<boolean> {
  const project = await getProjectById({ id: projectId });
  if (!project || project.userId !== userId) {
    return false;
  }

  const persona = await getDocumentById({ id: personaDocumentId });
  return !!(
    persona &&
    persona.userId === userId &&
    persona.projectId === projectId &&
    persona.kind === PERSONA_DOCUMENT_KIND
  );
}

export async function saveSimulationProfile(
  raw: SaveSimulationProfileInput
): Promise<SaveSimulationProfileResult> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return { status: "unauthorized" };
  }

  const parsed = ProfileSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      problems: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "input"}: ${issue.message}`
      ),
      status: "invalid",
    };
  }
  const input = parsed.data;

  const owned = await requireOwnedProjectAndPersona({
    personaDocumentId: input.personaDocumentId,
    projectId: input.projectId,
    userId: session.user.id,
  });
  if (!owned) {
    return { status: "not-found" };
  }

  // A NEW SEAT ONLY. Editing an existing seat never changes the count, and a
  // project already over the limit must still be able to fix a seat before
  // removing one. Two concurrent saves can pass this together and land one
  // seat over; `runProjectSimulation` refuses to seat more than the limit
  // whatever the table holds, so that race cannot spend more.
  if (!input.id) {
    const seats = await getSimulationProfiles({ projectId: input.projectId });
    if (seats.length >= MAX_SIMULATION_SEATS) {
      return { limit: MAX_SIMULATION_SEATS, status: "seat-limit" };
    }
  }

  try {
    const result = await upsertSimulationProfile(input);
    if (result.status === "not-found") {
      // The row id is not this project's. Reported, never turned into an INSERT.
      return { status: "not-found" };
    }
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { handle: input.handle, status: "handle-taken" };
    }
    throw error;
  }

  revalidatePath(`/project/${input.projectId}/simulation`);
  return { status: "saved" };
}

export async function deleteSimulationProfileAction({
  id,
  projectId,
}: {
  id: string;
  projectId: string;
}): Promise<SaveSimulationProfileResult> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return { status: "unauthorized" };
  }

  const project = await getProjectById({ id: projectId });
  if (!project || project.userId !== session.user.id) {
    return { status: "not-found" };
  }

  // `projectId` is in the DELETE predicate too, so an id from another project
  // deletes nothing rather than deleting somebody else's seat.
  await deleteSimulationProfile({ id, projectId });
  revalidatePath(`/project/${projectId}/simulation`);
  return { status: "saved" };
}
