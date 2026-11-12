import {
  convertToModelMessages,
  createUIMessageStream,
  type InferUIMessageChunk,
  JsonToSseTransformStream,
} from "ai";
import { headers } from "next/headers";
import type { NextRequest } from "next/server";
import { after } from "next/server";
import { createClient } from "redis";
import {
  createResumableStreamContext,
  type ResumableStreamContext,
} from "resumable-stream";
import throttle from "throttleit";
import {
  type AppModelDefinition,
  type AppModelId,
  getAppModelDefinition,
} from "@/lib/ai/app-models";
import { createCoreChatAgent } from "@/lib/ai/core-chat-agent";
import { determineExplicitlyRequestedTools } from "@/lib/ai/determine-explicitly-requested-tools";
import { ChatSDKError } from "@/lib/ai/errors";
import {
  generateFollowupSuggestions,
  streamFollowupSuggestions,
} from "@/lib/ai/followup-suggestions";
import { systemPrompt } from "@/lib/ai/prompts";
import { CHAT_REQUEST_BUDGET_MS } from "@/lib/ai/request-budget";
import { getStreamErrorMessage } from "@/lib/ai/stream-errors";
import { calculateMessagesTokens } from "@/lib/ai/token-utils";
import {
  type ChatMessage,
  getPrimarySelectedModelId,
  isSelectedModelValue,
  type ToolName,
} from "@/lib/ai/types";
import {
  getAnonymousSession,
  setAnonymousSession,
} from "@/lib/anonymous-session-server";
import {
  findDeadInputStreams,
  partialDocumentBody,
  partialDocumentTitle,
  type SalvagedTextDocument,
  type SavedPartialDocument,
  sweepDeadInputStreams,
} from "@/lib/artifacts/text/salvage";
import { auth } from "@/lib/auth";
import { config } from "@/lib/config";
import { createAnonymousSession } from "@/lib/create-anonymous-session";
import { CostAccumulator } from "@/lib/credits/cost-accumulator";
import { canSpend, deductCredits } from "@/lib/db/credits";
import { getMcpConnectorsByUserId } from "@/lib/db/mcp-queries";
import {
  getChatById,
  getMessageById,
  getMessageCanceledAt,
  getProjectById,
  getUserById,
  saveChatIfNotExists,
  saveDocument,
  saveMessageIfNotExists,
  updateMessage,
  updateMessageActiveStreamId,
} from "@/lib/db/queries";
import type { McpConnector } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { MAX_INPUT_TOKENS } from "@/lib/limits/tokens";
import { createModuleLogger } from "@/lib/logger";
import { runPostTurnPersonaPass } from "@/lib/personas/post-turn";
import {
  buildPhaseSystemBlock,
  runPostTurnPhasePass,
} from "@/lib/phases/runtime";
import type { AnonymousSession } from "@/lib/types/anonymous";
import { ANONYMOUS_LIMITS } from "@/lib/types/anonymous";
import { generateUUID } from "@/lib/utils";
import { checkAnonymousRateLimit, getClientIP } from "@/lib/utils/rate-limit";
import { generateTitleFromUserMessage } from "../../actions";
import { getThreadUpToMessageId } from "./get-thread-up-to-message-id";

// Shared Redis clients for resumable stream
let redisPublisher: ReturnType<typeof createClient> | null = null;
let redisSubscriber: ReturnType<typeof createClient> | null = null;

if (env.REDIS_URL) {
  redisPublisher = createClient({ url: env.REDIS_URL });
  redisSubscriber = createClient({ url: env.REDIS_URL });
  await Promise.all([redisPublisher.connect(), redisSubscriber.connect()]);
}

let globalStreamContext: ResumableStreamContext | null = null;

export function getStreamContext(): ResumableStreamContext | null {
  if (globalStreamContext) {
    return globalStreamContext;
  }

  // Resumable streams require Redis - return null if not configured
  if (!(redisPublisher && redisSubscriber)) {
    return null;
  }

  globalStreamContext = createResumableStreamContext({
    waitUntil: after,
    keyPrefix: `${config.appPrefix}:resumable-stream`,
    publisher: redisPublisher,
    subscriber: redisSubscriber,
  });

  return globalStreamContext;
}

type AnonymousSessionResult =
  | { success: true; session: AnonymousSession }
  | { success: false; error: Response };

async function handleAnonymousSession({
  request,
  redis,
  selectedModelId,
}: {
  request: NextRequest;
  redis: ReturnType<typeof import("redis").createClient> | null;
  selectedModelId: AppModelId;
}): Promise<AnonymousSessionResult> {
  const log = createModuleLogger("api:chat:anonymous");

  const clientIP = getClientIP(request);
  const rateLimitResult = await checkAnonymousRateLimit(clientIP, redis);

  if (!rateLimitResult.success) {
    log.warn({ clientIP }, "Rate limit exceeded");
    return {
      success: false,
      error: Response.json(
        { error: rateLimitResult.error, type: "RATE_LIMIT_EXCEEDED" },
        { status: 429, headers: rateLimitResult.headers || {} }
      ),
    };
  }

  const session =
    (await getAnonymousSession()) ?? (await createAnonymousSession());

  if (session.remainingCredits <= 0) {
    log.info("Anonymous credit limit reached");
    return {
      success: false,
      error: Response.json(
        {
          error: "You've used your free credits. Sign up to continue chatting!",
          type: "ANONYMOUS_LIMIT_EXCEEDED",
          suggestion:
            "Create an account to get more credits and access to more AI models",
        },
        { status: 402, headers: rateLimitResult.headers || {} }
      ),
    };
  }

  if (
    !(ANONYMOUS_LIMITS.AVAILABLE_MODELS as readonly AppModelId[]).includes(
      selectedModelId
    )
  ) {
    log.warn("Model not available for anonymous users");
    return {
      success: false,
      error: Response.json(
        {
          error: "Model not available for anonymous users",
          availableModels: ANONYMOUS_LIMITS.AVAILABLE_MODELS,
        },
        { status: 403, headers: rateLimitResult.headers || {} }
      ),
    };
  }

  return { success: true, session };
}

