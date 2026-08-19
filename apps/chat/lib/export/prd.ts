import {
  type DocumentContext,
  type ExportSection,
  groundFact,
  LOW_CONFIDENCE_CEILING,
  LOW_CONFIDENCE_MARKER,
  labelFor,
  phaseStateFor,
  phaseStatusLabel,
  renderGrounded,
} from "./grounding";
import { blockquote, joinSections, singleLine, tableCell } from "./markdown";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * PRD.md — the document the whole feature exists to produce.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHY IT LOOKS LIKE THIS, AND NOT LIKE A NORMAL PRD.
 *
 * A normal PRD is written by a human who knows which parts they are confident
 * about. This one is assembled by a machine from a fact store, and the founder
 * will hand it to an investor, a contractor, or a coding agent. If it reads
 * like a finished document, every gap in it becomes an implicit claim that
 * there is no gap. So the format inverts the usual priority:
 *
 *  • ABSENCE IS RENDERED, never omitted. Every fact key the workflow defines
 *    gets a heading. A missing section would read as "not applicable"; an
 *    explicit "not established" reads as "nobody answered this", which is the
 *    truth and is actionable.
 *
 *  • DOUBT IS RENDERED TWICE. A low-confidence fact is marked inline AND listed
 *    near the top, because the top is where a reader who skims will look, and a
 *    skimmed low-confidence fact is exactly how a guess becomes a plan.
 *
 *  • PROVENANCE IS ON EVERY CLAIM. Confidence, originating phase and the raw
 *    fact key sit under each value, so any statement can be traced back to the
 *    row that produced it and argued with.
 *
 * PURE. Takes a DocumentContext, returns a string. No I/O, no clock.
 */

/** The `.planning/` file that carries the full open-questions list. */
const OPEN_QUESTIONS_PATH = ".planning/OPEN-QUESTIONS.md";

function renderTitle(context: DocumentContext): string {
  // singleLine, because a project name containing a newline would otherwise
  // split the H1 and turn the remainder into body text the founder never wrote.
  const name = singleLine(context.project.name) || context.repoName;
  return `# ${name} — Product Requirements`;
}

function renderBanner(context: DocumentContext): string {
  return [
    `> Generated on ${context.generatedOn} from the eight-phase validation workflow.`,
    ">",
    "> **Every project-specific statement below is copied verbatim from a recorded",
    "> fact, or is explicitly marked as not established.** Nothing here was",
    "> inferred, rounded, summarised or filled in. If a number you expected is",
    "> missing, it is missing because it was never evidenced.",
  ].join("\n");
}

function renderLegend(): string {
  return [
    "## How to read this document",
    "",
    "| Marker | Meaning |",
    "| --- | --- |",
    "| _confidence N/100_ | How sure the extractor was when it recorded the fact. |",
    `| ${LOW_CONFIDENCE_MARKER} | Recorded below ${LOW_CONFIDENCE_CEILING}/100. Treat as an open question. |`,
    "| _not established_ | No fact was ever recorded. This document makes no claim. |",
    "",
    "Quoted blocks are the recorded value, unedited. Everything outside a quote is",
    "this template's own wording and says nothing about the project.",
  ].join("\n");
}

function renderEvidenceStatus(context: DocumentContext): string {
  const { readiness, notEstablishedKeys, lowConfidenceKeys } = context;
  const established = readiness.factCount;

  return [
    "## Status of the evidence",
    "",
    "| | |",
    "| --- | --- |",
    `| Phases passed | ${readiness.passedPhaseKeys.length} of ${readiness.phaseCount} |`,
    `| Facts established | ${established} |`,
    `| Questions still unanswered | ${notEstablishedKeys.length} (listed in \`${OPEN_QUESTIONS_PATH}\`) |`,
    `| Established but low confidence | ${lowConfidenceKeys.length} |`,
    "",
    tableCell(readiness.reason),
  ].join("\n");
}

/**
 * The low-confidence roll-up.
 *
 * Rendered even when empty, with an explicit "none" — an absent section would
 * be indistinguishable from a generator that forgot to check, and the founder
 * has no way to tell those apart from the outside.
 */
