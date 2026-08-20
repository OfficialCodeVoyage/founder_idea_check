import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getProjectFacts, getProjectPhases } from "@/lib/db/phase-queries";
import { getDocumentsByProjectId, getProjectById } from "@/lib/db/queries";
import {
  getProjectTask,
  getProjectTasks,
  isPersistedTaskState,
  upsertProjectTask,
} from "@/lib/db/task-queries";
import {
  isPersonaDocument,
  latestPersonaVersion,
  PERSONA_DOCUMENT_KIND,
} from "@/lib/personas/artifact";
import { toCanvasPersonaInput } from "@/lib/personas/canvas-input";
import { resolveCurrentPhase } from "@/lib/phases/advance";
import { type ExitCriterion, GateVerdictSchema } from "@/lib/phases/types";
import { analyzeBlockers } from "@/lib/ultraplan/blockers";
import type {
  CanvasArtifactInput,
  CanvasFactInput,
  CanvasPersonaInput,
} from "@/lib/ultraplan/graph";
import { applyTaskEvent, parseTaskState } from "@/lib/ultraplan/tasks";
import type { StoredTask, UnblockingTask } from "@/lib/ultraplan/types";
import { TASK_EVENTS } from "@/lib/ultraplan/types";
import { createTRPCRouter, protectedProcedure } from "@/trpc/init";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CANVAS ROUTER — READS EVERYTHING, DECIDES NOTHING IT CAN DELEGATE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `getCanvas` returns the four lanes in exactly the shapes lib/ultraplan
 * consumes (CanvasFactInput / CanvasArtifactInput / CanvasPersonaInput /
 * StoredTask), so the client's whole job is
 *
 *   analyzeBlockers → reconcileTasks → buildCanvasGraph
 *
 * — three pure calls with no reshaping in between, all of them already unit
 * tested. Nothing about layout, status or severity is computed here.
 *
 * `setTaskState` is the one place this file does hold a rule, and it holds it
 * by REFUSING to accept a decision from the client. See its comment.
 */

type ProjectDocumentRow = Awaited<
  ReturnType<typeof getDocumentsByProjectId>
>[number];

/**
 * Documents are versioned on the composite key (id, createdAt), so one document
 * is many rows. Rows arrive oldest-first, hence `.at(-1)` is the current one.
 */
function groupDocumentVersions(
  rows: ProjectDocumentRow[]
): Map<string, ProjectDocumentRow[]> {
  const groups = new Map<string, ProjectDocumentRow[]>();
  for (const row of rows) {
    const existing = groups.get(row.id);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(row.id, [row]);
    }
  }
  return groups;
}

/**
 * Kind is the cheap discriminator, but a persona written while
 * PERSONA_DOCUMENT_KIND was still pinned to "text" is a real row in a real
 * database, and it is still a persona. isPersonaDocument() settles those by
 * parsing; JSON.parse bails on the first character of a markdown document, so
 * the fallback costs nothing on the rows it does not match.
 */
function isPersonaRow(row: ProjectDocumentRow): boolean {
  return row.kind === PERSONA_DOCUMENT_KIND || isPersonaDocument(row);
}

function toPersonaInput(
  documentId: string,
  versions: ProjectDocumentRow[]
): CanvasPersonaInput {
  const latest = latestPersonaVersion(versions);
  const artifact = latest?.artifact ?? null;
  // Shared with loadProjectCanvas. These two reads used to compute
  // evidenceCount, summary and name three different ways between them.
  return toCanvasPersonaInput({
    documentId,
    title: latest?.title ?? null,
    persona: artifact?.persona ?? null,
    groundedInFactKeys: artifact?.groundedInFactKeys ?? [],
  });
}

