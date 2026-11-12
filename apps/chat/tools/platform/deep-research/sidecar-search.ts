import { tool } from "ai";
import { z } from "zod";
import type { StreamWriter } from "@/lib/ai/types";
import { config } from "@/lib/config";
import { env } from "@/lib/env";
import { createModuleLogger } from "@/lib/logger";
import {
  type AudienceView,
  limitLanes,
  orderProviders,
  rankSignals,
  rankSourcesFor,
  type SourceRanking,
  sourceOptionsFor,
} from "@/lib/signals/audience";
import { runSignalHarvest } from "@/lib/signals/provider";
import {
  ALL_PROVIDERS,
  describeUnknownSourceIds,
} from "@/lib/signals/providers";
import { createSidecarSignalFetcher } from "@/lib/signals/sidecar";
import type {
  DemandSignal,
  SignalFailure,
  SignalSourceId,
} from "@/lib/signals/types";
import { generateUUID } from "@/lib/utils";
import type { LaneReport } from "../research-updates-schema";
import { currentDeployment } from "./deployment-mode";
import { describeLanes } from "./lane-report";
import {
  canStartSearchStep,
  type ResearchClock,
  recordCut,
  searchStepTimeoutMs,
} from "./research-clock";

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

/**
 * WHAT AN ABSENT AUDIENCE MEANS — and it does not mean "developers".
 *
 * A caller that passes no audience is in exactly the position a project with no
 * `target_user` fact is in: nothing is known about the buyer. That resolves
 * through `rankSourcesFor` to `NEUTRAL_RANKING`, which is a written, defended
 * ordering — general web first, the narrow developer corpora last — rather than
 * a fall-through to the registry order that put Hacker News first for everyone.
 */
