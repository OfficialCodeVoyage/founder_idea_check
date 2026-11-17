import type { AiGatewayModel } from "../ai-gateway-models-schemas";

/**
 * Static catalog of Anthropic first-party models.
 *
 * Anthropic's `GET /v1/models` returns only `id`, `display_name`, `created_at`,
 * `max_input_tokens`, `max_tokens` and `capabilities` — it exposes no pricing and
 * no tag vocabulary. The app derives `reasoning` / `toolCall` / `input.image` /
 * `input.pdf` from tags (see `to-model-data.ts`) and skips credit accounting for
 * models without `pricing.input` + `pricing.output` (see `credits/cost-accumulator.ts`),
 * so a live-only fetch would silently disable tools and make every message free.
 *
 * This module is intentionally pure: it imports a type only, so it is fully
 * unit-testable with no API key, no network and no Next.js request scope.
 *
 * Pricing is dollars-per-token (list $/1M ÷ 1e6). Cache pricing follows the
 * Anthropic convention: read = 0.1x input, write (5m) = 1.25x input, except
 * where a model says otherwise (Opus 5.5 and Sonnet 5.5 read at 0.05x).
 *
 * The 5.5 prices were read from the claude-api skill's model table (cached
 * 2026-11-03) on 2026-11-17: Opus 5.5 $4/$20, Sonnet 5.5 $2/$10 (cache reads
 * $0.20 and $0.10), Haiku 5.5 $0.10/$0.50, Sonnet 5 $2/$10.
 */

/** Stable placeholder — the catalog is static, so `created` carries no meaning. */
const CREATED = 1_755_815_280;

type AnthropicTag = NonNullable<AiGatewayModel["tags"]>[number];

/** Every catalog model reasons, calls tools, and accepts images and PDFs. */
const ANTHROPIC_TAGS: readonly AnthropicTag[] = [
  "file-input",
  "reasoning",
  "tool-use",
  "vision",
];

/**
 * Every id the app knows about, in model-selector preference order.
 * Ids are the bare Anthropic API ids — never slash-prefixed and never
 * date-suffixed, except for the explicitly pinned Haiku 4.5 snapshot.
 */
export const ANTHROPIC_MODEL_IDS = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-opus-5",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
] as const;

export type AnthropicModelId = (typeof ANTHROPIC_MODEL_IDS)[number];

type AnthropicCatalogModel = AiGatewayModel & { id: AnthropicModelId };

function opusPricing(): AiGatewayModel["pricing"] {
  return {
    input: "0.000005",
    output: "0.000025",
    input_cache_read: "0.0000005",
    input_cache_write: "0.00000625",
    web_search: "10",
  };
}

function sonnetPricing(): AiGatewayModel["pricing"] {
  return {
    input: "0.000003",
    output: "0.000015",
    input_cache_read: "0.0000003",
    input_cache_write: "0.00000375",
    web_search: "10",
  };
}

function haikuPricing(): AiGatewayModel["pricing"] {
  return {
    input: "0.000001",
    output: "0.000005",
    input_cache_read: "0.0000001",
    input_cache_write: "0.00000125",
    web_search: "10",
  };
}

