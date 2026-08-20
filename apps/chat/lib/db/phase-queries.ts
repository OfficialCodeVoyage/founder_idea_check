import "server-only";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { EmbeddingProvider } from "../embeddings/provider";
import { factEmbeddingText } from "../embeddings/text";
import { db } from "./client";
import { PROJECT_FACT_UPSERT_SET } from "./fact-upsert";
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
