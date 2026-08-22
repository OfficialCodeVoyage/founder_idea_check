import { tool } from "ai";
import { z } from "zod";
import type { StreamWriter } from "@/lib/ai/types";
import { config } from "@/lib/config";
import { createModuleLogger } from "@/lib/logger";
import { runSignalHarvest } from "@/lib/signals/provider";
import { ALL_PROVIDERS } from "@/lib/signals/providers";
import { createSidecarSignalFetcher } from "@/lib/signals/sidecar";
import type { DemandSignal, SignalFailure } from "@/lib/signals/types";
import { generateUUID } from "@/lib/utils";
import type { LaneReport } from "../research-updates-schema";
import { currentDeployment } from "./deployment-mode";
import { describeLanes } from "./lane-report";

/**
 * THE `apps/research` SIDECAR, EXPOSED AS A DEEP-RESEARCH SEARCH TOOL.
 *
 * `getSearchTool` in utils.ts previously offered Tavily and Firecrawl only, so
 * a deployment with neither key got `search_api: "none"`, an empty `ToolSet`,
 * and `runResearcher` throwing "No tools found to conduct research". This is
 * the keyless third arm: the sidecar already owns the adapters, the gating and
 * the scoring, and `lib/signals/` already owns the orchestration.
 *
 * NOTHING NEW IS IMPLEMENTED HERE. `runSignalHarvest` gates and fans out,
 * `createSidecarSignalFetcher` speaks the wire format, and `harvestSignals`
 * merges. This file is the adapter between that vocabulary (`DemandSignal`)
 * and the one deep-research streams (`{url,title,content,source}`).
 */

const log = createModuleLogger("tools/deep-research/sidecar-search");

const DEFAULT_MAX_RESULTS = 5;

/**
 * Matches `MAX_SEARCH_QUERIES` in ../web-search.ts. Kept identical so the
 * researcher's prompt behaves the same whichever arm is live — a tool that
 * silently accepts more queries than its siblings makes the search API a
 * variable the prompt has to know about.
 */
const MAX_SEARCH_QUERIES = 2;

/**
 * How far back a research query looks, in days.
 *
 * The sidecar requires an explicit window — `date_from`/`date_to` have no
 * defaults in `SignalRequest` — and it feeds `rerank.freshness_score`, so this
 * is a ranking input, not just a filter. A year is wide enough that a
 * still-true observation from ten months ago still ranks, and narrow enough
 * that a decade-old thread does not outrank this month's.
 */
const LOOKBACK_DAYS = 365;

const DAY_MS = 86_400_000;

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Names the ids that matched no descriptor, so a misspelled source reads as a
 * misspelling rather than as a quiet absence.
 */
function describeUnknownSourceIds(ids: readonly string[]): string {
  if (ids.length === 0) {
    return "";
  }
  return ` RESEARCH_ENABLED_SOURCES names ${ids.length === 1 ? "an id" : "ids"} that match no source: ${ids.join(", ")}.`;
}

function describeFailures(failures: readonly SignalFailure[]): string {
  if (failures.length === 0) {
    return "No source returned an error and no source returned a result.";
  }
  return failures
    .map(
      (failure) => `${failure.sourceId} (${failure.kind}): ${failure.detail}`
    )
    .join(" | ");
}

type SearchResult = { url: string; title: string; content: string };

/**
 * One row per source, on its own update.
 *
 * A fresh `id` each time: this tool runs once per researcher search step, and
 * two steps are two genuinely different observations of the same six lanes. The
 * UI merges them — see `mergeLaneReports` in components/research-run-summary.ts
 * — rather than the producer flattening them into a number here.
 */
function writeLaneReport(
  dataStream: StreamWriter,
  toolCallId: string,
  lanes: LaneReport[]
): void {
  dataStream.write({
    type: "data-researchUpdate",
    id: generateUUID(),
    data: { toolCallId, title: "Sources", type: "lanes", lanes },
  });
}

