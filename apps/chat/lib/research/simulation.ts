import { z } from "zod";

/**
 * STEP 8 — OASIS PERSONA SIMULATION, app side.
 *
 * Spawns persona agents seeded from stored project facts and generated
 * personas, simulates their reaction to a pitch, and feeds the result into
 * "Verifying Demand". buildpad has no equivalent.
 *
 * WHAT THIS IS NOT. A simulated reaction is NOT demand evidence. Ten synthetic
 * personas agreeing that an idea is good is ten samples from one language
 * model's prior, and treating it as market signal is exactly the "credit
 * enthusiasm as evidence" failure the persona prompt exists to prevent. So the
 * output of this module is explicitly typed as a HYPOTHESIS GENERATOR: it
 * surfaces objections worth going and asking a real human about, and
 * `SimulationVerdict.usableAsEvidence` is hard-wired `false`. The gate must
 * never accept it in place of a permalink.
 *
 * OASIS runs in `apps/research` (Python), not here: `import oasis` eagerly
 * pulls torch, sentence-transformers and scikit-learn
 * (`oasis/social_platform/recsys.py:26-29` @ 40bf1705) and probes CUDA at
 * import time. That belongs in a sidecar image, not in a Next.js server bundle.
 *
 * SHAPE: pure half (seed construction, divergence, verdict) fully unit-tested;
 * one injected async seam for the sidecar call.
 */

// ─────────────────────────────────────────────────────────────────────────────
// (a) THE SEED. Pure construction of what OASIS actually requires.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * OASIS's `generate_reddit_agent_graph` reads a JSON array and indexes SEVEN
 * keys per entry with no `.get()` and no default
 * (`oasis/social_agent/agents_generator.py:573-596` @ 40bf1705):
 *
 *     profile["other_info"]["user_profile"] = agent_info[i]["persona"]
 *     profile["other_info"]["mbti"]         = agent_info[i]["mbti"]
 *     profile["other_info"]["gender"]       = agent_info[i]["gender"]
 *     profile["other_info"]["age"]          = agent_info[i]["age"]
 *     profile["other_info"]["country"]      = agent_info[i]["country"]
 *     user_info = UserInfo(name=agent_info[i]["username"],
 *                          description=agent_info[i]["bio"], ...)
 *
 * A missing key is a `KeyError` deep inside an async generator, surfacing as an
 * opaque 500 from the sidecar. So the shape is enforced HERE, in a pure
 * function with tests, where the failure names the persona and the field.
 */
export const OasisPersonaSchema = z.object({
  username: z.string().min(1),
  bio: z.string().min(1),
  persona: z.string().min(1),
  age: z.number().int().min(13).max(120),
  gender: z.string().min(1),
  mbti: z.string().min(1),
  country: z.string().min(1),
});

export type OasisPersona = z.infer<typeof OasisPersonaSchema>;

/** A persona as the product knows it, before it is flattened for OASIS. */
export type ProjectPersona = {
  id: string;
  name: string;
  /** One-paragraph description. Becomes OASIS's `persona`. */
  description: string;
  /** Becomes OASIS's `bio`. */
  headline: string;
  age: number;
  gender: string;
  country: string;
  /**
   * Optional. OASIS requires the field, so `toOasisPersona` supplies a neutral
   * placeholder rather than letting the sidecar `KeyError` — but the
   * placeholder is a named constant so it is greppable and obviously synthetic.
   */
  mbti?: string;
};

/** What OASIS needs but our persona schema does not model. */
export const UNSPECIFIED_MBTI = "XXXX";

// Hoisted: biome bars regex literals inside frequently-called scopes.
const NON_SLUG_CHARS = /[^a-z0-9]+/g;
const HAS_ALPHANUMERIC = /[a-z0-9]/;
const NON_WORD_CHARS = /[^\p{L}\p{N}\s]/gu;
const WHITESPACE = /\s+/;

export type PersonaSeedResult =
  | { ok: true; personas: OasisPersona[] }
  | { ok: false; problems: string[] };

