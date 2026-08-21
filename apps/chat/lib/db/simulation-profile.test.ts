import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

/**
 * `schema.ts` reaches `@/lib/env` through `./encrypted-text`, which validates
 * the whole server env at module load. Mocked so this file can import the
 * schema at all — same reason phase-attempt.test.ts does it.
 */
vi.mock("@/lib/env", () => ({
  env: { ENCRYPTION_KEY: "0".repeat(64) },
}));

// biome-ignore lint/performance/noNamespaceImport: asserting that `projectPersona` is ABSENT from the module needs the namespace; tree shaking is irrelevant in a test.
import * as schema from "./schema";
import { simulationProfile } from "./schema";

/**
 * These read the actual drizzle table config rather than the source text, so
 * they fail if the CHECK constraints are dropped, if `age` becomes nullable, or
 * if the shadow table comes back.
 */
describe("SimulationProfile makes the dishonest states unrepresentable", () => {
  const config = getTableConfig(simulationProfile);
  const columns = new Map(config.columns.map((c) => [c.name, c]));

  it("has no honest placeholder for age, gender or country, so they are NOT NULL", () => {
    // OASIS validates age 13..120 and has no representation for "unknown".
    // A nullable age would mean inventing one downstream or refusing later,
    // and the founder is the only one who can answer it.
    for (const name of ["age", "gender", "country", "handle"]) {
      expect(columns.get(name)?.notNull, name).toBe(true);
    }
  });

  it("leaves mbti the ONE nullable field, because XXXX is a named non-answer", () => {
    expect(columns.get("mbti")?.notNull).toBe(false);
  });

  it("refuses an out-of-range age in the database, not only in zod", () => {
    const names = config.checks.map((c) => c.name);
    expect(names).toContain("SimulationProfile_age_range");
  });

  it("refuses whitespace-only text, which is the trap NULL checks miss", () => {
    // `mbti: ""` is not null, so every `?? UNSPECIFIED_MBTI` downstream steps
    // over it and it surfaces as an OasisPersonaSchema min(1) failure reported
    // as "malformed on: mbti" — a field the form says to leave blank.
    const names = config.checks.map((c) => c.name);
    expect(names).toContain("SimulationProfile_text_present");
  });

  it("keeps one handle per project, the cheap half of the collision guard", () => {
    // It does NOT subsume toOasisPersonas's refusal: "Ana R" and "ana-r" are
    // distinct here and both slug to "ana_r".
    const unique = config.indexes
      .filter((i) => i.config.unique)
      .map((i) => (i.config.columns as { name: string }[]).map((c) => c.name));
    expect(unique).toContainEqual(["projectId", "handle"]);
  });

  it("cascades from Project, so deleting a project takes its seats", () => {
    expect(
      config.foreignKeys.map((fk) => fk.reference().foreignTable)
    ).toContain(schema.project);
  });

  it("does NOT carry a foreign key to the persona Document", () => {
    // It cannot: Document's primary key is (id, createdAt), so `id` alone is
    // not unique, and referencing (id, createdAt) would pin ONE VERSION — a
    // seat belongs to the whole history. The cost is orphan seats, which
    // toSimulationPersonas names rather than skipping.
    const referenced = config.foreignKeys.map(
      (fk) => fk.reference().foreignTable
    );
    expect(referenced).not.toContain(schema.document);
  });
});

describe("the shadow table is gone", () => {
  it("has no ProjectPersona export left to read from by mistake", () => {
    // A plausible-looking empty table named ProjectPersona, sitting next to a
    // comment claiming it holds "the population an OASIS run is seeded with",
    // is what produced the "0 simulation personas" bug. It had one reader and,
    // in the whole history of the repo, no writer at all.
    expect("projectPersona" in schema).toBe(false);
  });
});
