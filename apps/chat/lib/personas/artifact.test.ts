import { describe, expect, it } from "vitest";
import {
  buildPersonaVersionRow,
  isPersonaDocument,
  latestPersonaVersion,
  latestReadablePersona,
  nextVersionCreatedAt,
  orderPersonaVersions,
  PERSONA_DOCUMENT_KIND,
  type PersonaDocumentRowLike,
  parsePersonaArtifact,
  personaAttributeChanges,
  personaVersionTitle,
  serializePersonaArtifact,
} from "./artifact";
import { personaArtifact } from "./generate";
import { emptyPersona, normalizePersona } from "./normalize";
import {
  PERSONA_CONTENT_VERSION,
  type Persona,
  type PersonaArtifact,
  PersonaDraftSchema,
} from "./types";

const DOC_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "user_1";
const MESSAGE_ID = "22222222-2222-2222-2222-222222222222";

function personaWithRole(value: string, kind = "quote"): Persona {
  return normalizePersona(
    PersonaDraftSchema.parse({
      label: "Ops lead",
      attributes: [
        {
          key: "role",
          value,
          evidence: [{ kind, quote: "I run delivery", source: "Ops lead" }],
        },
      ],
    })
  );
}

function artifactFor(persona: Persona): PersonaArtifact {
  return personaArtifact({
    persona,
    groundedInFactKeys: ["primary_persona"],
    droppedPinnedFactKeys: [],
    degradedReasons: [],
  });
}

function row(
  createdAt: string,
  content: string | null,
  title = "Persona"
): PersonaDocumentRowLike {
  return {
    id: DOC_ID,
    createdAt: new Date(createdAt),
    title,
    content,
    kind: PERSONA_DOCUMENT_KIND,
  };
}

describe("serialize / parse — a fail-closed read", () => {
  it("round-trips an artifact", () => {
    const artifact = artifactFor(personaWithRole("Operations lead"));
    const parsed = parsePersonaArtifact(serializePersonaArtifact(artifact));
    expect(parsed).toEqual(artifact);
  });

  it("returns null for a null column", () => {
    expect(parsePersonaArtifact(null)).toBeNull();
  });

  it("returns null for content that is not JSON", () => {
    expect(parsePersonaArtifact("Hello, I am a text artifact.")).toBeNull();
  });

  it("returns null for JSON that is some other artifact", () => {
    expect(parsePersonaArtifact('{"artifact":"task","title":"x"}')).toBeNull();
  });

  it("returns null — not a partial persona — for a future content version", () => {
    const artifact = artifactFor(personaWithRole("Operations lead"));
    const bumped = JSON.stringify({
      ...artifact,
      contentVersion: PERSONA_CONTENT_VERSION + 1,
    });
    expect(parsePersonaArtifact(bumped)).toBeNull();
  });

  it("returns null for an envelope whose persona smuggles in an unevidenced claim", () => {
    const smuggled = JSON.stringify({
      artifact: "persona",
      contentVersion: PERSONA_CONTENT_VERSION,
      persona: {
        label: "Ops lead",
        attributes: { role: { status: "evidenced", value: "x", evidence: [] } },
        observableAttributes: [],
        excludedSegments: [],
        interviews: {
          status: "not-established",
          count: 0,
          meetsFloor: false,
          gap: "none",
          evidence: [],
        },
      },
      groundedInFactKeys: [],
      droppedPinnedFactKeys: [],
      degradedReasons: [],
    });
    expect(parsePersonaArtifact(smuggled)).toBeNull();
  });

  it("identifies a persona row while it is still stored as kind text", () => {
    const artifact = artifactFor(personaWithRole("Operations lead"));
    expect(
      isPersonaDocument(
        row("2026-08-01T00:00:00Z", serializePersonaArtifact(artifact))
      )
    ).toBe(true);
    expect(isPersonaDocument(row("2026-08-01T00:00:00Z", "plain text"))).toBe(
      false
    );
  });
});

describe("nextVersionCreatedAt — the composite primary key guard", () => {
  it("uses the clock when it is ahead of every stored version", () => {
    const now = new Date("2026-08-02T00:00:00Z");
    expect(
      nextVersionCreatedAt([new Date("2026-08-01T00:00:00Z")], now)
    ).toEqual(now);
  });

  it("uses the clock when there are no versions yet", () => {
    const now = new Date("2026-08-02T00:00:00Z");
    expect(nextVersionCreatedAt([], now)).toEqual(now);
  });

  it("steps past a collision so a double-click makes v2 instead of failing", () => {
    const now = new Date("2026-08-02T00:00:00.000Z");
    const next = nextVersionCreatedAt([now], now);
    expect(next.getTime()).toBe(now.getTime() + 1);
  });

  it("steps past the NEWEST version, not merely the last one listed", () => {
    const now = new Date("2026-08-01T00:00:00.000Z");
    const next = nextVersionCreatedAt(
      [new Date("2026-08-03T00:00:00.000Z"), new Date("2026-08-02T00:00:00Z")],
      now
    );
    expect(next.toISOString()).toBe("2026-08-03T00:00:00.001Z");
  });
});

