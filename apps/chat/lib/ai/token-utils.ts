import type { ModelMessage } from "ai";
import { getEncoding } from "js-tiktoken";
import { RecursiveCharacterTextSplitter } from "./text-splitter";

const MinChunkSize = 140;
const encoder = getEncoding("o200k_base");

/** Characters per `encode` call; see `encodedLength`. */
const MAX_CHUNK_CHARS = 1024;
/** How far back from a chunk's end a space is looked for to cut before. */
const CHUNK_BOUNDARY_SEARCH = 128;
/**
 * Longest slice of one run handed to `encode`, in UTF-8 bytes, since the
 * merge works on bytes. 64 keeps identifiers, paths and URLs whole in nearly
 * every case.
 */
const MAX_RUN_BYTES = 64;
/**
 * The runs o200k's pre-tokenizer can make one long piece of: non-whitespace,
 * whitespace, and the `[\r\n/]*` tail it lets follow punctuation (its
 * ` ?[^\s\p{L}\p{N}]+[\r\n/]*` branch), which mixes the two. A run of more
 * UTF-16 units than this could exceed `MAX_RUN_BYTES` (a unit is at most 3
 * UTF-8 bytes), so it goes through `encodeInSlices`.
 */
const LONG_RUN_UNITS = Math.floor(MAX_RUN_BYTES / 3) + 1;
const LONG_RUN = new RegExp(
  ["\\S", "\\s", "[\\r\\n/]"]
    .map((run) => `${run}{${LONG_RUN_UNITS},}`)
    .join("|"),
  "g"
);
const WHITESPACE = /\s/;
/**
 * UTF-8 bytes counted exactly. Past it, a text is bounded instead of counted,
 * in the direction its caller can afford (`TokenCountMode`). Bytes, not
 * characters, because the merge's cost follows bytes: at the limit the worst
 * text measured (one run of a single letter, or of Chinese) takes about 0.8 s.
 * 250,000 bytes is more than any message that fits the app's limits: English
 * prose that long is about 55,000 tokens and Chinese about 83,000, above
 * `MAX_INPUT_TOKENS` (50,000) and the 24,000-token context and gate budgets.
 */
const MAX_EXACT_BYTES = 250_000;
/**
 * The longest o200k token, in UTF-8 bytes (measured over the rank table of
 * js-tiktoken 1.0.21). A text of N bytes is at least N / 128 tokens, and at
 * most N, since every token is at least one byte.
 */
const MAX_TOKEN_BYTES = 128;

/**
 * Which way a count may err past `MAX_EXACT_BYTES`:
 *  - "ceiling" never undercounts (one token per UTF-8 byte), for every caller
 *    that ENFORCES a limit or a budget: an undercount there lets oversized
 *    input through, so those fail closed;
 *  - "floor" never overcounts (one token per `MAX_TOKEN_BYTES` bytes), for the
 *    usage meter's estimate of a cut-off step: an overcount there overcharges
 *    the founder.
 */
type TokenCountMode = "ceiling" | "floor";

