import "server-only";

import { getProjectFacts, getProjectPhases } from "@/lib/db/phase-queries";
import {
  getPersonaDocumentsByProjectId,
  getProjectById,
} from "@/lib/db/queries";
import { getProjectTasks } from "@/lib/db/task-queries";
import type { PersonaVersion } from "@/lib/personas/artifact";
import { latestPersonaVersion } from "@/lib/personas/artifact";
import { toCanvasPersonaInput } from "@/lib/personas/canvas-input";
import { resolveCurrentPhase } from "@/lib/phases/advance";
import { GateVerdictSchema } from "@/lib/phases/types";
import { analyzeBlockers } from "@/lib/ultraplan/blockers";
import type { CanvasPersonaInput } from "@/lib/ultraplan/graph";
import { buildCanvasGraph } from "@/lib/ultraplan/graph";
import { reconcileTasks } from "@/lib/ultraplan/tasks";
import type { BlockerAnalysis, CanvasGraph } from "@/lib/ultraplan/types";

/**
 * The read behind the project canvas route.
 *
 * WHY THIS EXISTS ALONGSIDE `canvas.getCanvas`. This is the SERVER-RENDERED
 * read: the route is a server component, and an RSC calling its own tRPC
 * endpoint over HTTP would pay a round trip to reach code already running in
 * the same process. The router is the CLIENT read plus the one mutation. Both
 * run the same three pure calls in the same order
 * (analyzeBlockers → reconcileTasks → buildCanvasGraph); neither decides
 * anything the other does not.
 *
 * The persona mapping is NOT duplicated here: both this file and
 * canvas.router.ts call `toCanvasPersonaInput` from lib/personas/canvas-input.ts.
 * They used to disagree about evidenceCount, summary and name — see that file
 * for what each of them got wrong.
 *
 * Ownership check is the one copied from `trpc/routers/phase.router.ts`,
 * including its deliberate lie-by-omission: a project somebody else owns is
 * reported exactly like a project that does not exist.
 */

export type ProjectCanvasData = {
  projectName: string;
  phaseKey: string;
  graph: CanvasGraph;
  analysis: BlockerAnalysis;
  /** Newest persona version for the project, readable or not. Null if none. */
  persona: PersonaVersion | null;
};

function toPersonaInput(version: PersonaVersion): CanvasPersonaInput {
  const artifact = version.artifact;
  return toCanvasPersonaInput({
    documentId: version.documentId,
    title: version.title,
    persona: artifact?.persona ?? null,
    groundedInFactKeys: artifact?.groundedInFactKeys ?? [],
  });
}

export async function loadProjectCanvas({
  projectId,
  userId,
}: {
  projectId: string;
  userId: string;
}): Promise<ProjectCanvasData | null> {
  const project = await getProjectById({ id: projectId });
  if (!project || project.userId !== userId) {
    return null;
  }

  const [phaseRows, factRows, personaRows, taskRows] = await Promise.all([
    getProjectPhases({ projectId }),
    getProjectFacts({ projectId }),
    getPersonaDocumentsByProjectId({ projectId }),
    getProjectTasks({ projectId }),
  ]);

  const { phase } = resolveCurrentPhase(
    phaseRows.map((row) => ({
      phaseKey: row.phaseKey,
      status: row.status as "locked" | "active" | "passed",
    }))
  );
  const row = phaseRows.find((r) => r.phaseKey === phase.key) ?? null;

  // PARSED, NOT CAST. `verdict` is a json column, i.e. genuinely unknown, and a
  // failed parse must yield NULL — which analyzeBlockers() reads as
  // "unassessed", NOT as "blocked".
  const parsed = GateVerdictSchema.safeParse(row?.verdict);
  const verdict = parsed.success ? parsed.data : null;

  const analysis = analyzeBlockers({
    phaseKey: phase.key,
    criteria: phase.exitCriteria,
    verdict,
  });

  // Founder-set task state, reconciled against what the CURRENT verdict
  // generates. Reconciling against [] instead would render every task at its
  // generated default and silently discard whatever the founder had already
  // ticked — the server-rendered canvas would disagree with the database.
  const tasks = reconcileTasks(
    analysis.tasks,
    taskRows.map((row) => ({
      id: row.taskId,
      state: row.state,
      title: row.title,
      detail: row.detail,
      criterionId: row.criterionId,
      producesFactKey: row.producesFactKey,
    }))
  );

  const persona = latestPersonaVersion(personaRows);

  const graph = buildCanvasGraph({
    analysis,
    tasks,
    facts: factRows.map((fact) => ({
      key: fact.key,
      value: fact.value,
      confidence: fact.confidence,
      phaseKey: fact.phaseKey,
    })),
    // Artifacts are documents that cite facts. Nothing writes that citation
    // list yet, so the lane is empty rather than populated with a guess.
    artifacts: [],
    personas: persona ? [toPersonaInput(persona)] : [],
  });

  return {
    projectName: project.name,
    phaseKey: phase.key,
    graph,
    analysis,
    persona,
  };
}
