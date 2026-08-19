#!/usr/bin/env bun
/**
 * END-TO-END DEMO of the phase engine against a real model, with no browser,
 * no database and no Next runtime.
 *
 * It runs the product's actual loop — extract facts from each turn, reconcile
 * them into a store, then judge the accumulated transcript against phase 1's
 * eight exit criteria — and prints what the founder would see.
 *
 * Two scenarios on the SAME idea, so the difference is the founder's evidence
 * and nothing else:
 *   pitch  — the idea as people actually pitch it: enthusiasm, no evidence.
 *   worked — the same founder after doing the work the gate asked for.
 * A gate worth having BLOCKs the first and advances the second. If both come
 * out the same, the gate is decorative and that is the headline.
 *
 * Run:  cd apps/chat && bun scripts/demo-run.ts [pitch|worked|both]
 *
 * Talks to the gateway configured in chat.config.ts and costs a few cents.
 * Deliberately NOT part of any test task — `test:unit` runs with keys unset.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnvConfig } from "dotenv";

const HERE = path.dirname(fileURLToPath(import.meta.url));
loadEnvConfig({ path: path.join(HERE, "../../../.env.local") });

const { config } = await import("../lib/config");
const { getActiveGateway } = await import("../lib/ai/active-gateway");
const { PHASE_ONE } = await import("../lib/phases/definitions");
const { evaluateGate } = await import("../lib/phases/gate");
const { extractFacts, reconcileFacts } = await import("../lib/phases/extract");
const { createModelGateJudge, createModelFactExtractor } = await import(
  "../lib/phases/model-adapters"
);
type ModelUsage = import("../lib/phases/model-adapters").ModelUsage;
const { readFileSync } = await import("node:fs");

type Turn = { role: "user" | "assistant"; text: string };

/**
 * Every model call this script makes, metered. This is a BYOK product: the
 * spend is the user's, and a gated workflow makes two calls per turn (extract,
 * then judge) where a chat wrapper makes one. Printing the meter is the only
 * way "is the gate worth what it costs" becomes an answerable question.
 */
const USAGE: ModelUsage[] = [];
const meter = (u: ModelUsage) => USAGE.push(u);

function summariseUsage(label: string) {
  const byFn = new Map<
    string,
    { calls: number; input: number; output: number }
  >();
  for (const u of USAGE) {
    const row = byFn.get(u.functionId) ?? { calls: 0, input: 0, output: 0 };
    row.calls++;
    row.input += u.inputTokens ?? 0;
    row.output += u.outputTokens ?? 0;
    byFn.set(u.functionId, row);
  }
  process.stdout.write(`\n  TOKENS (${label})\n`);
  let totalIn = 0;
  let totalOut = 0;
  for (const [fn, row] of byFn) {
    process.stdout.write(
      `    ${fn.padEnd(14)} ${String(row.calls).padStart(3)} calls  in ${row.input.toLocaleString().padStart(8)}  out ${row.output.toLocaleString().padStart(7)}\n`
    );
    totalIn += row.input;
    totalOut += row.output;
  }
  process.stdout.write(
    `    ${"TOTAL".padEnd(14)} ${String(USAGE.length).padStart(3)} calls  in ${totalIn.toLocaleString().padStart(8)}  out ${totalOut.toLocaleString().padStart(7)}\n`
  );
  return { totalIn, totalOut, calls: USAGE.length };
}
type Fact = { key: string; value: string; confidence: number };

/**
 * runtime.ts's loadPrompt lives behind `server-only` and pulls in the database,
 * so this mirrors it rather than importing it: same path, same comment
 * stripping. Kept to two lines so drift is obvious.
 */
function loadPrompt(rel: string): string {
  return readFileSync(path.join(HERE, "../prompts", rel), "utf8")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
}

const personaPrompt = [
  loadPrompt("persona/honesty-protocol.md"),
  loadPrompt("persona/problem-validation-rubric.md"),
].join("\n\n---\n\n");
const phasePrompt = loadPrompt(PHASE_ONE.promptFile);

// ─────────────────────────────────────────────────────────────────────────────
// The scenarios.
// ─────────────────────────────────────────────────────────────────────────────

const t = (role: "user" | "assistant", text: string): Turn => ({ role, text });

