import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import { convertToModelMessages, stepCountIs, streamText } from "ai";
import { addExplicitToolRequestToMessages } from "@/app/(chat)/api/chat/add-explicit-tool-request-to-messages";
import { filterPartsForLLM } from "@/app/(chat)/api/chat/filter-reasoning-parts";
import { getRecentGeneratedImage } from "@/app/(chat)/api/chat/get-recent-generated-image";
import { type AppModelId, getAppModelDefinition } from "@/lib/ai/app-models";
import { selectContextWindow } from "@/lib/ai/context-window";
import { markdownJoinerTransform } from "@/lib/ai/markdown-joiner-transform";
import { getLanguageModel, getModelProviderOptions } from "@/lib/ai/providers";
import { countTextTokens } from "@/lib/ai/token-utils";
import type { ChatMessage, StreamWriter, ToolName } from "@/lib/ai/types";
import { config } from "@/lib/config";
import type { CostAccumulator } from "@/lib/credits/cost-accumulator";
import {
  createMainChatUsageMeter,
  promptFloor,
} from "@/lib/credits/main-chat-usage";
import type { McpConnector } from "@/lib/db/schema";
import { createModuleLogger } from "@/lib/logger";
import { GATE_TRANSCRIPT_BUDGET_TOKENS } from "@/lib/phases/context";
import { ANONYMOUS_LIMITS } from "@/lib/types/anonymous";
import { replaceFilePartUrlByBinaryDataInMessages } from "@/lib/utils/download-assets";
import { getMcpTools, getTools } from "@/tools/platform/tools";

/**
 * How much conversation history the assistant is given, in tokens.
 *
 * DELIBERATELY THE SAME NUMBER AS THE GATE'S TRANSCRIPT BUDGET, and imported
 * rather than copied so it cannot drift.
 *
 * This used to be `.slice(-5)`. The phase gate judges up to
 * GATE_TRANSCRIPT_BUDGET_TOKENS of transcript and then BLOCKS the phase naming
 * a specific gap; the assistant answering the founder saw five messages. The
 * gate could therefore block on evidence the model was never shown, and the
 * founder's only symptom was an assistant that kept re-asking what it had
 * already been told. Sizing the window from the judge's own budget closes that
 * asymmetry for everything inside one chat.
 *
 * WHAT REMAINS, stated rather than hidden: the judge reads the PROJECT
 * transcript (every chat in the project) while a stream is necessarily one
 * chat's. A second chat's evidence still reaches the judge without reaching
 * this assistant. That gap is what the fact store is for — facts are
 * project-scoped, re-injected into the system prompt every turn, and their
 * budget was re-measured to carry the whole 8-phase vocabulary — and it is
 * logged as `omittedMessages` here whenever this window itself has to cut.
 */
export const CHAT_CONTEXT_BUDGET_TOKENS = GATE_TRANSCRIPT_BUDGET_TOKENS;

