import { z } from "zod";
import { nextBreadth, nextDepth } from "./budget";
import { sanitizeLearnings } from "./supervisor";
import type {
  ResearchFailure,
  ResearchLearning,
  ResearchResult,
  ResearchRole,
  ResearchShape,
} from "./types";

/**
 * THE RESEARCH LOOP. Ported from `dzhng/deep-research` `src/deep-research.ts`
 * @ `1f8f3e285bbc23e80b98a66a64effab9069f3ad4` (MIT).
 *
 * PORTED, NOT COPIED. Upstream targets `ai@4` and `zod@3`; this repo is
 * `ai@6.0.219` and `zod@^4.3.6`, so the `generateObject` call sites, the schema
 * builders and the module-level provider singletons all had to change. What
 * survives verbatim is the ALGORITHM, which is the part worth taking:
 *
 *   - generate `breadth` SERP queries from the brief plus prior learnings,
 *   - run them under a concurrency limit (upstream `pLimit`, line 216),
 *   - halve the breadth and decrement the depth on recursion (line 230:
 *     `const newBreadth = Math.ceil(breadth / 2)`),
 *   - accumulate learnings and visited urls down the tree.
 *
 * THE ONE DELIBERATE DIVERGENCE. Upstream's per-query catch is:
 *
 *     } catch (e: any) {
 *       ...
 *       return { learnings: [], visitedUrls: [] };
 *     }
 *
 * which makes "every source 403'd" indistinguishable from "this topic has no
 * coverage". Since the keyless adapters were only ever verified from a
 * residential IP and are expected to 403 from a datacenter egress range, that
 * is the single most likely failure this fork will hit in production — and
 * upstream's version of it reports success. Here every failure becomes a named
 * `ResearchFailure` that rides out with the result. Nothing is swallowed.
 *
 * SHAPE. Pure half (prompts, schemas, descent, merge) is fully unit-tested. One
 * injected `LoopDeps` object holds every call that touches a model or the
 * network. This file imports neither `ai` nor `@/lib/ai/*`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// (a) SCHEMAS. zod 4. Parsed defensively — the seam returns `unknown`.
// ─────────────────────────────────────────────────────────────────────────────

export const SerpQuerySchema = z.object({
  query: z.string().describe("The search query"),
  researchGoal: z
    .string()
    .describe(
      "What this query is meant to establish, then how to go deeper once results are in. Be specific about the follow-up directions."
    ),
});

export const SerpQueriesOutputSchema = z.object({
  queries: z.array(SerpQuerySchema),
});

export const LearningsOutputSchema = z.object({
  learnings: z
    .array(
      z.object({
        text: z
          .string()
          .describe(
            "One concrete finding in a single sentence. Include names, numbers and dates."
          ),
        url: z
          .string()
          .describe(
            "The exact url this finding came from. A finding with no url is discarded."
          ),
      })
    )
    .describe("Findings supported by the supplied contents"),
  followUpQuestions: z
    .array(z.string())
    .describe("Questions the contents raised but did not answer"),
});

export type SerpQuery = z.infer<typeof SerpQuerySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// (b) THE PURE PART.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PURE. The descent rule, isolated so `budget.ts` and `loop.ts` provably agree.
 * A projection computed from a different rule than the loop walks is not a
 * projection, it is a guess.
 */
export function descendShape(shape: ResearchShape): ResearchShape {
  return {
    breadth: nextBreadth(shape.breadth),
    depth: nextDepth(shape.depth),
  };
}

export type QueryPlanRequest = {
  system: string;
  prompt: string;
  /** Passed through untouched so an adapter can size the call. */
  maxQueries: number;
};

