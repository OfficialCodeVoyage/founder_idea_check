import { createHash } from "node:crypto";
import { type Body, Files } from "files-sdk";
import { nanoid } from "nanoid";
import { FILE_STORAGE_PREFIX } from "./constants";
import {
  FILE_CONTENT_PATH,
  FILE_OWNER_TAG_LENGTH,
  isFileStorageKey,
  keyFromFileUrl,
  ownerTagFromFileKey,
} from "./file-url";
import { storageProvider } from "./storage-provider";

const SAFE_EXTENSION = /^\.[a-z0-9]{1,10}$/;
const PATH_SEPARATOR = /[\\/]/;

let files: Files | undefined;

function getFiles(): Files {
  files ??= new Files({
    adapter: storageProvider.createAdapter(),
    prefix: FILE_STORAGE_PREFIX,
    retries: 2,
  });
  return files;
}

function sanitizeFilename(filename: string): string {
  const basename = filename.split(PATH_SEPARATOR).at(-1) ?? "";
  const withoutControlCharacters = [...basename]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join("");
  return withoutControlCharacters.trim() || "file";
}

/**
 * The owner part of a storage key (`lib/file-url.ts::isFileStorageKey`): a
 * fixed-length digest of the user id, so the key names its owner without
 * exposing the id itself.
 */
export function fileOwnerTag(userId: string): string {
  return createHash("sha256")
    .update(userId)
    .digest("base64url")
    .slice(0, FILE_OWNER_TAG_LENGTH);
}

export function isFileOwnedBy(key: string, userId: string): boolean {
  return ownerTagFromFileKey(key) === fileOwnerTag(userId);
}

/**
 * Whether a reference to `key` inside a chat owned by `chatOwnerId` counts as
 * the file's owner sharing it with that chat's viewers. Only the chat's owner
 * (and the assistant answering them) writes that chat's messages, but those
 * messages are client-supplied, so a reference alone proves nothing: anyone can
 * paste someone else's key into their own chat. A tagged key therefore counts
 * only when its tag is the chat owner's.
 *
 * A legacy untagged key (`lib/file-url.ts::LEGACY_STORAGE_KEY`) names no owner,
 * so any chat that references one vouches for it. RESIDUAL, stated plainly: a
 * signed-in user who learns a pre-tag file's key can paste it into a chat of
 * their own and then read it there (and so can viewers of that chat if it is
 * shared). New files are always tagged, so this only covers files stored
 * before the tag existed.
 */
export function isFileSharedByChatOwner(
  key: string,
  chatOwnerId: string
): boolean {
  const tag = ownerTagFromFileKey(key);
  if (tag === null) {
    return isFileStorageKey(key);
  }
  return tag === fileOwnerTag(chatOwnerId);
}

function createStorageKey(filename: string, ownerId: string): string {
  const clean = sanitizeFilename(filename);
  const dot = clean.lastIndexOf(".");
  const candidate = dot > 0 ? clean.slice(dot).toLowerCase() : "";
  const extension = SAFE_EXTENSION.test(candidate) ? candidate : "";
  return `${fileOwnerTag(ownerId)}.${nanoid(24)}${extension}`;
}

function createFileUrl(key: string): string {
  const search = new URLSearchParams({ key });
  return `${FILE_CONTENT_PATH}?${search}`;
}

export async function uploadFile(
  filename: string,
  body: Body,
  contentType: string | undefined,
  ownerId: string
) {
  const pathname = sanitizeFilename(filename);
  const uploaded = await getFiles().upload(
    createStorageKey(pathname, ownerId),
    body,
    { contentType }
  );

  return {
    contentType: uploaded.contentType,
    pathname,
    url: createFileUrl(uploaded.key),
  };
}

export async function listFiles() {
  const files: Array<{
    pathname: string;
    uploadedAt: Date;
    url: string;
  }> = [];
  for await (const file of getFiles().listAll()) {
    files.push({
      pathname: file.key,
      uploadedAt: new Date(file.lastModified ?? Date.now()),
      url: createFileUrl(file.key),
    });
  }
  return { files };
}

export async function deleteFilesByUrls(urls: string[]): Promise<void> {
  const keys = [
    ...new Set(
      urls.map(keyFromFileUrl).filter((key): key is string => key !== null)
    ),
  ];
  if (keys.length === 0) {
    return;
  }

  const result = await getFiles().delete(keys);
  const errors = "errors" in result ? result.errors : undefined;
  if (errors?.length) {
    throw new AggregateError(
      errors.map(({ error }) => error),
      `Failed to delete ${errors.length} stored file(s)`
    );
  }
}

export function downloadFile(
  key: string,
  range?: { start: number; end?: number }
) {
  return getFiles().download(key, range ? { range } : undefined);
}

export function getFileMetadata(key: string) {
  return getFiles().head(key);
}

export function storageSupportsRange(): boolean {
  return getFiles().capabilities.rangeRead;
}

export async function getFileProviderUrl(key: string): Promise<string | null> {
  const fileService = getFiles();
  if (!fileService.capabilities.signedUrl.supported) {
    return null;
  }
  const value = await fileService.url(key);
  const url = new URL(value);
  return url.protocol === "http:" || url.protocol === "https:" ? value : null;
}