/**
 * The idea as it arrives: a solution, a category, and a lot of belief. No named
 * person, no observed behaviour, no money. Every criterion phase 1 defines is
 * unevidenced, and two of the rubric's explicit kill triggers are live —
 * nobody has tried a workaround, and willingness to pay is hypothetical.
 */
const PITCH: Turn[] = [
  t(
    "user",
    "I want to build a social network for dogs. Basically Instagram but every profile is a dog — owners post photos, dogs 'follow' each other, and you can arrange playdates with dogs nearby. Dog people are obsessed, the market is massive, and nobody has built a good one."
  ),
  t(
    "assistant",
    "Who specifically has told you they have a problem here, and what were they doing when it came up?"
  ),
  t(
    "user",
    "Honestly everyone with a dog would use this. My girlfriend has a golden retriever with 4,000 followers on Instagram and she says the dog community there is huge but Instagram isn't built for it — the algorithm buries dog posts and there's no way to find dogs near you. Pet industry is like $150 billion a year in the US alone."
  ),
  t(
    "assistant",
    "Has anyone described a specific time this cost them something, or tried to solve it themselves?"
  ),
  t(
    "user",
    "Not really tried to solve it as such — people just post on Instagram and grumble about the reach. There are Facebook groups for local dog owners, I guess. But nobody's built a dedicated thing, which to me is the opportunity. I posted the concept in a dog owners subreddit and got 200 upvotes and loads of people saying they'd download it."
  ),
  t("assistant", "Would anyone pay for it?"),
  t(
    "user",
    "It'd be free with ads, and later maybe premium features. When I asked in the subreddit a bunch of people said they'd pay a couple of quid a month for something good. I think once we have the network effects the monetisation basically takes care of itself. Can we move on to designing the app?"
  ),
];

/**
 * The SAME founder after the gate sent them away. The idea has narrowed from
 * "dogs" to one segment with a real, dated, expensive problem, and every claim
 * is now backed by a type of evidence the rubric accepts: observed behaviour,
 * money already spent, and named numbers. Note the idea itself barely survived
 * contact with the evidence — that is the product working, not failing.
 */
const WORKED: Turn[] = [
  t(
    "user",
    "I dropped the general dog social network. Going through my notes from the subreddit thread, the only people describing an actual cost were owners of reactive dogs — dogs that lunge or bark at other dogs — who cannot use normal dog parks. I've since interviewed 11 of them, recruited from three reactive-dog Facebook groups, not from my own network."
  ),
  t(
    "assistant",
    "What is the problem in their words, and how often does it happen?"
  ),
  t(
    "user",
    "They need somewhere to walk and train their dog without meeting another dog off-lead. Every single one described the same thing: they walk at 5-6am or after dark to avoid other dogs. I asked all 11 to walk me through the last fortnight from their phone's step data and photos — between them that was 154 walks, and 138 were before 7am or after 8pm. Nine of the eleven have had an incident in the last year: two ended in a vet bill (£340 and £190, I saw both), one in a formal complaint to the council."
  ),
  t("assistant", "What do they already do about it?"),
  t(
    "user",
    "Six of the eleven pay for private secure dog fields — that's a real UK market, you book a fenced acre by the hour on an app called Dogs Day Out or through the field owner's Facebook page. They pay £8-15 an hour and go 2-4 times a week. Two of them showed me their booking history: £62 and £96 in the last month. Three more drive 20-40 minutes each way to a quiet spot they've found, and one has a WhatsApp group of four local reactive-dog owners who coordinate so they never overlap on the same route. Only one does nothing, and she has stopped walking her dog in daylight entirely."
  ),
  t("assistant", "Willingness to pay?"),
  t(
    "user",
    "It's already leaving their accounts — £62 and £96 a month on field hire, verified from booking histories, and that's for a booking experience they all complained about: no way to see which fields are free now, no way to know if the field before you overran, and Facebook-page booking means messaging a stranger and waiting. Four of the eleven named a number for a booking app without me prompting: £4, £5, £5 and £10 a month. One field owner I called said she turns away bookings because her calendar is a paper diary. Frequency 5, intensity 4, workarounds 5, willingness 4 — that's 400 on the rubric."
  ),
];

