import { MockLanguageModelV3 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GATE_TRANSCRIPT_BUDGET_TOKENS } from "@/lib/phases/context";

/**
 * lib/phases/runtime.ts is the WIRING: the one impure file in lib/phases, the
 * place the pure gate, the pure fact selector and the real DB/model seams are
 * bolted together. It had no coverage at all, which is how a positional
 * `slice(-2)` could be wrong for parallel responses and a flattened message
 * tree could reach the judge as real turns without anything noticing.
 *
 * NO API KEY, NO NETWORK, NO DATABASE. Every boundary runtime.ts reaches
 * through is replaced at the module edge, and `getLanguageModel` hands back a
 * MockLanguageModelV3 — so the REAL model-adapters, the REAL generateText, the
 * REAL gate (all 11 guards) and the REAL sequencing all execute. The only
 * things faked are the four things that would need a key, a socket or Postgres.
 *
 * `server-only` is mocked because runtime.ts imports it; that marker throws
 * outside a react-server condition, which is precisely why every OTHER module
 * in lib/phases refuses to import it.
 */

vi.mock("server-only", () => ({}));

const getProjectPhases = vi.fn();
const getProjectFacts = vi.fn();
const recordGateVerdict = vi.fn();
const upsertProjectFacts = vi.fn();
const activateProjectPhase = vi.fn();
const backfillFactEmbeddings = vi.fn();
const getAllMessagesByProjectId = vi.fn();
const getAllMessagesByChatId = vi.fn();
const getLanguageModel = vi.fn();
const getEmbeddingProvider = vi.fn();

vi.mock("@/lib/db/phase-queries", () => ({
  activateProjectPhase: (...args: unknown[]) => activateProjectPhase(...args),
  backfillFactEmbeddings: (...args: unknown[]) =>
    backfillFactEmbeddings(...args),
  getProjectFacts: (...args: unknown[]) => getProjectFacts(...args),
  getProjectPhases: (...args: unknown[]) => getProjectPhases(...args),
  upsertProjectFacts: (...args: unknown[]) => upsertProjectFacts(...args),
  recordGateVerdict: (...args: unknown[]) => recordGateVerdict(...args),
}));

vi.mock("@/lib/db/queries", () => ({
  getAllMessagesByChatId: (...args: unknown[]) =>
    getAllMessagesByChatId(...args),
  getAllMessagesByProjectId: (...args: unknown[]) =>
    getAllMessagesByProjectId(...args),
}));

vi.mock("@/lib/ai/providers", () => ({
  getLanguageModel: (...args: unknown[]) => getLanguageModel(...args),
}));

vi.mock("@/lib/embeddings/provider", () => ({
  getEmbeddingProvider: () => getEmbeddingProvider(),
}));

import { PHASE_ONE, PHASES } from "./definitions";
import {
  buildPhaseSystemBlock,
  loadPersonaPrompt,
  loadPrompt,
  PHASE_FACT_BUDGET_TOKENS,
  runPostTurnPhasePass,
} from "./runtime";
import type { CriterionEvaluation, CriterionStatus } from "./types";

// ─── fixtures ────────────────────────────────────────────────────────────────

const PROJECT_ID = "project-1";
const CHAT_ID = "chat-1";

/** config.ai.workflows.chat is the judge. */
const JUDGE_MODEL_ID = "gpt-5.6-terra";

const FAILED_CLOSED_RE = /failed closed/i;
const NO_API_KEY_RE = /no api key configured/;

function mockModel(body: string) {
  return new MockLanguageModelV3({
    doGenerate: () =>
      Promise.resolve({
        content: [{ type: "text" as const, text: body }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 10, text: 10, reasoning: 0 },
        },
        warnings: [],
      }),
  });
}

function ev(
  criterionId: string,
  status: CriterionStatus,
  extra: Partial<CriterionEvaluation> = {}
): CriterionEvaluation {
  return {
    criterionId,
    status,
    evidence: extra.evidence ?? "the founder said so",
    gap: extra.gap ?? (status === "met" ? null : `${criterionId} is missing`),
    nextQuestion: extra.nextQuestion ?? null,
    confidence: 80,
  };
}

