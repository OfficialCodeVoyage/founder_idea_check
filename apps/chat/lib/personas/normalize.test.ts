import { describe, expect, it } from "vitest";
import {
  ASSERTED_WITHOUT_EVIDENCE,
  assessPersonaReadiness,
  CONFLICTING_VALUES,
  canonicalAttributeKey,
  emptyPersona,
  MAX_EVIDENCE_PER_FIELD,
  MAX_QUOTE_LENGTH,
  normalizeAttribute,
  normalizeAttributes,
  normalizeEvidenceList,
  normalizeExcludedSegments,
  normalizeInterviews,
  normalizeObservableAttributes,
  normalizePersona,
  personaAttributeEntries,
  resolveAttribute,
  TRUNCATION_MARKER,
  UNNAMED_PERSONA_LABEL,
} from "./normalize";
import {
  type DraftAttribute,
  type DraftEvidence,
  type DraftExcludedSegment,
  type DraftObservableAttribute,
  MIN_OBSERVABLE_ATTRIBUTES,
  PERSONA_ATTRIBUTE_KEYS,
  PERSONA_INTERVIEW_FLOOR,
  PersonaAttributeSchema,
  type PersonaDraft,
  PersonaDraftSchema,
  PersonaSchema,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures. Every one of these is a plain object — no model, no key, no DB.
// ─────────────────────────────────────────────────────────────────────────────

function ev(overrides: Partial<DraftEvidence> = {}): DraftEvidence {
  return {
    kind: "quote",
    quote: "we lose about two hours every week to it",
    source: "Ops lead, Acme",
    when: null,
    ...overrides,
  };
}

function attr(
  key: string,
  value: string,
  evidence: DraftEvidence[] = [ev()]
): DraftAttribute {
  return { key, value, evidence, gap: null };
}

function observable(
  dimension: string,
  value: string,
  evidence: DraftEvidence[] = [ev()]
): DraftObservableAttribute {
  return { dimension, value, evidence };
}

function segment(
  name: string,
  reason: string,
  evidence: DraftEvidence[] = [ev({ kind: "assumption" })]
): DraftExcludedSegment {
  return { segment: name, reason, evidence };
}

function draft(overrides: Partial<PersonaDraft> = {}): PersonaDraft {
  return PersonaDraftSchema.parse(overrides);
}

/** A persona that clears every BLOCKING phase-3 structural check. */
function completeDraft(): PersonaDraft {
  return draft({
    label: "Ops lead at a 20-person agency",
    attributes: [
      attr("role", "Operations lead"),
      attr("context", "Runs delivery at a 20-person creative agency"),
      attr("trigger-event", "A client invoice went out twice in March"),
      attr("current-stack", "Two spreadsheets and a Slack channel"),
      attr("buying-process", "Ops lead chooses, founder pays, finance vetoes"),
      attr("budget-owner", "The founder; spoken to twice"),
      attr("reachable-where", "The Agency Ops Slack community"),
    ],
    observableAttributes: [
      observable("team size", "15-30 people"),
      observable("tool already in use", "Harvest"),
    ],
    excludedSegments: [segment("Enterprise agencies", "Sales cycle too long")],
    interviewCount: PERSONA_INTERVIEW_FLOOR,
    interviewEvidence: Array.from({ length: PERSONA_INTERVIEW_FLOOR }, (_, i) =>
      ev({ quote: `interview ${i} notes`, source: `Ops lead ${i}` })
    ),
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeEvidenceList — what counts as a source", () => {
  it("drops an item with no words", () => {
    expect(normalizeEvidenceList([ev({ quote: "   " })])).toEqual([]);
  });

  it("drops an item with no source", () => {
    expect(normalizeEvidenceList([ev({ source: "" })])).toEqual([]);
  });

  it("collapses the same quote from the same source into one item", () => {
    // Three mentions of one interview must never read as three interviews.
    const kept = normalizeEvidenceList([ev(), ev(), ev()]);
    expect(kept).toHaveLength(1);
  });

  it("keeps the same quote from two different sources", () => {
    const kept = normalizeEvidenceList([
      ev({ source: "Ops lead, Acme" }),
      ev({ source: "Ops lead, Beta" }),
    ]);
    expect(kept).toHaveLength(2);
  });

  it("caps the number of items it will keep", () => {
    const many = Array.from({ length: MAX_EVIDENCE_PER_FIELD + 5 }, (_, i) =>
      ev({ source: `Person ${i}` })
    );
    expect(normalizeEvidenceList(many)).toHaveLength(MAX_EVIDENCE_PER_FIELD);
  });

  it("marks a truncated quote visibly rather than silently misquoting", () => {
    const [item] = normalizeEvidenceList([ev({ quote: "x".repeat(5000) })]);
    expect(item.quote.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(item.quote.length).toBe(MAX_QUOTE_LENGTH + TRUNCATION_MARKER.length);
  });

  it("normalizes a blank `when` to null rather than an empty string", () => {
    const [item] = normalizeEvidenceList([ev({ when: "  " })]);
    expect(item.when).toBeNull();
  });
});

describe("normalizeAttribute — no evidence, no claim", () => {
  it("DISCARDS a value that cites nothing", () => {
    const result = normalizeAttribute(attr("role", "Operations lead", []));

    expect(result.status).toBe("not-established");
    expect(result.value).toBeNull();
    expect(result).toMatchObject({ gap: ASSERTED_WITHOUT_EVIDENCE });
  });

  it("does not echo the discarded value back into the gap", () => {
    const result = normalizeAttribute(
      attr("role", "Chief Fabrication Officer", [])
    );
    expect(JSON.stringify(result)).not.toContain("Fabrication");
  });

  it("marks a value backed only by stated guesses as assumed", () => {
    const result = normalizeAttribute(
      attr("role", "Operations lead", [ev({ kind: "assumption" })])
    );
    expect(result.status).toBe("assumed");
  });

  it("marks a value backed by one real quote as evidenced, even alongside a guess", () => {
    const result = normalizeAttribute(
      attr("role", "Operations lead", [
        ev({ kind: "assumption", source: "founder" }),
        ev({ kind: "quote", source: "Ops lead, Acme" }),
      ])
    );
    expect(result.status).toBe("evidenced");
  });

  it("prefers the model's own gap sentence when there is no value", () => {
    const result = normalizeAttribute({
      key: "budget-owner",
      value: "",
      evidence: [],
      gap: "nobody has named who signs off spend",
    });
    expect(result).toMatchObject({
      status: "not-established",
      gap: "nobody has named who signs off spend",
    });
  });
});

describe("resolveAttribute — an ambiguous answer is an unknown answer", () => {
  it("refuses to pick between two different values", () => {
    const result = resolveAttribute([
      attr("role", "Operations lead"),
      attr("role", "Finance director"),
    ]);
    expect(result).toMatchObject({
      status: "not-established",
      gap: CONFLICTING_VALUES,
    });
  });

  it("treats the same value stated twice as one answer", () => {
    const result = resolveAttribute([
      attr("role", "Operations lead"),
      attr("role", "operations   lead"),
    ]);
    expect(result.status).toBe("evidenced");
  });

  it("returns not-established for no drafts at all", () => {
    expect(resolveAttribute([]).status).toBe("not-established");
  });
});

describe("canonicalAttributeKey — a closed vocabulary", () => {
  it("accepts the snake_case spelling the fact block teaches the model", () => {
    expect(canonicalAttributeKey("trigger_event")).toBe("trigger-event");
  });

  it("is case-insensitive and whitespace tolerant", () => {
    expect(canonicalAttributeKey("  Budget-Owner ")).toBe("budget-owner");
  });

  it("discards an invented key", () => {
    expect(canonicalAttributeKey("favourite_colour")).toBeNull();
  });
});

describe("normalizeAttributes — total coverage of the vocabulary", () => {
  it("returns every key even when the model returned none", () => {
    const attributes = normalizeAttributes([]);
    expect(Object.keys(attributes).sort()).toEqual(
      [...PERSONA_ATTRIBUTE_KEYS].sort()
    );
    for (const key of PERSONA_ATTRIBUTE_KEYS) {
      expect(attributes[key].status).toBe("not-established");
    }
  });

  it("discards attributes outside the vocabulary", () => {
    const attributes = normalizeAttributes([
      attr("role", "Operations lead"),
      attr("astrological_sign", "Capricorn"),
    ]);
    expect(Object.keys(attributes)).not.toContain("astrological_sign");
    expect(attributes.role.status).toBe("evidenced");
  });
});

describe("normalizeObservableAttributes", () => {
  it("drops a trait with no evidence", () => {
    expect(
      normalizeObservableAttributes([observable("team size", "15-30", [])])
    ).toEqual([]);
  });

  it("counts two rows on the same dimension as one filter", () => {
    const kept = normalizeObservableAttributes([
      observable("team size", "15-30"),
      observable("Team Size", "20-40"),
    ]);
    expect(kept).toHaveLength(1);
  });
});

describe("normalizeExcludedSegments", () => {
  it("drops a deprioritisation with no reason", () => {
    expect(normalizeExcludedSegments([segment("Enterprise", "")])).toEqual([]);
  });

  it("drops a deprioritisation with no evidence", () => {
    expect(
      normalizeExcludedSegments([segment("Enterprise", "too slow", [])])
    ).toEqual([]);
  });

  it("accepts the founder's own stated reasoning as evidence", () => {
    const kept = normalizeExcludedSegments([
      segment("Enterprise", "sales cycle too long", [
        ev({ kind: "assumption" }),
      ]),
    ]);
    expect(kept).toHaveLength(1);
  });
});

describe("normalizeInterviews — a count needs people behind it", () => {
  it("refuses a large count with no evidence", () => {
    const result = normalizeInterviews(40, []);
    expect(result).toMatchObject({ status: "not-established", count: 0 });
  });

  it("rounds a fractional count DOWN, so a near-miss stays a miss", () => {
    const evidence = Array.from({ length: PERSONA_INTERVIEW_FLOOR }, (_, i) =>
      ev({ source: `Person ${i}` })
    );
    const result = normalizeInterviews(PERSONA_INTERVIEW_FLOOR - 0.5, evidence);
    expect(result.count).toBe(PERSONA_INTERVIEW_FLOOR - 1);
    expect(result.meetsFloor).toBe(false);
  });

  it("meets the floor at exactly the floor", () => {
    const evidence = Array.from({ length: PERSONA_INTERVIEW_FLOOR }, (_, i) =>
      ev({ source: `Person ${i}` })
    );
    const result = normalizeInterviews(PERSONA_INTERVIEW_FLOOR, evidence);
    expect(result).toMatchObject({ status: "counted", meetsFloor: true });
  });

  it("refuses a negative count", () => {
    expect(normalizeInterviews(-3, [ev()]).status).toBe("not-established");
  });

  it("refuses a count that is not a usable number", () => {
    expect(normalizeInterviews(Number.NaN, [ev()]).status).toBe(
      "not-established"
    );
  });
});

describe("normalizePersona", () => {
  it("falls back to a neutral label rather than inventing a name", () => {
    expect(normalizePersona(draft()).label).toBe(UNNAMED_PERSONA_LABEL);
  });

  it("produces a persona that satisfies the STRICT stored schema", () => {
    expect(
      PersonaSchema.safeParse(normalizePersona(completeDraft())).success
    ).toBe(true);
  });

  it("produces a schema-valid persona from deliberate garbage", () => {
    // The whole fail-closed contract in one assertion: any draft the lenient
    // schema accepts must normalize into something the strict schema accepts.
    const garbage = draft({
      label: "   ",
      attributes: [
        attr("role", "invented", []),
        attr("nonsense", "also invented"),
        attr("role", "contradictory"),
      ],
      observableAttributes: [observable("", "", [])],
      excludedSegments: [segment("", "")],
      interviewCount: -1,
      interviewEvidence: [ev({ quote: "", source: "" })],
    });
    expect(PersonaSchema.safeParse(normalizePersona(garbage)).success).toBe(
      true
    );
  });
});

describe("emptyPersona — the fail-closed artifact", () => {
  it("establishes nothing at all", () => {
    const persona = emptyPersona("the generator call failed");
    for (const { attribute } of personaAttributeEntries(persona)) {
      expect(attribute.status).toBe("not-established");
      expect(attribute.value).toBeNull();
    }
    expect(persona.interviews.status).toBe("not-established");
    expect(persona.observableAttributes).toEqual([]);
  });

  it("is still a valid stored persona", () => {
    expect(PersonaSchema.safeParse(emptyPersona("no facts")).success).toBe(
      true
    );
  });
});

describe("the schema itself refuses an unevidenced claim at runtime", () => {
  it("rejects an evidenced attribute with an empty evidence array", () => {
    const result = PersonaAttributeSchema.safeParse({
      status: "evidenced",
      value: "Operations lead",
      evidence: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a not-established attribute that smuggles in a value", () => {
    const result = PersonaAttributeSchema.safeParse({
      status: "not-established",
      value: "Operations lead",
      gap: "nobody said this",
      evidence: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("assessPersonaReadiness — a structural self-check, not a verdict", () => {
  it("reports an empty persona as structurally incomplete with named gaps", () => {
    const readiness = assessPersonaReadiness(emptyPersona("nothing yet"));
    expect(readiness.structurallyComplete).toBe(false);
    expect(readiness.missing.length).toBeGreaterThan(0);
  });

  it("does not let [Assumption] satisfy a BLOCKING criterion", () => {
    const persona = normalizePersona(
      draft({
        ...completeDraft(),
        attributes: [
          attr("role", "Operations lead"),
          attr("context", "20-person agency"),
          attr("trigger-event", "an invoice went out twice", [
            ev({ kind: "assumption" }),
          ]),
          attr("current-stack", "spreadsheets"),
          attr("buying-process", "ops chooses, founder pays"),
          attr("budget-owner", "the founder"),
          attr("reachable-where", "Agency Ops Slack"),
        ],
      })
    );
    const readiness = assessPersonaReadiness(persona);
    const trigger = readiness.checks.find(
      (c) => c.criterionId === "trigger-event"
    );
    expect(trigger?.satisfied).toBe(false);
    expect(trigger?.gap).toContain("[Assumption]");
  });

  it("requires at least the minimum number of filterable attributes", () => {
    const persona = normalizePersona(
      draft({
        ...completeDraft(),
        observableAttributes: [observable("team size", "15-30")],
      })
    );
    const primary = assessPersonaReadiness(persona).checks.find(
      (c) => c.criterionId === "primary-persona"
    );
    expect(MIN_OBSERVABLE_ATTRIBUTES).toBeGreaterThan(1);
    expect(primary?.satisfied).toBe(false);
  });

  it("blocks when no other segment was deprioritised, so no beachhead was chosen", () => {
    const persona = normalizePersona(
      draft({ ...completeDraft(), excludedSegments: [] })
    );
    const readiness = assessPersonaReadiness(persona);
    expect(readiness.structurallyComplete).toBe(false);
    expect(
      readiness.checks.find((c) => c.criterionId === "single-beachhead")
        ?.satisfied
    ).toBe(false);
  });

  it("blocks below the interview floor", () => {
    const persona = normalizePersona(
      draft({
        ...completeDraft(),
        interviewCount: PERSONA_INTERVIEW_FLOOR - 1,
        interviewEvidence: Array.from(
          { length: PERSONA_INTERVIEW_FLOOR - 1 },
          (_, i) => ev({ source: `Person ${i}` })
        ),
      })
    );
    expect(assessPersonaReadiness(persona).structurallyComplete).toBe(false);
  });

  it("reports a fully evidenced persona as structurally complete", () => {
    const readiness = assessPersonaReadiness(normalizePersona(completeDraft()));
    expect(readiness.missing).toEqual([]);
    expect(readiness.structurallyComplete).toBe(true);
  });
});
