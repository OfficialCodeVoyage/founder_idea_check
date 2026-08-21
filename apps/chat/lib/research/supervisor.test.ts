import { describe, expect, it, vi } from "vitest";
import {
  createSemaphore,
  decideOverflow,
  planFanOut,
  runFanOut,
  sanitizeLearnings,
  summarizeFanOut,
} from "./supervisor";
import type { ResearchLearning, ResearchResult, ResearchRole } from "./types";

// Hoisted because biome bars regex literals inside frequently-called scopes.
const POSITIVE_INTEGER = /positive integer/;
const ZERO_ROLES = /zero research roles/;

/**
 * FOUR ROLES, AS A TEST FIXTURE. This used to be `FOUR_ROLES` from
 * `lib/research/roles.ts`, which was deleted as unreachable — nothing outside
 * this file's own tests ever imported it. What these tests actually need is
 * "four distinct roles", not four particular prompts, so the fixture lives here
 * now. The real prompts are recoverable from git if the parallel research
 * fan-out is ever wired up.
 */
const FOUR_ROLES: readonly ResearchRole[] = [
  "demand",
  "competitor",
  "feasibility",
  "willingness",
].map((id) => ({
  id,
  label: id,
  sourceIds: ["hackernews"],
  systemPrompt: `research ${id}`,
}));

const DUPLICATE = /Duplicate/;

function role(id: string): ResearchRole {
  return { id, label: id, systemPrompt: `be ${id}`, sourceIds: [] };
}

function learning(
  text: string,
  url = "https://example.com/a"
): ResearchLearning {
  return { text, url, roleId: "demand" };
}

function result(
  roleId: string,
  learnings: ResearchLearning[] = [],
  failures: ResearchResult["failures"] = []
): ResearchResult {
  return { roleId, learnings, visitedUrls: [], failures };
}

describe("createSemaphore", () => {
  it("throws on a limit that would deadlock rather than clamping it", () => {
    expect(() => createSemaphore(0)).toThrow(POSITIVE_INTEGER);
    expect(() => createSemaphore(-1)).toThrow(POSITIVE_INTEGER);
    expect(() => createSemaphore(1.5)).toThrow(POSITIVE_INTEGER);
  });

  it("admits up to the limit immediately and queues the rest", async () => {
    const semaphore = createSemaphore(2);
    const a = await semaphore.acquire();
    await semaphore.acquire();
    expect(semaphore.inFlight).toBe(2);

    let thirdAdmitted = false;
    const third = semaphore.acquire().then((release) => {
      thirdAdmitted = true;
      return release;
    });
    await Promise.resolve();
    expect(thirdAdmitted).toBe(false);
    expect(semaphore.waiting).toBe(1);

    a();
    await third;
    expect(thirdAdmitted).toBe(true);
    expect(semaphore.inFlight).toBe(2);
  });
});

describe("planFanOut", () => {
  it("refuses an empty role list — a report from zero researchers reads as a complete one", () => {
    expect(() => planFanOut([], 4)).toThrow(ZERO_ROLES);
  });

  it("refuses duplicate role ids, which would silently discard a researcher", () => {
    expect(() => planFanOut([role("a"), role("a")], 4)).toThrow(DUPLICATE);
  });

  it("refuses a nonsense concurrency value", () => {
    expect(() => planFanOut([role("a")], 0)).toThrow(POSITIVE_INTEGER);
  });

  it("never claims more concurrency than there are roles", () => {
    const plan = planFanOut([role("a"), role("b")], 8);
    expect(plan.effectiveConcurrency).toBe(2);
    expect(plan.waveCount).toBe(1);
  });

  it("reports the wave count when concurrency is below the role count", () => {
    const plan = planFanOut([role("a"), role("b"), role("c")], 2);
    expect(plan.effectiveConcurrency).toBe(2);
    expect(plan.waveCount).toBe(2);
  });
});

describe("decideOverflow — open_deep_research's tell-the-model pattern", () => {
  it("stays silent when nothing overflowed", () => {
    expect(decideOverflow(3, 4)).toBeNull();
    expect(decideOverflow(4, 4)).toBeNull();
  });

  it("tells the model the dropped units were NOT run", () => {
    const notice = decideOverflow(8, 5);
    expect(notice?.message).toContain("3 were NOT run");
    expect(notice?.message).toContain("Do not treat the missing 3");
  });
});

describe("sanitizeLearnings", () => {
  it("drops a learning with no url — an uncitable claim renders as a sourced one", () => {
    expect(sanitizeLearnings([{ text: "x", url: "  ", roleId: "a" }])).toEqual(
      []
    );
  });

  it("drops empty text and dedupes on text+url", () => {
    const kept = sanitizeLearnings([
      learning("same"),
      learning("same"),
      { text: "  ", url: "https://x.test", roleId: "a" },
    ]);
    expect(kept).toHaveLength(1);
  });

  it("keeps the same text from two different urls", () => {
    const kept = sanitizeLearnings([
      learning("same", "https://a.test"),
      learning("same", "https://b.test"),
    ]);
    expect(kept).toHaveLength(2);
  });
});

