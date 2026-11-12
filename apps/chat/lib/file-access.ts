import "server-only";
import { getChatById, getFileUrlsByChatId } from "@/lib/db/queries";
import { isFileOwnedBy, isFileSharedByChatOwner } from "@/lib/file-storage";
import { keyFromFileUrl } from "@/lib/file-url";
import { createModuleLogger } from "@/lib/logger";

const log = createModuleLogger("file-access");

/**
 * Whether `viewerId` (null when signed out) may read the stored file `key`.
 *
 * 1. The file's owner always may (its key's tag is theirs) — no lookup.
 * 2. Otherwise only through a chat the caller names (`chatId`), and only when
 *    all three hold:
 *    - the viewer may see that chat: it is public, or it is theirs;
 *    - the chat's owner vouches for the file
 *      (`lib/file-storage.ts::isFileSharedByChatOwner`): a tagged key must
 *      carry the chat owner's tag, so pasting someone else's key or link into
 *      a chat — as a file part, a forged tool output, anything — never makes it
 *      readable; an untagged pre-tag key carries no owner and is vouched for by
 *      any chat that references it (the residual is stated there);
 *    - the chat's stored messages really reference the key
 *      (`lib/db/queries.ts::getFileUrlsByChatId`), so a public chat does not
 *      open every other file its owner has.
 *
 * The chat lookups are a primary-key read and one query bounded to that chat's
 * file and media parts, and run only when rule 1 fails. Any lookup error
 * denies: this fails closed.
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
    if (!(mayViewChat && isFileSharedByChatOwner(key, chat.userId))) {
      return false;
    }
    const urls = await getFileUrlsByChatId({ chatId });
    return urls.some((url) => keyFromFileUrl(url) === key);
  } catch (error) {
    log.error({ error, chatId }, "stored-file access lookup failed; denied");
    return false;
  }
}