function renderUnverified(context: DocumentContext): string {
  const head = "## Claims that are NOT yet verified";
  if (context.lowConfidenceKeys.length === 0) {
    return [
      head,
      "",
      `None. Every established fact was recorded at ${LOW_CONFIDENCE_CEILING}/100 confidence or above.`,
    ].join("\n");
  }

  const rows = context.lowConfidenceKeys.map((key) => {
    const grounded = groundFact(context.index, key);
    const value =
      grounded.status === "established" ? tableCell(grounded.value) : "";
    const confidence =
      grounded.status === "established" ? `${grounded.confidence}/100` : "—";
    return `| ${tableCell(labelFor(key))} | ${confidence} | ${value} |`;
  });

  return [
    head,
    "",
    `These were recorded below ${LOW_CONFIDENCE_CEILING}/100. They appear in full in`,
    "their sections below, marked. **Do not build, price or pitch on any of them",
    "without re-evidencing it first.**",
    "",
    "| What | Confidence | Recorded value |",
    "| --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function renderSection(
  context: DocumentContext,
  section: ExportSection
): string {
  const state = phaseStateFor(context.phases, section.phaseKey);
  const status = phaseStatusLabel(state.status, state.decision);

  const parts: string[] = [
    `## ${section.order}. ${section.title}`,
    "",
    `_Phase goal: ${singleLine(section.goal)}_`,
    "",
    `_Gate status: **${status}**._`,
  ];

  // The gate's own words about what is still missing. Reproduced verbatim
  // rather than re-summarised: decideGate() already interpolated the specific
  // failing thing at the point of decision, and re-writing it here would be a
  // second, drifting explanation of the same verdict.
  if (state.missing.length > 0) {
    parts.push(
      "",
      "_Outstanding gaps named by the gate:_",
      "",
      ...state.missing.map((gap) => `- ${singleLine(gap)}`)
    );
  }

  for (const key of section.factKeys) {
    parts.push(
      "",
      "---",
      "",
      renderGrounded(groundFact(context.index, key), labelFor(key))
    );
  }

  return parts.join("\n");
}

/**
 * Facts stored under keys no current phase defines.
 *
 * They exist when a phase definition drops a key that projects already have
 * rows for. Deleting them from the export would be silent data loss on the
 * founder's own data, so they are carried — but QUARANTINED into an appendix
 * and labelled, because an unrecognised key has no vetted meaning and must not
 * be presented next to a certified one as if it did.
 */
function renderUnrecognized(context: DocumentContext): string {
  if (context.unrecognizedKeys.length === 0) {
    return "";
  }
  const rows = context.unrecognizedKeys.map((key) => {
    const grounded = groundFact(context.index, key);
    const value =
      grounded.status === "established" ? tableCell(grounded.value) : "—";
    const confidence =
      grounded.status === "established" ? `${grounded.confidence}/100` : "—";
    return `| \`${tableCell(key)}\` | ${confidence} | ${value} |`;
  });

  return [
    "## Appendix — facts outside the current workflow vocabulary",
    "",
    "These were recorded against fact keys that no phase in this build defines,",
    "so no exit criterion ever checked them. They are reproduced for completeness",
    "and carry no certification at all.",
    "",
    "| Key | Confidence | Recorded value |",
    "| --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function renderInstructions(context: DocumentContext): string {
  const instructions = context.project.instructions.trim();
  if (instructions.length === 0) {
    return "";
  }
  return [
    "## Founder's own project instructions",
    "",
    "Written by the founder in the workspace, not derived from any gate.",
    "",
    blockquote(instructions),
  ].join("\n");
}

function renderFooter(context: DocumentContext): string {
  return [
    "---",
    "",
    `_Generated by the idea-check handoff export on ${context.generatedOn}._`,
    "_Regenerating from the same project state produces a byte-identical file,_",
    "_so this document is safe to commit and diff._",
  ].join("\n");
}

/** PURE. The whole PRD, in the order a reader needs it. */
export function renderPrd(context: DocumentContext): string {
  return joinSections([
    renderTitle(context),
    renderBanner(context),
    renderLegend(),
    renderEvidenceStatus(context),
    renderUnverified(context),
    renderInstructions(context),
    ...context.sections.map((section) => renderSection(context, section)),
    renderUnrecognized(context),
    renderFooter(context),
  ]);
}
