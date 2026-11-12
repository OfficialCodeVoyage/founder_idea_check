import type {
  DataContent,
  FilePart,
  ImagePart,
  ModelMessage,
  TextPart,
} from "ai";
import { FilesError } from "files-sdk";
import { downloadFile, isFileOwnedBy } from "@/lib/file-storage";
import { FILE_CONTENT_PATH, keyFromFileUrl } from "@/lib/file-url";
import { getBaseUrl } from "@/lib/url";

// Minimal utilities to download assets from URL-based parts and inline them.

interface DownloadResult {
  data: Uint8Array;
  mediaType: string | undefined;
}

type AssetDownloadResult = DownloadResult | null;

/** A file part that was not inlined, and the reason the model is told. */
interface RefusedAsset {
  refused: string;
}

export type DownloadImplementation = (args: {
  url: URL;
}) => Promise<AssetDownloadResult>;

const NOT_YOUR_FILE =
  "[Attachment omitted: it is not one of your stored files.]";
const UNMANAGED_APP_FILE =
  "[Attachment omitted: this file link is not a valid stored-file link.]";

/**
 * A chat turn's file parts come from the client, so a URL on this app's file
 * route is inlined only when its key is a managed key the caller stored
 * (`lib/file-storage.ts::isFileOwnedBy`). Anything else on that route — an
 * untagged key, someone else's key, any key on an anonymous turn — is refused
 * and replaced with a text part saying so, never fetched.
 */
function refuseApplicationFile(
  url: URL,
  ownerId: string | null
): RefusedAsset | null {
  const isApplicationFileRoute =
    url.origin === new URL(getBaseUrl()).origin &&
    url.pathname === FILE_CONTENT_PATH;
  if (!isApplicationFileRoute) {
    return null;
  }
  const key = keyFromFileUrl(url.toString());
  if (!key) {
    return { refused: UNMANAGED_APP_FILE };
  }
  if (!(ownerId && isFileOwnedBy(key, ownerId))) {
    return { refused: NOT_YOUR_FILE };
  }
  return null;
}

async function defaultDownload({
  url,
}: {
  url: URL;
}): Promise<AssetDownloadResult> {
  const isApplicationUrl = url.origin === new URL(getBaseUrl()).origin;
  const key = isApplicationUrl ? keyFromFileUrl(url.toString()) : null;
  if (key) {
    try {
      const file = await downloadFile(key);
      return {
        data: new Uint8Array(await file.arrayBuffer()),
        mediaType: file.type || undefined,
      };
    } catch (error) {
      if (error instanceof FilesError && error.code === "NotFound") {
        return null;
      }
      throw error;
    }
  }

  const response = await fetch(url);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(
      `Failed to download asset: ${url.toString()} (${response.status})`
    );
  }
  const contentType = response.headers.get("content-type") || undefined;
  const arrayBuffer = await response.arrayBuffer();
  return { mediaType: contentType, data: new Uint8Array(arrayBuffer) };
}

function toHttpUrl(value: unknown): URL | null {
  if (value instanceof URL) {
    return value.protocol.startsWith("http") ? value : null;
  }
  if (typeof value === "string") {
    try {
      // A relative link to this app's file route resolves against this app,
      // whether or not its key is a managed one, so refuseApplicationFile
      // sees it.
      const url =
        keyFromFileUrl(value) || value.startsWith(`${FILE_CONTENT_PATH}?`)
          ? new URL(value, getBaseUrl())
          : new URL(value);
      return url.protocol === "http:" || url.protocol === "https:" ? url : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Collects all http(s) URLs from file/image parts in the provided messages and downloads them.
 * Returns a map keyed by the normalized URL string.
 */
async function downloadAssetsFromModelMessages(
  messages: ModelMessage[],
  ownerId: string | null,
  downloadImplementation: DownloadImplementation
): Promise<Record<string, AssetDownloadResult | RefusedAsset>> {
  const urlSet = new Set<string>();

  for (const message of messages) {
    if (typeof message.content === "string") {
      continue;
    }
    for (const part of message.content) {
      if (part.type !== "file" && part.type !== "image") {
        continue;
      }
      const dataOrUrl: DataContent | URL =
        part.type === "file"
          ? (part as FilePart).data
          : (part as ImagePart).image;
      const url = toHttpUrl(dataOrUrl);
      if (url) {
        urlSet.add(url.toString());
      }
    }
  }

  const urls = Array.from(urlSet).map((u) => new URL(u));
  const downloaded = await Promise.all(
    urls.map(async (url) => ({
      url,
      data:
        refuseApplicationFile(url, ownerId) ??
        (await downloadImplementation({ url })),
    }))
  );
  return Object.fromEntries(
    downloaded.map(({ url, data }) => [url.toString(), data])
  );
}

function mapFilePart(
  part: FilePart,
  downloaded: Record<string, AssetDownloadResult | RefusedAsset>
): FilePart | TextPart | null {
  const url = toHttpUrl(part.data);
  if (url) {
    const found = downloaded[url.toString()];
    if (found === null) {
      return null;
    }
    if (found && "refused" in found) {
      return { type: "text", text: found.refused };
    }
    if (found) {
      return {
        ...part,
        data: found.data,
        mediaType: part.mediaType ?? found.mediaType,
      };
    }
  }
  return part;
}

function mapImagePart(
  part: ImagePart,
  downloaded: Record<string, AssetDownloadResult | RefusedAsset>
): ImagePart | TextPart | null {
  const url = toHttpUrl(part.image);
  if (url) {
    const found = downloaded[url.toString()];
    if (found === null) {
      return null;
    }
    if (found && "refused" in found) {
      return { type: "text", text: found.refused };
    }
    if (found) {
      return {
        ...part,
        image: found.data,
        mediaType: part.mediaType ?? found.mediaType,
      };
    }
  }
  return part;
}

/**
 * Inlines any URL-based file/image parts within ModelMessage[] by replacing the URLs
 * with downloaded binary data. This ensures providers receive actual bytes.
 */
export async function replaceFilePartUrlByBinaryDataInMessages(
  messages: ModelMessage[],
  ownerId: string | null,
  downloadImplementation: DownloadImplementation = defaultDownload
): Promise<ModelMessage[]> {
  const downloaded = await downloadAssetsFromModelMessages(
    messages,
    ownerId,
    downloadImplementation
  );

  const mapPart = (
    part: TextPart | ImagePart | FilePart
  ): TextPart | ImagePart | FilePart | null => {
    if (part.type === "file") {
      return mapFilePart(part as FilePart, downloaded);
    }
    if (part.type === "image") {
      return mapImagePart(part as ImagePart, downloaded);
    }
    // pass-through for text/tool/reasoning/etc
    return part;
  };

  const mappedMessages = messages.map((message) => {
    if (message.role !== "user" || typeof message.content === "string") {
      return message;
    }

    return {
      ...message,
      content: message.content
        .map(mapPart)
        .filter(
          (part): part is TextPart | ImagePart | FilePart => part !== null
        ),
    };
  });

  const availableMessages = mappedMessages.filter(
    (message) =>
      !(
        message.role === "user" &&
        Array.isArray(message.content) &&
        message.content.length === 0
      )
  );
  const firstUserIndex = availableMessages.findIndex(
    (message) => message.role === "user"
  );
  if (firstUserIndex === -1) {
    return availableMessages.filter((message) => message.role === "system");
  }

  const leadingSystemMessages = availableMessages
    .slice(0, firstUserIndex)
    .filter((message) => message.role === "system");
  return [...leadingSystemMessages, ...availableMessages.slice(firstUserIndex)];
}
