import type { ArtifactKind } from "@/lib/artifacts/artifact-kind";
import {
  PERSONA_ATTRIBUTE_KEYS,
  type Persona,
  type PersonaArtifact,
  PersonaArtifactSchema,
  type PersonaAttributeKey,
} from "./types";

/**
 * PERSONAS AS VERSIONED ARTIFACTS. Pure — no DB, no clock, no I/O. store.ts is
 * the one impure file that actually talks to Postgres.
 *
 * THE VERSIONING MECHANISM IS THE SCHEMA, NOT THIS CODE. `Document` has a
 * COMPOSITE PRIMARY KEY `(id, createdAt)` (lib/db/schema.ts). So:
 *
 *   - Regenerating a persona keeps the SAME `id` and uses a NEW `createdAt`,
 *     and the write is an INSERT. Versions accumulate. Nothing is overwritten.
 *   - There is no UPDATE path in this module, and there must never be one. An
 *     UPDATE would destroy the previous persona, and the previous persona is the
 *     evidence that the founder's understanding CHANGED — which is the single
 *     most useful thing an eight-phase workflow produces. A tool that silently
 *     replaces v1 with v2 cannot tell you that you quietly stopped believing in
 *     your first customer.
 *
 * The one thing the composite key does not do for free is protect against two
 * regenerations landing in the same millisecond — that is a PK collision and a
 * failed INSERT. `nextVersionCreatedAt` is the pure guard for it.
 */

/**
 * The `Document.kind` value persona rows are written with.
 *
 * Its own kind, not "text". A persona row's content is a JSON envelope, and an
 * artifact panel that believes it is text renders that envelope to the founder
 * verbatim. Storing JSON under "text" was a real hazard, not a cosmetic one.
 *
 * It is a single exported constant precisely so this is one line here and
 * nothing else in the module has to move.
 */
export const PERSONA_DOCUMENT_KIND: ArtifactKind = "persona";

/** Document.title is NOT NULL. Postgres text has no limit; readability does. */
export const MAX_TITLE_LENGTH = 200;

/**
 * The envelope written to `Document.content`.
 *
 * JSON rather than markdown because this artifact is READ BACK by code — the
 * canvas in step 7, the OASIS seeding in step 8, the handoff export in step 9 —
 * and re-parsing prose is how provenance gets lost. `renderPersonaMarkdown` in
 * prompt.ts is the human/LLM-facing projection.
 *
 * The `artifact: "persona"` discriminator is what makes a persona row
 * identifiable while it is still masquerading as `kind: "text"`.
 */
export type PersonaDocumentRowLike = {
  id: string;
  createdAt: Date;
  title: string;
  content: string | null;
  kind: string;
};

/** Exactly the columns an INSERT into `Document` needs. */
export type PersonaVersionRow = {
  id: string;
  createdAt: Date;
  title: string;
  content: string;
  kind: ArtifactKind;
  userId: string;
  /** NULLABLE since Document.messageId became nullable. */
  messageId: string | null;
  /** Scopes the persona to a project so it can be looked up without an id. */
  projectId: string | null;
};

/** PURE. */
export function serializePersonaArtifact(artifact: PersonaArtifact): string {
  return JSON.stringify(artifact);
}

/**
 * PURE. FAIL-CLOSED READ: returns null for anything that is not exactly a
 * current-version persona envelope.
 *
 * Null, not a partially-populated persona. A row written by an older content
 * version, or truncated, or hand-edited, has an UNKNOWN relationship to the
 * evidence it claims — and the whole product rests on that relationship. Showing
 * "this version can no longer be read" is honest; showing the fields that
 * happened to survive a schema change is a persona nobody wrote.
 */
