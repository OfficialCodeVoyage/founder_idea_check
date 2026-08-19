import { describe, expect, it } from "vitest";
import { projectQueryCount } from "./budget";
import {
  buildLearningPrompt,
  buildQueryPlanPrompt,
  descendShape,
  type LoopDeps,
  MAX_CONTENT_CHARS,
  mergeResults,
  runResearchLoop,
  sanitizeQueries,
  trimContent,
} from "./loop";
import { DEMAND_RESEARCHER } from "./roles";
import type { ResearchLearning, ResearchShape } from "./types";

/** Runs every task at once — the loop's own concurrency is injected. */
const runAll: LoopDeps["runConcurrent"] = (tasks) =>
  Promise.all(tasks.map((t) => t()));

function stubDeps(overrides: Partial<LoopDeps> = {}): LoopDeps {
  return {
    planQueries: () =>
      Promise.resolve({
        queries: [{ query: "q1", researchGoal: "g1" }],
      }),
    search: () =>
      Promise.resolve({
        ok: true as const,
        hits: [{ url: "https://a.test/1", title: "t", text: "body" }],
      }),
    extractLearnings: () =>
      Promise.resolve({
        learnings: [{ text: "a finding", url: "https://a.test/1" }],
        followUpQuestions: ["and then?"],
      }),
    runConcurrent: runAll,
    ...overrides,
  };
}

describe("descendShape — must agree with budget.ts or the projection is a guess", () => {
  it("halves breadth and decrements depth", () => {
    expect(descendShape({ breadth: 4, depth: 3 })).toEqual({
      breadth: 2,
      depth: 2,
    });
  });

  it("walks the same number of queries the budget projected", async () => {
    const shape: ResearchShape = { breadth: 3, depth: 2 };
    let searches = 0;

    await runResearchLoop(
      stubDeps({
        planQueries: () =>
          Promise.resolve({
            queries: Array.from({ length: 4 }, (_, i) => ({
              query: `q${i}`,
              researchGoal: "g",
            })),
          }),
        search: () => {
          searches++;
          return Promise.resolve({ ok: true as const, hits: [] });
        },
      }),
      { role: DEMAND_RESEARCHER, brief: "b", shape }
    );

    // Depth-2 children only run when the parent got hits, and here every search
    // returns none, so the top level is all that runs: exactly `breadth`.
    expect(searches).toBe(shape.breadth);
    expect(projectQueryCount(shape)).toBeGreaterThan(searches);
  });

  it("runs the full projected tree when every level returns hits", async () => {
    const shape: ResearchShape = { breadth: 2, depth: 2 };
    let searches = 0;

    await runResearchLoop(
      stubDeps({
        planQueries: () =>
          Promise.resolve({
            queries: [
              { query: "a", researchGoal: "g" },
              { query: "b", researchGoal: "g" },
            ],
          }),
        search: () => {
          searches++;
          return Promise.resolve({
            ok: true as const,
            hits: [{ url: "https://a.test/x", title: "t", text: "body" }],
          });
        },
      }),
      { role: DEMAND_RESEARCHER, brief: "b", shape }
    );

    // 2 top-level + 2 x 1 child (breadth halves to 1) = 4, which is what
    // projectQueryCount says.
    expect(searches).toBe(projectQueryCount(shape));
  });
});

describe("trimContent", () => {
  it("leaves short content alone", () => {
    expect(trimContent("short")).toBe("short");
  });

  it("truncates and SAYS it truncated, rather than silently dropping text", () => {
    const trimmed = trimContent("x".repeat(MAX_CONTENT_CHARS + 100));
    expect(trimmed).toContain("[truncated at 25000 characters]");
  });
});

describe("sanitizeQueries", () => {
  it("drops empties and near-duplicates that would buy the same page twice", () => {
    const kept = sanitizeQueries(
      [
        { query: "  ", researchGoal: "g" },
        { query: "dog walkers", researchGoal: "g" },
        { query: "Dog Walkers", researchGoal: "g" },
      ],
      5
    );
    expect(kept).toHaveLength(1);
  });

  it("caps at the requested breadth", () => {
    const kept = sanitizeQueries(
      Array.from({ length: 10 }, (_, i) => ({
        query: `q${i}`,
        researchGoal: "g",
      })),
      3
    );
    expect(kept).toHaveLength(3);
  });
});

describe("buildQueryPlanPrompt", () => {
  it("carries the role's system prompt through untouched", () => {
    const request = buildQueryPlanPrompt({
      role: DEMAND_RESEARCHER,
      brief: "an app for dog owners",
      breadth: 3,
      priorLearnings: [],
    });
    expect(request.system).toBe(DEMAND_RESEARCHER.systemPrompt);
    expect(request.prompt).toContain("an app for dog owners");
    expect(request.maxQueries).toBe(3);
  });

  it("omits the findings block entirely when there are none", () => {
    const request = buildQueryPlanPrompt({
      role: DEMAND_RESEARCHER,
      brief: "b",
      breadth: 3,
      priorLearnings: [],
    });
    expect(request.prompt).not.toContain("Findings so far");
  });

  it("feeds prior findings back in so depth 2 asks what depth 1 could not", () => {
    const prior: ResearchLearning[] = [
      {
        text: "dog walkers use group chats",
        url: "https://x.test",
        roleId: "demand",
      },
    ];
    const request = buildQueryPlanPrompt({
      role: DEMAND_RESEARCHER,
      brief: "b",
      breadth: 2,
      priorLearnings: prior,
    });
    expect(request.prompt).toContain("dog walkers use group chats");
  });
});

