import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getLanguageModel } from "@/lib/ai/providers";
import { countTextTokens } from "@/lib/ai/token-utils";
import type { ChatMessage } from "@/lib/ai/types";
import { config } from "@/lib/config";
import type { CostAccumulator } from "@/lib/credits/cost-accumulator";
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
import { embeddingCostCents } from "@/lib/embeddings/text";
import { createModuleLogger } from "@/lib/logger";
import { selectActiveThread } from "@/lib/thread-utils";
import {
  type DocumentToolType,
  documentToolTypes,
} from "@/tools/platform/documents/types";
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
  type DirectiveTarget,
  type PhaseGateState,
  toPhaseGateState,
} from "./directive";
import { extractFacts, reconcileFacts } from "./extract";
import { documentMarker, evaluateGate, failClosedVerdict } from "./gate";
import {
  chargeUsageTo,
  createModelFactExtractor,
  createModelGateJudge,
} from "./model-adapters";
import { humanizeCriterionId } from "./rail";
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

type MessagePart = ChatMessage["parts"][number];
type DocumentToolPart = Extract<MessagePart, { type: DocumentToolType }>;

const DOCUMENT_TOOL_TYPES: ReadonlySet<string> = new Set(documentToolTypes);

function isDocumentToolPart(part: MessagePart): part is DocumentToolPart {
  return DOCUMENT_TOOL_TYPES.has(part.type);
}

/**
 * What a message part contributes to a transcript line, or null for nothing.
 *
 * A DOCUMENT IS EVIDENCE, AND IT USED TO BE INVISIBLE. Only text parts were
 * kept, so a document the assistant wrote — the phase-1 interview protocol,
 * the pre-registered threshold that FIELDWORK_INSTRUCTION in directive.ts asks
 * the interviewer to help build — never reached the gate judge or the persona
 * pass. The founder did the work the gate asked for and the gate could not see
 * it: the deadlock the fieldwork instruction exists to end, moved one step
 * along.
 *
 * A ONE-LINE MARKER, NOT THE BODY. One document can be 26KB, and every turn
 * here competes for GATE_TRANSCRIPT_BUDGET_TOKENS; inlining bodies would push
 * the founder's own words out of the window to make room for the assistant's.
 * The marker says that the document exists, what it is called and how big it
 * is — enough for the judge to know the instrument was built, not enough for
 * it to grade the instrument's contents.
 *
 * ONLY A DOCUMENT THAT EXISTS. A document tool part counts once its call
 * completed and reported success (`output-available` with `status:
 * "success"`): a call whose input stream froze, or that errored, saved nothing,
 * and a marker for it would tell the judge about a document nobody can open.
 * Image and video turns and every other tool part stay dropped — they are tool
 * noise, not something the founder established.
 */
function transcriptPartText(part: MessagePart): string | null {
  if (part.type === "text") {
    return part.text;
  }
  if (
    isDocumentToolPart(part) &&
    part.state === "output-available" &&
    part.output.status === "success"
  ) {
    return documentMarker(part.input.title, part.input.content.length);
  }
  return null;
}

/**
 * Messages → the turns the gate judge, the extractor and the persona pass read.
 * Exported because lib/personas/runtime.ts reads the same transcript. It kept
 * its own copy of this projection, which meant the document blind spot had to
 * be found and fixed twice; one function means the judge and the persona pass
 * cannot disagree about what the conversation contained.
 *
 * A turn with nothing to contribute (no text, no document) is dropped, which
 * is what lastExchange's "anchored on the user turn" rule is written against.
 */
export function toTranscript(messages: ChatMessage[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") {
      continue;
    }
    const text = m.parts
      .map(transcriptPartText)
      .filter((t): t is string => t !== null)
      .join("\n")
      .trim();
    if (text.length > 0) {
      turns.push({ role: m.role, text });
    }
  }
  return turns;
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
    origin?: "extracted" | "founder";
  }[]
): StoredFact[] {
  return rows.map((r) => ({
    key: r.key,
    value: r.value,
    confidence: r.confidence,
    updatedAt: r.updatedAt,
    phaseKey: r.phaseKey,
    // ALWAYS supplied, so an absent origin downstream can only be a
    // hand-written literal and never a row that lost its provenance.
    origin: r.origin ?? "extracted",
    // Carried through so the semantic ranker embeds only what is missing. A
    // warm project therefore costs ONE embedding call per turn — the query.
    embedding: r.embedding ?? null,
  }));
}

