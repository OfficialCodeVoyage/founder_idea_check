"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import config from "@/chat.config";
import { auth } from "@/lib/auth";
import { addCredits, reserveCredits } from "@/lib/db/credits";
import { getProjectFacts } from "@/lib/db/phase-queries";
import { getProjectById } from "@/lib/db/queries";
import {
  getProjectPersonas,
  getSimulationProfiles,
  insertSimulationRun,
} from "@/lib/db/simulation-queries";
import { env } from "@/lib/env";
import type { SimulationSeedGap } from "@/lib/personas/simulation-gaps";
import { toSimulationPersonas } from "@/lib/personas/simulation-input";
import { createSidecarSimulationRunner } from "@/lib/research/sidecar-simulation";
import type { SimulationOutcome } from "@/lib/research/simulation";
import {
  estimateSimulationCostCents,
  MAX_SIMULATION_PITCH_CHARS,
  MAX_SIMULATION_SEATS,
  runSimulation,
  simulationReachedModel,
} from "@/lib/research/simulation";

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
 * A run that never happened — no personas, no sidecar — goes unrecorded,
 * because there is nothing to record; so does one that broke part way and
 * returned no reactions, though it is charged (`simulationReachedModel`).
 */

const DEFAULT_ROUNDS = 2;

/**
 * Failure kinds that mean the run HAPPENED and returned nothing, as opposed to
 * never having started. Only these are recorded: there is nothing to record
 * about a run that was refused before the sidecar was called.
 */
const RAN_BUT_PRODUCED_NOTHING = new Set(["no-reactions", "too-few-reactions"]);

/**
 * The divergence report for a run that produced nothing. Every field is zero
 * because nothing was measured — which is only safe to store BECAUSE the row
 * also carries `usable: null` and a named kind. Read on its own this shape is
 * indistinguishable from a total collapse, and that is exactly the confusion
 * the null exists to prevent.
 */
const EMPTY_DIVERGENCE = {
  score: 0,
  sentimentSpread: 0,
  duplicateRate: 0,
  distinctReactions: 0,
  totalReactions: 0,
};

/**
 * "You have no persona" (go do phase 3), "you have a persona with no simulation
 * profile" (fill in the form) and "you have one agent" (add a seat) are three
 * different next actions, so they get three distinct results. Collapsing them
 * into one string is the same class of error as `context_window: 0` standing in
 * for "the gateway did not report one".
 */
export type RunSimulationResult =
  | { status: "unauthorized" }
  | { status: "not-found" }
  | { status: "no-personas"; detail: string }
  | { status: "profile-incomplete"; gaps: SimulationSeedGap[] }
  /** The request itself is out of bounds (pitch length, seat count). */
  | { status: "invalid"; detail: string }
  /** The same refusal the chat route answers with HTTP 402. */
  | { status: "insufficient-credits" }
  | { status: "ran"; outcome: SimulationOutcome };

/** PURE. The pitch's refusal, or null when it may be sent. */
function pitchProblem(pitch: string): string | null {
  if (pitch.length === 0) {
    return "Write a pitch for the personas to react to.";
  }
  // Postgres `text` cannot hold U+0000 and `.trim()` keeps it, so a pitch
  // carrying one would run (and be charged) and then fail to be recorded.
  if (pitch.includes("\u0000")) {
    return "The pitch contains a null character (U+0000). Remove it and run the simulation again.";
  }
  if (pitch.length > MAX_SIMULATION_PITCH_CHARS) {
    return `The pitch is ${pitch.length} characters; a simulation takes at most ${MAX_SIMULATION_PITCH_CHARS}. Shorten it to the one or two sentences a buyer would hear.`;
  }
  return null;
}