function toArtifactInput(
  documentId: string,
  versions: ProjectDocumentRow[]
): CanvasArtifactInput {
  const latest = versions.at(-1);
  return {
    id: documentId,
    title: latest?.title ?? documentId,
    kind: latest?.kind ?? null,
    // NULL only when there is no row at all to look at. `content` is a nullable
    // column, and a NULL there means we DID check and there is nothing in it.
    hasContent: latest ? (latest.content ?? "").trim().length > 0 : null,
    // Empty, and deliberately so: nothing in the schema records which facts a
    // document cites. Inferring them by text similarity would draw edges the
    // data does not support, and lib/ultraplan reports dropped edges precisely
    // so a thin graph is visible rather than invented.
    citesFactKeys: [],
  };
}

function toStoredTask(row: {
  taskId: string;
  state: string;
  title: string;
  detail: string;
  criterionId: string;
  producesFactKey: string | null;
}): StoredTask {
  return {
    id: row.taskId,
    state: row.state,
    title: row.title,
    detail: row.detail,
    criterionId: row.criterionId,
    producesFactKey: row.producesFactKey,
  };
}

/** Ownership check, copied from phase.router.ts so the two cannot drift. */
async function requireOwnedProject(projectId: string, userId: string) {
  const project = await getProjectById({ id: projectId });
  if (!project) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
  }
  if (project.userId !== userId) {
    // Same message as NOT_FOUND on purpose: never confirm a project exists to
    // somebody who does not own it.
    throw new TRPCError({ code: "FORBIDDEN", message: "Project not found" });
  }
  return project;
}

type CurrentPhaseGate = {
  phaseKey: string;
  criteria: ExitCriterion[];
  verdict: z.infer<typeof GateVerdictSchema> | null;
  title: string;
  order: number;
  workflowComplete: boolean;
};

/**
 * Resolves which phase the canvas is describing and reads back its verdict.
 *
 * PARSED, NOT CAST. `verdict` is a json column, i.e. genuinely unknown, and a
 * failed parse must yield NULL — which analyzeBlockers() reads as "unassessed",
 * NOT as "blocked". Those are different facts about the world.
 */
async function readCurrentPhaseGate(
  projectId: string
): Promise<CurrentPhaseGate> {
  const rows = await getProjectPhases({ projectId });
  const { phase, workflowComplete } = resolveCurrentPhase(
    rows.map((r) => ({
      phaseKey: r.phaseKey,
      status: r.status as "locked" | "active" | "passed",
    }))
  );
  const row = rows.find((r) => r.phaseKey === phase.key) ?? null;
  const parsed = GateVerdictSchema.safeParse(row?.verdict);
  return {
    phaseKey: phase.key,
    criteria: phase.exitCriteria,
    verdict: parsed.success ? parsed.data : null,
    title: phase.title,
    order: phase.order,
    workflowComplete,
  };
}