const NO_AUDIENCE: AudienceView = {
  known: false,
  reason: "no-segment-stated",
};

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
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
 * two steps are two genuinely different observations of the same lanes. The
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
 *
 * `seen` IS SHARED BY THE QUERIES OF ONE STEP. A step runs up to two queries and
 * each harvest dedupes only its own signals, so a permalink both queries
 * returned was listed twice: React's duplicate-key warning, a run header that
 * said "100 sources" next to a Sources chip that said "96", and the same page
 * counted as two pieces of evidence. A later query drops a url an earlier one
 * already listed. The same url returned by a LATER STEP is handled where the
 * steps meet, in `uniqueSources` (components/research-run-summary.ts).
 *
 * THE MODEL IS TOLD HOW MANY WERE LEFT OUT. A later query whose hits were all
 * listed by an earlier one came back as `results: []`, which the researcher model
 * cannot tell from a query that found nothing, and it may write "no evidence for
 * this wording" off the back of it. `omittedAsDuplicates` counts the hits dropped
 * because an EARLIER QUERY of the step already returned the url (not a url the
 * sidecar repeated inside one query, which is the sidecar's repeat and not an
 * earlier query's finding). The de-duplication itself is unchanged, so the
 * streamed list, the run header and the Sources chip still count each url once.
 */
function toSearchResults(
  signals: readonly DemandSignal[],
  seen: Set<string>
): { results: SearchResult[]; omittedAsDuplicates: number } {
  const results: SearchResult[] = [];
  const listedByEarlierQueries = new Set(seen);
  let omittedAsDuplicates = 0;
  for (const signal of signals) {
    if (seen.has(signal.url)) {
      if (listedByEarlierQueries.has(signal.url)) {
        omittedAsDuplicates += 1;
      }
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
  return { results, omittedAsDuplicates };
}

/**
 * PURE. The sentence that goes next to a query's results when some of its hits
 * were left out as repeats of an earlier query's, and nothing when none were.
 */
function duplicatesNote(omittedAsDuplicates: number): {
  omittedAsDuplicates?: number;
  note?: string;
} {
  if (omittedAsDuplicates === 0) {
    return {};
  }
  const hits = omittedAsDuplicates === 1 ? "hit was" : "hits were";
  return {
    omittedAsDuplicates,
    note: `${omittedAsDuplicates} ${hits} left out of this query's results because an earlier query of this step already returned the same page. The page is listed there; its absence here is not a finding that this wording found nothing.`,
  };
}

/**
 * PURE. WHAT A PER-SEARCH LANE LIMIT LEFT OUT, in words for the researcher model:
 * how many results of which lane, why, and that their absence is not a finding.
 * Nothing when nothing was left out.
 *
 * The limit is never silent (`limitLanes` in lib/signals/audience.ts): the model
 * is about to write prose about this evidence, and "Hacker News has three stories
 * on this" is a different claim when it had eight and was shown three.
 * `omittedByLaneLimit` is the same count keyed by the lane's label, for a reader
 * that wants the numbers.
 */
function laneLimitNote(
  leftOut: Partial<Record<SignalSourceId, number>>,
  ranking: SourceRanking
): {
  omittedByLaneLimit?: Record<string, number>;
  laneLimitNote?: string;
} {
  const entries = ALL_PROVIDERS.flatMap((descriptor) => {
    const count = leftOut[descriptor.id] ?? 0;
    return count > 0
      ? [{ id: descriptor.id, label: descriptor.label, count }]
      : [];
  });
  if (entries.length === 0) {
    return {};
  }
  const total = entries.reduce((sum, entry) => sum + entry.count, 0);
  const left = entries
    .map(
      (entry) =>
        `${entry.count} ${entry.label} result${entry.count === 1 ? "" : "s"}`
    )
    .join(" and ");
  const caps = entries
    .map(
      (entry) =>
        `${entry.label} keeps at most ${ranking.laneLimits[entry.id]} per search`
    )
    .join(" and ");
  return {
    omittedByLaneLimit: Object.fromEntries(
      entries.map((entry) => [entry.label, entry.count])
    ),
    laneLimitNote: `${left} ${total === 1 ? "was" : "were"} left out of this query's results because ${ranking.laneLimitReason} (${caps}). They were the lowest-ranked results of that lane. Their absence is not a finding that nothing more was said there.`,
  };
}

/**
 * PER QUERY: the weighted order, then each narrow lane's limit (`limitLanes`),
 * which keeps its top-ranked results and counts the rest. Returns each query's
 * kept signals and what it left out, the step's left-out total per source id, and
 * every kept signal. The total is LOGGED here when anything was left out; the
 * caller reports it to the model (`laneLimitNote`) and to the founder (the lane
 * report's `leftOut`).
 */
function applyLaneLimits(
  harvests: readonly { signals: readonly DemandSignal[] }[],
  ranking: SourceRanking,
  queries: readonly string[]
): {
  limited: ReturnType<typeof limitLanes>[];
  leftOutBySource: Record<string, number>;
  keptSignals: DemandSignal[];
} {
  const limited = harvests.map((harvest) =>
    limitLanes(rankSignals(harvest.signals, ranking), ranking)
  );
  const leftOutBySource: Record<string, number> = {};
  for (const { leftOut } of limited) {
    for (const [sourceId, count] of Object.entries(leftOut)) {
      leftOutBySource[sourceId] = (leftOutBySource[sourceId] ?? 0) + count;
    }
  }
  if (Object.keys(leftOutBySource).length > 0) {
    log.info(
      {
        queries,
        leftOutBySource,
        laneLimits: ranking.laneLimits,
        because: ranking.laneLimitReason,
      },
      "sidecarWebSearch left results out under a per-search lane limit"
    );
  }
  return {
    limited,
    leftOutBySource,
    keptSignals: limited.flatMap(({ kept }) => kept),
  };
}

/**
 * The step's lanes are cut at the step cap (`searchStepTimeoutMs`), or when the
 * researcher calling this tool is stopped — whichever comes first.
 */
function stepAbortSignal(
  abortSignal: AbortSignal | undefined,
  clock: ResearchClock | undefined
): AbortSignal | undefined {
  const signals = [
    ...(abortSignal ? [abortSignal] : []),
    ...(clock ? [AbortSignal.timeout(searchStepTimeoutMs(clock))] : []),
  ];
  return signals.length > 0 ? AbortSignal.any(signals) : undefined;
}

/**
 * The top-level "Search complete" marker that pairs with the "Searching" marker
 * written when the call opens. Standalone web search (`writeTopLevelUpdates`)
 * reads the pair to time the step, so EVERY return path must write it: a path
 * that returns without it leaves a "started" with no end, and the elapsed time
 * in the run summary is then taken from the wrong pair.
 */
function writeSearchComplete(
  dataStream: StreamWriter,
  toolCallId: string,
  writeTopLevelUpdates: boolean
): void {
  if (!writeTopLevelUpdates) {
    return;
  }
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

/**
 * THE TERMINAL ROW FOR A STEP THAT NEVER RAN.
 *
 * Every step opens a `running` web update on its `updateId` before it knows
 * whether it will search, so every path that returns without searching must
 * replace that row, or the card spins forever and `describeResearchRun` counts
 * a search that never happened. It is `skipped`, not `completed`: a `completed`
 * web update is counted as a search ("8 searches" when three never ran), and one
 * with an empty result list is what a search that ran and found nothing looks
 * like. It carries no `results` for the same reason: there is nothing to count,
 * not a zero. `reason` is the founder-facing why, shown in the card's title.
 *
 * It also closes the top-level "Searching" marker (`writeSearchComplete`), for
 * the same reason it closes the row: a step that returns early has still opened
 * both.
 */
function writeSkippedStep(input: {
  dataStream: StreamWriter;
  toolCallId: string;
  updateId: string;
  queries: string[];
  reason: string;
  writeTopLevelUpdates: boolean;
}): void {
  const {
    dataStream,
    toolCallId,
    updateId,
    queries,
    reason,
    writeTopLevelUpdates,
  } = input;
  const count =
    queries.length === 1 ? "1 search" : `${queries.length} searches`;
  dataStream.write({
    type: "data-researchUpdate",
    id: updateId,
    data: {
      toolCallId,
      title: `Skipped ${count}: ${reason}`,
      type: "web",
      status: "skipped",
      queries,
    },
  });
  writeSearchComplete(dataStream, toolCallId, writeTopLevelUpdates);
}

/**
 * A search step that cannot finish before the search deadline, refused before
 * any fetch. `attempted: false` keeps every lane "not attempted" rather than
 * "found nothing", and the reply is an error so the researcher stops searching
 * instead of reading an absence of evidence into it.
 */
function refuseForTime(input: {
  clock: ResearchClock;
  dataStream: StreamWriter;
  toolCallId: string;
  updateId: string;
  queries: string[];
  descriptors: Parameters<typeof describeLanes>[0]["descriptors"];
  writeTopLevelUpdates: boolean;
}) {
  const {
    clock,
    dataStream,
    toolCallId,
    updateId,
    queries,
    descriptors,
    writeTopLevelUpdates,
  } = input;
  recordCut(
    clock,
    "a planned search was not run because the search time had run out"
  );
  writeLaneReport(
    dataStream,
    toolCallId,
    describeLanes({ descriptors, signals: [], failures: [], attempted: false })
  );
  writeSkippedStep({
    dataStream,
    toolCallId,
    updateId,
    queries,
    reason: "search time ran out",
    writeTopLevelUpdates,
  });
  return {
    searches: [],
    error:
      "Not searched: the search time for this research run has run out, so this search was skipped to leave time for the report. This is not a finding that the topic has no evidence. Stop searching and write up what you have.",
  };
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
  audience,
  fetchImpl,
  now,
  clock,
}: {
  dataStream: StreamWriter;
  writeTopLevelUpdates: boolean;
  toolCallIdOverride?: string;
  /**
   * Who the founder's buyer is, read once per research run in pipeline.ts.
   * OMITTED MEANS UNKNOWN, never "assume the default" — see NO_AUDIENCE.
   */
  audience?: AudienceView;
  /** Injected so a test never opens a socket. */
  fetchImpl?: typeof fetch;
  /** Injected so the lookback window is deterministic under test. */
  now?: () => Date;
  /**
   * The research run's deadlines. With it, a step that cannot finish before
   * the search deadline is not started, and one that starts is capped at
   * `searchStepTimeoutMs` (30 s at most). Omitted, the per-source 45 s timeout
   * in lib/signals/sidecar.ts is the only bound.
   */
  clock?: ResearchClock;
}) =>
  tool({
    description: `Multi-query web search over the local research sidecar. The lanes it can reach are whatever this deployment has enabled — Hacker News, a keyless general-web ladder, the Reddit archive, GitHub — and they are RANKED AGAINST THE FOUNDER'S BUYER before the results come back, so the first results are from the room that buyer is actually in. Do not assume which lane answered; the result carries a \`sourceRanking\` sentence saying why the order is what it is. Always cite sources inline.

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
      {
        toolCallId: sdkToolCallId,
        abortSignal,
      }: { toolCallId: string; abortSignal?: AbortSignal }
    ) => {
      const toolCallId = toolCallIdOverride ?? sdkToolCallId;
      const updateId = generateUUID();

      /*
        WHO THE BUYER IS DECIDES WHAT LEADS THE REPORT.

        For example, a founder whose buyer is parents of young children should
        not get a report that leads with Hacker News. Nothing prevented it:
        `ALL_PROVIDERS` lists Hacker News first, `selectEnabledProviders`
        preserves that order and `harvestSignals` concatenates in it, so a
        registry's writing order was the ranking for every project alike.

        `rankSourcesFor` replaces that with one explicit decision, made in
        lib/signals/audience.ts and explained there. It reaches FOUR places
        below and nowhere else:
          - the descriptor order, which is both the fan-out order and the order
            of the per-lane report the founder reads;
          - `sourceOptions`, which is what finally lets the Arctic Shift lane
            run at all — it refuses any query with no subreddits, and choosing
            subreddits for a project IS the segment question;
          - `rankSignals`, a weighting on top of the sidecar's own relevance;
          - `limitLanes`, a per-search limit on the narrow developer lanes for a
            buyer who is not (known to be) a developer.

        NOTHING IS FILTERED by the first three. Every lane still runs, still
        reports, and can still lead on merit. THE FOURTH LEAVES RESULTS OUT, and
        is never silent about it: the model is told how many of which lane and
        why (`laneLimitNote`), it is logged, and the lane report the founder
        reads says how many were kept and how many left out.
      */
      const ranking = rankSourcesFor(audience ?? NO_AUDIENCE);
      const descriptors = orderProviders(ALL_PROVIDERS, ranking);
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
            descriptors,
            signals: [],
            failures: [],
            attempted: false,
          })
        );
        // The "running" row written above must not be left open: it would spin
        // forever and be counted as a search.
        writeSkippedStep({
          dataStream,
          toolCallId,
          updateId,
          queries,
          reason: "no search query was supplied",
          writeTopLevelUpdates,
        });
        return {
          searches: [],
          error:
            "No non-empty search query was supplied, so nothing was searched. This is a malformed tool call, not a source failure.",
        };
      }

      /*
        NOT STARTED WHEN IT CANNOT FINISH. Past this point the run would spend
        the time the report needs (research-clock.ts). Said to the model as an
        error, like every other empty-but-explained outcome here, and recorded
        so the report says the search was cut short.
      */
      if (clock && !canStartSearchStep(clock)) {
        return refuseForTime({
          clock,
          dataStream,
          toolCallId,
          updateId,
          queries,
          descriptors,
          writeTopLevelUpdates,
        });
      }
      const stepSignal = stepAbortSignal(abortSignal, clock);

      const to = now?.() ?? new Date();
      const from = new Date(to.getTime() - LOOKBACK_DAYS * DAY_MS);
      const { mode, unknownSourceIds } = currentDeployment();
      if (unknownSourceIds.length > 0) {
        log.warn(
          { unknownSourceIds },
          "RESEARCH_ENABLED_SOURCES names unrecognised source ids"
        );
      }
      const fetcherFor = createSidecarSignalFetcher({
        baseUrl,
        fetchImpl,
        token: env.RESEARCH_SIDECAR_TOKEN,
      });

      const harvests = await Promise.all(
        usable.map((entry) =>
          runSignalHarvest(
            { fetcherFor },
            {
              descriptors,
              mode,
              query: {
                query: entry.query,
                limit: entry.maxResults ?? DEFAULT_MAX_RESULTS,
                from: isoDate(from),
                to: isoDate(to),
                sourceOptions: sourceOptionsFor(ranking),
              },
              abortSignal: stepSignal,
            }
          )
        )
      );

      // PER QUERY: weighted order, then each narrow lane's limit (`limitLanes`),
      // which keeps its top-ranked results and counts the rest. What is left out is
      // reported three ways below: to the researcher model (`laneLimitNote`), to
      // the log, and to the founder (the lane report's `leftOut`).
      const { limited, leftOutBySource, keptSignals } = applyLaneLimits(
        harvests,
        ranking,
        queries
      );

      // One set for the step, read in query order, so the first query's
      // results are the ones that stay. See `toSearchResults`.
      const seenUrls = new Set<string>();
      const searches = limited.map(({ kept, leftOut }, index) => {
        const { results, omittedAsDuplicates } = toSearchResults(
          kept,
          seenUrls
        );
        return {
          query: {
            query: usable[index].query,
            maxResults: usable[index].maxResults ?? DEFAULT_MAX_RESULTS,
          },
          results,
          ...duplicatesNote(omittedAsDuplicates),
          ...laneLimitNote(leftOut, ranking),
        };
      });

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
          descriptors,
          // What was KEPT, so a lane's count and the run's source count agree.
          signals: keptSignals,
          failures,
          attempted: true,
          leftOut: {
            bySource: leftOutBySource,
            because: ranking.laneLimitReason,
          },
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

      writeSearchComplete(dataStream, toolCallId, writeTopLevelUpdates);

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
        { queries, resultCount: allResults.length, ranking: ranking.rationale },
        "sidecarWebSearch complete"
      );

      // THE RATIONALE TRAVELS WITH THE RESULTS. The researcher model is about
      // to write prose about this evidence, and "Reddit leads because the buyer
      // is a parent" is the sentence the founder actually asked for. A ranking
      // whose reason stays in a log line is the same failure the per-lane
      // report was built to end.
      return { searches, sourceRanking: ranking.rationale };
    },
  });
