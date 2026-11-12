import type { CanvasPersonaInput } from "@/lib/ultraplan/graph";
import type { Persona } from "./types";

/**
 * THE ONE PERSONA → CANVAS MAPPER. Its only caller is `loadProjectCanvas` in
 * `lib/project/canvas-data.ts` (the server-rendered read behind the project
 * canvas route).
 *
 * There used to be two reads behind the canvas — that one and `canvas.getCanvas`
 * in `trpc/routers/canvas.router.ts` (client), deleted in c98d30a8 — and they
 * each grew their own version of this mapping. They disagreed about all three
 * derived fields:
 *
 *   - `evidenceCount`: the router totalled interviews, attributes, observable
 *     attributes and excluded segments; canvas-data totalled observable
 *     attributes only. The SAME persona reported two different numbers
 *     depending on whether the page was server-rendered or client-fetched, and
 *     `evidenceCount` drives the at-risk styling on the node.
 *   - `summary`: the router used the `role` attribute; canvas-data joined every
 *     observable attribute into one string.
 *   - `name`: the router fell back to the stored title and then the id;
 *     canvas-data used the label and had no fallback.
 *
 * The router's definitions won (they are the ones below), because they were the complete ones: evidence
 * cited on an interview or an excluded segment is evidence the founder
 * supplied, and omitting it understates how well sourced a persona is.
 */

/**
 * PURE. Total sourced claims behind one persona.
 *
 * Counts every evidence array on the artifact — interviews, each attribute,
 * each observable attribute, each excluded segment. `evidence[]` is a non-empty
 * tuple, so each of these contributes at least one; a count of 0 therefore
 * means the persona has no populated sections at all, which is a real finding.
 */
export function countPersonaEvidence(persona: Persona): number {
  let count = persona.interviews.evidence.length;
  for (const attribute of Object.values(persona.attributes)) {
    count += attribute.evidence.length;
  }
  for (const observable of persona.observableAttributes) {
    count += observable.evidence.length;
  }
  for (const excluded of persona.excludedSegments) {
    count += excluded.evidence.length;
  }
  return count;
}

/** PURE. The one supporting line for a persona node. Real data or NULL, never a guess. */
export function personaSummary(persona: Persona): string | null {
  const role = persona.attributes.role;
  return role.status === "not-established" ? null : role.value;
}

/**
 * PURE. Builds the canvas node input from whatever the caller could read.
 *
 * `persona` is null when the stored envelope would not parse. That yields
 * `evidenceCount: null`, NOT 0 — "we could not read this" and "this persona
 * cites nothing" render differently (unknown vs at-risk) and collapsing them
 * would paint a broken row as a sourcing problem the founder cannot fix.
 */
export function toCanvasPersonaInput({
  documentId,
  title,
  persona,
  groundedInFactKeys,
}: {
  documentId: string;
  /** The stored Document title. The only honest name left for an unreadable row. */
  title: string | null;
  persona: Persona | null;
  /** Provenance recorded at generation time. Never re-derived by matching text. */
  groundedInFactKeys: string[];
}): CanvasPersonaInput {
  return {
    id: documentId,
    // The label is a handle, not a claim.
    name: persona?.label ?? title ?? documentId,
    summary: persona ? personaSummary(persona) : null,
    evidenceCount: persona ? countPersonaEvidence(persona) : null,
    derivedFromFactKeys: groundedInFactKeys,
  };
}
