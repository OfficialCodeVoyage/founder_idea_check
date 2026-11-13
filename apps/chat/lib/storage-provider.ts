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
//
// Two consequences (README-DEV.md, "File storage"):
// - Blobs uploaded as public before this setting come back NotFound: in private
//   mode files-sdk reads with `blob.get(key, { access: "private" })`. A
//   store that already holds public blobs needs a one-off copy into a private
//   store under the same pathnames before going live.
// - Private blobs have no range reads, so the content route answers
//   `Accept-Ranges: none`; Safari will not play a <video> without ranges.
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
