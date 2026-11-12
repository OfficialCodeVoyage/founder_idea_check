import "server-only";
import { getChatById, getFileReferencesByChatId } from "@/lib/db/queries";
import { isFileOwnedBy, isFileReferenceTrusted } from "@/lib/file-storage";
import { keyFromFileUrl, ownerTagFromFileKey } from "@/lib/file-url";
import { createModuleLogger } from "@/lib/logger";

const log = createModuleLogger("file-access");

/**
 * Whether `viewerId` (null when signed out) may read the stored file `key`.
 *
 * 1. The file's owner always may (its key's tag is theirs) — no lookup.
 * 2. Otherwise only through a chat the caller names (`chatId`), and only when
 *    both hold:
 *    - the viewer may see that chat: it is public, or it is theirs;
 *    - one of that chat's stored references to the key is trusted
 *      (`lib/file-storage.ts::isFileReferenceTrusted`): for a tagged key, the
 *      key carries the chat owner's tag, so pasting someone else's key or link
 *      into a chat — a file part, a forged tool output, anything — never makes
 *      it readable; for an untagged pre-tag key, the Part row was written by
 *      the database before the owner tag existed, which a client cannot forge.
 *      Requiring a stored reference also keeps a public chat from opening
 *      every other file its owner has.
 *
 * The chat lookups are a primary-key read and one query bounded to that chat's
 * file and media parts (`lib/db/queries.ts::getFileReferencesByChatId`), and
 * run only when rule 1 fails. Any lookup error denies: this fails closed.
 */
export async function canReadStoredFile({
  key,
  viewerId,
  chatId,
}: {
  key: string;
  viewerId: string | null;
  chatId: string | null;
}): Promise<boolean> {
  if (viewerId && isFileOwnedBy(key, viewerId)) {
    return true;
  }
  if (!chatId) {
    return false;
  }
  try {
    const chat = await getChatById({ id: chatId });
    if (!chat) {
      return false;
    }
    const mayViewChat =
      chat.visibility === "public" ||
      (viewerId !== null && chat.userId === viewerId);
    if (!mayViewChat) {
      return false;
    }
    // A tagged key the chat owner did not store can never pass; skip the query.
    if (ownerTagFromFileKey(key) !== null && !isFileOwnedBy(key, chat.userId)) {
      return false;
    }
    const references = await getFileReferencesByChatId({ chatId });
    return references.some(
      (reference) =>
        keyFromFileUrl(reference.url) === key &&
        isFileReferenceTrusted({
          key,
          chatOwnerId: chat.userId,
          referencedAt: reference.createdAt,
        })
    );
  } catch (error) {
    log.error({ error, chatId }, "stored-file access lookup failed; denied");
    return false;
  }
}

/**
 * The untagged pre-tag keys a chat holds through trusted references
 * (`lib/file-storage.ts::isFileReferenceTrusted`). Cloning copies only these
 * among untagged keys. Errors propagate: the caller copies nothing on failure.
 */
export async function getTrustedLegacyFileKeys({
  chatId,
  chatOwnerId,
}: {
  chatId: string;
  chatOwnerId: string;
}): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const reference of await getFileReferencesByChatId({ chatId })) {
    const key = keyFromFileUrl(reference.url);
    if (
      key !== null &&
      ownerTagFromFileKey(key) === null &&
      isFileReferenceTrusted({
        key,
        chatOwnerId,
        referencedAt: reference.createdAt,
      })
    ) {
      keys.add(key);
    }
  }
  return keys;
}
