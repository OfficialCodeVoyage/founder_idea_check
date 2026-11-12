import { describe, expect, it } from "vitest";
import type {
  LaneReport,
  ResearchUpdate,
} from "@/tools/platform/research-updates-schema";
import {
  describeResearchRun,
  mergeLaneReports,
  researchRunLine,
} from "./research-run-summary";

/**
 * THE SIXTH INSTANCE OF "A ZERO STANDING IN FOR AN UNKNOWN".
 *
 * On 2026-08-21 a founder asked for a source-cited study and got, twice over,
 * "Researched for 0 seconds, 0 searches, 0 sources" above an error. Every one of
 * those zeros was false: `deepResearch` was called with an empty message list,
 * the pipeline threw before `runSupervisor`, and no search was ever attempted.
 * The row read as a completed search that found nothing.
 *
 * These tests lock the distinction the union now carries: never-searched has no
 * counts at all, and searched-and-found-nothing does.
 */

const CALL = "call-1";

/** Top-level so biome's useTopLevelRegex stays happy. */
const ANY_DIGIT = /\d/;
const TWO_SEARCHES_LINE = /^Researched for 2 seconds, 2 searches, \d+ sources$/;

function web(results: number, status: "running" | "completed"): ResearchUpdate {
  return {
    type: "web",
    toolCallId: CALL,
    title: "Executing 1 searches",
    status,
    queries: ["demand"],
    results: Array.from({ length: results }, (_, i) => ({
      url: `https://example.com/${i}`,
      title: `Result ${i}`,
      content: "…",
      source: "web" as const,
    })),
  };
}

function marker(
  type: "started" | "completed",
  timestamp: number
): ResearchUpdate {
  return { type, toolCallId: CALL, title: type, timestamp };
}

describe("describeResearchRun", () => {
  it("reports NEVER SEARCHED — with no counts — when no search was attempted", () => {
    // The exact shape of the live incident: writing/thoughts updates and a
    // terminal `completed` written by the catch handler, and no `web` update.
    const view = describeResearchRun([
      {
        type: "writing",
        toolCallId: CALL,
        title: "Writing research brief",
        status: "running",
      },
      marker("completed", 1_700_000_000_000),
    ]);

    expect(view.searched).toBe(false);
    // The whole point: there is nothing on this arm to render as a zero.
    expect(view).not.toHaveProperty("searches");
    expect(view).not.toHaveProperty("sources");
    expect(view).not.toHaveProperty("elapsed");
    if (view.searched === false) {
      expect(view.note.length).toBeGreaterThan(0);
    }
  });

  it("reports NEVER SEARCHED for a run with no updates at all", () => {
    expect(describeResearchRun([]).searched).toBe(false);
  });

  it("keeps a real zero: a search that ran and found nothing still counts", () => {
    // NOT the same bug. An adapter that searched and found nothing is a
    // legitimate finding the phase gate acts on — see apps/research/README.md.
    const view = describeResearchRun([
      marker("started", 1000),
      web(0, "completed"),
      marker("completed", 4000),
    ]);

    expect(view.searched).toBe(true);
    if (view.searched) {
      expect(view.searches).toBe(1);
      expect(view.sources).toBe(0);
      expect(view.elapsed).toEqual({ known: true, seconds: 3 });
    }
  });

  it("counts searches and sources when both are present", () => {
    const view = describeResearchRun([
      marker("started", 0),
      web(2, "completed"),
      web(3, "completed"),
      marker("completed", 12_500),
    ]);

    expect(view.searched).toBe(true);
    if (view.searched) {
      expect(view.searches).toBe(2);
      expect(view.sources).toBe(5);
      expect(view.elapsed).toEqual({ known: true, seconds: 12 });
    }
  });

  it("admits an UNKNOWN elapsed time rather than reporting 0 seconds", () => {
    // The old arithmetic read `progressUpdates[0].timestamp` — which, when the
    // only marker present was the terminal one, meant `completed - completed`,
    // i.e. a confident 0. A run with no `started` marker has no duration, and
    // saying so is the honest answer.
    const view = describeResearchRun([
      web(1, "completed"),
      marker("completed", 9000),
    ]);

    expect(view.searched).toBe(true);
    if (view.searched) {
      expect(view.elapsed).toEqual({ known: false });
      expect(view.searches).toBe(1);
    }
  });

  it("does not invent a duration from a started marker with no completion", () => {
    const view = describeResearchRun([
      marker("started", 1000),
      web(1, "running"),
    ]);

    expect(view.searched).toBe(true);
    if (view.searched) {
      expect(view.elapsed).toEqual({ known: false });
    }
  });
});

describe("describeResearchRun with refused steps", () => {
  function skipped(): ResearchUpdate {
    return {
      type: "web",
      toolCallId: CALL,
      title: "Skipped 1 search: search time ran out",
      status: "skipped",
      queries: ["demand"],
    };
  }

  it("does not count a step that was refused before any request as a search", () => {
    // REGRESSION. The refused step used to be a `completed` web update with no
    // results, so a run of 5 searches and 3 refusals printed "8 searches".
    const view = describeResearchRun([
      web(2, "completed"),
      web(1, "completed"),
      skipped(),
      skipped(),
      skipped(),
      marker("started", 0),
      marker("completed", 4000),
    ]);

    expect(view.searched).toBe(true);
    if (view.searched) {
      expect(view.searches).toBe(2);
      expect(view.sources).toBe(3);
    }
  });

  it("says nothing ran, with no count, when every step was refused", () => {
    const view = describeResearchRun([skipped(), skipped()]);

    expect(view.searched).toBe(false);
    const line = researchRunLine(view);
    expect(line).toContain("No search ran");
    expect(line).toContain("search time had run out");
    expect(line).not.toMatch(ANY_DIGIT);
  });
});

