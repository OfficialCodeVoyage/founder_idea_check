import { describe, expect, it } from "vitest";
import { getPhaseByKey } from "./definitions";

/**
 * THE JUDGE WRITES ITS GAP TEXT OUT OF THE CRITERION DESCRIPTION.
 *
 * Live, on four of the seven problem-validation refusals, the founder read:
 *
 *   "four evidence-backed rubric scores to calculate the validation product"
 *
 * "the validation product" reads as THIS APP — the thing they were talking to.
 * It means the arithmetic product of four 1-5 scores. Nothing in the repository
 * contains that phrase: the judge composed it from `validation-score`'s
 * description, which listed four factors separated by "x" and never named what
 * multiplying them produces.
 *
 * So the description names the result — "the validation score", the same words
 * as the metric key it writes — and spells the arithmetic out in words. This
 * test is the guard: the phrase is one careless edit away from coming back, and
 * it is not visible from the definition itself, only from what the judge then
 * writes on the card.
 */
describe("validation-score reads as arithmetic, not as this product", () => {
  const criterion = getPhaseByKey("problem-validation")?.exitCriteria.find(
    (c) => c.id === "validation-score"
  );

  it("exists", () => {
    expect(criterion).toBeDefined();
  });

  it("never calls the result a 'product'", () => {
    expect(criterion?.description.toLowerCase()).not.toContain("product");
  });

  it("names what the four scores produce, so the judge can too", () => {
    expect(criterion?.description.toLowerCase()).toContain("validation score");
  });

  it("still states the four factors and the threshold", () => {
    const text = criterion?.description.toLowerCase() ?? "";
    for (const factor of [
      "frequency",
      "intensity",
      "workaround",
      "willingness to pay",
    ]) {
      expect(text, `missing "${factor}"`).toContain(factor);
    }
    expect(text).toContain("100");
  });
});
