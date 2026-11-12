import { renderFactLine, type StoredFact } from "@/lib/phases/context";
import {
  type DocumentContext,
  groundFact,
  LOW_CONFIDENCE_CEILING,
  labelFor,
  renderGrounded,
} from "./grounding";
import { bulletList, joinSections, singleLine } from "./markdown";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * CLAUDE.md for the EXPORTED repository.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This is not documentation. It is the operating contract for whichever coding
 * agent the founder points at the repo next, and it is the last place this
 * product can enforce its own rule after the founder has walked away.
 *
 * THE FAILURE MODE IT EXISTS TO PREVENT: the founder opens Claude Code in the
 * exported repo and says "build this". The agent reads a PRD full of confident
 * prose, finds a gap, and — being helpful — fills it in with a plausible
 * assumption. Two weeks later the founder is building against a market size,
 * a price and a persona that nobody ever evidenced, and the eight gates they
 * sat through have been quietly undone by one turn of autocomplete.
 *
 * So this file does three things, in this order:
 *   1. States the ledger as the ONLY source of project truth, and names the
 *      required behaviour when something is missing: ask, do not assume.
 *   2. Reproduces the ledger in the SAME line format the gate judge read
 *      (lib/phases/context.ts `renderFactLine`), so the downstream agent and
 *      the upstream gate are looking at byte-identical evidence. A second
 *      rendering of the same facts would be a second source of truth.
 *   3. Names what is missing and what is shaky, explicitly, so "not in the
 *      ledger" is checkable rather than something the agent has to notice.
 *
 * PURE. Takes a DocumentContext, returns a string.
 */

const NEWLINE_RUN = /\s*\n\s*/g;

/**
 * Fact values are free text and can contain newlines; `renderFactLine` emits a
 * single `- key: value` list item. A raw newline would end the list item and
 * dump the rest of the value into the document as body text — where an agent
 * reads it as an instruction rather than as data. Flatten first, and flatten
 * with a visible separator so the founder can see something was joined.
 */
function flattenForLedger(fact: StoredFact): StoredFact {
  return { ...fact, value: singleLine(fact.value.replace(NEWLINE_RUN, " / ")) };
}

/**
 * The ledger, in phase order then unrecognised keys.
 *
 * Deterministic ordering matters more than it looks: this file is committed,
 * and a set-iteration-order ledger would produce a spurious diff on every
 * re-export, training the founder to ignore the diff that eventually matters.
 */
function renderLedger(context: DocumentContext): string {
  const lines: string[] = [];
  for (const section of context.sections) {
    for (const key of section.factKeys) {
      const fact = context.index.get(key);
      if (fact) {
        lines.push(renderFactLine(flattenForLedger(fact)));
      }
    }
  }
  for (const key of context.unrecognizedKeys) {
    const fact = context.index.get(key);
    if (fact) {
      lines.push(renderFactLine(flattenForLedger(fact)));
    }
  }

  if (lines.length === 0) {
    return "(none established yet)";
  }
  return lines.join("\n");
}

function renderRules(context: DocumentContext): string {
  return [
    "## Rules for any agent working in this repository",
    "",
    "1. **The fact ledger below is the only source of truth about this project.**",
    "   It was produced by an eight-phase workflow that refused to advance until",
    "   each claim was evidenced.",
    "2. **If something you need is not in the ledger, it is not known.** Do not",
    "   infer it, do not pick a reasonable default, and do not write it into a",
    "   file as though it were settled. Say which fact is missing and ask.",
    `3. **Facts recorded below ${LOW_CONFIDENCE_CEILING}/100 confidence are not decisions.**`,
    "   They are listed under “Not yet verified”. Treat them the same way you",
    "   treat a missing fact.",
    "4. **A ledger line marked “asserted by the founder, not extracted” is the",
    "   founder's own claim.** It was typed or corrected by hand and no extractor",
    "   judged it, so its confidence number is not a certainty. Those facts are",
    "   listed under “Asserted by the founder”; re-evidence them before building",
    "   on them.",
    "5. **Do not implement anything listed as out of scope.** Scope exclusions",
    "   were argued for explicitly; re-adding them silently is the single easiest",
    "   way to blow the build window.",
    "6. **When you learn something new, write it down** in `.planning/` and say",
    "   where the evidence came from. A fact with no evidence is a guess with",
    "   better formatting.",
    "",
    `Full reasoning, provenance and open questions: \`PRD.md\` and \`.planning/\`. This file was generated on ${context.generatedOn}.`,
  ].join("\n");
}