describe("researchRunLine", () => {
  it("says no search ran, and prints no number, for the not-searched arm", () => {
    const line = researchRunLine(describeResearchRun([]));

    expect(line).toContain("No search ran");
    // The regression, stated as an assertion: no digit may appear on this arm.
    expect(line).not.toMatch(ANY_DIGIT);
  });

  it("prints the duration when it is known", () => {
    const line = researchRunLine(
      describeResearchRun([
        { type: "started", toolCallId: "c", title: "started", timestamp: 0 },
        {
          type: "web",
          toolCallId: "c",
          title: "w",
          status: "completed",
          queries: ["q"],
          results: [
            {
              url: "https://example.com/a",
              title: "A",
              content: "…",
              source: "web",
            },
          ],
        },
        {
          type: "completed",
          toolCallId: "c",
          title: "completed",
          timestamp: 5000,
        },
      ])
    );

    expect(line).toBe("Researched for 5 seconds, 1 search, 1 source");
  });

  it("names the duration as unrecorded rather than printing 0 seconds", () => {
    const line = researchRunLine(
      describeResearchRun([
        {
          type: "web",
          toolCallId: "c",
          title: "w",
          status: "completed",
          queries: ["q"],
          results: [],
        },
        {
          type: "completed",
          toolCallId: "c",
          title: "completed",
          timestamp: 5000,
        },
      ])
    );

    expect(line).not.toContain("0 seconds");
    expect(line).toContain("1 search,");
    expect(line).toContain("0 sources");
    expect(line).toContain("elapsed time not recorded");
  });

  it("spells every plural it prints as a word, never as an appended s", () => {
    // QA saw "5 searchs": the suffix rule was right for "sources" and
    // "seconds" and wrong for "search".
    const line = researchRunLine(
      describeResearchRun([
        marker("started", 0),
        web(2, "completed"),
        web(1, "completed"),
        marker("completed", 2000),
      ])
    );

    expect(line).toMatch(TWO_SEARCHES_LINE);
  });
});

describe("mergeLaneReports", () => {
  function lanesUpdate(lanes: LaneReport[]): ResearchUpdate {
    return { type: "lanes", toolCallId: "c", title: "Sources", lanes };
  }

  it("returns nothing when the run streamed no lane report", () => {
    // An older transcript, or a run that died before the search tool. Rendering
    // "not attempted" rows we were never told about would be an invention.
    expect(mergeLaneReports([])).toEqual([]);
  });

  it("sums what a lane returned across two search steps", () => {
    const merged = mergeLaneReports([
      lanesUpdate([
        {
          sourceId: "hackernews",
          label: "Hacker News",
          outcome: { kind: "returned", signals: 2 },
        },
      ]),
      lanesUpdate([
        {
          sourceId: "hackernews",
          label: "Hacker News",
          outcome: { kind: "returned", signals: 3 },
        },
      ]),
    ]);

    expect(merged).toEqual([
      {
        sourceId: "hackernews",
        label: "Hacker News",
        outcome: { kind: "returned", signals: 5 },
      },
    ]);
  });

  it("lets a lane that answered once outrank a step where it refused", () => {
    const merged = mergeLaneReports([
      lanesUpdate([
        {
          sourceId: "hackernews",
          label: "Hacker News",
          outcome: {
            kind: "refused",
            failureKind: "rate-limited",
            detail: "429",
          },
        },
      ]),
      lanesUpdate([
        {
          sourceId: "hackernews",
          label: "Hacker News",
          outcome: { kind: "returned", signals: 1 },
        },
      ]),
    ]);

    expect(merged[0].outcome).toEqual({ kind: "returned", signals: 1 });
  });

  it("keeps a refusal, verbatim, over a not-attempted step", () => {
    const detail =
      "GitHub is enabled but GITHUB_TOKEN is not set. It will not fall back to a keyless path.";
    const merged = mergeLaneReports([
      lanesUpdate([
        {
          sourceId: "github",
          label: "GitHub",
          outcome: { kind: "not-attempted" },
        },
      ]),
      lanesUpdate([
        {
          sourceId: "github",
          label: "GitHub",
          outcome: {
            kind: "refused",
            failureKind: "missing-credential",
            detail,
          },
        },
      ]),
    ]);

    expect(merged[0].outcome).toEqual({
      kind: "refused",
      failureKind: "missing-credential",
      detail,
    });
  });

  it("keeps found-nothing distinct from refused and from not-attempted", () => {
    const merged = mergeLaneReports([
      lanesUpdate([
        {
          sourceId: "web-keyless",
          label: "Keyless web search",
          outcome: { kind: "not-attempted" },
        },
      ]),
      lanesUpdate([
        {
          sourceId: "web-keyless",
          label: "Keyless web search",
          outcome: { kind: "found-nothing" },
        },
      ]),
    ]);

    expect(merged[0].outcome).toEqual({ kind: "found-nothing" });
  });

  it("preserves the order the lanes were first reported in", () => {
    const merged = mergeLaneReports([
      lanesUpdate([
        {
          sourceId: "hackernews",
          label: "Hacker News",
          outcome: { kind: "found-nothing" },
        },
        {
          sourceId: "github",
          label: "GitHub",
          outcome: { kind: "not-attempted" },
        },
      ]),
    ]);

    expect(merged.map((lane) => lane.sourceId)).toEqual([
      "hackernews",
      "github",
    ]);
  });
});