export function parsePersonaArtifact(
  content: string | null
): PersonaArtifact | null {
  if (!content) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  const parsed = PersonaArtifactSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** PURE. Cheap discriminator for "is this Document row a persona?". */
export function isPersonaDocument(row: PersonaDocumentRowLike): boolean {
  return parsePersonaArtifact(row.content) !== null;
}

/** PURE. Document.title is NOT NULL, and this is what the sidebar shows. */
export function personaVersionTitle(persona: Persona, version: number): string {
  return `Persona: ${persona.label} (v${version})`.slice(0, MAX_TITLE_LENGTH);
}

/**
 * PURE. The timestamp the next version must be written with.
 *
 * `(id, createdAt)` is the primary key, so a second regeneration inside the same
 * millisecond — a double-click, a retry, two tabs — collides and the INSERT
 * fails. Nudging past the newest existing version by 1ms keeps the write
 * succeeding AND keeps `createdAt` a total order, which is what every
 * "which version is latest" query in the codebase depends on.
 *
 * Deliberately takes `now` as an argument: this module has no clock, so the same
 * inputs always produce the same output and the collision case is a plain unit
 * test rather than a flake.
 */
export function nextVersionCreatedAt(
  existing: readonly Date[],
  now: Date
): Date {
  let newest = Number.NEGATIVE_INFINITY;
  for (const date of existing) {
    newest = Math.max(newest, date.getTime());
  }
  if (!Number.isFinite(newest) || now.getTime() > newest) {
    return now;
  }
  return new Date(newest + 1);
}

/**
 * PURE. Builds the row for ONE new version.
 *
 * Note there is no `update` sibling and no `upsert` flag. Passing the same `id`
 * as an existing persona is not an edge case to guard against — it is the ONLY
 * correct way to add a version, and passing a fresh `id` starts a separate
 * persona whose history begins at v1.
 */
export function buildPersonaVersionRow({
  documentId,
  artifact,
  userId,
  messageId = null,
  projectId = null,
  existingCreatedAt,
  now,
}: {
  /** Reuse the existing persona's id to add a version; a new id starts a new one. */
  documentId: string;
  artifact: PersonaArtifact;
  userId: string;
  /**
   * The assistant message that triggered this regeneration, when there was
   * one. Null is normal: a persona is rebuilt from the fact store on demand.
   */
  messageId?: string | null;
  /** The project this persona belongs to. */
  projectId?: string | null;
  /** createdAt of every version already stored under `documentId`. */
  existingCreatedAt: readonly Date[];
  now: Date;
}): PersonaVersionRow {
  return {
    id: documentId,
    createdAt: nextVersionCreatedAt(existingCreatedAt, now),
    title: personaVersionTitle(artifact.persona, existingCreatedAt.length + 1),
    content: serializePersonaArtifact(artifact),
    kind: PERSONA_DOCUMENT_KIND,
    userId,
    messageId,
    projectId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the accumulated versions back.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHAT HAPPENED TO THE WRITE. Three states, deliberately not two.
 *
 * `version: PersonaVersion | null` collapsed two different facts about the
 * world into one null: "we chose not to persist this because it is degraded,
 * and it is not a finding" and "we tried to persist it and the database
 * refused". The second returned HTTP 200 with `degradedReasons: []`, so the
 * banner that exists to explain a degraded artifact never fired and the caller
 * had no way to know anything had gone wrong. A regenerate would then show the
 * OLD persona with no explanation.
 *
 * `reasons` is a non-empty tuple for the same reason `evidence[]` is: a
 * withheld persona with no stated reason is a compile error, not a runtime
 * surprise.
 */
export type PersonaPersistence =
  /** Written. This version is in the history. */
  | { status: "stored"; version: PersonaVersion }
  /** Degraded, so deliberately NOT written. Mirrors artifact.degradedReasons. */
  | { status: "withheld"; reasons: [string, ...string[]] }
  /** The write was ATTEMPTED and FAILED. The artifact is real; the history is not. */
  | { status: "write-failed"; reason: string };

/**
 * Keeps the Postgres error code, because "FK violation on messageId" and
 * "connection refused" need different fixes and both used to vanish into a
 * server log.
 */
export function describePersonaWriteFailure(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : null;
  const message = error instanceof Error ? error.message : String(error);
  return code
    ? `the persona was generated but could not be stored (postgres ${code}: ${message})`
    : `the persona was generated but could not be stored (${message})`;
}

export type PersonaVersion = {
  /** 1-based, assigned by createdAt order. v1 is the first thing ever written. */
  version: number;
  documentId: string;
  createdAt: Date;
  title: string;
  /** Null when the row could not be read — see parsePersonaArtifact. */
  artifact: PersonaArtifact | null;
};

/**
 * PURE. Oldest first, version numbers assigned by `createdAt`.
 *
 * UNREADABLE ROWS ARE KEPT, with `artifact: null`. Dropping them would renumber
 * every version after the bad one, so a founder's "v3" would silently become a
 * different document than the one they read last week. A visible hole is a bug
 * report; a renumbered history is a lie.
 *
 * Ties on `createdAt` cannot occur through this module (nextVersionCreatedAt
 * prevents them) and cannot occur in the table (they are the primary key), but
 * the comparison falls back to the title so the order is total for any input.
 */
export function orderPersonaVersions(
  rows: readonly PersonaDocumentRowLike[]
): PersonaVersion[] {
  return [...rows]
    .sort((a, b) => {
      const delta = a.createdAt.getTime() - b.createdAt.getTime();
      if (delta !== 0) {
        return delta;
      }
      return a.title.localeCompare(b.title);
    })
    .map((row, index) => ({
      version: index + 1,
      documentId: row.id,
      createdAt: row.createdAt,
      title: row.title,
      artifact: parsePersonaArtifact(row.content),
    }));
}

/** PURE. The newest version, readable or not. Null for no rows at all. */
export function latestPersonaVersion(
  rows: readonly PersonaDocumentRowLike[]
): PersonaVersion | null {
  const ordered = orderPersonaVersions(rows);
  return ordered.at(-1) ?? null;
}

/**
 * PURE. The newest version of EACH document in a mixed row set, in first-seen
 * document order.
 *
 * GROUPING FIRST IS THE POINT. `orderPersonaVersions` numbers versions by
 * position in the rows it is handed, so handing it rows from two documents
 * numbers them 1..n ACROSS both and a project's second persona reports itself as
 * "v4". Grouping keeps a version number the founder's version number. The
 * grouping by document id is done inline below. (It used to be done by a
 * `groupDocumentVersions` helper in `trpc/routers/canvas.router.ts`; that
 * router was deleted in c98d30a8 and this function is the only grouping left.)
 *
 * `latestPersonaVersion`, not `latestReadablePersona`: an unreadable newest
 * version must surface as a refusal, not be quietly replaced by an older
 * readable one. Simulating or exporting v2 while the founder is looking at v3 is
 * a lie about which persona was used.
 */
export function latestPersonaPerDocument(
  rows: readonly PersonaDocumentRowLike[]
): PersonaVersion[] {
  const groups = new Map<string, PersonaDocumentRowLike[]>();
  for (const row of rows) {
    const existing = groups.get(row.id);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(row.id, [row]);
    }
  }

  const out: PersonaVersion[] = [];
  for (const versions of groups.values()) {
    const latest = latestPersonaVersion(versions);
    if (latest) {
      out.push(latest);
    }
  }
  return out;
}

/**
 * PURE. The newest version that can actually be READ.
 *
 * Separate from `latestPersonaVersion` on purpose. Regeneration needs a persona
 * to revise, and revising against an unreadable row would mean revising against
 * nothing while believing otherwise — so the two questions ("what is newest" and
 * "what can I build on") get two functions and neither pretends to be the other.
 */
export function latestReadablePersona(
  rows: readonly PersonaDocumentRowLike[]
): PersonaVersion | null {
  const ordered = orderPersonaVersions(rows);
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (ordered[i].artifact) {
      return ordered[i];
    }
  }
  return null;
}

export type PersonaAttributeChange = {
  key: PersonaAttributeKey;
  from: string | null;
  to: string | null;
  /** True when the attribute LOST its evidence between versions. */
  regressed: boolean;
};

/**
 * PURE. What changed between two versions.
 *
 * `regressed` is the interesting half. Personas are supposed to get sharper, so
 * an attribute going from evidenced back to not-established is the signal a
 * founder most needs and least wants: something they believed has stopped being
 * supported. Accumulating versions is what makes that computable at all — with
 * an UPDATE-in-place table the previous value is simply gone.
 */
export function personaAttributeChanges(
  previous: Persona,
  next: Persona
): PersonaAttributeChange[] {
  const changes: PersonaAttributeChange[] = [];
  for (const key of PERSONA_ATTRIBUTE_KEYS) {
    const before = previous.attributes[key];
    const after = next.attributes[key];
    const from = before.status === "not-established" ? null : before.value;
    const to = after.status === "not-established" ? null : after.value;
    if (from === to) {
      continue;
    }
    changes.push({
      key,
      from,
      to,
      regressed: before.status === "evidenced" && after.status !== "evidenced",
    });
  }
  return changes;
}

export type PersonaVersionDiff = {
  /** The version this diff arrives AT. `from` is the one before it. */
  fromVersion: number;
  toVersion: number;
  changes: PersonaAttributeChange[];
};

/**
 * PURE. The whole change history of one persona document, oldest step first.
 *
 * WHY THE EXPORT WANTS THIS. The handoff used to ship only the newest version,
 * so a reader saw the founder's current belief and had no way to know it had
 * ever been anything else. That hides the most valuable thing an eight-phase
 * interview produces: not the persona, but the fact that the founder started
 * with one idea of their user and evidence moved them off it. "Age 30-40, uses
 * spreadsheets" becoming "45-55, uses QuickBooks" because interview three
 * contradicted the guess IS the work.
 *
 * UNREADABLE VERSIONS ARE SKIPPED, NOT GUESSED AT. A row that does not parse
 * cannot be diffed, so it contributes no step rather than a step against the
 * last readable one — which would attribute a change to the wrong version. The
 * gap is therefore visible in the version numbers: a jump from v2 to v4 says
 * v3 could not be read.
 *
 * A version that changed nothing produces an entry with an EMPTY `changes`
 * array rather than being dropped. "We regenerated and nothing moved" is a
 * result, and the caller decides whether to show it.
 */
export function personaVersionHistory(
  rows: readonly PersonaDocumentRowLike[]
): PersonaVersionDiff[] {
  const ordered = orderPersonaVersions(rows).filter(
    (v): v is PersonaVersion & { artifact: PersonaArtifact } =>
      v.artifact !== null
  );

  const diffs: PersonaVersionDiff[] = [];
  for (let i = 1; i < ordered.length; i++) {
    diffs.push({
      fromVersion: ordered[i - 1].version,
      toVersion: ordered[i].version,
      changes: personaAttributeChanges(
        ordered[i - 1].artifact.persona,
        ordered[i].artifact.persona
      ),
    });
  }
  return diffs;
}
