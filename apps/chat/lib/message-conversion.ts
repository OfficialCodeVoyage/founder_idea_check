import type { Chat, DBMessage } from "@/lib/db/schema";
import type { UIChat } from "@/lib/types/ui-chat";
import type { ChatMessage } from "./ai/types";

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
 * THE SHAPE A STORED CRITERION MARK MUST HAVE, spelled the same way as the
 * `Message_target_criterion_shape` CHECK (migration 0054). It is checked in
 * exactly one place, `chatMessageToDbMessage` below, because that is the one
 * mapping every Message write goes through. Whether a stored id names an exit
 * criterion of the current phase is a different question, answered per turn by
 * an exact lookup in `lib/phases/runtime.ts::buildPhaseSystemBlock`.
 */
const TARGET_CRITERION_ID_SHAPE = /^[a-z0-9-]{1,64}$/;

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

  // THE GUARD ON EVERY WRITE of a criterion mark. The field is typed, but
  // neither route that saves a founder's message parses metadata against
  // `messageMetadataSchema`: the chat route's `normalizeChatMessage` and the
  // prepare route both pass the client's metadata through as sent. So the
  // value is checked HERE, at runtime, whatever its type says. A value the
  // CHECK would refuse fails the whole save, so it is stored as NULL instead:
  // a spoofed or oversized mark is dropped silently and never errors the
  // request. Losing the mark costs a hint.
  const target: unknown = message.metadata.targetCriterionId;

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
    targetCriterionId:
      typeof target === "string" && TARGET_CRITERION_ID_SHAPE.test(target)
        ? target
        : null,
  };
}
