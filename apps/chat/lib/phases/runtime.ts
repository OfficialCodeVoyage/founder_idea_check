import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getLanguageModel } from "@/lib/ai/providers";
import { countTextTokens } from "@/lib/ai/token-utils";
import type { ChatMessage } from "@/lib/ai/types";
import { config } from "@/lib/config";
import {
  activateProjectPhase,
  backfillFactEmbeddings,
  getProjectFacts,
  getProjectPhases,
  recordGateVerdict,
  upsertProjectFacts,
} from "@/lib/db/phase-queries";
import {
  getAllMessagesByChatId,
  getAllMessagesByProjectId,
} from "@/lib/db/queries";
import { getEmbeddingProvider } from "@/lib/embeddings/provider";
import { createModuleLogger } from "@/lib/logger";
import { selectActiveThread } from "@/lib/thread-utils";
import { planPhaseAdvance, resolveCurrentPhase } from "./advance";
import {
  budgetTranscript,
  EmbeddingFactSelector,
  GATE_TRANSCRIPT_BUDGET_TOKENS,
  type StoredFact,
  selectAndRenderFacts,
  selectAndRenderFactsWith,
} from "./context";
import {
  buildPhaseDirective,
  buildPhaseSystemBlockText,
  toPhaseGateState,
} from "./directive";
import { extractFacts, reconcileFacts } from "./extract";
import { evaluateGate, failClosedVerdict } from "./gate";
import {
  createModelFactExtractor,
  createModelGateJudge,
} from "./model-adapters";
import type { GateVerdict, PhaseDefinition, TranscriptTurn } from "./types";

const log = createModuleLogger("phases:runtime");

/**
 * How many tokens the fact block may cost, per turn, forever.
 *
 * MEASURED, not guessed. The previous value (900) was justified as "roughly 45
 * fact lines … comfortably more than the 8 phases' vocabularies can generate".
 * Both halves of that were wrong, and measuring says so:
 *
 *   - The vocabulary is 66 distinct keys, not ~45. (Union of every phase's
 *     `factKeys`; `sanitizeFacts` restricts the extractor to them and
 *     ProjectFact is keyed by (projectId, key), so 66 rows is the hard ceiling
 *     on the store, not an estimate.)
 *   - A rendered fact line costs a MEASURED mean of 27.1 tokens (median 27,
 *     p90 38, max 58) over the 82 human-written fact values in
 *     evals/fixtures/gate-phase-01.ts — the corpus the gate is calibrated
 *     against, written to the exact shape the extractor is told to produce.
 *     900/45 assumed 20.
 *
 * So the complete store costs 1,901 tokens, and 900 carried 26 of 66 facts by
 * the last phase — it silently evicted 61% of everything the first seven
 * phases established. Divergence begins at phase 4 (34 facts, 991 tokens).
 *
 * WHY THAT WAS INVISIBLE: the loud alarm below fires only on droppedPinnedKeys,
 * and pinned facts always fit (the worst single phase pins 258 tokens' worth).
 * The facts being evicted were the unpinned ones — which are exactly what the
 * fact store exists to carry, since the transcript budget drops the old turns
 * and "the fact store is what carries them forward" is the whole bargain.
 *
 * WHY IT MATTERS RATHER THAN JUST COSTS: the judge reads the fact store
 * UNBUDGETED (runPhasePass passes every row of getProjectFacts to
 * evaluateGate). Only the assistant's system prompt was budgeted. So the judge
 * could block citing a fact the assistant was never shown — the same asymmetry
 * as the transcript window, in the other half of the context.
 *
 * 2,400 covers the measured complete store (1,901) with 26% headroom, which is
 * within a hair of the 2,460 the same 66 keys cost if EVERY value were as long
 * as the corpus's p90. It is still a cap, and eviction still works — a store
 * that somehow exceeds it degrades exactly as before, loudly.
 */
export const PHASE_FACT_BUDGET_TOKENS = 2400;

/**
 * Re-exported from ./context, which is where it now lives: the number is also
 * the ASSISTANT's context-window budget (lib/ai/core-chat-agent.ts), and a
 * pure module is the only place both sides can read it from.
 */

/** Provenance comments must never reach the model — they cost ~330 tokens. */
function stripComments(markdown: string): string {
  return markdown.replace(/<!--[\s\S]*?-->/g, "").trim();
}

