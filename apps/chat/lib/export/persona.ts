import {
  latestPersonaPerDocument,
  type PersonaDocumentRowLike,
} from "@/lib/personas/artifact";
import { personaAttributeEntries } from "@/lib/personas/normalize";
import type {
  Persona,
  PersonaAttribute,
  PersonaEvidence,
} from "@/lib/personas/types";
import { PERSONA_INTERVIEW_FLOOR } from "@/lib/personas/types";
import type { DocumentContext } from "./grounding";
import { blockquote, bulletList, joinSections, singleLine } from "./markdown";
import { PLANNING_DIR } from "./planning";
import type { ExportFile, ExportPersona } from "./types";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * `.planning/PERSONA.md` — the persona the eight phases actually produced.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * THE DEFECT THIS CLOSES. `buildHandoff` composed exactly 17 files
 * (scaffold + PRD + CLAUDE + AGENTS + planning) and `BuildHandoffInput` had no
 * persona field at all, so a project that owned a finished persona document
 * exported a repository with no persona in it. Not a regression — it was never
 * wired. The plumbing already existed and named this reader:
 * `latestPersonaVersion`'s own header cites "the handoff export in step 9", and
 * `PersonaStore`'s doc comment says the seam exists so the canvas and the
 * handoff export can be tested without a database.
 *
 * ONE FIXED PATH, ALWAYS EMITTED. No slugified per-persona filenames, so this
 * adds no new path-escape surface for `assertSafeTree` and the README manifest
 * row is unconditional. "No persona was ever generated" is a SENTENCE IN THE
 * FILE, never a missing file: an absent file reads as "not relevant to this
 * project", which is the same lie `not-established` exists to prevent.
 *
 * WHY NOT `renderPersonaMarkdown` FROM lib/personas/prompt.ts. It looks like a
 * drop-in and is not. It interpolates `attribute.value`, `e.quote` and
 * `persona.label` raw into `#`/`##` lines — model-written text forging document
 * structure in a file the founder circulates and an agent is told to obey, which
 * is exactly the hole lib/export/markdown.ts exists to close. It also takes a
 * `Persona`, not a `PersonaArtifact`, so it cannot render `degradedReasons`:
 * shipping a degraded placeholder with no banner would launder a refusal into a
 * finding.
 *
 * PURE. No fs, no clock, no model, no database.
 */

export const PERSONA_PATH = `${PLANNING_DIR}/PERSONA.md`;

/**
 * PURE. One `ExportPersona` per persona document, newest version of each.
 *
 * The grouping and the "an unreadable newest version is NOT replaced by an older
 * readable one" rule both live in `latestPersonaPerDocument`; this is only the
 * projection into the export's own union.
 */
export function toExportPersonas(
  rows: readonly PersonaDocumentRowLike[]
): ExportPersona[] {
  return latestPersonaPerDocument(rows).map((latest) =>
    latest.artifact
      ? {
          artifact: latest.artifact,
          documentId: latest.documentId,
          status: "readable",
          title: latest.title,
          version: latest.version,
        }
      : {
          documentId: latest.documentId,
          status: "unreadable",
          title: latest.title,
          version: latest.version,
        }
  );
}

function renderEvidence(evidence: readonly PersonaEvidence[]): string {
  if (evidence.length === 0) {
    return "_(no evidence recorded)_";
  }
  return evidence
    .map((item) =>
      [
        `- **${singleLine(item.kind)}** — ${singleLine(item.source)}${
          item.when ? ` (${singleLine(item.when)})` : ""
        }`,
        "",
        blockquote(item.quote),
      ].join("\n")
    )
    .join("\n\n");
}

/**
 * One attribute, with its STATUS SPELLED OUT.
 *
 * `assumed` is labelled `[Assumption]` and never rendered like `evidenced` —
 * `renderAttributeLines` in lib/personas/prompt.ts already does this for the
 * model's own eyes, and a file a founder hands to an engineer needs it more, not
 * less. `not-established` renders its gap and NEVER a blank value line: a blank
 * line under a confident heading reads as "this persona has no buying process"
 * rather than "nobody has established it".
 */
function renderAttribute(label: string, attribute: PersonaAttribute): string {
  const heading = `### ${singleLine(label)}`;

  if (attribute.status === "not-established") {
    return [
      heading,
      "",
      "**Not established.** Nobody has answered this, and nothing in this",
      "repository guesses at it.",
      "",
      `Missing: ${singleLine(attribute.gap)}`,
    ].join("\n");
  }

  const marker =
    attribute.status === "assumed"
      ? "**[Assumption]** — the founder's stated guess, not something a customer said."
      : "**Evidenced.**";

  return [
    heading,
    "",
    marker,
    "",
    blockquote(attribute.value),
    "",
    renderEvidence(attribute.evidence),
  ].join("\n");
}

type ReadableExportPersona = Extract<ExportPersona, { status: "readable" }>;

