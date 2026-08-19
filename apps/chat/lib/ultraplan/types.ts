import { z } from "zod";
import type { CriterionStatus, GateDecisionValue } from "@/lib/phases/types";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ULTRAPLAN VOCABULARY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This module is to lib/ultraplan what lib/phases/types.ts is to the gate: the
 * single place the words are defined, so blockers.ts, tasks.ts, graph.ts and
 * every component under components/canvas/ cannot quietly disagree about what
 * "blocked" means.
 *
 * It imports TYPES ONLY from lib/phases. Ultraplan is downstream of the gate —
 * it explains a verdict, it never produces one — and a value import would make
 * this file (and therefore the canvas) depend on phase definitions, prompts and
 * eventually the model adapters. Types are erased at build time; values are not.
 *
 * NOTHING HERE PERFORMS I/O. No model, no DB, no clock, no `Math.random`. That
 * is the property that lets every function in this directory be unit-tested
 * with all AI keys unset, and it is the same split gate.ts draws between its
 * pure half and its one injected async seam.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Blockers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How bad a blocker is — and, separately from that, whether we actually KNOW.
 *
 *  blocking — a criterion the phase declares BLOCKING is unmet or only partly
 *             evidenced. Confirmed gap, concrete task, phase advance refused.
 *  advisory — a criterion the phase declares ADVISORY is short. The gate WARNs;
 *             advance is permitted. Showing these as red is how a product
 *             teaches founders to ignore red.
 *  unknown  — the gate ran but could not determine this criterion's state
 *             ("not-evaluable"), or returned a criterion the phase does not
 *             define. We do not know how bad it is, so we do not claim to.
 *
 * `unknown` exists as its own severity precisely so that "we could not check"
 * never renders with the same affordance as "we checked and it is fine". The
 * separate `blocksAdvance` flag on Blocker carries the orthogonal question of
 * whether the gate will refuse to move on — an unknown BLOCKING criterion is
 * uncertain AND blocking, and squeezing both facts into one enum loses one.
 */
export const BLOCKER_SEVERITIES = ["blocking", "advisory", "unknown"] as const;
export type BlockerSeverity = (typeof BLOCKER_SEVERITIES)[number];

/**
 * What kind of move closes a blocker. The kind — not free text — is what the UI
 * switches on, so a renderer can never be surprised by a task shape it has no
 * affordance for.
 *
 *  answer-question — the judge named the single question that closes the gap.
 *  establish-fact  — an `artifact-exists` criterion wants a named project fact.
 *  raise-metric    — a `metric-threshold` criterion wants a number moved.
 *  satisfy-requirement / complete-phase / run-validator — the remaining
 *                    criterion types, kept distinct so nothing is silently
 *                    funnelled into a generic bucket.
 *  supply-evidence — the gate could not assess the criterion at all. The task
 *                    is to produce evidence, NOT to assert the criterion is met.
 *  close-gap       — the judge named a gap but no question and the criterion
 *                    type carries no target. Last resort, still specific.
 */
export const UNBLOCKING_TASK_KINDS = [
  "answer-question",
  "establish-fact",
  "raise-metric",
  "satisfy-requirement",
  "complete-phase",
  "run-validator",
  "supply-evidence",
  "close-gap",
] as const;
export type UnblockingTaskKind = (typeof UNBLOCKING_TASK_KINDS)[number];

/**
 * One concrete move a founder can make. Generated deterministically from the
 * verdict — there is no second model call here. A model-written task would be
 * unreproducible across renders, and this object's `id` is a React key and a
 * canvas node id: it MUST be the same on every render given the same verdict.
 */
export type UnblockingTask = {
  /** `${phaseKey}::${criterionId}::${kind}`. Stable across re-renders. */
  id: string;
  kind: UnblockingTaskKind;
  /** Imperative, one line. Rendered as the task node's title. */
  title: string;
  /** Why this task exists — the gap or criterion description. Never invented. */
  detail: string;
  /** The criterion this task closes. Links a task node back to the gate. */
  criterionId: string;
  /**
   * The project fact this task would establish, when the criterion names one.
   * graph.ts uses it to draw a task→fact edge when the fact already exists.
   */
  producesFactKey: string | null;
};

