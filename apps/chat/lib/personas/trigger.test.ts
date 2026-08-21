import { describe, expect, it } from "vitest";
import { PHASE_THREE } from "@/lib/phases/definitions-discovery";
import { decidePersonaRegeneration, type PersonaTriggerInput } from "./trigger";

const OLD = new Date("2026-08-01T00:00:00Z");
const NEW = new Date("2026-08-20T00:00:00Z");

function decide(over: Partial<PersonaTriggerInput> = {}) {
  return decidePersonaRegeneration({
    phaseKey: PHASE_THREE.key,
    assessed: true,
    decision: "WARN",
    factsChanged: 0,
    factsStored: 6,
    latestFactUpdatedAt: OLD,
    latestVersionCreatedAt: NEW,
    ...over,
  });
}

describe("decidePersonaRegeneration", () => {
  it("regenerates when this turn changed a fact", () => {
    expect(decide({ factsChanged: 2 })).toEqual({
      regenerate: true,
      why: "facts-changed-this-turn",
    });
  });

  it("lets a FIRST-HAND fact change beat a newer stored version", () => {
    // THE REGRESSION TEST for the clock bug. ProjectFact.updatedAt is written
    // by Postgres and Document.createdAt by Node. If the timestamp comparison
    // ran before `factsChanged`, a database clock trailing the app clock would
    // resolve this to "version-is-current" and silently skip a regeneration
    // that was certainly needed.
    expect(
      decide({
        factsChanged: 1,
        latestFactUpdatedAt: OLD,
        latestVersionCreatedAt: NEW,
      })
    ).toEqual({ regenerate: true, why: "facts-changed-this-turn" });
  });

  it("does nothing on a turn the gate did not assess", () => {
    expect(decide({ assessed: false, factsChanged: 5 })).toEqual({
      regenerate: false,
      why: "not-assessed",
    });
  });

  it("does nothing outside phase 3", () => {
    expect(decide({ phaseKey: "problem-validation", factsChanged: 5 })).toEqual(
      { regenerate: false, why: "not-phase-three" }
    );
  });

  it("does nothing when no fact is stored at all", () => {
    // buildPersonaPrompt would refuse anyway; not paying for the model call is
    // the cheaper route to the same answer.
    expect(decide({ factsStored: 0, factsChanged: 0 })).toEqual({
      regenerate: false,
      why: "no-facts-stored",
    });
  });

  it("does not pay for a regeneration when a BLOCK changed nothing", () => {
    expect(decide({ decision: "BLOCK", factsChanged: 0 })).toEqual({
      regenerate: false,
      why: "no-new-input",
    });
  });

  it("regenerates when there is no version yet, even with no fact change", () => {
    // The exact reported state: phase 3 passed and the Document table was empty.
    expect(decide({ factsChanged: 0, latestVersionCreatedAt: null })).toEqual({
      regenerate: true,
      why: "no-version-yet",
    });
  });

  it("regenerates when the facts moved on since the stored version", () => {
    expect(
      decide({
        factsChanged: 0,
        latestFactUpdatedAt: NEW,
        latestVersionCreatedAt: OLD,
      })
    ).toEqual({ regenerate: true, why: "facts-changed-since-version" });
  });

  it("does nothing when the stored version already records the facts", () => {
    expect(
      decide({
        factsChanged: 0,
        latestFactUpdatedAt: OLD,
        latestVersionCreatedAt: NEW,
      })
    ).toEqual({ regenerate: false, why: "version-is-current" });
  });

  it("treats equal timestamps as current rather than regenerating forever", () => {
    expect(
      decide({
        factsChanged: 0,
        latestFactUpdatedAt: OLD,
        latestVersionCreatedAt: OLD,
      })
    ).toEqual({ regenerate: false, why: "version-is-current" });
  });

  it("does not treat a null fact timestamp as the epoch", () => {
    // `?? new Date(0)` here would make "we do not know" beat any stored version.
    expect(
      decide({
        factsChanged: 0,
        latestFactUpdatedAt: null,
        latestVersionCreatedAt: NEW,
      })
    ).toEqual({ regenerate: false, why: "version-is-current" });
  });

  it("names a rule for every outcome", () => {
    // A debug log saying only true/false cannot be diagnosed.
    const reasons = new Set(
      [
        decide({ assessed: false }),
        decide({ phaseKey: "positioning" }),
        decide({ factsStored: 0 }),
        decide({ factsChanged: 3 }),
        decide({ decision: "BLOCK" }),
        decide({ latestVersionCreatedAt: null }),
        decide({ latestFactUpdatedAt: NEW, latestVersionCreatedAt: OLD }),
        decide({}),
      ].map((d) => d.why)
    );
    expect(reasons.size).toBe(8);
  });
});
