import { assert, describe, expect, it } from "vitest";
import {
  judgeSimulation,
  MIN_DIVERGENCE_SCORE,
  measureDivergence,
  OasisPersonaSchema,
  type PersonaReaction,
  type ProjectPersona,
  reactionSimilarity,
  runSimulation,
  toOasisPersonas,
  UNSPECIFIED_MBTI,
} from "./simulation";

function persona(overrides: Partial<ProjectPersona> = {}): ProjectPersona {
  return {
    id: "p1",
    name: "Busy Dog Owner",
    description: "Works long hours, owns two dogs, pays a walker weekly.",
    headline: "Pays for dog walking, hates coordinating it",
    age: 34,
    gender: "female",
    country: "UK",
    ...overrides,
  };
}

function reaction(
  username: string,
  text: string,
  sentiment: number
): PersonaReaction {
  return { username, text, sentiment };
}

describe("toOasisPersonas — enforcing OASIS's seven unguarded keys up front", () => {
  it("produces exactly the keys generate_reddit_agent_graph indexes", () => {
    const seeded = toOasisPersonas(
      [persona(), persona({ id: "p2", name: "Rural Owner" })],
      []
    );
    expect(seeded.ok).toBe(true);
    if (seeded.ok) {
      for (const p of seeded.personas) {
        expect(OasisPersonaSchema.safeParse(p).success).toBe(true);
        expect(Object.keys(p).sort()).toEqual([
          "age",
          "bio",
          "country",
          "gender",
          "mbti",
          "persona",
          "username",
        ]);
      }
    }
  });

  it("supplies a greppable placeholder for the mbti OASIS demands but we do not model", () => {
    const seeded = toOasisPersonas(
      [persona(), persona({ id: "p2", name: "Other" })],
      []
    );
    expect(seeded.ok).toBe(true);
    if (seeded.ok) {
      expect(seeded.personas[0].mbti).toBe(UNSPECIFIED_MBTI);
    }
  });

  it("REFUSES a single-persona run — divergence is undefined over one agent", () => {
    const seeded = toOasisPersonas([persona()], []);
    expect(seeded.ok).toBe(false);
    if (!seeded.ok) {
      expect(seeded.problems.join(" ")).toContain("only one persona");
    }
  });

  it("REFUSES an empty run", () => {
    const seeded = toOasisPersonas([], []);
    expect(seeded.ok).toBe(false);
  });

  it("REFUSES colliding usernames, which would make two agents indistinguishable in the trace table", () => {
    const seeded = toOasisPersonas(
      [
        persona({ id: "a", name: "Dog Owner" }),
        persona({ id: "b", name: "dog-owner" }),
      ],
      []
    );
    expect(seeded.ok).toBe(false);
    if (!seeded.ok) {
      expect(seeded.problems.join(" ")).toContain("collides");
    }
  });

  it("reports EVERY problem at once, not one per round trip through a torch-loading sidecar", () => {
    const seeded = toOasisPersonas(
      [
        persona({ id: "a", name: "   " }),
        persona({ id: "b", name: "!!!" }),
        persona({ id: "c", name: "Ok Name", age: 5 }),
        persona({ id: "d", name: "Also Fine", country: "  " }),
      ],
      []
    );
    expect(seeded.ok).toBe(false);
    if (!seeded.ok) {
      expect(seeded.problems).toHaveLength(4);
      expect(seeded.problems.join(" ")).toContain('"a"');
      expect(seeded.problems.join(" ")).toContain('"d"');
    }
  });

  it("rejects a name that slugs to punctuation only, which carries no identity", () => {
    const seeded = toOasisPersonas(
      [persona({ id: "a", name: "!!!" }), persona({ id: "b", name: "Fine" })],
      []
    );
    expect(seeded.ok).toBe(false);
    if (!seeded.ok) {
      expect(seeded.problems[0]).toContain("no letters or digits");
    }
  });

  it("grounds each agent in the project's established facts — the cross-phase promise", () => {
    const seeded = toOasisPersonas(
      [persona(), persona({ id: "p2", name: "Rural Owner" })],
      [
        { key: "target_user", value: "urban dog owners who work full time" },
        { key: "pricing_model", value: "GBP 12 per walk" },
      ]
    );
    expect(seeded.ok).toBe(true);
    if (seeded.ok) {
      expect(seeded.personas[0].persona).toContain("GBP 12 per walk");
      expect(seeded.personas[0].persona).toContain("already established");
    }
  });

  it("slugs a display name into a username OASIS can sign up", () => {
    const seeded = toOasisPersonas(
      [
        persona({ name: "Busy Dog Owner!" }),
        persona({ id: "p2", name: "Rural" }),
      ],
      []
    );
    expect(seeded.ok).toBe(true);
    if (seeded.ok) {
      expect(seeded.personas[0].username).toBe("busy_dog_owner_");
    }
  });
});

