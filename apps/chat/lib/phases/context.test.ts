import { describe, expect, it } from "vitest";

/** Hoisted: biome's useTopLevelRegex — recompiling per call in a hot map. */
const AXIS_PATTERN = /axis-(\d+)/;

import { EMBEDDING_DIMENSIONS } from "../embeddings/text";
import {
  approxTokenCount,
  buildFactBlock,
  DeterministicFactSelector,
  EmbeddingFactSelector,
  FACT_BLOCK_HEADING,
  type FactEmbedder,
  type FactSelector,
  pinnedFactKeys,
  renderFactLine,
  type SelectFactsOptions,
  type StoredFact,
  selectAndRenderFacts,
  selectFacts,
  toKnownFact,
  tokenize,
} from "./context";
import { PHASE_ONE } from "./definitions";
import { renderFacts } from "./gate";

const NONE_ESTABLISHED = "(none established yet)";

const OLD = new Date("2026-01-01T00:00:00.000Z");
const MID = new Date("2026-02-01T00:00:00.000Z");
const NEW = new Date("2026-03-01T00:00:00.000Z");

/**
 * Vocabulary chosen so it shares NO token with any phase-1 exit criterion.
 * That pins relevance to 0 for every fact, which is what isolates the
 * confidence and recency tests from the keyword scorer.
 */
function inert(
  key: string,
  confidence: number,
  updatedAt: Date,
  value = "Quokkas nibble kelp at dusk."
): StoredFact {
  return { key, value, confidence, updatedAt, phaseKey: PHASE_ONE.key };
}

const OPTS: SelectFactsOptions = { phase: PHASE_ONE };

function keysOf(facts: StoredFact[], opts: SelectFactsOptions = OPTS) {
  return selectFacts(facts, opts).ranked.map((s) => s.fact.key);
}

describe("tokenize", () => {
  it("lowercases, splits on non-alphanumerics and drops stopwords", () => {
    expect(tokenize("The Ops-Manager reconciles 12 invoices!")).toEqual([
      "ops",
      "manager",
      "reconciles",
      "invoices",
    ]);
  });

  it("drops tokens shorter than three characters", () => {
    expect(tokenize("a to be or not 42 xy abc")).toEqual(["abc"]);
  });
});

describe("pinnedFactKeys", () => {
  it("collects the fact keys named by BLOCKING criteria only", () => {
    const pinned = pinnedFactKeys(PHASE_ONE);

    // artifact-exists (blocking) + metric-threshold (blocking)
    expect([...pinned].sort()).toEqual([
      "problem_statement",
      "target_user",
      "validation_score",
    ]);
    // people_interviewed is severity "advisory" — never pinned.
    expect(pinned.has("people_interviewed")).toBe(false);
  });
});

