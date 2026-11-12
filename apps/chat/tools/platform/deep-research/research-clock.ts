import { CHAT_REQUEST_BUDGET_MS } from "@/lib/ai/request-budget";
import { createModuleLogger } from "@/lib/logger";

const log = createModuleLogger("tools/deep-research/research-clock");

/**
 * THE DEADLINES OF ONE DEEP-RESEARCH RUN, all derived from the route's budget.
 *
 * Why this exists: live QA (2026-11-12) ran a consumer-buyer research run that
 * the chat route's own abort timer cut at 289 s. Search had taken most of the
 * budget (a rate-limited Reddit lane added about a minute per search step), so
 * the report was cut after its executive summary and saved only as a partial
 * document. Nothing in the pipeline knew the route had a deadline.
 *
 * The rule now: search stops early enough that the findings can be condensed
 * and the WHOLE report written before the route's timer, which stays as the
 * backstop. Measured from the moment the request arrived (the route passes
 * that deadline down), so the chat turn before the tool call, the clarification
 * and the research brief all count against the same clock.
 *
 * THE ARITHMETIC, for the 290 s budget (`CHAT_REQUEST_BUDGET_MS`):
 *
 *   290 s  route aborts (backstop, never expected to fire)
 *   - 15 s WRAP_UP: the chat model's closing reply after the tool returns,
 *          and persisting the message
 *   = 275 s reportDueAt: the report must be finished
 *   - 120 s REPORT: writing the final report (see below)
 *   = 155 s findingsDueAt: the supervisor is stopped; the report starts
 *   - 5 s  HANDOFF: researchers that finish compressing at the deadline still
 *          get their notes to the supervisor
 *   = 150 s compressionDueAt: compression is aborted and raw findings used
 *   - 30 s COMPRESSION: one compression call (up to 4,000 output tokens);
 *          the researchers compress in parallel, so one allowance covers them
 *   = 120 s searchStopAt: no search step or research topic starts after this,
 *          and a researcher still running is stopped here
 *
 * Inside the search window, one search step is capped at 30 s
 * (`SEARCH_STEP_TIMEOUT_MS`), and never past `searchStopAt`. The slowest lane
 * caps itself below that: the Arctic Shift lane stops at 25 s
 * (`_LANE_WALL_TIME_SECONDS` in apps/research/app/sources/arctic_shift.py), so
 * it reports its own outcome instead of being cut off. A step is not started
 * with less than 10 s left (`MIN_SEARCH_STEP_MS`), and a research topic not
 * with less than 25 s (`MIN_RESEARCH_TOPIC_MS`: one researcher model step plus
 * one short search).
 *
 * THE 120 s REPORT ALLOWANCE IS AN ESTIMATE, not a measurement: the report
 * model's throughput has not been measured on this route. It assumes 15 s
 * before the first token and 40 output tokens per second after it, which
 * writes about 4,200 tokens (about 3,100 words) in 120 s — below the 6,000-token
 * ceiling in configuration.ts. `reportWordBudget` turns whatever time is
 * actually left into a word limit stated in the report prompt, so a report
 * that starts late is asked to be shorter rather than being cut off.
 */

export const WRAP_UP_ALLOWANCE_MS = 15_000;
export const REPORT_ALLOWANCE_MS = 120_000;
export const HANDOFF_GRACE_MS = 5000;
export const COMPRESSION_ALLOWANCE_MS = 30_000;

export const SEARCH_STEP_TIMEOUT_MS = 30_000;
export const MIN_SEARCH_STEP_MS = 10_000;
export const MIN_RESEARCH_TOPIC_MS = 25_000;

/** Assumed report-model latency and speed. See the arithmetic above. */
const REPORT_FIRST_TOKEN_MS = 15_000;
const REPORT_TOKENS_PER_SECOND = 40;
const WORDS_PER_TOKEN = 0.75;
/** Below this a report cannot say anything useful; asked for anyway. */
const MIN_REPORT_WORDS = 400;

/**
 * One thing a cut left behind: the research topic it hit (null when the cut is
 * not about one topic, such as a search step refused for time) and the numbers
 * the caller knew (`stepsFinished`, `unfinishedStepSeconds`).
 */
