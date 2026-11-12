import type { FileUIPart } from "ai";
import type { ChatMessage } from "./ai/types";
import { FILE_STORAGE_PREFIX } from "./constants";
import { downloadFile, isFileOwnedBy, uploadFile } from "./file-storage";
import { keyFromFileUrl, ownerTagFromFileKey } from "./file-url";
import { generateUUID } from "./utils";

function cloneMessages<
  T extends { id: string; chatId: string; parentMessageId?: string | null },
>(sourceMessages: T[], newChatId: string): T[] {
  // First pass: Create mapping from old IDs to new IDs
  const idMap = new Map<string, string>();
  for (const message of sourceMessages) {
    idMap.set(message.id, generateUUID());
  }

  // Second pass: Clone messages using the ID mapping
  const clonedMessages: T[] = [];
  for (const message of sourceMessages) {
    const newId = idMap.get(message.id);
    if (!newId) {
      throw new Error(`Message ID ${message.id} not found in mapping`);
    }

    let newParentId: string | null = null;
    if (message.parentMessageId) {
      const mappedParentId = idMap.get(message.parentMessageId);
      if (!mappedParentId) {
        throw new Error(
          `Parent message ID ${message.parentMessageId} not found in mapping`
        );
      }
      newParentId = mappedParentId;
    }

    const clonedMessage: T = {
      ...message,
      id: newId,
      chatId: newChatId,
      parentMessageId: newParentId,
    };
    clonedMessages.push(clonedMessage);
  }

  return clonedMessages;
}
function createDocumentIdMap<T extends { id: string }>(
  documents: T[]
): Map<string, string> {
  const documentIdMap = new Map<string, string>();
  for (const document of documents) {
    documentIdMap.set(document.id, generateUUID());
  }
  return documentIdMap;
}

function updateDocumentIdInPart(
  oldDocId: string,
  documentIdMap: Map<string, string>
): string {
  const newDocId = documentIdMap.get(oldDocId);
  if (!newDocId) {
    throw new Error(`Document ID ${oldDocId} not found in mapping`);
  }
  return newDocId;
}

function transformDeepResearchPart(
  part: ChatMessage["parts"][number],
  documentIdMap: Map<string, string>
): ChatMessage["parts"][number] {
  if (part.type !== "tool-deepResearch") {
    return part;
  }
  if (part.state !== "output-available") {
    return part;
  }
  if (part.output?.format !== "report" || part.output.status !== "success") {
    return part;
  }
  const oldDocId = part.output.documentId;
  const newDocId = updateDocumentIdInPart(oldDocId, documentIdMap);
  return {
    ...part,
    output: {
      ...part.output,
      documentId: newDocId,
    },
  };
}

function isEditDocumentPart(
  part: ChatMessage["parts"][number]
): part is Extract<
  ChatMessage["parts"][number],
  | { type: "tool-editTextDocument" }
  | { type: "tool-editCodeDocument" }
  | { type: "tool-editSheetDocument" }
> {
  return (
    part.type === "tool-editTextDocument" ||
    part.type === "tool-editCodeDocument" ||
    part.type === "tool-editSheetDocument"
  );
}

function isCreateDocumentPart(
  part: ChatMessage["parts"][number]
): part is Extract<
  ChatMessage["parts"][number],
  | { type: "tool-createTextDocument" }
  | { type: "tool-createCodeDocument" }
  | { type: "tool-createSheetDocument" }
> {
  return (
    part.type === "tool-createTextDocument" ||
    part.type === "tool-createCodeDocument" ||
    part.type === "tool-createSheetDocument"
  );
}

function transformEditDocumentPart(
  part: ChatMessage["parts"][number],
  documentIdMap: Map<string, string>
): ChatMessage["parts"][number] {
  if (!isEditDocumentPart(part)) {
    return part;
  }
  if (part.state !== "output-available") {
    return part;
  }
  if (part.output.status !== "success") {
    return part;
  }
  const oldDocId = part.output.documentId;
  const newDocId = updateDocumentIdInPart(oldDocId, documentIdMap);
  return {
    ...part,
    output: {
      ...part.output,
      documentId: newDocId,
    },
  };
}

function transformCreateDocumentPart(
  part: ChatMessage["parts"][number],
  documentIdMap: Map<string, string>
): ChatMessage["parts"][number] {
  if (!isCreateDocumentPart(part)) {
    return part;
  }
  if (part.state !== "output-available") {
    return part;
  }
  if (part.output.status !== "success") {
    return part;
  }
  const oldDocId = part.output.documentId;
  const newDocId = updateDocumentIdInPart(oldDocId, documentIdMap);
  return {
    ...part,
    output: {
      ...part.output,
      documentId: newDocId,
    },
  };
}

