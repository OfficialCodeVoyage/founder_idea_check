/**
 * STATIC MODEL CAPABILITY AND PRICE TABLE.
 *
 * WHY THIS FILE EXISTS. OpenAI's `/v1/models` returns an id, a creation
 * timestamp and an owner. It does NOT return a context window, a token limit or
 * a price. `toAiGatewayModel` in `gateways/openai-gateway.ts` therefore used to
 * write `context_window: 0`, `max_tokens: 0` and `pricing: {}` for all 126
 * models, and that single placeholder has already caused two silent failures:
 *
 *   1. Deep research could not run at all. `truncateMessages(messages, 0)`
 *      discarded every message and `generateText` threw "messages must not be
 *      empty". Patched at the consumer in 2cb9c253 with a documented fallback.
 *   2. Credit accounting was inert. The cost accumulator skipped any model
 *      whose pricing was absent, so EVERY call was skipped, `deductCredits` was
 *      always called with 0, and the 402 path could never fire from real usage.
 *      `UserCredit.credits` for dev-local-user had not moved in 23 turns.
 *
 * Both failures share one cause: a value the gateway never reported was written
 * as a number that means something else. This table is the source of the values
 * the gateway cannot supply.
 *
 * THE RULE THIS FILE ENFORCES. A model with no entry reports a NAMED unknown.
 * It never reports 0, and it never gets a silent default. Every lookup here
 * returns a discriminated result whose unknown arm has no value to read, so
 * "the table does not cover this model" cannot be mistaken for "this model
 * costs nothing" at a call site. `null` inside an entry means the same thing at
 * field level: not established by a verified source.
 *
 * NO NETWORK, EVER. This is a static table on purpose — no scraper, no runtime
 * fetch. Prices change on announcement, not on a schedule, and a pricing lookup
 * that can fail at request time is a worse failure mode than a stale constant
 * that a human updates deliberately.
 *
 * PROVENANCE. Every number below was read from OpenAI's own per-model
 * documentation pages at `developers.openai.com/api/docs/models/<id>` on
 * 2026-08-21, and cross-checked against the independently gathered table in
 * NEXT-BATCH-2026-08-21.md ("Model data (verified 2026-08-21)"). The two agree.
 * Prices are post the 2026-07-30 cut. When you change a number here, say where
 * you read it.
 */

/**
 * Which endpoint this model will accept FUNCTION TOOLS on. Measured, not
 * documented — the docs claim the 5.6 family supports Chat Completions, and in
 * practice tools plus the default reasoning effort are rejected there:
 *
 *   400 - "Function tools with reasoning_effort are not supported for
 *          gpt-5.6-luna in /v1/chat/completions. To use function tools, use
 *          /v1/responses or set reasoning_effort to 'none'."
 *
 * The Next.js app is unaffected — AI SDK v6 posts to `/v1/responses`. It is the
 * Python sidecar's CAMEL path that posts to `chat/completions`, which is the
 * whole reason `RESEARCH_SIM_REASONING_EFFORT` exists.
 */
export type ToolTransport = "chat-completions" | "responses-only";

/**
 * Rough role band, for choosing a model for a workflow rather than for billing.
 * Deliberately coarse: the precise trade-offs live in the batch document's
 * benchmark table, and a finer enum here would be a second source of truth.
 */
export type ModelTier = "frontier" | "balanced" | "economy" | "embedding";

export type ModelPrices = {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M cached input tokens. `null` = no published cached tier. */
  cachedInput: number | null;
  /**
   * USD per 1M output tokens. `null` = this model publishes no output price
   * because it produces no output tokens (embeddings). That is a different
   * fact from "we do not know", and callers must not bill against it.
   */
  output: number | null;
};

export type ModelCapabilities = {
  /** Maximum total tokens. `null` = not stated by the source. */
  contextWindow: number | null;
  /** Maximum tokens in one response. `null` = not stated by the source. */
  maxOutput: number | null;
  prices: ModelPrices;
  tier: ModelTier;
  toolTransport: ToolTransport;
};

/**
 * Only the models this app actually reaches for. Everything else degrades to a
 * named unknown rather than being guessed at — an entry here is a claim that
 * someone verified these numbers, so an unverified row would be worse than no
 * row.
 *
 * Deliberately absent: gpt-5.4-nano and gpt-5.4-mini (luna dominates both on
 * price and on both benchmarks, so neither is in the target config),
 * gpt-5.6-sol (not recommended anywhere yet), and gpt-5.2-chat-latest
 * (deprecated — 404s on both endpoints).
 */