async function handleChatValidation({
  chatId,
  userId,
  userMessage,
  projectId,
  costAccumulator,
}: {
  chatId: string;
  userId: string;
  userMessage: ChatMessage;
  projectId?: string;
  /** The turn's accumulator; a new chat's title call is recorded on it. */
  costAccumulator: CostAccumulator;
}): Promise<{ error: Response | null; isNewChat: boolean }> {
  const log = createModuleLogger("api:chat:validation");

  const chat = await getChatById({ id: chatId });
  let isNewChat = false;

  if (chat) {
    if (chat.userId !== userId) {
      log.warn(
        {
          chatId,
          userId,
          chatUserId: chat.userId,
        },
        "Unauthorized - chat ownership mismatch"
      );
      return {
        error: new Response("Unauthorized", { status: 401 }),
        isNewChat,
      };
    }
  } else {
    // A NEW CHAT MAY ONLY BE FILED UNDER THE REQUESTER'S OWN PROJECT.
    // `projectId` comes straight from the request body, and once it is on the
    // Chat row every project-scoped read trusts it: the system prompt loads
    // that project's instructions, facts and gate verdict, and the post-turn
    // passes extract into its fact store, re-run its gate and save personas
    // under it. Without this check any signed-in user could read and write
    // another founder's project by naming its id. "No such project" and "not
    // yours" get the same answer so a caller cannot probe which ids exist —
    // the posture of `api/chat/prepare/route.ts::validatePrepareProject`.
    // Checked before the title is generated so a refused request costs no
    // model call.
    if (projectId) {
      const project = await getProjectById({ id: projectId });
      if (!project || project.userId !== userId) {
        log.warn(
          {
            chatId,
            userId,
            projectId,
            hasProject: !!project,
            projectUserId: project?.userId ?? null,
          },
          "Unauthorized - project ownership mismatch"
        );
        return {
          error: new Response("Unauthorized", { status: 401 }),
          isNewChat,
        };
      }
    }

    // CREDITS BEFORE THE TITLE. The title is a charged model call
    // (`app/(chat)/actions.ts::generateTitleFromUserMessage`), and the turn's
    // own credit check in `handleUserValidationAndCredits` runs only after
    // this function returns — so a founder at zero credits was billed for a
    // title on the way to the 402. Checked after the ownership checks above,
    // so an unauthorised request still gets its 401, not a balance answer.
    //
    // The title is recorded on the TURN's accumulator, not charged here: on
    // its own it was rounded up to 1¢ for a fraction of a cent, and with
    // exactly 1¢ left that charge made the turn's own check refuse the turn
    // the check below had just admitted. It is now rounded once with the turn
    // and deducted with it: by `chargeTurnOnce` once the turn's stream exists,
    // or by `POST`'s `finally` when the request ends before that. This is the
    // turn's only balance check (`handleUserValidationAndCredits`).
    const creditError = await checkUserCanSpend(userId);
    if (creditError) {
      return { error: creditError, isNewChat };
    }

    isNewChat = true;
    const title = await generateTitleFromUserMessage({
      message: userMessage,
      userId,
      costAccumulator,
    });

    await saveChatIfNotExists({ id: chatId, userId, title, projectId });
  }

  const [existentMessage] = await getMessageById({ id: userMessage.id });

  if (existentMessage && existentMessage.chatId !== chatId) {
    log.warn(
      {
        chatId,
        userMessageId: userMessage.id,
        existentMessageChatId: existentMessage.chatId,
      },
      "Unauthorized - message chatId mismatch"
    );
    return { error: new Response("Unauthorized", { status: 401 }), isNewChat };
  }

  await saveMessageIfNotExists({
    id: userMessage.id,
    chatId,
    message: userMessage,
  });

  return { error: null, isNewChat };
}

function resolveSelectedModelId({
  requestSelectedModelId,
  selectedModel,
}: {
  requestSelectedModelId?: AppModelId;
  selectedModel: ChatMessage["metadata"]["selectedModel"];
}): AppModelId | null {
  if (typeof selectedModel === "string") {
    return requestSelectedModelId ?? selectedModel;
  }

  if (requestSelectedModelId) {
    if (!selectedModel || typeof selectedModel !== "object") {
      return null;
    }
    const requestedCount = selectedModel[requestSelectedModelId];
    return requestedCount && requestedCount > 0 ? requestSelectedModelId : null;
  }

  return getPrimarySelectedModelId(selectedModel);
}

async function checkUserCanSpend(userId: string): Promise<Response | null> {
  const userCanSpend = await canSpend(userId);
  if (!userCanSpend) {
    return new Response("Insufficient credits", { status: 402 });
  }
  return null;
}

async function handleUserValidationAndCredits({
  chatId,
  userId,
  userMessage,
  projectId,
  costAccumulator,
}: {
  chatId: string;
  userId: string;
  userMessage: ChatMessage;
  projectId?: string;
  costAccumulator: CostAccumulator;
}): Promise<{ error: Response } | { isNewChat: boolean }> {
  const validationResult = await handleChatValidation({
    chatId,
    userId,
    userMessage,
    projectId,
    costAccumulator,
  });
  if (validationResult.error) {
    return { error: validationResult.error };
  }

  // A new chat's balance was already checked in this request, before its
  // title (`handleChatValidation`). Checking again could only refuse a turn
  // that check admitted, after the chat and the founder's message were saved.
  if (!validationResult.isNewChat) {
    const creditError = await checkUserCanSpend(userId);
    if (creditError) {
      return { error: creditError };
    }
  }

  return { isNewChat: validationResult.isNewChat };
}

/** The plain text of a message, for ranking the fact block against this turn. */
function messageText(uiMessage: ChatMessage): string {
  return uiMessage.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("\n")
    .trim();
}

async function getSystemPrompt({
  isAnonymous,
  chatId,
  userMessage,
  costAccumulator,
}: {
  isAnonymous: boolean;
  chatId: string;
  userMessage: ChatMessage;
  costAccumulator: CostAccumulator;
}): Promise<string> {
  let system = systemPrompt();
  if (!isAnonymous) {
    const currentChat = await getChatById({ id: chatId });
    if (currentChat?.projectId) {
      const project = await getProjectById({ id: currentChat.projectId });
      // DEFENCE IN DEPTH. handleChatValidation refuses a new chat filed under
      // someone else's project, but a Chat row written before that check (or
      // by any future path that forgets it) still names the project. A
      // project that is missing or not owned by the chat's owner contributes
      // nothing — no instructions, no facts, no verdict — and the turn runs
      // as a plain chat.
      if (!project || project.userId !== currentChat.userId) {
        return system;
      }
      if (project.instructions) {
        system = `${system}\n\nProject instructions:\n${project.instructions}`;
      }
      // Phase persona + phase brief + the ranked fact block + the GATE VERDICT
      // FROM THE PREVIOUS TURN. That last part is the loop: the gate runs in
      // after(), post-flush, so its verdict cannot reach the turn it judged —
      // this system prompt is the only place it can land.
      //
      // Anonymous chats have no project, so they never enter a phase — that is
      // the deliberate answer to "what happens to the gate for anonymous users".
      const phaseBlock = await buildPhaseSystemBlock({
        projectId: currentChat.projectId,
        latestUserMessage: messageText(userMessage),
        costAccumulator,
      });
      system = `${system}\n\n${phaseBlock}`;
    }
  }
  return system;
}