export const canvasRouter = createTRPCRouter({
  /**
   * Everything the canvas renders, in one snapshot.
   *
   * One snapshot rather than four queries the client stitches together: facts,
   * documents, tasks and the verdict are read within one request, so the graph
   * cannot show a task generated from a verdict that a concurrently-running
   * gate has already replaced.
   */
  getCanvas: protectedProcedure
    .input(z.object({ projectId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await requireOwnedProject(input.projectId, ctx.user.id);

      const [gate, factRows, documentRows, taskRows] = await Promise.all([
        readCurrentPhaseGate(input.projectId),
        getProjectFacts({ projectId: input.projectId }),
        getDocumentsByProjectId({ projectId: input.projectId }),
        getProjectTasks({ projectId: input.projectId }),
      ]);

      const facts: CanvasFactInput[] = factRows.map((row) => ({
        key: row.key,
        value: row.value,
        confidence: row.confidence,
        phaseKey: row.phaseKey,
      }));

      const personas: CanvasPersonaInput[] = [];
      const artifacts: CanvasArtifactInput[] = [];
      for (const [documentId, versions] of groupDocumentVersions(
        documentRows
      )) {
        const latest = versions.at(-1);
        if (latest && isPersonaRow(latest)) {
          personas.push(toPersonaInput(documentId, versions));
        } else {
          artifacts.push(toArtifactInput(documentId, versions));
        }
      }

      return {
        phaseKey: gate.phaseKey,
        phaseTitle: gate.title,
        phaseOrder: gate.order,
        workflowComplete: gate.workflowComplete,
        criteria: gate.criteria,
        verdict: gate.verdict,
        facts,
        artifacts,
        personas,
        tasks: taskRows.map(toStoredTask),
      };
    }),

  /**
   * THE MUTATION TAKES AN EVENT, NEVER A TARGET STATE.
   *
   * If it accepted a state, every rule in the machine — a blocked task cannot
   * be completed, an unreadable task cannot be completed, a completed task
   * cannot be dropped — would be client-side decoration, bypassable with one
   * curl. The client says what the founder DID; applyTaskEvent() says what that
   * means. A refused move comes back as BAD_REQUEST carrying the machine's own
   * reason, so the UI explains the rule rather than appearing broken.
   *
   * The task's IDENTITY is server-owned for the same reason. Title, detail,
   * criterion and target fact key are read from the current verdict's generated
   * tasks, not from the request, so a caller cannot mint arbitrary rows or
   * rewrite what a task claims to be.
   */
  setTaskState: protectedProcedure
    .input(
      z.object({
        projectId: z.string().uuid(),
        // 256 is the column width; rejecting here makes an over-long id a
        // validation error rather than a Postgres error.
        taskId: z.string().min(1).max(256),
        event: z.enum(TASK_EVENTS),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwnedProject(input.projectId, ctx.user.id);

      const [gate, current] = await Promise.all([
        readCurrentPhaseGate(input.projectId),
        getProjectTask({
          projectId: input.projectId,
          taskId: input.taskId,
        }),
      ]);

      const analysis = analyzeBlockers({
        phaseKey: gate.phaseKey,
        criteria: gate.criteria,
        verdict: gate.verdict,
      });
      const generated: UnblockingTask | undefined = analysis.tasks.find(
        (task) => task.id === input.taskId
      );

      if (!(current || generated)) {
        // Neither the founder nor the gate has ever heard of this task. Refuse
        // rather than create it: the id is the only thing tying a row to a
        // blocker, and a row nothing generated can never be reconciled.
        throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
      }

      // No stored row means the verdict just produced this task and nobody has
      // touched it: "todo", not "unknown". Exactly the rule reconcileTasks()
      // applies in memory — if this said parseTaskState(undefined) instead, a
      // fresh task would land on "unknown", where the only legal moves are
      // reopen and drop, and the first click on "Start" would be refused.
      const state = current ? parseTaskState(current.state) : "todo";
      const result = applyTaskEvent(state, input.event);
      if (!result.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: result.reason });
      }
      if (!isPersistedTaskState(result.state)) {
        // Unreachable: no transition targets "unknown". Fails closed instead of
        // writing a parse-failure value into the column.
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `refusing to persist unwritable task state "${result.state}"`,
        });
      }

      await upsertProjectTask({
        projectId: input.projectId,
        taskId: input.taskId,
        // The generated task wins on wording; a task the verdict no longer
        // mentions keeps the snapshot it was stored with, so an orphaned task
        // stays renderable instead of losing its title.
        phaseKey: generated ? gate.phaseKey : (current?.phaseKey ?? ""),
        criterionId: generated?.criterionId ?? current?.criterionId ?? "",
        state: result.state,
        title: generated?.title ?? current?.title ?? "",
        detail: generated?.detail ?? current?.detail ?? "",
        producesFactKey:
          generated?.producesFactKey ?? current?.producesFactKey ?? null,
      });

      return {
        taskId: input.taskId,
        state: result.state,
        /** FALSE for an idempotent replay — a double-click, not a refusal. */
        changed: result.changed,
      };
    }),
});
