import { z } from "zod";
import type {
  ProviderDescriptor,
  SignalFailure,
  SignalFailureKind,
  SignalFetchOutcome,
  SignalQuery,
  SignalSourceId,
} from "./types";

/**
 * THE SEAM to `apps/research`, the Python sidecar.
 *
 * Every adapter — Hacker News, the keyless web ladder, GitHub, Reddit — lives
 * in Python, because that is where `mvanhorn/last30days-skill`'s seventeen
 * hard-won adapters already exist and where re-implementing them in TypeScript
 * would mean owning an anti-bot maintenance treadmill forever.
 *
 * This file is the ONLY place in `lib/signals/` that touches the network. Its
 * pure half — status classification and response parsing — is unit-tested; the
 * impure half is one `fetch` call injected through `SidecarConfig.fetchImpl`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// (a) THE WIRE FORMAT. Parsed defensively; the sidecar is a separate process
//     with its own deploy cadence, so its response is untrusted input.
// ─────────────────────────────────────────────────────────────────────────────

const SidecarSignalSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  published_at: z.string().nullable(),
  engagement: z.number(),
  relevance: z.number(),
});

const SidecarOkSchema = z.object({
  ok: z.literal(true),
  source_id: z.string(),
  signals: z.array(SidecarSignalSchema),
});

const SidecarFailureSchema = z.object({
  ok: z.literal(false),
  source_id: z.string(),
  /** Mirrors `SignalFailureKind`. Validated against it below, not trusted. */
  kind: z.string(),
  detail: z.string(),
});

const SidecarResponseSchema = z.union([SidecarOkSchema, SidecarFailureSchema]);

const KNOWN_FAILURE_KINDS: readonly SignalFailureKind[] = [
  "blocked",
  "unavailable",
  "rate-limited",
  "disabled",
  "missing-credential",
  "schema-drift",
];

/**
 * PURE. Maps a sidecar-reported kind onto our enum.
 *
 * An unrecognised kind becomes `schema-drift`, NOT `unavailable`. The two lead
 * an operator to different actions — one says "the source is down, wait", the
 * other says "the sidecar and the app disagree about the contract, redeploy" —
 * and collapsing them sends people to retry a problem that retrying cannot fix.
 */
export function normalizeFailureKind(raw: string): SignalFailureKind {
  return KNOWN_FAILURE_KINDS.includes(raw as SignalFailureKind)
    ? (raw as SignalFailureKind)
    : "schema-drift";
}

/**
 * PURE. Maps the SIDECAR'S OWN transport status onto a failure kind.
 *
 * Note whose status this is: a 403 here means the sidecar refused US, not that
 * an upstream source refused the sidecar. Upstream 403s are reported inside a
 * 200 body as `{ ok: false, kind: "blocked" }`, because the adapter caught them
 * — which is the whole point of the sidecar owning the adapters.
 */
export function classifySidecarStatus(status: number): SignalFailureKind {
  if (status === 429) {
    return "rate-limited";
  }
  if (status === 401 || status === 403) {
    return "missing-credential";
  }
  if (status === 422 || status === 400) {
    return "schema-drift";
  }
  return "unavailable";
}

function failure(
  sourceId: SignalSourceId,
  kind: SignalFailureKind,
  detail: string
): SignalFetchOutcome {
  const value: SignalFailure = { kind, sourceId, detail };
  return { ok: false, failure: value };
}

/**
 * PURE. Turns a parsed sidecar body into an outcome.
 *
 * The `source_id` on the wire is checked against the descriptor we asked for.
 * A mismatch is `schema-drift` rather than a silent relabel: attributing one
 * source's signals to another would put Reddit-sourced quotes under a "Hacker
 * News" heading in a report a founder is about to act on, and nothing
 * downstream could detect it.
 */
export function parseSignalResponse(
  descriptor: ProviderDescriptor,
  raw: unknown
): SignalFetchOutcome {
  const parsed = SidecarResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return failure(
      descriptor.id,
      "schema-drift",
      `The research sidecar returned a body that did not match the signal contract for ${descriptor.label}.`
    );
  }

  const body = parsed.data;
  if (body.source_id !== descriptor.id) {
    return failure(
      descriptor.id,
      "schema-drift",
      `Asked the research sidecar for "${descriptor.id}" and it answered for "${body.source_id}".`
    );
  }

  if (!body.ok) {
    return failure(descriptor.id, normalizeFailureKind(body.kind), body.detail);
  }

  return {
    ok: true,
    sourceId: descriptor.id,
    signals: body.signals.map((s) => ({
      id: s.id,
      sourceId: descriptor.id,
      title: s.title,
      url: s.url,
      snippet: s.snippet,
      publishedAt: s.published_at,
      engagement: s.engagement,
      relevance: s.relevance,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// (b) THE IMPURE PART.
// ─────────────────────────────────────────────────────────────────────────────

export type SidecarConfig = {
  /** e.g. `http://localhost:8099`. No trailing slash required. */
  baseUrl: string;
  /** Injected so tests never open a socket. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Hard ceiling per source. The sidecar has its own, lower, internal budget. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 45_000;
const TRAILING_SLASHES = /\/+$/;

/**
 * Builds the fetcher for one source. NEVER THROWS — every path returns a
 * `SignalFetchOutcome`, because `runSignalHarvest` runs these concurrently and
 * a throw would be the one bad source taking down the good ones.
 */
export function createSidecarSignalFetcher(config: SidecarConfig) {
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = config.baseUrl.replace(TRAILING_SLASHES, "");

  return (descriptor: ProviderDescriptor) =>
    async (
      query: SignalQuery,
      abortSignal?: AbortSignal
    ): Promise<SignalFetchOutcome> => {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = abortSignal
        ? AbortSignal.any([abortSignal, timeout])
        : timeout;

      let response: Response;
      try {
        response = await fetchImpl(`${base}/v1/signals/${descriptor.id}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: query.query,
            limit: query.limit,
            date_from: query.from,
            date_to: query.to,
          }),
          signal,
        });
      } catch (error) {
        return failure(
          descriptor.id,
          "unavailable",
          `Could not reach the research sidecar at ${base} for ${descriptor.label}: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      if (!response.ok) {
        return failure(
          descriptor.id,
          classifySidecarStatus(response.status),
          `The research sidecar answered HTTP ${response.status} for ${descriptor.label}.`
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        return failure(
          descriptor.id,
          "schema-drift",
          `The research sidecar returned a non-JSON body for ${descriptor.label}: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      return parseSignalResponse(descriptor, body);
    };
}