/**
 * THE ONE PLACE A FOUNDER'S "THIS MESSAGE ANSWERS CRITERION X" BECOMES PROMPT.
 *
 * `raw` is the saved Message row's `targetCriterionId` (the chat route reads it
 * from the row, never from the request), so it is already NULL or shaped like
 * a criterion id: `lib/message-conversion.ts::chatMessageToDbMessage` and the
 * `Message_target_criterion_shape` CHECK see to that. It is still the
 * founder's input and is never interpolated. It is only COMPARED, exactly,
 * against the ids of the exit criteria of `phase` — the phase this turn
 * resolved as current — and that exact lookup is the whole validation: an
 * allowlist of the phase's own ids is stricter than any shape check. What the
 * prompt receives is that criterion's own definition text.
 *
 * Fails closed to "no target": an id of another phase (a stale target from
 * before an advance) or an id that names nothing yields null, and the turn
 * renders exactly as it would have with no target. A dropped target costs the
 * founder a hint; an accepted wrong one would aim the interviewer at the wrong
 * criterion.
 *
 * `alreadyMet` comes from the LAST verdict's per-criterion status. Without it
 * the paragraph presumes a gap, and a model told to name what is still open
 * invents one for a criterion the gate already counted as met.
 */
function resolveTarget(
  phase: PhaseDefinition,
  raw: string | null,
  state: PhaseGateState | null
): DirectiveTarget | null {
  const criterion = raw
    ? phase.exitCriteria.find((c) => c.id === raw)
    : undefined;
  if (!criterion) {
    return null;
  }
  return {
    // The same label the gate card shows for this criterion.
    title: humanizeCriterionId(criterion.id),
    description: criterion.description,
    closure: criterion.closure,
    alreadyMet:
      state?.perCriterion.some(
        (e) => e.criterionId === criterion.id && e.status === "met"
      ) ?? false,
  };
}

/**
 * The titles of `phase`'s offline-only exit criteria that the last verdict did
 * not score `met`, in definition order, for `fieldworkPlanLines` in
 * `./directive`. From the phase DEFINITION only: a criterion the judge never
 * scored counts as open, because "not scored" is not "met".
 */
