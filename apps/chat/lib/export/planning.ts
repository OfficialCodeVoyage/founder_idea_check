import {
  type DocumentContext,
  type ExportSection,
  FOUNDER_CONFIDENCE_MEANING,
  groundFact,
  LOW_CONFIDENCE_CEILING,
  labelFor,
  originOf,
  phaseStateFor,
  phaseStatusLabel,
  renderGrounded,
} from "./grounding";
import {
  blockquote,
  bulletList,
  joinSections,
  singleLine,
  tableCell,
} from "./markdown";
import { ExportPathError, slugifySegment } from "./paths";
import type { ExportFile } from "./types";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * `.planning/` — the state of the work, separated from the description of the
 * product.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * PRD.md answers "what is this?". `.planning/` answers "where are we, and what
 * is still unknown?" — and it is the half that a subscription product has no
 * incentive to ever hand over, because a founder holding an accurate list of
 * their own open questions does not need a subscription to keep track of them.
 *
 * The split matters for a second reason: PRD.md is stable and quotable, while
 * planning state changes every time a gate runs. Interleaving them would mean
 * every status change rewrites the document the founder is circulating.
 *
 * PURE. Every function here takes a DocumentContext and returns strings.
 */

export const PLANNING_DIR = ".planning";
export const ROADMAP_PATH = `${PLANNING_DIR}/ROADMAP.md`;
export const FACTS_PATH = `${PLANNING_DIR}/FACTS.md`;
export const OPEN_QUESTIONS_PATH = `${PLANNING_DIR}/OPEN-QUESTIONS.md`;
export const PHASES_DIR = `${PLANNING_DIR}/phases`;

/**
 * PURE. Path for one phase file.
 *
 * THROWS rather than falling back when a phase key does not slugify. Phase keys
 * are compile-time constants matching CRITERION_ID_PATTERN (`^[a-z][a-z0-9-]`),
 * so a failure here means the phase definitions changed in a way this module
 * has not been taught about. A silent fallback would produce a roadmap linking
 * to `.planning/phases/03-phase.md` for two different phases and lose one of
 * them — fail loudly instead, at build time, where a test catches it.
 */
export function phaseFilePath(section: ExportSection): string {
  const slug = slugifySegment(section.phaseKey);
  if (!slug) {
    throw new ExportPathError(
      `Refusing to export: phase key "${section.phaseKey}" does not reduce to a safe filename.`
    );
  }
  const order = String(section.order).padStart(2, "0");
  return `${PHASES_DIR}/${order}-${slug}.md`;
}

function establishedCount(
  context: DocumentContext,
  section: ExportSection
): number {
  return section.factKeys.filter(
    (key) => groundFact(context.index, key).status === "established"
  ).length;
}

/**
 * The status table. One row per phase, always all eight.
 *
 * Never filtered to "the interesting ones": the shape of the table IS the
 * information — a founder should see at a glance that phases 5 to 8 were never
 * started, rather than seeing a tidy table of the four they finished.
 */
