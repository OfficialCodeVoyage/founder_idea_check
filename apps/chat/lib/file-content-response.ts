import { FilesError } from "files-sdk";
import {
  downloadFile,
  getFileMetadata,
  getFileProviderUrl,
  isFileOwnedBy,
  storageSupportsRange,
} from "./file-storage";
import { keyFromFileUrl } from "./file-url";

const RANGE_HEADER = /^bytes=(?:(\d+)-(\d*)|-(\d+))$/;

function parseRange(value: string, size: number) {
  const match = RANGE_HEADER.exec(value);
  if (!match) {
    return null;
  }
  if (match[3]) {
    const length = Number(match[3]);
    return Number.isSafeInteger(length) && length > 0 && size > 0
      ? { start: Math.max(size - length, 0), end: size - 1 }
      : null;
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  const end = Math.min(requestedEnd, size - 1);
  return Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    start <= end &&
    start < size
    ? { start, end }
    : null;
}

/**
 * Serves a stored file to the signed-in user who stored it. `userId` comes from
 * the caller's session (`app/(chat)/api/files/content/route.ts`); a key whose
 * owner tag is not that user's answers 404, the same as a missing file, so the
 * response does not reveal whether someone else's key exists.
 */
export async function createFileContentResponse(
  request: Request,
  userId: string
) {
  const key = keyFromFileUrl(request.url);
  if (!key) {
    return new Response("Invalid file URL", { status: 400 });
  }
  if (!isFileOwnedBy(key, userId)) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const providerUrl = await getFileProviderUrl(key);
    if (providerUrl) {
      return new Response(null, {
        headers: {
          Location: providerUrl,
          "Cache-Control": "private, no-store",
        },
        status: 307,
      });
    }

    const rangeHeader = request.headers.get("range");
    const supportsRange = storageSupportsRange();
    let range: { start: number; end: number } | undefined;
    let fullSize: number | undefined;
    if (rangeHeader && supportsRange) {
      const metadata = await getFileMetadata(key);
      fullSize = metadata.size;
      const parsed = parseRange(rangeHeader, fullSize);
      if (!parsed) {
        return new Response(null, {
          headers: { "Content-Range": `bytes */${fullSize}` },
          status: 416,
        });
      }
      range = parsed;
    }

    const file = await downloadFile(key, range);
    const headers = new Headers({
      "Accept-Ranges": supportsRange ? "bytes" : "none",
      "Content-Length": String(file.size),
      "Content-Type": file.type || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });
    if (range && fullSize !== undefined) {
      headers.set(
        "Content-Range",
        `bytes ${range.start}-${range.end}/${fullSize}`
      );
    }
    return new Response(file.stream(), {
      headers,
      status: range ? 206 : 200,
    });
  } catch (error) {
    if (error instanceof FilesError && error.code === "NotFound") {
      return new Response("File not found", { status: 404 });
    }
    return new Response("File download failed", { status: 500 });
  }
}