/** PURE. Builds the query-planning prompt. */
export function buildQueryPlanPrompt(input: {
  role: ResearchRole;
  brief: string;
  breadth: number;
  priorLearnings: readonly ResearchLearning[];
}): QueryPlanRequest {
  const { role, brief, breadth, priorLearnings } = input;

  const learningsBlock =
    priorLearnings.length === 0
      ? ""
      : `\n\nFindings so far — use them to make the next queries MORE specific, not to repeat them:\n${priorLearnings
          .map((l) => `- ${l.text}`)
          .join("\n")}`;

  return {
    system: role.systemPrompt,
    prompt: `Generate at most ${breadth} search queries that would advance this research brief. Each query must be distinct from the others — near-duplicates waste the budget on the same page twice.

<brief>${brief}</brief>${learningsBlock}`,
    maxQueries: breadth,
  };
}

export type LearningExtractionRequest = {
  system: string;
  prompt: string;
};

/** PURE. Builds the learning-extraction prompt from fetched contents. */
export function buildLearningPrompt(input: {
  role: ResearchRole;
  query: string;
  contents: readonly { url: string; text: string }[];
  maxLearnings: number;
  maxFollowUps: number;
}): LearningExtractionRequest {
  const { role, query, contents, maxLearnings, maxFollowUps } = input;

  const body = contents
    .map((c) => `<content url="${c.url}">\n${c.text}\n</content>`)
    .join("\n");

  return {
    system: role.systemPrompt,
    prompt: `From the contents below, returned for the query <query>${query}</query>, extract at most ${maxLearnings} findings and at most ${maxFollowUps} follow-up questions.

Rules:
- Every finding MUST carry the url of the content it came from, copied exactly from that content's url attribute. A finding you cannot attribute is one you must not return.
- Findings must be concrete and information-dense: names, companies, products, exact metrics, numbers, dates.
- Do not restate the query back as a finding.
- Returning fewer findings than the maximum is correct when the contents support fewer. An empty list is a valid answer.

<contents>${body}</contents>`,
  };
}

/**
 * PURE. Trims a fetched page to a token-ish budget before it enters a prompt.
 *
 * Character-based rather than tokeniser-based on purpose: a tokeniser here
 * would be a runtime dependency inside the pure half, and the number this feeds
 * is a pessimistic upper bound anyway (see `budget.ts`). Upstream trims to
 * 25,000 characters per page; the same figure is kept so `DEFAULT_COST_MODEL`
 * stays honest.
 */
export const MAX_CONTENT_CHARS = 25_000;

