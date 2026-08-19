import {
  cosineSimilarity,
  EMBEDDING_DIMENSIONS,
  factEmbeddingText,
  similarityToScore,
} from "../embeddings/text";
import { renderFacts, renderTranscript, TRANSCRIPT_SEPARATOR } from "./gate";
import type {
  ExitCriterion,
  KnownFact,
  PhaseDefinition,
  TranscriptTurn,
} from "./types";

/**
 * FACT SELECTION — the answer to buildpad's own documented weakness, that it
 * "seemed to momentarily forget insights from previous phases".
 *
 * The chat path amputates history (`.slice(-5)` in route.ts / core-chat-agent),
 * so by phase 3 the raw phase-1 turns are gone. Durable facts survive that
 * amputation only if they are (a) ranked by something better than alphabetical
 * order and (b) fitted to a token budget without ever being cut in half.
 *
 * DISCIPLINE (same as types/gate/extract/definitions): this file imports ONLY
 * ./gate and ./types. No "ai", no "@/lib/ai/*", no "@/lib/db/*", no clock, no
 * randomness, no I/O. Every function here is pure and runs under vitest with no
 * API key, no network and no database.
 *
 * NO CLOCK ON PURPOSE: recency is scored as a RANK within the candidate set,
 * not as an age against `Date.now()`. Same input ⇒ byte-identical output,
 * forever, with no injected clock to forget to inject.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The stored fact — wider than KnownFact.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A fact as it actually sits in the ProjectFact row, including the provenance
 * columns `toKnownFacts()` throws away.
 *
 * KnownFact ({key, value, confidence}) is deliberately NOT widened: gate.ts and
 * extract.ts render KnownFact[] and their tests build KnownFact literals. This
 * is the wider projection the ranker needs; `toKnownFact` narrows back.
 */
export type StoredFact = {
  key: string;
  value: string;
  /** 0-100 integer, as stored (the column has a CHECK constraint). */
  confidence: number;
  /** ProjectFact.updatedAt. The only recency signal the ranker reads. */
  updatedAt: Date;
  /** Phase that last wrote the fact. Provenance; not scored today. */
  phaseKey: string;
  /**
   * ProjectFact.embedding, when the row has one. Optional and nullable: a fact
   * whose embedding call failed is still a fact, and the keyword selector still
   * ranks it. EmbeddingFactSelector embeds only the facts missing a vector, so
   * a warm store costs one embedding call for the query and nothing else.
   */
  embedding?: number[] | null;
};

export function toKnownFact(fact: StoredFact): KnownFact {
  return { key: fact.key, value: fact.value, confidence: fact.confidence };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring constants. All integer maths — no float accumulation, so two runs on
// two machines produce the same ordering bit for bit.
// ─────────────────────────────────────────────────────────────────────────────

/** Each component is normalised to 0-100 before being weighted. */
const COMPONENT_MAX = 100;

/**
 * Relevance outweighs recency so that an OLD fact the founder is talking about
 * right now beats a NEW fact about something else — the "promotes a relevant
 * older fact" property. Confidence sits between them: a well-evidenced fact is
 * worth more than a fresh guess, but never more than the thing being discussed.
 */
export const WEIGHT_RELEVANCE = 5;
export const WEIGHT_CONFIDENCE = 3;
export const WEIGHT_RECENCY = 2;

/** Query terms from the founder's latest message count double. */
const QUERY_WEIGHT_MESSAGE = 2;
const QUERY_WEIGHT_CRITERIA = 1;

/** Shorter tokens are noise ("a", "of", "to") and are never discriminating. */
const MIN_TOKEN_LENGTH = 3;

/**
 * Deliberately small. This is a stopword list, not a stemmer — no stemming is
 * applied anywhere, because a crude stemmer ("businesses" -> "businesse") makes
 * matching LESS predictable, and predictability is the whole point of this file.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  "and",
  "are",
  "but",
  "can",
  "for",
  "from",
  "has",
  "have",
  "how",
  "into",
  "its",
  "not",
  "other",
  "our",
  "out",
  "since",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "they",
  "this",
  "was",
  "were",
  "what",
  "when",
  "which",
  "who",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

const NON_TOKEN = /[^a-z0-9]+/;

/** PURE. Lowercase, split on non-alphanumerics, drop short words and stopwords. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(NON_TOKEN)
    .filter((t) => t.length >= MIN_TOKEN_LENGTH && !STOP_WORDS.has(t));
}

// ─────────────────────────────────────────────────────────────────────────────
// The selector interface + its inputs and outputs.
// ─────────────────────────────────────────────────────────────────────────────

export type SelectFactsOptions = {
  /** The phase whose exit criteria define what "relevant" means right now. */
  phase: PhaseDefinition;
  /**
   * The founder's most recent message. Weighted double against the criteria,
   * because it is the only signal about what THIS turn is about. Optional: an
   * empty string simply removes that half of the query.
   */
  latestUserMessage?: string;
  /**
   * Hard cap on how many facts are ranked in. Omit or 0 for no cap — the token
   * budget in buildFactBlock is the real limit; this is a belt-and-braces knob.
   */
  maxFacts?: number;
};