export const ANTHROPIC_MODELS: readonly AnthropicCatalogModel[] = [
  {
    id: "claude-opus-5-5",
    object: "model",
    created: CREATED,
    owned_by: "anthropic",
    name: "Claude Opus 5.5",
    description:
      "The current Opus, for demanding reasoning and long-horizon work. The phase gate's judge in this app. Thinking is always on; effort sets its depth.",
    context_window: 1_000_000,
    max_tokens: 128_000,
    type: "language",
    tags: [...ANTHROPIC_TAGS],
    pricing: {
      input: "0.000004",
      output: "0.00002",
      input_cache_read: "0.0000002",
      input_cache_write: "0.000005",
      web_search: "10",
    },
  },
  {
    id: "claude-sonnet-5-5",
    object: "model",
    created: CREATED,
    owned_by: "anthropic",
    name: "Claude Sonnet 5.5",
    description:
      "The current Sonnet: frontier capability at mid-tier cost and latency. The default chat model for this app.",
    context_window: 1_000_000,
    max_tokens: 128_000,
    type: "language",
    tags: [...ANTHROPIC_TAGS],
    pricing: {
      input: "0.000002",
      output: "0.00001",
      input_cache_read: "0.0000001",
      input_cache_write: "0.0000025",
      web_search: "10",
    },
  },
  {
    id: "claude-haiku-5-5",
    object: "model",
    created: CREATED,
    owned_by: "anthropic",
    name: "Claude Haiku 5.5",
    description:
      "The current Haiku: fast and low-cost, for titles, fact extraction, the research loop and other background workflows.",
    context_window: 1_000_000,
    max_tokens: 128_000,
    type: "language",
    tags: [...ANTHROPIC_TAGS],
    /**
     * THE LOWER OF TWO RATE CARDS. Haiku 5.5 bills $0.10/$0.50 per 1M tokens
     * for a prompt of 100K tokens or fewer and $0.50/$2.50 above that. Credit
     * accounting (`lib/credits/cost-accumulator.ts::priceFor`) reads one flat
     * `input`/`output` pair, so a prompt over 100K is undercounted five-fold.
     * That errs the way the meter is built to err (never overcount the
     * founder), and no Haiku path here sends prompts that long today.
     */
    pricing: {
      input: "0.0000001",
      output: "0.0000005",
      input_cache_read: "0.00000001",
      input_cache_write: "0.000000125",
      web_search: "10",
    },
  },
  {
    id: "claude-opus-5",
    object: "model",
    created: CREATED,
    owned_by: "anthropic",
    name: "Claude Opus 5",
    description:
      "Anthropic's flagship Opus model for demanding reasoning, coding and long-horizon agentic work. Adaptive thinking is on by default.",
    context_window: 1_000_000,
    max_tokens: 128_000,
    type: "language",
    tags: [...ANTHROPIC_TAGS],
    pricing: opusPricing(),
  },
  {
    id: "claude-fable-5",
    object: "model",
    created: CREATED,
    owned_by: "anthropic",
    name: "Claude Fable 5",
    description:
      "Anthropic's most capable widely released model, for the hardest reasoning and long-horizon agentic tasks. Thinking is always on.",
    context_window: 1_000_000,
    max_tokens: 128_000,
    type: "language",
    tags: [...ANTHROPIC_TAGS],
    pricing: {
      input: "0.00001",
      output: "0.00005",
      input_cache_read: "0.000001",
      input_cache_write: "0.0000125",
      web_search: "10",
    },
  },
  {
    id: "claude-opus-4-8",
    object: "model",
    created: CREATED,
    owned_by: "anthropic",
    name: "Claude Opus 4.8",
    description:
      "Opus-tier model for complex coding and agentic workflows, with the same request surface as Opus 4.7.",
    context_window: 1_000_000,
    max_tokens: 128_000,
    type: "language",
    tags: [...ANTHROPIC_TAGS],
    pricing: opusPricing(),
  },
  {
    id: "claude-opus-4-7",
    object: "model",
    created: CREATED,
    owned_by: "anthropic",
    name: "Claude Opus 4.7",
    description:
      "Opus-tier model for complex coding, agentic workflows and knowledge work.",
    context_window: 1_000_000,
    max_tokens: 128_000,
    type: "language",
    tags: [...ANTHROPIC_TAGS],
    pricing: opusPricing(),
  },
  {
    id: "claude-opus-4-6",
    object: "model",
    created: CREATED,
    owned_by: "anthropic",
    name: "Claude Opus 4.6",
    description:
      "Opus-tier model for coding and professional work across the whole software lifecycle.",
    context_window: 1_000_000,
    max_tokens: 128_000,
    type: "language",
    tags: [...ANTHROPIC_TAGS],
    pricing: opusPricing(),
  },
  {
    id: "claude-opus-4-5",
    object: "model",
    created: CREATED,
    owned_by: "anthropic",
    name: "Claude Opus 4.5",
    description:
      "Opus-tier model for demanding reasoning and complex problem solving, with strong tool and computer use.",
    context_window: 200_000,
    max_tokens: 64_000,
    type: "language",
    tags: [...ANTHROPIC_TAGS],
    pricing: {
      input: "0.000005",
      output: "0.000025",
      input_cache_read: "0.0000005",
      input_cache_write: "0.00000625",
    },
  },
  {
    id: "claude-sonnet-5",
    object: "model",
    created: CREATED,
    owned_by: "anthropic",
    name: "Claude Sonnet 5",
    description:
      "The previous Sonnet, balancing frontier capability with cost and latency.",
    context_window: 1_000_000,
    max_tokens: 128_000,
    type: "language",
    tags: [...ANTHROPIC_TAGS],
    // $2/$10, not the $3/$15 of the 4.x Sonnets this entry used to share.
    pricing: {
      input: "0.000002",
      output: "0.00001",
      input_cache_read: "0.0000002",
      input_cache_write: "0.0000025",
      web_search: "10",
    },
  },
  {
    id: "claude-sonnet-4-6",
    object: "model",
    created: CREATED,
    owned_by: "anthropic",
    name: "Claude Sonnet 4.6",
    description:
      "Sonnet-class model for iterative development, codebase navigation and polished document creation.",
    context_window: 1_000_000,
    max_tokens: 128_000,
    type: "language",
    tags: [...ANTHROPIC_TAGS],
    pricing: sonnetPricing(),
  },
  {
    id: "claude-sonnet-4-5",
    object: "model",
    created: CREATED,
    owned_by: "anthropic",
    name: "Claude Sonnet 4.5",
    description:
      "Sonnet-class model balancing capability and cost for everyday chat and tool use.",
    context_window: 1_000_000,
    max_tokens: 64_000,
    type: "language",
    tags: [...ANTHROPIC_TAGS],
    pricing: sonnetPricing(),
  },
  {
    id: "claude-haiku-4-5",
    object: "model",
    created: CREATED,
    owned_by: "anthropic",
    name: "Claude Haiku 4.5",
    description:
      "Fast, low-cost model for titles, suggestions and other high-volume background workflows.",
    context_window: 200_000,
    max_tokens: 64_000,
    type: "language",
    tags: [...ANTHROPIC_TAGS],
    pricing: haikuPricing(),
  },
  {
    id: "claude-haiku-4-5-20251001",
    object: "model",
    created: CREATED,
    owned_by: "anthropic",
    name: "Claude Haiku 4.5 (2025-10-01)",
    description:
      "Pinned snapshot of Claude Haiku 4.5. Use it when you need the model version to stay frozen.",
    context_window: 200_000,
    max_tokens: 64_000,
    type: "language",
    tags: [...ANTHROPIC_TAGS],
    pricing: haikuPricing(),
  },
];

