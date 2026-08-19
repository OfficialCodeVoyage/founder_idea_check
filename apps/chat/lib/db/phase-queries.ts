import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "./client";
import {
  type ProjectFact,
  type ProjectPhase,
  projectFact,
  projectPhase,
} from "./schema";

export async function getProjectPhase({
  projectId,
  phaseKey,
}: {
  projectId: string;
  phaseKey: string;
}): Promise<ProjectPhase | undefined> {
  try {
    const [row] = await db
      .select()
      .from(projectPhase)
      .where(
        and(
          eq(projectPhase.projectId, projectId),
          eq(projectPhase.phaseKey, phaseKey)
        )
      );
    return row;
  } catch (error) {
    console.error("Failed to get project phase from database", error);
    throw error;
  }
}

/**
 * Every phase row for a project, ordered by phaseOrder.
 *
 * The sequencing decision (which phase is current, what a PASS advances to)
 * belongs to the PURE resolveCurrentPhase()/planPhaseAdvance() in
 * lib/phases/advance.ts — this only reads the rows they judge.
 */
export async function getProjectPhases({
  projectId,
}: {
  projectId: string;
}): Promise<ProjectPhase[]> {
  try {
    return await db
      .select()
      .from(projectPhase)
      .where(eq(projectPhase.projectId, projectId))
      .orderBy(projectPhase.phaseOrder);
  } catch (error) {
    console.error("Failed to get project phases from database", error);
    throw error;
  }
}

/**
 * Opens a phase. Insert-only by design: onConflictDoNothing, because an
 * existing row already carries a verdict and an attemptCount, and re-opening a
 * phase must never wipe them. Called only for the phase a PASS advances into.
 */
export async function activateProjectPhase({
  projectId,
  phaseKey,
  phaseOrder,
}: {
  projectId: string;
  phaseKey: string;
  phaseOrder: number;
}) {
  try {
    return await db
      .insert(projectPhase)
      .values({
        projectId,
        phaseKey,
        phaseOrder,
        status: "active",
        attemptCount: 0,
      })
      .onConflictDoNothing({
        target: [projectPhase.projectId, projectPhase.phaseKey],
      });
  } catch (error) {
    console.error("Failed to activate project phase in database", error);
    throw error;
  }
}

export async function upsertProjectPhase({
  projectId,
  phaseKey,
  phaseOrder,
  status,
  decision,
  reason,
  nextQuestion,
  verdict,
}: {
  projectId: string;
  phaseKey: string;
  phaseOrder: number;
  /**
   * Decided by planPhaseAdvance() in lib/phases/advance.ts. Optional so the
   * default stays the old derivation — but a caller that knows the sequencing
   * plan should pass it rather than let this function re-derive it, since
   * "PASS ⇒ passed" is a sequencing rule and belongs in the pure module.
   */
  status?: "active" | "passed";
  decision: "PASS" | "WARN" | "BLOCK";
  reason: string;
  nextQuestion: string | null;
  verdict: unknown;
}) {
  const resolvedStatus =
    status ?? (decision === "PASS" ? ("passed" as const) : ("active" as const));
  try {
    return await db
      .insert(projectPhase)
      .values({
        projectId,
        phaseKey,
        phaseOrder,
        status: resolvedStatus,
        decision,
        reason,
        nextQuestion,
        verdict,
        attemptCount: 1,
        evaluatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [projectPhase.projectId, projectPhase.phaseKey],
        set: {
          status: resolvedStatus,
          decision,
          reason,
          nextQuestion,
          verdict,
          attemptCount: sql`${projectPhase.attemptCount} + 1`,
          evaluatedAt: new Date(),
          updatedAt: new Date(),
        },
      });
  } catch (error) {
    console.error("Failed to upsert project phase in database", error);
    throw error;
  }
}

export async function getProjectFacts({
  projectId,
}: {
  projectId: string;
}): Promise<ProjectFact[]> {
  try {
    return await db
      .select()
      .from(projectFact)
      .where(eq(projectFact.projectId, projectId))
      .orderBy(projectFact.key);
  } catch (error) {
    console.error("Failed to get project facts from database", error);
    throw error;
  }
}

/**
 * Plain upsert. All insert-vs-update judgement (confidence policy, vocabulary
 * filtering) already happened in the PURE reconcileFacts()/sanitizeFacts() in
 * lib/phases/extract.ts — this function only writes what it is told.
 * The conflict target IS the (projectId, key) unique index.
 */
export async function upsertProjectFacts({
  projectId,
  phaseKey,
  sourceMessageId,
  facts,
}: {
  projectId: string;
  phaseKey: string;
  sourceMessageId: string | null;
  facts: { key: string; value: string; confidence: number }[];
}) {
  if (facts.length === 0) {
    return;
  }
  try {
    return await db
      .insert(projectFact)
      .values(
        facts.map((f) => ({
          projectId,
          phaseKey,
          key: f.key,
          value: f.value,
          confidence: f.confidence,
          sourceMessageId,
          extractedAt: new Date(),
        }))
      )
      .onConflictDoUpdate({
        target: [projectFact.projectId, projectFact.key],
        set: {
          value: sql`excluded."value"`,
          confidence: sql`excluded."confidence"`,
          phaseKey: sql`excluded."phaseKey"`,
          sourceMessageId: sql`excluded."sourceMessageId"`,
          extractedAt: sql`excluded."extractedAt"`,
          updatedAt: sql`now()`,
        },
      });
  } catch (error) {
    console.error("Failed to upsert project facts in database", error);
    throw error;
  }
}