const promptCache = new Map<string, string>();

/**
 * relPath is relative to apps/chat/prompts, e.g. "phases/phase-01-problem.md".
 *
 * DEGRADES, never throws. A missing or unreadable prompt file used to take down
 * every chat turn for every project with a 500 — the read happens inside
 * getSystemPrompt, before the stream is created, so there is no partial answer
 * and no error surface beyond a blank failure. An empty section is dropped by
 * buildPhaseSystemBlockText, so the founder gets a degraded (persona-less or
 * brief-less) turn plus a logged error, which is recoverable. Failures are NOT
 * cached: a file restored on disk must take effect without a restart.
 */
export function loadPrompt(relPath: string): string {
  const cached = promptCache.get(relPath);
  if (cached !== undefined) {
    return cached;
  }
  let text: string;
  try {
    text = stripComments(
      readFileSync(join(process.cwd(), "prompts", relPath), "utf8")
    );
  } catch (error) {
    log.error({ error, relPath }, "phase prompt file could not be read");
    return "";
  }
  promptCache.set(relPath, text);
  return text;
}

export function loadPersonaPrompt(): string {
  return [
    loadPrompt("persona/honesty-protocol.md"),
    loadPrompt("persona/problem-validation-rubric.md"),
  ]
    .filter((s) => s.length > 0)
    .join("\n\n---\n\n");
}

function toTranscript(messages: ChatMessage[]): TranscriptTurn[] {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      text: m.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("\n")
        .trim(),
    }))
    .filter((t) => t.text.length > 0);
}

/**
 * The exchange the extractor is meant to learn from: the last user turn and
 * everything the assistant said in reply to it.
 *
 * This used to be `slice(-2)`, which is only "last user + assistant" when each
 * user turn has exactly one assistant reply. With parallel responses on, one
 * user message gets N assistant messages, so `slice(-2)` returned TWO ASSISTANT
 * TURNS AND NO USER TURN — the extractor was shown answers with the question
 * removed and asked what the founder had established. selectActiveThread now
 * collapses a parallel group to its primary reply upstream of this, but the
 * positional assumption was still the bug: anchoring on the last user turn is
 * true whatever the shape of the tail, including a multi-step reply and an
 * assistant turn that contributed no text.
 *
 * Falls back to the last two turns only when the tail holds no user turn at
 * all, so a first-turn or resumed-stream edge case still extracts something
 * rather than nothing.
 */
function lastExchange(turns: TranscriptTurn[]): TranscriptTurn[] {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "user") {
      return turns.slice(i);
    }
  }
  return turns.slice(-2);
}

/**
 * The wider projection the ranker needs. `toKnownFacts` used to drop
 * updatedAt/phaseKey here, which is why the fact block could only ever be
 * ordered alphabetically.
 */
function toStoredFacts(
  rows: {
    key: string;
    value: string;
    confidence: number;
    updatedAt: Date;
    phaseKey: string;
    embedding?: number[] | null;
  }[]
): StoredFact[] {
  return rows.map((r) => ({
    key: r.key,
    value: r.value,
    confidence: r.confidence,
    updatedAt: r.updatedAt,
    phaseKey: r.phaseKey,
    // Carried through so the semantic ranker embeds only what is missing. A
    // warm project therefore costs ONE embedding call per turn — the query.
    embedding: r.embedding ?? null,
  }));
}

/**
 * Read-side: what gets appended to the chat system prompt, at the START of the
 * turn.
 *
 * THIS IS THE EDGE THAT CLOSES THE LOOP. The gate writes its verdict after the
 * turn, in `after()`, once the response is already flushed — so the verdict for
 * turn N has exactly one place to land, and it is here, in turn N+1's system
 * prompt. Without this read the verdict reaches the rail badge and dies there.
 *
 * All the judgement is in pure functions (resolveCurrentPhase, toPhaseGateState,
 * selectAndRenderFacts, buildPhaseDirective); this only fetches and wires.
 */
