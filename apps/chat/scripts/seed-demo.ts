#!/usr/bin/env bun
/**
 * Seeds the local development database with the minimum set of rows needed to
 * exercise the phase workflow in a browser:
 *
 *   user (dev@localhost)  ->  UserCredit  ->  Project  ->  ProjectPhase (phase 1)
 *
 * The user is deliberately the same `dev@localhost` account that
 * `GET /api/dev-login` signs you into, so seeding and dev login land on one
 * account and the seeded project shows up in the sidebar immediately.
 *
 * Idempotent: every write is either a lookup-then-insert or an explicit
 * ON CONFLICT DO NOTHING, so running this twice changes nothing.
 *
 * Run:  bun run db:seed        (repo root, loads .env.local for you)
 *   or: bun scripts/seed-demo.ts   (from apps/chat; loads the root .env.local itself)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnvConfig } from "dotenv";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { PHASE_ONE } from "../lib/phases/definitions";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const repoRoot = path.resolve(appRoot, "../..");

// apps/chat has no .env.local of its own — the real one lives at the repo root.
// Load it before anything imports lib/env, which validates DATABASE_URL eagerly.
loadEnvConfig({ path: path.join(repoRoot, ".env.local") });
loadEnvConfig({ path: path.join(appRoot, ".env.local") });
loadEnvConfig();

/** Same account as app/api/dev-login/route.ts — do not diverge. */
const DEV_USER_EMAIL = "dev@localhost";
const DEV_USER_NAME = "Dev User";
const DEV_USER_ID = "dev-local-user";

const DEMO_PROJECT_NAME = "Demo idea";
const DEMO_PROJECT_INSTRUCTIONS =
  "A seeded demo project. Talk to it like a founder with a raw idea; the phase gate will refuse to advance until phase 1 is satisfied.";

type Schema = typeof import("../lib/db/schema");
type Db = ReturnType<typeof drizzle>;

async function ensureUser(db: Db, schema: Schema): Promise<string> {
  const [existing] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, DEV_USER_EMAIL));

  if (existing) {
    return existing.id;
  }

  const [created] = await db
    .insert(schema.user)
    .values({
      id: DEV_USER_ID,
      email: DEV_USER_EMAIL,
      name: DEV_USER_NAME,
      emailVerified: true,
    })
    .returning({ id: schema.user.id });

  return created.id;
}

async function ensureCredits(
  db: Db,
  schema: Schema,
  userId: string
): Promise<void> {
  await db
    .insert(schema.userCredit)
    .values({ userId })
    .onConflictDoNothing({ target: schema.userCredit.userId });
}

async function ensureProject(
  db: Db,
  schema: Schema,
  userId: string
): Promise<string> {
  const [existing] = await db
    .select({ id: schema.project.id })
    .from(schema.project)
    .where(
      and(
        eq(schema.project.userId, userId),
        eq(schema.project.name, DEMO_PROJECT_NAME)
      )
    );

  if (existing) {
    return existing.id;
  }

  const [created] = await db
    .insert(schema.project)
    .values({
      userId,
      name: DEMO_PROJECT_NAME,
      instructions: DEMO_PROJECT_INSTRUCTIONS,
    })
    .returning({ id: schema.project.id });

  return created.id;
}

async function ensurePhase(
  db: Db,
  schema: Schema,
  projectId: string
): Promise<void> {
  // Deliberately leaves decision/reason/nextQuestion NULL: the honest initial
  // state is "the gate has never run", which the rail renders as BLOCK with
  // "no assessment yet — keep going".
  await db
    .insert(schema.projectPhase)
    .values({
      projectId,
      phaseKey: PHASE_ONE.key,
      phaseOrder: PHASE_ONE.order,
      status: "active",
    })
    .onConflictDoNothing();
}

async function seed(): Promise<void> {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL_ENV === "production"
  ) {
    console.error(
      "❌ Refusing to seed: NODE_ENV/VERCEL_ENV is production. This script is development-only."
    );
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      `❌ DATABASE_URL is not set. Expected it in ${path.join(repoRoot, ".env.local")}.\n   See GETTING-STARTED.md.`
    );
    process.exit(1);
  }

  // Imported dynamically: lib/db/schema pulls lib/env, which validates the
  // environment at import time and must not run before dotenv above.
  const schema: Schema = await import("../lib/db/schema");

  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client);

  try {
    const userId = await ensureUser(db, schema);
    await ensureCredits(db, schema, userId);
    const projectId = await ensureProject(db, schema, userId);
    await ensurePhase(db, schema, projectId);

    console.log("✅ Seed complete (idempotent — safe to run again)");
    console.log(`   user     ${DEV_USER_EMAIL} (${userId})`);
    console.log(`   project  ${DEMO_PROJECT_NAME} (${projectId})`);
    console.log(
      `   phase    ${PHASE_ONE.order}. ${PHASE_ONE.title} [${PHASE_ONE.key}] status=active`
    );
    console.log("");
    console.log("Next:");
    console.log(
      "   1. start the app:  bun run dev:local   (http://localhost:3100)"
    );
    console.log("   2. sign in:        http://localhost:3100/api/dev-login");
    console.log(
      `   3. open the rail:  http://localhost:3100/project/${projectId}`
    );
  } finally {
    await client.end();
  }
}

seed().catch((error) => {
  console.error(error);
  process.exit(1);
});