export function trimContent(
  text: string,
  maxChars = MAX_CONTENT_CHARS
): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n[truncated at ${maxChars} characters]`;
}

/** PURE. Drops empty and duplicate queries; caps at `max`. */
export function sanitizeQueries(
  queries: readonly SerpQuery[],
  max: number
): SerpQuery[] {
  const seen = new Set<string>();
  const kept: SerpQuery[] = [];
  for (const q of queries) {
    const query = q.query.trim();
    if (query.length === 0) {
      continue;
    }
    const key = query.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    kept.push({ query, researchGoal: q.researchGoal.trim() });
    if (kept.length >= max) {
      break;
    }
  }
  return kept;
}

/** PURE. Merges child results into a parent's accumulator. */
export function mergeResults(
  roleId: string,
  parts: readonly Omit<ResearchResult, "roleId">[]
): ResearchResult {
  return {
    roleId,
    learnings: sanitizeLearnings(parts.flatMap((p) => p.learnings)),
    visitedUrls: [
      ...new Set(
        parts.flatMap((p) => p.visitedUrls).filter((u) => u.trim().length > 0)
      ),
    ],
    failures: parts.flatMap((p) => p.failures),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// (c) THE IMPURE PART. Three seams, one recursive function.
// ─────────────────────────────────────────────────────────────────────────────

/** One fetched document, ready to be trimmed into a prompt. */
export type SearchHit = {
  url: string;
  title: string;
  text: string;
};

export type SearchOutcome =
  | { ok: true; hits: SearchHit[] }
  /**
   * A named failure, NOT an empty hit list. `source-blocked` is the 403 case
   * the keyless adapters are expected to produce from a datacenter IP; it must
   * reach the report as "the source refused us", never as "we found nothing".
   */
  | { ok: false; failure: Omit<ResearchFailure, "subject"> };

export type LoopDeps = {
  /** Model call: brief + prior learnings -> search queries. Returns raw. */
  planQueries: (request: QueryPlanRequest) => Promise<unknown>;
  /** Network call: one query -> fetched documents. Never throws for a 403. */
  search: (query: string, abortSignal?: AbortSignal) => Promise<SearchOutcome>;
  /** Model call: documents -> attributed findings. Returns raw. */
  extractLearnings: (request: LearningExtractionRequest) => Promise<unknown>;
  /** Bounded parallelism inside one researcher. Injected so tests can pin it. */
  runConcurrent: <T>(tasks: (() => Promise<T>)[]) => Promise<T[]>;
  onProgress?: (progress: LoopProgress) => void;
};

export type LoopProgress = {
  roleId: string;
  depthRemaining: number;
  breadth: number;
  query: string;
};

export type LoopInput = {
  role: ResearchRole;
  brief: string;
  shape: ResearchShape;
  priorLearnings?: readonly ResearchLearning[];
  visitedUrls?: readonly string[];
  maxLearningsPerQuery?: number;
  abortSignal?: AbortSignal;
};

const DEFAULT_MAX_LEARNINGS_PER_QUERY = 3;

function fail(
  kind: ResearchFailure["kind"],
  subject: string,
  detail: string
): Omit<ResearchResult, "roleId"> {
  return {
    learnings: [],
    visitedUrls: [],
    failures: [{ kind, subject, detail }],
  };
}

async function planQueriesOrFail(
  deps: LoopDeps,
  input: LoopInput
): Promise<{ queries: SerpQuery[] } | { failure: ResearchFailure }> {
  const request = buildQueryPlanPrompt({
    role: input.role,
    brief: input.brief,
    breadth: input.shape.breadth,
    priorLearnings: input.priorLearnings ?? [],
  });

  let raw: unknown;
  try {
    raw = await deps.planQueries(request);
  } catch (error) {
    return {
      failure: {
        kind: "model-call-failed",
        subject: `query planning for ${input.role.id}`,
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }

  const parsed = SerpQueriesOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      failure: {
        kind: "model-schema-mismatch",
        subject: `query planning for ${input.role.id}`,
        detail: "the planner returned a response that was not a query list",
      },
    };
  }

  return { queries: sanitizeQueries(parsed.data.queries, input.shape.breadth) };
}

async function extractOrFail(
  deps: LoopDeps,
  args: {
    role: ResearchRole;
    query: string;
    hits: SearchHit[];
    maxLearnings: number;
    maxFollowUps: number;
  }
): Promise<
  | { learnings: ResearchLearning[]; followUpQuestions: string[] }
  | { failure: ResearchFailure }
> {
  const request = buildLearningPrompt({
    role: args.role,
    query: args.query,
    contents: args.hits.map((h) => ({ url: h.url, text: trimContent(h.text) })),
    maxLearnings: args.maxLearnings,
    maxFollowUps: args.maxFollowUps,
  });

  let raw: unknown;
  try {
    raw = await deps.extractLearnings(request);
  } catch (error) {
    return {
      failure: {
        kind: "model-call-failed",
        subject: args.query,
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }

  const parsed = LearningsOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      failure: {
        kind: "model-schema-mismatch",
        subject: args.query,
        detail:
          "the extractor returned a response that was not a findings list",
      },
    };
  }

  return {
    learnings: sanitizeLearnings(
      parsed.data.learnings.map((l) => ({ ...l, roleId: args.role.id }))
    ).slice(0, args.maxLearnings),
    followUpQuestions: parsed.data.followUpQuestions,
  };
}

/**
 * Runs one researcher's loop to completion. NEVER REJECTS.
 *
 * Every failure path returns a `ResearchResult` carrying named failures, so the
 * caller (`runFanOut`) can report which lane broke without losing the lanes
 * that worked.
 */
export async function runResearchLoop(
  deps: LoopDeps,
  input: LoopInput
): Promise<ResearchResult> {
  const roleId = input.role.id;
  const priorLearnings = input.priorLearnings ?? [];
  const visitedUrls = input.visitedUrls ?? [];
  const maxLearnings =
    input.maxLearningsPerQuery ?? DEFAULT_MAX_LEARNINGS_PER_QUERY;

  if (input.abortSignal?.aborted) {
    return mergeResults(roleId, [
      fail(
        "aborted",
        roleId,
        "the run was cancelled before this level started"
      ),
    ]);
  }
  if (input.shape.depth < 1 || input.shape.breadth < 1) {
    return mergeResults(roleId, [
      {
        learnings: [...priorLearnings],
        visitedUrls: [...visitedUrls],
        failures: [],
      },
    ]);
  }

  const planned = await planQueriesOrFail(deps, input);
  if ("failure" in planned) {
    return mergeResults(roleId, [
      {
        learnings: [...priorLearnings],
        visitedUrls: [...visitedUrls],
        failures: [planned.failure],
      },
    ]);
  }
  if (planned.queries.length === 0) {
    return mergeResults(roleId, [
      {
        learnings: [...priorLearnings],
        visitedUrls: [...visitedUrls],
        failures: [
          {
            kind: "model-schema-mismatch",
            subject: `query planning for ${roleId}`,
            detail:
              "the planner returned zero usable queries, so this branch searched nothing",
          },
        ],
      },
    ]);
  }

  const child = descendShape(input.shape);

  const tasks = planned.queries.map(
    (serpQuery) => async (): Promise<Omit<ResearchResult, "roleId">> => {
      deps.onProgress?.({
        roleId,
        depthRemaining: input.shape.depth,
        breadth: input.shape.breadth,
        query: serpQuery.query,
      });

      const found = await deps.search(serpQuery.query, input.abortSignal);
      if (!found.ok) {
        return fail(found.failure.kind, serpQuery.query, found.failure.detail);
      }
      if (found.hits.length === 0) {
        // A genuinely empty result set. Distinct from a blocked source, and it
        // is NOT a failure — it is a finding about the topic's coverage.
        return { learnings: [], visitedUrls: [], failures: [] };
      }

      const extracted = await extractOrFail(deps, {
        role: input.role,
        query: serpQuery.query,
        hits: found.hits,
        maxLearnings,
        maxFollowUps: child.breadth,
      });
      if ("failure" in extracted) {
        return {
          learnings: [],
          visitedUrls: found.hits.map((h) => h.url),
          failures: [extracted.failure],
        };
      }

      const levelResult: Omit<ResearchResult, "roleId"> = {
        learnings: extracted.learnings,
        visitedUrls: found.hits.map((h) => h.url),
        failures: [],
      };

      if (child.depth < 1) {
        return levelResult;
      }

      // Recurse. The follow-up questions plus the original research goal become
      // the next brief — upstream's `nextQuery` construction, kept because it is
      // what makes depth 2 ask something depth 1 could not have asked.
      const nextBrief = [
        `Previous research goal: ${serpQuery.researchGoal}`,
        `Follow-up directions:${extracted.followUpQuestions.map((q) => `\n- ${q}`).join("")}`,
      ].join("\n");

      const deeper = await runResearchLoop(deps, {
        ...input,
        brief: nextBrief,
        shape: child,
        priorLearnings: [...priorLearnings, ...extracted.learnings],
        visitedUrls: [...visitedUrls, ...levelResult.visitedUrls],
      });

      return {
        learnings: deeper.learnings,
        visitedUrls: deeper.visitedUrls,
        failures: deeper.failures,
      };
    }
  );

  const parts = await deps.runConcurrent(tasks);

  return mergeResults(roleId, [
    {
      learnings: [...priorLearnings],
      visitedUrls: [...visitedUrls],
      failures: [],
    },
    ...parts,
  ]);
}
