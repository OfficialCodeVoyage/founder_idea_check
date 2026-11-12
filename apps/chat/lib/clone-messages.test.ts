import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import type { ChatMessage } from "./ai/types";

const SOURCE_OWNER = "user-1";
const SOURCE_OWNER_KEY = "Ab3_xY9-kLmN0pQr.l_u0a2bkphKLFKsBI4q5Tue9.png";

const fileStorage = vi.hoisted(() => ({
  downloadFile: vi.fn(),
  uploadFile: vi.fn(),
  // The source owner stored only the key that starts with their tag.
  isFileSharedByChatOwner: (key: string, ownerId: string) =>
    ownerId === "user-1" && key.startsWith("Ab3_xY9-kLmN0pQr."),
}));

vi.mock("@/lib/config", () => ({
  config: { appPrefix: "test" },
}));

vi.mock("./file-storage", () => fileStorage);

import {
  cloneAttachmentsInMessages,
  cloneMessagesWithDocuments,
} from "./clone-messages";

function createMessage({
  id,
  parentMessageId = null,
  chatId,
}: {
  id: string;
  parentMessageId?: string | null;
  chatId: string;
}): ChatMessage & { chatId: string } {
  return {
    id,
    role: "user",
    parts: [],
    metadata: {
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      parentMessageId,
      selectedModel: "gpt-5.6-luna",
      activeStreamId: null,
    },
    chatId,
  };
}

describe("cloneMessagesWithDocuments", () => {
  it("clones message ids, chatId and parentMessageId thread structure", () => {
    const sourceChatId = "source-chat";
    const newChatId = "new-chat";
    const userId = "user-1";

    const m1 = createMessage({
      id: "m1",
      parentMessageId: null,
      chatId: sourceChatId,
    });
    const m2 = createMessage({
      id: "m2",
      parentMessageId: "m1",
      chatId: sourceChatId,
    });
    const m3 = createMessage({
      id: "m3",
      parentMessageId: "m2",
      chatId: sourceChatId,
    });

    const { clonedMessages, messageIdMap } = cloneMessagesWithDocuments(
      [m1, m2, m3],
      [],
      newChatId,
      userId
    );

    assert.equal(clonedMessages.length, 3);

    // IDs should all be new and unique
    const newIds = clonedMessages.map((m) => m.id);
    assert.equal(new Set(newIds).size, 3);
    assert(!newIds.includes("m1"));
    assert(!newIds.includes("m2"));
    assert(!newIds.includes("m3"));

    // All messages should belong to the new chat
    for (const msg of clonedMessages) {
      assert.equal(msg.chatId, newChatId);
    }

    const newM1Id = messageIdMap.get("m1");
    const newM2Id = messageIdMap.get("m2");
    const newM3Id = messageIdMap.get("m3");

    assert(newM1Id);
    assert(newM2Id);
    assert(newM3Id);

    const clonedM1 = clonedMessages.find((m) => m.id === newM1Id);
    const clonedM2 = clonedMessages.find((m) => m.id === newM2Id);
    const clonedM3 = clonedMessages.find((m) => m.id === newM3Id);

    assert(clonedM1);
    assert(clonedM2);
    assert(clonedM3);

    // Root has no parent
    assert.equal(clonedM1.metadata.parentMessageId, null);

    // Second-level message should point to cloned root
    assert.equal(clonedM2.metadata.parentMessageId, newM1Id);

    // Third-level message should point to cloned second-level
    assert.equal(clonedM3.metadata.parentMessageId, newM2Id);
  });

  it("clones documents and updates document references in message parts", () => {
    const sourceChatId = "source-chat";
    const newChatId = "new-chat";
    const userId = "user-1";

    const messageWithDoc = createMessage({
      id: "m-doc",
      parentMessageId: null,
      chatId: sourceChatId,
    });

    // Minimal tool parts that reference a document id.
    // Shapes match the actual tool output types so the test type-checks.
    messageWithDoc.parts = [
      {
        type: "tool-createTextDocument",
        toolCallId: "call-create",
        state: "output-available",
        input: {
          title: "Doc title",
          content: "The document content",
        },
        output: {
          status: "success",
          documentId: "doc-1",
          result: "A document was created and is now visible to the user.",
          date: "2024-01-01T00:00:00.000Z",
        },
      },
      {
        type: "tool-editTextDocument",
        toolCallId: "call-update",
        state: "output-available",
        input: {
          documentId: "doc-1",
          title: "Doc title",
          content: "Updated content",
        },
        output: {
          status: "success",
          documentId: "doc-1",
          result: "The document was updated and is now visible to the user.",
          date: "2024-01-01T00:00:00.000Z",
        },
      },
      {
        type: "tool-deepResearch",
        toolCallId: "call-deep",
        state: "output-available",
        input: {},
        output: {
          format: "report",
          status: "success",
          documentId: "doc-1",
          result: "Deep research report content",
          date: "2024-01-01T00:00:00.000Z",
        },
      },
    ];

    const sourceDocuments = [
      {
        id: "doc-1",
        messageId: "m-doc",
        userId: "source-user",
        title: "Doc title",
        kind: "text",
        content: "hello",
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
      },
    ];

    const { clonedMessages, clonedDocuments, messageIdMap, documentIdMap } =
      cloneMessagesWithDocuments(
        [messageWithDoc],
        sourceDocuments,
        newChatId,
        userId
      );

    assert.equal(clonedMessages.length, 1);
    assert.equal(clonedDocuments.length, 1);

    const newMessageId = messageIdMap.get("m-doc");
    const newDocumentId = documentIdMap.get("doc-1");

    assert(newMessageId);
    assert(newDocumentId);

    const clonedMessage = clonedMessages[0];
    const clonedDocument = clonedDocuments[0];

    // Document should point to cloned message and new user
    assert.equal(clonedDocument.messageId, newMessageId);
    assert.equal(clonedDocument.userId, userId);
    assert.equal(clonedDocument.id, newDocumentId);

    // All tool parts in the cloned message should reference the new document id
    for (const part of clonedMessage.parts) {
      if (
        (part.type === "tool-createTextDocument" ||
          part.type === "tool-createCodeDocument" ||
          part.type === "tool-createSheetDocument" ||
          part.type === "tool-editTextDocument" ||
          part.type === "tool-editCodeDocument" ||
          part.type === "tool-editSheetDocument" ||
          part.type === "tool-deepResearch") &&
        part.state === "output-available" &&
        part.output &&
        "documentId" in part.output
      ) {
        assert.equal(part.output.documentId, newDocumentId);
      }
    }
  });
});

