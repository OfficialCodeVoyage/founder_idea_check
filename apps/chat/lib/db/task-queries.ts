import "server-only";
import { and, eq } from "drizzle-orm";
import type { TaskState } from "@/lib/ultraplan/types";
import { db } from "./client";
import { type ProjectTask, projectTask } from "./schema";

/**
 * Persistence for founder-owned task state.
 *
 * Its own file rather than another 60 lines in queries.ts, following the
 * lib/db/phase-queries.ts precedent: everything the ultraplan canvas persists
 * lives together, and queries.ts stays the chat/document surface.
 *
 * NOTHING HERE DECIDES ANYTHING. Every rule about which state a task may move
 * to lives in the PURE applyTaskEvent() in lib/ultraplan/tasks.ts, which is
 * unit-tested with no database and no key. These functions only read and write
 * what they are told, exactly as upsertProjectPhase() does for the gate.
 */

/**
 * The states that may be WRITTEN, read off the column definition so the two can
 * never drift.
 *
 * "unknown" is absent on purpose and that absence is load-bearing: it is the
 * read-side fail-closed value parseTaskState() produces for a string we could
 * not recognise, and writing it back would persist a parse failure as though it
 * were a decision the founder made.
 */
export const PERSISTED_TASK_STATES = projectTask.state.enumValues;
export type PersistedTaskState = ProjectTask["state"];

const PERSISTED_TASK_STATE_SET = new Set<string>(PERSISTED_TASK_STATES);

/**
 * Narrows a TaskState to something the column can hold.
 *
 * applyTaskEvent() can never target "unknown" — no row in its transition table
 * points there — so this guard is unreachable in practice. It exists so that
 * remaining true is enforced by the type system at the write site rather than
 * assumed, and so a future transition that DID target "unknown" would be
 * refused at the boundary instead of silently stored.
 */
export function isPersistedTaskState(
  state: TaskState
): state is PersistedTaskState {
  return PERSISTED_TASK_STATE_SET.has(state);
}

/** Every stored task for a project. Ordered so the canvas is stable per fetch. */
export async function getProjectTasks({
  projectId,
}: {
  projectId: string;
}): Promise<ProjectTask[]> {
  try {
    return await db
      .select()
      .from(projectTask)
      .where(eq(projectTask.projectId, projectId))
      .orderBy(projectTask.taskId);
  } catch (error) {
    console.error("Failed to get project tasks from database", error);
    throw error;
  }
}

/**
 * One stored task, or undefined.
 *
 * Scoped by projectId as well as taskId — taskId is deterministic
 * (`${phaseKey}::${criterionId}::${kind}`) and therefore IDENTICAL across every
 * project that reaches the same blocker, so a lookup by taskId alone would read
 * another founder's row.
 */
export async function getProjectTask({
  projectId,
  taskId,
}: {
  projectId: string;
  taskId: string;
}): Promise<ProjectTask | undefined> {
  try {
    const [row] = await db
      .select()
      .from(projectTask)
      .where(
        and(
          eq(projectTask.projectId, projectId),
          eq(projectTask.taskId, taskId)
        )
      );
    return row;
  } catch (error) {
    console.error("Failed to get project task from database", error);
    throw error;
  }
}

export type UpsertProjectTaskInput = {
  projectId: string;
  /** `${phaseKey}::${criterionId}::${kind}` from UnblockingTask.id. */
  taskId: string;
  phaseKey: string;
  criterionId: string;
  /** Computed by applyTaskEvent(). Never taken from a client. */
  state: PersistedTaskState;
  title: string;
  detail: string;
  producesFactKey: string | null;
};

/**
 * Plain upsert on the (projectId, taskId) unique index.
 *
 * The display columns are overwritten on conflict because the CURRENT verdict's
 * wording wins — the same rule reconcileTasks() applies in memory. `state` is
 * whatever applyTaskEvent() returned; this function does not re-check it.
 */
export async function upsertProjectTask(input: UpsertProjectTaskInput) {
  try {
    return await db
      .insert(projectTask)
      .values({
        projectId: input.projectId,
        taskId: input.taskId,
        phaseKey: input.phaseKey,
        criterionId: input.criterionId,
        state: input.state,
        title: input.title,
        detail: input.detail,
        producesFactKey: input.producesFactKey,
      })
      .onConflictDoUpdate({
        target: [projectTask.projectId, projectTask.taskId],
        set: {
          state: input.state,
          phaseKey: input.phaseKey,
          criterionId: input.criterionId,
          title: input.title,
          detail: input.detail,
          producesFactKey: input.producesFactKey,
          updatedAt: new Date(),
        },
      });
  } catch (error) {
    console.error("Failed to upsert project task in database", error);
    throw error;
  }
}