function renderStatusTable(context: DocumentContext): string {
  const rows = context.sections.map((section) => {
    const state = phaseStateFor(context.phases, section.phaseKey);
    const status = phaseStatusLabel(state.status, state.decision);
    const facts = `${establishedCount(context, section)}/${section.factKeys.length}`;
    const gap = state.missing[0] ? tableCell(state.missing[0]) : "—";
    return `| ${section.order} | ${tableCell(section.title)} | ${status} | ${facts} | ${gap} |`;
  });

  return [
    "| # | Phase | Gate status | Facts established | First outstanding gap |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/**
 * The one thing to do next.
 *
 * Taken from the FIRST non-passed phase's stored `nextQuestion` — the question
 * the gate itself produced at the point of decision. It is not re-derived and
 * not re-worded here: decideGate() already chose it with the failing criterion
 * in scope, and a second opinion generated from a summary would be a worse one.
 * When there is no stored question, this says so rather than inventing a task.
 */
function renderNextAction(context: DocumentContext): string {
  const head = "## What to do next";

  for (const section of context.sections) {
    const state = phaseStateFor(context.phases, section.phaseKey);
    if (state.status === "passed") {
      continue;
    }
    const question = state.nextQuestion
      ? blockquote(state.nextQuestion)
      : "_No question was recorded by the gate. Re-open the phase in the workflow to get one._";
    return [
      head,
      "",
      `Phase ${section.order} — **${singleLine(section.title)}** — has not passed its gate.`,
      "",
      question,
      "",
      `Full detail: \`${phaseFilePath(section)}\`.`,
    ].join("\n");
  }

  return [
    head,
    "",
    "All eight phases passed their gate. The validation work is done; the build is not.",
    "",
    renderGrounded(groundFact(context.index, "mvp_core_flow"), "Start here"),
  ].join("\n");
}

/** PURE. `.planning/ROADMAP.md`. */
export function renderRoadmap(context: DocumentContext): string {
  return joinSections([
    "# Roadmap",
    `_State of the eight-phase validation workflow as of ${context.generatedOn}._`,
    [
      "> This file records what was **validated**, not what was built. A phase",
      "> marked passed means its exit criteria were evidenced and a gate agreed;",
      "> it does not mean any code exists.",
    ].join("\n"),
    ["## Phase status", "", renderStatusTable(context)].join("\n"),
    renderNextAction(context),
    [
      "## Build plan",
      "",
      "Derived only from facts recorded in phase 6. Anything not established here",
      "is genuinely undecided — decide it deliberately rather than in an editor.",
      "",
      renderGrounded(groundFact(context.index, "mvp_core_flow"), "Core flow"),
      "",
      renderGrounded(
        groundFact(context.index, "mvp_included_features"),
        labelFor("mvp_included_features")
      ),
      "",
      renderGrounded(
        groundFact(context.index, "mvp_excluded_features"),
        labelFor("mvp_excluded_features")
      ),
      "",
      renderGrounded(
        groundFact(context.index, "mvp_success_metric"),
        labelFor("mvp_success_metric")
      ),
      "",
      renderGrounded(
        groundFact(context.index, "mvp_success_threshold"),
        labelFor("mvp_success_threshold")
      ),
      "",
      renderGrounded(
        groundFact(context.index, "mvp_build_weeks"),
        labelFor("mvp_build_weeks")
      ),
      "",
      renderGrounded(
        groundFact(context.index, "mvp_named_first_users"),
        labelFor("mvp_named_first_users")
      ),
    ].join("\n"),
    [
      "## Files",
      "",
      ...context.sections.map(
        (section) =>
          `- \`${phaseFilePath(section)}\` — ${singleLine(section.title)}`
      ),
    ].join("\n"),
  ]);
}

/** PURE. One `.planning/phases/NN-key.md`. */
export function renderPhaseFile(
  context: DocumentContext,
  section: ExportSection
): string {
  const state = phaseStateFor(context.phases, section.phaseKey);

  const verdict = [
    "## Gate verdict",
    "",
    `- Status: **${phaseStatusLabel(state.status, state.decision)}**`,
    `- Decision: ${state.decision ?? "_never evaluated_"}`,
    "",
    state.reason
      ? blockquote(state.reason)
      : "_The gate has never run for this phase._",
  ];

  if (state.missing.length > 0) {
    verdict.push("", "### Outstanding gaps", "", bulletList(state.missing));
  }
  if (state.nextQuestion) {
    verdict.push(
      "",
      "### The question that would close this",
      "",
      blockquote(state.nextQuestion)
    );
  }

  return joinSections([
    `# Phase ${section.order} — ${singleLine(section.title)}`,
    `_Goal: ${singleLine(section.goal)}_`,
    verdict.join("\n"),
    [
      "## What this phase established",
      "",
      ...section.factKeys.flatMap((key) => [
        renderGrounded(groundFact(context.index, key), labelFor(key)),
        "",
      ]),
    ]
      .join("\n")
      .trimEnd(),
  ]);
}

/**
 * PURE. `.planning/FACTS.md` — the raw ledger.
 *
 * Exists so the founder can audit the export against the product: every row
 * that decided anything in PRD.md, with its timestamp, in one table. The PRD is
 * for reading; this is for checking the PRD.
 */
export function renderFactsLedger(context: DocumentContext): string {
  const keys = [
    ...context.sections.flatMap((section) => section.factKeys),
    ...context.unrecognizedKeys,
  ];

  const rows: string[] = [];
  for (const key of keys) {
    const fact = context.index.get(key);
    if (!fact) {
      continue;
    }
    rows.push(
      `| \`${tableCell(key)}\` | ${tableCell(labelFor(key))} | ${originOf(fact)} | ${fact.confidence} | \`${tableCell(fact.phaseKey)}\` | ${fact.updatedAt.toISOString()} | ${tableCell(fact.value)} |`
    );
  }

  const table =
    rows.length === 0
      ? "_No facts were established._"
      : [
          "| Key | What it is | Origin | Confidence | Phase | Last updated (UTC) | Value |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          ...rows,
        ].join("\n");

  return joinSections([
    "# Fact ledger",
    `_Every fact recorded for this project, as of ${context.generatedOn}._`,
    [
      "> This is the evidence base. Every claim in `PRD.md` traces to a row here,",
      "> and anything not here was never established. The Origin column says who",
      "> asserted each row. For an `extracted` row, Confidence is the extractor's",
      "> own certainty at the moment it recorded the fact. For a `founder` row,",
      `> the founder entered or corrected the value by hand, so Confidence is ${FOUNDER_CONFIDENCE_MEANING}.`,
      "> Confidence is not a quality score and it was never revised upwards by",
      "> anything.",
    ].join("\n"),
    table,
  ]);
}

/** PURE. `.planning/OPEN-QUESTIONS.md` — the complete list of what is unknown. */
export function renderOpenQuestions(context: DocumentContext): string {
  const sections = context.sections.map((section) => {
    const state = phaseStateFor(context.phases, section.phaseKey);
    const unknown = section.factKeys
      .filter(
        (key) => groundFact(context.index, key).status === "not-established"
      )
      .map((key) => `\`${key}\` — ${labelFor(key)}`);
    const shaky = section.factKeys
      .filter((key) => {
        const grounded = groundFact(context.index, key);
        return grounded.status === "established" && grounded.band === "low";
      })
      .map((key) => {
        const grounded = groundFact(context.index, key);
        const confidence =
          grounded.status === "established" ? grounded.confidence : 0;
        return `\`${key}\` — ${labelFor(key)} (recorded at ${confidence}/100)`;
      });
    // Same filter as `context.founderAssertedKeys`, narrowed to this phase.
    const asserted = section.factKeys
      .filter((key) => context.founderAssertedKeys.includes(key))
      .map((key) => `\`${key}\` — ${labelFor(key)}`);

    const body = [
      `## Phase ${section.order} — ${singleLine(section.title)}`,
      "",
      `_Gate status: ${phaseStatusLabel(state.status, state.decision)}._`,
      "",
      "**Never answered:**",
      "",
      bulletList(
        unknown,
        "_(nothing — every question in this phase was answered)_"
      ),
      "",
      `**Answered but below ${LOW_CONFIDENCE_CEILING}/100 confidence (extracted):**`,
      "",
      bulletList(shaky, "_(nothing)_"),
      "",
      "**Asserted by the founder, not extracted:**",
      "",
      bulletList(asserted, "_(nothing)_"),
    ];

    if (state.missing.length > 0) {
      body.push(
        "",
        "**Gaps the gate itself named:**",
        "",
        bulletList(state.missing)
      );
    }

    return body.join("\n");
  });

  return joinSections([
    "# Open questions",
    `_As of ${context.generatedOn}. ${context.notEstablishedKeys.length} never answered, ${context.lowConfidenceKeys.length} answered with low confidence, ${context.founderAssertedKeys.length} asserted by the founder rather than extracted._`,
    [
      "> Each item is a question the workflow asked and did not get an evidenced",
      "> answer to. None of them has been guessed at anywhere in this repository.",
      "> If a decision depends on one, answer it before making the decision.",
    ].join("\n"),
    ...sections,
  ]);
}

/** PURE. Every `.planning/` file, in a stable order. */
export function planningFiles(context: DocumentContext): ExportFile[] {
  return [
    { path: ROADMAP_PATH, contents: renderRoadmap(context) },
    { path: FACTS_PATH, contents: renderFactsLedger(context) },
    { path: OPEN_QUESTIONS_PATH, contents: renderOpenQuestions(context) },
    ...context.sections.map((section) => ({
      path: phaseFilePath(section),
      contents: renderPhaseFile(context, section),
    })),
  ];
}
