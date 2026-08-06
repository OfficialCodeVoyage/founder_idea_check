export const MAIN_CHAT_THREAD_ID = "main";

export type ChatRuntimeId = `chat:${string}:thread:${string}`;

export interface ParsedChatRuntimeId {
  chatId: string;
  threadId: string;
}

function encodeRuntimeIdPart(value: string) {
  return encodeURIComponent(value);
}

function decodeRuntimeIdPart(value: string) {
  return decodeURIComponent(value);
}

export function createChatThreadRuntimeId({
  chatId,
  threadId,
}: {
  chatId: string;
  threadId: string;
}): ChatRuntimeId {
  return `chat:${encodeRuntimeIdPart(chatId)}:thread:${encodeRuntimeIdPart(threadId)}`;
}

export function createMainChatRuntimeId(chatId: string): ChatRuntimeId {
  return createChatThreadRuntimeId({
    chatId,
    threadId: MAIN_CHAT_THREAD_ID,
  });
}

export function parseChatRuntimeId(
  runtimeId: string | null | undefined
): ParsedChatRuntimeId | null {
  if (!runtimeId) {
    return null;
  }

  const parts = runtimeId.split(":");
  if (parts.length !== 4 || parts[0] !== "chat" || parts[2] !== "thread") {
    return null;
  }

  try {
    const chatId = decodeRuntimeIdPart(parts[1] ?? "");
    const threadId = decodeRuntimeIdPart(parts[3] ?? "");

    if (!(chatId && threadId)) {
      return null;
    }

    return {
      chatId,
      threadId,
    };
  } catch {
    return null;
  }
}
