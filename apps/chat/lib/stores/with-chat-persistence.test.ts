import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { ChatMessage } from "@/lib/ai/types";
import { createCustomChatStore } from "./custom-store-provider";

describe("withChatPersistence", () => {
  it("can initialize persisted state without a follow-up store update", () => {
    const store = createCustomChatStore<ChatMessage>([], {
      initialIsChatPersisted: true,
    });

    assert.equal(store.getState().isChatPersisted, true);
  });

  it("tracks app-level chat persistence outside the runtime registry", () => {
    const store = createCustomChatStore<ChatMessage>();

    assert.equal(store.getState().isChatPersisted, false);

    store.getState().setChatPersisted(true);
    assert.equal(store.getState().isChatPersisted, true);

    store.getState().setPendingChatConfirmation({
      message: {
        id: "message-1",
        metadata: {
          activeStreamId: null,
          createdAt: new Date("2024-01-01T00:00:00.000Z"),
          parentMessageId: null,
          selectedModel: "openai/gpt-4o-mini",
          selectedTool: undefined,
        },
        parts: [],
        role: "user",
      },
      projectId: null,
      requestSpecs: [],
    });
    assert.equal(
      store.getState().pendingChatConfirmation?.message.id,
      "message-1"
    );

    store.getState().reset();

    assert.equal(store.getState().isChatPersisted, false);
    assert.equal(store.getState().pendingChatConfirmation, null);
  });
});