describe("buildLearningPrompt", () => {
  it("attaches each content's url so a finding can be attributed", () => {
    const request = buildLearningPrompt({
      role: DEMAND_RESEARCHER,
      query: "q",
      contents: [{ url: "https://a.test/1", text: "body" }],
      maxLearnings: 3,
      maxFollowUps: 2,
    });
    expect(request.prompt).toContain('<content url="https://a.test/1">');
    expect(request.prompt).toContain("A finding you cannot attribute");
  });
});

describe("mergeResults", () => {
  it("dedupes urls and drops uncitable findings", () => {
    const merged = mergeResults("demand", [
      {
        learnings: [{ text: "a", url: "https://x.test", roleId: "demand" }],
        visitedUrls: ["https://x.test", "https://x.test"],
        failures: [],
      },
      {
        learnings: [{ text: "b", url: "", roleId: "demand" }],
        visitedUrls: [""],
        failures: [],
      },
    ]);
    expect(merged.learnings).toHaveLength(1);
    expect(merged.visitedUrls).toEqual(["https://x.test"]);
  });
});

describe("runResearchLoop — the divergence from upstream's silent catch", () => {
  it("returns findings on the happy path", async () => {
    const result = await runResearchLoop(stubDeps(), {
      role: DEMAND_RESEARCHER,
      brief: "b",
      shape: { breadth: 1, depth: 1 },
    });
    expect(result.learnings).toHaveLength(1);
    expect(result.failures).toEqual([]);
  });

  it("SURFACES a 403 as source-blocked instead of returning an empty result", async () => {
    const result = await runResearchLoop(
      stubDeps({
        search: () =>
          Promise.resolve({
            ok: false as const,
            failure: {
              kind: "source-blocked" as const,
              detail: "HTTP 403 from a datacenter egress range",
            },
          }),
      }),
      { role: DEMAND_RESEARCHER, brief: "b", shape: { breadth: 1, depth: 1 } }
    );

    expect(result.learnings).toEqual([]);
    expect(result.failures).toEqual([
      {
        kind: "source-blocked",
        subject: "q1",
        detail: "HTTP 403 from a datacenter egress range",
      },
    ]);
  });

  it("distinguishes a genuinely empty search from a blocked one", async () => {
    const result = await runResearchLoop(
      stubDeps({
        search: () => Promise.resolve({ ok: true as const, hits: [] }),
      }),
      { role: DEMAND_RESEARCHER, brief: "b", shape: { breadth: 1, depth: 1 } }
    );
    expect(result.learnings).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it("records a planner failure rather than searching nothing quietly", async () => {
    const result = await runResearchLoop(
      stubDeps({ planQueries: () => Promise.reject(new Error("429")) }),
      { role: DEMAND_RESEARCHER, brief: "b", shape: { breadth: 2, depth: 1 } }
    );
    expect(result.failures[0]).toMatchObject({ kind: "model-call-failed" });
    expect(result.failures[0].detail).toContain("429");
  });

  it("records a planner schema mismatch", async () => {
    const result = await runResearchLoop(
      stubDeps({ planQueries: () => Promise.resolve({ nonsense: true }) }),
      { role: DEMAND_RESEARCHER, brief: "b", shape: { breadth: 2, depth: 1 } }
    );
    expect(result.failures[0]).toMatchObject({ kind: "model-schema-mismatch" });
  });

  it("treats zero usable queries as a failure, not as a completed branch", async () => {
    const result = await runResearchLoop(
      stubDeps({ planQueries: () => Promise.resolve({ queries: [] }) }),
      { role: DEMAND_RESEARCHER, brief: "b", shape: { breadth: 2, depth: 1 } }
    );
    expect(result.failures[0].detail).toContain("zero usable queries");
  });

  it("drops an unattributed finding the model returned anyway", async () => {
    const result = await runResearchLoop(
      stubDeps({
        extractLearnings: () =>
          Promise.resolve({
            learnings: [
              { text: "attributed", url: "https://a.test/1" },
              { text: "made up", url: "" },
            ],
            followUpQuestions: [],
          }),
      }),
      { role: DEMAND_RESEARCHER, brief: "b", shape: { breadth: 1, depth: 1 } }
    );
    expect(result.learnings.map((l) => l.text)).toEqual(["attributed"]);
  });

  it("keeps the visited urls even when extraction fails, so the run is auditable", async () => {
    const result = await runResearchLoop(
      stubDeps({ extractLearnings: () => Promise.reject(new Error("boom")) }),
      { role: DEMAND_RESEARCHER, brief: "b", shape: { breadth: 1, depth: 1 } }
    );
    expect(result.visitedUrls).toEqual(["https://a.test/1"]);
    expect(result.failures[0]).toMatchObject({
      kind: "model-call-failed",
      subject: "q1",
    });
  });

  it("stops immediately when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runResearchLoop(stubDeps(), {
      role: DEMAND_RESEARCHER,
      brief: "b",
      shape: { breadth: 1, depth: 1 },
      abortSignal: controller.signal,
    });
    expect(result.failures[0].kind).toBe("aborted");
  });

  it("never rejects, whatever the seams do", async () => {
    await expect(
      runResearchLoop(
        {
          planQueries: () => Promise.reject(new Error("a")),
          search: () => Promise.reject(new Error("b")),
          extractLearnings: () => Promise.reject(new Error("c")),
          runConcurrent: runAll,
        },
        { role: DEMAND_RESEARCHER, brief: "b", shape: { breadth: 2, depth: 2 } }
      )
    ).resolves.toBeDefined();
  });

  it("tags every finding with the role that found it", async () => {
    const result = await runResearchLoop(stubDeps(), {
      role: DEMAND_RESEARCHER,
      brief: "b",
      shape: { breadth: 1, depth: 1 },
    });
    expect(result.learnings[0].roleId).toBe("demand");
    expect(result.roleId).toBe("demand");
  });
});