describe("summarizeFanOut", () => {
  it("separates roles that found something from roles that did not", () => {
    const summary = summarizeFanOut([
      result("demand", [learning("people complain about X")]),
      result("competitor"),
    ]);
    expect(summary.rolesWithFindings).toEqual(["demand"]);
    expect(summary.rolesWithoutFindings).toEqual(["competitor"]);
  });

  it("flags an empty run caused by failures, distinct from an empty run caused by the topic", () => {
    const blocked = summarizeFanOut([
      result(
        "demand",
        [],
        [{ kind: "source-blocked", subject: "reddit", detail: "403" }]
      ),
    ]);
    expect(blocked.emptyBecauseOfFailures).toBe(true);

    const quiet = summarizeFanOut([result("demand")]);
    expect(quiet.emptyBecauseOfFailures).toBe(false);
  });

  it("never hides a failure behind findings from another role", () => {
    const summary = summarizeFanOut([
      result("demand", [learning("found something")]),
      result(
        "competitor",
        [],
        [
          {
            kind: "source-blocked",
            subject: "web",
            detail: "403 from datacenter",
          },
        ]
      ),
    ]);
    expect(summary.failures).toHaveLength(1);
    expect(summary.emptyBecauseOfFailures).toBe(false);
  });
});

describe("runFanOut — the replacement for the sequential supervisor queue", () => {
  /**
   * THE REGRESSION TEST FOR THE BUG THIS FILE EXISTS TO FIX.
   * `supervisor-agent.ts` chains every researcher onto one promise, so its peak
   * concurrency is 1 no matter what `max_concurrent_research_units` says. This
   * asserts the config value is a real bound, in both directions.
   */
  it("actually runs researchers in parallel up to the configured bound", async () => {
    let live = 0;
    let observedPeak = 0;
    const gate: (() => void)[] = [];

    const outcome = runFanOut(
      {
        runResearcher: (r) => {
          live++;
          observedPeak = Math.max(observedPeak, live);
          return new Promise<ResearchResult>((resolve) => {
            gate.push(() => {
              live--;
              resolve(result(r.id, [learning(`from ${r.id}`)]));
            });
          });
        },
      },
      {
        brief: "does anyone want this",
        roles: FOUR_ROLES,
        maxConcurrent: 4,
      }
    );

    // Let all four start before releasing any of them. A sequential queue
    // would have exactly one waiting here.
    await vi.waitFor(() => expect(gate).toHaveLength(4));
    expect(observedPeak).toBe(4);
    for (const release of gate) {
      release();
    }

    const settled = await outcome;
    expect(settled.peakConcurrency).toBe(4);
    expect(settled.plan.waveCount).toBe(1);
    expect(settled.summary.learnings).toHaveLength(4);
  });

  it("honours a lower bound instead of ignoring it", async () => {
    const gate: (() => void)[] = [];
    const outcome = runFanOut(
      {
        runResearcher: (r) =>
          new Promise<ResearchResult>((resolve) => {
            gate.push(() => resolve(result(r.id)));
          }),
      },
      {
        brief: "b",
        roles: FOUR_ROLES,
        maxConcurrent: 2,
      }
    );

    // Only two may start. A supervisor that ignored the bound would have all
    // four queued here; the sequential queue it replaces would have one.
    await vi.waitFor(() => expect(gate).toHaveLength(2));

    // Drain: releasing a slot admits the next role, which enqueues another gate.
    for (let released = 0; released < 4; released++) {
      await vi.waitFor(() => expect(gate.length).toBeGreaterThan(0));
      gate.shift()?.();
    }

    const settled = await outcome;
    expect(settled.peakConcurrency).toBeLessThanOrEqual(2);
    expect(settled.plan.waveCount).toBe(2);
  });

  it("turns a thrown researcher into a named failure instead of losing the other three", async () => {
    const settled = await runFanOut(
      {
        runResearcher: (r) => {
          if (r.id === "demand") {
            return Promise.reject(new Error("gateway exploded"));
          }
          return Promise.resolve(result(r.id, [learning(`from ${r.id}`)]));
        },
      },
      {
        brief: "b",
        roles: FOUR_ROLES,
        maxConcurrent: 4,
      }
    );

    expect(settled.summary.failures).toHaveLength(1);
    expect(settled.summary.failures[0]).toMatchObject({
      kind: "model-call-failed",
      subject: "demand",
    });
    expect(settled.summary.failures[0].detail).toContain("gateway exploded");
    expect(settled.summary.learnings).toHaveLength(3);
  });

  it("records an aborted run as aborted rather than as an empty result", async () => {
    const controller = new AbortController();
    controller.abort();

    const settled = await runFanOut(
      { runResearcher: (r) => Promise.resolve(result(r.id)) },
      {
        brief: "b",
        roles: FOUR_ROLES,
        maxConcurrent: 4,
        abortSignal: controller.signal,
      }
    );

    expect(settled.summary.failures).toHaveLength(4);
    expect(settled.summary.failures.every((f) => f.kind === "aborted")).toBe(
      true
    );
    expect(settled.summary.emptyBecauseOfFailures).toBe(true);
  });

  it("releases the semaphore even when a researcher throws", async () => {
    const settled = await runFanOut(
      {
        runResearcher: () => Promise.reject(new Error("always fails")),
      },
      {
        brief: "b",
        roles: FOUR_ROLES,
        maxConcurrent: 1,
      }
    );
    // Four results, not a hang: the `finally` released each slot.
    expect(settled.results).toHaveLength(4);
  });
});