describe("reactionSimilarity", () => {
  it("scores identical text as 1", () => {
    expect(reactionSimilarity("this is great", "this is great")).toBe(1);
  });

  it("scores unrelated text near 0", () => {
    expect(
      reactionSimilarity(
        "walking dogs is expensive",
        "quantum chromodynamics research funding"
      )
    ).toBe(0);
  });

  it("ignores punctuation and case", () => {
    expect(
      reactionSimilarity("Dogs, walking!", "dogs walking")
    ).toBeGreaterThan(0.9);
  });

  it("returns 0 rather than NaN for empty text", () => {
    expect(reactionSimilarity("", "anything meaningful")).toBe(0);
  });
});

describe("measureDivergence — the Step 8 gate", () => {
  it("scores N copies of one opinion near zero", () => {
    const same = "I would absolutely use this every single day it looks great";
    const report = measureDivergence([
      reaction("a", same, 0.9),
      reaction("b", same, 0.9),
      reaction("c", same, 0.9),
    ]);
    expect(report.duplicateRate).toBe(1);
    expect(report.sentimentSpread).toBe(0);
    expect(report.score).toBe(0);
  });

  it("scores genuinely different reactions high", () => {
    const report = measureDivergence([
      reaction(
        "a",
        "the scheduling problem is real, I would pay for this",
        0.9
      ),
      reaction("b", "my group chat already handles this fine, no thanks", -0.8),
      reaction("c", "price matters more than features here honestly", 0.1),
    ]);
    expect(report.score).toBeGreaterThan(MIN_DIVERGENCE_SCORE);
    expect(report.distinctReactions).toBe(3);
  });

  it("catches identical WORDING even when sentiment scores were spread", () => {
    const same = "this product would definitely solve my particular problem";
    const report = measureDivergence([
      reaction("a", same, 1),
      reaction("b", same, -1),
    ]);
    expect(report.duplicateRate).toBe(1);
    // Sentiment spread saves it from zero, but it must not clear the floor on
    // spread alone when every agent recited the same reasoning.
    expect(report.score).toBeLessThan(0.55);
  });

  it("catches identical SENTIMENT even when the wording varied", () => {
    const report = measureDivergence([
      reaction("a", "scheduling walks around my shifts is the hard bit", 0.5),
      reaction("b", "coordinating with the walker eats my evenings", 0.5),
    ]);
    expect(report.sentimentSpread).toBe(0);
  });

  it("treats a single reaction as maximally convergent, not as a clean pass", () => {
    const report = measureDivergence([reaction("a", "great", 1)]);
    expect(report.score).toBe(0);
    expect(report.duplicateRate).toBe(1);
  });

  it("returns finite numbers for an empty run", () => {
    const report = measureDivergence([]);
    expect(report.score).toBe(0);
    expect(Number.isFinite(report.sentimentSpread)).toBe(true);
  });
});

