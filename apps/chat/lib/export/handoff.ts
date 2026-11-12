import { renderAgentsMd, renderClaudeMd } from "./claude-md";
import {
  buildDocumentContext,
  buildFactIndex,
  decideExportReadiness,
  groundFact,
} from "./grounding";
import { assertSafeTree, pickRepoName } from "./paths";
import { personaFiles } from "./persona";
import { planningFiles } from "./planning";
import { renderPrd } from "./prd";
import { scaffoldFiles } from "./scaffold";
import type {
  BuildHandoffInput,
  ExportFile,
  HandoffOutcome,
  HandoffPlan,
} from "./types";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE HANDOFF. Pure half above the line, one injected seam below it.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Structure copied deliberately from lib/phases/gate.ts:
 *
 *   (a) buildHandoff()  — PURE. Decides every path and every byte. No fs, no
 *                          git, no clock, no model. Fully unit-tested.
 *   (b) runHandoff()    — ONE async function, ONE injected writer. REMOVED:
 *                          nothing implemented the writer in production.
 *
 * The reason is not aesthetic. A bug in content generation ships a broken
 * repository to a founder who has, by construction, just finished using the
 * product and has nowhere to complain to. Content generation therefore has to
 * be testable without a filesystem, and the only way to guarantee that is for
 * the code that decides content to be incapable of touching one.
 *
 * lib/export/* never imports node:fs, node:child_process, "ai",
 * "@/lib/ai/providers" or "@/lib/db/*". There is no exception any more: the one
 * impure file, `node-writer.ts`, was deleted (see the note at the foot of this
 * file), and the caller that does I/O is `app/actions/build-handoff.ts`.
 */

/**
 * PURE. Choose the repo directory name.
 *
 * ORDER OF PREFERENCE, and why each candidate is untrusted:
 *   1. An explicit override from the caller (a UI field the founder typed).
 *   2. `Project.name` — typed by the founder, sometimes model-suggested.
 *   3. The `solution_concept` fact — MODEL-WRITTEN TEXT. This is the candidate
 *      that makes path safety load-bearing rather than theoretical: a fact
 *      value of `../../../../etc/passwd` genuinely reaches this function.
 *   4. FALLBACK_REPO_NAME.
 *
 * Every candidate goes through slugifySegment(), whose output alphabet is
 * [a-z0-9-]. Traversal is not filtered out; it is unrepresentable.
 */
export function deriveRepoName(input: BuildHandoffInput): string {
  const index = buildFactIndex(input.facts);
  const concept = groundFact(index, "solution_concept");
  const problem = groundFact(index, "problem_statement");

  return pickRepoName([
    input.repoName ?? "",
    input.project.name,
    concept.status === "established" ? concept.value : "",
    problem.status === "established" ? problem.value : "",
  ]);
}

/**
 * The first-commit message.
 *
 * CONTAINS NO FACT VALUES, only counts. Two reasons: a commit subject is a
 * single line and a fact value is arbitrary multi-line text, and a commit
 * message is the one artefact that gets pasted into shells, CI logs and issue
 * trackers by tools this export does not control. Counts are safe, stable, and
 * are the thing a reader actually wants from a generated commit.
 */
function buildCommitMessage(plan: Omit<HandoffPlan, "commitMessage">): string {
  const {
    readiness,
    notEstablishedKeys,
    lowConfidenceKeys,
    founderAssertedKeys,
    files,
  } = plan;
  return [
    "Initial handoff export",
    "",
    `Generated from an eight-phase validation workflow: ${readiness.passedPhaseKeys.length} of ${readiness.phaseCount} phases passed their gate.`,
    "",
    `- ${readiness.factCount} facts established`,
    `- ${notEstablishedKeys.length} questions never answered`,
    `- ${lowConfidenceKeys.length} extracted facts below the confidence floor`,
    `- ${founderAssertedKeys.length} facts asserted by the founder, not extracted`,
    `- ${files.length} files written`,
    "",
    "Every project-specific claim in these files is copied from a recorded fact",
    "or explicitly marked as not established. Nothing was inferred.",
  ].join("\n");
}

/**
 * PURE. Build the complete described repository, or refuse.
 *
 * REFUSAL IS A FEATURE, and it is the same empty-set guard decideGate() applies
 * (EMPTY-SET GUARD C): a project with zero established facts has established
 * nothing, and an export of nothing is a repository whose every section reads
 * "not established". From ten feet away that looks like a plan, and the founder
 * would circulate it. There is no honest document to generate here, so none is
 * generated.
 *
 * Note that a project with ONE fact does NOT refuse. Partial is legitimate —
 * the documents say exactly which parts are missing, which is useful. Zero is
 * not partial; it is absent.
 */
export function buildHandoff(input: BuildHandoffInput): HandoffOutcome {
  const readiness = decideExportReadiness({
    facts: input.facts,
    phases: input.phases,
  });

  if (readiness.level === "empty") {
    return {
      status: "refused",
      reason: readiness.reason,
      readiness,
    };
  }

  const repoName = deriveRepoName(input);
  const context = buildDocumentContext({
    project: input.project,
    repoName,
    facts: input.facts,
    phases: input.phases,
    generatedAt: input.generatedAt,
  });

  const files: ExportFile[] = [
    ...scaffoldFiles(context),
    { path: "PRD.md", contents: renderPrd(context) },
    { path: "CLAUDE.md", contents: renderClaudeMd(context) },
    { path: "AGENTS.md", contents: renderAgentsMd(context) },
    ...personaFiles(context, input.personas),
    ...planningFiles(context),
  ];

  // Sorted by code point, not localeCompare: the file ORDER is what the writer
  // walks and what the commit records, so a locale-dependent sort would make
  // two machines produce different git trees from the same project state.
  files.sort((a, b) => (a.path < b.path ? -1 : 1));

  // THE CHOKE POINT. Runs on our own hard-coded paths as well as the derived
  // ones — the literals are safe today, and this is the tripwire for the day
  // someone interpolates a variable into one of them.
  assertSafeTree(files);

  const partial = {
    repoName,
    files,
    readiness,
    notEstablishedKeys: [...context.notEstablishedKeys],
    lowConfidenceKeys: [...context.lowConfidenceKeys],
    founderAssertedKeys: [...context.founderAssertedKeys],
    unrecognizedKeys: [...context.unrecognizedKeys],
  };

  return {
    status: "ready",
    readiness,
    plan: { ...partial, commitMessage: buildCommitMessage(partial) },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// (b) THE IMPURE PART IS GONE.
//
// `runHandoff` and its `HandoffDeps` seam were removed on 2026-08-21. The only
// implementation of that seam was `lib/export/node-writer.ts`, which nothing
// imported either — so the whole write path was finished, tested and
// unreachable. The live export is `app/actions/build-handoff.ts`, which calls
// the pure `buildHandoff` above and streams the plan to the browser rather than
// writing a git repository on the server.
//
// If server-side writing comes back, both halves are recoverable from git. Do
// not reintroduce the seam without a caller: that is how this became dead the
// first time.
// ─────────────────────────────────────────────────────────────────────────────
