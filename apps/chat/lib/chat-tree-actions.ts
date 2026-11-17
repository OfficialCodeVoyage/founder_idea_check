import type { AppModelId } from "@/lib/ai/app-models";
import { usableStoredModel } from "@/lib/ai/chat-seed-model";
import type { ChatMessage } from "@/lib/ai/types";

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

  // A stored model may be one the catalog no longer has: read through the one
  // check every client path uses (`usableStoredModel`). A retry sends one model.
  const retryModelId = usableStoredModel({
    candidates: [
      currentMessage.metadata?.selectedModel,
      parentMessage.metadata?.selectedModel,
    ],
    isKnownModel,
    fallbackModelId,
  }).modelId;

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
