/**
 * Vocabulary for demand signals — the evidence the *Verifying Demand* phase
 * needs before its gate will let a founder past.
 *
 * Types only. No imports, so everything below stays testable with no key, no
 * network and no database.
 */

/** Stable ids. Adding a source means adding a descriptor, not a new branch. */
export type SignalSourceId =
  | "hackernews"
  | "web-keyless"
  | "github"
  | "arctic-shift";

/**
 * One piece of evidence that somebody has the problem.
 *
 * DELIBERATELY NO `author` FIELD. See `providers.ts` for the reasoning: storing
 * usernames alongside verbatim quotes is what turns the operator into a GDPR
 * controller. The shape refuses to carry the field so no adapter can start.
 */
export type DemandSignal = {
  /** Stable within a source. Used for dedupe. */
  id: string;
  sourceId: SignalSourceId;
  title: string;
  /** Permalink. A signal with no url is discarded before it reaches here. */
  url: string;
  /** Short excerpt for the report. Never the full body. */
  snippet: string;
  /** ISO-8601 date, or null when the source does not date its items. */
  publishedAt: string | null;
  /** Source-native engagement, already normalised to a 0-100 scale. */
  engagement: number;
  /** 0-1 lexical relevance to the query, computed by the sidecar. */
  relevance: number;
};

export type SignalQuery = {
  /** The search text. */
  query: string;
  /** Cap on items returned per source. */
  limit: number;
  /** ISO dates bounding the search window, inclusive. */
  from: string;
  to: string;
  /**
   * ADAPTER-SPECIFIC HINTS, ADDRESSED TO ONE SOURCE. Passed through verbatim as
   * the sidecar's `SignalRequest.options`.
   *
   * KEYED BY SOURCE ID rather than flat, because these are not query terms —
   * they are instructions to one adapter, and a flat bag would send Arctic
   * Shift's subreddits to Hacker News, which would accept them silently
   * (`options` is a free-form dict on the wire) and mean nothing.
   *
   * THE LANE THAT NEEDS THIS: `arctic-shift` REFUSES a query with no
   * subreddits. Its `query` parameter is documented as working only alongside
   * `subreddit` or `author`, so it cannot search all of Reddit for a phrase and
   * an unscoped answer would read as "we searched and found little" when no
   * search happened. Until this field existed the lane could be enabled,
   * reachable and correct, and still refuse every request — which it did. See
   * `sourceOptionsFor` in ./audience.ts for who fills it in.
   */
  sourceOptions?: Readonly<
    Partial<Record<SignalSourceId, Record<string, unknown>>>
  >;
};

/**
 * Why a source produced nothing. Every one of these is a NAMED condition, and
 * none of them is an empty array — see `SignalFetchOutcome`.
 */
export type SignalFailureKind =
  /**
   * HTTP 403. The single most likely production failure for the keyless
   * adapters: they were verified from a residential IP, and DuckDuckGo serves
   * challenge pages or hard 403s to datacenter egress ranges (Vercel, AWS). This has its own kind precisely so a deployment can
   * tell "the host is blocked" from "the topic has no discussion".
   */
  | "blocked"
  /** Network error, DNS failure, timeout, 5xx. */
  | "unavailable"
  /** 429. Distinct from `blocked`: retrying later is meaningful. */
  | "rate-limited"
  /** The source is off for this deployment — see `providerGateReason`. */
  | "disabled"
  /** Configured on, but its credential is missing. */
  | "missing-credential"
  /** The response parsed, but not into the shape the adapter expects. */
  | "schema-drift";

export type SignalFailure = {
  kind: SignalFailureKind;
  sourceId: SignalSourceId;
  /** Written for a human operator, and it must name the actual cause. */
  detail: string;
};

/**
 * A source either produced signals or named why it did not. There is no third
 * state and, in particular, `{ ok: true, signals: [] }` means "this source
 * searched and genuinely found nothing" — never "this source was blocked".
 */
export type SignalFetchOutcome =
  | { ok: true; sourceId: SignalSourceId; signals: DemandSignal[] }
  | { ok: false; failure: SignalFailure };

/**
 * How a source is allowed to run. This is the type that carries the legal
 * position, which is why `enabledInHosted` is required rather than defaulted:
 * a new adapter cannot be added without its author answering the question.
 */
export type ProviderDescriptor = {
  id: SignalSourceId;
  label: string;
  /**
   * May this source run when the deployment serves users other than the
   * operator? `false` means the operator would be taking on somebody else's
   * legal risk on their behalf.
   */
  enabledInHosted: boolean;
  /** May this source run in self-host, where the operator is the only user? */
  enabledInSelfHost: boolean;
  /** Env var names that must be non-empty. Empty array means keyless. */
  requiredCredentials: readonly string[];
  /**
   * Why this source is gated the way it is, in plain prose. Rendered in the
   * operator UI next to the toggle — a gate whose reason is buried in a code
   * comment gets flipped by the next person who finds it inconvenient.
   */
  gateReason: string;
};

/** The one interface every source implements. */
export type DemandSignalProvider = {
  descriptor: ProviderDescriptor;
  /**
   * NEVER THROWS. A blocked or unavailable source returns
   * `{ ok: false, failure }`, because a throw here takes down the other three
   * sources in the same fan-out.
   */
  fetch: (
    query: SignalQuery,
    abortSignal?: AbortSignal
  ) => Promise<SignalFetchOutcome>;
};

/** Where this deployment sits, which is the input to every gating decision. */
export type DeploymentMode = {
  /**
   * True when one provider key and one operator serve users who are not the
   * operator. The whole `enabledInHosted` mechanism keys off this.
   */
  hosted: boolean;
  /** Env var names that currently hold a non-empty value. */
  availableCredentials: readonly string[];
  /**
   * Sources the operator explicitly switched on, by id. An id here is a
   * REQUEST, not a grant — `selectEnabledProviders` still refuses anything the
   * descriptor bars in this mode.
   */
  operatorEnabled: readonly SignalSourceId[];
};
