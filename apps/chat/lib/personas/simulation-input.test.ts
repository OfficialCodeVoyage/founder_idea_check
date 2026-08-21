import { describe, expect, it } from "vitest";
import type { PersonaVersion } from "./artifact";
import { describeSeedGap, type SimulationSeedGap } from "./simulation-gaps";
import {
  type SimulationProfileInput,
  toSimulationPersonas,
} from "./simulation-input";
import {
  PERSONA_ATTRIBUTE_KEYS,
  PERSONA_CONTENT_VERSION,
  type Persona,
  type PersonaArtifact,
} from "./types";

const AT = new Date("2026-08-01T00:00:00Z");

function evidence(quote: string) {
  return [
    { kind: "quote", quote, source: "Ops lead", when: null },
  ] as Persona["attributes"]["role"]["evidence"];
}

function attributes(role: unknown) {
  const base = Object.fromEntries(
    PERSONA_ATTRIBUTE_KEYS.map((key) => [
      key,
      {
        evidence: [],
        gap: `no ${key} recorded`,
        status: "not-established",
        value: null,
      },
    ])
  );
  return { ...base, role } as Persona["attributes"];
}

const EVIDENCED_ROLE = {
  evidence: evidence("I run payroll"),
  status: "evidenced",
  value: "In-house bookkeeper",
};

function version(over: {
  documentId?: string;
  role?: unknown;
  label?: string;
  artifact?: PersonaArtifact | null;
  title?: string;
}): PersonaVersion {
  const persona = {
    attributes: attributes(over.role ?? EVIDENCED_ROLE),
    excludedSegments: [],
    interviews: {
      count: 0,
      evidence: [],
      gap: "no interview count recorded",
      meetsFloor: false,
      status: "not-established",
    },
    label: over.label ?? "Bookkeeper at a small restaurant group",
    observableAttributes: [],
  } as unknown as Persona;

  return {
    artifact:
      over.artifact === null
        ? null
        : {
            artifact: "persona",
            contentVersion: PERSONA_CONTENT_VERSION,
            degradedReasons: [],
            droppedPinnedFactKeys: [],
            groundedInFactKeys: ["primary_persona"],
            persona,
          },
    createdAt: AT,
    documentId: over.documentId ?? "doc-1",
    title: over.title ?? "Persona: Bookkeeper (v1)",
    version: 1,
  };
}

function profile(
  over: Partial<SimulationProfileInput> = {}
): SimulationProfileInput {
  return {
    age: 44,
    country: "United States",
    gender: "female",
    handle: "Ana R",
    id: "seat-1",
    mbti: "ISTJ",
    personaDocumentId: "doc-1",
    ...over,
  };
}

function kinds(gaps: SimulationSeedGap[]): string[] {
  return gaps.map((gap) => gap.kind).sort();
}