/**
 * THE LARGEST ONE PERSONA ENTRY MAY BE, measured as its JSON (`JSON.stringify`
 * of the object sent to the sidecar). Every agent's prompt carries its entry on
 * every round, so this bounds what each model call costs.
 *
 * HOW IT IS SIZED, from how an entry is built:
 *   - the short fields come from the seat form and are bounded there
 *     (handle 64, gender 60, country 120, MBTI 8 — save-simulation-profile.ts),
 *     so with the keys they stay under ~400 characters;
 *   - `bio` is the persona's role line, and `persona` is
 *     `renderPersonaMarkdown` of the generated persona: about a dozen short
 *     sections with their evidence quotes, a few thousand characters;
 *   - then the project's facts. That is the unbounded part: 66 fact keys across
 *     the eight phases, each value up to 2,000 characters, so a late-stage
 *     project could append well over 100,000 characters to EVERY agent.
 * 16,000 characters (about 4,000 tokens) keeps the whole persona and a
 * substantial fact block, and puts one agent-round near the 0.1¢ that
 * `estimateSimulationCostCents` charges for it. Facts that do not fit are left
 * out with a sentence saying how many (`withFactContext`), never silently.
 *
 * MIRRORED as `MAX_PERSONA_ENTRY_CHARS` in apps/research/app/main.py, measured
 * the same way. Change both together.
 */
export const MAX_PERSONA_ENTRY_CHARS = 16_000;

const FACT_CONTEXT_PREAMBLE =
  "\n\nWhat is already established about the product being discussed: ";
const FACT_SEPARATOR = "; ";

/**
 * Room always kept free for the preamble and the omission sentence, so a
 * persona that is seated always has space to say that facts were left out.
 */
const FACT_CONTEXT_RESERVE_CHARS = 400;

function jsonLength(value: unknown): number {
  return JSON.stringify(value).length;
}

/** The characters `text` occupies inside a JSON string, quotes excluded. */
function escapedLength(text: string): number {
  return JSON.stringify(text).length - 2;
}

function factOmissionNote(omitted: number): string {
  return ` (${omitted} established fact${omitted === 1 ? "" : "s"} about the product not shown here, to keep this persona within the simulation's size limit.)`;
}

/**
 * PURE. `description` plus as many of `factLines` as fit in `room` JSON
 * characters, in stored order; a fact too long for the remaining room is
 * skipped and a shorter later one may still fit. When any is left out, the text
 * says how many, so the agent (and anyone reading the trace) knows the block is
 * partial rather than taking it for everything the founder established.
 */
export function withFactContext(
  description: string,
  factLines: readonly string[],
  room: number
): string {
  if (factLines.length === 0) {
    return description;
  }
  const full = `${FACT_CONTEXT_PREAMBLE}${factLines.join(FACT_SEPARATOR)}`;
  if (escapedLength(full) <= room) {
    return `${description}${full}`;
  }

  // The note is sized for the worst case (every fact omitted), so the result
  // fits whatever the final count turns out to be.
  const budget =
    room -
    escapedLength(FACT_CONTEXT_PREAMBLE) -
    escapedLength(factOmissionNote(factLines.length));
  const kept: string[] = [];
  let used = 0;
  for (const line of factLines) {
    const cost =
      escapedLength(line) + (kept.length > 0 ? FACT_SEPARATOR.length : 0);
    if (used + cost <= budget) {
      kept.push(line);
      used += cost;
    }
  }
  return `${description}${FACT_CONTEXT_PREAMBLE}${kept.join(FACT_SEPARATOR)}${factOmissionNote(factLines.length - kept.length)}`;
}

/**
 * PURE. Flattens project personas into the exact array OASIS parses, or names
 * every problem at once.
 *
 * Reports ALL problems rather than the first. A caller fixing personas one
 * `KeyError` per round trip through a torch-loading sidecar is the slowest
 * possible way to discover that four of them are incomplete.
 */
