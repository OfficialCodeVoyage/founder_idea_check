import { describe, expect, it, vi } from "vitest";
import type { StreamWriter } from "@/lib/ai/types";

/**
 * The sidecar arm of deep research.
 *
 * The point of these tests is the two states that used to be indistinguishable:
 * a deployment with no cloud key now gets a REAL tool rather than `{}`, and a
 * harvest that found nothing because every source was blocked reports that as
 * an error rather than as an absence of demand.
 */

vi.mock("@/lib/config", () => ({
  config: {
    ai: {
      tools: {
        deepResearch: {
          hosted: false,
          // Inline, not a const: vi.mock factories are hoisted above it.
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

// No TAVILY_API_KEY and no FIRECRAWL_API_KEY: the exact shape of this project's
// deployment, and the one that used to produce an empty ToolSet.
vi.mock("@/lib/env", () => ({
  env: {},
}));

import { getDeepResearchConfig } from "./configuration";
import { sidecarWebSearch } from "./sidecar-search";
import { getAllTools } from "./utils";

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

function signalBody(sourceId: string, signals: unknown[]) {
  return { ok: true, source_id: sourceId, signals };
}

function signal(overrides: Record<string, unknown> = {}) {
  return {
    id: "s1",
    title: "Founders keep rebuilding this by hand",
    url: "https://news.ycombinator.com/item?id=1",
    snippet: "Every founder I know has a spreadsheet for this.",
    published_at: "2026-08-01",
    engagement: 42,
    relevance: 0.9,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Answers whichever source id the URL names, so the fan-out stays honest. */
function fetchReturning(
  perSource: Record<string, unknown>,
  seen?: string[]
): typeof fetch {
  return ((url: string) => {
    const sourceId = String(url).split("/").pop() ?? "";
    seen?.push(sourceId);
    const body = perSource[sourceId];
    if (body === undefined) {
      return Promise.resolve(
        jsonResponse({
          ok: false,
          source_id: sourceId,
          kind: "disabled",
          detail: `no stub for ${sourceId}`,
        })
      );
    }
    return Promise.resolve(jsonResponse(body));
  }) as unknown as typeof fetch;
}

async function runTool(
  tool: ReturnType<typeof sidecarWebSearch>,
  queries: { query: string; maxResults: number | null }[]
) {
  const execute = tool.execute as unknown as (
    input: unknown,
    ctx: { toolCallId: string }
  ) => Promise<{
    searches: { results: { url: string; title: string; content: string }[] }[];
    error?: string;
  }>;
  return await execute({ search_queries: queries }, { toolCallId: "call-1" });
}

describe("getSearchApi via getDeepResearchConfig", () => {
  it("selects the sidecar when it is configured and no cloud key is set", () => {
    // Previously "none" — which is what made the whole feature unreachable.
    expect(getDeepResearchConfig().search_api).toBe("sidecar");
  });
});

describe("getAllTools", () => {
  it("returns a non-empty ToolSet for a keyless sidecar deployment", async () => {
    const { stream } = recordingStream();
    const tools = await getAllTools(getDeepResearchConfig(), stream);

    // The regression this guards: `{}` here is what makes runResearcher throw
    // "No tools found to conduct research".
    expect(Object.keys(tools)).toContain("webSearch");
    expect(Object.keys(tools).length).toBeGreaterThan(0);
  });
});

describe("sidecarWebSearch", () => {
  it("maps sidecar signals onto the search-result shape", async () => {
    const { stream } = recordingStream();
    const tool = sidecarWebSearch({
      dataStream: stream,
      writeTopLevelUpdates: false,
      fetchImpl: fetchReturning({
        hackernews: signalBody("hackernews", [signal()]),
        "web-keyless": signalBody("web-keyless", [
          signal({
            id: "s2",
            url: "https://example.com/post",
            title: "A post",
            snippet: "Body text.",
          }),
        ]),
      }),
    });

    const result = await runTool(tool, [
      { query: "spreadsheets", maxResults: 5 },
    ]);

    expect(result.error).toBeUndefined();
    const results = result.searches.flatMap((s) => s.results);
    expect(results).toContainEqual({
      url: "https://news.ycombinator.com/item?id=1",
      title: "Founders keep rebuilding this by hand",
      content: "Every founder I know has a spreadsheet for this.",
    });
    expect(results).toHaveLength(2);
  });

  it("lists one url ONCE even when two sources return it", async () => {
    // The sidecar does not guarantee unique urls: app/pipeline/dedupe.py drops
    // near-duplicates by TEXT similarity at 0.7, not by url, and keeps any item
    // whose text is empty without comparing it at all. Verified by running that
    // function directly — a shared url survives both when the text is empty and
    // when the wording differs.
    //
    // Two consequences, and the second is why this test exists rather than just
    // a key fix: React's `key={result.url}` collides, AND the same permalink
    // listed twice reads to a founder as two pieces of evidence. One permalink
    // is one citation however many harvests returned it.
    const { stream } = recordingStream();
    const duplicated = {
      id: "dup",
      url: "https://example.com/same",
      title: "The same page",
      snippet: "Same page, found twice.",
    };
    const tool = sidecarWebSearch({
      dataStream: stream,
      writeTopLevelUpdates: false,
      fetchImpl: fetchReturning({
        hackernews: signalBody("hackernews", [signal(duplicated)]),
        "web-keyless": signalBody("web-keyless", [
          signal({ ...duplicated, id: "dup-2" }),
        ]),
      }),
    });

    const result = await runTool(tool, [{ query: "same", maxResults: 5 }]);

    const results = result.searches.flatMap((s) => s.results);
    const urls = results.map((r) => r.url);
    expect(urls).toEqual(["https://example.com/same"]);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("only asks the two operator-enabled sources", async () => {
    const seen: string[] = [];
    const { stream } = recordingStream();
    const tool = sidecarWebSearch({
      dataStream: stream,
      writeTopLevelUpdates: false,
      fetchImpl: fetchReturning(
        {
          hackernews: signalBody("hackernews", [signal()]),
          "web-keyless": signalBody("web-keyless", []),
        },
        seen
      ),
    });

    await runTool(tool, [{ query: "anything", maxResults: 3 }]);

    // Reddit and GitHub are gate-refused before any request is made; a fetch
    // to either would mean the gate had stopped gating.
    expect(seen.sort()).toEqual(["hackernews", "web-keyless"]);
  });

  it("streams one running update and one completed update on the same id", async () => {
    const { stream, written } = recordingStream();
    const tool = sidecarWebSearch({
      dataStream: stream,
      writeTopLevelUpdates: false,
      fetchImpl: fetchReturning({
        hackernews: signalBody("hackernews", [signal()]),
        "web-keyless": signalBody("web-keyless", []),
      }),
    });

    await runTool(tool, [{ query: "spreadsheets", maxResults: 5 }]);

    const webUpdates = written.filter((w) => w.data.type === "web");
    expect(webUpdates).toHaveLength(2);
    expect(webUpdates[0].data.status).toBe("running");
    expect(webUpdates[1].data.status).toBe("completed");
    // Same update id, so the UI rewrites one row rather than appending two.
    expect(webUpdates[0].id).toBe(webUpdates[1].id);
  });

  it("FAILS CLOSED: a fully blocked harvest is an error, not an empty result", async () => {
    const { stream } = recordingStream();
    const tool = sidecarWebSearch({
      dataStream: stream,
      writeTopLevelUpdates: false,
      fetchImpl: fetchReturning({
        hackernews: {
          ok: false,
          source_id: "hackernews",
          kind: "blocked",
          detail: "403 from a datacenter IP",
        },
        "web-keyless": {
          ok: false,
          source_id: "web-keyless",
          kind: "blocked",
          detail: "403 from a datacenter IP",
        },
      }),
    });

    const result = await runTool(tool, [{ query: "demand", maxResults: 5 }]);

    // "We could not look" must never reach the model as "nobody cares".
    expect(result.error).toBeDefined();
    expect(result.error).toContain("blocked");
    expect(result.error).toContain("403 from a datacenter IP");
    expect(result.searches).toHaveLength(0);
  });

  it("FAILS CLOSED: a genuinely empty harvest still reports rather than returning nothing", async () => {
    const { stream } = recordingStream();
    const tool = sidecarWebSearch({
      dataStream: stream,
      writeTopLevelUpdates: false,
      fetchImpl: fetchReturning({
        hackernews: signalBody("hackernews", []),
        "web-keyless": signalBody("web-keyless", []),
      }),
    });

    const result = await runTool(tool, [{ query: "demand", maxResults: 5 }]);

    expect(result.error).toBeDefined();
    expect(result.searches).toHaveLength(0);
  });

  it("keeps partial results when only one source fails", async () => {
    const { stream } = recordingStream();
    const tool = sidecarWebSearch({
      dataStream: stream,
      writeTopLevelUpdates: false,
      fetchImpl: fetchReturning({
        hackernews: signalBody("hackernews", [signal()]),
        "web-keyless": {
          ok: false,
          source_id: "web-keyless",
          kind: "blocked",
          detail: "403",
        },
      }),
    });

    const result = await runTool(tool, [{ query: "demand", maxResults: 5 }]);

    // One bad source must not take down a good one.
    expect(result.error).toBeUndefined();
    expect(result.searches.flatMap((s) => s.results)).toHaveLength(1);
  });

  it("refuses an empty query instead of letting the sidecar 422 it", async () => {
    // The sidecar answers HTTP 422 for query:"", which classifySidecarStatus
    // maps to schema-drift — "the contracts diverged, redeploy". That is the
    // wrong story to tell an operator about a malformed tool call.
    let called = false;
    const { stream } = recordingStream();
    const tool = sidecarWebSearch({
      dataStream: stream,
      writeTopLevelUpdates: false,
      fetchImpl: (() => {
        called = true;
        return Promise.resolve(jsonResponse(signalBody("hackernews", [])));
      }) as unknown as typeof fetch,
    });

    const result = await runTool(tool, [{ query: "   ", maxResults: 5 }]);

    expect(called).toBe(false);
    expect(result.error).toContain("malformed tool call");
    expect(result.searches).toHaveLength(0);
  });

  it("still searches the non-empty queries when one is blank", async () => {
    const seen: string[] = [];
    const { stream } = recordingStream();
    const tool = sidecarWebSearch({
      dataStream: stream,
      writeTopLevelUpdates: false,
      fetchImpl: fetchReturning(
        {
          hackernews: signalBody("hackernews", [signal()]),
          "web-keyless": signalBody("web-keyless", []),
        },
        seen
      ),
    });

    const result = await runTool(tool, [
      { query: "", maxResults: 5 },
      { query: "real query", maxResults: 5 },
    ]);

    expect(result.error).toBeUndefined();
    expect(result.searches).toHaveLength(1);
    expect(result.searches[0].results).toHaveLength(1);
  });

  it("sends the configured lookback window to the sidecar", async () => {
    const bodies: Record<string, unknown>[] = [];
    const { stream } = recordingStream();
    const fetchImpl = ((_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(
        jsonResponse(
          signalBody(String(_url).split("/").pop() ?? "", [signal()])
        )
      );
    }) as unknown as typeof fetch;

    const tool = sidecarWebSearch({
      dataStream: stream,
      writeTopLevelUpdates: false,
      fetchImpl,
      now: () => new Date("2026-08-20T12:00:00Z"),
    });

    await runTool(tool, [{ query: "demand", maxResults: 5 }]);

    // The sidecar has no default for these; an omitted window is a 422.
    expect(bodies[0].date_to).toBe("2026-08-20");
    expect(bodies[0].date_from).toBe("2025-08-20");
    expect(bodies[0].limit).toBe(5);
  });
});