function judgeBody(overrides: Record<string, CriterionStatus> = {}): string {
  return JSON.stringify({
    evaluations: PHASE_ONE.exitCriteria.map((c) =>
      ev(c.id, overrides[c.id] ?? "met")
    ),
  });
}

const NO_FACTS_EXTRACTED = JSON.stringify({ facts: [] });

/** Nine stored facts — enough to clear decideGate's minFactsRequired guard. */
function storedFacts() {
  return PHASE_ONE.factKeys.map((key, i) => ({
    key,
    value: `established value for ${key}`,
    confidence: 90,
    updatedAt: new Date(2_000_000 + i),
    phaseKey: PHASE_ONE.key,
    embedding: null,
  }));
}

let msgClock = 0;
function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  parentMessageId: string | null,
  extra: Record<string, unknown> = {}
) {
  msgClock += 1000;
  return {
    id,
    role,
    parts: [{ type: "text", text }],
    metadata: { createdAt: new Date(msgClock), parentMessageId, ...extra },
  };
}

/** Whatever the extractor was actually shown, as "ROLE: text" lines. */
function extractorPrompt(): string {
  const call = extractModel.doGenerateCalls.at(-1);
  return JSON.stringify(call?.prompt ?? "");
}

/** Whatever the GATE JUDGE was actually shown. */
function judgePrompt(): string {
  const call = judgeModel.doGenerateCalls.at(-1);
  return JSON.stringify(call?.prompt ?? "");
}

let judgeModel: MockLanguageModelV3;
let extractModel: MockLanguageModelV3;

function useModels(judge: string, extract: string) {
  judgeModel = mockModel(judge);
  extractModel = mockModel(extract);
  getLanguageModel.mockImplementation((id: string) =>
    Promise.resolve(id === JUDGE_MODEL_ID ? judgeModel : extractModel)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  msgClock = 0;
  getProjectPhases.mockResolvedValue([
    { phaseKey: PHASE_ONE.key, status: "active" },
  ]);
  getProjectFacts.mockResolvedValue(storedFacts());
  // MUST resolve to an object: persistVerdict destructures `attemptNo` from
  // it. Left as undefined, the destructure throws inside the path whose whole
  // job is never to throw, runPostTurnPhasePass's catch converts that into a
  // fail-closed BLOCK, and roughly eight tests pass for the wrong reason.
  recordGateVerdict.mockResolvedValue({ attemptNo: 1 });
  upsertProjectFacts.mockResolvedValue(undefined);
  activateProjectPhase.mockResolvedValue(undefined);
  backfillFactEmbeddings.mockResolvedValue({ embedded: 0 });
  getEmbeddingProvider.mockReturnValue(null);
  getAllMessagesByProjectId.mockResolvedValue([
    message("u1", "user", "we sell to dentists", null),
    message("a1", "assistant", "who exactly?", "u1"),
  ]);
  getAllMessagesByChatId.mockResolvedValue([
    message("u1", "user", "we sell to dentists", null),
    message("a1", "assistant", "who exactly?", "u1"),
  ]);
  useModels(judgeBody(), NO_FACTS_EXTRACTED);
});

// ─── prompt loading ──────────────────────────────────────────────────────────

describe("loadPrompt", () => {
  it("reads a real phase prompt and strips provenance comments", () => {
    const text = loadPrompt(PHASE_ONE.promptFile);
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain("<!--");
  });

  it("DEGRADES to empty rather than throwing when the file is missing", () => {
    // A missing prompt used to 500 every chat turn for every project.
    expect(loadPrompt("phases/does-not-exist.md")).toBe("");
  });

  it("does not cache a failure — a restored file must work without a restart", () => {
    expect(loadPrompt("phases/still-missing.md")).toBe("");
    expect(loadPrompt("phases/still-missing.md")).toBe("");
  });

  it("builds the persona prompt from both persona files", () => {
    expect(loadPersonaPrompt().length).toBeGreaterThan(0);
  });
});

// ─── the read side ───────────────────────────────────────────────────────────