async function createChatStream({
  messageId,
  chatId,
  userMessage,
  previousMessages,
  selectedModelId,
  parallelGroupId,
  parallelIndex,
  isPrimaryParallel,
  explicitlyRequestedTools,
  userId,
  abortController,
  requestDeadlineAt,
  isAnonymous,
  isNewChat,
  timeoutId,
  mcpConnectors,
  streamId,
  onChunk,
  turnCost,
}: {
  messageId: string;
  chatId: string;
  userMessage: ChatMessage;
  previousMessages: ChatMessage[];
  selectedModelId: AppModelId;
  parallelGroupId: string | null;
  parallelIndex: number | null;
  isPrimaryParallel: boolean | null;
  explicitlyRequestedTools: ToolName[] | null;
  userId: string | null;
  abortController: AbortController;
  requestDeadlineAt: number;
  isAnonymous: boolean;
  isNewChat: boolean;
  timeoutId: NodeJS.Timeout;
  mcpConnectors: McpConnector[];
  streamId: string;
  onChunk?: () => void;
  /**
   * The turn's cost, created in `POST` before the title call. Building the
   * system prompt below can spend into its accumulator too (the phase block
   * embeds this turn's message to rank the fact store). Charged once by
   * `chargeTurnOnce`, from onFinish or from `executeChatRequest`'s drain.
   */
  turnCost: TurnCost;
}): Promise<{
  stream: ReadableStream<InferUIMessageChunk<ChatMessage>>;
  spendRecorded: Promise<void>;
}> {
  const log = createModuleLogger("api:chat:stream");
  const costAccumulator = turnCost.accumulator;

  // WHEN THE TURN'S SPENDING IS ALL RECORDED. The model's "main-chat" usage is
  // recorded step by step by a transform inside `streamText`
  // (`createCoreChatAgent`, `createMainChatUsageMeter`), upstream of both
  // readers of the model stream, so all of it is in by the time
  // `result.consumeStream()` resolves, an aborted turn's estimate included;
  // the follow-up suggestions are recorded after that, inside `execute`.
  // onFinish does not mark that moment: it runs from the finish transform's
  // `flush` at the end, but also from its `cancel`, which an error partway
  // through the stream reaches at once while the model goes on (verified with
  // ai@6.0.219 on Node). So a charge waits for `execute` to end. Resolves
  // whether `execute` succeeds or throws.
  let markExecuteEnded: () => void = () => undefined;
  const spendRecorded = new Promise<void>((resolve) => {
    markExecuteEnded = resolve;
  });

  const system = await getSystemPrompt({
    isAnonymous,
    chatId,
    userMessage,
    costAccumulator,
  });

  // Build the data stream that will emit tokens
  const stream = createUIMessageStream<ChatMessage>({
    execute: async ({ writer: dataStream }) => {
      try {
        // Confirm chat persistence on first message (chat + user message are persisted before streaming begins)
        if (isNewChat) {
          dataStream.write({
            id: generateUUID(),
            type: "data-chatConfirmed",
            data: { chatId },
            transient: true,
          });
        }

        const { result, contextForLLM } = await createCoreChatAgent({
          system,
          userMessage,
          previousMessages,
          selectedModelId,
          explicitlyRequestedTools,
          userId,
          chatId,
          isAnonymous,
          abortSignal: abortController.signal,
          requestDeadlineAt,
          messageId,
          dataStream,
          onError: (error) => {
            log.error({ error }, "streamText error");
          },
          onChunk,
          onContextTrimmed: (omittedMessages) => {
            // Never silent: this is the one place the assistant is knowingly
            // shown less than the whole conversation, and the phase gate judges
            // the whole of it.
            log.info(
              { chatId, omittedMessages },
              "chat context trimmed to budget — older messages are carried by the project fact store"
            );
          },
          mcpConnectors,
          costAccumulator,
        });

        const initialMetadata: ChatMessage["metadata"] = {
          createdAt: new Date(),
          parentMessageId: userMessage.id,
          parallelGroupId,
          parallelIndex,
          isPrimaryParallel,
          selectedModel: selectedModelId,
          activeStreamId: isAnonymous ? null : streamId,
        };

        dataStream.merge(
          result.toUIMessageStream({
            sendReasoning: true,
            messageMetadata: ({ part }) => {
              // send custom information to the client on start:
              if (part.type === "start") {
                return initialMetadata;
              }

              // when the message is finished, send additional information.
              // The usage here is for the client only: the turn's
              // "main-chat" cost is recorded step by step inside
              // `createCoreChatAgent` (`createMainChatUsageMeter`), because
              // an aborted turn, or one a provider error ends in a later
              // step, never reaches this part.
              if (part.type === "finish") {
                return {
                  ...initialMetadata,
                  usage: part.totalUsage,
                  activeStreamId: null,
                };
              }
            },
          })
        );
        await result.consumeStream();

        const response = await result.response;
        const responseMessages = response.messages;

        // Generate and stream follow-up suggestions
        if (config.ai.tools.followupSuggestions.enabled) {
          const followupSuggestionsResult = generateFollowupSuggestions([
            ...contextForLLM,
            ...responseMessages,
          ]);
          await streamFollowupSuggestions({
            followupSuggestionsResult,
            writer: dataStream,
            costAccumulator,
          });
        }
      } finally {
        // The deadline timer is cleared here, when the model and the
        // follow-ups are done, and not in onFinish or onError: an error
        // partway through the stream runs both of those at once while the
        // model goes on, and clearing the timer there turned off the 290 s
        // backstop for the rest of the call.
        clearTimeout(timeoutId);
        markExecuteEnded();
      }
    },
    generateId: () => messageId,
    onFinish: async ({ isAborted, messages }) => {
      await finalizeMessageAndCredits({
        messages,
        userId,
        isAnonymous,
        chatId,
        turnCost,
        spendRecorded,
        selectedModelId,
        parallelGroupId,
        parallelIndex,
        isPrimaryParallel,
      });

      // Post-turn phase pass: extract facts, then re-run the gate.
      // Guards, in order:
      //  - isAborted: a cancelled turn produced no complete answer to learn from.
      //  - isAnonymous: no project, so no phase and no fact store.
      //  - isPrimaryParallel === false: parallel responses fire onFinish more
      //    than once per user message; only the primary may write facts.
      // Runs inside `after()` so it never delays the flushed response.
      if (isAborted || isAnonymous || isPrimaryParallel === false) {
        return;
      }
      const finishedChat = await getChatById({ id: chatId });
      if (!finishedChat?.projectId) {
        return;
      }
      // Same defence as getSystemPrompt, and it matters more here: these
      // passes WRITE — facts into the project's store, a verdict onto its
      // gate, personas under it. A chat whose owner is not the project's
      // owner must never reach them, whatever wrote its projectId.
      const phaseProject = await getProjectById({
        id: finishedChat.projectId,
      });
      if (!phaseProject || phaseProject.userId !== finishedChat.userId) {
        log.warn(
          {
            chatId,
            chatUserId: finishedChat.userId,
            projectId: finishedChat.projectId,
            hasProject: !!phaseProject,
          },
          "post-turn passes skipped - chat owner does not own its project"
        );
        return;
      }
      const phaseProjectId = phaseProject.id;
      const phaseUserId = phaseProject.userId;
      // THE ROUTE IS THE SEQUENCER. The phase pass now reports what it did, and
      // the persona pass decides off that report. Kept here rather than inside
      // runPostTurnPhasePass so lib/phases/runtime.ts does not import
      // lib/personas (which reaches the db client).
      //
      // Awaited in sequence, not raced: the persona is built from the facts the
      // phase pass has just written, so running them concurrently would build it
      // from the previous turn's fact store.
      //
      // CHARGED SEPARATELY. The turn's own cost is settled by `chargeTurnOnce`,
      // which does not wait for these passes, so their calls — extraction,
      // the gate judge, the embedding backfill, a persona regeneration — go
      // into a second accumulator and a second deduction, made in `finally` so
      // a pass that throws past its own guards is still charged for what it
      // spent. No second canSpend: the turn already passed it, and these
      // passes are what keeps the founder's phase state true. Being rounded
      // up to a whole cent on its own, this deduction costs the founder less
      // than 1¢ more per project turn than one rounding with the turn would;
      // folding it into the turn is not possible, because the turn's charge
      // does not wait for these passes to end.
      after(async () => {
        const postTurnCost = new CostAccumulator();
        try {
          const outcome = await runPostTurnPhasePass({
            projectId: phaseProjectId,
            userId: phaseUserId,
            chatId,
            assistantMessageId: messageId,
            costAccumulator: postTurnCost,
          });
          await runPostTurnPersonaPass({
            projectId: phaseProjectId,
            userId: phaseUserId,
            assistantMessageId: messageId,
            outcome,
            costAccumulator: postTurnCost,
          });
        } finally {
          await chargeAccumulatedCost({
            userId,
            costAccumulator: postTurnCost,
            label: "Post-turn",
          });
        }
      });
    },
    onError: (error) => {
      // If the stream fails, ensure the placeholder assistant message is no longer marked resumable.
      // Otherwise the client will try to resume a stream that no longer exists and we end up with a
      // stuck partial placeholder on reload.
      if (!isAnonymous) {
        after(() =>
          Promise.resolve(
            updateMessageActiveStreamId({
              id: messageId,
              activeStreamId: null,
            })
          ).catch((dbError) => {
            log.error(
              { error: dbError },
              "Failed to clear activeStreamId on stream error"
            );
          })
        );
      }

      log.error({ error }, "onError");
      return getStreamErrorMessage(error);
    },
  });

  return { stream, spendRecorded };
}

