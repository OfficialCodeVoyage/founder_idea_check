import { DOCUMENT_MARKER_NOTE, renderFacts, renderTranscript } from "./gate";
import {
  type ExtractedFact,
  ExtractionOutputSchema,
  FACT_KEY_PATTERN,
  type KnownFact,
  type PhaseDefinition,
  type TranscriptTurn,
} from "./types";

export type ExtractRequest = {
  system: string;
  prompt: string;
};

/** THE SEAM — same shape and same discipline as GateJudge. */
export type FactExtractor = (request: ExtractRequest) => Promise<unknown>;

export type ExtractDeps = {
  extract: FactExtractor;
  /**
   * Optional failure sink. PURE MODULE RULE: this file must not import the
   * logger (it would drag `server-only` into vitest), so the caller injects
   * one. runtime.ts wires it to the module logger.
   */
  onError?: (
    error: unknown,
    stage: "extract-call-failed" | "extract-schema-mismatch"
  ) => void;
};

export type BuildExtractionPromptInput = {
  phase: PhaseDefinition;
  personaPrompt: string;
  /** The last user turn + the assistant reply that just finished. */
  turn: TranscriptTurn[];
  knownFacts: KnownFact[];
};

/** Below this, a fact is noise and is discarded before it reaches the store. */
export const MIN_FACT_CONFIDENCE = 40;

export function buildExtractionPrompt(
  input: BuildExtractionPromptInput
): ExtractRequest {
  const { phase, personaPrompt, turn, knownFacts } = input;

  const system = [
    personaPrompt,
    `# Your job right now

You are NOT talking to the founder. You are reading one exchange and extracting
durable facts about the project into a structured store.

Rules:
- Only these keys are permitted: ${phase.factKeys.join(", ")}. Anything else is discarded.
- One fact per key. If the exchange revises a known fact, emit the revised value.
- value: a single sentence, concrete, no hedging, no markdown.
- evidence: a direct quote from the exchange. No quote, no fact.
- confidence: 0-100. Score what the FOUNDER evidenced, not what they hope.
  Observed behaviour or money spent scores high; a survey answer or "people
  would love this" scores below ${MIN_FACT_CONFIDENCE} and will be discarded.
- Extract nothing rather than something speculative. An empty list is a valid answer.
- ${DOCUMENT_MARKER_NOTE}`,
  ].join("\n\n---\n\n");

  const prompt = [
    "## Already established (do not repeat unchanged)",
    renderFacts(knownFacts),
    "",
    "## The exchange",
    renderTranscript(turn),
  ].join("\n");

  return { system, prompt };
}

/**
 * PURE. Drops facts that are out of vocabulary, unevidenced, empty or
 * low-confidence, then dedupes by key keeping the highest confidence.
 */
export function sanitizeFacts(
  facts: ExtractedFact[],
  allowedKeys: readonly string[]
): ExtractedFact[] {
  const allowed = new Set(allowedKeys);
  const best = new Map<string, ExtractedFact>();

  for (const raw of facts) {
    const key = raw.key.trim().toLowerCase();
    const value = raw.value.trim();
    if (!(allowed.has(key) && FACT_KEY_PATTERN.test(key))) {
      continue;
    }
    if (value.length === 0 || raw.evidence.trim().length === 0) {
      continue;
    }
    if (raw.confidence < MIN_FACT_CONFIDENCE) {
      continue;
    }
    const candidate: ExtractedFact = { ...raw, key, value };
    const existing = best.get(key);
    if (!existing || candidate.confidence > existing.confidence) {
      best.set(key, candidate);
    }
  }

  // Code point, NOT localeCompare. localeCompare depends on the host's ICU
  // locale, so the same facts sort differently on two machines and the prompt
  // built from them differs byte for byte — which silently breaks prompt
  // caching and makes an extraction bug unreproducible. context.ts made the
  // same call deliberately (see compareScored); this is the file that forgot.
  return [...best.values()].sort((a, b) => {
    if (a.key < b.key) {
      return -1;
    }
    return a.key > b.key ? 1 : 0;
  });
}

export type FactReconciliation = {
  /** Keys not currently in the store. */
  inserts: ExtractedFact[];
  /** Keys already in the store whose value or confidence changes. */
  updates: ExtractedFact[];
  /** Keys deliberately left alone. */
  skipped: {
    key: string;
    why: "unchanged" | "lower-confidence" | "founder-asserted";
  }[];
};

/**
 * PURE. Decides insert vs update vs skip. The SQL upsert is deliberately dumb
 * (plain onConflictDoUpdate) so that every judgement call lives here, where it
 * is unit-testable.
 *
 * Policy: a new value overwrites only if its confidence is >= the stored
 * value's. A lower-confidence contradiction is dropped, not merged — a later,
 * better evidenced turn will clear the bar and overwrite.
 *
 * AND A FOUNDER'S CORRECTION IS NEVER OVERWRITTEN. Once someone has fixed a
 * fact by hand, an extractor that silently reverted it on the next turn would
 * make the correction feature a lie — the founder would watch their fix
 * disappear with no message. It is checked FIRST, before the confidence
 * comparison, because a high-confidence extraction is exactly the case that
 * would otherwise win.
 */
export function reconcileFacts(
  existing: KnownFact[],
  incoming: ExtractedFact[]
): FactReconciliation {
  const byKey = new Map(existing.map((f) => [f.key, f]));
  const result: FactReconciliation = {
    inserts: [],
    updates: [],
    skipped: [],
  };

  for (const fact of incoming) {
    const prior = byKey.get(fact.key);
    if (!prior) {
      result.inserts.push(fact);
      continue;
    }
    if (prior.origin === "founder") {
      result.skipped.push({ key: fact.key, why: "founder-asserted" });
      continue;
    }
    if (prior.value === fact.value && prior.confidence === fact.confidence) {
      result.skipped.push({ key: fact.key, why: "unchanged" });
      continue;
    }
    if (fact.confidence < prior.confidence) {
      result.skipped.push({ key: fact.key, why: "lower-confidence" });
      continue;
    }
    result.updates.push(fact);
  }

  return result;
}

/**
 * Runs the extraction pass. NEVER throws and NEVER rejects — a failed
 * extraction returns [] so it can never break the chat stream.
 */
export async function extractFacts(
  deps: ExtractDeps,
  input: BuildExtractionPromptInput
): Promise<ExtractedFact[]> {
  const request = buildExtractionPrompt(input);

  let raw: unknown;
  try {
    raw = await deps.extract(request);
  } catch (error) {
    // Returning [] is right — a failed extraction must not break the turn, and
    // the gate's empty-fact guard will BLOCK rather than pass. But it must not
    // be SILENT: "the extractor 500'd" and "this turn genuinely said nothing"
    // both produce zero facts, and without this the only visible symptom is a
    // gate BLOCK for "nothing established", pointing at the wrong cause.
    deps.onError?.(error, "extract-call-failed");
    return [];
  }

  const parsed = ExtractionOutputSchema.safeParse(raw);
  if (!parsed.success) {
    deps.onError?.(parsed.error, "extract-schema-mismatch");
    return [];
  }

  return sanitizeFacts(parsed.data.facts, input.phase.factKeys);
}