export type ScoreComponents = {
  /** 0-100, keyword overlap with the criteria + the latest user message. */
  relevance: number;
  /** 0-100, the stored confidence verbatim. */
  confidence: number;
  /** 0-100, rank among the distinct updatedAt values in this candidate set. */
  recency: number;
};

export type ScoredFact = {
  fact: StoredFact;
  /** Weighted integer sum of `components`. Higher is kept. */
  score: number;
  /**
   * True when a BLOCKING exit criterion names this fact key by hand. Pinned
   * facts sort ahead of everything, whatever they score.
   *
   * WHY: if the budget evicts the fact a blocking `artifact-exists` criterion
   * names, the gate reports a gap for a fact that IS in the store — a false
   * BLOCK the founder cannot clear by answering. Same fail-closed discipline as
   * decideGate: never let a missing signal look like an absent one.
   */
  pinned: boolean;
  components: ScoreComponents;
};

export type SelectedFacts = {
  /** Best first. Total order — see compareScored. */
  ranked: ScoredFact[];
  /** Keys cut by `maxFacts`, in the order they were cut. */
  omitted: string[];
};

/** THE SEAM. Synchronous, deterministic, no model, no key. */
export interface FactSelector {
  select(facts: StoredFact[], opts: SelectFactsOptions): SelectedFacts;
}

/**
 * THE SEAM for anything that has to call out (an embedder, a reranker). Same
 * inputs, same outputs, only async — so a caller swaps one for the other
 * without any other change.
 */
