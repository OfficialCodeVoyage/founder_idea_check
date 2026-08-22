import "server-only";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { EmbeddingProvider } from "../embeddings/provider";
import { factEmbeddingText } from "../embeddings/text";
import { db } from "./client";
import type { FounderFactWrite } from "./fact-assertion";
import { PROJECT_FACT_UPSERT_SET } from "./fact-upsert";
import {
  type ProjectFact,
  type ProjectPhase,
  type ProjectPhaseAttempt,
  projectFact,
  projectPhase,
  projectPhaseAttempt,
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

/**
 * Writes the current phase state AND appends the verdict to the ledger, in one
 * transaction. Returns the attempt ordinal so callers can report it.
 *
 * Named `recordGateVerdict` rather than `upsertProjectPhase` because it no
 * longer only upserts: every call now leaves a permanent row in
 * `ProjectPhaseAttempt`. The rename is deliberate — a caller reaching for
 * "upsert" should not silently get an append.
 */
export async function recordGateVerdict({
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
  const evaluatedAt = new Date();
  try {
    return await db.transaction(async (tx) => {
      const [current] = await tx
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
          evaluatedAt,
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
            evaluatedAt,
            updatedAt: evaluatedAt,
          },
        })
        .returning({ attemptNo: projectPhase.attemptCount });

      // The ordinal is a label taken from the counter we just advanced; the
      // ledger's identity is (projectId, phaseKey, evaluatedAt), so a counter
      // anomaly cannot make this insert collide and roll back the write above.
      const attemptNo = current?.attemptNo ?? 1;
      await tx.insert(projectPhaseAttempt).values({
        projectId,
        phaseKey,
        attemptNo,
        decision,
        reason,
        nextQuestion,
        verdict,
        status: resolvedStatus,
        evaluatedAt,
      });

      return { attemptNo };
    });
  } catch (error) {
    console.error("Failed to record gate verdict in database", error);
    throw error;
  }
}

/**
 * The refusal history for one phase, oldest first.
 *
 * Ordered by `evaluatedAt`, which is the key and therefore genuinely
 * chronological — ordering by `attemptNo` would be a label sort.
 */