function renderWhatThisIs(context: DocumentContext): string {
  return [
    "## What this project is",
    "",
    renderGrounded(
      groundFact(context.index, "problem_statement"),
      "The problem"
    ),
    "",
    renderGrounded(
      groundFact(context.index, "solution_concept"),
      "The solution"
    ),
    "",
    renderGrounded(groundFact(context.index, "target_user"), "Who it is for"),
  ].join("\n");
}

function renderBuildScope(context: DocumentContext): string {
  const keys = [
    "mvp_core_flow",
    "mvp_included_features",
    "mvp_excluded_features",
    "excluded_scope",
    "mvp_manual_parts",
    "mvp_success_metric",
    "mvp_success_threshold",
    "mvp_build_weeks",
  ];

  return [
    "## What to build, and what not to build",
    "",
    ...keys.flatMap((key) => [
      renderGrounded(groundFact(context.index, key), labelFor(key)),
      "",
    ]),
  ]
    .join("\n")
    .trimEnd();
}

function renderGaps(context: DocumentContext): string {
  const unverified = context.lowConfidenceKeys.map(
    (key) => `\`${key}\` — ${labelFor(key)}`
  );
  const asserted = context.founderAssertedKeys.map(
    (key) => `\`${key}\` — ${labelFor(key)}`
  );
  const unknown = context.notEstablishedKeys.map(
    (key) => `\`${key}\` — ${labelFor(key)}`
  );

  return [
    "## Not yet verified",
    "",
    `Extracted, but recorded below ${LOW_CONFIDENCE_CEILING}/100 confidence. Do not treat as decided:`,
    "",
    bulletList(
      unverified,
      "_(none — every extracted fact is above the floor)_"
    ),
    "",
    "## Asserted by the founder",
    "",
    "Typed or corrected by the founder, not extracted, so the confidence number beside each is not a certainty. Treat as the founder's claim and re-evidence before building on it:",
    "",
    bulletList(asserted, "_(none — every recorded fact was extracted)_"),
    "",
    "## Never established",
    "",
    "No evidence was ever recorded for these. If your task needs one, stop and ask:",
    "",
    bulletList(unknown, "_(none — the workflow answered every question)_"),
  ].join("\n");
}

/** PURE. CLAUDE.md for the exported repo. */
export function renderClaudeMd(context: DocumentContext): string {
  const name = singleLine(context.project.name) || context.repoName;

  return joinSections([
    "# CLAUDE.md",
    `Operating instructions for AI agents working in **${name}**.`,
    renderRules(context),
    renderWhatThisIs(context),
    renderBuildScope(context),
    // The ledger heading is byte-identical to lib/phases/context.ts
    // FACT_BLOCK_HEADING for the same reason the lines are: one shape, one
    // meaning, whether a gate judge or a coding agent is reading it.
    ["## Established project facts", "", renderLedger(context)].join("\n"),
    renderGaps(context),
    [
      "## Where everything lives",
      "",
      "- `PRD.md` — every fact in full, with provenance and confidence.",
      "- `.planning/ROADMAP.md` — the eight phases, their gate status and what remains.",
      "- `.planning/OPEN-QUESTIONS.md` — everything still unanswered.",
      "- `.planning/FACTS.md` — the raw fact ledger with timestamps.",
      "- `.planning/phases/` — one file per phase: goal, exit criteria, verdict.",
    ].join("\n"),
  ]);
}

/**
 * PURE. `AGENTS.md` — a POINTER, deliberately not a copy.
 *
 * The agents.md convention and CLAUDE.md are read by different tools, and the
 * obvious move is to write the same content twice. Two copies drift, and the
 * founder has no way to know which one their tool read. One file, one pointer.
 */
export function renderAgentsMd(context: DocumentContext): string {
  const name = singleLine(context.project.name) || context.repoName;
  return joinSections([
    "# AGENTS.md",
    `Instructions for AI agents working in **${name}** live in [CLAUDE.md](./CLAUDE.md).`,
    "This file is a pointer on purpose. Duplicating the rules here would create a",
    "second copy that drifts, and neither copy would be knowably the current one.",
  ]);
}
