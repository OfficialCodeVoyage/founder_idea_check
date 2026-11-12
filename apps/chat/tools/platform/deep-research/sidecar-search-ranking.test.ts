import { describe, expect, it, vi } from "vitest";
import type { StreamWriter } from "@/lib/ai/types";

/**
 * WHY A CONSUMER BUYER'S REPORT MUST NOT LEAD WITH HACKER NEWS, AS A TEST.
 *
 * Two things had to be true for a report for, say, parents of young children to
 * come back citing Hacker News first, and both are asserted here against the
 * WIRED tool rather than against the pure ranking functions
 * (lib/signals/audience.test.ts covers those):
 *
 * 1. The Arctic Shift lane was enabled, correct and reachable, and refused
 *    EVERY request, because `sidecarWebSearch` never sent `options` and that
 *    adapter will not search Reddit without subreddits.
 * 2. Nothing ranked the lanes against the buyer, so Hacker News led because it
 *    is written first in `ALL_PROVIDERS`.
 *
 * This file runs with a self-host deployment that has the Reddit archive
 * switched on.
 */

vi.mock("@/lib/config", () => ({
  config: {
    ai: {
      tools: {
        deepResearch: {
          hosted: false,
          researchSidecarUrl: "http://sidecar.test:8099",
          researchModel: "test-model",
          summarizationModel: "test-model",
          compressionModel: "test-model",
          finalReportModel: "test-model",
          statusUpdateModel: "test-model",
          allowClarification: true,
          maxConcurrentResearchUnits: 2,
          maxSearchQueries: 2,
          maxResearcherIterations: 1,
          maxResearcherSteps: 6,
        },
      },
    },
  },
}));

vi.mock("@/lib/env", () => ({
  env: {
    RESEARCH_ENABLED_SOURCES: "hackernews,web-keyless,arctic-shift",
  },
}));

import type { LaneReport } from "../research-updates-schema";
import { sidecarWebSearch } from "./sidecar-search";

type Written = { type: string; id?: string; data: Record<string, unknown> };