export async function getProjectPhaseAttempts({
  projectId,
  phaseKey,
}: {
  projectId: string;
  phaseKey: string;
}): Promise<ProjectPhaseAttempt[]> {
  try {
    return await db
      .select()
      .from(projectPhaseAttempt)
      .where(
        and(
          eq(projectPhaseAttempt.projectId, projectId),
          eq(projectPhaseAttempt.phaseKey, phaseKey)
        )
      )
      .orderBy(projectPhaseAttempt.evaluatedAt);
  } catch (error) {
    console.error("Failed to get phase attempts from database", error);
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
 * THE FOUNDER CORRECTS ONE FACT'S VALUE. Not its key, not its confidence.
 *
 * The key is identity — it is half of the (projectId, key) unique index, and
 * "correcting" it would be a delete plus an insert wearing a rename.
 *
 * Confidence is deliberately NOT editable, and removing the control removes the
 * question rather than answering it badly. `renderFactsLedger` ships this
 * sentence in every exported FACTS.md: confidence "is the extractor's own
 * certainty at the moment it recorded the fact — it is not a quality score and
 * it was never revised upwards by anything". A founder-editable confidence
 * makes a shipped document lie, and it is the exact dial that would let someone
 * pass their own gate on an assumption. The correction carries the extracted
 * row's confidence forward untouched; what changes is the PROVENANCE.
 *
 * THE EMBEDDING MUST GO WITH THE VALUE. `embedding` is a vector over
 * "key: value" (lib/embeddings/text.ts). Leaving it behind would mean fact
 * SELECTION keeps retrieving on the old wording while the founder reads the new
 * one — silently, forever. All three embedding columns are nulled together
 * because ProjectFact_embedding_labelled requires it, and
 * `backfillFactEmbeddings` re-embeds anything with a null embedding on the next
 * turn, so no new embedding code is needed.
 *
 * Returns the number of rows changed. `projectId` is in the PREDICATE, not just
 * the values, so a key belonging to another project updates nothing.
 */
export async function correctProjectFact({
  projectId,
  key,
  value,
}: {
  projectId: string;
  key: string;
  value: string;
}): Promise<number> {
  try {
    const rows = await db
      .update(projectFact)
      .set({
        value,
        origin: "founder",
        correctedAt: new Date(),
        embedding: null,
        embeddingModel: null,
        embeddingDims: null,
        embeddedAt: null,
      })
      .where(
        and(eq(projectFact.projectId, projectId), eq(projectFact.key, key))
      )
      .returning({ key: projectFact.key });
    return rows.length;
  } catch (error) {
    console.error("Failed to correct project fact in database", error);
    throw error;
  }
}

/**
 * THE FOUNDER ENTERS EVIDENCE THEY GATHERED IN THE FIELD.
 *
 * The other half of the gate's `offline-only` classification. When every
 * outstanding criterion needs data that does not exist yet, the gate stops
 * asking for the value and asks for the INSTRUMENT instead (`instrumentQuestion`
 * in lib/phases/gate.ts). This is where the results of running it come back —
 * structured, so the founder names the fact key and the value directly rather
 * than pasting five field logs into chat and hoping the extractor guesses.
 *
 * EVERY JUDGEMENT ALREADY HAPPENED, in the PURE `planFactAssertion`
 * (lib/db/fact-assertion.ts). The `FounderFactWrite` this takes is branded and
 * cannot be built anywhere else, which is what makes the confidence policy
 * structural instead of a rule everyone has to remember. This function only
 * writes what it is handed — the same posture as `upsertProjectFacts` below.
 *
 * ON CONFLICT DO NOTHING, AND THAT IS THE WHOLE DECISION ABOUT ASSERTING OVER
 * AN EXISTING FACT. A key that already holds a fact is refused; the founder is
 * pointed at Correct on that row instead. Both alternatives are worse:
 *
 *   - overwrite and CARRY THE STORED CONFIDENCE FORWARD, as `correctProjectFact`
 *     does, and a founder could type any value onto a key holding an
 *     85-confidence extracted fact and inherit the 85. That is the confidence
 *     raise the whole design forbids, done through the back door.
 *   - overwrite and RESET to the assertion floor, and a founder loses the
 *     extractor's record of what the transcript actually said, silently and
 *     without asking for it.
 *
 * Correction is already the right tool for "there is a fact here and it is
 * wrong": it changes the wording, flips the provenance to `founder`, and leaves
 * the extractor's confidence untouched. Keeping the two paths apart keeps each
 * one honest. It is enforced at the DATABASE rather than by a read-then-write,
 * so two tabs racing cannot slip a second one through.
 *
 * `correctedAt` is set because ProjectFact_origin_coherent requires
 * `(origin = 'founder') = (correctedAt IS NOT NULL)` — the column records when
 * the founder last put their name to the row, and for an asserted fact that is
 * the moment it was created. `sourceMessageId` stays NULL: there is genuinely
 * no assistant message behind this one, which is the point.
 *
 * The embedding columns are left NULL together (the CHECK needs them together),
 * so `backfillFactEmbeddings` picks the row up on the next turn and it becomes
 * retrievable like any other fact.
 */
export async function assertProjectFact({
  projectId,
  write,
}: {
  projectId: string;
  write: FounderFactWrite;
}): Promise<"recorded" | "key-already-held"> {
  try {
    const rows = await db
      .insert(projectFact)
      .values({
        projectId,
        phaseKey: write.phaseKey,
        key: write.key,
        value: write.value,
        confidence: write.confidence,
        sourceMessageId: null,
        origin: "founder",
        correctedAt: new Date(),
        extractedAt: new Date(),
      })
      .onConflictDoNothing({
        target: [projectFact.projectId, projectFact.key],
      })
      .returning({ key: projectFact.key });
    return rows.length === 0 ? "key-already-held" : "recorded";
  } catch (error) {
    console.error("Failed to assert project fact in database", error);
    throw error;
  }
}

/**
 * The founder removes a fact outright.
 *
 * Deletion is the honest option when a fact is not merely worded wrong but
 * false. It is NOT a soft delete: a fact the founder has disowned should not go
 * on grounding the persona, the simulation or the export from behind a flag.
 *
 * Note the consequence, which the UI states before the click: removing facts
 * can drop a phase below `gate.minFactsRequired`, and the gate will then BLOCK.
 * That is the gate working.
 */
export async function deleteProjectFact({
  projectId,
  key,
}: {
  projectId: string;
  key: string;
}): Promise<number> {
  try {
    const rows = await db
      .delete(projectFact)
      .where(
        and(eq(projectFact.projectId, projectId), eq(projectFact.key, key))
      )
      .returning({ key: projectFact.key });
    return rows.length;
  } catch (error) {
    console.error("Failed to delete project fact from database", error);
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
        set: PROJECT_FACT_UPSERT_SET,
      });
  } catch (error) {
    console.error("Failed to upsert project facts in database", error);
    throw error;
  }
}

