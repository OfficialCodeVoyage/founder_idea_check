import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { serverEnvSchema } from "./env-schema";

/**
 * Census: every server env var must be named in the repo-root turbo.json.
 *
 * `bun run dev` goes through turbo, which runs in strict env mode and passes a
 * task only the variables listed in `globalEnv`. `RESEARCH_ENABLED_SOURCES` was
 * in `serverEnvSchema` but not in that list, so `bun run dev` silently dropped
 * it, the app fell back to the two keyless sources, and an operator who had
 * switched a source on saw it refused with no hint that the variable never
 * arrived. `dev:local` avoids turbo altogether, which is why the gap stayed
 * invisible there.
 *
 * Skipped when there is no turbo.json two levels up: apps/chat can be copied out
 * of the monorepo on its own, and a standalone copy has no turbo to be strict.
 */
const TURBO_JSON = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "turbo.json"
);

describe.skipIf(!existsSync(TURBO_JSON))("turbo.json env census", () => {
  it("lists every key of serverEnvSchema in globalEnv", () => {
    const turbo = JSON.parse(readFileSync(TURBO_JSON, "utf8")) as {
      globalEnv: string[];
    };
    const listed = new Set(turbo.globalEnv);

    const missing = Object.keys(serverEnvSchema).filter(
      (name) => !listed.has(name)
    );

    expect(missing).toEqual([]);
  });
});
