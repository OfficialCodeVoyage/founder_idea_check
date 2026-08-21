"use server";

import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { getProjectFacts, getProjectPhases } from "@/lib/db/phase-queries";
import {
  getPersonaDocumentsByProjectId,
  getProjectById,
} from "@/lib/db/queries";
import { missingFromVerdict } from "@/lib/export/grounding";
import { buildHandoff } from "@/lib/export/handoff";
import { toExportPersonas } from "@/lib/export/persona";
import type { ExportPhaseState, HandoffOutcome } from "@/lib/export/types";

/**
 * Builds the FULL described repository and hands it back as `{path, contents}[]`.
 *
 * Nothing is written server-side. That is the whole point of the pure/impure
 * split in `lib/export/`: the same plan feeds a preview pane, a zip and a
 * filesystem write with no second code path.
 *
 * EXPORT-INTEGRATION-NOTES.md §4a puts this in `trpc/routers/export.router.ts`,
 * and that is still where it belongs — `trpc/routers/**` is owned by another
 * lane right now, so this is the same body behind a server action instead. The
 * ownership check is copied verbatim from `phase.router.ts`, including its
 * refusal to distinguish "does not exist" from "not yours".
 */

export type BuildHandoffResult =
  | { status: "unauthorized" }
  | { status: "not-found" }
  | HandoffOutcome;

export async function buildProjectHandoff({
  projectId,
}: {
  projectId: string;
}): Promise<BuildHandoffResult> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return { status: "unauthorized" };
  }

  const project = await getProjectById({ id: projectId });
  if (!project || project.userId !== session.user.id) {
    return { status: "not-found" };
  }

  const [factRows, phaseRows, personaRows] = await Promise.all([
    getProjectFacts({ projectId }),
    getProjectPhases({ projectId }),
    getPersonaDocumentsByProjectId({ projectId }),
  ]);

  const phases: ExportPhaseState[] = phaseRows.map((row) => ({
    phaseKey: row.phaseKey,
    status: row.status,
    decision: row.decision ?? null,
    reason: row.reason ?? null,
    nextQuestion: row.nextQuestion ?? null,
    // Parsed, not cast: `verdict` is a json column, i.e. genuinely unknown.
    missing: missingFromVerdict(row.verdict),
  }));

  return buildHandoff({
    project: { name: project.name, instructions: project.instructions },
    facts: factRows.map((row) => ({
      key: row.key,
      value: row.value,
      confidence: row.confidence,
      phaseKey: row.phaseKey,
      updatedAt: row.updatedAt,
    })),
    phases,
    // Rows in, pure shapes out: the DB read stays here and only row-shaped data
    // crosses into lib/export.
    personas: toExportPersonas(personaRows),
    // The ONLY clock in the whole feature, and it is here rather than inside
    // lib/export so the pure layer stays deterministic and testable.
    generatedAt: new Date(),
  });
}
