import type { AnthropicProviderOptions } from "@ai-sdk/anthropic";
import { devToolsMiddleware } from "@ai-sdk/devtools";
import type { GoogleGenerativeAIProviderOptions } from "@ai-sdk/google";
import type { OpenAIResponsesProviderOptions } from "@ai-sdk/openai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import {
  extractReasoningMiddleware,
  type LanguageModelMiddleware,
  wrapLanguageModel,
} from "ai";
import { getActiveGateway } from "./active-gateway";
import { anthropicThinkingOptions } from "./anthropic-thinking";
import type { AppModelId } from "./app-models";
import { getAppModelDefinition } from "./app-models";
import { type CallPath, callPathMiddleware } from "./call-paths";

/**
 * The model for one call. `path` is REQUIRED: it is what the call asks of the
 * model (effort, thinking), applied from the table in `call-paths.ts`, so no
 * call runs at a model's default by leaving it out.
 */
export const getLanguageModel = async (modelId: AppModelId, path: CallPath) => {
  const model = await getAppModelDefinition(modelId);
  const languageProvider = getActiveGateway().createLanguageModel(
    model.apiModelId
  );

  const middlewares: Parameters<typeof wrapLanguageModel>[0]["middleware"][] =
    [];

  // FIRST, so it is the outermost layer: every middleware after it, the dev
  // tools recorder included, sees the request with the path's options merged.
  const callPath = callPathMiddleware(path, model.apiModelId);
  if (callPath) {
    middlewares.push(callPath);
  }

  // Add devtools middleware in development
  if (process.env.NODE_ENV === "development") {
    middlewares.push(devToolsMiddleware());
  }

  // Add reasoning middleware if the model supports reasoning
  if (model.reasoning && model.owned_by === "xai") {
    middlewares.push(extractReasoningMiddleware({ tagName: "think" }));
  }

  if (middlewares.length === 0) {
    return languageProvider;
  }

  return wrapLanguageModel({
    model: languageProvider as LanguageModelV3,
    middleware: middlewares as LanguageModelMiddleware[],
  });
};

export const getImageModel = (modelId: string) => {
  const imageModel = getActiveGateway().createImageModel(modelId);
  if (!imageModel) {
    throw new Error(
      `Gateway '${getActiveGateway().type}' does not support dedicated image models. Use a multimodal language model instead.`
    );
  }
  return imageModel;
};

export const getVideoModel = (modelId: string) => {
  const videoModel = getActiveGateway().createVideoModel(modelId);
  if (!videoModel) {
    throw new Error(
      `Gateway '${getActiveGateway().type}' does not support video models.`
    );
  }
  return videoModel;
};

// Get a multimodal language model that can generate images via generateText
export const getMultimodalImageModel = (modelId: string) =>
  getActiveGateway().createLanguageModel(modelId);

// Model aliases removed - use getLanguageModel directly with specific model IDs

export const getModelProviderOptions = async (
  providerModelId: AppModelId
): Promise<
  | {
      openai: OpenAIResponsesProviderOptions;
    }
  | {
      anthropic: AnthropicProviderOptions;
    }
  | {
      xai: Record<string, never>;
    }
  | {
      google: GoogleGenerativeAIProviderOptions;
    }
  | Record<string, never>
> => {
  const model = await getAppModelDefinition(providerModelId);
  if (model.owned_by === "openai") {
    if (model.reasoning) {
      // Strip provider prefix (e.g. "openai/gpt-5-mini" → "gpt-5-mini")
      // so the check works for all gateways (Vercel uses prefixed IDs, OpenAI direct does not)
      const modelName = model.apiModelId.split("/").pop() ?? model.apiModelId;
      return {
        openai: {
          reasoningSummary: "auto",
          ...(modelName === "gpt-5" ||
          modelName === "gpt-5-mini" ||
          modelName === "gpt-5-nano"
            ? { reasoningEffort: "low" }
            : {}),
        } satisfies OpenAIResponsesProviderOptions,
      };
    }
    return { openai: {} };
  }
  if (model.owned_by === "anthropic") {
    // Effort is not set here: the chat's model comes from
    // `getLanguageModel(id, "chat")`, which applies it to both variants (on
    // Opus, Sonnet and Haiku 5.5 the "non-reasoning" one thinks too, so effort
    // is what bounds a turn either way). This adds the per-model thinking
    // shape of a `-reasoning` variant on top.
    if (model.reasoning) {
      return {
        anthropic: {
          // PER MODEL, not one shape for all of them. `budgetTokens` is removed
          // on Opus 5 / 4.8 / 4.7, Sonnet 5 and Fable 5 (HTTP 400) and
          // deprecated on 4.6, where adaptive thinking replaces it — but every
          // model OLDER than 4.6 is the exact opposite: it has never heard of
          // "adaptive" and 400s on it. Both are in the catalog and both are
          // selectable, so the decision is a function of the id.
          // See lib/ai/anthropic-thinking.ts, which is unit-tested against
          // every id in ANTHROPIC_MODEL_IDS.
          thinking: anthropicThinkingOptions(model.apiModelId),
        } satisfies AnthropicProviderOptions,
      };
    }
    return { anthropic: {} };
  }
  if (model.owned_by === "xai") {
    return {
      xai: {},
    };
  }
  if (model.owned_by === "google") {
    if (model.reasoning) {
      return {
        google: {
          thinkingConfig: {
            thinkingBudget: 10_000,
          },
        },
      };
    }
    return { google: {} };
  }
  return {};
};
