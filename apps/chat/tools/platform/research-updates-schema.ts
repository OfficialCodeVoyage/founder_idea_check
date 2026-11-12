import { z } from "zod";

const BaseStreamUpdateSchema = z.object({
  title: z.string(),
  toolCallId: z.string(),
});

const TaskUpdateSchema = BaseStreamUpdateSchema.extend({
  status: z.enum(["running", "completed"]),
});

/**
 * A `web` update is one search step. `skipped` is a step that was PLANNED and
 * REFUSED before any request (the research run's search time had run out, or
 * the call carried no usable query): it never ran, so it is not a search and carries no results. It is its own status
 * and not `completed` with an empty result list, because that is exactly what
 * a search that ran and found nothing looks like, and `describeResearchRun`
 * counts the one and must not count the other.
 */
const WebSearchSchema = TaskUpdateSchema.extend({
  type: z.literal("web"),
  status: z.enum(["running", "completed", "skipped"]),
  queries: z.array(z.string()),
  results: z
    .array(
      z.object({
        url: z.string(),
        title: z.string(),
        content: z.string(),
        source: z.enum(["web", "academic", "x"]),
        // tweetId: z.string().optional(),
      })
    )
    .optional(),
});

export type WebSearchUpdate = z.infer<typeof WebSearchSchema>;

export type SearchResultItem = NonNullable<WebSearchUpdate["results"]>[number];

const StartedSchema = BaseStreamUpdateSchema.extend({
  type: z.literal("started"),
  timestamp: z.number(),
});

const CompletedSchema = BaseStreamUpdateSchema.extend({
  type: z.literal("completed"),
  timestamp: z.number(),
});

const ThoughtsSchema = TaskUpdateSchema.extend({
  type: z.literal("thoughts"),
  message: z.string(),
});

const WritingSchema = TaskUpdateSchema.extend({
  type: z.literal("writing"),
  message: z.string().optional(),
});

/**
 * WHAT EACH SOURCE LANE DID — AND THE ARMS THAT CARRY NO COUNT.
 *
 * On 2026-08-21 a founder asked for a source-cited study, got zero citations,
 * and had to ask "why am I only seeing Y Combinator?" to discover that four of
 * six lanes were switched off. The refusals were ALREADY fully structured — the
 * sidecar answers `{"ok": false, source_id, kind, detail}` with a complete,
 * human-written reason, and `runSignalHarvest` collects them as
 * `SignalFailure[]` — and every one of them stopped at a log line.
 *
 * THREE STATES THAT MUST NEVER COLLAPSE INTO EACH OTHER, which is why this is a
 * union and not a row of numbers:
 *
 * - `returned`       the lane ran and produced this many signals. `signals` counts
 *                    the ones KEPT. When a per-search lane limit left some out
 *                    (`limitLanes` in lib/signals/audience.ts), `leftOut` says how
 *                    many and why, so "3 signals" is never read as "that is all
 *                    the lane found". Optional, so an older transcript parses.
 * - `found-nothing`  the lane ran and the topic genuinely has no coverage there.
 *                    A LEGITIMATE FINDING the *Verifying Demand* gate acts on,
 *                    and apps/research/README.md calls preserving it the one
 *                    thing not to break. It carries no count on purpose: the
 *                    only number it could carry is 0, and a 0 is exactly what
 *                    made the other two arms unreadable.
 * - `refused`        the lane was blocked, gated off, or missing a credential.
 *                    "We could not look", never "nobody cares".
 * - `not-attempted`  no harvest ran at all, so this lane was never asked.
 *
 * `detail` is passed through VERBATIM. `decideProviderGate` and the sidecar's
 * adapters write these sentences for a human — one of them names the
 * credential that is missing, another tells the caller which parameter to pass
 * instead — and summarising them throws away the only part the reader can act
 * on.
 */
const LaneOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("returned"),
    signals: z.number(),
    leftOut: z
      .object({
        count: z.number(),
        /** Completes "because ...": the founder reads it verbatim. */
        because: z.string(),
      })
      .optional(),
  }),
  z.object({ kind: z.literal("found-nothing") }),
  z.object({
    kind: z.literal("refused"),
    failureKind: z.string(),
    detail: z.string(),
  }),
  z.object({ kind: z.literal("not-attempted") }),
]);

const LaneReportSchema = z.object({
  sourceId: z.string(),
  /** The human label, not the id. A founder does not know "web-keyless". */
  label: z.string(),
  outcome: LaneOutcomeSchema,
});

export type LaneOutcome = z.infer<typeof LaneOutcomeSchema>;
export type LaneReport = z.infer<typeof LaneReportSchema>;

const LanesSchema = BaseStreamUpdateSchema.extend({
  type: z.literal("lanes"),
  lanes: z.array(LaneReportSchema),
});

export type LanesUpdate = z.infer<typeof LanesSchema>;

const ResearchUpdateSchema = z.discriminatedUnion("type", [
  WebSearchSchema,
  StartedSchema,
  CompletedSchema,
  ThoughtsSchema,
  WritingSchema,
  LanesSchema,
]);

export type ResearchUpdate = z.infer<typeof ResearchUpdateSchema>;