export const MODEL_CAPABILITIES: Readonly<Record<string, ModelCapabilities>> =
  Object.freeze({
    "gpt-5.6-terra": {
      contextWindow: 1_050_000,
      maxOutput: 128_000,
      prices: { input: 2.0, cachedInput: 0.2, output: 12.0 },
      tier: "frontier",
      toolTransport: "responses-only",
    },
    "gpt-5.6-sol": {
      // PRICE CORRECTION, 2026-08-21. NEXT-BATCH-2026-08-21.md lists sol at
      // $5.00 / $0.50 / $30.00, and several third-party pricing pages still say
      // the same "since launch". OpenAI's own model page states $4 / $0.40 /
      // $20 and calls it a reduction, quoted verbatim twice. The batch
      // document's row is stale — it was gathered for a model no workflow uses,
      // so nobody re-checked it. Primary source wins; if you change this back,
      // quote where you read it.
      contextWindow: 1_050_000,
      maxOutput: 128_000,
      prices: { input: 4.0, cachedInput: 0.4, output: 20.0 },
      tier: "frontier",
      toolTransport: "responses-only",
    },
    "gpt-5.6-luna": {
      contextWindow: 1_050_000,
      maxOutput: 128_000,
      prices: { input: 0.2, cachedInput: 0.02, output: 1.2 },
      tier: "balanced",
      toolTransport: "responses-only",
    },
    "gpt-5.2": {
      contextWindow: 400_000,
      maxOutput: 128_000,
      prices: { input: 1.75, cachedInput: 0.175, output: 14.0 },
      tier: "frontier",
      toolTransport: "chat-completions",
    },
    "gpt-5-mini": {
      contextWindow: 400_000,
      maxOutput: 128_000,
      prices: { input: 0.25, cachedInput: 0.025, output: 2.0 },
      tier: "balanced",
      toolTransport: "chat-completions",
    },
    "gpt-5-nano": {
      contextWindow: 400_000,
      maxOutput: 128_000,
      prices: { input: 0.05, cachedInput: 0.005, output: 0.4 },
      tier: "economy",
      toolTransport: "chat-completions",
    },
    "gpt-4o-mini": {
      contextWindow: 128_000,
      maxOutput: 16_384,
      prices: { input: 0.15, cachedInput: 0.075, output: 0.6 },
      tier: "economy",
      toolTransport: "chat-completions",
    },
    "text-embedding-3-small": {
      // The docs page states neither a context window nor a token limit for
      // this model, so both stay null rather than borrowing 8191 from the
      // older ada page.
      contextWindow: null,
      maxOutput: null,
      prices: { input: 0.02, cachedInput: null, output: null },
      tier: "embedding",
      toolTransport: "chat-completions",
    },
  });

/**
 * A lookup that cannot be mistaken for a value. The unknown arm carries no
 * number at all, so a caller has to acknowledge it to compile — the same
 * technique `judgeSimulation` uses to stop "not assessed" being read as a
 * verdict.
 */
export type CapabilityLookup<T> =
  | { known: true; value: T }
  | { known: false; reason: string };

const REASONING_SUFFIX = "-reasoning";

/**
 * `AppModelId` carries a `-reasoning` suffix for the reasoning variant of a
 * model, while the table is keyed by the API model id. Without this, every
 * reasoning variant would look unknown and would silently go unpriced — which
 * is the exact failure this file exists to end, reintroduced through a naming
 * convention.
 */
export function toApiModelId(modelId: string): string {
  return modelId.endsWith(REASONING_SUFFIX)
    ? modelId.slice(0, -REASONING_SUFFIX.length)
    : modelId;
}

export function lookupModelCapabilities(
  modelId: string
): CapabilityLookup<ModelCapabilities> {
  const apiModelId = toApiModelId(modelId);
  const entry = MODEL_CAPABILITIES[apiModelId];
  if (!entry) {
    return {
      known: false,
      reason: `No capability entry for model "${apiModelId}". Add one to lib/ai/model-capabilities.ts with a verified source, or treat this model as unpriced — do not assume zero.`,
    };
  }
  return { known: true, value: entry };
}

export function lookupContextWindow(modelId: string): CapabilityLookup<number> {
  const found = lookupModelCapabilities(modelId);
  if (!found.known) {
    return found;
  }
  if (found.value.contextWindow === null) {
    return {
      known: false,
      reason: `Model "${toApiModelId(modelId)}" is in the capability table but its context window was never stated by the source.`,
    };
  }
  return { known: true, value: found.value.contextWindow };
}

export function lookupPrices(modelId: string): CapabilityLookup<ModelPrices> {
  const found = lookupModelCapabilities(modelId);
  return found.known ? { known: true, value: found.value.prices } : found;
}

export function lookupToolTransport(
  modelId: string
): CapabilityLookup<ToolTransport> {
  const found = lookupModelCapabilities(modelId);
  return found.known
    ? { known: true, value: found.value.toolTransport }
    : found;
}

/** Per-TOKEN price string, the shape `ModelData.pricing` uses. */
function perToken(usdPerMillion: number): string {
  return (usdPerMillion / 1_000_000).toString();
}

/**
 * The table rendered in the gateway's own wire shape, so `openai-gateway.ts`
 * can merge it over an API response that carries none of these fields.
 * Returns undefined for a model with no entry — the caller must then leave the
 * gateway's values alone rather than substituting anything.
 */
export function gatewayFieldsFor(modelId: string):
  | {
      context_window?: number;
      max_tokens?: number;
      pricing: {
        input?: string;
        output?: string;
        input_cache_read?: string;
      };
    }
  | undefined {
  const found = lookupModelCapabilities(modelId);
  if (!found.known) {
    return;
  }
  const { contextWindow, maxOutput, prices } = found.value;
  return {
    ...(contextWindow === null ? {} : { context_window: contextWindow }),
    ...(maxOutput === null ? {} : { max_tokens: maxOutput }),
    pricing: {
      input: perToken(prices.input),
      ...(prices.output === null ? {} : { output: perToken(prices.output) }),
      ...(prices.cachedInput === null
        ? {}
        : { input_cache_read: perToken(prices.cachedInput) }),
    },
  };
}
