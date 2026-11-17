import type { Chat, DBMessage } from "@/lib/db/schema";
import type { UIChat } from "@/lib/types/ui-chat";
import { type ChatMessage, TARGET_CRITERION_ID_PATTERN } from "./ai/types";

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
 * The message's criterion target, read back into metadata only when one is
 * stored. Spread rather than assigned so a message with no target carries no key
 * at all, exactly as the client sent it.
 */
export function targetMetadata(
  targetCriterionId: string | null
): { targetCriterionId: string } | Record<string, never> {
  return targetCriterionId ? { targetCriterionId } : {};
}

/**
 * THE REFUSAL MARKER, stored in `Message.annotations`, a JSON column nothing
 * else reads (every other row holds `[]`, or NULL on old rows). It marks an
 * assistant reply the model declined, so that no model reads that reply or
 * the founder message behind it again (`lib/thread-utils.ts::withoutRefusedTurns`).
 * Only the server writes it: the chat route's end-of-turn save passes it
 * explicitly (`updateMessage`'s `refused`, read from the reply the route's own
 * stream built, `lib/ai/refused-reply.ts::finishedReplyRefused`), and
 * `chatMessageToDbMessage`, which every insert goes through, never reads it,
 * so a client cannot set it.
 */
export const REFUSAL_ANNOTATION = { type: "refusal" } as const;

/** PURE. The annotations column for a reply that was or was not declined. */
export function refusalAnnotations(
  refused: boolean
): (typeof REFUSAL_ANNOTATION)[] {
  return refused ? [REFUSAL_ANNOTATION] : [];
}

/**
 * The refusal marker, read back into metadata only when the stored
 * annotations carry it, like `targetMetadata`: any other row (`[]`, NULL,
 * anything unreadable) carries no key at all, exactly as before.
 */
export function refusedMetadata(
  annotations: unknown
): { refused: true } | Record<string, never> {
  const refused =
    Array.isArray(annotations) &&
    annotations.some(
      (annotation) =>
        typeof annotation === "object" &&
        annotation !== null &&
        "type" in annotation &&
        annotation.type === REFUSAL_ANNOTATION.type
    );
  return refused ? { refused: true } : {};
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

  // THE GUARD ON EVERY WRITE of a criterion target. The field is typed, but
  // neither route that saves a founder's message parses metadata against
  // `messageMetadataSchema`: the chat route's `normalizeChatMessage` and the
  // prepare route both pass the client's metadata through as sent. So the
  // value is checked HERE, at runtime, whatever its type says, against
  // `TARGET_CRITERION_ID_PATTERN` (`lib/ai/types.ts`), the shape the
  // `Message_target_criterion_shape` CHECK spells in SQL. A value the CHECK
  // would refuse fails the whole save, so it is stored as NULL instead:
  // a spoofed or oversized target is dropped silently and never errors the
  // request. Losing the target costs a hint.
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
      typeof target === "string" && TARGET_CRITERION_ID_PATTERN.test(target)
        ? target
        : null,
  };
}
