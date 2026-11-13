import type { ModelId } from "@/lib/ai/app-models";
import type { Chat, DBMessage } from "@/lib/db/schema";
import { isTargetCriterionId } from "@/lib/phases/target-criterion";
import type { UIChat } from "@/lib/types/ui-chat";
import {
  type ChatMessage,
  isSelectedModelValue,
  type UiToolName,
} from "./ai/types";

// Helper functions for type conversion
export function dbChatToUIChat(chat: Chat): UIChat {
  return {
    id: chat.id,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    title: chat.title,
    visibility: chat.visibility,
    userId: chat.userId,
    isPinned: chat.isPinned,
    projectId: chat.projectId ?? null,
  };
}

/**
 * The founder's criterion mark, read back into metadata only when one is
 * stored. Spread rather than assigned so a message with no mark carries no key
 * at all, exactly as the client sent it.
 */
export function targetMetadata(
  targetCriterionId: string | null
): { targetCriterionId: string } | Record<string, never> {
  return targetCriterionId ? { targetCriterionId } : {};
}

function _dbMessageToChatMessage(message: DBMessage): ChatMessage {
  // Note: This function should not be used directly for messages with parts
  // Use getAllMessagesByChatId which reconstructs parts from Part table
  // Parts are now stored in Part table, not in Message.parts
  return {
    id: message.id,
    parts: [], // Parts are stored in Part table - use getAllMessagesByChatId instead
    role: message.role as ChatMessage["role"],
    metadata: {
      createdAt: message.createdAt,
      activeStreamId: message.activeStreamId,
      parentMessageId: message.parentMessageId,
      parallelGroupId: message.parallelGroupId,
      parallelIndex: message.parallelIndex,
      isPrimaryParallel: message.isPrimaryParallel,
      selectedModel: isSelectedModelValue(message.selectedModel)
        ? message.selectedModel
        : ("" as ModelId),
      selectedTool: (message.selectedTool as UiToolName | null) || undefined,
      usage: message.lastContext as ChatMessage["metadata"]["usage"],
      ...targetMetadata(message.targetCriterionId),
    },
  };
}

export function chatMessageToDbMessage(
  message: ChatMessage,
  chatId: string
): DBMessage {
  const parentMessageId = message.metadata.parentMessageId || null;
  const selectedModel = message.metadata.selectedModel;

  // Ensure createdAt is a Date object
  let createdAt: Date;
  if (message.metadata?.createdAt) {
    createdAt =
      message.metadata.createdAt instanceof Date
        ? message.metadata.createdAt
        : new Date(message.metadata.createdAt);
  } else {
    createdAt = new Date();
  }

  // THE GUARD ON EVERY WRITE of a criterion mark. Read as unknown and checked
  // here, not trusted from upstream: this mapping saves whatever reaches it —
  // the chat route's message, the prepare route's (which never passes through
  // normalizeChatMessage), assistant turns and cloned chats. A value the
  // Message_target_criterion_shape CHECK refuses would fail the whole save, so
  // it is stored as NULL instead: losing the mark costs a hint.
  const target = (message.metadata as Record<string, unknown>)
    .targetCriterionId;

  // Parts are stored in Part table, not in Message.parts
  return {
    id: message.id,
    chatId,
    role: message.role,
    attachments: [],
    lastContext: message.metadata?.usage || null,
    createdAt,
    annotations: [],
    parentMessageId,
    selectedModel,
    selectedTool: message.metadata?.selectedTool || null,
    parallelGroupId: message.metadata?.parallelGroupId || null,
    parallelIndex: message.metadata?.parallelIndex ?? null,
    isPrimaryParallel: message.metadata?.isPrimaryParallel ?? null,
    activeStreamId: message.metadata?.activeStreamId || null,
    canceledAt: null,
    targetCriterionId: isTargetCriterionId(target) ? target : null,
  };
}