/**
 * The tokens `encoder` makes of `text`, with special-token markers such as
 * `<|endoftext|>` counted as the plain text they are.
 *
 * js-tiktoken's `encode(text)` defaults to `disallowedSpecial: "all"` and
 * THROWS on text that contains a special-token marker. That text is ordinary
 * here: a founder can paste it, and a model can write it. One such message
 * made every later turn of its chat fail in `selectContextWindow`, and the
 * same throw inside the usage meter's estimate broke a stopped turn's stream.
 * Passing empty allowed and disallowed lists encodes a marker as the
 * characters it is (`<|`, `endoftext`, `|>`), never as a control token, so a
 * count can no longer throw on what a message says.
 *
 * NO TEXT REACHES `encode` IN A PIECE LONG ENOUGH TO STALL IT. js-tiktoken's
 * byte-pair merge is quadratic in the length of one pre-tokenized piece, and
 * a run of letters, or of spaces, is one piece: 40,000 letters took 61 to 73 s
 * and 40,000 spaces 79 s on js-tiktoken 1.0.21, synchronously, on the
 * request's thread (pasted base-32, a DNA string, a model looping on one
 * character). So the cost is bounded three ways:
 *  - inside a chunk, every run the pre-tokenizer could make one long piece of
 *    (`LONG_RUN`) is encoded in slices of at most `MAX_RUN_BYTES` UTF-8
 *    bytes, so no piece is longer than about twice that;
 *  - whatever the text holds, no `encode` call gets more than
 *    `MAX_CHUNK_CHARS`: the text is encoded in chunks of at most that, each
 *    cut before a space that follows a non-space within the last
 *    `CHUNK_BOUNDARY_SEARCH` characters when there is one (a cut there leaves
 *    every piece as one call would make it), else at the length, never inside
 *    a surrogate pair. A piece shape missed above costs at most one chunk's
 *    worth of quadratic work per chunk;
 *  - only the first `MAX_EXACT_BYTES` bytes are counted exactly; the rest is
 *    bounded by its byte length as `mode` says.
 * Ordinary prose has few runs that long, so its count barely moves (+0.2%
 * over the repo's own docs and code); a sliced run can gain or lose about one
 * token per cut, since a real token is rarely that long.
 */
function encodedLength(text: string, mode: TokenCountMode): number {
  const exactEnd = indexAfterBytes(text, MAX_EXACT_BYTES);
  let tokens = 0;
  let start = 0;
  while (start < exactEnd) {
    const end = chunkEnd(text, start, exactEnd);
    tokens += encodeChunk(text.slice(start, end));
    start = end;
  }
  if (exactEnd === text.length) {
    return tokens;
  }
  const restBytes = utf8Length(text.slice(exactEnd));
  return (
    tokens +
    (mode === "ceiling" ? restBytes : Math.ceil(restBytes / MAX_TOKEN_BYTES))
  );
}

function chunkEnd(text: string, start: number, limit: number): number {
  const hardEnd = start + MAX_CHUNK_CHARS;
  if (hardEnd >= limit) {
    return limit;
  }
  for (let i = hardEnd; i > hardEnd - CHUNK_BOUNDARY_SEARCH; i--) {
    if (text[i] === " " && !WHITESPACE.test(text[i - 1] ?? " ")) {
      return i;
    }
  }
  return surrogateSafeEnd(text, hardEnd);
}

function encodeChunk(chunk: string): number {
  let tokens = 0;
  let start = 0;
  for (const run of chunk.matchAll(LONG_RUN)) {
    tokens += encodePlain(chunk.slice(start, run.index));
    tokens += encodeInSlices(run[0]);
    start = run.index + run[0].length;
  }
  return tokens + encodePlain(chunk.slice(start));
}

function encodePlain(text: string): number {
  return text.length > 0 ? encoder.encode(text, [], []).length : 0;
}

/** Encodes `run` in slices of at most `MAX_RUN_BYTES` UTF-8 bytes each. */
function encodeInSlices(run: string): number {
  let tokens = 0;
  let start = 0;
  let bytes = 0;
  let i = 0;
  while (i < run.length) {
    const code = run.charCodeAt(i);
    const isPair = isHighSurrogate(code) && i + 1 < run.length;
    const width = utf8Width(code, isPair);
    if (bytes + width > MAX_RUN_BYTES && i > start) {
      tokens += encodePlain(run.slice(start, i));
      start = i;
      bytes = 0;
    }
    bytes += width;
    i += isPair ? 2 : 1;
  }
  return tokens + encodePlain(run.slice(start));
}

/** The index past the longest prefix of `text` that fits in `maxBytes`. */
function indexAfterBytes(text: string, maxBytes: number): number {
  let bytes = 0;
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    const isPair = isHighSurrogate(code) && i + 1 < text.length;
    bytes += utf8Width(code, isPair);
    if (bytes > maxBytes) {
      return i;
    }
    i += isPair ? 2 : 1;
  }
  return i;
}

