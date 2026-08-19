/**
 * Shared vocabulary for the research fan-out.
 *
 * This file is types only. It imports nothing, so every module below it stays
 * runnable under vitest with no API key, no network and no database — the same
 * property `lib/phases/types.ts` buys for the gate.
 */

/** One role-specialised researcher in the fan-out. */
export type ResearchRole = {
  /** Stable id, used in logs and in the per-role result map. */
  id: string;
  /** Human-readable label for the UI. */
  label: string;
  /**
   * The role's system prompt. Four of these run concurrently over the same
   * brief — that is the whole point of the fan-out, and it is why the
   * supervisor must be parallel rather than a queue.
   */
  systemPrompt: string;
  /**
   * Source ids this role is allowed to draw on. Empty means "every enabled
   * source". Named explicitly so a demand-signal role cannot silently start
   * reading a source the operator disabled.
   */
  sourceIds: readonly string[];
};

/** A single piece of evidence a researcher found. */
export type ResearchLearning = {
  /** The claim, in one sentence. */
  text: string;
  /** Where it came from. Empty is not permitted — see `sanitizeLearnings`. */
  url: string;
  /** Which role found it. Lets the report attribute divergent readings. */
  roleId: string;
};

/**
 * What one researcher produced.
 *
 * `failures` is NOT optional and NOT swallowed. dzhng's original loop catches
 * every error and returns `{ learnings: [], visitedUrls: [] }`, which makes
 * "every query 403'd" and "the topic genuinely has no coverage" the same
 * observable result. That is the exact silent-fallback this fork bars.
 */
export type ResearchResult = {
  roleId: string;
  learnings: ResearchLearning[];
  visitedUrls: string[];
  /** Named, surfaced failures. An empty result WITH failures is a broken run. */
  failures: ResearchFailure[];
};

export type ResearchFailureKind =
  /** The provider answered 403. Expected from a datacenter IP — see signals/. */
  | "source-blocked"
  /** The provider was unreachable or timed out. */
  | "source-unavailable"
  /** The model call failed. */
  | "model-call-failed"
  /** The model answered, but not in the shape we asked for. */
  | "model-schema-mismatch"
  /** The run was cancelled by its AbortSignal. */
  | "aborted";

export type ResearchFailure = {
  kind: ResearchFailureKind;
  /** Which query or source produced it, so the message names the real cause. */
  subject: string;
  detail: string;
};

/** How wide and how deep one researcher searches. */
export type ResearchShape = {
  /** Queries generated at the top level. */
  breadth: number;
  /** How many times the loop recurses. `1` means no recursion. */
  depth: number;
};
