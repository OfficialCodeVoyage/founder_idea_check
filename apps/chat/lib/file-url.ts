export const FILE_CONTENT_PATH = "/api/files/content";

/**
 * A managed key is `<owner tag>.<random id>[.ext]`. The owner tag is derived
 * from the uploader's user id (`lib/file-storage.ts::fileOwnerTag`) so that
 * `lib/file-access.ts::canReadStoredFile` can serve a file to the user who
 * stored it without any other lookup.
 *
 * Files stored before the tag existed have a bare `<random id>[.ext]` key
 * (LEGACY_STORAGE_KEY). They are still managed keys — chats that reference
 * them must keep working — but they name no owner, so `ownerTagFromFileKey`
 * returns null for them and no rule that trusts a tag ever accepts one. Only
 * new keys are created by `lib/file-storage.ts::uploadFile`, always tagged.
 */
export const FILE_OWNER_TAG_LENGTH = 16;
const TAGGED_STORAGE_KEY =
  /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{24}(?:\.[a-z0-9]{1,10})?$/;
const LEGACY_STORAGE_KEY = /^[A-Za-z0-9_-]{24}(?:\.[a-z0-9]{1,10})?$/;
const CHAT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_PARSE_BASE = "http://chatjs.local";

export function isFileStorageKey(value: string): boolean {
  return TAGGED_STORAGE_KEY.test(value) || LEGACY_STORAGE_KEY.test(value);
}

export function ownerTagFromFileKey(key: string): string | null {
  return TAGGED_STORAGE_KEY.test(key)
    ? key.slice(0, FILE_OWNER_TAG_LENGTH)
    : null;
}

function parseUrl(value: string): URL | null {
  try {
    const url = new URL(value, URL_PARSE_BASE);
    return url.pathname === FILE_CONTENT_PATH ? url : null;
  } catch {
    return null;
  }
}

/** A stored file link: the content route with exactly one `key` parameter. */
function parseFileUrl(value: string): URL | null {
  const url = parseUrl(value);
  const key = url?.searchParams.get("key");
  return url && url.searchParams.size === 1 && key && isFileStorageKey(key)
    ? url
    : null;
}

/**
 * The key of a stored file link, as messages store it. A link that also
 * carries `chatId` (see `fileUrlInChat`) is a display link, not a stored one,
 * and is rejected here.
 */
export function keyFromFileUrl(value: string): string | null {
  return parseFileUrl(value)?.searchParams.get("key") ?? null;
}

/**
 * A request to the content route: the key, and the chat the file is being
 * viewed in when the page that asked for it knows one. The chat id is only a
 * claim; `lib/file-access.ts::canReadStoredFile` checks it.
 */
export function fileRequestFromUrl(
  value: string
): { key: string; chatId: string | null } | null {
  const url = parseUrl(value);
  if (!url) {
    return null;
  }
  const key = url.searchParams.get("key");
  const chatId = url.searchParams.get("chatId");
  const expectedSize = chatId === null ? 1 : 2;
  if (
    url.searchParams.size !== expectedSize ||
    !key ||
    !isFileStorageKey(key) ||
    (chatId !== null && !CHAT_ID.test(chatId))
  ) {
    return null;
  }
  return { key, chatId };
}

/**
 * The link a page uses to show a stored file inside a chat. Adding the chat id
 * lets a viewer who is not the file's owner — a reader of a shared chat, or the
 * owner of a chat holding a pre-tag file — be served the file through that chat
 * (`lib/file-access.ts::canReadStoredFile`). Display only: messages keep the
 * plain stored link. Anything that is not a stored file link is returned as is.
 */
export function fileUrlInChat(
  value: string,
  chatId: string | null | undefined
): string {
  const key = keyFromFileUrl(value);
  if (!(key && chatId && CHAT_ID.test(chatId))) {
    return value;
  }
  return `${FILE_CONTENT_PATH}?${new URLSearchParams({ key, chatId })}`;
}

export function getFileImageProps(value: string): {
  src: string;
  unoptimized: boolean;
} {
  const url = fileRequestFromUrl(value) ? parseUrl(value) : null;
  return url
    ? { src: `${url.pathname}${url.search}`, unoptimized: true }
    : { src: value, unoptimized: false };
}
