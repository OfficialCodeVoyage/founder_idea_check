import type { generatedForGateway, models } from "../models.generated";
import { AnthropicGateway } from "./anthropic-gateway";
import type { GatewayProvider as GatewayProviderBase } from "./gateway-provider";
import { LiteLLMGateway } from "./litellm-gateway";
import { OpenAICompatibleGateway } from "./openai-compatible-gateway";
import { OpenAIGateway } from "./openai-gateway";
import { OpenRouterGateway } from "./openrouter-gateway";
import { VercelGateway } from "./vercel-gateway";

export const gatewayRegistry = {
  vercel: () => new VercelGateway(),
  anthropic: () => new AnthropicGateway(),
  openrouter: () => new OpenRouterGateway(),
  openai: () => new OpenAIGateway(),
  "openai-compatible": () => new OpenAICompatibleGateway(),
  litellm: () => new LiteLLMGateway(),
} as const satisfies Record<string, () => GatewayProviderBase>;

export type GatewayProvider = GatewayProviderBase<GatewayType>;
export type GatewayType = keyof typeof gatewayRegistry;

/**
 * The fork's default, used only by a config with no `ai` block at all:
 * `defineConfig` requires `ai.gateway` whenever `ai` is given, and
 * chat.config.ts names `gateway: "anthropic"`. Upstream chat-js defaults to
 * "vercel", which needs an AI_GATEWAY_API_KEY this project does not use, so a
 * config without the block could not resolve a single model, and the error
 * would surface as a failed chat turn rather than as a config error. "openai"
 * needs only OPENAI_API_KEY, which this app needs anyway for the fact
 * embeddings and the research sidecar.
 */
export const DEFAULT_GATEWAY = "openai" as const satisfies GatewayType;
export type DefaultGateway = typeof DEFAULT_GATEWAY;
/** Infer model ID type from a gateway's `createLanguageModel` parameter */
type InferLanguageModelId<T extends GatewayType> = Parameters<
  ReturnType<(typeof gatewayRegistry)[T]>["createLanguageModel"]
>[0];

export type GatewayModelIdMap = {
  [K in GatewayType]: InferLanguageModelId<K>;
};

/** Infer image model ID type from a gateway's `createImageModel` parameter */
type InferImageModelId<T extends GatewayType> = Parameters<
  ReturnType<(typeof gatewayRegistry)[T]>["createImageModel"]
>[0];

// Helper: check if tuple T contains element E
type TupleIncludes<T extends readonly unknown[], E> = T extends readonly [
  infer H,
  ...infer R,
]
  ? H extends E
    ? true
    : TupleIncludes<R, E>
  : false;

// Extract language models with "image-generation" tag from the snapshot
type MultimodalImageModel =
  Extract<
    (typeof models)[number],
    { type: "language"; tags: readonly string[] }
  > extends infer M
    ? M extends { id: infer Id; tags: infer Tags extends readonly string[] }
      ? TupleIncludes<Tags, "image-generation"> extends true
        ? Id
        : never
      : never
    : never;

export type GatewayImageModelIdMap = {
  [K in GatewayType]:
    | InferImageModelId<K>
    | (K extends typeof generatedForGateway ? MultimodalImageModel : never);
};

/** Infer video model ID type from a gateway's `createVideoModel` parameter */
type InferVideoModelId<T extends GatewayType> = Parameters<
  ReturnType<(typeof gatewayRegistry)[T]>["createVideoModel"]
>[0];

export type GatewayVideoModelIdMap = {
  [K in GatewayType]: InferVideoModelId<K>;
};
