import { describe, expect, it } from "vitest";
import type { StoredFact } from "@/lib/phases/context";
import { PHASE_THREE } from "@/lib/phases/definitions-discovery";
import { DOCUMENT_MARKER_NOTE } from "@/lib/phases/gate";
import { EMPTY_FACT_STORE, emptyPersona, normalizePersona } from "./normalize";
import {
  type BuildPersonaPromptInput,
  buildPersonaPrompt,
  renderPersonaMarkdown,
} from "./prompt";
import {
  PERSONA_ATTRIBUTE_KEYS,
  PERSONA_INTERVIEW_FLOOR,
  PersonaDraftSchema,
} from "./types";

const AT = new Date("2026-08-01T00:00:00.000Z");

function fact(key: string, value: string, confidence = 80): StoredFact {
  return { key, value, confidence, updatedAt: AT, phaseKey: PHASE_THREE.key };
}

function input(
  overrides: Partial<BuildPersonaPromptInput> = {}
): BuildPersonaPromptInput {
  return {
    personaPrompt: "PERSONA BRIEF",
    phasePrompt: "PHASE 3 BRIEF",
    facts: [fact("primary_persona", "operations leads at small agencies")],
    ...overrides,
  };
}

describe("buildPersonaPrompt — the refusal", () => {
  it("REFUSES to generate a persona from an empty fact store", () => {
    const build = buildPersonaPrompt(input({ facts: [] }));

    expect(build.refusals).toContain(EMPTY_FACT_STORE);
    expect(build.groundedInFactKeys).toEqual([]);
  });

  it("uses phase 3's own minFactsRequired rather than a second number", () => {
    // If this ever stops holding, the gate and the generator have drifted and a
    // persona can be produced from a store the gate would BLOCK on.
    expect(PHASE_THREE.gate.minFactsRequired).toBeGreaterThan(0);
    const justEnough = Array.from(
      { length: PHASE_THREE.gate.minFactsRequired },
      (_, i) => fact(`primary_persona${i}`, `value ${i}`)
    );
    expect(buildPersonaPrompt(input({ facts: justEnough })).refusals).toEqual(
      []
    );
  });
});

describe("buildPersonaPrompt — grounding", () => {
  it("puts the established facts in front of the model", () => {
    const build = buildPersonaPrompt(
      input({
        facts: [fact("primary_persona", "operations leads at small agencies")],
      })
    );

    expect(build.request.prompt).toContain(
      "operations leads at small agencies"
    );
    expect(build.groundedInFactKeys).toEqual(["primary_persona"]);
  });

  it("names the phase-3 fact keys that are missing from the store entirely", () => {
    const build = buildPersonaPrompt(input());

    // budget_owner is named by a BLOCKING criterion and is not in the store.
    expect(build.missingPinnedFactKeys).toContain("budget_owner");
    expect(build.missingPinnedFactKeys).not.toContain("primary_persona");
  });

  it("reports a pinned fact the token budget evicted, without refusing", () => {
    const build = buildPersonaPrompt(
      input({
        facts: [
          fact("primary_persona", "x".repeat(400)),
          fact("excluded_segments", "no"),
        ],
        factBudgetTokens: 20,
      })
    );

    expect(build.droppedPinnedFactKeys).toEqual(["primary_persona"]);
    expect(build.groundedInFactKeys).toEqual(["excluded_segments"]);
    expect(build.refusals).toEqual([]);
  });

  it("says out loud when the transcript was trimmed", () => {
    const turns = Array.from({ length: 40 }, (_, i) => ({
      role: "user" as const,
      text: `turn ${i} ${"y".repeat(200)}`,
    }));
    const build = buildPersonaPrompt(
      input({ transcript: turns, transcriptBudgetTokens: 200 })
    );

    expect(build.request.prompt).toContain("were dropped for budget");
  });
});