const SCENARIOS = {
  pitch: { label: "PITCH — the idea as pitched", turns: PITCH },
  worked: {
    label: "WORKED — same founder, after doing the work",
    turns: WORKED,
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────────

function pairTurns(turns: Turn[]): Turn[][] {
  const pairs: Turn[][] = [];
  for (let i = 0; i < turns.length; i += 2) {
    pairs.push(turns.slice(i, i + 2));
  }
  return pairs;
}

async function runScenario(name: keyof typeof SCENARIOS) {
  const scenario = SCENARIOS[name];
  const gateway = getActiveGateway();
  const chatModel = gateway.createLanguageModel(
    config.ai.workflows.chat as never
  );
  const cheapModel = gateway.createLanguageModel(
    config.ai.workflows.title as never
  );

  process.stdout.write(
    `\n${"═".repeat(78)}\n${scenario.label}\n${"═".repeat(78)}\n`
  );

  // 1. Extraction, turn pair by turn pair — exactly how runtime.ts does it.
  let facts: Fact[] = [];
  for (const [i, turn] of pairTurns(scenario.turns).entries()) {
    const extracted = await extractFacts(
      {
        extract: createModelFactExtractor({
          model: cheapModel,
          onUsage: meter,
        }),
        onError: (e, stage) => process.stdout.write(`  ! ${stage}: ${e}\n`),
      },
      { phase: PHASE_ONE, personaPrompt, turn, knownFacts: facts }
    );
    const { inserts, updates } = reconcileFacts(facts, extracted);
    const byKey = new Map(facts.map((f) => [f.key, f]));
    for (const f of [...inserts, ...updates]) {
      byKey.set(f.key, {
        key: f.key,
        value: f.value,
        confidence: f.confidence,
      });
    }
    facts = [...byKey.values()];
    process.stdout.write(
      `  turn ${i + 1}: +${inserts.length} new, ${updates.length} updated → ${facts.length} facts\n`
    );
  }

  process.stdout.write(`\n  ESTABLISHED FACTS (${facts.length})\n`);
  for (const f of [...facts].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    const value = f.value.length > 96 ? `${f.value.slice(0, 96)}…` : f.value;
    process.stdout.write(`    ${f.key} (${f.confidence}) — ${value}\n`);
  }

  // 2. The gate.
  const verdict = await evaluateGate(
    { judge: createModelGateJudge({ model: chatModel, onUsage: meter }) },
    {
      phase: PHASE_ONE,
      personaPrompt,
      phasePrompt,
      transcript: scenario.turns,
      facts,
    }
  );

  process.stdout.write(`\n  GATE: ${verdict.decision}\n  ${verdict.reason}\n`);
  if (verdict.missing.length > 0) {
    process.stdout.write("\n  WHAT IS MISSING\n");
    for (const m of verdict.missing) {
      process.stdout.write(`    • ${m}\n`);
    }
  }
  if (verdict.nextQuestion) {
    process.stdout.write(
      `\n  NEXT QUESTION TO THE FOUNDER\n    ${verdict.nextQuestion}\n`
    );
  }

  process.stdout.write("\n  PER CRITERION\n");
  for (const e of verdict.perCriterion) {
    const severity =
      PHASE_ONE.exitCriteria.find((c) => c.id === e.criterionId)?.severity ??
      "blocking";
    process.stdout.write(
      `    ${e.status.padEnd(14)} ${e.criterionId} [${severity}]\n`
    );
  }
  return verdict.decision;
}

const arg = (process.argv[2] ?? "both") as keyof typeof SCENARIOS | "both";
const names: (keyof typeof SCENARIOS)[] =
  arg === "both" ? ["pitch", "worked"] : [arg];

const results: Record<string, string> = {};
for (const name of names) {
  results[name] = await runScenario(name);
}

process.stdout.write(`\n${"═".repeat(78)}\nSUMMARY\n`);
summariseUsage(names.join(" + "));
process.stdout.write("\n");
for (const [name, decision] of Object.entries(results)) {
  process.stdout.write(`  ${name.padEnd(8)} → ${decision}\n`);
}
if (results.pitch && results.worked) {
  const discriminates = results.pitch === "BLOCK" && results.worked !== "BLOCK";
  process.stdout.write(
    `\n  ${discriminates ? "✓" : "✗"} the gate ${discriminates ? "discriminates" : "DOES NOT discriminate"} between the two.\n`
  );
}
process.stdout.write("\n");
