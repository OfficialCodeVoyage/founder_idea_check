import { z } from "zod";

const BaseStreamUpdateSchema = z.object({
  title: z.string(),
  toolCallId: z.string(),
});

const TaskUpdateSchema = BaseStreamUpdateSchema.extend({
  status: z.enum(["running", "completed"]),
});

const WebSearchSchema = TaskUpdateSchema.extend({
  type: z.literal("web"),
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
 * - `returned`       the lane ran and produced this many signals.
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
 * adapters write these sentences for a human — one of them cites Reddit v.
 * Perplexity and Reddit v. Anthropic by name, another tells the caller which
 * parameter to pass instead — and summarising them throws away the only part
 * the reader can act on.
 */
const LaneOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("returned"), signals: z.number() }),
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
