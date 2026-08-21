import type { ProjectPersona } from "@/lib/research/simulation";
import type { PersonaVersion } from "./artifact";
import { renderPersonaMarkdown } from "./prompt";
import type { SimulationSeedGap } from "./simulation-gaps";

/**
 * THE ONE PERSONA → SIMULATION MAPPER, deliberately shaped like
 * `canvas-input.ts`: one mapper, imported by whoever needs it, so a second copy
 * cannot grow and disagree.
 *
 * WHY A SEAT IS NOT AN ICP. `toOasisPersonas` refuses to run over fewer than two
 * agents — divergence between one opinion and itself is not a finding — while
 * phase 3's `single-beachhead` criterion demands exactly ONE evidenced persona
 * and `PersonaSchema` models exactly one. So the population cannot come from a
 * second ICP without contradicting the gate. It comes from the founder naming
 * several PEOPLE INSIDE the one ICP: one `SimulationProfile` row is one agent
 * ("a seat"), their demographics differ, and their evidenced profile does not.
 *
 * THE DEMOGRAPHICS ARE THE FOUNDER'S, NOT THE MODEL'S. age/gender/country/mbti
 * are typed by a human and stored in their own table precisely so they can never
 * be mistaken for something a customer said. Nothing here fills them in.
 *
 * PURE. No database, no key, no clock.
 */

export type SimulationProfileInput = {
  id: string;
  personaDocumentId: string;
  handle: string;
  age: number;
  gender: string;
  country: string;
  mbti: string | null;
};

export type SimulationSeedResult =
  | { ok: true; personas: ProjectPersona[] }
  | { ok: false; gaps: SimulationSeedGap[] };

/**
 * The label the agent's `bio` is built from.
 *
 * `personaSummary` in canvas-input.ts returns `role.value` for BOTH `evidenced`
 * and `assumed`, and only nulls on `not-established`. That is right for a canvas
 * node and wrong here without a marker: an assumed role would become the agent's
 * flat statement of who it is, i.e. the founder's labelled guess laundered into
 * a finding by omission. `renderAttributeLines` in prompt.ts already appends
 * " [Assumption]" for the model's eyes; the seat carries the same marker.
 */
function seatHeadline(version: PersonaVersion): string | null {
  const role = version.artifact?.persona.attributes.role;
  if (!role || role.status === "not-established") {
    return null;
  }
  return role.status === "assumed"
    ? `${role.value} [Assumption — the founder's stated guess, not something a customer said]`
    : role.value;
}

/**
 * PURE. Build the OASIS population, or name every reason it cannot be built.
 *
 * REPORTS EVERY GAP, not the first — same posture as `toOasisPersonas`, for the
 * same reason: a founder fixing one field at a time, one run at a time, gives up.
 *
 * A PERSONA WITH NO SEAT IS NEVER DROPPED to get the rest over the two-agent
 * floor. Dropping it would change the population without saying so, which is the
 * silent-degradation failure this whole product exists to refuse.
 */
export function toSimulationPersonas(input: {
  versions: readonly PersonaVersion[];
  profiles: readonly SimulationProfileInput[];
}): SimulationSeedResult {
  const gaps: SimulationSeedGap[] = [];
  const byDocument = new Map<string, PersonaVersion>();

  for (const version of input.versions) {
    byDocument.set(version.documentId, version);
  }

  const seatedDocumentIds = new Set(
    input.profiles.map((profile) => profile.personaDocumentId)
  );

  for (const version of input.versions) {
    if (!version.artifact) {
      gaps.push({
        kind: "unreadable-version",
        personaDocumentId: version.documentId,
        title: version.title,
      });
      continue;
    }
    if (!seatedDocumentIds.has(version.documentId)) {
      gaps.push({
        kind: "no-profile",
        personaDocumentId: version.documentId,
        personaLabel: version.artifact.persona.label,
        title: version.title,
      });
      continue;
    }
    if (seatHeadline(version) === null) {
      gaps.push({
        kind: "role-not-established",
        personaDocumentId: version.documentId,
        personaLabel: version.artifact.persona.label,
      });
    }
  }

  const personas: ProjectPersona[] = [];
  for (const profile of input.profiles) {
    const version = byDocument.get(profile.personaDocumentId);
    if (!version) {
      // ORPHAN MEANS THE DOCUMENT IS GONE, and nothing else. No foreign key can
      // cascade this: `Document`'s primary key is (id, createdAt), so
      // `personaDocumentId` cannot reference it, and a deleted persona leaves
      // seats behind. They must be NAMED rather than silently skipped — a
      // population quietly one agent short is what this function refuses to
      // produce.
      gaps.push({
        handle: profile.handle,
        kind: "orphan-profile",
        personaDocumentId: profile.personaDocumentId,
        profileId: profile.id,
      });
      continue;
    }
    if (!version.artifact) {
      // Already reported as `unreadable-version` above. Adding
      // `orphan-profile` here as well would tell the founder their seat "points
      // at a persona that no longer exists" — a false sentence about a persona
      // that exists and does not parse, pointing at the wrong remedy.
      continue;
    }
    const headline = seatHeadline(version);
    if (headline === null) {
      continue;
    }

    const mbti = profile.mbti?.trim();
    personas.push({
      // `handle`, NOT `persona.label`. The stored label is a sentence ("Primary
      // persona: in-house payroll bookkeeper/controller/office manager at an
      // independent 3–15-location restaurant group"), which slugs to an unusable
      // OASIS username — and every seat in one ICP would slug IDENTICALLY and be
      // refused by toOasisPersonas's collision guard, deadlocking the feature.
      // `id` is the handle too: it appears only in toOasisPersonas's problem
      // strings, where "Ana R" is actionable and a uuid is not.
      age: profile.age,
      country: profile.country,
      description: renderPersonaMarkdown(version.artifact.persona),
      gender: profile.gender,
      headline,
      id: profile.handle,
      // `""` IS NOT "UNSPECIFIED". An empty string is not null, so every
      // `?? UNSPECIFIED_MBTI` downstream steps straight over it and it reaches
      // OasisPersonaSchema as a min(1) failure reported to the founder as
      // "malformed on: mbti" — a field the form told them to leave blank.
      mbti: mbti ? mbti : undefined,
      name: profile.handle,
    });
  }

  if (gaps.length > 0) {
    return { gaps, ok: false };
  }
  return { ok: true, personas };
}