describe("selectFacts — ranking", () => {
  it("ranks higher confidence first when nothing else differs", () => {
    const facts = [
      inert("zeta_note", 45, MID),
      inert("alpha_note", 90, MID),
      inert("gamma_note", 70, MID),
    ];

    expect(keysOf(facts)).toEqual(["alpha_note", "gamma_note", "zeta_note"]);
  });

  it("ranks the more recent fact first at equal confidence", () => {
    const facts = [
      inert("alpha_note", 60, OLD),
      inert("zeta_note", 60, NEW),
      inert("gamma_note", 60, MID),
    ];

    expect(keysOf(facts)).toEqual(["zeta_note", "gamma_note", "alpha_note"]);
  });

  it("promotes a relevant OLD fact over a newer irrelevant one", () => {
    const relevantButOld = inert(
      "alpha_note",
      60,
      OLD,
      "Freelance bookkeepers reconcile invoices on Friday mornings."
    );
    const irrelevantButNew = inert("zeta_note", 60, NEW);
    const opts: SelectFactsOptions = {
      phase: PHASE_ONE,
      latestUserMessage:
        "Tell me again what the freelance bookkeepers said about reconciling invoices.",
    };

    // Recency alone would put zeta_note first.
    expect(keysOf([relevantButOld, irrelevantButNew])).toEqual([
      "zeta_note",
      "alpha_note",
    ]);
    // Keyword overlap with the latest message flips it.
    expect(keysOf([relevantButOld, irrelevantButNew], opts)).toEqual([
      "alpha_note",
      "zeta_note",
    ]);
  });

  it("pins fact keys named by blocking criteria ahead of everything", () => {
    // The worst possible score: lowest confidence, oldest, no overlap.
    const pinned: StoredFact = {
      key: "problem_statement",
      value: "Quokkas nibble kelp at dusk.",
      confidence: 1,
      updatedAt: OLD,
      phaseKey: PHASE_ONE.key,
    };
    const strong = inert("zeta_note", 100, NEW);

    const ranked = selectFacts([strong, pinned], OPTS).ranked;

    expect(ranked.map((s) => s.fact.key)).toEqual([
      "problem_statement",
      "zeta_note",
    ]);
    expect(ranked[0].pinned).toBe(true);
    expect(ranked[1].pinned).toBe(false);
  });

  it("scores components on a 0-100 scale and weights them into the score", () => {
    const only = inert("alpha_note", 80, MID);
    const [scored] = selectFacts([only], OPTS).ranked;

    // Single distinct timestamp ⇒ recency 100. No overlap ⇒ relevance 0.
    expect(scored.components).toEqual({
      relevance: 0,
      confidence: 80,
      recency: 100,
    });
    expect(scored.score).toBe(3 * 80 + 2 * 100);
  });

  it("gives facts sharing an updatedAt the same recency score", () => {
    const facts = [
      inert("alpha_note", 50, MID),
      inert("gamma_note", 50, MID),
      inert("zeta_note", 50, OLD),
    ];

    const ranked = selectFacts(facts, OPTS).ranked;
    const byKey = new Map(
      ranked.map((s) => [s.fact.key, s.components.recency])
    );

    expect(byKey.get("alpha_note")).toBe(100);
    expect(byKey.get("gamma_note")).toBe(100);
    expect(byKey.get("zeta_note")).toBe(0);
  });

  it("caps at maxFacts and reports what it omitted", () => {
    const facts = [
      inert("alpha_note", 90, MID),
      inert("gamma_note", 70, MID),
      inert("zeta_note", 50, MID),
    ];

    const selected = selectFacts(facts, { ...OPTS, maxFacts: 2 });

    expect(selected.ranked.map((s) => s.fact.key)).toEqual([
      "alpha_note",
      "gamma_note",
    ]);
    expect(selected.omitted).toEqual(["zeta_note"]);
  });

  it("dedupes a repeated key, keeping the best row", () => {
    const facts = [inert("alpha_note", 40, OLD), inert("alpha_note", 90, MID)];

    const ranked = selectFacts(facts, OPTS).ranked;

    expect(ranked).toHaveLength(1);
    expect(ranked[0].fact.confidence).toBe(90);
  });

  it("returns an empty ranking for an empty store, not a crash", () => {
    expect(selectFacts([], OPTS)).toEqual({ ranked: [], omitted: [] });
  });
});