describe("buildPhaseSystemBlock", () => {
  it("assembles persona, phase brief, facts and the directive", async () => {
    const block = await buildPhaseSystemBlock({
      projectId: PROJECT_ID,
      latestUserMessage: "what should I do next?",
    });

    expect(block).toContain("Established project facts");
    expect(block).toContain("problem_statement");
    expect(getProjectFacts).toHaveBeenCalledWith({ projectId: PROJECT_ID });
    expect(getProjectPhases).toHaveBeenCalledWith({ projectId: PROJECT_ID });
  });

  it("carries the PREVIOUS turn's verdict into this turn's prompt", async () => {
    // The gate writes in after(), post-flush, so the verdict for turn N has
    // exactly one place to land: turn N+1's system prompt. Without this read
    // the verdict reaches the rail badge and dies there.
    getProjectPhases.mockResolvedValue([
      {
        phaseKey: PHASE_ONE.key,
        status: "active",
        decision: "BLOCK",
        reason: "willingness to pay is unevidenced",
        nextQuestion: "Who has paid for a workaround, and how much?",
      },
    ]);

    const block = await buildPhaseSystemBlock({ projectId: PROJECT_ID });

    expect(block).toContain("Who has paid for a workaround, and how much?");
  });

  it("uses the keyword ranker when no embedding provider is configured", async () => {
    getEmbeddingProvider.mockReturnValue(null);
    await expect(
      buildPhaseSystemBlock({ projectId: PROJECT_ID })
    ).resolves.toContain("problem_statement");
  });

  it("uses the embedding ranker when one IS configured", async () => {
    const embed = vi.fn((texts: string[]) =>
      Promise.resolve({ vectors: texts.map(() => [1, 0, 0]) })
    );
    getEmbeddingProvider.mockReturnValue({ embed });

    const block = await buildPhaseSystemBlock({
      projectId: PROJECT_ID,
      latestUserMessage: "who is the target user?",
    });

    expect(embed).toHaveBeenCalled();
    expect(block).toContain("Established project facts");
  });

  it("falls back to keyword ranking rather than emitting no facts when embedding fails", async () => {
    // An empty fact block would turn a retrieval outage into a phase BLOCK the
    // founder cannot clear by answering.
    getEmbeddingProvider.mockReturnValue({
      embed: () => Promise.reject(new Error("embedding provider down")),
    });

    const block = await buildPhaseSystemBlock({ projectId: PROJECT_ID });

    expect(block).toContain("problem_statement");
  });

  it("still produces a block when the project has no facts at all", async () => {
    getProjectFacts.mockResolvedValue([]);
    await expect(
      buildPhaseSystemBlock({ projectId: PROJECT_ID })
    ).resolves.toContain("Phase");
  });
});

// ─── the write side ──────────────────────────────────────────────────────────