export function toOasisPersonas(
  personas: readonly ProjectPersona[],
  facts: readonly { key: string; value: string }[]
): PersonaSeedResult {
  const problems: string[] = [];

  if (personas.length === 0) {
    problems.push(
      "no personas to simulate — a simulation over zero agents returns a clean, empty, entirely meaningless result"
    );
  }
  // Two agents is the floor at which divergence is even definable. One agent
  // trivially "agrees with itself" and would pass any divergence check.
  if (personas.length === 1) {
    problems.push(
      "only one persona — divergence is undefined over a single agent, so the run could not answer the question it exists to answer"
    );
  }

  const seenNames = new Set<string>();
  const factLines = facts.map((f) => `${f.key}: ${f.value}`);

  const built: OasisPersona[] = [];
  for (const persona of personas) {
    const username = persona.name
      .trim()
      .toLowerCase()
      .replace(NON_SLUG_CHARS, "_");
    // At least one alphanumeric character is required, not merely a non-empty
    // slug: a name of "!!!" slugs to "_", which is a legal-looking username
    // that carries no identity, and two such personas would collide on it.
    if (!HAS_ALPHANUMERIC.test(username)) {
      problems.push(
        `persona "${persona.id}" has no usable name (${JSON.stringify(persona.name)} contains no letters or digits)`
      );
      continue;
    }
    if (seenNames.has(username)) {
      // OASIS keys agents by list index but signs them up by name; a duplicate
      // makes two agents indistinguishable in the trace table, which is where
      // every reaction is read back from.
      problems.push(
        `persona "${persona.id}" collides with an earlier persona on username "${username}"`
      );
      continue;
    }
    seenNames.add(username);

    const base = {
      username,
      bio: persona.headline.trim(),
      persona: persona.description.trim(),
      age: persona.age,
      gender: persona.gender.trim(),
      mbti: (persona.mbti ?? UNSPECIFIED_MBTI).trim(),
      country: persona.country.trim(),
    };

    // Everything but the facts is fixed; the facts get whatever room is left.
    // A persona that cannot fit even with no facts is refused by name rather
    // than cut: which half of a persona to drop is not a call to make here.
    const fixedChars = jsonLength(base) + FACT_CONTEXT_RESERVE_CHARS;
    if (fixedChars > MAX_PERSONA_ENTRY_CHARS) {
      problems.push(
        `persona "${persona.id}" is too long to seat (${fixedChars} characters before any project fact; the limit is ${MAX_PERSONA_ENTRY_CHARS}) — regenerate it or shorten its role`
      );
      continue;
    }

    const candidate = {
      ...base,
      // The project's established facts are appended so the agent argues from
      // what the founder actually evidenced, not from the model's generic idea
      // of this demographic. This is the cross-phase grounding the whole
      // product is built on, applied to simulation.
      persona: withFactContext(
        base.persona,
        factLines,
        MAX_PERSONA_ENTRY_CHARS - jsonLength(base)
      ),
    };

    const parsed = OasisPersonaSchema.safeParse(candidate);
    if (!parsed.success) {
      const fields = parsed.error.issues
        .map((i) => i.path.join("."))
        .join(", ");
      problems.push(
        `persona "${persona.id}" is missing or malformed on: ${fields}`
      );
      continue;
    }
    built.push(parsed.data);
  }

  if (problems.length > 0) {
    return { ok: false, problems };
  }
  return { ok: true, personas: built };
}

// ─────────────────────────────────────────────────────────────────────────────
// (b) THE DIVERGENCE CHECK. This is the Step 8 gate, as a pure function.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One persona's reaction, read back from the OASIS sqlite `post` and `comment`
 * tables by the sidecar.
 *
 * The structural fields below are optional because the sidecar can genuinely
 * fail to determine them — a database whose watermark could not be read yields
 * `round: null` — and because a reaction that predates this shape is still a
 * reaction. Consumers must therefore treat absence as "unknown", never as a
 * default: `round ?? 0` would silently file an unmeasured reaction into the
 * seed round, and `parentId ?? 0` would draw a reply edge to post zero that
 * nobody wrote.
 */
