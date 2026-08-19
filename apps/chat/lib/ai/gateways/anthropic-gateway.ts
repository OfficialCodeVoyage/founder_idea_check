import { createAnthropic } from "@ai-sdk/anthropic";
import type { Experimental_VideoModelV3 } from "@ai-sdk/provider";
import type { ImageModel, LanguageModel } from "ai";
import { createModuleLogger } from "@/lib/logger";
import type { AiGatewayModel } from "../ai-gateway-models-schemas";
import {
  ANTHROPIC_MODELS,
  type AnthropicModelId,
  resolveAnthropicModelId,
} from "./anthropic-models";
import type { GatewayProvider } from "./gateway-provider";

const log = createModuleLogger("ai/gateways/anthropic");

/**
 * Native Anthropic (BYOK) gateway.
 *
 * Reads `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` from `process.env` directly
 * rather than through `@/lib/env`, because that module runs `createEnv` at import
 * time and throws without `DATABASE_URL` / `AUTH_SECRET` — which would make this
 * file untestable under vitest. This matches the vercel/openrouter/litellm
 * gateways, the three that have tests.
 *
 * `fetchModels` returns a static catalog: Anthropic's `GET /v1/models` exposes no
 * pricing and no capability tags, both of which this app requires. See
 * `anthropic-models.ts` for the reasoning.
 */
export class AnthropicGateway
  implements GatewayProvider<"anthropic", AnthropicModelId, never, never>
{
  readonly type = "anthropic" as const;

  createLanguageModel(modelId: AnthropicModelId): LanguageModel {
    const provider = this.getProvider();
    return provider(resolveAnthropicModelId(modelId));
  }

  createImageModel(_modelId: never): ImageModel | null {
    // Anthropic has no image generation models.
    return null;
  }

  createVideoModel(_modelId: never): Experimental_VideoModelV3 | null {
    return null;
  }

  fetchModels(): Promise<AiGatewayModel[]> {
    log.debug(
      { modelCount: ANTHROPIC_MODELS.length },
      "Using the static Anthropic model catalog"
    );
    return Promise.resolve(ANTHROPIC_MODELS.map((model) => ({ ...model })));
  }

  private getApiKey(): string | undefined {
    return process.env.ANTHROPIC_API_KEY;
  }

  private getBaseUrl(): string | undefined {
    return process.env.ANTHROPIC_BASE_URL || undefined;
  }

  private getProvider() {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not configured");
    }
    const baseURL = this.getBaseUrl();
    return createAnthropic(baseURL ? { apiKey, baseURL } : { apiKey });
  }
}