export async function buildPhaseSystemBlock({
  projectId,
  latestUserMessage,
}: {
  projectId: string;
  /** Ranks the fact block against what this turn is actually about. */
  latestUserMessage?: string;
}): Promise<string> {
  const [factRows, phaseRows] = await Promise.all([
    getProjectFacts({ projectId }),
    getProjectPhases({ projectId }),
  ]);

  const resolution = resolveCurrentPhase(
    phaseRows.map((r) => ({
      phaseKey: r.phaseKey,
      status: r.status as "locked" | "active" | "passed",
    }))
  );
  const { phase } = resolution;
  const row = phaseRows.find((r) => r.phaseKey === phase.key) ?? null;

  /**
   * Semantic ranking when an embedding provider is configured, keyword ranking
   * when it is not. Both are the same seam and produce the same shape, so this
   * is the only line that knows which one ran.
   *
   * The keyword path is not a degraded mode to be ashamed of — it needs no key
   * and no network, which is the promise this project makes to self-hosters.
   * EmbeddingFactSelector falls back to it on ANY failure rather than
   * returning nothing, because an empty fact block would turn a retrieval
   * outage into a phase BLOCK the founder cannot clear by answering.
   */
  const storedFacts = toStoredFacts(factRows);
  const selectOpts = { phase, latestUserMessage };
  const embeddingProvider = getEmbeddingProvider();
  const block = embeddingProvider
    ? await selectAndRenderFactsWith(
        new EmbeddingFactSelector({
          embed: async (texts) =>
            (await embeddingProvider.embed(texts)).vectors,
          onFallback: (error) =>
            log.error(
              { error, projectId, phaseKey: phase.key },
              "fact embedding failed; fell back to keyword ranking"
            ),
        }),
        storedFacts,
        selectOpts,
        PHASE_FACT_BUDGET_TOKENS,
        { countTokens: countTextTokens }
      )
    : selectAndRenderFacts(storedFacts, selectOpts, PHASE_FACT_BUDGET_TOKENS, {
        countTokens: countTextTokens,
      });
  if (block.droppedPinnedKeys.length > 0) {
    // A fact a BLOCKING criterion names by hand did not fit. The gate will now
    // report a gap for a fact that IS in the store, and the founder cannot
    // clear it by answering. Loud on purpose.
    log.error(
      {
        projectId,
        phaseKey: phase.key,
        droppedPinnedKeys: block.droppedPinnedKeys,
        budget: PHASE_FACT_BUDGET_TOKENS,
      },
      "fact budget evicted a pinned fact — raise PHASE_FACT_BUDGET_TOKENS"
    );
  }

  return buildPhaseSystemBlockText({
    personaPrompt: loadPersonaPrompt(),
    phasePrompt: loadPrompt(phase.promptFile),
    factBlock: block.text,
    directive: buildPhaseDirective({
      phase,
      state: toPhaseGateState(row),
      previousPhase: resolution.previousPhase,
      nextPhase: resolution.nextPhase,
      workflowComplete: resolution.workflowComplete,
    }),
  });
}

/** Persists a verdict and whatever sequencing it implies. */
async function persistVerdict({
  projectId,
  phase,
  verdict,
  workflowComplete,
}: {
  projectId: string;
  phase: PhaseDefinition;
  verdict: GateVerdict;
  /** From resolveCurrentPhase. Keeps a finished arc from being un-finished. */
  workflowComplete: boolean;
}): Promise<void> {
  const plan = planPhaseAdvance(phase, verdict.decision, workflowComplete);

  await recordGateVerdict({
    projectId,
    phaseKey: plan.current.phaseKey,
    phaseOrder: plan.current.phaseOrder,
    status: plan.current.status,
    decision: verdict.decision,
    reason: verdict.reason,
    nextQuestion: verdict.nextQuestion,
    verdict,
  });

  if (plan.activate) {
    await activateProjectPhase({ projectId, ...plan.activate });
  }

  if (plan.workflowComplete) {
    // The last phase passing is a completed workflow, not an error.
    log.info({ projectId, phaseKey: phase.key }, "phase workflow complete");
  }
}

/**
 * Write-side: runs AFTER the turn. Extract facts, then gate. Never throws.
 * Extraction runs first so the gate sees the facts this turn produced — that is
 * what makes "zero facts ⇒ BLOCK" a real signal rather than a race.
 *
 * SCOPE. The gate reads the PROJECT transcript and the PROJECT fact store, and
 * writes a PROJECT-scoped verdict row. It used to read a CHAT transcript while
 * writing a project row, so a second chat in the same project would judge its
 * own two messages and overwrite the first chat's PASS with a BLOCK through the
 * (projectId, phaseKey) upsert. Project-scoping the transcript is the fix that
 * matches the scope of both the fact store and the verdict; chat-scoping the
 * verdict instead would fork phase state per chat, contradict the "a fact is
 * identified by what it says about the project" rule the fact schema is built
 * on, and need a migration.
 *
 * Extraction still runs on the CHAT transcript's last two turns: it is learning
 * from the exchange that just happened in THIS chat, and the project tail could
 * belong to a different conversation entirely.
 */
