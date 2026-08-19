import { describe, expect, it } from "vitest";
import {
  DEFAULT_COST_MODEL,
  decideResearchBudget,
  isUsableShape,
  largestAffordableShape,
  nextBreadth,
  projectPlanningCalls,
  projectQueryCount,
  projectResearchCost,
  type ResearchBudget,
} from "./budget";

const SELF_HOST: ResearchBudget = { maxInputTokensPerRun: null, hosted: false };
const HOSTED_NO_CAP: ResearchBudget = {
  maxInputTokensPerRun: null,
  hosted: true,
};

describe("nextBreadth — the halving rule ported from dzhng/deep-research", () => {
  it("halves and rounds up, so breadth never reaches zero while depth remains", () => {
    expect(nextBreadth(4)).toBe(2);
    expect(nextBreadth(3)).toBe(2);
    expect(nextBreadth(2)).toBe(1);
    expect(nextBreadth(1)).toBe(1);
  });
});

describe("projectQueryCount — the shape of the tree the loop actually walks", () => {
  it("depth 1 is exactly breadth queries and no recursion", () => {
    expect(projectQueryCount({ breadth: 4, depth: 1 })).toBe(4);
  });

  it("depth 2 adds one halved level per top-level query", () => {
    // 4 top-level + 4 x (2 child queries) = 12
    expect(projectQueryCount({ breadth: 4, depth: 2 })).toBe(12);
  });

  it("depth 3 compounds: this is why an uncapped run is unaffordable", () => {
    // 4 + 4 x (2 + 2 x 1) = 4 + 4 x 4 = 20
    expect(projectQueryCount({ breadth: 4, depth: 3 })).toBe(20);
  });

  it("returns zero for a shape with no work in it, rather than throwing", () => {
    expect(projectQueryCount({ breadth: 0, depth: 3 })).toBe(0);
    expect(projectQueryCount({ breadth: 4, depth: 0 })).toBe(0);
  });
});

describe("projectPlanningCalls — one per NODE, not one per query", () => {
  it("counts one call at depth 1", () => {
    expect(projectPlanningCalls({ breadth: 4, depth: 1 })).toBe(1);
  });

  it("counts the root plus one per top-level query at depth 2", () => {
    expect(projectPlanningCalls({ breadth: 4, depth: 2 })).toBe(5);
  });
});

describe("isUsableShape — the guard against a meaningless projection", () => {
  it("accepts an ordinary shape", () => {
    expect(isUsableShape({ breadth: 4, depth: 2 })).toBe(true);
  });

  it("rejects fractional, negative, zero and non-finite shapes", () => {
    expect(isUsableShape({ breadth: 2.5, depth: 2 })).toBe(false);
    expect(isUsableShape({ breadth: -1, depth: 2 })).toBe(false);
    expect(isUsableShape({ breadth: 0, depth: 2 })).toBe(false);
    expect(isUsableShape({ breadth: 4, depth: 0 })).toBe(false);
    expect(isUsableShape({ breadth: Number.NaN, depth: 2 })).toBe(false);
    expect(isUsableShape({ breadth: Number.POSITIVE_INFINITY, depth: 2 })).toBe(
      false
    );
  });

  it("rejects a shape past the hard ceiling", () => {
    expect(isUsableShape({ breadth: 13, depth: 2 })).toBe(false);
    expect(isUsableShape({ breadth: 4, depth: 7 })).toBe(false);
  });
});

describe("projectResearchCost", () => {
  it("returns null rather than zero for an unusable shape", () => {
    expect(
      projectResearchCost({
        shape: { breadth: 0, depth: 2 },
        researcherCount: 4,
      })
    ).toBeNull();
  });

  it("returns null for a nonsense researcher count", () => {
    expect(
      projectResearchCost({
        shape: { breadth: 4, depth: 2 },
        researcherCount: 0,
      })
    ).toBeNull();
    expect(
      projectResearchCost({
        shape: { breadth: 4, depth: 2 },
        researcherCount: 1.5,
      })
    ).toBeNull();
  });

  it("multiplies through the fan-out", () => {
    const one = projectResearchCost({
      shape: { breadth: 4, depth: 2 },
      researcherCount: 1,
    });
    const four = projectResearchCost({
      shape: { breadth: 4, depth: 2 },
      researcherCount: 4,
    });
    expect(one).not.toBeNull();
    expect(four).not.toBeNull();
    expect(four?.totalInputTokens).toBe((one?.totalInputTokens ?? 0) * 4);
    expect(four?.totalQueries).toBe(48);
  });

  it("lands in the 600k-1M range the plan budgets for a 4-role run", () => {
    // This is the number the whole cap exists to bound. If a refactor moves it
    // by an order of magnitude, the cap is either useless or blocks everything.
    const projection = projectResearchCost({
      shape: { breadth: 4, depth: 2 },
      researcherCount: 4,
    });
    expect(projection?.totalInputTokens).toBeGreaterThan(600_000);
    expect(projection?.totalInputTokens).toBeLessThan(2_000_000);
  });

  it("costs each call kind separately", () => {
    const projection = projectResearchCost({
      shape: { breadth: 2, depth: 1 },
      researcherCount: 1,
      costModel: {
        planningInputTokens: 10,
        extractionInputTokens: 100,
        finalReportInputTokens: 1000,
      },
    });
    // 1 planning call x 10 + 2 queries x 100 + 1 report x 1000
    expect(projection?.totalInputTokens).toBe(1210);
  });
});

