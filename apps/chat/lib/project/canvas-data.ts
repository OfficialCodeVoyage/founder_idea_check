import "server-only";

import { getProjectFacts, getProjectPhases } from "@/lib/db/phase-queries";
import {
  getPersonaDocumentsByProjectId,
  getProjectById,
} from "@/lib/db/queries";
import { getProjectTasks } from "@/lib/db/task-queries";
import type { PersonaVersion } from "@/lib/personas/artifact";
import { latestPersonaVersion } from "@/lib/personas/artifact";
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
 * KNOWN DIVERGENCE, recorded rather than left to be discovered: this file and
 * canvas.router.ts count persona evidence differently — the router totals
 * interviews, attributes, observable attributes and excluded segments, this one
 * totals observable attributes only. Same persona, two numbers. Deduping them
 * means one shared mapper both import; until that lands, the router's count is
 * the more complete of the two.
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
  if (!artifact) {
    // Unreadable row. NULL evidenceCount, not 0: "we could not read this" and
    // "this persona cites nothing" are different failures and the canvas paints
    // them differently (unknown vs at-risk).
    return {
      id: version.documentId,
      name: version.title,
      summary: null,
      evidenceCount: null,
      derivedFromFactKeys: [],
    };
  }
  const persona = artifact.persona;
  const evidenceCount = persona.observableAttributes.reduce(
    (total, observable) => total + observable.evidence.length,
    0
  );
  return {
    id: version.documentId,
    name: persona.label,
    summary: persona.observableAttributes
      .map((observable) => `${observable.dimension}: ${observable.value}`)
      .join(", "),
    evidenceCount,
    derivedFromFactKeys: artifact.groundedInFactKeys,
  };
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