describe("selectFacts — determinism", () => {
  const facts: StoredFact[] = [
    inert("alpha_note", 60, MID),
    inert("gamma_note", 60, MID),
    inert("zeta_note", 60, MID),
    inert("delta_note", 60, MID),
  ];

  it("produces byte-identical output for identical input", () => {
    const a = selectAndRenderFacts(facts, OPTS, 500);
    const b = selectAndRenderFacts(facts, OPTS, 500);

    expect(a.text).toBe(b.text);
    expect(a).toEqual(b);
  });

  it("does not depend on the input order (no reliance on sort stability)", () => {
    // Every fact here scores IDENTICALLY, so only the explicit key tie-break
    // can decide the order. A stable-sort-dependent implementation would echo
    // whatever order it was handed.
    const forwards = selectAndRenderFacts(facts, OPTS, 500).text;
    const backwards = selectAndRenderFacts(
      [...facts].reverse(),
      OPTS,
      500
    ).text;
    const shuffled = selectAndRenderFacts(
      [facts[2], facts[0], facts[3], facts[1]],
      OPTS,
      500
    ).text;

    expect(backwards).toBe(forwards);
    expect(shuffled).toBe(forwards);
    expect(forwards.split("\n").slice(1)).toEqual([
      renderFactLine(facts[0]),
      renderFactLine(facts[3]),
      renderFactLine(facts[1]),
      renderFactLine(facts[2]),
    ]);
  });
});

describe("renderFactLine", () => {
  it("is byte-identical to gate.renderFacts for a single fact", () => {
    const fact = inert("alpha_note", 73, MID);

    expect(renderFacts([toKnownFact(fact)])).toBe(renderFactLine(fact));
  });
});

describe("buildFactBlock", () => {
  const many: StoredFact[] = [
    inert("alpha_note", 95, NEW, "Alpha value that is reasonably long."),
    inert("gamma_note", 85, NEW, "Gamma value that is reasonably long."),
    inert("delta_note", 75, NEW, "Delta value that is reasonably long."),
    inert("zeta_note", 65, NEW, "Zeta value that is reasonably long."),
  ];

  it("renders the heading and the none-established marker for no facts", () => {
    const block = buildFactBlock({ ranked: [], omitted: [] }, 100);

    expect(block.text).toBe(`${FACT_BLOCK_HEADING}\n${NONE_ESTABLISHED}`);
    expect(block.includedKeys).toEqual([]);
    expect(block.droppedKeys).toEqual([]);
    expect(block.droppedPinnedKeys).toEqual([]);
  });

  it("NEVER exceeds the budget, at every budget from 0 upwards", () => {
    const selected = selectFacts(many, OPTS);
    const whole = buildFactBlock(selected, Number.MAX_SAFE_INTEGER);

    for (let budget = 0; budget <= whole.tokens + 5; budget++) {
      const block = buildFactBlock(selected, budget);
      expect(approxTokenCount(block.text)).toBeLessThanOrEqual(budget);
      expect(block.tokens).toBeLessThanOrEqual(budget);
    }
  });

  it("drops WHOLE facts — every rendered line is a complete fact line", () => {
    const selected = selectFacts(many, OPTS);
    const whole = buildFactBlock(selected, Number.MAX_SAFE_INTEGER);
    const lineOf = new Map(many.map((f) => [f.key, renderFactLine(f)]));

    for (let budget = 0; budget <= whole.tokens; budget++) {
      const block = buildFactBlock(selected, budget);
      const lines = block.text === "" ? [] : block.text.split("\n").slice(1);

      if (block.includedKeys.length === 0) {
        expect(lines.length === 0 || lines[0] === NONE_ESTABLISHED).toBe(true);
        continue;
      }
      expect(lines).toEqual(block.includedKeys.map((k) => lineOf.get(k)));
      // Nothing that was dropped leaks in as a fragment.
      for (const key of block.droppedKeys) {
        expect(block.text.includes(key)).toBe(false);
      }
    }
  });

  it("drops the lowest-scoring facts first when all facts cost the same", () => {
    const selected = selectFacts(many, OPTS);
    const two = buildFactBlock(
      selected,
      approxTokenCount(
        `${FACT_BLOCK_HEADING}\n${renderFactLine(many[0])}\n${renderFactLine(many[1])}`
      )
    );

    expect(two.includedKeys).toEqual(["alpha_note", "gamma_note"]);
    expect(two.droppedKeys).toEqual(["delta_note", "zeta_note"]);
  });

  it("emits nothing at all when the budget cannot carry the heading", () => {
    const selected = selectFacts(many, OPTS);
    const block = buildFactBlock(selected, 1);

    expect(block.text).toBe("");
    expect(block.tokens).toBe(0);
    expect(block.includedKeys).toEqual([]);
    expect(block.droppedKeys).toEqual([
      "alpha_note",
      "gamma_note",
      "delta_note",
      "zeta_note",
    ]);
  });

  it("keeps a pinned fact inside a budget that only fits one fact", () => {
    const pinned: StoredFact = {
      key: "problem_statement",
      value:
        "Freelance bookkeepers lose two hours a week reconciling invoices.",
      confidence: 20,
      updatedAt: OLD,
      phaseKey: PHASE_ONE.key,
    };
    const facts = [...many, pinned];
    const selected = selectFacts(facts, OPTS);
    const budget = approxTokenCount(
      `${FACT_BLOCK_HEADING}\n${renderFactLine(pinned)}`
    );

    const block = buildFactBlock(selected, budget);

    expect(block.includedKeys).toEqual(["problem_statement"]);
    expect(block.droppedPinnedKeys).toEqual([]);
  });

  it("reports a pinned fact it was forced to drop", () => {
    const pinned: StoredFact = {
      key: "problem_statement",
      value: "x".repeat(400),
      confidence: 20,
      updatedAt: OLD,
      phaseKey: PHASE_ONE.key,
    };
    const selected = selectFacts([pinned, many[0]], OPTS);
    const budget = approxTokenCount(
      `${FACT_BLOCK_HEADING}\n${renderFactLine(many[0])}`
    );

    const block = buildFactBlock(selected, budget);

    expect(block.includedKeys).toEqual(["alpha_note"]);
    expect(block.droppedPinnedKeys).toEqual(["problem_statement"]);
  });

  it("honours an injected token counter", () => {
    const selected = selectFacts(many, OPTS);
    // One "token" per line. Heading + none-established costs 2.
    const countTokens = (text: string) => text.split("\n").length;

    const block = buildFactBlock(selected, 3, { countTokens });

    expect(block.includedKeys).toEqual(["alpha_note", "gamma_note"]);
    expect(block.tokens).toBe(3);
  });

  it("honours a custom heading", () => {
    const block = buildFactBlock({ ranked: [], omitted: [] }, 100, {
      heading: "## Facts",
    });

    expect(block.text).toBe(`## Facts\n${NONE_ESTABLISHED}`);
  });
});

