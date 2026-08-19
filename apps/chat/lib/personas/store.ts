import "server-only";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { document } from "@/lib/db/schema";
import { createModuleLogger } from "@/lib/logger";
import {
  buildPersonaVersionRow,
  latestReadablePersona,
  orderPersonaVersions,
  type PersonaDocumentRowLike,
  type PersonaVersion,
} from "./artifact";
import type { PersonaArtifact } from "./types";

/**
 * THE ONE IMPURE FILE IN lib/personas. Same role runtime.ts plays for
 * lib/phases: everything else in this directory is pure and runs under vitest
 * with no key, no network and no database, and all of the I/O is here.
 *
 * WHY THIS SQL IS STILL NOT `saveDocument()`, now that saveDocument accepts a
 * `createdAt`: appendVersion must inspect the RAW driver error to tell a
 * benign version collision (Postgres 23505, retry) from a real failure, and it
 * must not emit a console.error on every benign retry. saveDocument logs and
 * rethrows, which would turn each successful retry into a false alarm in the
 * logs. The retry loop below is NOT a workaround for saveDocument's clock — it
 * guards a genuine race between two concurrent regenerations that both read
 * the same version set — so it survives that change and must not be deleted.
 */

const log = createModuleLogger("personas:store");

/**
 * Retries exist for ONE cause: two regenerations racing on the same persona,
 * both reading the same set of existing versions, both computing the same
 * `createdAt`, and colliding on `(id, createdAt)`. The loser re-reads (it now
 * sees the winner's row) and lands one millisecond later.
 *
 * Three attempts, not a while(true): a collision that survives three re-reads is
 * not a race, it is a bug, and it should surface as an error rather than as a
 * hot loop against Postgres.
 */
const MAX_APPEND_ATTEMPTS = 3;

/** Postgres unique_violation. The only error this store retries. */
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

export type AppendPersonaVersionInput = {
  /**
   * Reuse the id of an existing persona to add a version to its history; pass a
   * fresh uuid to start a new persona at v1. There is no third option, and in
   * particular there is no way to overwrite a version.
   */
  documentId: string;
  artifact: PersonaArtifact;
  userId: string;
  /**
   * The assistant message that triggered this regeneration, when there was one.
   * Null is normal — a persona is rebuilt from the fact store, not from a turn.
   */
  messageId?: string | null;
  /**
   * The project the persona belongs to. Supplying it is what makes the persona
   * findable by getPersonaDocumentsByProjectId; omitting it leaves the row
   * reachable only by documentId.
   */
  projectId?: string | null;
};

/**
 * THE PERSISTENCE SEAM. An interface rather than a set of free functions so the
 * canvas (step 7) and the handoff export (step 9) can be handed an in-memory
 * implementation in tests without a database.
 */
export type PersonaStore = {
  /** Oldest first. Unreadable rows are kept with `artifact: null`. */
  listVersions(documentId: string): Promise<PersonaVersion[]>;
  /** The newest version that actually parses, or null. */
  readLatest(documentId: string): Promise<PersonaVersion | null>;
  /** INSERTs a new version. NEVER updates. Returns what was written. */
  appendVersion(input: AppendPersonaVersionInput): Promise<PersonaVersion>;
};

async function selectRows(
  documentId: string
): Promise<PersonaDocumentRowLike[]> {
  return await db
    .select({
      id: document.id,
      createdAt: document.createdAt,
      title: document.title,
      content: document.content,
      kind: document.kind,
    })
    .from(document)
    .where(eq(document.id, documentId))
    .orderBy(asc(document.createdAt));
}

/**
 * The real store.
 *
 * `now` is injected so a test can drive the collision path deterministically,
 * and defaults to the wall clock. Every decision it makes about WHICH timestamp
 * to write lives in the pure `nextVersionCreatedAt`; this function only reads,
 * writes and retries.
 */
export function createPersonaStore({
  now = () => new Date(),
}: {
  now?: () => Date;
} = {}): PersonaStore {
  const listVersions = async (documentId: string) =>
    orderPersonaVersions(await selectRows(documentId));

  return {
    listVersions,

    readLatest: async (documentId: string) =>
      latestReadablePersona(await selectRows(documentId)),

    appendVersion: async (input: AppendPersonaVersionInput) => {
      let lastError: unknown;

      for (let attempt = 1; attempt <= MAX_APPEND_ATTEMPTS; attempt++) {
        const existing = await selectRows(input.documentId);
        const row = buildPersonaVersionRow({
          documentId: input.documentId,
          artifact: input.artifact,
          userId: input.userId,
          messageId: input.messageId ?? null,
          projectId: input.projectId ?? null,
          existingCreatedAt: existing.map((r) => r.createdAt),
          now: now(),
        });

        try {
          // INSERT, never upsert. The composite PK is what makes regeneration
          // accumulate; onConflictDoUpdate here would quietly delete history.
          await db.insert(document).values(row);
          return {
            version: existing.length + 1,
            documentId: row.id,
            createdAt: row.createdAt,
            title: row.title,
            artifact: input.artifact,
          };
        } catch (error) {
          if (!isUniqueViolation(error)) {
            throw error;
          }
          lastError = error;
          log.warn(
            { documentId: input.documentId, attempt },
            "persona version collided on (id, createdAt) — re-reading and retrying"
          );
        }
      }

      // Loud on purpose. A caller must not be told a version was written when it
      // was not: the founder would regenerate, see the old persona, and conclude
      // the model ignored them.
      log.error(
        { documentId: input.documentId, attempts: MAX_APPEND_ATTEMPTS },
        "persona version could not be written after repeated key collisions"
      );
      throw lastError;
    },
  };
}