export type PersonaReaction = {
  username: string;
  /** What the agent said. */
  text: string;
  /** -1 (rejects it) .. +1 (would use it), scored by the sidecar. */
  sentiment: number;
  /**
   * Whether this was a top-level post or a comment on one. Without it the two
   * are indistinguishable and a feed can only be a flat list.
   */
  kind?: "post" | "comment";
  /** `post.post_id` or `comment.comment_id` — the target of a reply edge. */
  reactionId?: number | null;
  /**
   * The post a comment answers, or a repost's original. `null` for an original
   * post, and that null is meaningful: there is no parent, as opposed to a
   * parent we failed to record.
   */
  parentId?: number | null;
  /**
   * Which `env.step()` produced it: 0 is the seeded pitch, 1..n the agent
   * rounds. Derived from row-id watermarks rather than from OASIS's simulated
   * clock, because its schema has no round column and ordering by timestamp
   * would be an inference dressed as a fact.
   */
  round?: number | null;
};

export type DivergenceReport = {
  /** 0 = every persona said the same thing, 1 = maximally spread. */
  score: number;
  /** Standard deviation of sentiment. */
  sentimentSpread: number;
  /** Share of reaction pairs whose wording is near-identical, 0-1. */
  duplicateRate: number;
  distinctReactions: number;
  totalReactions: number;
};

const NEAR_DUPLICATE_THRESHOLD = 0.8;

/** PURE. Word-set Jaccard; enough to catch "N copies of one opinion". */
export function reactionSimilarity(a: string, b: string): number {
  const tokens = (t: string) =>
    new Set(
      t
        .toLowerCase()
        .replace(NON_WORD_CHARS, " ")
        .split(WHITESPACE)
        .filter((w) => w.length > 2)
    );
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) {
      shared++;
    }
  }
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * PURE. Measures how much the personas actually disagreed.
 *
 * WHY THIS IS THE GATE. The Step 8 verification criterion is "an OASIS run
 * produces divergent persona reactions, not N copies of one opinion". That is
 * not a nice-to-have: N identical reactions is the signature of a simulation
 * that has collapsed onto the base model's prior, and its output is worthless —
 * but it is worthless in the most dangerous possible way, because it reads as
 * unanimous enthusiasm. A founder shown ten agreeing personas concludes the
 * market agrees. So the collapse is detected here, mechanically, and reported
 * as a failed run rather than a positive result.
 *
 * Both halves matter and are combined rather than either alone: sentiment can
 * spread while every agent recites the same reasoning, and wording can vary
 * while every agent lands on the same verdict.
 */
export function measureDivergence(
  reactions: readonly PersonaReaction[]
): DivergenceReport {
  const total = reactions.length;
  if (total < 2) {
    return {
      score: 0,
      sentimentSpread: 0,
      duplicateRate: total === 1 ? 1 : 0,
      distinctReactions: total,
      totalReactions: total,
    };
  }

  const sentiments = reactions.map((r) => r.sentiment);
  const mean = sentiments.reduce((a, b) => a + b, 0) / total;
  const variance =
    sentiments.reduce((acc, s) => acc + (s - mean) ** 2, 0) / total;
  const sentimentSpread = Math.sqrt(variance);

  let pairs = 0;
  let duplicatePairs = 0;
  const duplicated = new Set<number>();
  for (let i = 0; i < total; i++) {
    for (let j = i + 1; j < total; j++) {
      pairs++;
      if (
        reactionSimilarity(reactions[i].text, reactions[j].text) >=
        NEAR_DUPLICATE_THRESHOLD
      ) {
        duplicatePairs++;
        duplicated.add(j);
      }
    }
  }
  const duplicateRate = pairs === 0 ? 0 : duplicatePairs / pairs;

  // Sentiment is on [-1, 1], so its standard deviation is at most 1. Clamping
  // rather than normalising by the observed max keeps the score comparable
  // between runs — a score that rescaled itself per run could not be compared
  // to a threshold at all.
  const spreadTerm = Math.min(sentimentSpread, 1);
  const textTerm = 1 - duplicateRate;

  return {
    score: Number((0.5 * spreadTerm + 0.5 * textTerm).toFixed(4)),
    sentimentSpread: Number(sentimentSpread.toFixed(4)),
    duplicateRate: Number(duplicateRate.toFixed(4)),
    distinctReactions: total - duplicated.size,
    totalReactions: total,
  };
}