describe("runPostTurnPhasePass", () => {
  it("extracts, then gates, then persists the verdict", async () => {
    await runPostTurnPhasePass({
      projectId: PROJECT_ID,
      chatId: CHAT_ID,
      assistantMessageId: "a1",
    });

    expect(upsertProjectFacts).toHaveBeenCalledTimes(1);
    expect(recordGateVerdict).toHaveBeenCalledTimes(1);
    const row = recordGateVerdict.mock.calls[0][0];
    expect(row.projectId).toBe(PROJECT_ID);
    expect(row.decision).toBe("PASS");
  });

  it("extraction runs BEFORE the gate, so 'zero facts ⇒ BLOCK' is a signal not a race", async () => {
    await runPostTurnPhasePass({
      projectId: PROJECT_ID,
      chatId: CHAT_ID,
      assistantMessageId: "a1",
    });

    expect(extractModel.doGenerateCalls.length).toBe(1);
    expect(judgeModel.doGenerateCalls.length).toBe(1);
    // getProjectFacts is read once before extraction and once after, and the
    // POST-extraction read is what the judge is given.
    expect(getProjectFacts.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("PASS advances the phase and opens the next one", async () => {
    await runPostTurnPhasePass({
      projectId: PROJECT_ID,
      chatId: CHAT_ID,
      assistantMessageId: "a1",
    });

    expect(recordGateVerdict.mock.calls[0][0].status).toBe("passed");
    expect(activateProjectPhase).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      phaseKey: PHASES[1].key,
      phaseOrder: PHASES[1].order,
    });
  });

  it("WARN ADVANCES — an advisory miss is not a blocking one", async () => {
    // people-interviewed is the one advisory criterion in phase 1.
    useModels(judgeBody({ "people-interviewed": "unmet" }), NO_FACTS_EXTRACTED);

    await runPostTurnPhasePass({
      projectId: PROJECT_ID,
      chatId: CHAT_ID,
      assistantMessageId: "a1",
    });

    const row = recordGateVerdict.mock.calls[0][0];
    expect(row.decision).toBe("WARN");
    expect(row.status).toBe("passed");
    expect(activateProjectPhase).toHaveBeenCalledTimes(1);
    // The gap stays visible rather than being reported as a clean pass.
    expect(row.verdict.missing.length).toBeGreaterThan(0);
  });

  it("BLOCK HOLDS — the phase stays active and nothing is opened", async () => {
    useModels(judgeBody({ "willingness-to-pay": "unmet" }), NO_FACTS_EXTRACTED);

    await runPostTurnPhasePass({
      projectId: PROJECT_ID,
      chatId: CHAT_ID,
      assistantMessageId: "a1",
    });

    const row = recordGateVerdict.mock.calls[0][0];
    expect(row.decision).toBe("BLOCK");
    expect(row.status).toBe("active");
    expect(activateProjectPhase).not.toHaveBeenCalled();
    expect(row.nextQuestion).toBeTruthy();
  });

  it("a blocking PARTIAL blocks — the load-bearing branch of the product", async () => {
    useModels(
      judgeBody({ "willingness-to-pay": "partial" }),
      NO_FACTS_EXTRACTED
    );

    await runPostTurnPhasePass({
      projectId: PROJECT_ID,
      chatId: CHAT_ID,
      assistantMessageId: "a1",
    });

    expect(recordGateVerdict.mock.calls[0][0].decision).toBe("BLOCK");
  });

  it("writes a fail-closed BLOCK when the model cannot be resolved at all", async () => {
    // With no gateway key getLanguageModel throws. That used to be swallowed,
    // leaving NO ROW — which the rail's null default rendered identically to
    // "not assessed yet". Not assessed is never the same state as blocked.
    getLanguageModel.mockRejectedValue(new Error("no api key configured"));

    await runPostTurnPhasePass({
      projectId: PROJECT_ID,
      chatId: CHAT_ID,
      assistantMessageId: "a1",
    });

    expect(recordGateVerdict).toHaveBeenCalledTimes(1);
    const row = recordGateVerdict.mock.calls[0][0];
    expect(row.decision).toBe("BLOCK");
    expect(row.status).toBe("active");
    expect(row.reason).toMatch(FAILED_CLOSED_RE);
    expect(row.reason).toMatch(NO_API_KEY_RE);
  });

  it("writes a fail-closed BLOCK when the transcript read fails", async () => {
    getAllMessagesByProjectId.mockRejectedValue(new Error("connection reset"));

    await runPostTurnPhasePass({
      projectId: PROJECT_ID,
      chatId: CHAT_ID,
      assistantMessageId: "a1",
    });

    expect(recordGateVerdict.mock.calls[0][0].decision).toBe("BLOCK");
  });

  it("writes NOTHING when the phase itself cannot be resolved", async () => {
    // The DB is unreachable, so there is nothing to fail closed INTO — writing
    // a verdict would mean inventing which phase it belongs to.
    getProjectPhases.mockRejectedValue(new Error("db down"));

    await runPostTurnPhasePass({
      projectId: PROJECT_ID,
      chatId: CHAT_ID,
      assistantMessageId: "a1",
    });

    expect(recordGateVerdict).not.toHaveBeenCalled();
  });

  it("never throws, even when persisting the fail-closed verdict also fails", async () => {
    getLanguageModel.mockRejectedValue(new Error("no api key"));
    recordGateVerdict.mockRejectedValue(new Error("db down too"));

    // STRENGTHENED, not loosened. The property under test is still "resolves
    // rather than rejects" — this runs inside after(), where a rejection is an
    // unhandled rejection. It now also pins the reported outcome: a pass that
    // could not assess must say "not-assessed", NOT a BLOCK decision. Reporting
    // the fail-closed BLOCK as a decision here would invite the persona pass,
    // and anything else downstream, to treat a failure as a judgement.
    await expect(
      runPostTurnPhasePass({
        projectId: PROJECT_ID,
        chatId: CHAT_ID,
        assistantMessageId: "a1",
      })
    ).resolves.toMatchObject({
      status: "not-assessed",
      phaseKey: PHASE_ONE.key,
    });
  });

  it("a finished workflow absorbs further verdicts without un-finishing", async () => {
    getProjectPhases.mockResolvedValue(
      PHASES.map((p) => ({ phaseKey: p.key, status: "passed" }))
    );
    useModels(judgeBody(), NO_FACTS_EXTRACTED);

    await runPostTurnPhasePass({
      projectId: PROJECT_ID,
      chatId: CHAT_ID,
      assistantMessageId: "a1",
    });

    const row = recordGateVerdict.mock.calls[0][0];
    expect(row.phaseKey).toBe(PHASES.at(-1)?.key);
    expect(row.status).toBe("passed");
    expect(activateProjectPhase).not.toHaveBeenCalled();
  });

  it("embeds the facts this turn wrote when a provider is configured", async () => {
    getEmbeddingProvider.mockReturnValue({ embed: vi.fn() });
    backfillFactEmbeddings.mockResolvedValue({ embedded: 3 });

    await runPostTurnPhasePass({
      projectId: PROJECT_ID,
      chatId: CHAT_ID,
      assistantMessageId: "a1",
    });

    expect(backfillFactEmbeddings).toHaveBeenCalledTimes(1);
    expect(recordGateVerdict).toHaveBeenCalledTimes(1);
  });

  it("skips the embedding backfill entirely when no provider is configured", async () => {
    getEmbeddingProvider.mockReturnValue(null);

    await runPostTurnPhasePass({
      projectId: PROJECT_ID,
      chatId: CHAT_ID,
      assistantMessageId: "a1",
    });

    expect(backfillFactEmbeddings).not.toHaveBeenCalled();
  });

  it("judges the PROJECT transcript, not this chat's", async () => {
    getAllMessagesByProjectId.mockResolvedValue([
      message("o1", "user", "SENTENCE FROM ANOTHER CHAT", null),
      message("o2", "assistant", "noted", "o1"),
    ]);

    await runPostTurnPhasePass({
      projectId: PROJECT_ID,
      chatId: CHAT_ID,
      assistantMessageId: "a1",
    });

    expect(JSON.stringify(judgeModel.doGenerateCalls[0].prompt)).toContain(
      "SENTENCE FROM ANOTHER CHAT"
    );
  });
});

// ─── finding 2: the message tree must not reach the judge flattened ──────────

describe("runPostTurnPhasePass / abandoned branches", () => {
  it("does not extract from a retracted branch of this chat", async () => {
    // u2 was asked and answered, then EDITED into u2b. Both branches keep their
    // rows. The retracted branch's SECOND parallel reply finished late — real,
    // because parallel streams finish at different times — so in createdAt
    // order the newest row in the chat belongs to a branch the founder threw
    // away, and flattening splices it into the tail as the current exchange.
    getAllMessagesByChatId.mockResolvedValue([
      message("u1", "user", "we sell to dentists", null),
      message("a1", "assistant", "who exactly?", "u1"),
      message("u2", "user", "RETRACTED QUESTION", "a1"),
      message("a1b", "assistant", "RETRACTED ANSWER", "u2", {
        parallelGroupId: "retracted",
        parallelIndex: 0,
        isPrimaryParallel: true,
      }),
      message("u2b", "user", "practice managers", "a1"),
      message("a2b", "assistant", "how do you know?", "u2b"),
      message("a1c", "assistant", "RETRACTED SLOW ANSWER", "u2", {
        parallelGroupId: "retracted",
        parallelIndex: 1,
        isPrimaryParallel: false,
      }),
    ]);

    await runPostTurnPhasePass({
      projectId: PROJECT_ID,
      chatId: CHAT_ID,
      assistantMessageId: "a2b",
    });

    const shown = extractorPrompt();
    expect(shown).toContain("practice managers");
    expect(shown).toContain("how do you know?");
    expect(shown).not.toContain("RETRACTED QUESTION");
    expect(shown).not.toContain("RETRACTED ANSWER");
    expect(shown).not.toContain("RETRACTED SLOW ANSWER");
  });

  it("does not extract from a superseded regenerated reply", async () => {
    getAllMessagesByChatId.mockResolvedValue([
      message("u1", "user", "we sell to dentists", null),
      message("a1", "assistant", "SUPERSEDED REPLY", "u1"),
      message("a1r", "assistant", "the regenerated reply", "u1"),
    ]);

    await runPostTurnPhasePass({
      projectId: PROJECT_ID,
      chatId: CHAT_ID,
      assistantMessageId: "a1r",
    });

    const shown = extractorPrompt();
    expect(shown).toContain("the regenerated reply");
    expect(shown).not.toContain("SUPERSEDED REPLY");
  });
});

// ─── finding 3: the extraction turn with parallel responses on ───────────────

describe("runPostTurnPhasePass / the exchange handed to the extractor", () => {
  it("is the last USER turn plus its reply, even with parallel responses on", async () => {
    // Three assistant replies to one user message. A positional slice(-2)
    // returned the last TWO ASSISTANT turns and no question at all — the
    // extractor was shown answers with the question removed.
    getAllMessagesByChatId.mockResolvedValue([
      message("u1", "user", "we sell to dentists", null),
      message("a1", "assistant", "who exactly?", "u1"),
      message("u2", "user", "THE QUESTION THAT MUST SURVIVE", "a1"),
      message("p0", "assistant", "PRIMARY REPLY", "u2", {
        parallelGroupId: "g1",
        parallelIndex: 0,
        isPrimaryParallel: true,
      }),
      message("p1", "assistant", "SECOND REPLY", "u2", {
        parallelGroupId: "g1",
        parallelIndex: 1,
        isPrimaryParallel: false,
      }),
      message("p2", "assistant", "THIRD REPLY", "u2", {
        parallelGroupId: "g1",
        parallelIndex: 2,
        isPrimaryParallel: false,
      }),
    ]);

    await runPostTurnPhasePass({
      projectId: PROJECT_ID,
      chatId: CHAT_ID,
      assistantMessageId: "p0",
    });

    const shown = extractorPrompt();
    expect(shown).toContain("THE QUESTION THAT MUST SURVIVE");
    expect(shown).toContain("PRIMARY REPLY");
    expect(shown).not.toContain("SECOND REPLY");
    expect(shown).not.toContain("THIRD REPLY");
  });

  it("does not carry older turns into the exchange", async () => {
    getAllMessagesByChatId.mockResolvedValue([
      message("u1", "user", "AN OLD TURN", null),
      message("a1", "assistant", "AN OLD REPLY", "u1"),
      message("u2", "user", "the newest question", "a1"),
      message("a2", "assistant", "the newest reply", "u2"),
    ]);

    await runPostTurnPhasePass({
      projectId: PROJECT_ID,
      chatId: CHAT_ID,
      assistantMessageId: "a2",
    });

    const shown = extractorPrompt();
    expect(shown).toContain("the newest question");
    expect(shown).toContain("the newest reply");
    expect(shown).not.toContain("AN OLD TURN");
  });

  it("is anchored on the user turn, not on position, when a reply carries no text", async () => {
    // The assistant message that just finished was a tool/image turn with no
    // text part, so toTranscript drops it and the tail is [.., a_prev, u_last].
    // A positional slice(-2) then hands the extractor the PREVIOUS answer
    // followed by the current question — an exchange in the wrong order that
    // never happened.
    getAllMessagesByChatId.mockResolvedValue([
      message("u1", "user", "the previous question", null),
      message("a1", "assistant", "THE PREVIOUS ANSWER", "u1"),
      message("u2", "user", "now draw me the funnel", "a1"),
      {
        id: "a2",
        role: "assistant",
        parts: [{ type: "tool-generateImage", state: "output-available" }],
        metadata: { createdAt: new Date(9000), parentMessageId: "u2" },
      },
    ]);

    await runPostTurnPhasePass({
      projectId: PROJECT_ID,
      chatId: CHAT_ID,
      assistantMessageId: "a2",
    });

    const shown = extractorPrompt();
    expect(shown).toContain("now draw me the funnel");
    expect(shown).not.toContain("THE PREVIOUS ANSWER");
  });

  it("still extracts something when the tail holds no user turn", async () => {
    getAllMessagesByChatId.mockResolvedValue([
      message("a1", "assistant", "an orphaned opening", null),
    ]);

    await runPostTurnPhasePass({
      projectId: PROJECT_ID,
      chatId: CHAT_ID,
      assistantMessageId: "a1",
    });

    expect(extractorPrompt()).toContain("an orphaned opening");
  });
});

// ─── budgets ─────────────────────────────────────────────────────────────────

/**
 * `toStoredFacts` in runtime.ts carries `origin` and says why: "ALWAYS
 * supplied, so an absent origin downstream can only be a hand-written literal
 * and never a row that lost its provenance." Two other mappings in the same
 * file quietly broke that invariant, and both fed a model.
 */
describe("runPostTurnPhasePass / provenance reaches the models", () => {
  function factsWithFounderAssertion() {
    return storedFacts().map((f, i) => ({
      ...f,
      origin: i === 0 ? ("founder" as const) : ("extracted" as const),
    }));
  }

  it("tells the JUDGE which facts the founder asserted rather than evidenced", async () => {
    // The whole reason the provenance column exists. Without it a judge cannot
    // tell an assumption the founder typed from a quote observed in the field,
    // and can be passed on the former — the exact failure this product exists
    // to prevent.
    getProjectFacts.mockResolvedValue(factsWithFounderAssertion());

    await runPostTurnPhasePass({
      projectId: PROJECT_ID,
      chatId: CHAT_ID,
      assistantMessageId: "a1",
    });

    expect(judgePrompt()).toContain("asserted by the founder, not extracted");
  });

  it("tells the EXTRACTOR too, since it decides what to overwrite", async () => {
    getProjectFacts.mockResolvedValue(factsWithFounderAssertion());

    await runPostTurnPhasePass({
      projectId: PROJECT_ID,
      chatId: CHAT_ID,
      assistantMessageId: "a1",
    });

    expect(extractorPrompt()).toContain(
      "asserted by the founder, not extracted"
    );
  });

  it("says nothing of the sort when every fact was extracted", async () => {
    // The marker is additive: an extracted fact must render byte-for-byte as
    // before, or every existing prompt and fixture shifts.
    getProjectFacts.mockResolvedValue(
      storedFacts().map((f) => ({ ...f, origin: "extracted" as const }))
    );

    await runPostTurnPhasePass({
      projectId: PROJECT_ID,
      chatId: CHAT_ID,
      assistantMessageId: "a1",
    });

    expect(judgePrompt()).not.toContain("asserted by the founder");
  });
});

describe("phase budgets", () => {
  it("the assistant's context budget is the judge's transcript budget", () => {
    // If the judge could read more of a conversation than the assistant was
    // shown, the gate could BLOCK on evidence the model never saw.
    expect(GATE_TRANSCRIPT_BUDGET_TOKENS).toBe(24_000);
  });

  it("the fact budget carries the whole 8-phase vocabulary", () => {
    // MEASURED: 66 distinct fact keys across the 8 phases, at a measured mean
    // of 27.1 tokens per rendered line = 1,901 tokens for a complete store.
    // The old 900 carried 26 of 66.
    const keys = new Set(PHASES.flatMap((p) => p.factKeys));
    expect(keys.size).toBe(66);
    expect(PHASE_FACT_BUDGET_TOKENS).toBeGreaterThan(1901);
  });

  it("trims the judge's transcript to budget and reports it", async () => {
    const huge = Array.from({ length: 60 }, (_, i) =>
      message(
        `m${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "word ".repeat(2000),
        i === 0 ? null : `m${i - 1}`
      )
    );
    getAllMessagesByProjectId.mockResolvedValue(huge);

    await runPostTurnPhasePass({
      projectId: PROJECT_ID,
      chatId: CHAT_ID,
      assistantMessageId: "m59",
    });

    // It still produced a verdict rather than blowing the prompt.
    expect(recordGateVerdict).toHaveBeenCalledTimes(1);
    const prompt = JSON.stringify(judgeModel.doGenerateCalls[0].prompt);
    // The newest turn survived; the oldest did not.
    expect(prompt.length).toBeLessThan(
      JSON.stringify(huge.map((m) => m.parts[0].text)).length
    );
  });
});