describe("cloneAttachmentsInMessages", () => {
  it("copies managed files through the configured storage provider", async () => {
    fileStorage.downloadFile.mockResolvedValue({
      arrayBuffer: async () => new TextEncoder().encode("contents").buffer,
      type: "text/plain",
    });
    fileStorage.uploadFile.mockResolvedValue({
      url: "https://chat.example/api/files/content?key=cloned-key",
    });

    const [message] = await cloneAttachmentsInMessages(
      [
        {
          parts: [
            {
              type: "file",
              filename: "attachment.txt",
              mediaType: "text/plain",
              url: `https://old-chat.example/api/files/content?key=${SOURCE_OWNER_KEY}`,
            },
          ],
        },
      ],
      { ownerId: "user-2", sourceOwnerId: SOURCE_OWNER }
    );

    assert.deepEqual(fileStorage.downloadFile.mock.calls, [[SOURCE_OWNER_KEY]]);
    assert.equal(fileStorage.uploadFile.mock.calls[0]?.[0], "attachment.txt");
    assert.equal(fileStorage.uploadFile.mock.calls[0]?.[2], "text/plain");
    assert.equal(fileStorage.uploadFile.mock.calls[0]?.[3], "user-2");
    assert.equal(
      message.parts[0]?.type === "file" ? message.parts[0].url : null,
      "https://chat.example/api/files/content?key=cloned-key"
    );
  });

  it("copies generated images out of tool outputs under the cloner", async () => {
    fileStorage.downloadFile.mockReset().mockResolvedValue({
      arrayBuffer: async () => new Uint8Array([1]).buffer,
      type: "image/png",
    });
    fileStorage.uploadFile.mockReset().mockResolvedValue({
      url: "/api/files/content?key=cloned-image",
    });

    const [message] = await cloneAttachmentsInMessages(
      [
        {
          parts: [
            {
              type: "tool-generateImage",
              toolCallId: "call-1",
              state: "output-available",
              input: { prompt: "a cat" },
              output: {
                imageUrl: `/api/files/content?key=${SOURCE_OWNER_KEY}`,
                prompt: "a cat",
              },
            },
          ],
        },
      ] as Array<{ parts: ChatMessage["parts"] }>,
      { ownerId: "user-2", sourceOwnerId: SOURCE_OWNER }
    );

    assert.deepEqual(fileStorage.downloadFile.mock.calls, [[SOURCE_OWNER_KEY]]);
    assert.equal(fileStorage.uploadFile.mock.calls[0]?.[3], "user-2");
    const part = message.parts[0];
    assert.equal(
      part?.type === "tool-generateImage" && part.state === "output-available"
        ? part.output.imageUrl
        : null,
      "/api/files/content?key=cloned-image"
    );
  });

  it("does not copy a stored file the source chat's owner did not store", async () => {
    fileStorage.downloadFile.mockReset();
    fileStorage.uploadFile.mockReset();
    const foreignUrl =
      "/api/files/content?key=Zz9_zZ9-zZzZzZzZ.l_u0a2bkphKLFKsBI4q5Tue9.png";

    const [message] = await cloneAttachmentsInMessages(
      [
        {
          parts: [
            {
              type: "file",
              filename: "pasted.png",
              mediaType: "image/png",
              url: foreignUrl,
            },
          ],
        },
      ],
      { ownerId: "user-2", sourceOwnerId: SOURCE_OWNER }
    );

    assert.equal(fileStorage.downloadFile.mock.calls.length, 0);
    assert.equal(fileStorage.uploadFile.mock.calls.length, 0);
    assert.equal(
      message.parts[0]?.type === "file" ? message.parts[0].url : null,
      foreignUrl
    );
  });
});
