import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getLanguageModel } from "@/lib/ai/providers";
import { countTextTokens } from "@/lib/ai/token-utils";
import type { ChatMessage } from "@/lib/ai/types";
import { config } from "@/lib/config";
import {
  activateProjectPhase,
  getProjectFacts,
  getProjectPhases,
  upsertProjectFacts,
  upsertProjectPhase,
} from "@/lib/db/phase-queries";
import {
  getAllMessagesByChatId,
  getAllMessagesByProjectId,
} from "@/lib/db/queries";
import { createModuleLogger } from "@/lib/logger";
import { planPhaseAdvance, resolveCurrentPhase } from "./advance";
import {
  budgetTranscript,
  type StoredFact,
  selectAndRenderFacts,
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
 * The persona + phase brief already cost ~2,600 tokens and the base prompt
 * ~250, so this is the third-largest fixed cost of every turn. 900 is roughly
 * 45 fact lines at the shapes phase 1 produces — comfortably more than the 8
 * phases' vocabularies can generate — and it caps a store that would otherwise
 * grow monotonically with no ceiling at all.
 */
export const PHASE_FACT_BUDGET_TOKENS = 900;

/**
 * How many tokens of transcript the gate judge may read.
 *
 * The judge now sees the PROJECT transcript (every chat in the project), which
 * is strictly larger than the chat transcript it used to get, so it needs a
 * ceiling it never had. The oldest turns are the ones dropped, and the fact
 * store is what carries them forward — that is the whole bargain of fact
 * injection.
 */
export const GATE_TRANSCRIPT_BUDGET_TOKENS = 24_000;

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
  }[]
): StoredFact[] {
  return rows.map((r) => ({
    key: r.key,
    value: r.value,
    confidence: r.confidence,
    updatedAt: r.updatedAt,
    phaseKey: r.phaseKey,
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

  const block = selectAndRenderFacts(
    toStoredFacts(factRows),
    { phase, latestUserMessage },
    PHASE_FACT_BUDGET_TOKENS,
    { countTokens: countTextTokens }
  );
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

  await upsertProjectPhase({
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
export async function runPostTurnPhasePass({
  projectId,
  chatId,
  assistantMessageId,
}: {
  projectId: string;
  chatId: string;
  assistantMessageId: string | null;
}): Promise<void> {
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
    return;
  }

  try {
    await runPhasePass({
      projectId,
      chatId,
      assistantMessageId,
      phase,
      workflowComplete,
    });
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
}): Promise<void> {
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
  const chatTranscript = toTranscript(chatMessages);
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
      turn: chatTranscript.slice(-2),
      knownFacts: known,
    }
  );

  const { inserts, updates } = reconcileFacts(known, extracted);
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
