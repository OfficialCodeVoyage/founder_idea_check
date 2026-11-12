import "server-only";
import { getProjectFacts } from "@/lib/db/phase-queries";
import { getPersonaDocumentsByProjectId } from "@/lib/db/queries";
import { createModuleLogger } from "@/lib/logger";
import { generateUUID } from "@/lib/utils";
import type { PhasePassOutcome } from "../phases/runtime";
import { regeneratePersona } from "./runtime";
import { decidePersonaRegeneration } from "./trigger";

/**
 * THE CALLER `regeneratePersona` NEVER HAD.
 *
 * `persona.regenerate` on the tRPC router was reachable from nothing — no
 * component, no route handler, no server action — and the post-turn phase pass
 * never called it either. So phase 3 (`user-personas`) passed its gate with an
 * empty `Document` table and the canvas reading "Personas 0". The generator
 * worked the whole time; nothing invoked it.
 *
 * This lives OUTSIDE lib/phases/runtime.ts on purpose. Importing
 * lib/personas/runtime from there would pull `./store` and the db client into
 * every consumer of the phase runtime; the route sequences the two passes
 * instead, off the `PhasePassOutcome` the phase pass now returns.
 */

const log = createModuleLogger("personas/post-turn");

/**
 * Regenerates the persona when this turn earned it. NEVER THROWS — it runs
 * inside `after()`, where an exception is an unhandled rejection that takes the
 * turn's tail with it.
 */
export async function runPostTurnPersonaPass({
  projectId,
  userId,
  assistantMessageId,
  outcome,
}: {
  projectId: string;
  userId: string;
  assistantMessageId: string | null;
  outcome: PhasePassOutcome;
}): Promise<void> {
  // Short-circuit BEFORE any I/O. Seven of the eight phases, and every turn the
  // gate did not assess, answer "no" from the outcome alone — they must not pay
  // for three project-wide reads to learn it. The same two conditions stay
  // inside `decidePersonaRegeneration` so the pure rule remains total.
  if (outcome.status !== "assessed") {
    return;
  }

  try {
    const [factRows, personaRows] = await Promise.all([
      getProjectFacts({ projectId }),
      getPersonaDocumentsByProjectId({ projectId, userId }),
    ]);

    // Grouped per documentId, NOT flattened. `latestPersonaVersion` orders a
    // flat set, so over multiple persona documents it would return whichever
    // document happens to hold the newest row — and appending to that one
    // forever would orphan the other histories.
    const byDocument = new Map<string, { createdAt: Date }[]>();
    for (const row of personaRows) {
      const list = byDocument.get(row.id) ?? [];
      list.push({ createdAt: row.createdAt });
      byDocument.set(row.id, list);
    }
    let newestDocumentId: string | null = null;
    let latestVersionCreatedAt: Date | null = null;
    for (const [documentId, versions] of byDocument) {
      for (const v of versions) {
        if (
          latestVersionCreatedAt === null ||
          v.createdAt.getTime() > latestVersionCreatedAt.getTime()
        ) {
          latestVersionCreatedAt = v.createdAt;
          newestDocumentId = documentId;
        }
      }
    }

    const latestFactUpdatedAt = factRows.reduce<Date | null>(
      (newest: Date | null, row: { updatedAt: Date | null }) => {
        const at = row.updatedAt;
        if (!at) {
          return newest;
        }
        return newest === null || at.getTime() > newest.getTime() ? at : newest;
      },
      null
    );

    const decision = decidePersonaRegeneration({
      phaseKey: outcome.phaseKey,
      assessed: true,
      decision: outcome.decision,
      factsChanged: outcome.factsChanged,
      factsStored: factRows.length,
      latestFactUpdatedAt,
      latestVersionCreatedAt,
    });

    if (!decision.regenerate) {
      log.debug({ projectId, why: decision.why }, "persona not regenerated");
      return;
    }

    if (assistantMessageId === null) {
      // RegeneratePersonaInput requires a messageId for provenance. A turn with
      // no assistant message has none, and inventing one would attach the
      // persona to a row that does not exist — the FK violation that used to
      // return HTTP 200 with an empty explanation.
      log.warn(
        { projectId, why: decision.why },
        "persona regeneration skipped: no assistant message to attribute it to"
      );
      return;
    }

    // Append to the existing history when there is one; a fresh uuid starts a
    // new persona at v1. Reusing the newest document is what keeps a project's
    // persona a single versioned artifact rather than a pile of v1s.
    const documentId = newestDocumentId ?? generateUUID();
    const result = await regeneratePersona({
      projectId,
      documentId,
      userId,
      messageId: assistantMessageId,
      latestUserMessage: undefined,
    });

    switch (result.persistence.status) {
      case "stored":
        log.debug(
          {
            projectId,
            documentId,
            version: result.persistence.version.version,
            why: decision.why,
          },
          "persona regenerated"
        );
        break;
      case "withheld":
        log.warn(
          { projectId, reasons: result.persistence.reasons },
          "persona was generated but is not a finding, so it was not stored"
        );
        break;
      default:
        // A database refusal, not a degraded artifact. Distinct on purpose.
        log.error(
          { projectId, documentId, reason: result.persistence.reason },
          "persona write failed"
        );
        break;
    }
  } catch (error) {
    log.error({ error, projectId }, "post-turn persona pass failed");
  }
}
