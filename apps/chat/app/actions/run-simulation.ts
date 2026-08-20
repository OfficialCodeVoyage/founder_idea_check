"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import config from "@/chat.config";
import { auth } from "@/lib/auth";
import { getProjectFacts } from "@/lib/db/phase-queries";
import { getProjectById } from "@/lib/db/queries";
import {
  getProjectPersonas,
  insertSimulationRun,
} from "@/lib/db/simulation-queries";
import { createSidecarSimulationRunner } from "@/lib/research/sidecar-simulation";
import type { SimulationOutcome } from "@/lib/research/simulation";
import { runSimulation } from "@/lib/research/simulation";

/**
 * Runs one simulation for a project and records it.
 *
 * Every judgement lives in the pure `runSimulation` — seeding, divergence, the
 * verdict. This action only supplies the population, the socket and the row.
 *
 * A COLLAPSED RUN IS STILL PERSISTED. `usable: false` means the personas all
 * said the same thing, which is the most useful diagnostic this feature
 * produces: it usually means they were seeded from too few facts. Recording
 * only the runs that "worked" would delete exactly the evidence a founder needs.
 * Only a run that never happened — no personas, no sidecar — goes unrecorded,
 * because there is nothing to record.
 */

const DEFAULT_ROUNDS = 2;

export type RunSimulationResult =
  | { status: "unauthorized" }
  | { status: "not-found" }
  | { status: "no-personas"; detail: string }
  | { status: "ran"; outcome: SimulationOutcome };

export async function runProjectSimulation({
  projectId,
  pitch,
}: {
  projectId: string;
  pitch: string;
}): Promise<RunSimulationResult> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return { status: "unauthorized" };
  }

  const project = await getProjectById({ id: projectId });
  // "No such project" and "not yours" are deliberately the same answer, the
  // posture phase.router.ts takes.
  if (!project || project.userId !== session.user.id) {
    return { status: "not-found" };
  }

  const [personas, facts] = await Promise.all([
    getProjectPersonas({ projectId }),
    getProjectFacts({ projectId }),
  ]);

  if (personas.length < 2) {
    // Divergence is undefined over fewer than two agents, so the run cannot
    // answer the question it exists to answer. Refused before the sidecar is
    // touched, and named rather than returned as an empty result.
    return {
      status: "no-personas",
      detail: `This project has ${personas.length} simulation persona${personas.length === 1 ? "" : "s"}. A simulation needs at least two, because divergence between one opinion and itself is not a finding.`,
    };
  }

  const outcome = await runSimulation(
    {
      run: createSidecarSimulationRunner({
        baseUrl: config.ai.tools.deepResearch.researchSidecarUrl,
      }),
    },
    {
      personas: personas.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        headline: row.headline,
        age: row.age,
        gender: row.gender,
        country: row.country,
        mbti: row.mbti ?? undefined,
      })),
      facts: facts.map((fact) => ({ key: fact.key, value: fact.value })),
      pitch,
      rounds: DEFAULT_ROUNDS,
    }
  );

  if (outcome.ok) {
    await insertSimulationRun({
      projectId,
      pitch,
      divergence: outcome.verdict.divergence,
      usable: outcome.verdict.usable,
      reactions: outcome.reactions,
    });
    revalidatePath(`/project/${projectId}/simulation`);
  }

  return { status: "ran", outcome };
}