describe("buildPersonaPrompt — the system prompt", () => {
  it("names every attribute in the closed vocabulary", () => {
    const { system } = buildPersonaPrompt(input()).request;
    for (const key of PERSONA_ATTRIBUTE_KEYS) {
      expect(system).toContain(key);
    }
  });

  it("tells the model the honest escape hatch instead of only forbidding invention", () => {
    const { system } = buildPersonaPrompt(input()).request;
    expect(system).toContain("EMPTY evidence array");
    expect(system).toContain("not established");
  });

  it("states the interview floor as a floor, not a target", () => {
    const { system } = buildPersonaPrompt(input()).request;
    expect(system).toContain(String(PERSONA_INTERVIEW_FLOOR));
    expect(system).toContain("Do not round up to it");
  });

  it("carries the persona and phase briefs through", () => {
    const { system } = buildPersonaPrompt(input()).request;
    expect(system).toContain("PERSONA BRIEF");
    expect(system).toContain("PHASE 3 BRIEF");
  });

  it("tells the model a document marker is not founder evidence", () => {
    // The transcript carries runtime.ts::toTranscript's document markers; an
    // assistant-written document must not source a persona attribute.
    const { system } = buildPersonaPrompt(input()).request;
    expect(system).toContain(DOCUMENT_MARKER_NOTE);
  });

  it("drops an empty brief instead of emitting a stray separator", () => {
    const { system } = buildPersonaPrompt(
      input({ personaPrompt: "", phasePrompt: "" })
    ).request;
    expect(system.startsWith("# Your job right now")).toBe(true);
  });

  it("lists the exit criteria the persona has to satisfy", () => {
    const { prompt } = buildPersonaPrompt(input()).request;
    for (const criterion of PHASE_THREE.exitCriteria) {
      expect(prompt).toContain(criterion.id);
    }
  });
});

describe("buildPersonaPrompt — regeneration", () => {
  it("shows the previous version so the pass is a revision, not a reroll", () => {
    const previous = normalizePersona(
      PersonaDraftSchema.parse({
        label: "Ops lead at a 20-person agency",
        attributes: [
          {
            key: "role",
            value: "Operations lead",
            evidence: [
              { kind: "quote", quote: "I run delivery", source: "Ops lead" },
            ],
          },
        ],
      })
    );

    const { prompt } = buildPersonaPrompt(input({ previous })).request;
    expect(prompt).toContain("The persona you are revising");
    expect(prompt).toContain("Ops lead at a 20-person agency");
  });

  it("omits the section entirely when there is no previous version", () => {
    const { prompt } = buildPersonaPrompt(input()).request;
    expect(prompt).not.toContain("The persona you are revising");
  });
});

describe("renderPersonaMarkdown", () => {
  it("prints NOT ESTABLISHED rather than a blank line under a heading", () => {
    const markdown = renderPersonaMarkdown(emptyPersona("no facts yet"));
    expect(markdown).toContain("NOT ESTABLISHED — no facts yet");
  });

  it("always prints the sources next to the value", () => {
    const persona = normalizePersona(
      PersonaDraftSchema.parse({
        label: "Ops lead",
        attributes: [
          {
            key: "role",
            value: "Operations lead",
            evidence: [
              {
                kind: "quote",
                quote: "I run delivery",
                source: "Ops lead, Acme",
                when: "March",
              },
            ],
          },
        ],
      })
    );

    const markdown = renderPersonaMarkdown(persona);
    expect(markdown).toContain("Operations lead");
    expect(markdown).toContain('"I run delivery" — Ops lead, Acme, March');
  });

  it("labels an assumption everywhere it appears", () => {
    const persona = normalizePersona(
      PersonaDraftSchema.parse({
        attributes: [
          {
            key: "budget-owner",
            value: "the founder",
            evidence: [
              {
                kind: "assumption",
                quote: "I assume the founder signs off",
                source: "founder",
              },
            ],
          },
        ],
      })
    );

    expect(renderPersonaMarkdown(persona)).toContain("[Assumption]");
  });
});