/** Below this a run is reported as collapsed, not as a finding. */
export const MIN_DIVERGENCE_SCORE = 0.35;

/** A run that WAS judged. `usable` is a finding about the personas. */
export type SimulationVerdict = {
  /**
   * Discriminant. Present so that "the run was assessed" is a fact the type
   * system carries, not one a caller infers from the shape.
   */
  assessed: true;
  /** Did the run produce something worth reading? */
  usable: boolean;
  /**
   * ALWAYS FALSE. Kept as an explicit field rather than omitted so that any
   * future code reaching for "can I use this at the gate?" finds a hard `false`
   * and a reason, instead of finding nothing and assuming yes.
   */
  usableAsEvidence: false;
  divergence: DivergenceReport;
  reason: string;
  /**
   * Agent actions the sidecar watched fail. `null` means the sidecar did not
   * report a count — NOT that none failed. A run with two survivors out of four
   * is a partial run, and the founder is looking at half an audience.
   */
  agentErrors: number | null;
};

/**
 * A run that could NOT be judged. Deliberately has no `usable` field at all, so
 * that reading one is a compile error rather than a `false` that reads as a
 * verdict.
 */
export type SimulationNotAssessed = {
  assessed: false;
  /** The named condition. Never a polarity. */
  kind: "no-reactions" | "too-few-reactions";
  usableAsEvidence: false;
  /** Kept so a caller can still show what little was measured. */
  divergence: DivergenceReport;
  reason: string;
  agentErrors: number | null;
};

export type SimulationJudgement = SimulationVerdict | SimulationNotAssessed;

/**
 * PURE. The Step 8 decision. Fails closed for the same reason `decideGate`
 * does: there is no second check behind this one.
 *
 * WHY THIS RETURNS A UNION. It used to return `usable: false` for an empty
 * reaction list, and that is how a run in which every single agent call
 * returned 400 was recorded and rendered as COLLAPSED — the same badge, the
 * same colour and the same row as a run in which the personas genuinely all
 * agreed. Those two facts point a founder in opposite directions: one says
 * "your personas are too alike, seed them from more facts", the other says
 * "nothing ran, go and look at your model configuration".
 *
 * "Not assessed" is not a polarity of "assessed", so it is not a value of
 * `usable` — it is a different shape, and `SimulationNotAssessed` has no
 * `usable` key for a caller to read by accident. This is the same distinction
 * `decideGate` draws between "blocked" and "never evaluated", and the same one
 * `formatCreditBalance` draws between zero and unknown.
 */
/**
 * The clause explaining an agent-error count on a run that produced NOTHING.
 *
 * THREE OUTCOMES, NOT TWO. `null` is silence — this sidecar build did not
 * report a count, and inventing "nothing failed" from that would be exactly the
 * defaulting this module refuses everywhere else. `0` is a measurement, and on
 * an empty run it is the interesting one: every persona was reached, none
 * errored, and none of them said anything. That points at the pitch or the
 * personas, not at the plumbing.
 */
function describeAgentErrorsOnEmptyRun(agentErrors: number | null): string {
  if (agentErrors === null) {
    return "";
  }
  if (agentErrors > 0) {
    return ` ${agentErrors} agent action(s) failed during the run.`;
  }
  return " No agent action failed, so the personas were reached and simply said nothing.";
}

/**
 * The same clause for a run that WAS judged, where only failures are worth
 * saying. Zero errors is the unremarkable case on a run that produced
 * reactions, and the empty-run wording ("simply said nothing") would be plainly
 * false next to a list of things they said — which is exactly how it read in
 * the browser before this split.
 */
