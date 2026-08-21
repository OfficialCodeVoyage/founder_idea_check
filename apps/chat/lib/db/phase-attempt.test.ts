import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

/**
 * `schema.ts` reaches `@/lib/env` through `./encrypted-text`, which validates
 * the whole server env at module load. Mocked so this file can import the
 * schema at all — no other test in the repo imports it, which is why
 * fact-upsert.test.ts is written to avoid needing to.
 */
vi.mock("@/lib/env", () => ({
  env: { ENCRYPTION_KEY: "0".repeat(64) },
}));

import { projectPhase, projectPhaseAttempt } from "./schema";

/**
 * These assert that APPENDING IS STRUCTURALLY POSSIBLE, which is the thing the
 * defect made false.
 *
 * The old writer did `onConflictDoUpdate` against the unique index
 * `(projectId, phaseKey)` on `ProjectPhase`, so every gate verdict overwrote
 * the previous one and a founder's earlier refusals were unrecoverable. In this
 * product the refusals ARE the product, so the history is the evidence trail
 * the app exists to build.
 *
 * A source-text assertion would be worthless here — it would pass on an unused
 * import. These read the actual drizzle table config, so they fail if someone
 * puts a uniqueness constraint back on (projectId, phaseKey), or re-keys the
 * ledger on the mutable attempt counter.
 */
describe("ProjectPhaseAttempt is an append-only ledger", () => {
  const config = getTableConfig(projectPhaseAttempt);

  it("keys on the evaluation clock, not the mutable attempt ordinal", () => {
    // Keying on attemptNo would tie the ledger's identity to
    // ProjectPhase.attemptCount, a mutable column on an UPDATEd row. If that
    // counter ever regressed below max(attemptNo), the insert would collide,
    // roll back the enclosing transaction, fail to advance the counter, and
    // then collide identically forever — a permanent write outage that would
    // freeze a stale PASS the gate could never replace with a BLOCK.
    // `document` versions on (id, createdAt) for exactly this reason.
    const pk = config.primaryKeys[0];
    expect(pk).toBeDefined();
    expect(pk.columns.map((c) => c.name).sort()).toEqual([
      "evaluatedAt",
      "phaseKey",
      "projectId",
    ]);
  });

  it("has NO uniqueness on (projectId, phaseKey), so many rows per phase fit", () => {
    // This is the assertion that fails if the ledger is ever "simplified" back
    // into one-row-per-phase.
    const offenders = [
      ...config.uniqueConstraints.map((u) => u.columns.map((c) => c.name)),
      ...config.indexes
        .filter((i) => i.config.unique)
        .map((i) =>
          (i.config.columns as { name: string }[]).map((c) => c.name)
        ),
    ].filter(
      (cols) =>
        cols.length === 2 &&
        cols.includes("projectId") &&
        cols.includes("phaseKey")
    );

    expect(offenders).toEqual([]);
  });

  it("cannot store a verdict without its rationale", () => {
    // A refusal with no reason is not a record of anything.
    const byName = Object.fromEntries(config.columns.map((c) => [c.name, c]));
    expect(byName.decision.notNull).toBe(true);
    expect(byName.reason.notNull).toBe(true);
    expect(byName.evaluatedAt.notNull).toBe(true);
    // nextQuestion IS nullable: there is no next question on a PASS.
    expect(byName.nextQuestion.notNull).toBe(false);
  });

  it("leaves verdict as an unparsed json column", () => {
    // Repo posture: a json column is genuinely unknown on read and callers run
    // GateVerdictSchema.safeParse. Typing it would assert a shape the database
    // does not enforce.
    const verdict = config.columns.find((c) => c.name === "verdict");
    expect(verdict?.notNull).toBe(false);
    expect(verdict?.columnType).toBe("PgJson");
  });

  it("erases with its project", () => {
    // GDPR: history must not outlive the project it describes.
    const fk = config.foreignKeys[0];
    expect(fk).toBeDefined();
    expect(fk.onDelete).toBe("cascade");
  });

  it("still keeps ProjectPhase one-row-per-phase for the hot read", () => {
    // The current-state read must not have to scan history.
    const phaseConfig = getTableConfig(projectPhase);
    const unique = phaseConfig.indexes
      .filter((i) => i.config.unique)
      .map((i) => (i.config.columns as { name: string }[]).map((c) => c.name));
    expect(unique).toContainEqual(["projectId", "phaseKey"]);
  });
});