function utf8Length(text: string): number {
  let bytes = 0;
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    const isPair = isHighSurrogate(code) && i + 1 < text.length;
    bytes += utf8Width(code, isPair);
    i += isPair ? 2 : 1;
  }
  return bytes;
}

function utf8Width(code: number, isSurrogatePair: boolean): number {
  if (isSurrogatePair) {
    return 4;
  }
  if (code < 0x80) {
    return 1;
  }
  return code < 0x8_00 ? 2 : 3;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd8_00 && code <= 0xdb_ff;
}

/** `end`, or one past it when a cut there would split a surrogate pair. */
function surrogateSafeEnd(text: string, end: number): number {
  return end < text.length && isHighSurrogate(text.charCodeAt(end - 1))
    ? end + 1
    : end;
}

/**
 * Token count of a bare string, with no message-envelope overhead, that
 * never undercounts: the counter for every limit and budget (the "ceiling"
 * mode of `encodedLength`).
 *
 * calculateMessagesTokens() adds the role tokens and a +5 structural overhead
 * per message, which is wrong for counting a prompt fragment such as a fact
 * line. lib/phases/context.ts takes a TokenCounter seam whose default is the
 * repo's chars/4 heuristic; this is the real counter that lib/phases/runtime.ts
 * injects in production.
 */
export function countTextTokens(text: string): number {
  return encodedLength(text, "ceiling");
}

/**
 * Token count of a bare string that never overcounts (the "floor" mode of
 * `encodedLength`). For billing estimates only (the usage meter's cut-step
 * estimate); a limit or a budget must use `countTextTokens`.
 */
export function countTokensFloor(text: string): number {
  return encodedLength(text, "floor");
}

// Calculate total tokens from messages
export function calculateMessagesTokens(messages: ModelMessage[]): number {
  let totalTokens = 0;

  for (const message of messages) {
    // Count tokens for role
    totalTokens += encodedLength(message.role, "ceiling");

    // Count tokens for content - handle both string and array formats
    if (typeof message.content === "string") {
      totalTokens += encodedLength(message.content, "ceiling");
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "text") {
          totalTokens += encodedLength(part.text, "ceiling");
        }
        // Add overhead for other part types (image, file, etc.)
        // Using GPT-4V approximation: ~765 tokens for typical image
        else {
          totalTokens += 765;
        }
      }
    }

    // Add overhead for message structure (role, content wrapper, etc.)
    totalTokens += 5;
  }

  return totalTokens;
}

// trim prompt to maximum context size
function trimPrompt(prompt: string, contextSize: number) {
  if (!prompt) {
    return "";
  }

  const length = encodedLength(prompt, "ceiling");
  if (length <= contextSize) {
    return prompt;
  }

  const overflowTokens = length - contextSize;
  // on average it's 3 characters per token, so multiply by 3 to get a rough estimate of the number of characters
  const chunkSize = prompt.length - overflowTokens * 3;
  if (chunkSize < MinChunkSize) {
    return prompt.slice(0, MinChunkSize);
  }

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap: 0,
  });
  const trimmedPrompt = splitter.splitText(prompt)[0] ?? "";

  // last catch, there's a chance that the trimmed prompt is same length as the original prompt, due to how tokens are split & innerworkings of the splitter, handle this case by just doing a hard cut
  if (trimmedPrompt.length === prompt.length) {
    return trimPrompt(prompt.slice(0, chunkSize), contextSize);
  }

  // recursively trim until the prompt is within the context size
  return trimPrompt(trimmedPrompt, contextSize);
}

function extractSystemMessage(
  messages: ModelMessage[],
  preserveSystemMessage: boolean
): {
  systemMessage: ModelMessage | null;
  otherMessages: ModelMessage[];
} {
  const systemMessage =
    preserveSystemMessage && messages[0]?.role === "system"
      ? messages[0]
      : null;
  const otherMessages = systemMessage ? messages.slice(1) : messages;
  return { systemMessage, otherMessages };
}