/**
 * Fills in `embedding` for the facts of one project that do not have a current
 * one — either never embedded, or embedded by a DIFFERENT model, which is the
 * case that matters after a model change: two models at the same width produce
 * cosine distances that are arithmetically valid and semantically meaningless,
 * so a mixed column is worse than an empty one.
 *
 * INCREMENTAL BY CONSTRUCTION. It only ever touches rows that need work, so
 * calling it on every turn costs one query and nothing else once a project is
 * warm. Embedding is ~$0.02/1M tokens; a 200-fact project is ~10k tokens, so
 * even a full re-embed is about $0.0002. This is not a budget line.
 *
 * NEVER THROWS. It runs after the response is already flushed, as enrichment.
 * A failure here must degrade retrieval to the keyword selector — which needs
 * no key and no network — and never break a turn or lose a fact. Returning the
 * count lets the caller log the degradation instead of it being invisible.
 */
export async function backfillFactEmbeddings({
  projectId,
  provider,
  onError,
}: {
  projectId: string;
  provider: EmbeddingProvider;
  onError?: (error: unknown) => void;
}): Promise<{ embedded: number; tokens: number | null }> {
  try {
    const stale = await db
      .select({
        id: projectFact.id,
        key: projectFact.key,
        value: projectFact.value,
      })
      .from(projectFact)
      .where(
        and(
          eq(projectFact.projectId, projectId),
          or(
            isNull(projectFact.embedding),
            ne(projectFact.embeddingModel, provider.model),
            ne(projectFact.embeddingDims, provider.dimensions)
          )
        )
      );

    if (stale.length === 0) {
      return { embedded: 0, tokens: 0 };
    }

    const result = await provider.embed(stale.map(factEmbeddingText));

    // One UPDATE per fact rather than one bulk statement: the rows are few
    // (only the stale ones), and a per-row update keeps a single bad vector
    // from failing the whole batch at the embedding_labelled CHECK.
    let embedded = 0;
    for (const [i, row] of stale.entries()) {
      const vector = result.vectors[i];
      if (!vector) {
        continue;
      }
      await db
        .update(projectFact)
        .set({
          embedding: vector,
          embeddingModel: result.model,
          embeddingDims: result.dimensions,
          embeddedAt: new Date(),
        })
        .where(eq(projectFact.id, row.id));
      embedded++;
    }

    return { embedded, tokens: result.tokens };
  } catch (error) {
    onError?.(error);
    return { embedded: 0, tokens: null };
  }
}