export interface AsyncFactSelector {
  select(
    facts: StoredFact[],
    opts: SelectFactsOptions
  ): Promise<SelectedFacts> | SelectedFacts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Query construction: what "relevant" means for this phase, this turn.
// ─────────────────────────────────────────────────────────────────────────────

/** The fact key (if any) a criterion names by hand. */
export function criterionFactKey(criterion: ExitCriterion): string | null {
  if (criterion.type === "artifact-exists") {
    return criterion.factKey;
  }
  if (criterion.type === "metric-threshold") {
    return criterion.metric;
  }
  return null;
}

function criterionText(criterion: ExitCriterion): string {
  const key = criterionFactKey(criterion);
  const extra = key ?? "";
  return `${criterion.id} ${extra} ${criterion.description}`;
}

/**
 * PURE. Fact keys named by a BLOCKING criterion. These are pinned into the
 * budget before anything is scored.
 */
export function pinnedFactKeys(phase: PhaseDefinition): Set<string> {
  const keys = new Set<string>();
  for (const criterion of phase.exitCriteria) {
    if (criterion.severity !== "blocking") {
      continue;
    }
    const key = criterionFactKey(criterion);
    if (key) {
      keys.add(key);
    }
  }
  return keys;
}

/**
 * PURE. term -> weight. The latest user message weighs double; a term that
 * appears in both keeps the higher weight rather than summing, so a criterion
 * that repeats a word cannot drown out the message.
 */
export function buildQueryTerms(opts: SelectFactsOptions): Map<string, number> {
  const terms = new Map<string, number>();

  const add = (text: string, weight: number) => {
    for (const token of tokenize(text)) {
      const current = terms.get(token) ?? 0;
      if (weight > current) {
        terms.set(token, weight);
      }
    }
  };

  for (const criterion of opts.phase.exitCriteria) {
    add(criterionText(criterion), QUERY_WEIGHT_CRITERIA);
  }
  add(opts.latestUserMessage ?? "", QUERY_WEIGHT_MESSAGE);

  return terms;
}

/** Raw (un-normalised) overlap weight between one fact and the query. */
function rawRelevance(fact: StoredFact, terms: Map<string, number>): number {
  const seen = new Set<string>();
  let total = 0;
  for (const token of tokenize(`${fact.key} ${fact.value}`)) {
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    total += terms.get(token) ?? 0;
  }
  return total;
}

/**
 * Recency as a RANK over the DISTINCT updatedAt values present, newest = 100.
 * Facts written in the same upsert share a timestamp and therefore share a
 * recency score — recency must never be the thing that separates them, or the
 * order of a single batch would decide what the model remembers.
 */
function recencyScores(facts: StoredFact[]): Map<number, number> {
  const distinct = [...new Set(facts.map((f) => f.updatedAt.getTime()))].sort(
    (a, b) => b - a
  );
  const scores = new Map<number, number>();
  const last = distinct.length - 1;
  for (const [index, time] of distinct.entries()) {
    if (last === 0) {
      scores.set(time, COMPONENT_MAX);
    } else {
      scores.set(time, Math.round(((last - index) / last) * COMPONENT_MAX));
    }
  }
  return scores;
}

/**
 * TOTAL ORDER. Never relies on Array.prototype.sort being stable: every tie is
 * broken explicitly, ending at the key, which is UNIQUE per project
 * (ProjectFact_project_key_unique). So two runs over the same rows produce a
 * byte-identical block.
 *
 * Key comparison is by code point, NOT localeCompare — localeCompare depends on
 * the host's ICU locale, which is exactly the kind of "works on my machine"
 * nondeterminism this file exists to avoid.
 */
function compareScored(a: ScoredFact, b: ScoredFact): number {
  if (a.pinned !== b.pinned) {
    return a.pinned ? -1 : 1;
  }
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  if (a.fact.confidence !== b.fact.confidence) {
    return b.fact.confidence - a.fact.confidence;
  }
  const at = a.fact.updatedAt.getTime();
  const bt = b.fact.updatedAt.getTime();
  if (at !== bt) {
    return bt - at;
  }
  if (a.fact.key < b.fact.key) {
    return -1;
  }
  if (a.fact.key > b.fact.key) {
    return 1;
  }
  return 0;
}

/**
 * Defensive dedupe by key. The (projectId, key) unique index means this cannot
 * happen from one project's rows, but selectFacts is a pure function anyone may
 * call with a merged list, and a duplicate key would make the ordering
 * non-total. Keeps the highest confidence, then the most recent.
 */
function dedupeByKey(facts: StoredFact[]): StoredFact[] {
  const best = new Map<string, StoredFact>();
  for (const fact of facts) {
    const existing = best.get(fact.key);
    if (!existing) {
      best.set(fact.key, fact);
      continue;
    }
    if (fact.confidence > existing.confidence) {
      best.set(fact.key, fact);
      continue;
    }
    if (
      fact.confidence === existing.confidence &&
      fact.updatedAt.getTime() > existing.updatedAt.getTime()
    ) {
      best.set(fact.key, fact);
    }
  }
  return [...best.values()];
}

/**
 * THE DEFAULT SELECTOR. No model, no key, no network, no clock.
 *
 * score = 5*relevance + 3*confidence + 2*recency, each component 0-100, so the
 * score is an integer in 0-1000. Pinned facts sort ahead of all of it.
 */
export function selectFacts(
  facts: StoredFact[],
  opts: SelectFactsOptions
): SelectedFacts {
  const candidates = dedupeByKey(facts);
  if (candidates.length === 0) {
    return { ranked: [], omitted: [] };
  }

  const terms = buildQueryTerms(opts);
  const pinned = pinnedFactKeys(opts.phase);
  const recency = recencyScores(candidates);

  const raw = candidates.map((fact) => ({
    fact,
    overlap: rawRelevance(fact, terms),
  }));
  const maxOverlap = raw.reduce((max, r) => Math.max(max, r.overlap), 0);

  const scored: ScoredFact[] = raw.map(({ fact, overlap }) => {
    const relevance =
      maxOverlap === 0 ? 0 : Math.round((overlap / maxOverlap) * COMPONENT_MAX);
    const confidence = fact.confidence;
    const recencyScore = recency.get(fact.updatedAt.getTime()) ?? 0;
    return {
      fact,
      pinned: pinned.has(fact.key),
      components: { relevance, confidence, recency: recencyScore },
      score:
        WEIGHT_RELEVANCE * relevance +
        WEIGHT_CONFIDENCE * confidence +
        WEIGHT_RECENCY * recencyScore,
    };
  });

  scored.sort(compareScored);

  const cap = opts.maxFacts ?? 0;
  if (cap > 0 && scored.length > cap) {
    return {
      ranked: scored.slice(0, cap),
      omitted: scored.slice(cap).map((s) => s.fact.key),
    };
  }
  return { ranked: scored, omitted: [] };
}

/** The default FactSelector. Stateless, so one shared instance is enough. */
export class DeterministicFactSelector implements FactSelector {
  select(facts: StoredFact[], opts: SelectFactsOptions): SelectedFacts {
    return selectFacts(facts, opts);
  }
}

export const deterministicFactSelector: FactSelector =
  new DeterministicFactSelector();

// ─────────────────────────────────────────────────────────────────────────────
// The embedding selector. Same seam, same output shape, same weights — the ONE
// thing it changes is how the `relevance` component is computed: cosine
// similarity in the embedding space instead of keyword overlap.
// ─────────────────────────────────────────────────────────────────────────────

/** Order-preserving batch embedder. One call per select(), not one per fact. */
export type FactEmbedder = (texts: string[]) => Promise<number[][]>;

export type EmbeddingSelectorDeps = {
  embed: FactEmbedder;
  /**
   * Where to go when embedding is unavailable or fails. Defaults to the
   * keyword selector, which needs no key and no network.
   */
  fallback?: FactSelector;
  /** Observability sink. A silent fallback is how "retrieval got worse and
   * nobody noticed" happens — the caller wires this to the module logger. */
  onFallback?: (error: unknown) => void;
};

/**
 * The query, as text rather than tokens. Same two signals buildQueryTerms uses
 * — what this phase must certify, and what this turn is about — because the
 * two selectors must be answering the same question. If they diverge, swapping
 * selectors silently changes what "relevant" means.
 *
 * The latest message is repeated so it carries roughly the double weight it has
 * in the keyword selector (QUERY_WEIGHT_MESSAGE vs QUERY_WEIGHT_CRITERIA).
 * Repetition is a blunt instrument, but it is the only weighting a single
 * embedding of a single string admits.
 */
export function buildQueryText(opts: SelectFactsOptions): string {
  const parts = opts.phase.exitCriteria.map(criterionText);
  const message = opts.latestUserMessage?.trim();
  if (message) {
    parts.push(message, message);
  }
  return parts.join("\n");
}

/**
 * THE EMBEDDING SELECTOR.
 *
 * Async because it calls out; otherwise indistinguishable from the default
 * from a caller's point of view — same inputs, same SelectedFacts, same
 * pinning, same confidence and recency components, same integer scoring, same
 * total order. That is what makes it swappable.
 *
 * FAILURE POLICY, and it is the important part: any failure — the embedder
 * throws, returns the wrong number of vectors, returns a mis-sized vector —
 * falls back to the keyword selector. It NEVER throws and NEVER returns an
 * empty ranking. "No facts" is the one answer that must never come out of
 * here: the gate reads the fact block, so an empty block turns a retrieval
 * outage into a phase BLOCK the founder cannot clear by answering. Same
 * fail-closed reasoning as decideGate, pointing the other way — here the safe
 * direction is degrading quality, not withholding evidence.
 */
export class EmbeddingFactSelector implements AsyncFactSelector {
  private readonly deps: EmbeddingSelectorDeps;