/** One thing standing between this project and the next phase. */
export type Blocker = {
  /** `${phaseKey}::${criterionId}`. Stable across re-renders. */
  id: string;
  criterionId: string;
  /**
   * The gap sentence, in the judge's words. Named `blocker` rather than `gap`
   * to match the plan's `{blocker, severity, unblocking_task[]}` shape.
   */
  blocker: string;
  severity: BlockerSeverity;
  /**
   * Whether the gate will REFUSE to advance while this stands. Derived from the
   * criterion's declared severity, defaulting to `true` for a criterion the
   * phase does not define — the same fail-closed default gate.ts uses in
   * `severityOf.get(id) ?? "blocking"`.
   */
  blocksAdvance: boolean;
  /** The judge's per-criterion status this blocker was derived from. */
  status: CriterionStatus;
  /**
   * The plan spells this `unblocking_task[]`. Renamed to house camelCase; the
   * contents are unchanged.
   */
  unblockingTasks: UnblockingTask[];
};

/**
 * The four states a phase can be in, and the reason this enum has four members
 * instead of reusing GateDecisionValue.
 *
 * `unassessed` is the state components/phase-rail.tsx currently collapses with
 * `data.decision ?? "BLOCK"`: a project on turn 1, whose gate has never run,
 * renders a red BLOCKED badge — contradicting the phase directive that tells
 * the founder to just start talking. "We have not looked yet" and "we looked
 * and you are blocked" are different facts about the world and must not share
 * a rendering. Every consumer in this directory switches on this enum, so the
 * distinction cannot be lost downstream.
 */
export const BLOCKER_ANALYSIS_STATES = [
  /** The gate has never produced a verdict for this phase. NOT "blocked". */
  "unassessed",
  /** Assessed, nothing outstanding. */
  "clear",
  /** Assessed; gaps exist but none of them refuses advance. */
  "advisory",
  /** Assessed; at least one blocker refuses advance. */
  "blocked",
] as const;
export type BlockerAnalysisState = (typeof BLOCKER_ANALYSIS_STATES)[number];