describe("the selector seams", () => {
  it("DeterministicFactSelector satisfies FactSelector and needs no key", () => {
    const selector: FactSelector = new DeterministicFactSelector();
    const facts = [inert("alpha_note", 90, MID), inert("zeta_note", 50, MID)];

    expect(selector.select(facts, OPTS).ranked.map((s) => s.fact.key)).toEqual([
      "alpha_note",
      "zeta_note",
    ]);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // EmbeddingFactSelector. No network, no key: the embedder is a closure that
  // returns hand-built vectors, so every property below is exact rather than
  // "roughly ranks better".
  // ───────────────────────────────────────────────────────────────────────────

  /** A unit vector pointing along one axis, at the real column width. */
  function axis(i: number): number[] {
    const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    v[i] = 1;
    return v;
  }

  /** Embeds the query onto axis 0; each fact onto the axis its value names. */
  function axisEmbedder(): FactEmbedder {
    return (texts: string[]) =>
      Promise.resolve(
        texts.map((text) => {
          const match = AXIS_PATTERN.exec(text);
          return axis(match ? Number(match[1]) : 0);
        })
      );
  }

  it("ranks by cosine similarity to the query", async () => {
    const selector = new EmbeddingFactSelector({ embed: axisEmbedder() });
    // Same confidence and same timestamp, so relevance is the ONLY difference.
    const facts = [
      inert("far_note", 60, MID, "axis-7"),
      inert("near_note", 60, MID, "axis-0"),
    ];

    const ranked = await selector.select(facts, OPTS);

    expect(ranked.ranked.map((s) => s.fact.key)).toEqual([
      "near_note",
      "far_note",
    ]);
    // cos=1 -> 100, cos=0 -> 50 under the (1+cos)/2 map.
    expect(ranked.ranked[0]?.components.relevance).toBe(100);
    expect(ranked.ranked[1]?.components.relevance).toBe(50);
  });

  it("reuses a stored vector instead of re-embedding it", async () => {
    const seen: string[][] = [];
    const selector = new EmbeddingFactSelector({
      embed: (texts) => {
        seen.push(texts);
        return Promise.resolve(texts.map(() => axis(0)));
      },
    });
    const warm: StoredFact = {
      ...inert("warm_note", 60, MID),
      embedding: axis(0),
    };
    const cold = inert("cold_note", 60, MID, "axis-1");

    await selector.select([warm, cold], OPTS);

    // One call, and the warm fact's text is NOT in it.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(2); // the query + the cold fact only
    expect(seen[0]?.join(" ")).not.toContain("warm note");
  });

  it("ignores a stored vector of the wrong width rather than trusting it", async () => {
    const selector = new EmbeddingFactSelector({ embed: axisEmbedder() });
    const wrongWidth: StoredFact = {
      ...inert("stale_note", 60, MID, "axis-0"),
      embedding: [1, 0, 0],
    };

    const ranked = await selector.select([wrongWidth], OPTS);

    // Re-embedded onto axis 0, so it scores as an exact match rather than 0.
    expect(ranked.ranked[0]?.components.relevance).toBe(100);
  });

  it("falls back to the keyword selector when the embedder throws", async () => {
    const errors: unknown[] = [];
    const selector = new EmbeddingFactSelector({
      embed: () => Promise.reject(new Error("provider down")),
      onFallback: (e) => errors.push(e),
    });
    const facts = [inert("alpha_note", 90, MID), inert("zeta_note", 50, MID)];

    const ranked = await selector.select(facts, OPTS);

    // Degraded, never empty — an empty fact block would turn a retrieval
    // outage into a phase BLOCK the founder cannot clear by answering.
    expect(ranked.ranked.map((s) => s.fact.key)).toEqual([
      "alpha_note",
      "zeta_note",
    ]);
    expect(errors).toHaveLength(1);
  });

  it("falls back when the embedder returns the wrong number of vectors", async () => {
    const errors: unknown[] = [];
    const selector = new EmbeddingFactSelector({
      embed: () => Promise.resolve([axis(0)]),
      onFallback: (e) => errors.push(e),
    });

    const ranked = await selector.select([inert("alpha_note", 90, MID)], OPTS);

    expect(ranked.ranked).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it("keeps a pinned fact first even when it is semantically distant", async () => {
    const selector = new EmbeddingFactSelector({ embed: axisEmbedder() });
    const pinnedKey = [...pinnedFactKeys(PHASE_ONE)][0] as string;
    const facts = [
      inert("near_note", 90, MID, "axis-0"),
      inert(pinnedKey, 10, MID, "axis-9"),
    ];

    const ranked = await selector.select(facts, OPTS);

    expect(ranked.ranked[0]?.fact.key).toBe(pinnedKey);
    expect(ranked.ranked[0]?.pinned).toBe(true);
  });

  it("produces the same SelectedFacts shape as the deterministic selector", async () => {
    const facts = [inert("alpha_note", 90, MID), inert("zeta_note", 50, MID)];
    const opts: SelectFactsOptions = { ...OPTS, maxFacts: 1 };

    const embedded = await new EmbeddingFactSelector({
      embed: axisEmbedder(),
    }).select(facts, opts);
    const keyword = new DeterministicFactSelector().select(facts, opts);

    expect(Object.keys(embedded).sort()).toEqual(Object.keys(keyword).sort());
    expect(embedded.ranked).toHaveLength(1);
    expect(embedded.omitted).toHaveLength(1);
  });
});
