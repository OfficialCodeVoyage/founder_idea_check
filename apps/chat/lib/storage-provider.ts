// This file is rewritten by `chat-js create --storage-provider`.
// ChatJS storage peer dependencies: ["@vercel/blob"]

import type { ProviderSlug } from "files-sdk/providers";
import { vercelBlob } from "files-sdk/vercel-blob";

// Private, not the adapter's "public" default: a public blob is readable by
// anyone holding the store id and the key, straight from the Blob CDN, which
// bypasses every access check in lib/file-access.ts. Private blobs are read
// only through the adapter's credentials (lib/file-storage.ts::downloadFile),
// so /api/files/content stays the only way in. The Blob store itself must
// accept private blobs.
const options = {
  access: "private",
} satisfies Parameters<typeof vercelBlob>[0];

export const storageProvider = {
  createAdapter: () => vercelBlob(options),
  options,
  slug: "vercel-blob",
} satisfies {
  createAdapter: () => ReturnType<typeof vercelBlob>;
  options: typeof options;
  slug: ProviderSlug;
};