export type CutOccurrence = {
  topic: string | null;
  detail: Readonly<Record<string, number | string>>;
};

/** A reason, and every occurrence of it. One record per reason. */
export type CutRecord = { reason: string; occurrences: CutOccurrence[] };

export type ResearchClock = {
  /** When the route aborts the request. The backstop. */
  readonly requestDeadlineAt: number;
  readonly searchStopAt: number;
  readonly compressionDueAt: number;
  readonly findingsDueAt: number;
  readonly reportDueAt: number;
  readonly now: () => number;
  /**
   * What was cut short, in the order it first happened, ONE RECORD PER REASON.
   * Empty means nothing was. The report prompt quotes these (`describeCuts`) so
   * the report can say so. Several researchers can be stopped for the same
   * reason; each keeps its own occurrence under that one record, so the report
   * can name every topic that was affected and not only the first.
   */
  readonly cuts: CutRecord[];
};

/** PURE apart from reading `now`. */
export function planResearchClock(
  requestDeadlineAt: number,
  now: () => number = Date.now
): ResearchClock {
  const reportDueAt = requestDeadlineAt - WRAP_UP_ALLOWANCE_MS;
  const findingsDueAt = reportDueAt - REPORT_ALLOWANCE_MS;
  const compressionDueAt = findingsDueAt - HANDOFF_GRACE_MS;
  const searchStopAt = compressionDueAt - COMPRESSION_ALLOWANCE_MS;
  return {
    requestDeadlineAt,
    searchStopAt,
    compressionDueAt,
    findingsDueAt,
    reportDueAt,
    now,
    cuts: [],
  };
}

/** The deadline for a run with no route deadline handed down (evals, scripts). */
export function defaultRequestDeadline(now: () => number = Date.now): number {
  return now() + CHAT_REQUEST_BUDGET_MS;
}

export function msUntil(clock: ResearchClock, at: number): number {
  return Math.max(0, at - clock.now());
}

export function canStartSearchStep(clock: ResearchClock): boolean {
  return msUntil(clock, clock.searchStopAt) >= MIN_SEARCH_STEP_MS;
}

export function canStartResearchTopic(clock: ResearchClock): boolean {
  return msUntil(clock, clock.searchStopAt) >= MIN_RESEARCH_TOPIC_MS;
}

/** One search step's cap: 30 s, and never past `searchStopAt`. */
export function searchStepTimeoutMs(clock: ResearchClock): number {
  return Math.min(SEARCH_STEP_TIMEOUT_MS, msUntil(clock, clock.searchStopAt));
}

/** Longest topic text kept for the report, which only has to recognise it. */
const MAX_CUT_TOPIC_CHARS = 160;

const WHITESPACE_RUN = /\s+/g;
/** Punctuation and space left dangling once a topic is cut at a word. */
const DANGLING_PUNCTUATION = /[\s,;:—-]+$/;

/** PURE. A research topic (a paragraph) cut to a recognisable clause. */
function clipTopic(topic: string): string {
  const flat = topic.replace(WHITESPACE_RUN, " ").trim();
  if (flat.length <= MAX_CUT_TOPIC_CHARS) {
    return flat;
  }
  const room = flat.slice(0, MAX_CUT_TOPIC_CHARS - 1);
  const lastSpace = room.lastIndexOf(" ");
  const kept =
    lastSpace > MAX_CUT_TOPIC_CHARS / 2 ? room.slice(0, lastSpace) : room;
  return `${kept.replace(DANGLING_PUNCTUATION, "")}…`;
}