describe("buildPersonaVersionRow — regeneration accumulates", () => {
  const artifact = artifactFor(personaWithRole("Operations lead"));

  it("reuses the document id so versions share a history", () => {
    const built = buildPersonaVersionRow({
      documentId: DOC_ID,
      artifact,
      userId: USER_ID,
      messageId: MESSAGE_ID,
      existingCreatedAt: [new Date("2026-08-01T00:00:00Z")],
      now: new Date("2026-08-02T00:00:00Z"),
    });

    expect(built.id).toBe(DOC_ID);
    expect(built.createdAt.toISOString()).toBe("2026-08-02T00:00:00.000Z");
  });

  it("numbers the title from the count of versions already stored", () => {
    const built = buildPersonaVersionRow({
      documentId: DOC_ID,
      artifact,
      userId: USER_ID,
      messageId: MESSAGE_ID,
      existingCreatedAt: [
        new Date("2026-08-01T00:00:00Z"),
        new Date("2026-08-01T01:00:00Z"),
      ],
      now: new Date("2026-08-02T00:00:00Z"),
    });

    expect(built.title).toBe("Persona: Ops lead (v3)");
  });

  it("writes a content envelope that parses back to the same artifact", () => {
    const built = buildPersonaVersionRow({
      documentId: DOC_ID,
      artifact,
      userId: USER_ID,
      messageId: MESSAGE_ID,
      existingCreatedAt: [],
      now: new Date("2026-08-02T00:00:00Z"),
    });

    expect(parsePersonaArtifact(built.content)).toEqual(artifact);
    expect(built.kind).toBe(PERSONA_DOCUMENT_KIND);
  });

  it("caps the title so a long label cannot produce an unreadable row", () => {
    const long = personaWithRole("Operations lead");
    const built = personaVersionTitle({ ...long, label: "L".repeat(500) }, 2);
    expect(built.length).toBeLessThanOrEqual(200);
  });
});

describe("orderPersonaVersions — a visible hole beats a renumbered history", () => {
  const good = serializePersonaArtifact(
    artifactFor(personaWithRole("Operations lead"))
  );

  it("numbers versions oldest-first by createdAt regardless of input order", () => {
    const versions = orderPersonaVersions([
      row("2026-08-03T00:00:00Z", good, "c"),
      row("2026-08-01T00:00:00Z", good, "a"),
      row("2026-08-02T00:00:00Z", good, "b"),
    ]);

    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(versions.map((v) => v.title)).toEqual(["a", "b", "c"]);
  });

  it("KEEPS an unreadable row so later versions are not renumbered", () => {
    const versions = orderPersonaVersions([
      row("2026-08-01T00:00:00Z", good, "a"),
      row("2026-08-02T00:00:00Z", "corrupted", "b"),
      row("2026-08-03T00:00:00Z", good, "c"),
    ]);

    expect(versions).toHaveLength(3);
    expect(versions[1].artifact).toBeNull();
    expect(versions[2].version).toBe(3);
  });

  it("returns null for a persona with no versions at all", () => {
    expect(latestPersonaVersion([])).toBeNull();
    expect(latestReadablePersona([])).toBeNull();
  });

  it("distinguishes the newest version from the newest READABLE one", () => {
    const rows = [
      row("2026-08-01T00:00:00Z", good, "a"),
      row("2026-08-02T00:00:00Z", "corrupted", "b"),
    ];

    expect(latestPersonaVersion(rows)?.version).toBe(2);
    expect(latestPersonaVersion(rows)?.artifact).toBeNull();
    expect(latestReadablePersona(rows)?.version).toBe(1);
  });
});

describe("personaAttributeChanges — what accumulating versions buys you", () => {
  it("reports nothing for two identical versions", () => {
    const persona = personaWithRole("Operations lead");
    expect(personaAttributeChanges(persona, persona)).toEqual([]);
  });

  it("reports a revision", () => {
    const changes = personaAttributeChanges(
      personaWithRole("Operations lead"),
      personaWithRole("Delivery lead")
    );

    expect(changes).toEqual([
      {
        key: "role",
        from: "Operations lead",
        to: "Delivery lead",
        regressed: false,
      },
    ]);
  });

  it("flags an attribute that LOST its evidence as a regression", () => {
    const changes = personaAttributeChanges(
      personaWithRole("Operations lead"),
      emptyPersona("the founder retracted the interview")
    );

    const role = changes.find((c) => c.key === "role");
    expect(role?.to).toBeNull();
    expect(role?.regressed).toBe(true);
  });

  it("flags a downgrade from evidenced to [Assumption] as a regression", () => {
    const changes = personaAttributeChanges(
      personaWithRole("Operations lead"),
      personaWithRole("Delivery lead", "assumption")
    );

    expect(changes.find((c) => c.key === "role")?.regressed).toBe(true);
  });
});