/**
 * DEDUPED BY URL, first occurrence wins.
 *
 * The sidecar does NOT guarantee unique urls. `app/pipeline/dedupe.py` removes
 * near-duplicates by TEXT similarity at a 0.7 threshold, not by url, and it has
 * an explicit branch that keeps any item whose text is empty without comparing
 * it to anything. Verified by running it: two items sharing a url survive
 * together both when their text is empty and when their text differs enough to
 * fall under the threshold.
 *
 * Two reasons that matters here, and the second is the important one.
 *
 * 1. `key={result.url}` in components/research-task.tsx and
 *    `key={source.url}` in components/sources.tsx then collide, which React
 *    reports as a duplicate-key warning and which makes list reconciliation
 *    undefined.
 * 2. THE SAME SOURCE LISTED TWICE READS AS TWO PIECES OF EVIDENCE. That is the
 *    exact failure this product exists to prevent, arriving through a
 *    rendering list rather than through a judgement. One permalink is one
 *    citation however many times a harvest happened to return it.
 *
 * First occurrence wins because the sidecar has already ordered signals by its
 * own relevance, so the first is the better-scored one.
 */
function toSearchResults(signals: readonly DemandSignal[]): SearchResult[] {
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const signal of signals) {
    if (seen.has(signal.url)) {
      continue;
    }
    seen.add(signal.url);
    results.push({
      url: signal.url,
      title: signal.title,
      // The snippet is already capped to an excerpt by the sidecar,
      // deliberately: a permalink plus a short quote is a citation, a stored
      // full copy is a republication. Do not widen this into a full-body fetch.
      content: signal.snippet,
    });
  }
  return results;
}

const searchQueriesSchema = z
  .array(
    z.object({
      // `.min(1)`: the sidecar's SignalRequest declares `query` with
      // min_length=1, so an empty string comes back HTTP 422 and
      // `classifySidecarStatus` maps that to `schema-drift` — which tells an
      // operator the app and sidecar contracts have diverged and to redeploy,
      // when in fact the model just emitted an empty argument. Reject it here
      // so the model gets a schema error it can repair instead.
      query: z.string().min(1),
      maxResults: z
        .number()
        .min(1)
        .max(10)
        .nullable()
        .describe(
          `Maximum number of results for this query. Defaults to ${DEFAULT_MAX_RESULTS}.`
        ),
    })
  )
  .max(MAX_SEARCH_QUERIES)
  .describe(`Array of search queries. Maximum ${MAX_SEARCH_QUERIES} queries.`);