describe("judgeSimulation", () => {
  it("REJECTS a collapsed run and names it as one model's opinion restated", () => {
    const same = "I would absolutely use this every single day it looks great";
    const verdict = judgeSimulation([
      reaction("a", same, 0.9),
      reaction("b", same, 0.9),
    ]);
    // A collapse IS a judgement: two personas were reached and said the same
    // thing. That is a finding about the audience, not a failed run.
    expect(verdict.assessed).toBe(true);
    assert(verdict.assessed);
    expect(verdict.usable).toBe(false);
    expect(verdict.reason).toContain("converged");
    expect(verdict.reason).toContain("not an audience");
  });

  it("ACCEPTS a divergent run but still refuses to call it evidence", () => {
    const verdict = judgeSimulation([
      reaction(
        "a",
        "the scheduling problem is real, I would pay for this",
        0.9
      ),
      reaction("b", "my group chat already handles this fine, no thanks", -0.8),
      reaction("c", "price matters more than features here honestly", 0.1),
    ]);
    expect(verdict.assessed).toBe(true);
    assert(verdict.assessed);
    expect(verdict.usable).toBe(true);
    expect(verdict.usableAsEvidence).toBe(false);
    expect(verdict.reason).toContain("not as demand evidence");
  });

  it("is never usable as evidence, whatever the divergence", () => {
    for (const reactions of [
      [],
      [reaction("a", "x", 0)],
      [
        reaction("a", "totally different thing here", 1),
        reaction("b", "unrelated wording entirely", -1),
      ],
    ]) {
      expect(judgeSimulation(reactions).usableAsEvidence).toBe(false);
    }
  });

  it("does NOT judge a run with zero reactions — in either direction", () => {
    const judgement = judgeSimulation([]);
    expect(judgement.assessed).toBe(false);
    assert(!judgement.assessed);
    expect(judgement.kind).toBe("no-reactions");
    // The whole point: there is no `usable` to read, in either polarity. A
    // `false` here is what rendered an all-400 run as COLLAPSED.
    expect("usable" in judgement).toBe(false);
    expect(judgement.reason).toContain("not a collapsed audience");
  });

  it("does NOT judge a single reaction either — divergence is undefined", () => {
    const judgement = judgeSimulation([reaction("a", "great", 1)]);
    expect(judgement.assessed).toBe(false);
    assert(!judgement.assessed);
    expect(judgement.kind).toBe("too-few-reactions");
    expect("usable" in judgement).toBe(false);
  });

  it("surfaces the agent-error count so the app can say WHY nothing came back", () => {
    const judgement = judgeSimulation([], 4);
    assert(!judgement.assessed);
    expect(judgement.agentErrors).toBe(4);
    expect(judgement.reason).toContain("4 agent action(s) failed");
  });

  it("distinguishes 'nothing failed' from 'nobody counted'", () => {
    // 0 errors and a null count are different facts and must read differently:
    // one says the personas were reached and stayed silent, the other says this
    // sidecar build cannot tell you anything about why.
    const counted = judgeSimulation([], 0);
    assert(!counted.assessed);
    expect(counted.agentErrors).toBe(0);
    expect(counted.reason).toContain("No agent action failed");

    const uncounted = judgeSimulation([]);
    assert(!uncounted.assessed);
    expect(uncounted.agentErrors).toBeNull();
    expect(uncounted.reason).not.toContain("No agent action failed");
  });

  it("says nothing about agent errors on a clean judged run", () => {
    // Regression: the empty-run wording ("the personas were reached and simply
    // said nothing") was being appended to successful runs, directly above the
    // list of things the personas had just said. Caught in the browser, not by
    // a test — which is why this one exists.
    const judgement = judgeSimulation(
      [
        reaction("a", "the scheduling problem is real, I would pay", 0.9),
        reaction("b", "my group chat handles this fine already", -0.8),
      ],
      0
    );
    assert(judgement.assessed);
    expect(judgement.agentErrors).toBe(0);
    expect(judgement.reason).not.toContain("said nothing");
    expect(judgement.reason).not.toContain("agent action(s) failed");
  });

  it("carries the error count onto a PARTIAL run that was still judged", () => {
    // Two of four agents answered. The run is judgeable, and it is also not
    // the audience the founder chose — both facts have to survive.
    const judgement = judgeSimulation(
      [
        reaction("a", "the scheduling problem is real, I would pay", 0.9),
        reaction("b", "my group chat handles this fine already", -0.8),
      ],
      2
    );
    expect(judgement.assessed).toBe(true);
    assert(judgement.assessed);
    expect(judgement.agentErrors).toBe(2);
    expect(judgement.reason).toContain("2 agent action(s) failed");
  });
});

describe("runSimulation", () => {
  const TWO = [persona(), persona({ id: "p2", name: "Rural Owner" })];

  it("refuses before calling the sidecar when the personas cannot seed OASIS", async () => {
    let called = false;
    const outcome = await runSimulation(
      {
        run: () => {
          called = true;
          return Promise.resolve({ ok: true, reactions: [] });
        },
      },
      { personas: [persona()], facts: [], pitch: "p", rounds: 1 }
    );
    expect(called).toBe(false);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("invalid-personas");
    }
  });

  it("returns unavailable rather than throwing when the sidecar is down", async () => {
    const outcome = await runSimulation(
      { run: () => Promise.reject(new Error("ECONNREFUSED")) },
      { personas: TWO, facts: [], pitch: "p", rounds: 1 }
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("unavailable");
    }
  });

  it("passes a sidecar-reported failure straight through", async () => {
    const outcome = await runSimulation(
      {
        run: () =>
          Promise.resolve({
            ok: false,
            kind: "oasis-not-installed",
            detail: "the simulation extra is not installed in this image",
          }),
      },
      { personas: TWO, facts: [], pitch: "p", rounds: 1 }
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("oasis-not-installed");
    }
  });

  it("judges the reactions it got back", async () => {
    const outcome = await runSimulation(
      {
        run: () =>
          Promise.resolve({
            ok: true,
            reactions: [
              {
                username: "a",
                text: "I would pay for this today",
                sentiment: 0.9,
              },
              {
                username: "b",
                text: "my spreadsheet already works fine",
                sentiment: -0.7,
              },
            ],
          }),
      },
      { personas: TWO, facts: [], pitch: "p", rounds: 1 }
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.verdict.usable).toBe(true);
      expect(outcome.reactions).toHaveLength(2);
    }
  });

  it("reports schema drift rather than crashing on an unexpected body", async () => {
    const outcome = await runSimulation(
      { run: () => Promise.resolve({ surprise: true }) },
      { personas: TWO, facts: [], pitch: "p", rounds: 1 }
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("schema-drift");
    }
  });
});