function renderReadablePersona(entry: ReadableExportPersona): string {
  const { artifact } = entry;
  const persona: Persona = artifact.persona;
  const sections: string[] = [];

  // THE BANNER GOES FIRST, before any attribute value. A degraded version is a
  // fail-closed placeholder, and a reader who meets the values first has
  // already believed them by the time they reach the caveat.
  if (artifact.degradedReasons.length > 0) {
    sections.push(
      [
        "> **This version is not a finding.**",
        ">",
        "> It was generated as a fail-closed placeholder, for the reasons below.",
        "> Do not treat anything in it as established.",
      ].join("\n"),
      bulletList(artifact.degradedReasons)
    );
  }

  sections.push(
    `## ${singleLine(persona.label)}`,
    `_Version ${entry.version}. The label is a handle, not a claim — every claim it summarises is an attribute below, with its source._`
  );

  for (const { spec, attribute } of personaAttributeEntries(persona)) {
    sections.push(renderAttribute(spec.label, attribute));
  }

  sections.push(
    "## Observable attributes",
    "",
    "_How you would recognise this person from the outside, without asking them._",
    persona.observableAttributes.length === 0
      ? "_(none established)_"
      : persona.observableAttributes
          .map((observable) =>
            [
              `### ${singleLine(observable.dimension)}`,
              "",
              blockquote(observable.value),
              "",
              renderEvidence(observable.evidence),
            ].join("\n")
          )
          .join("\n\n")
  );

  sections.push(
    "## Segments deliberately not served first",
    persona.excludedSegments.length === 0
      ? "_(none recorded)_"
      : persona.excludedSegments
          .map((excluded) =>
            [
              `### ${singleLine(excluded.segment)}`,
              "",
              blockquote(excluded.reason),
              "",
              renderEvidence(excluded.evidence),
            ].join("\n")
          )
          .join("\n\n")
  );

  sections.push(
    "## Interviews behind this persona",
    persona.interviews.status === "counted"
      ? [
          `${persona.interviews.count} recorded, against a floor of ${PERSONA_INTERVIEW_FLOOR}.`,
          persona.interviews.meetsFloor
            ? "The floor is met."
            : "**The floor is NOT met**, so this persona rests on fewer conversations than the workflow asks for.",
          "",
          renderEvidence(persona.interviews.evidence),
        ].join("\n")
      : [
          "**Not established.** No interview count has been recorded, so the",
          `floor of ${PERSONA_INTERVIEW_FLOOR} is not met.`,
          "",
          `Missing: ${singleLine(persona.interviews.gap)}`,
        ].join("\n")
  );

  sections.push(
    "## Provenance",
    "",
    "**Facts this version was generated from:**",
    "",
    bulletList(
      artifact.groundedInFactKeys.map((key) => `\`${key}\``),
      "_(none — the persona was generated with no fact in the prompt)_"
    ),
    "",
    "**Facts a blocking phase-3 criterion names that did NOT fit the prompt:**",
    "",
    bulletList(
      artifact.droppedPinnedFactKeys.map((key) => `\`${key}\``),
      "_(none)_"
    )
  );

  return joinSections(sections);
}

/** PURE. The whole document, for zero, one or several personas. */
export function renderPersonaDocument(
  context: DocumentContext,
  personas: readonly ExportPersona[]
): string {
  if (personas.length === 0) {
    return joinSections([
      "# Persona",
      `_As of ${context.generatedOn}._`,
      [
        "**No persona artifact has ever been generated for this project.**",
        "",
        "This is not the same as the project having no users. It means phase 3",
        "(`user-personas`) never produced a stored persona, so there is nothing",
        "here to copy and nothing has been invented in its place.",
      ].join("\n"),
      [
        "The phase-3 fact keys that feed a persona are listed in",
        `\`${PLANNING_DIR}/OPEN-QUESTIONS.md\`. Answer those and regenerate.`,
      ].join("\n"),
    ]);
  }

  const bodies = personas.map((entry) => {
    if (entry.status === "unreadable") {
      return [
        `## ${singleLine(entry.title)}`,
        "",
        `**Version ${entry.version} could not be read.** The stored document`,
        "exists but does not parse as a persona, so nothing from it is",
        "reproduced here. This is a bug worth reporting, not an empty persona:",
        "an older version is deliberately NOT shown in its place, because",
        "exporting a superseded version as the current one would be worse.",
      ].join("\n");
    }
    return renderReadablePersona(entry);
  });

  return joinSections([
    "# Persona",
    `_As of ${context.generatedOn}. ${personas.length} persona document${personas.length === 1 ? "" : "s"}, newest version of each. Version history is not exported._`,
    [
      "> Every value below is either evidenced, labelled as the founder's own",
      "> assumption, or marked not established. Nothing here was inferred to",
      "> fill a gap.",
    ].join("\n"),
    ...bodies,
  ]);
}

/** PURE. Exactly one file, always. */
export function personaFiles(
  context: DocumentContext,
  personas: readonly ExportPersona[]
): ExportFile[] {
  return [
    { path: PERSONA_PATH, contents: renderPersonaDocument(context, personas) },
  ];
}
