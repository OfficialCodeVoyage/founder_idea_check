import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_REQUEST_BUDGET_MS } from "@/lib/ai/request-budget";

const warn = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logger", () => ({
  createModuleLogger: () => ({ warn }),
}));

import {
  canStartSearchStep,
  MIN_SEARCH_STEP_MS,
  planResearchClock,
  REPORT_ALLOWANCE_MS,
  recordCut,
  reportWordBudget,
  SEARCH_STEP_TIMEOUT_MS,
  searchStepTimeoutMs,
} from "./research-clock";

/**
 * GUARD for the live QA run (2026-11-12) that the chat route's own timer cut
 * at 289 s, mid-report. The run's stages must fit inside the route's budget
 * with the report's allowance intact, whatever the budget is set to.
 */
describe("planResearchClock", () => {
  const start = 1_000_000;
  const clock = planResearchClock(start + CHAT_REQUEST_BUDGET_MS, () => start);

  it("orders every stage before the route's abort", () => {
    expect(clock.searchStopAt).toBeGreaterThan(start);
    expect(clock.searchStopAt).toBeLessThan(clock.compressionDueAt);
    expect(clock.compressionDueAt).toBeLessThan(clock.findingsDueAt);
    expect(clock.findingsDueAt).toBeLessThan(clock.reportDueAt);
    expect(clock.reportDueAt).toBeLessThan(clock.requestDeadlineAt);
  });

  it("leaves the whole report allowance between the findings and the report deadline", () => {
    expect(clock.reportDueAt - clock.findingsDueAt).toBe(REPORT_ALLOWANCE_MS);
  });

  it("never lets a search step run past the search deadline", () => {
    const lastStart = {
      ...clock,
      now: () => clock.searchStopAt - MIN_SEARCH_STEP_MS,
    };
    expect(canStartSearchStep(lastStart)).toBe(true);
    expect(
      lastStart.now() + searchStepTimeoutMs(lastStart)
    ).toBeLessThanOrEqual(clock.searchStopAt);

    const early = { ...clock, now: () => start };
    expect(searchStepTimeoutMs(early)).toBe(SEARCH_STEP_TIMEOUT_MS);

    const tooLate = { ...clock, now: () => clock.searchStopAt - 1 };
    expect(canStartSearchStep(tooLate)).toBe(false);
  });

  it("asks a report that starts late for fewer words", () => {
    const onTime = { ...clock, now: () => clock.findingsDueAt };
    const late = { ...clock, now: () => clock.findingsDueAt + 60_000 };
    expect(reportWordBudget(late, 6000)).toBeLessThan(
      reportWordBudget(onTime, 6000)
    );
    // Never more than the model's own output ceiling allows.
    expect(reportWordBudget(onTime, 1000)).toBeLessThanOrEqual(750);
  });
});

/**
 * GUARD for the live QA run whose report said it was cut short while nothing
 * said which cut had fired: a cut is logged, once, with the reason and where in
 * the request it happened.
 */
describe("recordCut", () => {
  const start = 1_000_000;

  beforeEach(() => warn.mockClear());

  it("logs which cut fired and how far into the request it was, once", () => {
    const clock = planResearchClock(
      start + CHAT_REQUEST_BUDGET_MS,
      () => start + 119_000
    );
    const reason = "a researcher was stopped mid-step at the search deadline";

    recordCut(clock, reason, { stepsFinished: 2 });
    recordCut(clock, reason, { stepsFinished: 2 });

    expect(clock.cuts).toEqual([
      { reason, occurrences: [{ topic: null, detail: { stepsFinished: 2 } }] },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields] = warn.mock.calls[0];
    expect(fields).toMatchObject({
      reason,
      stepsFinished: 2,
      secondsIntoRequest: 119,
      searchStopDueAtSeconds: 120,
    });
  });
});
