import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The repo-root .env.local is the source of truth — apps/chat/.env.local does
 * not exist. scripts/dev-local.sh bypasses turbo for the same reason (turbo's
 * strict env mode forwards only what turbo.json lists). Resolved from this
 * file's own location rather than cwd so drizzle-kit works from either
 * directory. Root is listed first because dotenv does not overwrite a key that
 * is already set.
 */
config({
  path: [join(HERE, "../../.env.local"), join(HERE, ".env.local")],
});

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./lib/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    // biome-ignore lint: Forbidden non-null assertion.
    url: process.env.DATABASE_URL!,
  },
});
