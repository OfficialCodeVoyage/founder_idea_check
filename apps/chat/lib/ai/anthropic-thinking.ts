/**
 * WHICH THINKING SHAPE AN ANTHROPIC MODEL ACTUALLY ACCEPTS.
 *
 * The Anthropic API has two mutually exclusive thinking configurations and no
 * tolerance for the wrong one:
 *
 *   - ADAPTIVE — `thinking: { type: "adaptive" }`. Claude 4.6 and newer. On
 *     Opus 5 / 4.8 / 4.7, Sonnet 5 and Fable 5, `budgetTokens` was REMOVED and
 *     sending it is an HTTP 400.
 *   - BUDGETED — `thinking: { type: "enabled", budgetTokens: N }`. Everything
 *     older (Opus/Sonnet/Haiku 4.5 and the whole Claude 3 family). These do not
 *     know the word "adaptive", and sending it is an HTTP 400 the other way.
 *
 * providers.ts sent `adaptive` to EVERY model tagged `reasoning`, so any
 * pre-4.6 Anthropic model — all of which are in the catalog and selectable —
 * failed outright. That was harmless only while the configured gateway was
 * openai; with the gateway on Anthropic it would be a hard outage.
 *
 * DIRECTION OF THE UNKNOWN CASE: an id this cannot parse gets ADAPTIVE. That is
 * the current behaviour, so nothing regresses, and it is also the right bet —
 * unrecognised ids are overwhelmingly models newer than this file, and thinking
 * has been adaptive-only since 4.6. The legacy branch is the one that needs an
 * explicit match, which is exactly what a version test gives it.
 *
 * PURE by contract: no "ai", no "@ai-sdk/*", no network, no key. It takes a
 * model id string and returns a plain object, so every model in the catalog can
 * be asserted in a unit test rather than discovered in production.
 */

/** The first Anthropic version whose thinking is adaptive. */
export const ADAPTIVE_THINKING_MIN_MAJOR = 4;
export const ADAPTIVE_THINKING_MIN_MINOR = 6;

/**
 * What a pre-4.6 model gets. Anthropic requires budgetTokens < max_tokens, and
 * the catalog's smallest max_tokens among legacy models is 64k, so 10,000 is
 * safely inside every one of them. It also matches the Google branch's
 * `thinkingBudget: 10_000` — the two knobs mean the same thing and there is no
 * reason for them to disagree.
 */
export const LEGACY_THINKING_BUDGET_TOKENS = 10_000;

export type AnthropicThinkingOptions =
  | { type: "adaptive"; display: "summarized" }
  | { type: "enabled"; budgetTokens: number };

