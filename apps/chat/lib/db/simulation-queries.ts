import "server-only";
import { desc, eq } from "drizzle-orm";
import { db } from "./client";
import {
  type ProjectPersona,
  projectPersona,
  type SimulationRun,
  simulationRun,
} from "./schema";

/**
 * Persistence for Step 8 simulations.
 *
 * Its own file rather than more of queries.ts, following the phase-queries and
 * task-queries precedent: the research subsystem's storage stays together.
 */

/** The population a run is seeded with. Oldest first, so ordering is stable. */
export async function getProjectPersonas({
  projectId,
}: {
  projectId: string;
}): Promise<ProjectPersona[]> {
  try {
    return await db
      .select()
      .from(projectPersona)
      .where(eq(projectPersona.projectId, projectId))
      .orderBy(projectPersona.createdAt);
  } catch (error) {
    console.error("Failed to get project personas from database", error);
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
  usable: boolean;
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
        reactions: input.reactions,
      })
      .returning();
    return row;
  } catch (error) {
    console.error("Failed to insert simulation run in database", error);
    throw error;
  }
}
