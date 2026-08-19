import type {
  ResearchFailure,
  ResearchLearning,
  ResearchResult,
  ResearchRole,
} from "./types";

/**
 * THE PARALLEL SUPERVISOR. This file replaces
 * `tools/platform/deep-research/supervisor-agent.ts`.
 *
 * WHAT WAS WRONG WITH THE ONE IT REPLACES. That file builds a `conductResearch`
 * tool whose execute body is:
 *
 *     researchQueue = researchQueue.then(() => runResearcher(topic, options));
 *     return researchQueue as Promise<string>;
 *
 * Every call chains onto the previous promise, so N research topics run
 * strictly one after another — while the very same function passes
 * `max_concurrent_research_units` into `leadResearcherPrompt`, telling the model
 * it may request up to N topics in parallel. The config value was documentation,
 * not a limit. The result is a fan-out that costs the same as a fan-out and
 * takes N times as long, and nothing in the type system or the tests notices.
 *
 * The replacement honours that same config value as an actual bound: a counting
 * semaphore admits up to `maxConcurrent` researchers at once and makes the rest
 * wait. `runFanOut` is the parallel version; the sequential queue is gone.
 *
 * SHAPE. Same discipline as `lib/phases/gate.ts` — a pure half that is fully
 * unit-tested (planning, overflow, merge, summary) and ONE injected async seam
 * (`ResearcherRunner`) for the part that calls a model. This file imports
 * nothing from `ai`, `@/lib/ai/*` or `@/lib/db/*`, which is what lets its tests
 * run with every API key unset.
 */

// ─────────────────────────────────────────────────────────────────────────────
// (a) THE SEMAPHORE. No I/O, no clock — deterministic and directly testable.
// ─────────────────────────────────────────────────────────────────────────────

export type Semaphore = {
  /** Resolves when a slot is free. The returned function releases it. */
  acquire: () => Promise<() => void>;
  /** How many slots are in use right now. Exposed so tests can assert the bound. */
  readonly inFlight: number;
  /** How many callers are queued behind a full semaphore. */
  readonly waiting: number;
};

/**
 * A counting semaphore.
 *
 * `limit` is asserted rather than clamped. A limit of 0 would deadlock every
 * caller forever and a fractional limit would admit a nonsense number of
 * researchers; both are bugs at the call site, and swallowing them here would
 * turn a loud failure into a hang, which is far worse to diagnose.
 */