describe("decideResearchBudget — the pre-flight gate", () => {
  it("REFUSES a run projected past the cap, and names the numbers", () => {
    const decision = decideResearchBudget(
      { shape: { breadth: 4, depth: 3 }, researcherCount: 4 },
      { maxInputTokensPerRun: 100_000, hosted: true }
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Refusing to start");
    expect(decision.reason).toContain("100,000");
    expect(decision.reason).toContain("4 researchers");
  });

  it("allows a run that fits", () => {
    const decision = decideResearchBudget(
      { shape: { breadth: 2, depth: 1 }, researcherCount: 1 },
      { maxInputTokensPerRun: 5_000_000, hosted: true }
    );
    expect(decision.allowed).toBe(true);
  });

  it("REFUSES hosted mode with no cap configured — a missing cap is not an infinite one", () => {
    const decision = decideResearchBudget(
      { shape: { breadth: 2, depth: 1 }, researcherCount: 1 },
      HOSTED_NO_CAP
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("no research token cap configured");
  });

  it("allows self-host with no cap, because the key is the operator's own", () => {
    const decision = decideResearchBudget(
      { shape: { breadth: 4, depth: 3 }, researcherCount: 4 },
      SELF_HOST
    );
    expect(decision.allowed).toBe(true);
  });

  it("REFUSES a cap that is not a usable number", () => {
    for (const cap of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const decision = decideResearchBudget(
        { shape: { breadth: 2, depth: 1 }, researcherCount: 1 },
        { maxInputTokensPerRun: cap, hosted: false }
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("not a usable number");
    }
  });

  it("REFUSES an out-of-range shape before costing it, and names the range", () => {
    const decision = decideResearchBudget(
      { shape: { breadth: 99, depth: 99 }, researcherCount: 4 },
      { maxInputTokensPerRun: 10_000_000_000, hosted: false }
    );
    expect(decision.allowed).toBe(false);
    expect(decision.projection).toBeNull();
    expect(decision.reason).toContain("out of range");
  });

  it("carries the projection out on a refusal so the caller can show the number", () => {
    const decision = decideResearchBudget(
      { shape: { breadth: 4, depth: 3 }, researcherCount: 4 },
      { maxInputTokensPerRun: 1000, hosted: true }
    );
    expect(decision.allowed).toBe(false);
    expect(decision.projection?.totalQueries).toBe(80);
  });
});

describe("largestAffordableShape — a refusal the user can act on", () => {
  it("finds the biggest shape that fits a tight budget", () => {
    const shape = largestAffordableShape(
      { researcherCount: 1 },
      { maxInputTokensPerRun: 200_000, hosted: true },
      { breadth: 6, depth: 3 }
    );
    expect(shape).not.toBeNull();
    const decision = decideResearchBudget(
      {
        shape: shape as { breadth: number; depth: number },
        researcherCount: 1,
      },
      { maxInputTokensPerRun: 200_000, hosted: true }
    );
    expect(decision.allowed).toBe(true);
  });

  it("returns null when even one query is unaffordable, rather than a shape that would be refused", () => {
    const shape = largestAffordableShape(
      { researcherCount: 4 },
      { maxInputTokensPerRun: 10, hosted: true },
      { breadth: 6, depth: 3 }
    );
    expect(shape).toBeNull();
  });

  it("never returns a shape the gate would refuse", () => {
    const budget: ResearchBudget = {
      maxInputTokensPerRun: 900_000,
      hosted: true,
    };
    const shape = largestAffordableShape({ researcherCount: 4 }, budget, {
      breadth: 8,
      depth: 4,
    });
    if (shape) {
      expect(
        decideResearchBudget({ shape, researcherCount: 4 }, budget).allowed
      ).toBe(true);
    }
  });
});

describe("DEFAULT_COST_MODEL", () => {
  it("keeps extraction as the dominant term — it is where the money goes", () => {
    expect(DEFAULT_COST_MODEL.extractionInputTokens).toBeGreaterThan(
      DEFAULT_COST_MODEL.planningInputTokens * 10
    );
  });
});