describe("toSimulationPersonas — the population comes from seats, not ICPs", () => {
  it("builds one agent per SEAT over the one evidenced persona", () => {
    // The whole design: phase 3's single-beachhead criterion demands ONE
    // persona, toOasisPersonas refuses fewer than TWO agents. Several people
    // inside the one ICP is the only answer that contradicts neither.
    const result = toSimulationPersonas({
      profiles: [
        profile({ handle: "Ana R", id: "seat-1" }),
        profile({ handle: "Dev K", id: "seat-2", mbti: null }),
      ],
      versions: [version({})],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.personas).toHaveLength(2);
    expect(result.personas.map((p) => p.name)).toEqual(["Ana R", "Dev K"]);
    // The handle, not the label: the stored label is a 118-character sentence
    // that slugs to an unusable username, and every seat would slug the same.
    expect(result.personas[0].id).toBe("Ana R");
    expect(result.personas[0].headline).toBe("In-house bookkeeper");
    expect(result.personas[0].description).toContain("In-house bookkeeper");
  });

  it("does NOT let an empty mbti reach OASIS as an empty string", () => {
    // `""` is not null, so `?? UNSPECIFIED_MBTI` steps over it and the run
    // fails with "malformed on: mbti" — a field the form says to leave blank.
    const result = toSimulationPersonas({
      profiles: [
        profile({ mbti: "" }),
        profile({ handle: "Dev K", id: "s2", mbti: "  " }),
      ],
      versions: [version({})],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.personas[0].mbti).toBeUndefined();
    expect(result.personas[1].mbti).toBeUndefined();
  });

  it("marks an ASSUMED role as an assumption in the agent's own bio", () => {
    // personaSummary returns role.value for `assumed` too, and prompt.ts tags
    // assumed attributes with [Assumption]. Without the marker here, the
    // founder's labelled guess becomes the agent's flat statement of identity.
    const result = toSimulationPersonas({
      profiles: [profile()],
      versions: [
        version({
          role: {
            evidence: evidence("my guess after two calls"),
            status: "assumed",
            value: "Probably the office manager",
          },
        }),
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.personas[0].headline).toContain(
      "Probably the office manager"
    );
    expect(result.personas[0].headline).toContain("[Assumption");
  });
});

describe("toSimulationPersonas — every gap is named, none is skipped", () => {
  it("names a persona with no seat instead of running without it", () => {
    // Dropping it to get the remaining seats over the two-agent floor would
    // change the population without saying so.
    const result = toSimulationPersonas({
      profiles: [profile({ personaDocumentId: "doc-1" })],
      versions: [version({}), version({ documentId: "doc-2" })],
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(kinds(result.gaps)).toEqual(["no-profile"]);
    expect(describeSeedGap(result.gaps[0])).toContain(
      "has no simulation profile"
    );
  });

  it("names an unreadable newest version rather than simulating an older one", () => {
    const result = toSimulationPersonas({
      profiles: [profile()],
      versions: [version({ artifact: null })],
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(kinds(result.gaps)).toEqual(["unreadable-version"]);
  });

  it("names a seat pointing at a persona that no longer exists", () => {
    // No foreign key can cascade this: Document's PK is (id, createdAt).
    const result = toSimulationPersonas({
      profiles: [profile({ personaDocumentId: "deleted-doc" })],
      versions: [version({})],
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(kinds(result.gaps)).toEqual(["no-profile", "orphan-profile"]);
  });

  it("names a not-established role, and does not call it 'no evidenced role'", () => {
    // Renamed from `no-evidenced-role`: an ASSUMED role passes this check, so
    // the old name claimed a stricter rule than the code applies.
    const result = toSimulationPersonas({
      profiles: [profile()],
      versions: [
        version({
          role: {
            evidence: [],
            gap: "no role recorded",
            status: "not-established",
            value: null,
          },
        }),
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(kinds(result.gaps)).toEqual(["role-not-established"]);
    expect(describeSeedGap(result.gaps[0])).toContain("no established role");
  });

  it("reports EVERY gap, not the first one", () => {
    const result = toSimulationPersonas({
      profiles: [profile({ personaDocumentId: "gone" })],
      versions: [version({ artifact: null }), version({ documentId: "doc-2" })],
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(kinds(result.gaps)).toEqual([
      "no-profile",
      "orphan-profile",
      "unreadable-version",
    ]);
  });

  it("says nothing about the two-agent floor, which runSimulation owns", () => {
    // One seat over one readable persona is a COMPLETE seeding as far as this
    // function is concerned; `toOasisPersonas` refuses the floor before the
    // sidecar is called. Two guards for one rule is how they drift.
    const result = toSimulationPersonas({
      profiles: [profile()],
      versions: [version({})],
    });

    expect(result).toEqual({
      ok: true,
      personas: [
        {
          age: 44,
          country: "United States",
          description: expect.any(String),
          gender: "female",
          headline: "In-house bookkeeper",
          id: "Ana R",
          mbti: "ISTJ",
          name: "Ana R",
        },
      ],
    });
  });
});

describe("describeSeedGap", () => {
  it("gives every kind its own actionable sentence", () => {
    const sentences = [
      describeSeedGap({
        kind: "no-profile",
        personaDocumentId: "d",
        personaLabel: "Bookkeeper",
        title: "t",
      }),
      describeSeedGap({
        kind: "unreadable-version",
        personaDocumentId: "d",
        title: "Persona v3",
      }),
      describeSeedGap({
        kind: "role-not-established",
        personaDocumentId: "d",
        personaLabel: "Bookkeeper",
      }),
      describeSeedGap({
        handle: "Ana R",
        kind: "orphan-profile",
        personaDocumentId: "d",
        profileId: "p",
      }),
    ];

    expect(new Set(sentences).size).toBe(4);
    for (const sentence of sentences) {
      // Never "the simulation profile is incomplete": a refusal a founder
      // cannot act on is a failure wearing a message.
      expect(sentence.length).toBeGreaterThan(40);
    }
  });

  it("falls back to the stored title when the label cannot be read", () => {
    expect(
      describeSeedGap({
        kind: "no-profile",
        personaDocumentId: "d",
        personaLabel: null,
        title: "Persona: unreadable row",
      })
    ).toContain("Persona: unreadable row");
  });
});