export const sidecarWebSearch = ({
  dataStream,
  writeTopLevelUpdates,
  toolCallIdOverride,
  fetchImpl,
  now,
}: {
  dataStream: StreamWriter;
  writeTopLevelUpdates: boolean;
  toolCallIdOverride?: string;
  /** Injected so a test never opens a socket. */
  fetchImpl?: typeof fetch;
  /** Injected so the lookback window is deterministic under test. */
  now?: () => Date;
}) =>
  tool({
    description: `Multi-query web search over the local research sidecar (Hacker News and a keyless web ladder). Always cite sources inline.

Use for:
- General information gathering, and for finding evidence that real people discuss a problem

Avoid:
- Pulling content from a single known URL (use retrieveUrl instead)`,
    inputSchema: z.object({
      search_queries: searchQueriesSchema,
    }),
    execute: async (
      {
        search_queries,
      }: {
        search_queries: { query: string; maxResults: number | null }[];
      },
      { toolCallId: sdkToolCallId }: { toolCallId: string }
    ) => {
      const toolCallId = toolCallIdOverride ?? sdkToolCallId;
      const updateId = generateUUID();
      const baseUrl = config.ai.tools.deepResearch.researchSidecarUrl;
      const queries = search_queries.map((entry) => entry.query);

      if (writeTopLevelUpdates) {
        dataStream.write({
          type: "data-researchUpdate",
          data: {
            toolCallId,
            title: "Searching",
            timestamp: Date.now(),
            type: "started",
          },
        });
      }

      dataStream.write({
        type: "data-researchUpdate",
        id: updateId,
        data: {
          toolCallId,
          title: `Executing ${queries.length} searches`,
          type: "web",
          status: "running",
          queries,
        },
      });

      // Defence in depth: the schema above rejects an empty query, but a
      // provider that skips validation must not turn it into a 422 mislabelled
      // as contract drift.
      const usable = search_queries.filter(
        (entry) => entry.query.trim().length > 0
      );
      if (usable.length === 0) {
        // `attempted: false` — no harvest ran, so no lane may be described as
        // having found nothing. See lane-report.ts.
        writeLaneReport(
          dataStream,
          toolCallId,
          describeLanes({
            descriptors: ALL_PROVIDERS,
            signals: [],
            failures: [],
            attempted: false,
          })
        );
        return {
          searches: [],
          error:
            "No non-empty search query was supplied, so nothing was searched. This is a malformed tool call, not a source failure.",
        };
      }

      const to = now?.() ?? new Date();
      const from = new Date(to.getTime() - LOOKBACK_DAYS * DAY_MS);
      const { mode, unknownSourceIds } = currentDeployment();
      if (unknownSourceIds.length > 0) {
        log.warn(
          { unknownSourceIds },
          "RESEARCH_ENABLED_SOURCES names unrecognised source ids"
        );
      }
      const fetcherFor = createSidecarSignalFetcher({ baseUrl, fetchImpl });

      const harvests = await Promise.all(
        usable.map((entry) =>
          runSignalHarvest(
            { fetcherFor },
            {
              descriptors: ALL_PROVIDERS,
              mode,
              query: {
                query: entry.query,
                limit: entry.maxResults ?? DEFAULT_MAX_RESULTS,
                from: isoDate(from),
                to: isoDate(to),
              },
            }
          )
        )
      );

      const searches = harvests.map((harvest, index) => ({
        query: {
          query: usable[index].query,
          maxResults: usable[index].maxResults ?? DEFAULT_MAX_RESULTS,
        },
        results: toSearchResults(harvest.signals),
      }));

      const allResults = searches.flatMap((search) => search.results);
      const failures = harvests.flatMap((harvest) => harvest.failures);

      /*
        WHICH LANES RAN, AND WHICH REFUSED — STREAMED, not just logged.

        The failures below have always been complete: `{ok:false, source_id,
        kind, detail}` from the sidecar, and `gateRefusalToFailure` for anything
        the gate barred before a request. Until now they reached
        `describeFailures()`, the log line at the bottom of this function, and
        nowhere else — so on 2026-08-21 a founder read "0 sources" and had to
        ASK why they were only seeing Y Combinator. Four of six lanes were off
        and every one of them had already written down why.
      */
      writeLaneReport(
        dataStream,
        toolCallId,
        describeLanes({
          descriptors: ALL_PROVIDERS,
          signals: harvests.flatMap((harvest) => harvest.signals),
          failures,
          attempted: true,
        })
      );

      dataStream.write({
        type: "data-researchUpdate",
        id: updateId,
        data: {
          toolCallId,
          title: `Executing ${queries.length} searches`,
          type: "web",
          status: "completed",
          queries,
          results: allResults.map((result) => ({
            ...result,
            source: "web" as const,
          })),
        },
      });

      if (writeTopLevelUpdates) {
        dataStream.write({
          type: "data-researchUpdate",
          data: {
            toolCallId,
            title: "Search complete",
            timestamp: Date.now(),
            type: "completed",
          },
        });
      }

      // FAIL CLOSED. Zero results with named failures behind them is "we could
      // not look", and returning a bare empty array would let the researcher
      // write "no evidence of demand" off the back of a datacenter-IP 403.
      // `inconclusive` covers blocked/unavailable/rate-limited; a harvest whose
      // every source was gate-refused is also empty-but-explained, and both
      // must reach the model as an error rather than as an absence.
      if (allResults.length === 0) {
        const detail =
          describeFailures(failures) +
          describeUnknownSourceIds(unknownSourceIds);
        log.error(
          { queries, failures, baseUrl },
          "sidecarWebSearch returned no results"
        );
        return {
          searches: [],
          error: `The research sidecar returned no usable results. ${detail}`,
        };
      }

      if (failures.length > 0) {
        log.warn(
          { queries, failures },
          "sidecarWebSearch succeeded with partial source failures"
        );
      }
      log.debug(
        { queries, resultCount: allResults.length },
        "sidecarWebSearch complete"
      );

      return { searches };
    },
  });