function transformPartWithDocumentId(
  part: ChatMessage["parts"][number],
  documentIdMap: Map<string, string>
): ChatMessage["parts"][number] {
  if (part.type === "tool-deepResearch") {
    return transformDeepResearchPart(part, documentIdMap);
  }
  if (isEditDocumentPart(part)) {
    return transformEditDocumentPart(part, documentIdMap);
  }
  if (isCreateDocumentPart(part)) {
    return transformCreateDocumentPart(part, documentIdMap);
  }
  return part;
}

function updateDocumentReferencesInMessageParts<
  T extends { parts: ChatMessage["parts"] },
>(messages: T[], documentIdMap: Map<string, string>): T[] {
  return messages.map((message) => {
    const parts = message.parts;
    let updatedParts: ChatMessage["parts"] = [];

    if (Array.isArray(parts)) {
      updatedParts = parts.map((part) =>
        transformPartWithDocumentId(part, documentIdMap)
      );
    }

    return {
      ...message,
      parts: updatedParts,
    };
  });
}
function cloneDocuments<
  T extends { id: string; messageId: string; userId: string },
>(
  sourceDocuments: T[],
  documentIdMap: Map<string, string>,
  messageIdMap: Map<string, string>,
  newUserId: string
): T[] {
  const clonedDocuments: T[] = [];

  for (const document of sourceDocuments) {
    const newDocumentId = documentIdMap.get(document.id);
    const newMessageId = messageIdMap.get(document.messageId);

    if (!newDocumentId) {
      throw new Error(`Document ID ${document.id} not found in mapping`);
    }
    if (!newMessageId) {
      throw new Error(`Message ID ${document.messageId} not found in mapping`);
    }

    const clonedDocument: T = {
      ...document,
      id: newDocumentId,
      messageId: newMessageId,
      userId: newUserId,
    };
    clonedDocuments.push(clonedDocument);
  }

  return clonedDocuments;
}

/** Who the copy is for, and what the source chat may hand over. */
interface CloneOwners {
  /** The user the cloned chat belongs to; copies are stored under them. */
  ownerId: string;
  /** The owner of the source chat. */
  sourceOwnerId: string;
  /**
   * The untagged pre-tag keys the source chat holds through trusted
   * references (`lib/file-access.ts::getTrustedLegacyFileKeys`).
   */
  trustedLegacyKeys: ReadonlySet<string>;
}

/**
 * Copies one stored file into the cloner's storage and returns the copy's
 * link, or null when the link is not copied (and stays as it was).
 *
 * The cloner may only copy the source chat's files that its owner put there,
 * the same rule as reading them (`lib/file-access.ts::canReadStoredFile`): a
 * tagged key must be the source owner's (`lib/file-storage.ts::isFileOwnedBy`)
 * and an untagged pre-tag key must be in `trustedLegacyKeys`. Message parts are
 * client-supplied, so a public chat could otherwise launder someone else's
 * file: paste their key into your own chat, share it, clone it, and the copy
 * is yours. Any other key is left alone; it is not readable in the clone
 * either.
 */
async function copyStoredFile(
  url: string,
  /** The copy's name; null names it after the source key (keeps its extension). */
  filename: string | null,
  owners: CloneOwners
): Promise<string | null> {
  const key = keyFromFileUrl(url);
  if (!key) {
    // External files are not managed by this instance; the link is kept.
    return null;
  }
  const mayCopy =
    ownerTagFromFileKey(key) === null
      ? owners.trustedLegacyKeys.has(key)
      : isFileOwnedBy(key, owners.sourceOwnerId);
  if (!mayCopy) {
    console.warn("Stored file is not the source chat owner's; not copied");
    return null;
  }

  const storedFile = await downloadFile(key);
  const uploadedFile = await uploadFile(
    filename ?? key,
    Buffer.from(await storedFile.arrayBuffer()),
    storedFile.type,
    owners.ownerId
  );
  return uploadedFile.url;
}

async function cloneFileUIPart(
  part: FileUIPart,
  owners: CloneOwners
): Promise<FileUIPart> {
  try {
    // Skip if no URL is provided
    if (!part.url) {
      console.warn("Attachment has no URL, skipping clone");
      return part;
    }

    // Extract just the base filename without any path components
    let filename = part.filename || "attachment";

    // If filename contains path separators, get just the last part
    if (filename.includes("/")) {
      filename = filename.split("/").pop() || "attachment";
    }

    // Remove any existing prefix if it somehow got into the filename
    if (filename.startsWith(FILE_STORAGE_PREFIX)) {
      filename = filename.replace(FILE_STORAGE_PREFIX, "");
    }

    const url = await copyStoredFile(part.url, filename, owners);
    return url ? { ...part, url } : part;
  } catch (error) {
    console.error("Failed to clone attachment:", error);
    // Return original attachment as fallback to avoid breaking the cloning process
    return part;
  }
}

/**
 * Generated images and videos live in tool outputs, not file parts. Their
 * links carry the source owner's tag, so a clone that kept them would show
 * broken media, and an image edit in the clone would resolve
 * `lastGeneratedImage` to a file the cloner cannot read
 * (`tools/platform/generate-image.ts::fetchImageBuffer`). They are copied like
 * attachments.
 */