export function createSemaphore(limit: number): Semaphore {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(
      `Semaphore limit must be a positive integer, got ${String(limit)}. A zero or fractional limit deadlocks the fan-out rather than failing.`
    );
  }

  let inFlight = 0;
  const queue: (() => void)[] = [];

  const release = () => {
    inFlight--;
    const next = queue.shift();
    if (next) {
      inFlight++;
      next();
    }
  };

  return {
    acquire() {
      if (inFlight < limit) {
        inFlight++;
        return Promise.resolve(release);
      }
      return new Promise<() => void>((resolve) => {
        queue.push(() => resolve(release));
      });
    },
    get inFlight() {
      return inFlight;
    },
    get waiting() {
      return queue.length;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// (b) THE PURE PART. Planning, overflow, merge, summary. All unit-tested.
// ─────────────────────────────────────────────────────────────────────────────

export type FanOutPlan = {
  roles: ResearchRole[];
  /** The bound actually applied — never larger than the number of roles. */
  effectiveConcurrency: number;
  /**
   * How many sequential waves this implies. `1` means fully parallel, which is
   * the target: the Step 5 gate wants wall-clock under 1.5x a single
   * researcher, and that is only reachable at one wave.
   */
  waveCount: number;
};

/**
 * PURE. Turns a role list plus a configured bound into the plan that will
 * actually be executed.
 *
 * Throws rather than returning an empty plan for an empty role list. A fan-out
 * over zero researchers would return a clean, cited, entirely evidence-free
 * report — the research equivalent of the gate's 0-of-0 bug, and it fails the
 * same way: silently and confidently.
 */
export function planFanOut(
  roles: readonly ResearchRole[],
  maxConcurrent: number
): FanOutPlan {
  if (roles.length === 0) {
    throw new Error(
      "Cannot fan out over zero research roles — a run with no researchers would produce an empty report that reads as a complete one."
    );
  }
  const ids = new Set<string>();
  for (const role of roles) {
    if (ids.has(role.id)) {
      throw new Error(
        `Duplicate research role id "${role.id}". Role ids key the per-role result map, so a duplicate silently discards one researcher's findings.`
      );
    }
    ids.add(role.id);
  }
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error(
      `max_concurrent_research_units must be a positive integer, got ${String(maxConcurrent)}.`
    );
  }

  const effectiveConcurrency = Math.min(maxConcurrent, roles.length);
  return {
    roles: [...roles],
    effectiveConcurrency,
    waveCount: Math.ceil(roles.length / effectiveConcurrency),
  };
}

export type OverflowNotice = {
  requested: number;
  allowed: number;
  /** Text handed back TO THE MODEL, not to the user. */
  message: string;
};

/**
 * PURE. `langchain-ai/open_deep_research` handles a supervisor that asks for
 * more parallel units than the config allows by truncating the list and
 * TELLING THE MODEL it was truncated (`deep_researcher.py`, the overflow branch
 * after the `asyncio.gather`), rather than silently dropping the tail.
 *
 * Reimplemented here rather than copied. The reason the notice matters: a
 * supervisor that asked for eight topics and got five answers, with no
 * indication that three were dropped, will conclude those three topics returned
 * nothing — and will write that non-finding into the report as a finding.
 *
 * Returns `null` when nothing overflowed, so the caller adds no noise to a
 * normal run.
 */
export function decideOverflow(
  requested: number,
  allowed: number
): OverflowNotice | null {
  if (!(Number.isInteger(requested) && Number.isInteger(allowed))) {
    return null;
  }
  if (requested <= allowed) {
    return null;
  }
  const dropped = requested - allowed;
  return {
    requested,
    allowed,
    message: `You requested ${requested} concurrent research units but only ${allowed} are permitted, so ${dropped} were NOT run. Do not treat the missing ${dropped} as having returned no results. Re-request them in a later iteration if they still matter.`,
  };
}

/**
 * PURE. Drops learnings that cannot be cited, then dedupes.
 *
 * An uncitable learning is worse than a missing one: the report renders it with
 * `inline-citation` machinery around an empty href, and a founder reads a
 * confident, sourced-looking claim that traces to nothing. No url, no learning.
 */
export function sanitizeLearnings(
  learnings: readonly ResearchLearning[]
): ResearchLearning[] {
  const seen = new Set<string>();
  const kept: ResearchLearning[] = [];
  for (const learning of learnings) {
    const text = learning.text.trim();
    const url = learning.url.trim();
    if (text.length === 0 || url.length === 0) {
      continue;
    }
    const key = `${text.toLowerCase()}::${url.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    kept.push({ ...learning, text, url });
  }
  return kept;
}

export type FanOutSummary = {
  /** Deduped across every role, citations preserved. */
  learnings: ResearchLearning[];
  visitedUrls: string[];
  failures: ResearchFailure[];
  /** Role ids that produced at least one citable learning. */
  rolesWithFindings: string[];
  /** Role ids that produced nothing at all. */
  rolesWithoutFindings: string[];
  /**
   * True when EVERY role came back empty AND at least one named a failure.
   * This is the case the caller must not render as a report: an empty run
   * caused by blocked sources looks exactly like an empty run caused by an
   * obscure topic, and only this flag tells them apart.
   */
  emptyBecauseOfFailures: boolean;
};

/** PURE. Merges per-role results without hiding what went wrong. */
export function summarizeFanOut(
  results: readonly ResearchResult[]
): FanOutSummary {
  const learnings = sanitizeLearnings(results.flatMap((r) => r.learnings));
  const visitedUrls = [
    ...new Set(
      results.flatMap((r) => r.visitedUrls).filter((u) => u.trim().length > 0)
    ),
  ];
  const failures = results.flatMap((r) => r.failures);

  const rolesWithFindings: string[] = [];
  const rolesWithoutFindings: string[] = [];
  for (const result of results) {
    const target = sanitizeLearnings(result.learnings).length
      ? rolesWithFindings
      : rolesWithoutFindings;
    target.push(result.roleId);
  }

  return {
    learnings,
    visitedUrls,
    failures,
    rolesWithFindings,
    rolesWithoutFindings,
    emptyBecauseOfFailures: learnings.length === 0 && failures.length > 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// (c) THE IMPURE PART. One injected seam, one async function.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE SEAM. Everything that calls a model or the network lives behind this one
 * function type. Tests pass a plain async closure; the route passes an adapter
 * built over `runResearcher`.
 */
export type ResearcherRunner = (
  role: ResearchRole,
  brief: string,
  abortSignal?: AbortSignal
) => Promise<ResearchResult>;

export type FanOutDeps = {
  runResearcher: ResearcherRunner;
  /**
   * Optional progress sink. Injected rather than imported for the same reason
   * `extract.ts` injects `onError`: importing the logger would drag
   * `server-only` into vitest and this file would stop being testable.
   */
  onRoleSettled?: (result: ResearchResult) => void;
};

export type FanOutInput = {
  brief: string;
  roles: readonly ResearchRole[];
  /** Pass `config.ai.tools.deepResearch.maxConcurrentResearchUnits` here. */
  maxConcurrent: number;
  abortSignal?: AbortSignal;
};

export type FanOutOutcome = {
  plan: FanOutPlan;
  results: ResearchResult[];
  summary: FanOutSummary;
  /** Peak observed concurrency. The proof the fan-out actually fanned out. */
  peakConcurrency: number;
};

function failureResult(
  role: ResearchRole,
  failure: ResearchFailure
): ResearchResult {
  return {
    roleId: role.id,
    learnings: [],
    visitedUrls: [],
    failures: [failure],
  };
}

/**
 * Runs every role concurrently, bounded by `maxConcurrent`.
 *
 * NEVER REJECTS. A researcher that throws becomes a `ResearchResult` carrying a
 * named failure, so one blocked source cannot take down the other three roles —
 * `Promise.all` over raw runners would reject the whole fan-out on the first
 * 403, which is precisely the datacenter-IP case we expect to hit.
 *
 * But it does not swallow either: the failure is in the result, it is in the
 * summary, and `emptyBecauseOfFailures` tells the caller when the report would
 * be a lie.
 */
export async function runFanOut(
  deps: FanOutDeps,
  input: FanOutInput
): Promise<FanOutOutcome> {
  const plan = planFanOut(input.roles, input.maxConcurrent);
  const semaphore = createSemaphore(plan.effectiveConcurrency);

  let peakConcurrency = 0;
  let active = 0;

  const results = await Promise.all(
    plan.roles.map(async (role): Promise<ResearchResult> => {
      const release = await semaphore.acquire();
      active++;
      peakConcurrency = Math.max(peakConcurrency, active);
      try {
        if (input.abortSignal?.aborted) {
          return failureResult(role, {
            kind: "aborted",
            subject: role.id,
            detail: "the run was cancelled before this researcher started",
          });
        }
        const result = await deps.runResearcher(
          role,
          input.brief,
          input.abortSignal
        );
        deps.onRoleSettled?.(result);
        return result;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const result = failureResult(role, {
          kind: input.abortSignal?.aborted ? "aborted" : "model-call-failed",
          subject: role.id,
          detail,
        });
        deps.onRoleSettled?.(result);
        return result;
      } finally {
        active--;
        release();
      }
    })
  );

  return {
    plan,
    results,
    summary: summarizeFanOut(results),
    peakConcurrency,
  };
}