function recordingStream(): { stream: StreamWriter; written: Written[] } {
  const written: Written[] = [];
  const stream = {
    write: (chunk: Written) => {
      written.push(chunk);
    },
  } as unknown as StreamWriter;
  return { stream, written };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function signal(overrides: Record<string, unknown>) {
  return {
    id: "s",
    title: "t",
    url: "https://example.test/x",
    snippet: "s",
    published_at: "2026-08-01",
    engagement: 10,
    relevance: 0.5,
    ...overrides,
  };
}

/** Records what each source was actually asked, then answers it. */
function recordingFetch(
  perSource: Record<string, unknown[]>,
  asked: Record<string, Record<string, unknown>>
): typeof fetch {
  return ((url: string, init: RequestInit) => {
    const sourceId = String(url).split("/").pop() ?? "";
    asked[sourceId] = JSON.parse(String(init.body));
    return Promise.resolve(
      jsonResponse({
        ok: true,
        source_id: sourceId,
        signals: perSource[sourceId] ?? [],
      })
    );
  }) as unknown as typeof fetch;
}

const PARENT_AUDIENCE = {
  known: true,
  audience: "non-technical",
  segment: "parents of 3-8 year olds who buy a bedtime-routine app",
  evidence: "parents",
} as const;

const DEVELOPER_AUDIENCE = {
  known: true,
  audience: "technical",
  segment: "backend engineers running Kubernetes",
  evidence: "engineers",
} as const;

function lanesFrom(written: Written[]): LaneReport[] {
  const update = written.find((w) => w.data?.type === "lanes");
  return (update?.data.lanes ?? []) as LaneReport[];
}

async function runTool(
  tool: ReturnType<typeof sidecarWebSearch>,
  query = "bedtime routine struggle"
) {
  const execute = tool.execute as unknown as (
    input: unknown,
    ctx: { toolCallId: string }
  ) => Promise<{
    searches: {
      results: { url: string; title: string }[];
      omittedByLaneLimit?: Record<string, number>;
      laneLimitNote?: string;
    }[];
    sourceRanking?: string;
    error?: string;
  }>;
  return await execute(
    { search_queries: [{ query, maxResults: 5 }] },
    { toolCallId: "call-1" }
  );
}

describe("sidecarWebSearch, ranked by the buyer", () => {
  it("sends the parenting subreddits to the Arctic Shift lane and to nobody else", async () => {
    const asked: Record<string, Record<string, unknown>> = {};
    const { stream } = recordingStream();
    const tool = sidecarWebSearch({
      dataStream: stream,
      writeTopLevelUpdates: false,
      audience: PARENT_AUDIENCE,
      fetchImpl: recordingFetch({}, asked),
    });

    await runTool(tool);

    expect(asked["arctic-shift"].options).toEqual({
      subreddits: ["Parenting", "daddit", "Mommit", "kindergarten"],
    });
    expect("options" in asked.hackernews).toBe(false);
    expect("options" in asked["web-keyless"]).toBe(false);
  });

  it("puts a Reddit result ahead of a more relevant Hacker News one", async () => {
    const asked: Record<string, Record<string, unknown>> = {};
    const { stream } = recordingStream();
    const tool = sidecarWebSearch({
      dataStream: stream,
      writeTopLevelUpdates: false,
      audience: PARENT_AUDIENCE,
      fetchImpl: recordingFetch(
        {
          hackernews: [
            signal({
              id: "hn",
              url: "https://news.ycombinator.com/item?id=1",
              relevance: 0.9,
            }),
          ],
          "arctic-shift": [
            signal({
              id: "r",
              url: "https://www.reddit.com/r/Parenting/comments/1/",
              relevance: 0.5,
            }),
          ],
        },
        asked
      ),
    });

    const result = await runTool(tool);
    const urls = result.searches.flatMap((s) => s.results).map((r) => r.url);

    expect(urls[0]).toContain("reddit.com");
    // AND HACKER NEWS IS STILL THERE. Deprioritised is not disabled.
    expect(urls).toContain("https://news.ycombinator.com/item?id=1");
  });

  it("orders the lane report so the founder can see the ranking", async () => {
    const asked: Record<string, Record<string, unknown>> = {};
    const { stream, written } = recordingStream();
    const tool = sidecarWebSearch({
      dataStream: stream,
      writeTopLevelUpdates: false,
      audience: PARENT_AUDIENCE,
      fetchImpl: recordingFetch({}, asked),
    });

    await runTool(tool);
    const lanes = lanesFrom(written);

    // EVERY lane, still. A weighting must never drop a source from the report.
    expect(lanes).toHaveLength(4);
    const ids = lanes.map((lane) => lane.sourceId);
    expect(ids.indexOf("arctic-shift")).toBeLessThan(
      ids.indexOf("web-keyless")
    );
    expect(ids.at(-1)).toBe("hackernews");
  });

  describe("the per-search limit on Hacker News for a buyer who is not a developer", () => {
    const FIVE_STORIES = Array.from({ length: 5 }, (_, index) =>
      signal({
        id: `hn-${index}`,
        url: `https://news.ycombinator.com/item?id=${index}`,
        relevance: 0.9 - index * 0.1,
      })
    );

    function webResultCount(written: Written[]): number {
      const completed = written.find(
        (w) => w.data?.type === "web" && w.data?.status === "completed"
      );
      return (completed?.data.results as unknown[]).length;
    }

    it("keeps the top 3, and tells the model, the founder and the count what it left out", async () => {
      const { stream, written } = recordingStream();
      const tool = sidecarWebSearch({
        dataStream: stream,
        writeTopLevelUpdates: false,
        audience: PARENT_AUDIENCE,
        fetchImpl: recordingFetch({ hackernews: FIVE_STORIES }, {}),
      });

      const result = await runTool(tool);
      const search = result.searches[0];

      // The three best stay; the two lowest-ranked are gone.
      expect(search.results.map((r) => r.url)).toEqual([
        "https://news.ycombinator.com/item?id=0",
        "https://news.ycombinator.com/item?id=1",
        "https://news.ycombinator.com/item?id=2",
      ]);
      // NOT SILENT, to the model: how many, of which lane, and why.
      expect(search.omittedByLaneLimit).toEqual({ "Hacker News": 2 });
      expect(search.laneLimitNote).toContain(
        "2 Hacker News results were left out"
      );
      expect(search.laneLimitNote).toContain("this buyer is not a developer");
      expect(search.laneLimitNote).toContain("not a finding");
      // NOT SILENT, to the founder: kept versus left out, in the lane report.
      const hackerNews = lanesFrom(written).find(
        (lane) => lane.sourceId === "hackernews"
      );
      expect(hackerNews?.outcome).toEqual({
        kind: "returned",
        signals: 3,
        leftOut: { count: 2, because: "this buyer is not a developer" },
      });
      // The run header and the Sources chip both count what was kept.
      expect(webResultCount(written)).toBe(3);
    });

    it("limits an unknown buyer to 5 and a developer buyer not at all", async () => {
      const eight = Array.from({ length: 8 }, (_, index) =>
        signal({
          id: `hn-${index}`,
          url: `https://news.ycombinator.com/item?id=${index}`,
          relevance: 0.9 - index * 0.05,
        })
      );

      const unknown = recordingStream();
      const unknownResult = await runTool(
        sidecarWebSearch({
          dataStream: unknown.stream,
          writeTopLevelUpdates: false,
          fetchImpl: recordingFetch({ hackernews: eight }, {}),
        })
      );
      expect(unknownResult.searches[0].results).toHaveLength(5);
      expect(unknownResult.searches[0].omittedByLaneLimit).toEqual({
        "Hacker News": 3,
      });
      expect(unknownResult.searches[0].laneLimitNote).toContain(
        "the buyer is not known"
      );

      const developer = recordingStream();
      const developerResult = await runTool(
        sidecarWebSearch({
          dataStream: developer.stream,
          writeTopLevelUpdates: false,
          audience: DEVELOPER_AUDIENCE,
          fetchImpl: recordingFetch({ hackernews: eight }, {}),
        })
      );
      expect(developerResult.searches[0].results).toHaveLength(8);
      expect(developerResult.searches[0].omittedByLaneLimit).toBeUndefined();
      expect(developerResult.searches[0].laneLimitNote).toBeUndefined();
      expect(
        lanesFrom(developer.written).find((l) => l.sourceId === "hackernews")
          ?.outcome
      ).toEqual({ kind: "returned", signals: 8 });
    });
  });

  it("reverses that for a developer buyer", async () => {
    const asked: Record<string, Record<string, unknown>> = {};
    const { stream, written } = recordingStream();
    const tool = sidecarWebSearch({
      dataStream: stream,
      writeTopLevelUpdates: false,
      audience: DEVELOPER_AUDIENCE,
      fetchImpl: recordingFetch(
        {
          hackernews: [
            signal({
              id: "hn",
              url: "https://news.ycombinator.com/item?id=1",
              relevance: 0.5,
            }),
          ],
          "arctic-shift": [
            signal({
              id: "r",
              url: "https://www.reddit.com/r/devops/comments/1/",
              relevance: 0.5,
            }),
          ],
        },
        asked
      ),
    });

    const result = await runTool(tool);
    expect(lanesFrom(written)[0].sourceId).toBe("hackernews");
    expect(result.searches.flatMap((s) => s.results)[0].url).toContain(
      "news.ycombinator.com"
    );
    expect(asked["arctic-shift"].options).toEqual({
      subreddits: ["devops", "webdev", "ExperiencedDevs", "programming"],
    });
  });

  it("asks Arctic Shift nothing extra when no buyer is known, so it refuses in its own words", async () => {
    const asked: Record<string, Record<string, unknown>> = {};
    const { stream, written } = recordingStream();
    const tool = sidecarWebSearch({
      dataStream: stream,
      writeTopLevelUpdates: false,
      // No audience at all — the state a project with no target_user is in.
      fetchImpl: recordingFetch({}, asked),
    });

    await runTool(tool);

    expect("options" in asked["arctic-shift"]).toBe(false);
    // Neutral means the general web leads, NOT Hacker News.
    expect(lanesFrom(written)[0].sourceId).toBe("web-keyless");
  });

  it("tells the researcher model why the sources are in this order", async () => {
    const asked: Record<string, Record<string, unknown>> = {};
    const { stream } = recordingStream();
    const tool = sidecarWebSearch({
      dataStream: stream,
      writeTopLevelUpdates: false,
      audience: PARENT_AUDIENCE,
      fetchImpl: recordingFetch(
        {
          "arctic-shift": [
            signal({ url: "https://www.reddit.com/r/Parenting/comments/1/" }),
          ],
        },
        asked
      ),
    });

    const result = await runTool(tool);
    expect(result.sourceRanking).toContain("Hacker News");
    expect(result.sourceRanking).toContain("r/Parenting");
  });
});
