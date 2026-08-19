import { type DocumentContext, groundFact, renderGrounded } from "./grounding";
import { joinSections, singleLine } from "./markdown";
import { FACTS_PATH, OPEN_QUESTIONS_PATH, ROADMAP_PATH } from "./planning";
import type { ExportFile } from "./types";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE REPO SCAFFOLD — and the code it deliberately does NOT contain.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * THE DECISION, FLAGGED: this export scaffolds a DOCUMENTATION repository, not
 * an application. No package.json, no framework, no src/, no CI.
 *
 * Not laziness — the eight phases define 66 fact keys and NONE of them records
 * a technology choice. Emitting a Next.js scaffold would mean the export
 * inventing the single most consequential decision in the repo and committing
 * it, under a banner claiming everything here is evidence-backed. That is
 * exactly the "launders a guess as a finding" failure this whole product
 * exists to prevent, and it would be the first thing the founder sees.
 *
 * What the founder gets instead is a real git repository containing the
 * validated plan, an agent contract, and an accurate list of what is still
 * unknown — which is the correct INPUT to a scaffolding tool, and lets them run
 * `create-next-app`, `cargo new` or nothing at all, deliberately.
 *
 * If a `tech_stack` fact key is ever added to a phase definition, revisit this:
 * a stack that was argued for through a gate would be groundable, and then
 * emitting it would be reporting rather than guessing.
 *
 * PURE.
 */

/**
 * `.gitignore` covering several ecosystems at once.
 *
 * Deliberately broad BECAUSE the stack is not established (see above). The cost
 * of an unused rule is zero; the cost of a missing one is a founder committing
 * `.env` with their API keys into the first repository this product ever gave
 * them. Asymmetric, so err wide.
 */
const GITIGNORE = `# Secrets. First rule for a reason: this repo is likely to be shared or made
# public, and the export cannot know which ecosystem's secret file you will use.
.env
.env.*
!.env.example
*.pem
*.key

# Dependencies
node_modules/
vendor/
.venv/
venv/
__pycache__/
target/

# Build output
dist/
build/
out/
.next/
*.egg-info/

# Editors and OS
.DS_Store
Thumbs.db
.idea/
.vscode/
*.swp

# Logs and local scratch
*.log
.cache/
tmp/
`;

/**
 * `.gitattributes` pinning LF.
 *
 * The export promises byte-identical output for identical project state. On a
 * Windows checkout with `core.autocrlf=true`, git would rewrite every generated
 * file to CRLF and the next export would show a whole-file diff that means
 * nothing. Pinning eol=lf makes the promise true on every platform.
 */
const GITATTRIBUTES = `* text=auto eol=lf
`;

function renderReadme(context: DocumentContext): string {
  const name = singleLine(context.project.name) || context.repoName;
  const { readiness } = context;

  return joinSections([
    `# ${name}`,
    [
      `> Exported on ${context.generatedOn} from an eight-phase validation workflow.`,
      ">",
      `> ${readiness.passedPhaseKeys.length} of ${readiness.phaseCount} phases passed their gate.`,
      `> ${readiness.factCount} facts established, ${context.notEstablishedKeys.length} questions still open.`,
    ].join("\n"),
    renderGrounded(
      groundFact(context.index, "problem_statement"),
      "The problem"
    ),
    renderGrounded(
      groundFact(context.index, "solution_concept"),
      "The proposed solution"
    ),
    [
      "## What is in this repository",
      "",
      "| File | What it is |",
      "| --- | --- |",
      "| `PRD.md` | Every established fact, with its confidence and the phase that produced it. |",
      "| `CLAUDE.md` | The operating contract for any AI agent working here. Read it first. |",
      `| \`${ROADMAP_PATH}\` | The eight phases, their gate status, and what to do next. |`,
      `| \`${OPEN_QUESTIONS_PATH}\` | Everything the workflow asked and never got an evidenced answer to. |`,
      `| \`${FACTS_PATH}\` | The raw fact ledger, for auditing the documents above. |`,
      "| `.planning/phases/` | One file per phase: goal, exit criteria, gate verdict. |",
    ].join("\n"),
    [
      "## What is NOT in this repository",
      "",
      "**No application code, and no technology choice.**",
      "",
      "The validation workflow never asked which stack to build on, so no fact",
      "records one — and this export will not invent the most consequential",
      "decision in the project and then present it under a banner claiming",
      "everything here is evidence-backed. Choose the stack deliberately, then",
      "scaffold it into this repository.",
      "",
      "**No licence file.** Licensing is a decision with legal consequences; a",
      "default would be a guess made on your behalf.",
    ].join("\n"),
    [
      "## Using this with a coding agent",
      "",
      "1. Open this directory with your agent of choice.",
      "2. Point it at `CLAUDE.md`. It states the one rule that matters: the fact",
      "   ledger is the only source of truth, and anything missing from it must be",
      "   asked about rather than assumed.",
      `3. Work through \`${ROADMAP_PATH}\`.`,
      "",
      "Every quoted block in every generated file is a recorded fact, reproduced",
      "verbatim. Everything outside a quote is template wording and asserts",
      "nothing about this project.",
    ].join("\n"),
  ]);
}

/** PURE. The scaffold files: README, .gitignore, .gitattributes. */
export function scaffoldFiles(context: DocumentContext): ExportFile[] {
  return [
    { path: "README.md", contents: renderReadme(context) },
    { path: ".gitignore", contents: GITIGNORE },
    { path: ".gitattributes", contents: GITATTRIBUTES },
  ];
}
