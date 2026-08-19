/**
 * HOW MUCH OF THE CONVERSATION THE ASSISTANT ACTUALLY GETS TO SEE.
 *
 * This replaces a hard-coded `.slice(-5)`. Five messages is not a context
 * policy, it is an accident, and in a gated workflow it is a correctness bug:
 * the phase gate judges up to GATE_TRANSCRIPT_BUDGET_TOKENS of transcript and
 * then BLOCKS the phase naming a specific gap, while the assistant answering
 * the founder had been shown five messages. The model was being held to a
 * standard over evidence it was never given — and the founder's only visible
 * symptom is an assistant that keeps re-asking what it was already told.
 *
 * A window measured in MESSAGES is the wrong unit besides. Five messages is
 * 300 tokens of "yes, go on" and 40,000 tokens of pasted interview notes, and
 * the whole point of a budget is to be the same size either way.
 *
 * DISCIPLINE: pure. No "ai", no "@/lib/db/*", no "server-only", no clock, no
 * network. The token counter is a seam whose default is the repo's chars/4
 * heuristic; production injects real tiktoken. Same contract as
 * lib/phases/context.ts, and for the same reason — this is a rule about what
 * the model sees, so it has to be testable without a model.
 */

/** Counts tokens in a bare string. Mirrors lib/phases/context.ts TokenCounter. */
export type TokenCounter = (text: string) => number;

/** ~4 characters per token — the repo's own heuristic. */
const CHARS_PER_TOKEN = 4;

export const approxTokenCount: TokenCounter = (text) =>
  Math.ceil(text.length / CHARS_PER_TOKEN);

/**
 * Per-message envelope (role, content wrapper), and the cost of a part that
 * carries no text. Both numbers are taken verbatim from
 * `calculateMessagesTokens` in token-utils.ts — the repo already priced a
 * non-text part at the GPT-4V approximation of ~765 tokens, and two different
 * answers to "what does an image cost" would make this budget disagree with
 * the one the request-size check uses.
 */
export const MESSAGE_ENVELOPE_TOKENS = 5;
export const NON_TEXT_PART_TOKENS = 765;

type PartLike = { type: string; text?: unknown };
type MessageLike = { role: string; parts: PartLike[] };

/**
 * PURE. What one message will cost the prompt.
 *
 * Reasoning parts are priced at zero because filterPartsForLLM strips them
 * before conversion — charging for them would shrink the window to pay for
 * text the model never receives.
 */
export function countMessageTokens(
  message: MessageLike,
  countTokens: TokenCounter = approxTokenCount
): number {
  let total = MESSAGE_ENVELOPE_TOKENS + countTokens(message.role);
  for (const part of message.parts) {
    if (part.type === "reasoning") {
      continue;
    }
    if (part.type === "text" && typeof part.text === "string") {
      total += countTokens(part.text);
      continue;
    }
    total += NON_TEXT_PART_TOKENS;
  }
  return total;
}

export type ContextWindow<T> = {
  /** Chronological, oldest first. A contiguous suffix of the input. */
  messages: T[];
  /** How many older messages were dropped for budget. */
  omittedMessages: number;
};

/**
 * PURE. Fits conversation history into a token budget, newest-first, never
 * splitting a message.
 *
 * Same three rules as budgetTranscript, deliberately:
 *
 *   - NEWEST-FIRST. The newest turns are the ones the answer depends on.
 *   - NEVER SPLIT. Half a message is worse than no message: the model reads a
 *     truncated answer as the whole answer. (token-utils' truncateMessages
 *     does split, and its own docstring says to prefer this approach.)
 *   - A message that does not fit STOPS the walk. A conversation is a
 *     sequence; keeping an older message after skipping a newer one would hand
 *     the model an exchange that never happened.
 *
 * And it REPORTS what it dropped, so a caller can say so out loud rather than
 * letting the model read a truncated history as a complete one.
 */
export function selectContextWindow<T extends MessageLike>(
  messages: T[],
  budgetTokens: number,
  countTokens: TokenCounter = approxTokenCount
): ContextWindow<T> {
  if (messages.length === 0) {
    return { messages: [], omittedMessages: 0 };
  }

  let spent = 0;
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = countMessageTokens(messages[i], countTokens);
    if (spent + cost > budgetTokens) {
      break;
    }
    spent += cost;
    start = i;
  }

  return { messages: messages.slice(start), omittedMessages: start };
}
