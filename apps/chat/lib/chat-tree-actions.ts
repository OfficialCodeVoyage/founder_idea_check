import type { AppModelId } from "@/lib/ai/app-models";
import { type ChatMessage, getPrimarySelectedModelId } from "@/lib/ai/types";

export type RetryMessageResult =
  | {
      message: ChatMessage;
      messagesBeforeRetry: ChatMessage[];
      ok: true;
    }
  | {
      ok: false;
      reason: "message_not_found" | "parent_not_found" | "parent_not_user";
    };

export function getRetryMessageInput({
  messageId,
  messages,
  isKnownModel,
  fallbackModelId,
}: {
  messageId: string;
  messages: ChatMessage[];
  /** Whether the catalog still serves a model id, as the seed path asks. */
  isKnownModel: (modelId: string) => boolean;
  /** The current default chat model, for a stored model the catalog lost. */
  fallbackModelId: AppModelId;
}): RetryMessageResult {
  const currentMessage = messages.find((message) => message.id === messageId);
  if (!currentMessage) {
    return { ok: false, reason: "message_not_found" };
  }

  const currentMessageIndex = messages.findIndex(
    (message) => message.id === messageId
  );
  const parentMessageId = currentMessage.metadata?.parentMessageId ?? null;
  const parentMessageIndex = parentMessageId
    ? messages.findIndex((message) => message.id === parentMessageId)
    : currentMessageIndex - 1;

  if (parentMessageIndex < 0) {
    return { ok: false, reason: "parent_not_found" };
  }

  const parentMessage = messages[parentMessageIndex];
  if (parentMessage.role !== "user") {
    return { ok: false, reason: "parent_not_user" };
  }

  // A STORED MODEL MAY BE ONE THE CATALOG NO LONGER HAS. Every message
  // written before the gateway moved to Anthropic carries a `gpt-5.6-*` id;
  // retried as stored, the route answered 404 "Model not found" and the reply
  // could not be regenerated. Checked like the seed path
  // (`lib/ai/chat-seed-model.ts::resolveChatSeedModel`), and an unknown or
  // missing id falls back to the current default chat model. `""` is falsy
  // here too: the queries write it for an unreadable stored value.
  const storedModelId = [
    getPrimarySelectedModelId(currentMessage.metadata?.selectedModel),
    getPrimarySelectedModelId(parentMessage.metadata?.selectedModel),
  ].find((modelId) => modelId && isKnownModel(modelId));
  const retryModelId = storedModelId || fallbackModelId;

  return {
    ok: true,
    messagesBeforeRetry: messages.slice(0, parentMessageIndex),
    message: {
      ...parentMessage,
      metadata: {
        ...parentMessage.metadata,
        activeStreamId: null,
        createdAt: parentMessage.metadata?.createdAt || new Date(),
        isPrimaryParallel: null,
        parallelGroupId: null,
        parallelIndex: null,
        parentMessageId: parentMessage.metadata?.parentMessageId || null,
        selectedModel: retryModelId,
      },
    },
  };
}

export function removeTrailingAssistantMessage(messages: ChatMessage[]) {
  const lastMessage = messages.at(-1);
  return lastMessage?.role === "assistant" ? messages.slice(0, -1) : messages;
}