function emptyChatStreamResponse() {
  const stream = createUIMessageStream<ChatMessage>({
    execute: () => undefined,
  });

  return new Response(stream.pipeThrough(new JsonToSseTransformStream()), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/**
 * The turn's cost meter and who settles it. Created in `POST` before the new
 * chat's title call, so the title is rounded and charged with the turn.
 * `settledByStream` turns true when `executeChatRequest` starts draining the
 * chat stream to its end in the background, and from then on the stream's
 * onFinish charges it, whoever reads the response; until then `POST` does, so
 * a title paid for on a request that ends before the stream exists is still
 * charged.
 *
 * `charged` turns true in `chargeTurnOnce`, synchronously after the settle and
 * before the deduction is attempted. Once the stream has taken over, two paths
 * can reach the charge (onFinish, and the background drain when it ends), and
 * this flag is what lets only the first one deduct.
 *
 * `chargeTakenByOnFinish` turns true when onFinish starts
 * (`finalizeMessageAndCredits`), which then always hands a charge to
 * `after()`. The drain's charge exists for a stream that never ran onFinish,
 * so it stands down once this is set instead of racing onFinish's charge.
 */
type TurnCost = {
  accumulator: CostAccumulator;
  settledByStream: boolean;
  charged: boolean;
  chargeTakenByOnFinish: boolean;
};

async function executeChatRequest({
  chatId,
  userMessage,
  previousMessages,
  selectedModelId,
  assistantMessageId,
  parallelGroupId,
  parallelIndex,
  isPrimaryParallel,
  explicitlyRequestedTools,
  userId,
  isAnonymous,
  isNewChat,
  abortController,
  requestDeadlineAt,
  timeoutId,
  mcpConnectors,
  turnCost,
}: {
  chatId: string;
  userMessage: ChatMessage;
  previousMessages: ChatMessage[];
  selectedModelId: AppModelId;
  assistantMessageId?: string;
  parallelGroupId: string | null;
  parallelIndex: number | null;
  isPrimaryParallel: boolean | null;
  explicitlyRequestedTools: ToolName[] | null;
  userId: string | null;
  isAnonymous: boolean;
  isNewChat: boolean;
  abortController: AbortController;
  /** Epoch ms at which `abortController` is aborted by the route's timer. */
  requestDeadlineAt: number;
  timeoutId: NodeJS.Timeout;
  mcpConnectors: McpConnector[];
  turnCost: TurnCost;
}): Promise<Response> {
  const log = createModuleLogger("api:chat:execute");
  const messageId = assistantMessageId ?? generateUUID();
  const streamId = generateUUID();

  if (!isAnonymous) {
    // The first provisional request can replay before chatConfirmed arrives, so
    // placeholder creation must be idempotent.
    const insertedMessage = await saveMessageIfNotExists({
      id: messageId,
      chatId,
      message: {
        id: messageId,
        role: "assistant",
        parts: [],
        metadata: {
          createdAt: new Date(),
          parentMessageId: userMessage.id,
          parallelGroupId,
          parallelIndex,
          isPrimaryParallel,
          selectedModel: selectedModelId,
          selectedTool: undefined,
          activeStreamId: streamId,
        },
      },
    });

    if (!insertedMessage) {
      clearTimeout(timeoutId);
      return emptyChatStreamResponse();
    }

    await updateMessageActiveStreamId({
      id: messageId,
      activeStreamId: streamId,
    });
  }

  // Create throttled cancel check (max once per second) for authenticated users
  const onChunk =
    !isAnonymous && userId
      ? throttle(async () => {
          const canceledAt = await getMessageCanceledAt({ messageId });
          if (canceledAt) {
            abortController.abort();
          }
        }, 1000)
      : undefined;

  // Build the data stream that will emit tokens
  const { stream, spendRecorded } = await createChatStream({
    messageId,
    chatId,
    userMessage,
    previousMessages,
    selectedModelId,
    parallelGroupId,
    parallelIndex,
    isPrimaryParallel,
    explicitlyRequestedTools,
    userId,
    abortController,
    requestDeadlineAt,
    isAnonymous,
    isNewChat,
    timeoutId,
    mcpConnectors,
    streamId,
    onChunk,
    turnCost,
  });

  const publisher = redisPublisher;
  if (publisher) {
    after(async () => {
      try {
        const keyPattern = `${config.appPrefix}:resumable-stream:rs:sentinel:${streamId}*`;
        const keys = await publisher.keys(keyPattern);
        if (keys.length > 0) {
          await Promise.all(
            keys.map((key: string) => publisher.expire(key, 300))
          );
        }
      } catch (error) {
        log.error({ error }, "Failed to set TTL on stream keys");
      }
    });
  }

  const sseHeaders = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  } as const;

  // WHO CHARGES THE TURN. The stream's onFinish settles the accumulator, and
  // it runs from the finish transform inside `createUIMessageStream` (AI SDK
  // `handleUIMessageStreamFinish`): from its `flush` when the stream is read
  // to its end, or from its `cancel` when the reader cancels it, whichever
  // comes first (a `finishCalled` guard makes it once). Letting the client's
  // reader decide that was the defect, twice over:
  //  - A plain Response body is cancelled when the client disconnects. onFinish
  //    then ran at once and settled the accumulator, while the model went on
  //    (`abortController` is not tied to the request), and its "main-chat"
  //    usage landed after settlement: closing the tab mid-reply on a
  //    deployment without Redis made the turn free.
  //  - resumable-stream's read loop (`createNewResumableStream`) has no catch:
  //    a rejected Redis publish while someone resumes stops it reading for
  //    good, `flush` never runs, and nothing charges the turn.
  // So the stream is teed here, and one branch is drained to its end in the
  // background whoever reads the other. A tee cancels its source only when
  // both branches cancel, so a client cancel never reaches the finish
  // transform, and the drained branch reaches `flush` only after the source
  // closes, which `createUIMessageStream` does once `execute` and every merged
  // stream (the model's last part included) are done: onFinish runs once, at
  // the real end, with the whole usage recorded. The drain is handed to
  // `after()` as a promise, not a callback, so it starts now (a callback would
  // wait for the response to close, which a stalled resumable read loop never
  // does) and the invocation is kept alive until it ends. A branch nobody
  // reads buffers one turn's output; a cancelled branch buffers nothing.
  //
  // An error partway through the stream (the SDK's message processor rejects
  // a malformed chunk) still reaches the finish transform's `cancel`, so
  // onFinish runs then, before the model has finished; it hands
  // `chargeTurnOnce` to `after()`, which waits for `spendRecorded` before it
  // settles, so that charge is whole too and the client gets the error at
  // once. When the drain ends, resolved or rejected, it calls `chargeTurnOnce`
  // as well: a no-op once onFinish has taken the charge, and the charge when a
  // stream error never ran onFinish. On Node it does run it; Bun did not call the transformer's
  // `cancel` hook in the same check, so that path rests on a runtime detail
  // and is not left to it.
  //
  // `settledByStream` flips here, with the drain: from this point onFinish or
  // the drain charges the turn; before it, `POST`'s `finally` charges what the
  // accumulator holds.
  const [clientStream, settlementStream] = stream.tee();
  turnCost.settledByStream = true;
  after(
    settlementStream
      .pipeTo(new WritableStream())
      .catch((error: unknown) => {
        log.error({ error, streamId }, "chat stream failed before its end");
      })
      .then(() =>
        chargeTurnOnce({
          turnCost,
          spendRecorded,
          userId,
          isAnonymous,
          chatId,
          from: "drain",
        })
      )
  );

  let clientStreamTaken = false;
  const sseStream = () => {
    clientStreamTaken = true;
    return clientStream.pipeThrough(new JsonToSseTransformStream());
  };

  const streamContext = getStreamContext();
  if (streamContext) {
    // resumable-stream talks to Redis (incr, then subscribe) before it calls
    // `makeStream`. A Redis error there used to fail the request with a 500
    // while `execute` had already started the model call. The turn is charged
    // by the drain above either way; on a rejection (or a null, which a fresh
    // stream id should never get) before `makeStream` ran, the client's branch
    // is served without resumability instead of the 500.
    try {
      const resumable = await streamContext.resumableStream(
        streamId,
        sseStream
      );
      if (resumable) {
        log.debug("Returning resumable stream");
        return new Response(resumable, { headers: sseHeaders });
      }
      if (clientStreamTaken) {
        throw new Error(
          "resumable stream returned no body after taking the chat stream"
        );
      }
      log.warn(
        { streamId },
        "resumable stream returned null; serving it plain"
      );
    } catch (error) {
      // `makeStream` already ran: the client's branch is locked, so piping it
      // a second time would throw. The error goes to `POST` (a 500), whose
      // `finally` skips the charge; the drain charges the turn.
      if (clientStreamTaken) {
        throw error;
      }
      log.error(
        { error, streamId },
        "resumable stream failed before it took the chat stream; serving it plain"
      );
    }
  }

  return new Response(sseStream(), { headers: sseHeaders });
}

type SessionSetupResult =
  | { success: false; error: Response }
  | {
      success: true;
      userId: string | null;
      isAnonymous: boolean;
      anonymousSession: AnonymousSession | null;
      modelDefinition: AppModelDefinition;
    };

async function validateAndSetupSession({
  request,
  selectedModelId,
}: {
  request: NextRequest;
  selectedModelId: AppModelId;
}): Promise<SessionSetupResult> {
  const log = createModuleLogger("api:chat:setup");

  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session?.user?.id ?? null;
  const isAnonymous = userId === null;

  let anonymousSession: AnonymousSession | null = null;

  if (userId) {
    const user = await getUserById({ userId });
    if (!user) {
      log.warn("User not found");
      return {
        success: false,
        error: new Response("User not found", { status: 404 }),
      };
    }
  } else {
    const result = await handleAnonymousSession({
      request,
      redis: redisPublisher,
      selectedModelId,
    });

    if (!result.success) {
      return result;
    }
    anonymousSession = result.session;
  }

  let modelDefinition: AppModelDefinition;
  try {
    modelDefinition = await getAppModelDefinition(selectedModelId);
  } catch {
    log.warn("Model not found");
    return {
      success: false,
      error: new Response("Model not found", { status: 404 }),
    };
  }

  return {
    success: true,
    userId,
    isAnonymous,
    anonymousSession,
    modelDefinition,
  };
}

async function prepareRequestContext({
  userMessage,
  chatId,
  isAnonymous,
  anonymousPreviousMessages,
}: {
  userMessage: ChatMessage;
  chatId: string;
  isAnonymous: boolean;
  anonymousPreviousMessages: ChatMessage[];
}): Promise<{
  previousMessages: ChatMessage[];
  error: Response | null;
}> {
  const log = createModuleLogger("api:chat:prepare");

  // Validate input token limit (50k tokens for user message)
  const totalTokens = calculateMessagesTokens(
    await convertToModelMessages([userMessage])
  );

  if (totalTokens > MAX_INPUT_TOKENS) {
    log.warn({ totalTokens, MAX_INPUT_TOKENS }, "Token limit exceeded");
    const error = new ChatSDKError(
      "input_too_long:chat",
      `Message too long: ${totalTokens} tokens (max: ${MAX_INPUT_TOKENS})`
    );
    return {
      previousMessages: [],
      error: error.toResponse(),
    };
  }

  // The whole branch-correct thread, NOT the last five messages. How much of
  // it the model actually gets is a token budget decided in one place —
  // createCoreChatAgent's CHAT_CONTEXT_BUDGET_TOKENS, which is the phase
  // gate's own transcript budget so the judge can never read more of a
  // conversation than the assistant was shown. Truncating here as well would
  // put a second, invisible, message-counted limit underneath it.
  const previousMessages = isAnonymous
    ? anonymousPreviousMessages
    : await getThreadUpToMessageId(
        chatId,
        userMessage.metadata.parentMessageId
      );

  return { previousMessages, error: null };
}

/**
 * A DEAD TOOL-INPUT STREAM IS A FAILURE, AND FROM HERE ON IT SAYS SO.
 *
 * On 2026-08-21 a `createTextDocument` call was left frozen at
 * `tool_state = 'input-streaming'` with 26,731 characters of input, no output,
 * no `tool_errorText`, and no `Document` row. Nothing looked at it, so nothing
 * reported it, so the turn that lost 26KB of the founder's protocol produced
 * ZERO text characters and said nothing at all. The founder found it. The
 * content had to be recovered by hand (Incident 6 in docs/INCIDENTS.md), and
 * this function exists so that never has to happen again.
 *
 * `onFinish` is the one place that knows the stream is over. Anything still in
 * `input-streaming` here will stay in `input-streaming` forever, so this is the
 * moment the state stops being "still arriving" and becomes "never arrived".
 *
 * Three things happen to such a part, and all three matter:
 *
 *  1. SALVAGE. A truncated input that carries a title and 26KB of content is a
 *     recoverable document. It is written as a `Document`, LABELLED PARTIAL in
 *     its title and at the top and bottom of its body. An honestly-labelled
 *     partial beats a clean discard; a partial passed off as finished would be
 *     worse than either. It runs FIRST, because the next two steps say
 *     whether a document was saved and under which id.
 *  2. MARK. The part is rewritten to `output-error` carrying
 *     DEAD_INPUT_STREAM_MARKER. That is what makes it distinguishable from a
 *     call still in flight — the exact distinction whose absence hid this for a
 *     whole session. It also un-hides the failure from the MODEL:
 *     `convertToModelMessages` (ai@6.0.219, its `isToolUIPart` branch skips a
 *     part whose state is `input-streaming`) DROPS
 *     `input-streaming` parts entirely, so on the next turn the assistant had
 *     no idea it had ever tried; an `output-error` part reaches it as a real
 *     tool error it can act on.
 *  3. SPEAK. A text part is appended saying what was lost, how much survived,
 *     the exact line it stopped after, and how to resume. A turn that ends
 *     without finishing has to say so.
 *
 * Returns the message to persist. Salvage writes only text documents: the
 * code and sheet document tools share the `{ title, content }` input shape but
 * not the artifact kind, and guessing a kind is exactly the sort of quiet
 * assumption this whole change is about. They are still MARKED and SPOKEN, so
 * a dead one is visible even though nothing is written for it.
 */
async function rescueDeadToolInputStreams({
  assistantMessage,
  userId,
  chatId,
}: {
  assistantMessage: ChatMessage;
  userId: string | null;
  chatId: string;
}): Promise<ChatMessage> {
  const log = createModuleLogger("api:chat:dead-input-stream");
  const dead = findDeadInputStreams(assistantMessage.parts);

  if (dead.length === 0) {
    return assistantMessage;
  }

  // Written BEFORE the parts are marked and the announcement is composed:
  // both say whether a document was saved, and only the write knows.
  const saved = new Map<string, SavedPartialDocument>();
  for (const death of dead) {
    const document = await writePartialDocument({
      salvage: death.salvage,
      toolType: death.toolType,
      userId,
      messageId: assistantMessage.id,
      log,
    });
    if (document) {
      saved.set(death.toolCallId, document);
    }
  }

  const swept = sweepDeadInputStreams(assistantMessage.parts, saved);

  for (const death of swept.deaths) {
    log.error(
      {
        chatId,
        messageId: assistantMessage.id,
        toolType: death.toolType,
        toolCallId: death.toolCallId,
        salvaged: death.verdict.salvage.salvaged,
        contentChars: death.verdict.salvage.salvaged
          ? death.verdict.salvage.contentChars
          : null,
        documentId: saved.get(death.toolCallId)?.documentId ?? null,
      },
      "tool input stream ended while still streaming — marking the call failed"
    );
  }

  if (swept.announcement === null) {
    return assistantMessage;
  }

  return {
    ...assistantMessage,
    parts: [
      ...(swept.parts as ChatMessage["parts"]),
      { type: "text", text: swept.announcement },
    ],
  };
}

/**
 * Write the salvaged prefix as a `Document`, or explain why it could not be.
 *
 * Returns the written document's id and kind, or null when nothing was
 * written. NULL IS NOT "EMPTY DOCUMENT": the sweep turns it into "was NOT
 * saved" in the marked part and in the announcement, so the founder is never
 * told a document exists that does not.
 */
async function writePartialDocument({
  salvage,
  toolType,
  userId,
  messageId,
  log,
}: {
  salvage: SalvagedTextDocument;
  toolType: string;
  userId: string | null;
  messageId: string;
  log: ReturnType<typeof createModuleLogger>;
}): Promise<SavedPartialDocument | null> {
  if (!salvage.salvaged) {
    return null;
  }
  // Anonymous turns have no owner column to write, and `saveDocument` requires
  // one. The failure is still marked and still announced in the chat — losing
  // the persistence is not a reason to also lose the report.
  if (!(userId && toolType === "tool-createTextDocument")) {
    return null;
  }

  const documentId = generateUUID();
  try {
    await saveDocument({
      id: documentId,
      title: partialDocumentTitle(salvage.title),
      content: partialDocumentBody(salvage),
      kind: "text",
      userId,
      messageId,
    });
    return { documentId, kind: "text" };
  } catch (error) {
    // The salvage is a best effort layered on top of a failure that has
    // already happened. If it throws, the turn must still finish and the
    // founder must still be told — swallowing the report as well would put us
    // back exactly where 2026-08-21 started.
    log.error({ error, messageId }, "failed to persist salvaged document");
    return null;
  }
}

/**
 * Settles and deducts what an accumulator outside `chargeTurnOnce` recorded:
 * the post-turn passes, or a turn whose request ended before its stream took
 * the accumulator over (`TurnCost`). NEVER THROWS: it runs in `after()` or a
 * `finally`, where a rejection would be unhandled or would replace the
 * response. Logs an unpriced entry the same way `chargeTurnOnce` does, because
 * the total is then an undercount.
 */
async function chargeAccumulatedCost({
  userId,
  costAccumulator,
  label,
}: {
  userId: string | null;
  costAccumulator: CostAccumulator;
  /** Names the charge in the log: "Post-turn" or "Pre-stream turn". */
  label: string;
}): Promise<void> {
  const log = createModuleLogger("api:chat:accumulated-credits");
  try {
    if (!(userId && costAccumulator.hasEntries())) {
      return;
    }
    const { cents, unpriced } = await costAccumulator.settle();
    if (unpriced.length > 0) {
      log.error(
        { unpriced, cents },
        `Some ${label} calls could not be priced; the deducted total is an undercount`
      );
    }
    log.info({ entries: costAccumulator.getEntries(), cents }, `${label} cost`);
    if (cents > 0) {
      await deductCredits(userId, cents);
    }
  } catch (error) {
    log.error({ error }, `Failed to charge the ${label} cost`);
  }
}

/**
 * The turn's one charge, once its stream has taken the accumulator over
 * (`TurnCost.settledByStream`). Called from onFinish
 * (`finalizeMessageAndCredits`, handed to `after()`) and from
 * `executeChatRequest`'s drain when it ends. The drain's call stands down once
 * onFinish has taken the charge (`TurnCost.chargeTakenByOnFinish`); otherwise
 * whichever reaches it first deducts, and the other does nothing.
 *
 * ONCE, BY A CHECK-AND-SET WITH NO AWAIT IN IT. Both calls can be in flight
 * together: onFinish's charge is not awaited, so on an error partway through
 * the stream it is still waiting for `spendRecorded` when the drain rejects
 * (on Node the drain rejects once onFinish has returned, which is now at
 * once). `CostAccumulator.settle()` does not consume what it prices: a second
 * settle returns the same total. So `charged` is read and set in one
 * synchronous step after the settle resolves and before the deduction is
 * attempted; JavaScript runs nothing else in between, so a second caller
 * resuming from its own settle sees it set. A deduction that then fails is
 * logged and not retried: one missed charge, never two.
 *
 * WAITS FOR `spendRecorded` before it settles (see `createChatStream`), so an
 * onFinish that ran early from the finish transform's `cancel` still charges
 * the model's usage. NEVER THROWS: it runs in `after()`.
 * Anonymous turns are settled and logged but never deducted: their credit is
 * taken from the cookie before the stream starts, because a cookie cannot be
 * set once the response has begun.
 */
async function chargeTurnOnce({
  turnCost,
  spendRecorded,
  userId,
  isAnonymous,
  chatId,
  from,
}: {
  turnCost: TurnCost;
  spendRecorded: Promise<void>;
  userId: string | null;
  isAnonymous: boolean;
  chatId: string;
  /** Which path called: onFinish normally, the drain as the fallback. */
  from: "onFinish" | "drain";
}): Promise<void> {
  const log = createModuleLogger("api:chat:finalize");
  try {
    if (
      turnCost.charged ||
      (from === "drain" && turnCost.chargeTakenByOnFinish)
    ) {
      return;
    }
    await spendRecorded;
    // Settle the accumulator (all LLM calls + external API costs)
    const { cents: totalCost, unpriced } = await turnCost.accumulator.settle();
    if (turnCost.charged) {
      return;
    }
    turnCost.charged = true;

    log.info(
      { entries: turnCost.accumulator.getEntries() },
      "Cost accumulator entries"
    );
    log.info({ totalCost }, "Cost accumulator total cost");

    // AN UNPRICED CALL IS LOGGED LOUDLY, NOT SWALLOWED. The turn still
    // completes — refusing to answer because a price is missing from a static
    // table would be a worse failure than undercharging — but `totalCost` is
    // then a known undercount, and this is the only place that says so. It
    // firing at all means a model reached production without an entry in
    // lib/ai/model-capabilities.ts.
    if (unpriced.length > 0) {
      log.error(
        { unpriced, totalCost },
        "Some LLM calls could not be priced; the deducted total is an undercount"
      );
    }

    if (from === "drain") {
      log.warn(
        { chatId, totalCost },
        "turn charged by the stream drain: onFinish did not charge it"
      );
    }

    if (userId && !isAnonymous) {
      await deductCredits(userId, totalCost);
    }
  } catch (error) {
    log.error(
      { error, chatId, from },
      "Failed to finalize credits for the turn"
    );
  }
}

async function finalizeMessageAndCredits({
  messages,
  userId,
  isAnonymous,
  chatId,
  turnCost,
  spendRecorded,
  selectedModelId,
  parallelGroupId,
  parallelIndex,
  isPrimaryParallel,
}: {
  messages: ChatMessage[];
  userId: string | null;
  isAnonymous: boolean;
  chatId: string;
  turnCost: TurnCost;
  spendRecorded: Promise<void>;
  selectedModelId: AppModelId;
  parallelGroupId: string | null;
  parallelIndex: number | null;
  isPrimaryParallel: boolean | null;
}): Promise<void> {
  const log = createModuleLogger("api:chat:finalize");

  // TWO STEPS, TWO GUARDS, AND THE CHARGE DOES NOT DEPEND ON THE WRITE. The
  // model calls have already happened and been paid for by the time this runs;
  // whether the assistant message then reaches the database has no bearing on
  // what the turn cost. Both steps used to share one `try`, so a failed
  // `updateMessage` (or a dead-tool rescue that threw) jumped straight past the
  // deduction and the turn was free. The deduction is still made exactly once:
  // the persistence step never settles or deducts, and the charge step
  // (`chargeTurnOnce`, shared with the stream drain) runs whatever the
  // persistence step did and deducts only if nothing has yet.
  //
  // THE CHARGE IS HANDED TO `after()`, NOT AWAITED. When the stream errors
  // partway, this runs from the SDK finish transform's `cancel`, and Node
  // reports the error downstream only once `cancel` has resolved; awaiting a
  // charge that waits for `spendRecorded` held the client's error until the
  // model finished (22 ms became 775 ms in a mock-model check on ai@6.0.219).
  // `after()` keeps the invocation open until the charge ends, and
  // `TurnCost.chargeTakenByOnFinish` tells the drain this charge is coming,
  // so the drain does not race it. The message save stays awaited: it writes
  // what the stream has produced by now and does not wait on the model.
  turnCost.chargeTakenByOnFinish = true;
  try {
    await persistFinishedAssistantMessage({
      messages,
      userId,
      isAnonymous,
      chatId,
      selectedModelId,
      parallelGroupId,
      parallelIndex,
      isPrimaryParallel,
    });
  } catch (error) {
    log.error(
      { error, chatId },
      "Failed to save the assistant message; the turn is still charged"
    );
  }

  after(
    chargeTurnOnce({
      turnCost,
      spendRecorded,
      userId,
      isAnonymous,
      chatId,
      from: "onFinish",
    })
  );
}

/**
 * Rescues dead tool inputs and writes the finished assistant message. Throws
 * on failure; `finalizeMessageAndCredits` catches it so the charge still runs.
 */
async function persistFinishedAssistantMessage({
  messages,
  userId,
  isAnonymous,
  chatId,
  selectedModelId,
  parallelGroupId,
  parallelIndex,
  isPrimaryParallel,
}: {
  messages: ChatMessage[];
  userId: string | null;
  isAnonymous: boolean;
  chatId: string;
  selectedModelId: AppModelId;
  parallelGroupId: string | null;
  parallelIndex: number | null;
  isPrimaryParallel: boolean | null;
}): Promise<void> {
  const streamed = messages.at(-1);

  if (!streamed) {
    throw new Error("No assistant message found!");
  }

  // BEFORE ANYTHING IS PERSISTED. The stream is over, so any tool call still
  // sitting in `input-streaming` is dead rather than pending, and this is the
  // last moment at which that difference can be recorded. Persisting the
  // message first and rescuing afterwards would recreate the exact row that
  // sat silently in the database for a whole session.
  const assistantMessage = await rescueDeadToolInputStreams({
    assistantMessage: streamed,
    userId,
    chatId,
  });

  if (!isAnonymous) {
    await updateMessage({
      id: assistantMessage.id,
      chatId,
      message: {
        ...assistantMessage,
        metadata: {
          ...assistantMessage.metadata,
          parallelGroupId:
            parallelGroupId ??
            assistantMessage.metadata.parallelGroupId ??
            null,
          parallelIndex:
            parallelIndex ?? assistantMessage.metadata.parallelIndex ?? null,
          isPrimaryParallel:
            isPrimaryParallel ??
            assistantMessage.metadata.isPrimaryParallel ??
            null,
          selectedModel: selectedModelId,
          activeStreamId: null,
        },
      },
    });
  }
}

type ChatPostBody = {
  assistantMessageId?: string;
  id: string;
  isPrimaryParallel?: boolean | null;
  message: ChatMessage;
  parallelGroupId?: string | null;
  parallelIndex?: number | null;
  prevMessages: ChatMessage[];
  projectId?: string;
  selectedModelId?: AppModelId;
};

type ChatPostBodyResult =
  | { success: false; error: Response }
  | { success: true; body: ChatPostBody };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseMessageDate(value: unknown): Date | null {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeChatMessage(value: unknown): ChatMessage | null {
  if (!isRecord(value)) {
    return null;
  }

  const metadata = value.metadata;

  if (
    typeof value.id !== "string" ||
    !Array.isArray(value.parts) ||
    typeof value.role !== "string" ||
    !isRecord(metadata) ||
    !isSelectedModelValue(metadata.selectedModel)
  ) {
    return null;
  }

  const createdAt = parseMessageDate(metadata.createdAt);
  if (!createdAt) {
    return null;
  }

  const parentMessageId = metadata.parentMessageId;
  const activeStreamId = metadata.activeStreamId;

  const hasValidParentMessageId =
    parentMessageId === null || typeof parentMessageId === "string";
  const hasValidActiveStreamId =
    activeStreamId === null || typeof activeStreamId === "string";

  if (!(hasValidParentMessageId && hasValidActiveStreamId)) {
    return null;
  }

  return {
    ...(value as ChatMessage),
    metadata: {
      ...(metadata as ChatMessage["metadata"]),
      createdAt,
      parentMessageId,
      activeStreamId,
      selectedModel: metadata.selectedModel,
    },
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNullableString(value: unknown): string | null | undefined {
  if (value === null || typeof value === "string") {
    return value;
  }
  return undefined;
}

function optionalNullableInteger(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

function optionalNullableBoolean(value: unknown): boolean | null | undefined {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  return undefined;
}

async function readChatPostBody(
  request: NextRequest
): Promise<ChatPostBodyResult> {
  let rawBody: unknown;

  try {
    rawBody = await request.json();
  } catch {
    return {
      success: false,
      error: new ChatSDKError("bad_request:api").toResponse(),
    };
  }

  if (!isRecord(rawBody)) {
    return {
      success: false,
      error: new ChatSDKError("bad_request:api").toResponse(),
    };
  }

  const userMessage = normalizeChatMessage(rawBody.message);
  const anonymousPreviousMessages = Array.isArray(rawBody.prevMessages)
    ? rawBody.prevMessages.map(normalizeChatMessage)
    : null;

  if (
    typeof rawBody.id !== "string" ||
    !userMessage ||
    userMessage.role !== "user" ||
    !anonymousPreviousMessages ||
    anonymousPreviousMessages.some((message) => !message)
  ) {
    return {
      success: false,
      error: new ChatSDKError("bad_request:api").toResponse(),
    };
  }

  return {
    success: true,
    body: {
      assistantMessageId: optionalString(rawBody.assistantMessageId),
      id: rawBody.id,
      isPrimaryParallel: optionalNullableBoolean(rawBody.isPrimaryParallel),
      message: userMessage,
      parallelGroupId: optionalNullableString(rawBody.parallelGroupId),
      parallelIndex: optionalNullableInteger(rawBody.parallelIndex),
      prevMessages: anonymousPreviousMessages as ChatMessage[],
      projectId: optionalString(rawBody.projectId),
      selectedModelId: optionalString(rawBody.selectedModelId) as
        | AppModelId
        | undefined,
    },
  };
}

async function prepareChatPersistenceAndCredits({
  chatId,
  projectId,
  userId,
  userMessage,
  costAccumulator,
}: {
  chatId: string;
  projectId?: string;
  userId: string | null;
  userMessage: ChatMessage;
  costAccumulator: CostAccumulator;
}): Promise<{ error: Response } | { isNewChat: boolean }> {
  if (userId) {
    return await handleUserValidationAndCredits({
      chatId,
      userId,
      userMessage,
      projectId,
      costAccumulator,
    });
  }

  return { isNewChat: false };
}

async function consumeAnonymousCreditBeforeStream(
  anonymousSession: AnonymousSession | null
) {
  if (!anonymousSession) {
    return;
  }

  // Cookies must be updated before streaming starts, but only after request
  // context validation has succeeded.
  await setAnonymousSession({
    ...anonymousSession,
    remainingCredits: anonymousSession.remainingCredits - 1,
  });
}

async function prepareChatExecutionInputs({
  anonymousPreviousMessages,
  chatId,
  isAnonymous,
  userId,
  userMessage,
}: {
  anonymousPreviousMessages: ChatMessage[];
  chatId: string;
  isAnonymous: boolean;
  userId: string | null;
  userMessage: ChatMessage;
}): Promise<
  | { error: Response }
  | { mcpConnectors: McpConnector[]; previousMessages: ChatMessage[] }
> {
  const [contextResult, mcpConnectors] = await Promise.all([
    prepareRequestContext({
      userMessage,
      chatId,
      isAnonymous,
      anonymousPreviousMessages,
    }),
    config.ai.tools.mcp.enabled && userId && !isAnonymous
      ? getMcpConnectorsByUserId({ userId })
      : Promise.resolve([]),
  ]);

  if (contextResult.error) {
    return { error: contextResult.error };
  }

  return {
    previousMessages: contextResult.previousMessages,
    mcpConnectors,
  };
}

export async function POST(request: NextRequest) {
  const log = createModuleLogger("api:chat");
  const turnCost: TurnCost = {
    accumulator: new CostAccumulator(),
    settledByStream: false,
    charged: false,
    chargeTakenByOnFinish: false,
  };
  let chargedUserId: string | null = null;
  try {
    const bodyResult = await readChatPostBody(request);

    if (!bodyResult.success) {
      log.warn("No user message found");
      return bodyResult.error;
    }

    const {
      id: chatId,
      message: userMessage,
      prevMessages: anonymousPreviousMessages,
      projectId,
      assistantMessageId,
      selectedModelId: requestSelectedModelId,
      parallelGroupId,
      parallelIndex,
      isPrimaryParallel,
    } = bodyResult.body;

    const selectedModelId = resolveSelectedModelId({
      requestSelectedModelId,
      selectedModel: userMessage.metadata.selectedModel,
    });

    if (!selectedModelId) {
      log.warn("No selectedModel in user message metadata");
      return new ChatSDKError("bad_request:api").toResponse();
    }

    const sessionSetup = await validateAndSetupSession({
      request,
      selectedModelId,
    });

    if (!sessionSetup.success) {
      return sessionSetup.error;
    }

    const { userId, isAnonymous, anonymousSession } = sessionSetup;
    chargedUserId = isAnonymous ? null : userId;
    const persistenceResult = await prepareChatPersistenceAndCredits({
      chatId,
      projectId,
      userId,
      userMessage,
      costAccumulator: turnCost.accumulator,
    });

    if ("error" in persistenceResult) {
      return persistenceResult.error;
    }

    const executionInputs = await prepareChatExecutionInputs({
      anonymousPreviousMessages,
      chatId,
      isAnonymous,
      userId,
      userMessage,
    });

    if ("error" in executionInputs) {
      return executionInputs.error;
    }

    await consumeAnonymousCreditBeforeStream(anonymousSession);

    const explicitlyRequestedTools = determineExplicitlyRequestedTools(
      userMessage.metadata.selectedTool ?? null
    );

    // The request's hard stop. `requestDeadlineAt` travels to the tools so a
    // long one (deep research) plans its own stages to finish before this
    // fires; the timer stays as the backstop. Both come from one constant.
    const abortController = new AbortController();
    const requestDeadlineAt = Date.now() + CHAT_REQUEST_BUDGET_MS;
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, CHAT_REQUEST_BUDGET_MS);

    return await executeChatRequest({
      chatId,
      userMessage,
      previousMessages: executionInputs.previousMessages,
      selectedModelId,
      assistantMessageId,
      parallelGroupId:
        parallelGroupId ?? userMessage.metadata.parallelGroupId ?? null,
      parallelIndex: parallelIndex ?? null,
      isPrimaryParallel: isPrimaryParallel ?? null,
      explicitlyRequestedTools,
      userId,
      isAnonymous,
      isNewChat: persistenceResult.isNewChat,
      abortController,
      requestDeadlineAt,
      timeoutId,
      mcpConnectors: executionInputs.mcpConnectors,
      turnCost,
    });
  } catch (error) {
    log.error(
      {
        err:
          error instanceof Error
            ? { message: error.message, stack: error.stack }
            : error,
      },
      "RESPONSE > POST /api/chat error"
    );
    return new Response("Internal Server Error", {
      status: 500,
    });
  } finally {
    // A request that ended before its stream took the accumulator over (a
    // refusal after the title, a replayed placeholder, a throw) has still paid
    // for whatever it recorded — a new chat's title, the phase block's
    // embedding. Charged here, once; when the stream did take over,
    // `chargeTurnOnce` charges instead (from onFinish or the stream drain).
    if (!turnCost.settledByStream) {
      await chargeAccumulatedCost({
        userId: chargedUserId,
        costAccumulator: turnCost.accumulator,
        label: "Pre-stream turn",
      });
    }
  }
}
