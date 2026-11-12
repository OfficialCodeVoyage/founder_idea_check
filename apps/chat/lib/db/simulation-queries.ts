import "server-only";
import { and, desc, eq } from "drizzle-orm";
import {
  latestPersonaPerDocument,
  type PersonaVersion,
} from "@/lib/personas/artifact";
import { db } from "./client";
import { getPersonaDocumentsByProjectId } from "./queries";
import {
  type SimulationProfile,
  type SimulationRun,
  simulationProfile,
  simulationRun,
} from "./schema";

/**
 * Persistence for Step 8 simulations.
 *
 * Its own file rather than more of queries.ts, following the phase-queries and
 * task-queries precedent: the research subsystem's storage stays together.
 */

/**
 * The project's personas — the newest version of each persona Document.
 *
 * IT USED TO READ `ProjectPersona`, WHICH NOTHING HAS EVER WRITTEN. That table
 * had one reader and no INSERT anywhere in the repo's history, so this function
 * returned [] every time and `runProjectSimulation` told a founder "this project
 * has 0 simulation personas" while they were looking at a finished persona
 * artifact. Personas live in `Document` where kind = 'persona'
 * (PERSONA_DOCUMENT_KIND), scoped by `Document.projectId` and served by
 * `Document_project_kind_idx`.
 */
export async function getProjectPersonas({
  projectId,
  userId,
}: {
  projectId: string;
  /** The project's owner, whom the caller has already checked. */
  userId: string;
}): Promise<PersonaVersion[]> {
  return latestPersonaPerDocument(
    await getPersonaDocumentsByProjectId({ projectId, userId })
  );
}

/**
 * The population, oldest first. OASIS keys agents by list index, so a stable
 * order keeps a trace row attributable to a seat.
 */
export async function getSimulationProfiles({
  projectId,
}: {
  projectId: string;
}): Promise<SimulationProfile[]> {
  try {
    return await db
      .select()
      .from(simulationProfile)
      .where(eq(simulationProfile.projectId, projectId))
      .orderBy(simulationProfile.createdAt);
  } catch (error) {
    console.error("Failed to get simulation profiles from database", error);
    throw error;
  }
}

export type UpsertSimulationProfileInput = {
  /** Omitted for a new seat. */
  id?: string;
  projectId: string;
  personaDocumentId: string;
  handle: string;
  age: number;
  gender: string;
  country: string;
  mbti: string | null;
};

/**
 * A seat is an editable ASSUMPTION, so unlike `insertSimulationRun` above —
 * which records something that happened and is never rewritten — update is
 * correct here. Do not read the INSERT-only rule as applying to both.
 */
export type UpsertSimulationProfileResult =
  | { status: "saved"; profile: SimulationProfile }
  | { status: "not-found" };

export async function upsertSimulationProfile(
  input: UpsertSimulationProfileInput
): Promise<UpsertSimulationProfileResult> {
  // `""` is not "unspecified", and the CHECK constraint rejects it. Normalise at
  // the boundary so a blank input box means NULL rather than a constraint error.
  const mbti = input.mbti?.trim() || null;

  try {
    if (input.id) {
      const [row] = await db
        .update(simulationProfile)
        .set({
          age: input.age,
          country: input.country,
          gender: input.gender,
          handle: input.handle,
          mbti,
          personaDocumentId: input.personaDocumentId,
        })
        // `projectId` IS IN THE PREDICATE, never merely in the values. Without
        // it, a caller supplying another project's row id with their own
        // projectId would rewrite that seat AND re-parent it into their project.
        // The callers validate the project and the persona document; neither can
        // validate that a row id belongs to the project without this.
        .where(
          and(
            eq(simulationProfile.id, input.id),
            eq(simulationProfile.projectId, input.projectId)
          )
        )
        .returning();

      // NO FALLBACK TO INSERT. Zero rows means the id is not this project's, and
      // inserting would silently create a duplicate seat while hiding the failed
      // update — the founder would see two agents and no error.
      return row ? { profile: row, status: "saved" } : { status: "not-found" };
    }

    const [row] = await db
      .insert(simulationProfile)
      .values({
        age: input.age,
        country: input.country,
        gender: input.gender,
        handle: input.handle,
        mbti,
        personaDocumentId: input.personaDocumentId,
        projectId: input.projectId,
      })
      .returning();
    return { profile: row, status: "saved" };
  } catch (error) {
    console.error("Failed to upsert simulation profile in database", error);
    throw error;
  }
}

/** Deletes one seat. `projectId` in the predicate, never trusted from the row. */
export async function deleteSimulationProfile({
  id,
  projectId,
}: {
  id: string;
  projectId: string;
}): Promise<void> {
  try {
    await db
      .delete(simulationProfile)
      .where(
        and(
          eq(simulationProfile.id, id),
          eq(simulationProfile.projectId, projectId)
        )
      );
  } catch (error) {
    console.error("Failed to delete simulation profile in database", error);
    throw error;
  }
}

/**
 * Past runs, newest first.
 *
 * COLLAPSED RUNS ARE INCLUDED, and that is the point of reading them at all. A
 * run whose personas all agreed is the most useful diagnostic this feature
 * produces — it usually means they were seeded from too few facts — so hiding
 * `usable: false` rows would hide the pattern the history exists to reveal.
 */
export async function getSimulationRuns({
  projectId,
  limit = 20,
}: {
  projectId: string;
  limit?: number;
}): Promise<SimulationRun[]> {
  try {
    return await db
      .select()
      .from(simulationRun)
      .where(eq(simulationRun.projectId, projectId))
      .orderBy(desc(simulationRun.createdAt))
      .limit(limit);
  } catch (error) {
    console.error("Failed to get simulation runs from database", error);
    throw error;
  }
}

export type InsertSimulationRunInput = {
  projectId: string;
  pitch: string;
  /** The full DivergenceReport, stored even when the run collapsed. */
  divergence: unknown;
  /**
   * `true` diverged, `false` collapsed, `null` NOT ASSESSED — and the third one
   * is why this is a union rather than a boolean. A run that produced nothing
   * used to be storable only as `false`, which is the COLLAPSED badge.
   */
  usable: boolean | null;
  /**
   * Required exactly when `usable` is null, forbidden otherwise. The database
   * enforces the same pairing in `SimulationRun_assessment_coherent`, so a
   * caller that gets this wrong fails loudly rather than writing a row that
   * reads as a verdict.
   */
  notAssessedKind?: string | null;
  /** Agent actions the sidecar watched fail. `null` = not counted, NOT zero. */
  agentErrors?: number | null;
  reactions: unknown;
};

/** INSERT only. A run is a record of what happened; it is never rewritten. */
export async function insertSimulationRun(
  input: InsertSimulationRunInput
): Promise<SimulationRun> {
  try {
    const [row] = await db
      .insert(simulationRun)
      .values({
        projectId: input.projectId,
        pitch: input.pitch,
        divergence: input.divergence,
        usable: input.usable,
        notAssessedKind: input.notAssessedKind ?? null,
        agentErrors: input.agentErrors ?? null,
        reactions: input.reactions,
      })
      .returning();
    return row;
  } catch (error) {
    console.error("Failed to insert simulation run in database", error);
    throw error;
  }
}