export type BlockerAnalysis = {
  state: BlockerAnalysisState;
  /** NULL exactly when state === "unassessed". */
  decision: GateDecisionValue | null;
  /**
   * Ordered blocking-first, then unknown, then advisory. Empty when the phase
   * is `clear` AND when it is `unassessed` — an unassessed phase invents no
   * blockers, because it has no evidence that anything is wrong.
   */
  blockers: Blocker[];
  /**
   * Flat, deduplicated task list across all blockers, in blocker order. What
   * the task lane of the canvas renders.
   */
  tasks: UnblockingTask[];
  /**
   * The gate's own one-line rationale, passed through untouched so the canvas
   * can show the founder the reasoning rather than a recomputed paraphrase.
   * NULL when unassessed.
   */
  reason: string | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Tasks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Task lifecycle.
 *
 * `unknown` is first and is the parse failure state: a task row read back from
 * storage whose state string we do not recognise lands here. It is deliberately
 * NOT "todo" — silently normalising an unreadable state to a known one is how a
 * persistence bug becomes an invisible data-loss bug — and it is very
 * deliberately not "done".
 *
 * `dropped` is the founder explicitly deciding a task does not apply. It is
 * distinct from `done` because the canvas must never let "I am not doing this"
 * read as evidence that the underlying criterion was satisfied.
 */
export const TASK_STATES = [
  "unknown",
  "todo",
  "active",
  "blocked",
  "done",
  "dropped",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** The events a UI may fire at a task. Closed set — see tasks.ts for the table. */
export const TASK_EVENTS = [
  "start",
  "block",
  "unblock",
  "complete",
  "reopen",
  "drop",
  "restore",
] as const;
export type TaskEvent = (typeof TASK_EVENTS)[number];

/** An unblocking task plus the mutable state a founder drives. */
export type CanvasTask = UnblockingTask & {
  state: TaskState;
  /**
   * TRUE when this task survives in storage but the current verdict no longer
   * reports the blocker it came from. It is NOT auto-completed: the gate not
   * mentioning a gap is not the same signal as the gap being closed (a coverage
   * mismatch produces exactly that silence), and auto-completing on silence is
   * the "done" that fail-closed forbids.
   */
  orphaned: boolean;
};

/**
 * The persisted shape.
 *
 * Lenient on purpose: this parses a `json` column, i.e. genuinely `unknown`,
 * and a strict schema would throw on one bad row and take the whole canvas down
 * with it. Every field except `id` has a `.catch()` fallback, so a row survives
 * partial corruption; `id` has none, because a task that cannot be matched to a
 * blocker or keyed in React is not recoverable.
 *
 * `state` is typed `string`, NOT `z.enum(TASK_STATES)`, so an unrecognised
 * value survives parsing and is then normalised by parseTaskState() — which
 * fails closed to "unknown". A z.enum here would drop the whole row, losing the
 * founder's task because we could not read one field of it.
 *
 * The display fields are a SNAPSHOT of the task as generated. They exist only
 * so an orphaned task — one whose blocker no longer appears in the current
 * verdict — can still be rendered instead of vanishing. When a matching
 * generated task exists, its wording wins (see reconcileTasks).
 */
export const StoredTaskSchema = z.object({
  id: z.string().min(1),
  state: z.string().catch("unknown"),
  title: z.string().catch(""),
  detail: z.string().catch(""),
  criterionId: z.string().catch(""),
  producesFactKey: z.string().nullable().catch(null),
});
export type StoredTask = z.infer<typeof StoredTaskSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Canvas graph
// ─────────────────────────────────────────────────────────────────────────────

/** The four node types Step 7 specifies. Closed set; renderers exhaust it. */
export const CANVAS_NODE_TYPES = [
  "artifact",
  "fact",
  "persona",
  "task",
] as const;
export type CanvasNodeType = (typeof CANVAS_NODE_TYPES)[number];

/**
 * How much the canvas is entitled to claim about a node.
 *
 *  unknown     — the underlying state could not be determined. THE DEFAULT for
 *                every node builder in graph.ts. A node whose backing row is
 *                missing a field renders here, never as `confirmed`.
 *  provisional — it exists, but it is under-evidenced (a low-confidence fact, a
 *                persona with no evidence entries, a task nobody has started).
 *  confirmed   — evidenced. The ONLY status a renderer may draw as "done", and
 *                the only one no code path reaches by defaulting.
 *  at-risk     — actively failing: a blocked task, a task attached to a blocker
 *                that still refuses advance, or a persona asserted with zero
 *                evidence entries.
 */
export const CANVAS_NODE_STATUSES = [
  "unknown",
  "provisional",
  "confirmed",
  "at-risk",
] as const;
export type CanvasNodeStatus = (typeof CANVAS_NODE_STATUSES)[number];

export type CanvasPosition = { x: number; y: number };

type CanvasNodeBase = {
  id: string;
  position: CanvasPosition;
  title: string;
  /** One supporting line, always taken from real data. NULL when absent. */
  subtitle: string | null;
  status: CanvasNodeStatus;
};

export type CanvasFactNode = CanvasNodeBase & {
  type: "fact";
  factKey: string;
  /** 0-100, or NULL when the stored value was not a usable integer. */
  confidence: number | null;
  /** Provenance: the phase that last wrote the fact. */
  phaseKey: string | null;
};

export type CanvasArtifactNode = CanvasNodeBase & {
  type: "artifact";
  documentId: string;
  kind: string | null;
};

export type CanvasPersonaNode = CanvasNodeBase & {
  type: "persona";
  personaId: string;
  /** Step 6 makes `evidence[]` mandatory; 0 is a real and visible failure. */
  evidenceCount: number | null;
};

export type CanvasTaskNode = CanvasNodeBase & {
  type: "task";
  task: CanvasTask;
};

export type CanvasNode =
  | CanvasFactNode
  | CanvasArtifactNode
  | CanvasPersonaNode
  | CanvasTaskNode;

/**
 * Edge semantics. Every kind is a claim about the project, so each one has to
 * be justified by data the caller actually holds — none is inferred by
 * similarity, and there is no "related" catch-all to hide a guess in.
 */
export const CANVAS_EDGE_KINDS = [
  /** artifact → fact: the artifact cites the fact. */
  "cites",
  /** persona → fact: the persona was derived from the fact. */
  "derived-from",
  /** task → fact: completing the task establishes or revises the fact. */
  "produces",
  /** task → task: the source cannot start until the target is done. */
  "depends-on",
] as const;
export type CanvasEdgeKind = (typeof CANVAS_EDGE_KINDS)[number];

export type CanvasEdge = {
  id: string;
  source: string;
  target: string;
  kind: CanvasEdgeKind;
};

/** A relation whose endpoints did not both resolve. Reported, never swallowed. */
export type DroppedEdge = {
  source: string;
  target: string;
  kind: CanvasEdgeKind;
  reason: string;
};

export type CanvasGraph = {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /**
   * Phase-level state, carried on the graph so the canvas chrome can render
   * "not assessed yet" differently from "blocked" without re-deriving it.
   */
  assessment: BlockerAnalysisState;
  /**
   * Edges dropped because an endpoint did not resolve to a node. Surfaced so a
   * missing relation is a visible defect rather than a silently thinner graph.
   */
  droppedEdges: DroppedEdge[];
};