function openFieldworkTitles(
  phase: PhaseDefinition,
  state: PhaseGateState | null
): string[] {
  return phase.exitCriteria
    .filter(
      (c) =>
        c.closure === "offline-only" &&
        !state?.perCriterion.some(
          (e) => e.criterionId === c.id && e.status === "met"
        )
    )
    .map((c) => humanizeCriterionId(c.id));
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
  targetCriterionId,
  costAccumulator,
}: {
  projectId: string;
  /** Ranks the fact block against what this turn is actually about. */
  latestUserMessage?: string;
  /**
   * The saved row of the message this turn answers: its `targetCriterionId`,
   * its criterion target, the exit criterion the founder said it answers (the gate card's
   * "Answer" / "Report what you found", sent by the composer). NULL or absent
   * means no target. `resolveTarget` is the only reader.
   */
  targetCriterionId?: string | null;
  /**
   * The TURN'S accumulator, still open at this point (the route settles it in
   * onFinish), so the query embedding is charged with the turn that needed it.
   */
  costAccumulator?: CostAccumulator;
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
          embed: async (texts) => {
            const result = await embeddingProvider.embed(texts);
            // Recorded only once the call has succeeded: a call that threw is
            // the fallback path, and its spend (if any) is not reported to us.
            if (result.tokens) {
              costAccumulator?.addAPICost(
                "fact-embeddings-query",
                embeddingCostCents(result.tokens)
              );
            }
            return result.vectors;
          },
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

  const state = toPhaseGateState(row);
  const target = resolveTarget(phase, targetCriterionId ?? null, state);
  if (targetCriterionId) {
    // The outcome only, never the value: a dropped id is founder input. An
    // accepted target renders only under a BLOCK or WARN verdict
    // (`buildPhaseDirective`); before the first verdict and after a PASS it is
    // valid but unused, and the log says so rather than claiming it was shown.
    const shown = state?.decision === "BLOCK" || state?.decision === "WARN";
    let outcome = "dropped";
    if (target && !shown) {
      outcome = "accepted-not-shown";
    } else if (target?.alreadyMet) {
      outcome = "accepted-already-met";
    } else if (target) {
      outcome = "accepted";
    }
    log.debug(
      { projectId, phaseKey: phase.key, target: outcome },
      "criterion target"
    );
  }

  return buildPhaseSystemBlockText({
    personaPrompt: loadPersonaPrompt(),
    phasePrompt: loadPrompt(phase.promptFile),
    factBlock: block.text,
    directive: buildPhaseDirective({
      phase,
      state,
      previousPhase: resolution.previousPhase,
      nextPhase: resolution.nextPhase,
      workflowComplete: resolution.workflowComplete,
      target,
      openFieldworkTitles: openFieldworkTitles(phase, state),
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
  userId,
  chatId,
  assistantMessageId,
  costAccumulator,
}: {
  projectId: string;
  /**
   * The project's OWNER. Scopes the judged transcript to that user's chats
   * (see `lib/db/queries.ts::getAllMessagesByProjectId`); the route checks the
   * chat's owner is the project's owner before it calls this.
   */
  userId: string;
  chatId: string;
  assistantMessageId: string | null;
  /**
   * Receives every paid call this pass makes — extraction, the judge, the
   * embedding backfill. The caller settles and charges it; this module only
   * records. Optional so a caller that is not billing (an eval) need not care.
   */
  costAccumulator?: CostAccumulator;
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
      userId,
      chatId,
      assistantMessageId,
      phase,
      workflowComplete,
      costAccumulator,
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
  userId,
  chatId,
  assistantMessageId,
  phase,
  workflowComplete,
  costAccumulator,
}: {
  projectId: string;
  userId: string;
  chatId: string;
  assistantMessageId: string | null;
  /** From resolveCurrentPhase. Keeps a finished arc from being un-finished. */
  workflowComplete: boolean;
  phase: PhaseDefinition;
  costAccumulator?: CostAccumulator;
}): Promise<{ decision: "PASS" | "WARN" | "BLOCK"; factsChanged: number }> {
  const [projectMessages, chatMessages, priorRows] = await Promise.all([
    getAllMessagesByProjectId({ projectId, userId }),
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
    // Same omission, same fix. The extractor is shown the known facts through
    // the same `renderFacts`, and it decides whether to overwrite them — so it
    // needs to know which ones a founder put there by hand.
    origin: r.origin,
  }));

  // Both ids come from config.ai.workflows. workflows.chat is the JUDGE (the
  // gate is the product, so it gets the stronger model) and workflows.extract
  // is the fact extractor.
  //
  // The extractor used to read workflows.title, on the reasoning that it is
  // schema-constrained so a cheap model would do. A schema constrains SHAPE,
  // not JUDGEMENT — this model decides which claims are facts and sets the
  // 0-100 confidence the gate acts on. It now has its own knob, so retuning it
  // is not a side effect of changing how chats get named. Same model as `title`
  // today; the point is that it need not stay that way.
  //
  // Resolved INSIDE the guarded path on purpose: with no gateway key this
  // throws, and the caller turns that into a written fail-closed BLOCK rather
  // than silence.
  const [gateModel, extractModel] = await Promise.all([
    getLanguageModel(config.ai.workflows.chat),
    getLanguageModel(config.ai.workflows.extract),
  ]);

  const extracted = await extractFacts(
    {
      extract: createModelFactExtractor({
        model: extractModel,
        onUsage: chargeUsageTo(costAccumulator, config.ai.workflows.extract),
      }),
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
    const { embedded, tokens } = await backfillFactEmbeddings({
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
    // `tokens` is null when the provider did not report usage or the call
    // failed; neither can be priced, and a failed call is not billed.
    if (tokens) {
      costAccumulator?.addAPICost(
        "fact-embeddings",
        embeddingCostCents(tokens)
      );
    }
  }

  const factsAfter = (await getProjectFacts({ projectId })).map((r) => ({
    key: r.key,
    value: r.value,
    confidence: r.confidence,
    // PROVENANCE REACHES THE JUDGE, AND IT DID NOT USED TO.
    //
    // `renderFacts` (gate.ts) annotates a founder-asserted fact with
    // ", asserted by the founder, not extracted" precisely so the judge can
    // weigh an assertion differently from evidence drawn out of the
    // transcript — the comment there calls that the point of the provenance
    // column. This map dropped `origin`, so the annotation could never fire on
    // the gate path and the marker was dead code: a fact the founder typed
    // read to the judge exactly like an observed quote. That is the one thing
    // the column exists to prevent, and it is the half of the founder
    // evidence-entry path that makes the rest of it mean anything.
    origin: r.origin,
  }));
  const verdict = await evaluateGate(
    {
      judge: createModelGateJudge({
        model: gateModel,
        onUsage: chargeUsageTo(costAccumulator, config.ai.workflows.chat),
      }),
    },
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
        phase.exitCriteria.map((c) => ({
          id: c.id,
          severity: c.severity,
          closure: c.closure,
        }))
      ),
    });
  } catch (error) {
    log.error(
      { error, projectId, phaseKey: phase.key },
      "could not even write the fail-closed verdict"
    );
  }
}