export async function runProjectSimulation({
  projectId,
  pitch: rawPitch,
}: {
  projectId: string;
  pitch: string;
}): Promise<RunSimulationResult> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return { status: "unauthorized" };
  }
  const userId = session.user.id;

  const project = await getProjectById({ id: projectId });
  // "No such project" and "not yours" are deliberately the same answer, the
  // posture phase.router.ts takes.
  if (!project || project.userId !== userId) {
    return { status: "not-found" };
  }

  // Checked here as well as in the sidecar's request model: a refusal from
  // there would come back as a 422 and read as contract drift.
  const pitch = rawPitch.trim();
  const problem = pitchProblem(pitch);
  if (problem) {
    return { detail: problem, status: "invalid" };
  }

  const [versions, profiles, facts] = await Promise.all([
    getProjectPersonas({ projectId, userId: project.userId }),
    getSimulationProfiles({ projectId }),
    getProjectFacts({ projectId }),
  ]);

  if (versions.length === 0) {
    // This status now means ONLY "there is nothing to simulate", never "the
    // profile is missing".
    return {
      detail:
        "This project has no persona yet. Generate one in phase 3 — a simulation needs a persona to put in the room.",
      status: "no-personas",
    };
  }

  const seeded = toSimulationPersonas({ profiles, versions });
  if (!seeded.ok) {
    // Before the sidecar is touched and before anything is written.
    return { gaps: seeded.gaps, status: "profile-incomplete" };
  }

  // `saveSimulationProfile` refuses an eleventh seat, but a project may hold
  // seats saved before that limit existed. Refused by name rather than
  // silently trimmed: which seats sit in the room is the founder's choice.
  if (seeded.personas.length > MAX_SIMULATION_SEATS) {
    return {
      detail: `This project has ${seeded.personas.length} seats; a simulation seats at most ${MAX_SIMULATION_SEATS}. Remove a seat and run it again.`,
      status: "invalid",
    };
  }

  // CHARGED UP FRONT, REFUNDED ONLY WHEN THE RUN NEVER STARTED.
  //
  // The same gate as a chat turn (a positive balance), but taken atomically
  // with the charge: `reserveCredits` deducts only while the balance is
  // positive, in one statement, so concurrent runs cannot all start on the
  // same last cent. It sits after every local refusal above, so a request
  // refused here is never charged at all.
  //
  // The charge was once deducted after the run's row was written, so a run
  // whose insert failed (a database error, the project deleted mid-run) had
  // spent the operator's key and was free. The insert's success now decides
  // nothing about money: the only refund is for an outcome that provably
  // never reached the model (`simulationReachedModel`, by
  // `SIMULATION_NEVER_STARTED_KINDS`). The amount is an estimate — see
  // `estimateSimulationCostCents`. Both take this run's own seat and round
  // counts.
  const size = { seats: seeded.personas.length, rounds: DEFAULT_ROUNDS };
  const cost = estimateSimulationCostCents(size);
  if (!(await reserveCredits(userId, cost))) {
    return { status: "insufficient-credits" };
  }

  const outcome = await runSimulation(
    {
      run: createSidecarSimulationRunner({
        baseUrl: config.ai.tools.deepResearch.researchSidecarUrl,
        token: env.RESEARCH_SIDECAR_TOKEN,
      }),
    },
    {
      // THE TWO-AGENT FLOOR IS NOT RE-CHECKED HERE. `runSimulation` calls
      // `toOasisPersonas` before `deps.run`, so a one-seat project already gets
      // a named refusal ("only one persona — divergence is undefined over a
      // single agent") with no sidecar call and no row written. Two guards for
      // one rule is how they drift.
      personas: seeded.personas,
      facts: facts.map((fact) => ({ key: fact.key, value: fact.value })),
      pitch,
      rounds: DEFAULT_ROUNDS,
    }
  );

  if (!simulationReachedModel(outcome, size)) {
    await addCredits(userId, cost);
  }

  if (outcome.ok) {
    await insertSimulationRun({
      projectId,
      pitch,
      divergence: outcome.verdict.divergence,
      usable: outcome.verdict.usable,
      agentErrors: outcome.verdict.agentErrors,
      reactions: outcome.reactions,
    });
    revalidatePath(`/project/${projectId}/simulation`);
  } else if (RAN_BUT_PRODUCED_NOTHING.has(outcome.kind)) {
    // A RUN THAT HAPPENED AND CAME BACK EMPTY IS STILL A RUN.
    //
    // It is recorded with `usable: null` — not `false`, which is the COLLAPSED
    // badge — and with the named reason beside it, so the history can show
    // "this one did not produce a result" instead of either hiding it or
    // lying about it. Recording it was a deliberate product call: a founder
    // looking at a gap in their run history has no way to tell whether they
    // forgot to run one or whether one broke.
    //
    // The other failure kinds are NOT recorded: either the run never started
    // (`SIMULATION_NEVER_STARTED_KINDS`), or it broke part way and left no
    // reactions to record. The panel draws the same lines, and the second
    // case is still charged above.
    await insertSimulationRun({
      projectId,
      pitch,
      divergence: EMPTY_DIVERGENCE,
      usable: null,
      notAssessedKind: outcome.kind,
      agentErrors: outcome.agentErrors ?? null,
      reactions: [],
    });
    revalidatePath(`/project/${projectId}/simulation`);
  }

  return { status: "ran", outcome };
}
