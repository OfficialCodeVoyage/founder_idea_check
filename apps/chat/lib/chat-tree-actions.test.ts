import { describe, expect, it } from "vitest";
import { usableStoredModel } from "@/lib/ai/chat-seed-model";
import type { ChatMessage, SelectedModelValue } from "@/lib/ai/types";
import {
  getRetryMessageInput,
  removeTrailingAssistantMessage,
} from "./chat-tree-actions";

function message({
  id,
  parentMessageId = null,
  role,
  selectedModel = "claude-sonnet-5-5",
}: {
  id: string;
  parentMessageId?: string | null;
  role: "assistant" | "user";
  selectedModel?: ChatMessage["metadata"]["selectedModel"];
}): ChatMessage {
  return {
    id,
    role,
    parts: [{ type: "text", text: id }],
    metadata: {
      activeStreamId: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      parentMessageId,
      selectedModel,
    },
  } as ChatMessage;
}

const retryCatalog = {
  usableModel: (
    candidates: readonly (SelectedModelValue | null | undefined)[]
  ) =>
    usableStoredModel({
      candidates,
      isKnownModel: (modelId: string) =>
        ["claude-sonnet-5-5", "claude-haiku-5-5"].includes(modelId),
      composer: {
        modelId: "claude-sonnet-5-5",
        selection: "claude-sonnet-5-5",
      },
    }),
};

describe("getRetryMessageInput", () => {
  it("builds a retry message from an assistant response and trims before the parent user message", () => {
    const root = message({ id: "root", role: "user" });
    const assistant = message({
      id: "assistant",
      parentMessageId: root.id,
      role: "assistant",
      selectedModel: "claude-haiku-5-5",
    });

    const result = getRetryMessageInput({
      messageId: assistant.id,
      messages: [root, assistant],
      ...retryCatalog,
    });

    expect(result).toMatchObject({
      ok: true,
      messagesBeforeRetry: [],
      message: {
        id: root.id,
        role: "user",
        metadata: {
          activeStreamId: null,
          isPrimaryParallel: null,
          parallelGroupId: null,
          parallelIndex: null,
          parentMessageId: null,
          selectedModel: "claude-haiku-5-5",
        },
      },
    });
  });

  it("uses the previous message as parent when metadata has no parent id", () => {
    const root = message({ id: "root", role: "user" });
    const assistant = message({ id: "assistant", role: "assistant" });

    const result = getRetryMessageInput({
      messageId: assistant.id,
      messages: [root, assistant],
      ...retryCatalog,
    });

    expect(result.ok).toBe(true);
    expect(result.ok ? result.message.id : null).toBe(root.id);
  });

  it("reports missing parent messages", () => {
    const assistant = message({
      id: "assistant",
      parentMessageId: "missing",
      role: "assistant",
    });

    expect(
      getRetryMessageInput({
        messageId: assistant.id,
        messages: [assistant],
        ...retryCatalog,
      })
    ).toEqual({ ok: false, reason: "parent_not_found" });
  });
});

describe("removeTrailingAssistantMessage", () => {
  it("removes a trailing assistant message", () => {
    const root = message({ id: "root", role: "user" });
    const assistant = message({ id: "assistant", role: "assistant" });

    expect(removeTrailingAssistantMessage([root, assistant])).toEqual([root]);
  });

  it("preserves messages when the last message is not an assistant", () => {
    const messages = [message({ id: "root", role: "user" })];

    expect(removeTrailingAssistantMessage(messages)).toBe(messages);
  });
});