/**
 * WHAT THE POST-TURN PASS DID, reported to its caller.
 *
 * Returned rather than void so the route can sequence a persona regeneration
 * off it without this module importing lib/personas (which reaches the db
 * client, and would drag a heavy import into every consumer of this file).
 *
 * `assessed: false` is NOT the same as a BLOCK. It means the gate never
 * reached a verdict — the phase could not be resolved, or the pass failed and
 * a fail-closed row was written. A caller must not read it as a judgement.
 */
export type PhasePassOutcome =
  | {
      status: "assessed";
      phaseKey: string;
      decision: "PASS" | "WARN" | "BLOCK";
      /** Facts this turn's extraction inserted or revised. */
      factsChanged: number;
    }
  | { status: "not-assessed"; phaseKey: string | null; reason: string };

export async function runPostTurnPhasePass({
  projectId,
  chatId,
  assistantMessageId,
}: {
  projectId: string;
  chatId: string;
  assistantMessageId: string | null;
}): Promise<PhasePassOutcome> {
  let phase: PhaseDefinition;
  let workflowComplete: boolean;
  try {
    const phaseRows = await getProjectPhases({ projectId });
    const resolution = resolveCurrentPhase(
      phaseRows.map((r) => ({
        phaseKey: r.phaseKey,
        status: r.status as "locked" | "active" | "passed",
      }))
    );
    phase = resolution.phase;
    workflowComplete = resolution.workflowComplete;
  } catch (error) {
    // The DB is unreachable, so there is nothing to fail closed INTO.
    log.error(
      { error, projectId, chatId },
      "phase pass could not resolve the current phase"
    );
    return {
      status: "not-assessed",
      phaseKey: null,
      reason: "the current phase could not be resolved",
    };
  }

  try {
    const { decision, factsChanged } = await runPhasePass({
      projectId,
      chatId,
      assistantMessageId,
      phase,
      workflowComplete,
    });
    return {
      status: "assessed",
      phaseKey: phase.key,
      decision,
      factsChanged,
    };
  } catch (error) {
    // A post-turn pass must never break the stream. But it must also never fail
    // SILENTLY: before this, no key meant no model, which threw, which was
    // swallowed, which left no row at all — and the rail's null default made
    // that look identical to "not assessed yet". Log it, then write a real
    // fail-closed BLOCK so the state on screen is the truth.
    const message = error instanceof Error ? error.message : String(error);
    log.error(
      { error, projectId, chatId, phaseKey: phase.key },
      "phase pass failed — writing a fail-closed BLOCK"
    );
    await writeFailClosed({ projectId, phase, message, workflowComplete });
    // A fail-closed BLOCK is written, but the gate did not ASSESS anything.
    // Reporting it as a BLOCK decision here would invite a caller to treat a
    // failure as a judgement.
    return { status: "not-assessed", phaseKey: phase.key, reason: message };
  }
}

