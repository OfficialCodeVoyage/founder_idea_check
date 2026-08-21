import type { PersonaArtifact } from "@/lib/personas/types";
import type { StoredFact } from "@/lib/phases/context";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS MODULE IS FOR, AND THE ONE RULE IT ENFORCES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The handoff is the end of the funnel: the founder walks away with a real git
 * repository containing a PRD, a CLAUDE.md and a .planning/ roadmap, all of it
 * built from what the eight gates actually certified.
 *
 * THE RULE: **a generated document may not contain a claim about the project
 * that is not backed by a stored ProjectFact.** A PRD that invents a market
 * size is strictly worse than no PRD, because it launders a guess into a
 * finding — the exact failure this whole product exists to prevent. So every
 * project-specific statement in every generated file is one of:
 *
 *   • `established`     — a fact row exists; its value is rendered verbatim,
 *                          with its confidence and originating phase attached.
 *   • `not-established` — no fact row exists; the document says so out loud and
 *                          makes NO claim. It never omits the heading, because
 *                          a silently missing section reads as "not relevant"
 *                          rather than "never answered".
 *
 * Low confidence is a third state layered on `established`: the value is shown,
 * but marked, and repeated in a dedicated "unverified" list. A 30/100 fact
 * rendered identically to a 95/100 fact is silent promotion, and silent
 * promotion is fabrication with extra steps.
 *
 * DISCIPLINE (copied from lib/phases/gate.ts): everything in lib/export except
 * node-writer.ts is PURE — no fs, no network, no model, no clock, no
 * randomness. `generatedAt` is injected rather than read from Date.now() so the
 * same snapshot produces byte-identical files forever. node-writer.ts is the
 * single seam that touches the filesystem and git.
 */

/**
 * One file in the exported repository.
 *
 * `path` is ALWAYS POSIX and ALWAYS relative to the repo root — never absolute,
 * never platform-native. The pure layer has no idea where the repo will land,
 * and that ignorance is what makes path escape checkable in one place
 * (assertSafeTree) instead of at every join site.
 */
export type ExportFile = {
  path: string;
  contents: string;
};

/** The bits of the `Project` row the export reads. Nothing else is needed. */
export type ExportProject = {
  /**
   * UNTRUSTED. Project names are typed by the founder and, in some flows,
   * suggested by a model. This string is a candidate for the repo DIRECTORY
   * name, so it goes through slugifySegment() and never near a path raw.
   */
  name: string;
  /** Free-text project instructions. Rendered, never used as a path. */
  instructions: string;
};

export const EXPORT_PHASE_STATUSES = ["locked", "active", "passed"] as const;
export type ExportPhaseStatus = (typeof EXPORT_PHASE_STATUSES)[number];

export const EXPORT_GATE_DECISIONS = ["PASS", "WARN", "BLOCK"] as const;
export type ExportGateDecision = (typeof EXPORT_GATE_DECISIONS)[number];

/**
 * A `ProjectPhase` row flattened for the export.
 *
 * `missing` is pre-extracted from the stored GateVerdict blob by the pure
 * adapter in grounding.ts, so nothing downstream ever has to reach into a
 * `json` column and guess at its shape.
 */
export type ExportPhaseState = {
  phaseKey: string;
  status: ExportPhaseStatus;
  /** NULL when the gate has never run for this phase. */
  decision: ExportGateDecision | null;
  /** The deterministic one-line rationale decideGate() produced. */
  reason: string | null;
  /** The single question that would close the gap. NULL on PASS. */
  nextQuestion: string | null;
  /** Ordered gap sentences from the last verdict. Empty when unknown. */
  missing: string[];
};

/**
 * One persona document, reduced to its NEWEST version.
 *
 * THE UNION IS THE POINT. A stored row that fails `parsePersonaArtifact` still
 * has to reach the document: dropping it would make "generated but unreadable"
 * indistinguishable from "never generated", which is the same distinction
 * `not-established` protects for facts. Neither may be silently rendered as a
 * persona.
 */
export type ExportPersona =
  | {
      status: "readable";
      documentId: string;
      version: number;
      title: string;
      artifact: PersonaArtifact;
    }
  | {
      status: "unreadable";
      documentId: string;
      version: number;
      title: string;
    };

