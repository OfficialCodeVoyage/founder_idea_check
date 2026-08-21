/**
 * EVERY REASON A SIMULATION POPULATION COULD NOT BE BUILT, and the sentence the
 * founder reads for each one.
 *
 * A LEAF MODULE ON PURPOSE — it imports NOTHING. The two mount points are a
 * `"use client"` panel and a server component, and the obvious home for this
 * (simulation-input.ts) transitively pulls `./prompt` -> `@/lib/phases/gate`,
 * `@/lib/phases/context` -> `@/lib/embeddings/text` and the phase-3 definitions.
 * All pure, all compilable in a browser, and all of it would have shipped the
 * gate's prompt text to the client to render four sentences.
 */

export type SimulationSeedGap =
  | {
      kind: "no-profile";
      personaDocumentId: string;
      personaLabel: string | null;
      title: string;
    }
  | { kind: "unreadable-version"; personaDocumentId: string; title: string }
  | {
      kind: "role-not-established";
      personaDocumentId: string;
      personaLabel: string;
    }
  | {
      kind: "orphan-profile";
      profileId: string;
      handle: string;
      personaDocumentId: string;
    };

/**
 * PURE. One sentence per gap, naming WHICH persona and WHICH field.
 *
 * Same register as `toOasisPersonas`'s refusals, and the same rule: never "the
 * simulation profile is incomplete". A refusal a founder cannot act on is a
 * failure wearing a message.
 */
export function describeSeedGap(gap: SimulationSeedGap): string {
  switch (gap.kind) {
    case "no-profile":
      return `“${gap.personaLabel ?? gap.title}” has no simulation profile. OASIS needs an age, a gender and a country for every agent it spawns, and this tool will not invent them — fill them in above.`;
    case "unreadable-version":
      return `The newest version of “${gap.title}” cannot be read, so there is nothing to simulate. Regenerate the persona.`;
    case "role-not-established":
      return `“${gap.personaLabel}” has no established role, so its agent has nothing to say about who it is. Establish the role in phase 3.`;
    default:
      return `The seat “${gap.handle}” points at a persona that no longer exists. Delete it, or point it at a current persona.`;
  }
}