async function runPhasePass({
  projectId,
  chatId,
  assistantMessageId,
  phase,
  workflowComplete,
}: {
  projectId: string;
  chatId: string;
  assistantMessageId: string | null;
  /** From resolveCurrentPhase. Keeps a finished arc from being un-finished. */
  workflowComplete: boolean;
  phase: PhaseDefinition;
}): Promise<{ decision: "PASS" | "WARN" | "BLOCK"; factsChanged: number }> {
  const [projectMessages, chatMessages, priorRows] = await Promise.all([
    getAllMessagesByProjectId({ projectId }),
    getAllMessagesByChatId({ chatId }),
    getProjectFacts({ projectId }),
  ]);

  const projectTranscript = budgetTranscript(
    toTranscript(projectMessages),
    GATE_TRANSCRIPT_BUDGET_TOKENS,
    countTextTokens
  );
  if (projectTranscript.omittedTurns > 0) {
    log.info(
      {
        projectId,
        omittedTurns: projectTranscript.omittedTurns,
        budget: GATE_TRANSCRIPT_BUDGET_TOKENS,
      },
      "gate transcript trimmed to budget — older turns are carried by the fact store"
    );
  }
  // getAllMessagesByProjectId already returns the live path through each tree.
  // getAllMessagesByChatId deliberately does NOT — the branch switcher and
  // getThreadUpToMessageId both need every sibling — so the selection happens
  // here, at the one consumer that wants judged evidence rather than raw rows.
  const chatTranscript = toTranscript(selectActiveThread(chatMessages));
  const known = priorRows.map((r) => ({
    key: r.key,
    value: r.value,
    confidence: r.confidence,
  }));

  // Both ids come from config.ai.workflows. workflows.chat is the JUDGE (the
  // gate is the product, so it gets the stronger model) and workflows.title is
  // the extractor (schema-constrained, so a cheap model is enough). Resolved
  // INSIDE the guarded path on purpose: with no gateway key this throws, and
  // the caller turns that into a written fail-closed BLOCK rather than silence.
  const [gateModel, extractModel] = await Promise.all([
    getLanguageModel(config.ai.workflows.chat),
    getLanguageModel(config.ai.workflows.title),
  ]);

  const extracted = await extractFacts(
    {
      extract: createModelFactExtractor({ model: extractModel }),
      onError: (error, stage) =>
        log.error(
          { err: error, stage, projectId, phaseKey: phase.key },
          "fact extraction failed — the turn continues with zero facts"
        ),
    },
    {
      phase,
      personaPrompt: loadPersonaPrompt(),
      turn: lastExchange(chatTranscript),
      knownFacts: known,
    }
  );

  const { inserts, updates } = reconcileFacts(known, extracted);
  const factsChanged = inserts.length + updates.length;
  await upsertProjectFacts({
    projectId,
    phaseKey: phase.key,
    sourceMessageId: assistantMessageId,
    facts: [...inserts, ...updates].map((f) => ({
      key: f.key,
      value: f.value,
      confidence: f.confidence,
    })),
  });

  /**
   * Embed whatever this turn just wrote, before the NEXT turn needs to rank it.
   * Incremental — it only touches rows with a missing or wrong-model vector —
   * so a warm project costs one query. Awaited rather than fired-and-forgotten
   * because this whole function already runs inside after(), where an
   * un-awaited promise is simply lost when the invocation is frozen.
   *
   * It never throws: a failure here degrades the next turn's ranking to
   * keyword and is logged, rather than losing a fact or breaking the turn.
   */
  const embeddingProvider = getEmbeddingProvider();
  if (embeddingProvider) {
    const { embedded } = await backfillFactEmbeddings({
      projectId,
      provider: embeddingProvider,
      onError: (error: unknown) =>
        log.error(
          { error, projectId, phaseKey: phase.key },
          "fact embedding backfill failed; ranking degrades to keyword"
        ),
    });
    if (embedded > 0) {
      log.debug({ projectId, embedded }, "embedded project facts");
    }
  }

  const factsAfter = (await getProjectFacts({ projectId })).map((r) => ({
    key: r.key,
    value: r.value,
    confidence: r.confidence,
  }));
  const verdict = await evaluateGate(
    { judge: createModelGateJudge({ model: gateModel }) },
    {
      phase,
      personaPrompt: loadPersonaPrompt(),
      phasePrompt: loadPrompt(phase.promptFile),
      transcript: projectTranscript.turns,
      facts: factsAfter,
    }
  );

  await persistVerdict({ projectId, phase, verdict, workflowComplete });

  return { decision: verdict.decision, factsChanged };
}

/**
 * Writes the BLOCK that says "the gate could not run". Fail-closed: an
 * unassessable phase is never an advanceable one.
 */
async function writeFailClosed({
  projectId,
  phase,
  message,
  workflowComplete,
}: {
  projectId: string;
  phase: PhaseDefinition;
  message: string;
  workflowComplete: boolean;
}): Promise<void> {
  try {
    await persistVerdict({
      projectId,
      phase,
      workflowComplete,
      verdict: failClosedVerdict(
        `the phase pass could not complete (${message})`,
        phase.exitCriteria.map((c) => ({ id: c.id, severity: c.severity }))
      ),
    });
  } catch (error) {
    log.error(
      { error, projectId, phaseKey: phase.key },
      "could not even write the fail-closed verdict"
    );
  }
}