function handleExceededSystemMessage(
  systemMessage: ModelMessage | null,
  maxTokens: number
): ModelMessage[] {
  if (!systemMessage) {
    return [];
  }

  if (typeof systemMessage.content === "string") {
    const truncatedContent = trimPrompt(systemMessage.content, maxTokens);
    // biome-ignore lint/style/useObjectSpread: Spread syntax causes TypeScript error with ModelMessage union types
    return [Object.assign({}, systemMessage, { content: truncatedContent })];
  }

  return [systemMessage];
}

function removeOldestMessagesUntilFit(
  messages: ModelMessage[],
  availableTokens: number
): ModelMessage[] {
  const truncatedMessages = [...messages];
  let currentTokens = calculateMessagesTokens(truncatedMessages);

  while (currentTokens > availableTokens && truncatedMessages.length > 0) {
    truncatedMessages.shift();
    currentTokens = calculateMessagesTokens(truncatedMessages);
  }

  return truncatedMessages;
}

function truncateStringContent(
  lastMessage: ModelMessage,
  availableTokens: number,
  currentTokens: number
): ModelMessage {
  const tokensToRemove = currentTokens - availableTokens;
  const charsToRemove = tokensToRemove * 4;
  const truncatedContent = (lastMessage.content as string).slice(
    0,
    -charsToRemove
  );
  const trimmedContent = trimPrompt(truncatedContent, availableTokens);

  // biome-ignore lint/style/useObjectSpread: Spread syntax causes TypeScript error with ModelMessage union types
  return Object.assign({}, lastMessage, { content: trimmedContent });
}

function truncateToolResultPart(
  part: {
    type: string;
    output?: {
      value?: string;
    };
  },
  tokensToRemove: number
): {
  truncatedPart: unknown;
  tokensRemoved: number;
} {
  if (
    part.type !== "tool-result" ||
    !part.output ||
    typeof part.output !== "object" ||
    !("value" in part.output) ||
    typeof part.output.value !== "string"
  ) {
    return { truncatedPart: part, tokensRemoved: 0 };
  }

  const partTokens = encodedLength(part.output.value, "ceiling");
  if (partTokens > 0) {
    const targetTokens = Math.max(0, partTokens - tokensToRemove);
    return {
      truncatedPart: {
        ...part,
        output: {
          type: "text",
          value: trimPrompt(part.output.value, targetTokens),
        },
      },
      tokensRemoved: partTokens - targetTokens,
    };
  }

  return { truncatedPart: null, tokensRemoved: partTokens };
}

function truncateToolArrayContent(
  lastMessage: ModelMessage,
  availableTokens: number
): ModelMessage {
  const content = [...(lastMessage.content as unknown[])];
  const currentMessageTokens = calculateMessagesTokens([lastMessage]);
  let tokensToRemove = currentMessageTokens - availableTokens;

  for (let i = content.length - 1; i >= 0 && tokensToRemove > 0; i--) {
    const part = content[i];
    const { truncatedPart, tokensRemoved } = truncateToolResultPart(
      part as {
        type: string;
        output?: {
          value?: string;
        };
      },
      tokensToRemove
    );

    if (truncatedPart === null) {
      content.splice(i, 1);
    } else {
      content[i] = truncatedPart;
    }
    tokensToRemove -= tokensRemoved;
  }

  // biome-ignore lint/style/useObjectSpread: Spread syntax causes TypeScript error with ModelMessage union types
  return Object.assign({}, lastMessage, { content });
}