/**
 * Notes a cut. The same fact twice is one fact; the same reason for a DIFFERENT
 * topic is a second occurrence under the same record.
 *
 * ONE RECORD PER REASON, EVERY OCCURRENCE KEPT. This used to keep the first
 * caller's reason and drop every later call with the same reason, so when two
 * researchers were stopped mid-step only the first was logged and reported, and
 * the report could not say which topics lost their last step. A call now adds
 * its `topic` and `detail` to the reason's record unless an identical one is
 * already there (a search step refused for time twice, with nothing to tell the
 * two apart, is still one fact).
 *
 * `topic` is what the report names, so a founder can see WHICH topic is thin
 * (`describeCuts`). It is clipped here, and it is not written to the log: the
 * log line carries the reason, the seconds since the request arrived and the
 * second the search stop was due (both on the request's own clock, the same one
 * the arithmetic at the top of this file counts on), and whatever else the caller
 * knows about what was in flight (`detail`).
 *
 * LOGGED, WITH WHERE IN THE REQUEST IT HAPPENED. A cut used to reach the report
 * prompt and nothing else, so when a run was cut short nobody could say which of
 * the cuts had fired or how far into the request it was. The reasons are the
 * strings the callers in the researcher, the supervisor and the search tool
 * pass. Most are about time; one (a researcher's first reply cut off at its
 * output limit) is not, and is recorded here all the same because the report has
 * to say that a topic went unresearched.
 */
export function recordCut(
  clock: ResearchClock,
  reason: string,
  detail: Record<string, number | string> = {},
  topic?: string
): void {
  const occurrence: CutOccurrence = {
    topic: topic ? clipTopic(topic) : null,
    detail,
  };
  let record = clock.cuts.find((cut) => cut.reason === reason);
  if (!record) {
    record = { reason, occurrences: [] };
    clock.cuts.push(record);
  }
  const repeated = record.occurrences.some(
    (seen) =>
      seen.topic === occurrence.topic &&
      JSON.stringify(seen.detail) === JSON.stringify(occurrence.detail)
  );
  if (repeated) {
    return;
  }
  record.occurrences.push(occurrence);
  const requestStartedAt = clock.requestDeadlineAt - CHAT_REQUEST_BUDGET_MS;
  log.warn(
    {
      reason,
      ...detail,
      secondsIntoRequest: toSeconds(clock.now() - requestStartedAt),
      searchStopDueAtSeconds: toSeconds(clock.searchStopAt - requestStartedAt),
    },
    "deep research was cut short for time"
  );
}

/**
 * PURE. The cuts as lines for the report prompt: the reason, and under it every
 * topic that reason hit (with how many search steps it had finished, when the
 * caller said). A reason that names no topic is just the reason.
 */
export function describeCuts(cuts: readonly CutRecord[]): string[] {
  return cuts.map(({ reason, occurrences }) => {
    const topics = occurrences
      .filter((occurrence) => occurrence.topic !== null)
      .map(({ topic, detail }) => {
        const finished = detail.stepsFinished;
        const steps =
          typeof finished === "number"
            ? ` (${finished} search ${finished === 1 ? "step" : "steps"} had finished)`
            : "";
        return `"${topic}"${steps}`;
      });
    return topics.length === 0
      ? reason
      : `${reason}. Topics affected: ${topics.join("; ")}`;
  });
}

function toSeconds(ms: number): number {
  return Math.round(ms / 100) / 10;
}

/**
 * A signal that aborts at `at`, or when `parent` (the route's signal) aborts —
 * whichever is first.
 *
 * `stoppedByDeadline()` tells the two apart, and callers must ask it before
 * keeping partial work: the route's abort is the end of the request and is
 * rethrown, while this deadline is a planned stop whose partial work is kept.
 * Any other error is rethrown as well.
 */
export function stopAt(
  clock: ResearchClock,
  at: number,
  parent?: AbortSignal
): { signal: AbortSignal; stoppedByDeadline: () => boolean } {
  const deadline = AbortSignal.timeout(msUntil(clock, at));
  return {
    signal: parent ? AbortSignal.any([parent, deadline]) : deadline,
    stoppedByDeadline: () => deadline.aborted && !parent?.aborted,
  };
}

/** The word limit stated in the report prompt, from the time actually left. */
export function reportWordBudget(
  clock: ResearchClock,
  maxOutputTokens: number
): number {
  const writingMs = msUntil(clock, clock.reportDueAt) - REPORT_FIRST_TOKEN_MS;
  const tokens = Math.min(
    maxOutputTokens,
    Math.floor((writingMs / 1000) * REPORT_TOKENS_PER_SECOND)
  );
  return Math.max(
    MIN_REPORT_WORDS,
    Math.floor((tokens * WORDS_PER_TOKEN) / 100) * 100
  );
}
