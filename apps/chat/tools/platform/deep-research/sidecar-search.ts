import { tool } from "ai";
import { z } from "zod";
import type { StreamWriter } from "@/lib/ai/types";
import { config } from "@/lib/config";
import { env } from "@/lib/env";
import { createModuleLogger } from "@/lib/logger";
import { runSignalHarvest } from "@/lib/signals/provider";
import {
  ALL_PROVIDERS,
  DEFAULT_ENABLED_SOURCE_IDS,
} from "@/lib/signals/providers";
import { createSidecarSignalFetcher } from "@/lib/signals/sidecar";
import type {
  DemandSignal,
  DeploymentMode,
  SignalFailure,
} from "@/lib/signals/types";
import { generateUUID } from "@/lib/utils";

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
 * Every credential any descriptor asks for, derived from the descriptors
 * themselves rather than restated. A hardcoded list here would drift the first
 * time a source is added, and `decideProviderGate` would then refuse it for a
 * credential the operator had actually set.
 */
const CREDENTIAL_ENV_NAMES: readonly string[] = [
  ...new Set(ALL_PROVIDERS.flatMap((provider) => provider.requiredCredentials)),
];

function currentDeploymentMode(): DeploymentMode {
  const values = env as unknown as Record<string, string | undefined>;
  return {
    hosted: config.ai.tools.deepResearch.hosted,
    availableCredentials: CREDENTIAL_ENV_NAMES.filter((name) => {
      const value = values[name];
      return typeof value === "string" && value.length > 0;
    }),
    // The operator's request, which the gate may still refuse. Hacker News and
    // the keyless web ladder — both keyless, both on in either mode.
    operatorEnabled: DEFAULT_ENABLED_SOURCE_IDS,
  };
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

function toSearchResults(signals: readonly DemandSignal[]): SearchResult[] {
  return signals.map((signal) => ({
    url: signal.url,
    title: signal.title,
    // The snippet is already capped to an excerpt by the sidecar, deliberately:
    // a permalink plus a short quote is a citation, a stored full copy is a
    // republication. Do not widen this into a full-body fetch.
    content: signal.snippet,
  }));
}

const searchQueriesSchema = z
  .array(
    z.object({
      query: z.string(),
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

      const to = now?.() ?? new Date();
      const from = new Date(to.getTime() - LOOKBACK_DAYS * DAY_MS);
      const mode = currentDeploymentMode();
      const fetcherFor = createSidecarSignalFetcher({ baseUrl, fetchImpl });

      const harvests = await Promise.all(
        search_queries.map((entry) =>
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
          query: search_queries[index].query,
          maxResults: search_queries[index].maxResults ?? DEFAULT_MAX_RESULTS,
        },
        results: toSearchResults(harvest.signals),
      }));

      const allResults = searches.flatMap((search) => search.results);
      const failures = harvests.flatMap((harvest) => harvest.failures);

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
        const detail = describeFailures(failures);
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
