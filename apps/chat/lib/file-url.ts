export const FILE_CONTENT_PATH = "/api/files/content";

/**
 * A managed key is `<owner tag>.<random id>[.ext]`. The owner tag is derived
 * from the uploader's user id (`lib/file-storage.ts::fileOwnerTag`) so that
 * `lib/file-content-response.ts::createFileContentResponse` can serve a file
 * only to the user who stored it. Keys without a tag cannot prove an owner and
 * are not managed keys.
 */
export const FILE_OWNER_TAG_LENGTH = 16;
const STORAGE_KEY =
  /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{24}(?:\.[a-z0-9]{1,10})?$/;
const URL_PARSE_BASE = "http://chatjs.local";

export function isFileStorageKey(value: string): boolean {
  return STORAGE_KEY.test(value);
}

export function ownerTagFromFileKey(key: string): string | null {
  return isFileStorageKey(key) ? key.slice(0, FILE_OWNER_TAG_LENGTH) : null;
}

function parseFileUrl(value: string): URL | null {
  try {
    const url = new URL(value, URL_PARSE_BASE);
    const key = url.searchParams.get("key");
    return url.pathname === FILE_CONTENT_PATH &&
      url.searchParams.size === 1 &&
      key &&
      isFileStorageKey(key)
      ? url
      : null;
  } catch {
    return null;
  }
}

export function keyFromFileUrl(value: string): string | null {
  return parseFileUrl(value)?.searchParams.get("key") ?? null;
}

export function getFileImageProps(value: string): {
  src: string;
  unoptimized: boolean;
} {
  const url = parseFileUrl(value);
  return url
    ? { src: `${url.pathname}${url.search}`, unoptimized: true }
    : { src: value, unoptimized: false };
}
