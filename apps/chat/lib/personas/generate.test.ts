import { describe, expect, it, vi } from "vitest";
import type { StoredFact } from "@/lib/phases/context";
import { PHASE_THREE } from "@/lib/phases/definitions-discovery";
import {
  failClosedPersonaArtifact,
  generatePersona,
  type PersonaDeps,
  type PersonaGenerationStage,
  type PersonaGenerator,
} from "./generate";
import { ASSERTED_WITHOUT_EVIDENCE, EMPTY_FACT_STORE } from "./normalize";
import type { BuildPersonaPromptInput } from "./prompt";
import { PERSONA_ATTRIBUTE_KEYS, PersonaArtifactSchema } from "./types";

const AT = new Date("2026-08-01T00:00:00.000Z");

function fact(key: string, value: string): StoredFact {
  return {
    key,
    value,
    confidence: 80,
    updatedAt: AT,
    phaseKey: PHASE_THREE.key,
  };
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

function collectStages() {
  const stages: PersonaGenerationStage[] = [];
  const onError: PersonaDeps["onError"] = (_error, stage) => {
    stages.push(stage);
  };
  return { stages, onError };
}

describe("generatePersona — refuses before it spends a token", () => {
  it("does not call the model at all when there is nothing to ground a persona in", async () => {
    const generate = vi.fn<PersonaGenerator>(() => Promise.resolve({}));
    const { stages, onError } = collectStages();

    const artifact = await generatePersona(
      { generate, onError },
      input({ facts: [] })
    );

    expect(generate).not.toHaveBeenCalled();
    expect(stages).toEqual(["refused-no-grounding"]);
    expect(artifact.degradedReasons).toEqual([EMPTY_FACT_STORE]);
    for (const key of PERSONA_ATTRIBUTE_KEYS) {
      expect(artifact.persona.attributes[key].status).toBe("not-established");
    }
  });
});

describe("generatePersona — every failure lands on the same artifact", () => {
  it("never rejects when the generator throws", async () => {
    const generate: PersonaGenerator = () =>
      Promise.reject(new Error("no api key"));
    const { stages, onError } = collectStages();

    const artifact = await generatePersona({ generate, onError }, input());

    expect(stages).toEqual(["generator-call-failed"]);
    expect(artifact.degradedReasons.at(0)).toContain("no api key");
    expect(artifact.persona.interviews.status).toBe("not-established");
  });

  it("never rejects when the generator returns an unreadable shape", async () => {
    const generate: PersonaGenerator = () =>
      Promise.resolve({ attributes: "not an array" });
    const { stages, onError } = collectStages();

    const artifact = await generatePersona({ generate, onError }, input());

    expect(stages).toEqual(["generator-schema-mismatch"]);
    expect(artifact.degradedReasons).toHaveLength(1);
  });

  it("reports an answer in which nothing could be sourced as degraded", async () => {
    // The dangerous case: a fluent, complete-looking persona with no citations.
    const generate: PersonaGenerator = () =>
      Promise.resolve({
        label: "Ambitious Amy",
        attributes: PERSONA_ATTRIBUTE_KEYS.map((key) => ({
          key,
          value: "something confident and entirely invented",
          evidence: [],
        })),
        interviewCount: 12,
      });
    const { stages, onError } = collectStages();

    const artifact = await generatePersona({ generate, onError }, input());

    expect(stages).toEqual(["nothing-established"]);
    for (const key of PERSONA_ATTRIBUTE_KEYS) {
      const attribute = artifact.persona.attributes[key];
      expect(attribute.status).toBe("not-established");
      expect(attribute.value).toBeNull();
    }
    expect(artifact.persona.interviews.count).toBe(0);
    expect(JSON.stringify(artifact)).not.toContain("entirely invented");
  });

  it("always returns something the stored schema accepts", async () => {
    const generators: PersonaGenerator[] = [
      () => Promise.reject(new Error("boom")),
      () => Promise.resolve(null),
      () => Promise.resolve({ attributes: [{ key: 42 }] }),
      () => Promise.resolve({ label: "x" }),
    ];

    for (const generate of generators) {
      const artifact = await generatePersona({ generate }, input());
      expect(PersonaArtifactSchema.safeParse(artifact).success).toBe(true);
    }
  });
});

describe("generatePersona — the happy path still discards what is unsourced", () => {
  const generate: PersonaGenerator = () =>
    Promise.resolve({
      label: "Ops lead at a 20-person agency",
      attributes: [
        {
          key: "role",
          value: "Operations lead",
          evidence: [
            {
              kind: "quote",
              quote: "I run delivery for the whole studio",
              source: "Ops lead, Acme",
            },
          ],
        },
        {
          key: "budget-owner",
          value: "The finance director",
          evidence: [],
        },
      ],
      observableAttributes: [
        {
          dimension: "team size",
          value: "15-30 people",
          evidence: [
            { kind: "observation", quote: "22 seats billed", source: "Acme" },
          ],
        },
      ],
      interviewCount: 2,
      interviewEvidence: [
        { kind: "quote", quote: "call notes 1", source: "Ops lead, Acme" },
        { kind: "quote", quote: "call notes 2", source: "Ops lead, Beta" },
      ],
    });

  it("keeps the sourced attribute", async () => {
    const artifact = await generatePersona({ generate }, input());
    expect(artifact.persona.attributes.role).toMatchObject({
      status: "evidenced",
      value: "Operations lead",
    });
  });

  it("discards the unsourced attribute and says why", async () => {
    const artifact = await generatePersona({ generate }, input());
    expect(artifact.persona.attributes["budget-owner"]).toMatchObject({
      status: "not-established",
      value: null,
      gap: ASSERTED_WITHOUT_EVIDENCE,
    });
  });

  it("does not mark a real generation as degraded", async () => {
    const artifact = await generatePersona({ generate }, input());
    expect(artifact.degradedReasons).toEqual([]);
    expect(artifact.groundedInFactKeys).toEqual(["primary_persona"]);
  });

  it("counts only the interviews that named somebody", async () => {
    const artifact = await generatePersona({ generate }, input());
    expect(artifact.persona.interviews).toMatchObject({
      status: "counted",
      count: 2,
      meetsFloor: false,
    });
  });
});

describe("generatePersona — a fact the budget evicted is never silent", () => {
  it("reports the eviction on both the error sink and the artifact", async () => {
    const generate: PersonaGenerator = () =>
      Promise.resolve({
        attributes: [
          {
            key: "role",
            value: "Operations lead",
            evidence: [
              { kind: "quote", quote: "I run delivery", source: "Ops lead" },
            ],
          },
        ],
      });
    const { stages, onError } = collectStages();

    const artifact = await generatePersona(
      { generate, onError },
      input({
        facts: [
          fact("primary_persona", "x".repeat(400)),
          fact("excluded_segments", "no"),
        ],
        factBudgetTokens: 20,
      })
    );

    expect(stages).toContain("pinned-fact-evicted");
    expect(artifact.droppedPinnedFactKeys).toEqual(["primary_persona"]);
    expect(artifact.degradedReasons.at(0)).toContain(
      "PERSONA_FACT_BUDGET_TOKENS"
    );
  });
});

describe("failClosedPersonaArtifact", () => {
  it("names its reason and establishes nothing", () => {
    const artifact = failClosedPersonaArtifact("the database was unreachable");

    expect(artifact.degradedReasons).toEqual(["the database was unreachable"]);
    expect(PersonaArtifactSchema.safeParse(artifact).success).toBe(true);
  });
});