function truncateLastMessageIfNeeded(
  truncatedMessages: ModelMessage[],
  availableTokens: number,
  currentTokens: number
): void {
  if (currentTokens <= availableTokens || truncatedMessages.length === 0) {
    return;
  }

  const lastMessage = truncatedMessages.at(-1);
  if (!lastMessage) {
    return;
  }

  if (typeof lastMessage.content === "string" && lastMessage.role !== "tool") {
    truncatedMessages[truncatedMessages.length - 1] = truncateStringContent(
      lastMessage,
      availableTokens,
      currentTokens
    );
  } else if (
    Array.isArray(lastMessage.content) &&
    lastMessage.role === "tool"
  ) {
    truncatedMessages[truncatedMessages.length - 1] = truncateToolArrayContent(
      lastMessage,
      availableTokens
    );
  }
}

/**
 * Truncate messages array to fit within token limit.
 *
 * ISSUE #189 NOTE. This drops the OLDEST turns and tells nobody, which is fine
 * for the deep-research pipeline (its callers build a fresh single-message array
 * per call, so nothing durable is lost) but is the wrong shape for a long
 * founder conversation: the phase gate is supposed to check the newest answers
 * against the earliest ones, and a silent drop makes an inconsistency
 * unfindable.
 *
 * The phase workflow answers that a different way — see lib/phases/context.ts.
 * Durable conclusions are extracted into the project fact store and re-injected
 * into the system prompt every turn, ranked and fitted to an explicit budget, so
 * state survives the truncation instead of racing it. When something IS dropped
 * the caller is told (droppedKeys / omittedTurns) rather than left to guess.
 * Prefer that approach over widening this function.
 */
/**
 * NEVER returns an empty array for a non-empty input.
 *
 * A budget too small for even one message is a budget problem, and answering it
 * with `[]` turns it into `AI_InvalidPromptError: messages must not be empty`,
 * thrown by the SDK three layers away from the cause with nothing naming the
 * budget. That is exactly how a `context_window` of 0 — the placeholder
 * `toAiGatewayModel` in lib/ai/gateways/openai-gateway.ts writes because
 * OpenAI's /v1/models reports no context window — silently disabled the entire
 * deep-research pipeline: every model in models.generated.ts carries 0, so
 * every `truncateMessages` call in it discarded every message.
 *
 * Keeping the newest message, trimmed, is the honest failure: the caller gets a
 * degraded prompt it can still act on rather than an opaque error.
 */
export function truncateMessages(
  messages: ModelMessage[],
  maxTokens: number,
  preserveSystemMessage = true
): ModelMessage[] {
  const result = truncateMessagesWithinBudget(
    messages,
    maxTokens,
    preserveSystemMessage
  );
  const newest = messages.at(-1);
  if (newest && result.length === 0) {
    if (typeof newest.content === "string") {
      return [
        // biome-ignore lint/style/useObjectSpread: Spread syntax causes TypeScript error with ModelMessage union types
        Object.assign({}, newest, {
          content: trimPrompt(newest.content, Math.max(1, maxTokens)),
        }),
      ];
    }
    return [newest];
  }
  return result;
}

function truncateMessagesWithinBudget(
  messages: ModelMessage[],
  maxTokens: number,
  preserveSystemMessage: boolean
): ModelMessage[] {
  if (messages.length === 0) {
    return messages;
  }

  const { systemMessage, otherMessages } = extractSystemMessage(
    messages,
    preserveSystemMessage
  );

  const systemTokens = systemMessage
    ? calculateMessagesTokens([systemMessage])
    : 0;
  const availableTokens = maxTokens - systemTokens;

  if (availableTokens <= 0) {
    return handleExceededSystemMessage(systemMessage, maxTokens);
  }

  const truncatedMessages = removeOldestMessagesUntilFit(
    otherMessages,
    availableTokens
  );
  const currentTokens = calculateMessagesTokens(truncatedMessages);

  truncateLastMessageIfNeeded(
    truncatedMessages,
    availableTokens,
    currentTokens
  );

  return systemMessage
    ? [systemMessage, ...truncatedMessages]
    : truncatedMessages;
}
