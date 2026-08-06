// This file is rewritten by `chat-js create --storage-provider`.
// ChatJS storage peer dependencies: ["@vercel/blob"]

import type { ProviderSlug } from "files-sdk/providers";
import { vercelBlob } from "files-sdk/vercel-blob";

const options = {} satisfies Parameters<typeof vercelBlob>[0];

export const storageProvider = {
  createAdapter: () => vercelBlob(options),
  options,
  slug: "vercel-blob",
} satisfies {
  createAdapter: () => ReturnType<typeof vercelBlob>;
  options: typeof options;
  slug: ProviderSlug;
};