/** Modern ids: claude-<family>-<major>[-<minor>], e.g. claude-opus-4-8. */
const FAMILY_FIRST = /claude-(?:opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/;
/** Legacy ids: claude-<major>[-<minor>]-<family>, e.g. claude-3-5-sonnet. */
const VERSION_FIRST = /claude-(\d+)(?:-(\d+))?-(?:opus|sonnet|haiku)/;

/**
 * PURE. Parses the Claude version out of a model id, tolerating the provider
 * prefixes different gateways add ("anthropic/claude-opus-4-5") and the date
 * suffixes Anthropic pins snapshots with ("claude-haiku-4-5-20251001").
 *
 * Returns null when the id is not a recognisable Claude id at all.
 */
export function parseClaudeVersion(
  apiModelId: string
): { major: number; minor: number } | null {
  // Strip any provider prefix, the same way the openai branch does.
  const bare = (apiModelId.split("/").pop() ?? apiModelId).toLowerCase();
  const match = FAMILY_FIRST.exec(bare) ?? VERSION_FIRST.exec(bare);
  if (!match) {
    return null;
  }
  return { major: Number(match[1]), minor: match[2] ? Number(match[2]) : 0 };
}

/** PURE. True when the model takes `thinking: { type: "adaptive" }`. */
export function supportsAdaptiveThinking(apiModelId: string): boolean {
  const version = parseClaudeVersion(apiModelId);
  if (!version) {
    // Unparseable — see "DIRECTION OF THE UNKNOWN CASE" above.
    return true;
  }
  if (version.major !== ADAPTIVE_THINKING_MIN_MAJOR) {
    return version.major > ADAPTIVE_THINKING_MIN_MAJOR;
  }
  return version.minor >= ADAPTIVE_THINKING_MIN_MINOR;
}

/**
 * PURE. The `thinking` value to send for a reasoning-tagged Anthropic model.
 *
 * `display: "summarized"` is only meaningful on the adaptive shape — it
 * defaults to "omitted" there, which streams empty reasoning blocks. The
 * budgeted shape has no such field and rejects unknown ones.
 */
export function anthropicThinkingOptions(
  apiModelId: string
): AnthropicThinkingOptions {
  return supportsAdaptiveThinking(apiModelId)
    ? { type: "adaptive", display: "summarized" }
    : { type: "enabled", budgetTokens: LEGACY_THINKING_BUDGET_TOKENS };
}

export type AnthropicEffort = "low" | "medium" | "high";

/**
 * HOW HARD EACH CALL PATH THINKS, CHOSEN RATHER THAN DEFAULTED.
 *
 * Thinking is on by default on Opus 5.5, Sonnet 5.5 and Haiku 5.5, and effort
 * is the one control over it. The defaults differ by model (`medium` on Opus
 * 5.5 and Haiku 5.5, `high` on Sonnet 5.5), so leaving it unset would make the
 * cost and depth of a path a side effect of which model it happens to run on.
 *
 *  - judge: `high`. The gate is the product and a wrong verdict is
 *    user-visible; one call per assessed turn, so the depth is bought.
 *  - chat, extract, persona: `medium`. The interview, the fact ledger the gate
 *    reads, and the phase-3 persona all carry judgement, but none is a
 *    one-shot verdict.
 *  - title, followups: `low`. Short, cheap, cosmetic.
 *  - research: `low`. Every deep-research call runs against the research
 *    clock and an output cap that is a time budget (see
 *    tools/platform/deep-research/configuration.ts), so thinking must not eat it.
 */
export const CALL_EFFORT = {
  chat: "medium",
  judge: "high",
  extract: "medium",
  persona: "medium",
  title: "low",
  followups: "low",
  research: "low",
} as const satisfies Record<string, AnthropicEffort>;

/**
 * PURE. True when the model takes `output_config.effort`: a recognisable
 * Claude id at 4.6 or newer. Sonnet 4.5 and Haiku 4.5 reject the parameter and
 * both are in the catalog and selectable, so this is a function of the id, like
 * the thinking shape. Unlike `supportsAdaptiveThinking`, an unparseable id gets
 * NO effort: it may not be a Claude model at all.
 */
export function supportsEffort(apiModelId: string): boolean {
  return (
    parseClaudeVersion(apiModelId) !== null &&
    supportsAdaptiveThinking(apiModelId)
  );
}

/** PURE. `{ anthropic: { effort } }` for a model that takes it, else nothing. */
export function anthropicEffortOptions(
  apiModelId: string,
  effort: AnthropicEffort
): { anthropic: { effort: AnthropicEffort } } | undefined {
  return supportsEffort(apiModelId) ? { anthropic: { effort } } : undefined;
}

export type AnthropicLeastThinkingOptions = {
  anthropic: {
    effort: "low";
    thinking?: { type: "between_tools" } | { type: "disabled" };
  };
};

/** The 5.5 generation, with or without a provider prefix or `-reasoning`. */
const CLAUDE_5_5 = /claude-(opus|sonnet|haiku)-5-5(?!\d)/;

/**
 * PURE. The least thinking a model accepts, for a call whose output cap is a
 * TIME BUDGET rather than a length target (deep research's researcher steps,
 * compression and final report). Thinking counts toward `max_tokens`, so on these models a
 * call left at its default effort can spend the cap thinking and stop before
 * the visible output is finished.
 *
 *  - Sonnet 5.5 rejects `disabled` (HTTP 400); `between_tools` is its lowest
 *    setting, and it is accepted only at effort `high` or below.
 *  - Haiku 5.5 accepts `disabled` at effort `high` or below.
 *  - Opus 5.5 cannot turn thinking off at all; low effort is all there is.
 *
 * Only the 5.5 models are mapped: any other id gets nothing, because a
 * rejected option fails the whole call, which is worse than thinking tokens.
 */
export function anthropicLeastThinkingOptions(
  apiModelId: string
): AnthropicLeastThinkingOptions | undefined {
  const family = CLAUDE_5_5.exec(apiModelId.toLowerCase())?.[1];
  if (family === "sonnet") {
    return {
      anthropic: { effort: "low", thinking: { type: "between_tools" } },
    };
  }
  if (family === "haiku") {
    return { anthropic: { effort: "low", thinking: { type: "disabled" } } };
  }
  if (family === "opus") {
    return { anthropic: { effort: "low" } };
  }
  return;
}