/** Sensible mid-tier default for chat and document workflows. */
export const ANTHROPIC_DEFAULT_MODEL_ID: AnthropicModelId = "claude-sonnet-5-5";

/** Cheapest model, used for titles and other background workflows. */
export const ANTHROPIC_FAST_MODEL_ID: AnthropicModelId = "claude-haiku-5-5";

const ANTHROPIC_MODEL_ID_SET: ReadonlySet<string> = new Set(
  ANTHROPIC_MODEL_IDS
);

export function isAnthropicModelId(value: string): value is AnthropicModelId {
  return ANTHROPIC_MODEL_ID_SET.has(value);
}

/**
 * Normalise a model id to the bare Anthropic API form.
 *
 * Persisted preferences and cookies written while another gateway was active
 * hold ids like `anthropic/claude-sonnet-4.5`; Anthropic's own ids are never
 * slash-prefixed and never contain dots. Stripping the provider prefix and
 * converting dots to dashes lets those stale ids resolve instead of 404-ing.
 *
 * Unknown ids are passed through normalised rather than rejected, so a model
 * released after this catalog was written still works.
 */
export function resolveAnthropicModelId(modelId: string): string {
  const withoutPrefix = modelId.slice(modelId.lastIndexOf("/") + 1);
  return withoutPrefix.replaceAll(".", "-");
}