/** Everything buildHandoff needs. No DB handle, no clock, no filesystem. */
export type BuildHandoffInput = {
  project: ExportProject;
  /** EVERY fact for the project. The export is never token-budgeted. */
  facts: StoredFact[];
  /** Phase rows. A phase with no row is treated as `locked`, never as passed. */
  phases: ExportPhaseState[];
  /**
   * The newest version of each persona document for the project. Version
   * HISTORY is not exported.
   *
   * REQUIRED, not optional-with-a-default. An optional field means the next
   * caller that forgets it exports a repository with the persona silently
   * missing — which is the bug this field exists to fix. Required makes every
   * call site a compile error until it is answered.
   */
  personas: ExportPersona[];
  /**
   * Stamped into the generated documents as provenance.
   *
   * INJECTED, not read from a clock. Two runs over the same snapshot must
   * produce byte-identical files, and an ambient `new Date()` would make the
   * output untestable and the diff noisy for no gain.
   */
  generatedAt: Date;
  /**
   * Optional explicit repo directory name. Slugified like every other
   * candidate — an override is not a trust boundary.
   */
  repoName?: string;
};

/**
 * How much of the workflow the founder actually finished.
 *
 * `empty` is a REFUSAL state, not a degraded one: see decideExportReadiness.
 */
export const EXPORT_READINESS = ["empty", "partial", "complete"] as const;
export type ExportReadinessLevel = (typeof EXPORT_READINESS)[number];

export type ExportReadiness = {
  level: ExportReadinessLevel;
  /** Phase keys whose stored decision is PASS. */
  passedPhaseKeys: string[];
  /** Total phases defined in the workflow (8). */
  phaseCount: number;
  /** How many distinct fact keys are stored. */
  factCount: number;
  /** Human-readable sentence naming the rule that produced `level`. */
  reason: string;
};

/**
 * The output of the pure half: a fully described repository, plus everything
 * the caller needs to explain the result without re-deriving it.
 */
export type HandoffPlan = {
  /** Slugified directory name for the repo. Safe by construction. */
  repoName: string;
  /** Every file, POSIX-relative, sorted by path for a stable diff. */
  files: ExportFile[];
  /** The first-commit message. Contains no fact values. */
  commitMessage: string;
  readiness: ExportReadiness;
  /** Fact keys the workflow defines but the project never established. */
  notEstablishedKeys: string[];
  /** Established fact keys below the low-confidence ceiling. */
  lowConfidenceKeys: string[];
  /**
   * Stored fact keys that belong to NO phase vocabulary. They are still
   * exported (dropping a founder's data silently is not an option) but they are
   * listed here and quarantined into their own document section.
   */
  unrecognizedKeys: string[];
};

/**
 * buildHandoff refuses rather than producing an empty shell. A repo full of
 * "not established" headings looks like a plan from ten feet away, and the
 * founder would ship it. Refusing is the fail-closed default.
 */
export type HandoffOutcome =
  | { status: "refused"; reason: string; readiness: ExportReadiness }
  | { status: "ready"; plan: HandoffPlan; readiness: ExportReadiness };

// ─────────────────────────────────────────────────────────────────────────────
// The writer seam. Types live here; the only implementation lives in
// node-writer.ts, which is the only file in lib/export that imports node:fs.
// ─────────────────────────────────────────────────────────────────────────────

export type WriteHandoffRequest = {
  /**
   * Absolute path of the directory that will CONTAIN the repo. The repo itself
   * lands at `join(targetDir, plan.repoName)`.
   */
  targetDir: string;
  plan: HandoffPlan;
  /**
   * Refuse to write into a non-empty repo directory unless this is explicitly
   * true. Clobbering a founder's existing work is unrecoverable; asking is not.
   */
  overwrite?: boolean;
  /** Author for the first commit. Defaults in node-writer.ts. */
  author?: { name: string; email: string };
};

/**
 * Git is reported as a DISCRIMINATED OUTCOME, never as a boolean and never
 * swallowed. `git` may be absent, may refuse to sign, may be a wrapper that
 * fails — and in every one of those cases the FILES are already on disk and
 * are still worth having. Returning `failed` with a reason lets the caller say
 * "your repo is at X but git init failed because Y", which is actionable.
 * Throwing would hide the files; returning `true`/`false` would hide the why.
 */
export type HandoffGitOutcome =
  | { status: "committed"; sha: string; branch: string }
  | { status: "failed"; reason: string };

export type HandoffWriteResult = {
  /** Absolute path of the repo that was written. */
  repoDir: string;
  /** POSIX-relative paths actually written, in write order. */
  written: string[];
  git: HandoffGitOutcome;
};

/**
 * THE SEAM. One injected async function. Tests pass a plain closure that
 * records what it was asked to write; production passes
 * createNodeHandoffWriter().
 *
 * Nothing in lib/export except node-writer.ts imports node:fs or
 * node:child_process. That is the property that makes this whole feature
 * runnable under vitest with no filesystem, no git binary and no API key.
 */
export type HandoffWriter = (
  request: WriteHandoffRequest
) => Promise<HandoffWriteResult>;

export type HandoffDeps = {
  write: HandoffWriter;
};