export async function createCoreChatAgent({
  system,
  userMessage,
  previousMessages,
  selectedModelId,
  explicitlyRequestedTools,
  userId,
  chatId,
  isAnonymous = false,
  abortSignal,
  requestDeadlineAt,
  messageId,
  dataStream,
  onError,
  onChunk,
  onContextTrimmed,
  mcpConnectors = [],
  costAccumulator,
}: {
  system: string;
  userMessage: ChatMessage;
  previousMessages: ChatMessage[];
  selectedModelId: AppModelId;
  explicitlyRequestedTools: ToolName[] | null;
  userId: string | null;
  /**
   * The chat this turn belongs to, which the caller has checked is the user's
   * own. Stored files are read through it (`lib/file-access.ts`); omitted by
   * callers with no stored chat (evals), which then read only the user's own.
   */
  chatId?: string;
  isAnonymous?: boolean;
  abortSignal?: AbortSignal;
  /**
   * Epoch ms at which the caller aborts `abortSignal` (the chat route's
   * timer). Deep research plans its stages against it. Omitted by callers with
   * no timer; the tool then assumes a full budget from when it starts.
   */
  requestDeadlineAt?: number;
  messageId: string;
  dataStream: StreamWriter;
  onError?: (error: unknown) => void;
  onChunk?: () => void;
  /**
   * Called when history had to be cut to fit the budget. A silent truncation
   * is the failure mode this whole change exists to remove: the caller logs it
   * so "the model did not know" is diagnosable instead of a mystery.
   */
  onContextTrimmed?: (omittedMessages: number) => void;
  mcpConnectors?: McpConnector[];
  /**
   * The turn's accumulator. The chat model's own usage is recorded on it here,
   * step by step (`createMainChatUsageMeter`); the tools record their own
   * model calls on it.
   */
  costAccumulator: CostAccumulator;
}) {
  const log = createModuleLogger("ai:core-chat-agent");
  const modelDefinition = await getAppModelDefinition(selectedModelId);

  // Build message thread. The history is fitted to a token budget; the user's
  // own message is never a candidate for eviction — dropping the question the
  // turn is answering is never the right trade — and the request-size check in
  // the route has already capped it at MAX_INPUT_TOKENS.
  const history = selectContextWindow(
    previousMessages,
    CHAT_CONTEXT_BUDGET_TOKENS,
    countTextTokens
  );
  if (history.omittedMessages > 0) {
    onContextTrimmed?.(history.omittedMessages);
  }
  const messages = [...history.messages, userMessage];

  // Process conversation history
  const lastGeneratedImage = getRecentGeneratedImage(messages);

  addExplicitToolRequestToMessages(messages, explicitlyRequestedTools);

  // Filter reasoning parts (cross-model compatibility)
  const filteredMessages = filterPartsForLLM(messages);

  // Convert to model messages, ignoring data-* parts (drop them)
  const modelMessages = await convertToModelMessages(filteredMessages, {
    convertDataPart: (_part): undefined => undefined,
  });

  // Replace file URLs with binary data. Only files this user could open
  // themselves are inlined (their own, or a pre-tag file this chat has held
  // since before the owner tag existed:
  // lib/file-access.ts::canReadStoredFile); an anonymous turn (userId null)
  // inlines none.
  const fileViewer = { userId, chatId: isAnonymous ? null : (chatId ?? null) };
  const contextForLLM = await replaceFilePartUrlByBinaryDataInMessages(
    modelMessages,
    fileViewer
  );

  // Get MCP tools if connectors are configured
  const { tools: mcpTools, cleanup: mcpCleanup } = await getMcpTools({
    connectors: mcpConnectors,
  });

  // Get base tools
  const baseTools = getTools({
    dataStream,
    session: {
      user: userId ? { id: userId } : undefined,
    },
    contextForLLM,
    messageId,
    selectedModel: modelDefinition.apiModelId,
    attachments: userMessage.parts.filter((part) => part.type === "file"),
    lastGeneratedImage,
    costAccumulator,
    requestDeadlineAt,
    chatId: fileViewer.chatId,
  });

  // Merge base tools with MCP tools
  const allTools = {
    ...baseTools,
    ...mcpTools,
  };

  // Compute final activeTools for streamText
  let activeBaseTools = Object.keys(baseTools) as ToolName[];
  let activeMcpTools = Object.keys(mcpTools) as ToolName[];
  if (!modelDefinition?.input) {
    activeBaseTools = [];
    activeMcpTools = [];
  } else if (isAnonymous) {
    activeBaseTools = activeBaseTools.filter((k) =>
      (ANONYMOUS_LIMITS.AVAILABLE_TOOLS as ToolName[]).includes(k)
    );
    activeMcpTools = [];
  }
  if (explicitlyRequestedTools !== null) {
    activeBaseTools = explicitlyRequestedTools.filter((k) =>
      activeBaseTools.includes(k)
    );
    activeMcpTools = explicitlyRequestedTools.filter((k) =>
      activeMcpTools.includes(k)
    );
  }
  const activeTools = [
    ...new Set([...activeBaseTools, ...activeMcpTools]),
  ] as (keyof typeof allTools)[];

  // Resolve async model config before streamText to ensure cleanup on failure
  let model: Awaited<ReturnType<typeof getLanguageModel>>;
  let providerOptions: Awaited<ReturnType<typeof getModelProviderOptions>>;
  try {
    [model, providerOptions] = await Promise.all([
      getLanguageModel(selectedModelId),
      getModelProviderOptions(selectedModelId),
    ]);
  } catch (error) {
    await mcpCleanup();
    throw error;
  }

  // The model's own output ceiling, or none when the catalog does not state
  // one. The OpenAI, LiteLLM, OpenAI-compatible and OpenRouter gateways write
  // `max_tokens: 0` for a model they have no figure for (OpenAI's /v1/models
  // reports none; `model-capabilities.ts` fills in only the models it lists).
  // That 0 means "unknown", not "zero tokens allowed": clamping to it would
  // cap every turn at 0 and fail it.
  const modelOutputCeiling =
    modelDefinition.max_tokens > 0
      ? modelDefinition.max_tokens
      : config.ai.maxOutputTokens;

  // The chat model's usage, recorded per step as the stream passes; see
  // `createMainChatUsageMeter` for why it is a transform and how a step cut
  // off by an abort is estimated.
  const recordMainChatUsage = createMainChatUsageMeter<typeof allTools>({
    costAccumulator,
    modelId: selectedModelId,
    countTokens: countTextTokens,
    getPromptFloor: () => promptFloor(system, contextForLLM),
    onCutStepEstimated: (estimate) => {
      log.warn(
        { messageId, chatId, selectedModelId, ...estimate },
        "chat step cut off by an abort or a broken connection: its usage is an estimate"
      );
    },
    onStepWithoutUsage: (finishReason) => {
      log.warn(
        { messageId, chatId, selectedModelId, finishReason },
        "chat step finished with no usage reported: nothing charged for it"
      );
    },
    onMeterError: (error) => {
      log.error(
        { messageId, chatId, selectedModelId, error },
        "chat usage meter failed: the stream went on, a count fell back to characters"
      );
    },
  });

  const result = streamText({
    model,
    system,
    messages: contextForLLM,
    /**
     * THE READER FOR `config.ai.maxOutputTokens`. Before 2026-08-22 there was
     * no output cap in this app at all, so how long a turn could run was a
     * provider default nobody had chosen and nobody could see. A
     * `createTextDocument` call died mid-table-row at 26,731 characters of
     * input with no output, no error and no document, and the founder had to
     * discover it (Incident 6 in docs/INCIDENTS.md).
     *
     * Clamped by the model's own ceiling: `max_tokens` comes from the model
     * catalog and a request above it is a provider error, so the config value
     * may lower the limit but never raise it past what the model accepts.
     * An unstated ceiling leaves the configured cap in force.
     */
    maxOutputTokens: Math.min(config.ai.maxOutputTokens, modelOutputCeiling),
    stopWhen: [
      stepCountIs(5),
      ({ steps }) => {
        return steps.some((step) => {
          const toolResults = step.content;
          // Don't stop if the tool result is a clarifying question
          return toolResults.some(
            (toolResult) =>
              toolResult.type === "tool-result" &&
              toolResult.toolName === "deepResearch" &&
              (toolResult.output as { format?: string }).format === "report"
          );
        });
      },
    ],
    activeTools,
    // The usage meter goes FIRST so it counts what the model streamed, not
    // what the markdown joiner has released so far.
    experimental_transform: [recordMainChatUsage, markdownJoinerTransform()],
    experimental_telemetry: {
      isEnabled: true,
      functionId: "chat-response",
    },
    tools: allTools,
    onError: (error) => {
      onError?.(error);
    },
    onChunk,
    abortSignal,
    providerOptions: providerOptions as SharedV3ProviderOptions,
    onFinish: async () => {
      // Clean up MCP clients when streaming is done (onFinish runs for both success and error)
      await mcpCleanup();
    },
  });

  return {
    result,
    contextForLLM,
    modelDefinition,
    mcpCleanup,
  };
}
