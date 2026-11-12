import type { ModelMessage } from "ai";
import { getEncoding } from "js-tiktoken";
import { RecursiveCharacterTextSplitter } from "./text-splitter";

const MinChunkSize = 140;
const encoder = getEncoding("o200k_base");

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
 */
function encodedLength(text: string): number {
  return encoder.encode(text, [], []).length;
}

/**
 * Token count of a bare string, with no message-envelope overhead.
 *
 * calculateMessagesTokens() adds the role tokens and a +5 structural overhead
 * per message, which is wrong for counting a prompt fragment such as a fact
 * line. lib/phases/context.ts takes a TokenCounter seam whose default is the
 * repo's chars/4 heuristic; this is the real counter that lib/phases/runtime.ts
 * injects in production.
 */
export function countTextTokens(text: string): number {
  return encodedLength(text);
}

// Calculate total tokens from messages
export function calculateMessagesTokens(messages: ModelMessage[]): number {
  let totalTokens = 0;

  for (const message of messages) {
    // Count tokens for role
    totalTokens += encodedLength(message.role);

    // Count tokens for content - handle both string and array formats
    if (typeof message.content === "string") {
      totalTokens += encodedLength(message.content);
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "text") {
          totalTokens += encodedLength(part.text);
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

  const length = encodedLength(prompt);
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

  const partTokens = encodedLength(part.output.value);
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
