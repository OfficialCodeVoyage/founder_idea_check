import { describe, expect, it } from "vitest";
import {
  countPersonaEvidence,
  personaSummary,
  toCanvasPersonaInput,
} from "./canvas-input";
import type { Persona } from "./types";

/**
 * The regression these lock down: `loadProjectCanvas` and `canvas.getCanvas`
 * each had their own copy of this mapping and disagreed about every derived
 * field, so the same persona rendered differently depending on whether the page
 * was server-rendered or client-fetched.
 *
 * Both production mappers are module-private, so the agreement test at the
 * bottom asserts the delegation STRUCTURALLY: each read must import the shared
 * mapper and must not carry its own definition of either derived field. It is
 * the one that fails if either call site grows a private copy again.
 */

const EVIDENCE = [{ factKey: "f1", quote: "they said so" }] as const;

/** Top-level per lint/performance/useTopLevelRegex. */
const CALLS_SHARED_MAPPER = /toCanvasPersonaInput\s*\(/;
const OLD_OBSERVABLE_ONLY_COUNT = /observableAttributes\.reduce/;

function evidenced(value: string, count = 1) {
  return {
    status: "evidenced" as const,
    value,
    evidence: Array.from({ length: count }, (_, i) => ({
      factKey: `f${i}`,
      quote: `quote ${i}`,
    })) as unknown as typeof EVIDENCE,
  };
}

function persona(overrides: Partial<Persona> = {}): Persona {
  return {
    label: "Solo founder",
    attributes: {
      role: evidenced("Founder"),
      context: evidenced("Pre-seed"),
    },
    observableAttributes: [
      {
        dimension: "channel",
        value: "HN",
        evidence: evidenced("x", 2).evidence,
      },
    ],
    excludedSegments: [
      {
        segment: "Enterprise",
        reason: "no budget",
        evidence: evidenced("x").evidence,
      },
    ],
    interviews: evidenced("3 interviews", 3),
    ...overrides,
  } as unknown as Persona;
}

describe("countPersonaEvidence", () => {
  it("totals every evidence array, not just observable attributes", () => {
    // 3 interviews + 1 role + 1 context + 2 observable + 1 excluded = 8.
    // The old canvas-data.ts definition counted the 2 observable only.
    expect(countPersonaEvidence(persona())).toBe(8);
  });

  it("counts evidence on excluded segments and interviews", () => {
    const withoutExtras = persona({
      excludedSegments: [],
      interviews: evidenced("none", 0) as unknown as Persona["interviews"],
    });
    expect(countPersonaEvidence(withoutExtras)).toBe(4);
  });
});

describe("personaSummary", () => {
  it("uses the role attribute", () => {
    expect(personaSummary(persona())).toBe("Founder");
  });

  it("returns NULL rather than a guess when role is not established", () => {
    const p = persona({
      attributes: {
        role: { status: "not-established", value: null, evidence: [] },
        context: evidenced("Pre-seed"),
      } as unknown as Persona["attributes"],
    });
    expect(personaSummary(p)).toBeNull();
  });
});

describe("toCanvasPersonaInput", () => {
  it("maps a readable persona", () => {
    expect(
      toCanvasPersonaInput({
        documentId: "doc-1",
        title: "Stored title",
        persona: persona(),
        groundedInFactKeys: ["f1", "f2"],
      })
    ).toEqual({
      id: "doc-1",
      name: "Solo founder",
      summary: "Founder",
      evidenceCount: 8,
      derivedFromFactKeys: ["f1", "f2"],
    });
  });

  it("returns NULL evidenceCount for an unreadable row, never 0", () => {
    // 0 renders at-risk and blames the founder for a parse failure.
    const result = toCanvasPersonaInput({
      documentId: "doc-2",
      title: "Stored title",
      persona: null,
      groundedInFactKeys: [],
    });
    expect(result.evidenceCount).toBeNull();
    expect(result.evidenceCount).not.toBe(0);
    expect(result.name).toBe("Stored title");
    expect(result.summary).toBeNull();
  });

  it("falls back to the document id when there is no title either", () => {
    expect(
      toCanvasPersonaInput({
        documentId: "doc-3",
        title: null,
        persona: null,
        groundedInFactKeys: [],
      }).name
    ).toBe("doc-3");
  });
});

describe("the canvas read delegates to the shared mapper", () => {
  // This used to assert that TWO reads agreed. The second one,
  // `trpc/routers/canvas.router.ts`, was a mounted tRPC procedure with no
  // caller anywhere in the app and was deleted on 2026-08-21 — so the drift
  // this test was written to catch is now structurally impossible rather than
  // merely detected. The remaining assertion is the one that still has teeth:
  // the surviving read must DELEGATE and must not grow a private copy of
  // either derived field, which is exactly how the two numbers diverged the
  // first time.
  //
  // If a second canvas read is ever added, put it back in this list.
  const CALL_SITES = ["lib/project/canvas-data.ts"];

  it.each(CALL_SITES)("%s delegates to the shared mapper", async (relative) => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const source = readFileSync(
      path.resolve(import.meta.dirname, "../..", relative),
      "utf-8"
    );

    expect(source).toContain("@/lib/personas/canvas-input");
    // The CALL, not the import: matching the bare name would pass on an
    // unused import, which is precisely the state this test has to catch.
    expect(source).toMatch(CALLS_SHARED_MAPPER);

    // No private re-implementation of either derived field.
    expect(source).not.toContain("function countPersonaEvidence");
    expect(source).not.toContain("function personaSummary");
    // The specific old canvas-data.ts bug: totalling observable attributes only.
    expect(source).not.toMatch(OLD_OBSERVABLE_ONLY_COUNT);
  });
});