function describeAgentErrorsOnJudgedRun(agentErrors: number | null): string {
  return agentErrors !== null && agentErrors > 0
    ? ` ${agentErrors} agent action(s) failed during the run, so this verdict is measured over the survivors rather than over the audience you chose.`
    : "";
}

export function judgeSimulation(
  reactions: readonly PersonaReaction[],
  agentErrors: number | null = null
): SimulationJudgement {
  const divergence = measureDivergence(reactions);

  const blameEmpty = describeAgentErrorsOnEmptyRun(agentErrors);
  const blameJudged = describeAgentErrorsOnJudgedRun(agentErrors);

  if (reactions.length === 0) {
    return {
      assessed: false,
      kind: "no-reactions",
      usableAsEvidence: false,
      divergence,
      agentErrors,
      reason: `The simulation produced no reactions at all.${blameEmpty} Nothing can be concluded about divergence from a run that produced nothing — this is not a collapsed audience, it is an absent one.`,
    };
  }

  if (reactions.length === 1) {
    return {
      assessed: false,
      kind: "too-few-reactions",
      usableAsEvidence: false,
      divergence,
      agentErrors,
      reason: `The simulation produced a single reaction.${blameEmpty} Divergence is undefined below two, so this run was not assessed — one agent trivially agrees with itself.`,
    };
  }

  if (divergence.score < MIN_DIVERGENCE_SCORE) {
    return {
      assessed: true,
      usable: false,
      usableAsEvidence: false,
      divergence,
      agentErrors,
      reason: `The personas converged: divergence ${divergence.score} is below the ${MIN_DIVERGENCE_SCORE} floor (${divergence.distinctReactions} distinct of ${divergence.totalReactions} reactions, sentiment spread ${divergence.sentimentSpread}). This is one model's opinion restated ${divergence.totalReactions} times, not an audience.${blameJudged}`,
    };
  }

  return {
    assessed: true,
    usable: true,
    usableAsEvidence: false,
    divergence,
    agentErrors,
    reason: `The personas diverged (score ${divergence.score}, ${divergence.distinctReactions} distinct of ${divergence.totalReactions}). Treat the objections as questions to ask real users, not as demand evidence.${blameJudged}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// (c) THE SEAM.
// ─────────────────────────────────────────────────────────────────────────────

const SimulationResponseSchema = z.object({
  ok: z.literal(true),
  reactions: z.array(
    z.object({
      username: z.string(),
      text: z.string(),
      sentiment: z.number(),
    })
  ),
  /**
   * Optional, and `nullable`, and NOT defaulted to 0. An older sidecar does not
   * send it; `.default(0)` here would turn "this build cannot tell you" into
   * "nothing failed", which is the exact substitution this whole task exists to
   * remove.
   */
  agentErrors: z.number().int().nullable().optional(),
});

const SimulationErrorSchema = z.object({
  ok: z.literal(false),
  kind: z.string(),
  detail: z.string(),
  agentErrors: z.number().int().nullable().optional(),
});

export type SimulationOutcome =
  | { ok: true; verdict: SimulationVerdict; reactions: PersonaReaction[] }
  | {
      ok: false;
      kind: string;
      detail: string;
      /** How many agent actions failed, when that is known. */
      agentErrors?: number | null;
    };

export type SimulationRunner = (payload: {
  personas: OasisPersona[];
  pitch: string;
  rounds: number;
}) => Promise<unknown>;

export type SimulationDeps = { run: SimulationRunner };

/**
 * THE MOST SEATS ONE PROJECT MAY HOLD, and so the most agents one run seats.
 * Every agent is one model call per round on the sidecar's key, so this bounds
 * what one run can spend. Real runs use two to four seats (the end-to-end run
 * recorded during development used two); ten leaves room for a deliberately
 * varied room without letting a script queue hundreds.
 *
 * MIRRORED as `MAX_SIMULATION_PERSONAS` in apps/research/app/main.py, which
 * refuses a larger request on its own. Change both together.
 */
export const MAX_SIMULATION_SEATS = 10;

/**
 * The longest pitch a run accepts, in characters. The default pitch is a stored
 * fact (`one_liner`, `value_proposition` or `problem_statement`), and a fact
 * value is capped at 2,000 characters whether extracted
 * (lib/phases/types.ts::ExtractedFactSchema) or typed by the founder
 * (app/actions/correct-fact.ts::MAX_FACT_VALUE), so a pitch proposed from a
 * fact always fits. MIRRORED as `MAX_SIMULATION_PITCH_CHARS`
 * in apps/research/app/main.py.
 */
export const MAX_SIMULATION_PITCH_CHARS = 2000;

/**
 * AN ESTIMATE, IN CENTS, AND SAID TO BE ONE. The run spends the sidecar's key
 * inside OASIS, and the sidecar reports no token usage back, so the exact cost
 * is not known here. The basis: each seat makes about one model call per round;
 * on the sidecar's default model (gpt-5.6-luna, $0.20 in / $1.20 out per 1M
 * tokens) a call with an OASIS-sized prompt costs a few hundredths of a cent,
 * and apps/research/README.md records a whole default run as a fraction of a
 * cent. 0.1¢ per seat-round sits above that on purpose, to cover the model
 * probe, retries and a longer feed in later rounds. Rounded up, so any run
 * that happened costs at least one cent; replace with metered usage if the
 * sidecar ever reports it.
 */
const SIMULATION_CENTS_PER_SEAT_ROUND = 0.1;

export function estimateSimulationCostCents({
  seats,
  rounds,
}: {
  seats: number;
  rounds: number;
}): number {
  return Math.max(
    1,
    Math.ceil(seats * rounds * SIMULATION_CENTS_PER_SEAT_ROUND)
  );
}

export type SimulationInput = {
  personas: readonly ProjectPersona[];
  facts: readonly { key: string; value: string }[];
  /** What the personas are reacting to. */
  pitch: string;
  /** How many OASIS steps to run. */
  rounds: number;
};

/** Runs a simulation. NEVER REJECTS. */
export async function runSimulation(
  deps: SimulationDeps,
  input: SimulationInput
): Promise<SimulationOutcome> {
  const seeded = toOasisPersonas(input.personas, input.facts);
  if (!seeded.ok) {
    return {
      ok: false,
      kind: "invalid-personas",
      detail: `Cannot seed the simulation: ${seeded.problems.join("; ")}.`,
    };
  }

  let raw: unknown;
  try {
    raw = await deps.run({
      personas: seeded.personas,
      pitch: input.pitch,
      rounds: input.rounds,
    });
  } catch (error) {
    return {
      ok: false,
      kind: "unavailable",
      detail: `The simulation sidecar could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const failed = SimulationErrorSchema.safeParse(raw);
  if (failed.success) {
    return {
      ok: false,
      kind: failed.data.kind,
      detail: failed.data.detail,
      agentErrors: failed.data.agentErrors ?? null,
    };
  }

  const parsed = SimulationResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      kind: "schema-drift",
      detail:
        "The simulation sidecar returned a body that did not match the reaction contract.",
    };
  }

  const judgement = judgeSimulation(
    parsed.data.reactions,
    parsed.data.agentErrors ?? null
  );

  // A RUN THAT COULD NOT BE JUDGED IS NOT AN `ok: true` OUTCOME.
  //
  // Routing it here rather than returning it as a verdict is what stops the
  // caller writing a SimulationRun row for it: `usable` in that table is a
  // non-null boolean, so the only thing an unjudgeable run could be stored as
  // is `false` — which is the COLLAPSED badge, on a run that never happened.
  // The named kind travels instead, so the panel can say what actually went
  // wrong.
  if (!judgement.assessed) {
    return {
      ok: false,
      kind: judgement.kind,
      detail: judgement.reason,
      agentErrors: judgement.agentErrors,
    };
  }

  return {
    ok: true,
    reactions: parsed.data.reactions,
    verdict: judgement,
  };
}