async function cloneGeneratedMediaPart(
  part: ChatMessage["parts"][number],
  owners: CloneOwners
): Promise<ChatMessage["parts"][number]> {
  try {
    if (
      part.type === "tool-generateImage" &&
      part.state === "output-available" &&
      part.output?.imageUrl
    ) {
      const imageUrl = await copyStoredFile(part.output.imageUrl, null, owners);
      return imageUrl
        ? { ...part, output: { ...part.output, imageUrl } }
        : part;
    }
    if (
      part.type === "tool-generateVideo" &&
      part.state === "output-available" &&
      part.output?.videoUrl
    ) {
      const videoUrl = await copyStoredFile(part.output.videoUrl, null, owners);
      return videoUrl
        ? { ...part, output: { ...part.output, videoUrl } }
        : part;
    }
  } catch (error) {
    console.error("Failed to clone generated media:", error);
  }
  return part;
}

export async function cloneAttachmentsInMessages<
  T extends { parts: ChatMessage["parts"] },
>(messages: T[], owners: CloneOwners): Promise<T[]> {
  const clonedMessages: T[] = [];

  for (const message of messages) {
    if (message.parts && Array.isArray(message.parts)) {
      const clonedParts: ChatMessage["parts"] = [];

      for (const part of message.parts) {
        if (part.type === "file") {
          const clonedPart = await cloneFileUIPart(part, owners);
          clonedParts.push(clonedPart);
        } else {
          clonedParts.push(await cloneGeneratedMediaPart(part, owners));
        }
      }

      const clonedMessage: T = {
        ...message,
        parts: clonedParts,
      };
      clonedMessages.push(clonedMessage);
    } else {
      clonedMessages.push(message);
    }
  }

  return clonedMessages;
}

export function cloneMessagesWithDocuments<
  TMessage extends {
    id: string;
    chatId: string;
    parentMessageId?: string | null;
    parts: ChatMessage["parts"];
    metadata?: {
      parentMessageId: string | null;
    } & Record<string, unknown>;
  },
  TDocument extends {
    id: string;
    messageId: string;
    userId: string;
    title: string;
    kind: unknown;
    content: string | null;
    createdAt: Date;
  },
>(
  sourceMessages: TMessage[],
  sourceDocuments: TDocument[],
  newChatId: string,
  newUserId: string
): {
  clonedMessages: TMessage[];
  clonedDocuments: TDocument[];
  messageIdMap: Map<string, string>;
  documentIdMap: Map<string, string>;
} {
  // Step 1: Clone messages (id, chatId, and parentMessageId field)
  const clonedMessagesBase = cloneMessages(sourceMessages, newChatId);

  // Step 2: Create message ID mapping for later use
  const messageIdMap = new Map<string, string>();
  for (let i = 0; i < sourceMessages.length; i++) {
    messageIdMap.set(sourceMessages[i].id, clonedMessagesBase[i].id);
  }

  // Step 2b: If messages have metadata.parentMessageId (ChatMessage),
  // remap it using the messageIdMap so the thread structure is preserved.
  const clonedMessages: TMessage[] = clonedMessagesBase.map(
    (clonedMessage, index) => {
      const sourceMessage = sourceMessages[index];

      const oldMetadataParentId =
        sourceMessage.metadata?.parentMessageId ?? null;

      if (oldMetadataParentId === null) {
        // Ensure we don't accidentally carry over an old parent in metadata
        if (!clonedMessage.metadata) {
          return clonedMessage;
        }

        return {
          ...clonedMessage,
          metadata: {
            ...clonedMessage.metadata,
            parentMessageId: null,
          },
        };
      }

      const newMetadataParentId = messageIdMap.get(oldMetadataParentId);
      if (!newMetadataParentId) {
        throw new Error(
          `Parent message ID ${oldMetadataParentId} from metadata not found in mapping`
        );
      }

      const existingMetadata = clonedMessage.metadata ?? {
        parentMessageId: null,
      };

      return {
        ...clonedMessage,
        metadata: {
          ...existingMetadata,
          parentMessageId: newMetadataParentId,
        },
      };
    }
  );

  // Step 3: Create document ID mapping
  const documentIdMap = createDocumentIdMap(sourceDocuments);

  // Step 4: Update document references in message parts
  const messagesWithUpdatedDocRefs = updateDocumentReferencesInMessageParts(
    clonedMessages,
    documentIdMap
  );

  // Step 5: Clone documents
  const clonedDocuments = cloneDocuments(
    sourceDocuments,
    documentIdMap,
    messageIdMap,
    newUserId
  );

  return {
    clonedMessages: messagesWithUpdatedDocRefs,
    clonedDocuments,
    messageIdMap,
    documentIdMap,
  };
}