  constructor(deps: EmbeddingSelectorDeps) {
    this.deps = deps;
  }

  private fallbackTo(
    facts: StoredFact[],
    opts: SelectFactsOptions,
    error: unknown
  ): SelectedFacts {
    this.deps.onFallback?.(error);
    return (this.deps.fallback ?? deterministicFactSelector).select(
      facts,
      opts
    );
  }

  async select(
    facts: StoredFact[],
    opts: SelectFactsOptions
  ): Promise<SelectedFacts> {
    const candidates = dedupeByKey(facts);
    if (candidates.length === 0) {
      return { ranked: [], omitted: [] };
    }

    // Only the facts without a stored vector need embedding. A warm store
    // therefore costs exactly one embedding call — for the query.
    const needsVector = candidates.filter((f) => !isUsableVector(f.embedding));
    const queryText = buildQueryText(opts);

    let vectors: number[][];
    try {
      vectors = await this.deps.embed([
        queryText,
        ...needsVector.map(factEmbeddingText),
      ]);
    } catch (error) {
      return this.fallbackTo(facts, opts, error);
    }

    if (vectors.length !== needsVector.length + 1) {
      return this.fallbackTo(
        facts,
        opts,
        new Error(
          `embedder returned ${vectors.length} vectors for ${needsVector.length + 1} inputs`
        )
      );
    }

    const queryVector = vectors[0] as number[];
    if (!isUsableVector(queryVector)) {
      return this.fallbackTo(
        facts,
        opts,
        new Error("embedder returned an unusable query vector")
      );
    }

    const freshByKey = new Map<string, number[]>();
    for (const [i, fact] of needsVector.entries()) {
      freshByKey.set(fact.key, vectors[i + 1] as number[]);
    }

    const pinned = pinnedFactKeys(opts.phase);
    const recency = recencyScores(candidates);

    const scored: ScoredFact[] = candidates.map((fact) => {
      const vector = isUsableVector(fact.embedding)
        ? (fact.embedding as number[])
        : freshByKey.get(fact.key);
      // A fact with no usable vector scores 0 for relevance rather than being
      // dropped: it keeps its confidence and recency and can still be pinned.
      const relevance = isUsableVector(vector)
        ? similarityToScore(cosineSimilarity(queryVector, vector as number[]))
        : 0;
      const recencyScore = recency.get(fact.updatedAt.getTime()) ?? 0;
      return {
        fact,
        pinned: pinned.has(fact.key),
        components: {
          relevance,
          confidence: fact.confidence,
          recency: recencyScore,
        },
        score:
          WEIGHT_RELEVANCE * relevance +
          WEIGHT_CONFIDENCE * fact.confidence +
          WEIGHT_RECENCY * recencyScore,
      };
    });

    scored.sort(compareScored);

    const cap = opts.maxFacts ?? 0;
    if (cap > 0 && scored.length > cap) {
      return {
        ranked: scored.slice(0, cap),
        omitted: scored.slice(cap).map((s) => s.fact.key),
      };
    }
    return { ranked: scored, omitted: [] };
  }
}

/** A vector is usable only at exactly the column width. */
function isUsableVector(vector: number[] | null | undefined): boolean {
  return Array.isArray(vector) && vector.length === EMBEDDING_DIMENSIONS;
}

// ─────────────────────────────────────────────────────────────────────────────
// The budgeted block.
// ─────────────────────────────────────────────────────────────────────────────

/** Counts tokens in a bare string — no message-envelope overhead. */
export type TokenCounter = (text: string) => number;

/** ~4 characters per token — the repo's own heuristic (token-utils.ts `truncateStringContent`). */
const CHARS_PER_TOKEN = 4;

/**
 * The DEFAULT counter: pure, dependency-free, deterministic.
 *
 * Production should inject a real tiktoken counter from the one impure file
 * (runtime.ts). This file must not import @/lib/ai/token-utils: that module
 * loads the ~1.5 MB o200k_base rank table at import time, and every phases test
 * would pay for it.
 */
export const approxTokenCount: TokenCounter = (text) =>
  Math.ceil(text.length / CHARS_PER_TOKEN);

export const FACT_BLOCK_HEADING = "## Established project facts";

export type BuildFactBlockOptions = {
  /** Defaults to approxTokenCount. runtime.ts injects the tiktoken counter. */
  countTokens?: TokenCounter;
  heading?: string;
};

export type FactBlock = {
  /** The text to inject. Guaranteed to cost <= budgetTokens. */
  text: string;
  /** Fact keys that made it in, in rendered order. */
  includedKeys: string[];
  /** Fact keys dropped for budget, best-scoring first. */
  droppedKeys: string[];
  /**
   * Pinned keys that STILL had to be dropped. Non-empty means the budget is too
   * small to certify the phase and the caller should raise it — the gate will
   * otherwise report a gap for a fact that is in the store.
   */
  droppedPinnedKeys: string[];
  /** Measured cost of `text` under the counter that was used. */
  tokens: number;
};

/**
 * PURE. Renders one fact line. Byte-identical to what gate.renderFacts emits
 * for a single fact — a test asserts the two cannot drift, because the gate and
 * extraction prompts depend on that exact shape.
 */
export function renderFactLine(fact: StoredFact): string {
  return `- ${fact.key}: ${fact.value} (confidence ${fact.confidence})`;
}

function assemble(heading: string, facts: StoredFact[]): string {
  return `${heading}\n${renderFacts(facts.map(toKnownFact))}`;
}

/**
 * Fits the ranked facts into a token budget and renders the block.
 *
 * NEVER SPLITS A FACT. A fact either appears whole or not at all — half a fact
 * is worse than no fact, because the model reads a truncated value as the whole
 * truth.
 *
 * The fit test measures the WHOLE assembled block on every candidate rather
 * than summing per-line counts. Real tokenizers are not additive (they merge
 * across a newline), so a sum can undercount and blow the budget; measuring the
 * assembled text makes "never exceeds budget" true for ANY injected counter.
 *
 * A fact that does not fit is skipped and the walk CONTINUES, so a single
 * enormous value cannot starve every smaller fact ranked below it. Facts are
 * still visited best-first, so what gets dropped is driven by score.
 */
export function buildFactBlock(
  selected: SelectedFacts,
  budgetTokens: number,
  options: BuildFactBlockOptions = {}
): FactBlock {
  const countTokens = options.countTokens ?? approxTokenCount;
  const heading = options.heading ?? FACT_BLOCK_HEADING;

  const empty = assemble(heading, []);
  const emptyTokens = countTokens(empty);

  // The budget cannot even carry the heading. Emit nothing rather than
  // overspend: the caller asked for a hard cap and this is the only honest
  // answer. Everything is reported as dropped so the caller can see why.
  if (budgetTokens < emptyTokens) {
    return {
      text: "",
      includedKeys: [],
      droppedKeys: selected.ranked.map((s) => s.fact.key),
      droppedPinnedKeys: selected.ranked
        .filter((s) => s.pinned)
        .map((s) => s.fact.key),
      tokens: 0,
    };
  }

  const included: StoredFact[] = [];
  const dropped: ScoredFact[] = [];
  let text = empty;
  let tokens = emptyTokens;

  for (const candidate of selected.ranked) {
    const next = assemble(heading, [...included, candidate.fact]);
    const nextTokens = countTokens(next);
    if (nextTokens > budgetTokens) {
      dropped.push(candidate);
      continue;
    }
    included.push(candidate.fact);
    text = next;
    tokens = nextTokens;
  }

  return {
    text,
    includedKeys: included.map((f) => f.key),
    droppedKeys: dropped.map((s) => s.fact.key),
    droppedPinnedKeys: dropped.filter((s) => s.pinned).map((s) => s.fact.key),
    tokens,
  };
}

/**
 * One-call convenience: rank, then fit. This is what the read path wants —
 * `buildPhaseSystemBlock` replaces its unbounded `renderFacts(facts)` with
 * `selectAndRenderFacts(rows, opts, budget).text`.
 */
export function selectAndRenderFacts(
  facts: StoredFact[],
  opts: SelectFactsOptions,
  budgetTokens: number,
  options: BuildFactBlockOptions = {}
): FactBlock {
  return buildFactBlock(selectFacts(facts, opts), budgetTokens, options);
}

/**
 * The same thing through an injected AsyncFactSelector, so the caller chooses
 * semantic or keyword ranking without any other change. Budgeting, rendering
 * and the pinned-eviction warning are shared verbatim with the sync path —
 * that is the point: swapping the ranker must not quietly swap the budget
 * policy too.
 */
export async function selectAndRenderFactsWith(
  selector: AsyncFactSelector,
  facts: StoredFact[],
  opts: SelectFactsOptions,
  budgetTokens: number,
  options: BuildFactBlockOptions = {}
): Promise<FactBlock> {
  return buildFactBlock(
    await selector.select(facts, opts),
    budgetTokens,
    options
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The budgeted transcript.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The other half of issue #189, and the opposite bug to the chat path's
 * `.slice(-5)`: the gate is handed the WHOLE transcript with no limit at all
 * (getAllMessagesByChatId has no LIMIT, and project-scoping it makes the
 * transcript larger still). One end truncates blindly, the other never
 * truncates. Both are wrong.
 *
 * This is the honest middle. It keeps the NEWEST turns that fit — the ones the
 * judge needs to evaluate what just happened — and relies on the fact store to
 * carry everything older, which is exactly why facts exist. When anything is
 * dropped the caller is told, so the judge prompt can say so out loud rather
 * than letting the model read a truncated history as a complete one.
 */
export type BudgetedTranscript = {
  /** Chronological, oldest first, as the judge expects. */
  turns: TranscriptTurn[];
  /** How many older turns were dropped for budget. */
  omittedTurns: number;
};

/**
 * How many tokens of transcript the gate judge may read.
 *
 * The judge sees the PROJECT transcript (every chat in the project), which is
 * strictly larger than the chat transcript it used to get, so it needs a
 * ceiling it never had. The oldest turns are the ones dropped, and the fact
 * store is what carries them forward — that is the whole bargain of fact
 * injection.
 *
 * LIVES HERE, not in runtime.ts, because it is not only the judge's number.
 * lib/ai/core-chat-agent.ts sizes the ASSISTANT's context window from it too,
 * and those two must not drift: the moment the judge can read more of a
 * conversation than the assistant was shown, the gate can BLOCK a phase over
 * evidence the model never saw. runtime.ts re-exports it so the phase runtime
 * still reads as one module.
 */
export const GATE_TRANSCRIPT_BUDGET_TOKENS = 24_000;

/**
 * PURE. Fits a transcript into a token budget, newest-first, never splitting a
 * turn.
 *
 * Like buildFactBlock, the fit test measures the WHOLE rendered transcript on
 * each candidate rather than summing per-turn counts, so "never exceeds budget"
 * holds for any injected counter, including a real non-additive tokenizer.
 *
 * A turn that does not fit STOPS the walk (unlike facts, which are skipped and
 * the walk continues). Transcripts are read as a sequence: skipping one turn
 * from the middle and keeping an older one would hand the judge a conversation
 * that never happened, whereas facts are an unordered set where a hole is only
 * a smaller set.
 *
 * COST. The obvious implementation of the above — re-render and re-COUNT the
 * whole accumulated candidate once per turn — is quadratic in the kept text,
 * and the counter injected in production is real tiktoken, not the chars/4
 * heuristic. At the 24,000-token gate budget that is ~n full encodes of up to
 * 24k tokens each: hundreds of milliseconds to seconds of blocking CPU, per
 * turn, inside `after()`, where it competes with nothing but still holds the
 * invocation open.
 *
 * So the walk happens in two phases:
 *
 *   1. A cheap ADDITIVE prescan, newest-first, that encodes each turn ONCE and
 *      stops as soon as the running sum passes the budget. It touches only the
 *      newest ~budget worth of text — never the whole transcript — and it is
 *      never trusted: a tokenizer is not additive across a join, so this is an
 *      estimate that merely picks a starting point.
 *   2. An EXACT correction that measures whole rendered candidates: shrink from
 *      the old end while over budget, then grow while the next-older turn still
 *      fits. The grow loop's termination IS the "stops at the first turn that
 *      does not fit" rule, and the shrink loop is what makes the hard cap true
 *      for any counter. Both walk one turn at a time, and both normally run
 *      once or twice because the prescan lands within a couple of tokens.
 *
 * Every guarantee is therefore still measured, not inferred: the returned turns
 * are always a contiguous suffix, byte-identical to their sources, and the
 * rendered result is always measured to be within budget before it is returned.
 */
export function budgetTranscript(
  turns: TranscriptTurn[],
  budgetTokens: number,
  countTokens: TokenCounter = approxTokenCount
): BudgetedTranscript {
  if (turns.length === 0) {
    return { turns: [], omittedTurns: 0 };
  }

  // Phase 1 — additive prescan. `start` is the index of the oldest turn the
  // estimate thinks fits; turns.length means "nothing fits yet".
  const separatorTokens = countTokens(TRANSCRIPT_SEPARATOR);
  let start = turns.length;
  let estimate = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    estimate +=
      countTokens(renderTranscript([turns[i]])) +
      (start === turns.length ? 0 : separatorTokens);
    if (estimate > budgetTokens) {
      break;
    }
    start = i;
  }

  // Phase 2 — exact. Shrink first: the estimate can undercount when the
  // tokenizer merges across the join.
  while (
    start < turns.length &&
    countTokens(renderTranscript(turns.slice(start))) > budgetTokens
  ) {
    start++;
  }
  // Then grow: the estimate over-counts whenever per-turn encodes double-count
  // a boundary, and an honest budget spends what it has.
  while (
    start > 0 &&
    countTokens(renderTranscript(turns.slice(start - 1))) <= budgetTokens
  ) {
    start--;
  }

  return { turns: turns.slice(start), omittedTurns: start };
}
