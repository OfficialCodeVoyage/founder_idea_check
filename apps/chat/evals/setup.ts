import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { vi } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The repo-root .env.local is the source of truth — apps/chat/.env.local does
 * not exist, and turbo's strict env mode is the reason (see scripts/dev-local.sh:
 * the dev server bypasses turbo and loads the root file directly for the same
 * reason). Resolved from this file's own location rather than cwd, so an eval
 * run from the repo root and one run from apps/chat both find it.
 *
 * Listed first because dotenv does not overwrite an already-set key: root wins,
 * and an apps/chat/.env.local, should one ever appear, only fills gaps.
 */
config({
  path: [join(HERE, "../../../.env.local"), join(HERE, "../.env.local")],
});

vi.mock("server-only", () => {
  return {
    // mock server-only module
  };
});

/**
 * `unstable_cache` throws "Invariant: incrementalCache missing" outside a Next
 * request context, and lib/ai/app-models.ts wraps the model catalogue in it —
 * so every eval that resolves a model through getLanguageModel dies before it
 * reaches a provider. Passing the callback through unchanged is the correct
 * behaviour here: an eval wants the live catalogue, not a cached one. Only
 * unstable_cache is replaced; the rest of next/cache stays real.
 */
vi.mock("next/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/cache")>();
  return {
    ...actual,
    unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  };
});
