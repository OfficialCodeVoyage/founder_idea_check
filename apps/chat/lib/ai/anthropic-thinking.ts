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
 * failed outright. It has been harmless only because the configured gateway is
 * openai; it becomes a hard outage the moment the gateway is Anthropic.
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
