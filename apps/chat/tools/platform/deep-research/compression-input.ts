import type { ModelMessage, ToolResultPart } from "ai";

/**
 * WHAT THE COMPRESSION CALL READS: the researcher's work as plain text, in ONE
 * user message.
 *
 * It used to be the researcher's own messages replayed, tool calls, tool
 * results and all, under a different system prompt and with no tools. The
 * Anthropic API rejects that twice over: a request whose messages hold
 * `tool_use` or `tool_result` blocks must define tools, and with thinking on, a
 * replayed assistant tool turn must start with a thinking block, which the
 * replay had stripped (it was bound to the researcher's own request and would
 * have been rejected too). Either 400 is rethrown by `compressResearch`, so the
 * topic's findings were lost on every compression call. As text there are no
 * tool blocks and no assistant turn, so neither rule applies, on any provider.
 *
 * PURE. The token counter is passed in, so this module has no I/O.
 */

/**
 * HOW MUCH MORE CLAUDE COUNTS. The budget is measured with this repo's o200k
 * counter (`lib/ai/token-utils.ts::countTextTokens`, OpenAI's tokenizer), and
 * compression runs on Claude Sonnet 5.5, whose tokenizer counts the same text
 * as about 30% more tokens. An o200k count is multiplied by this before it is
 * held against the model's context window, so a log measured just under the
 * window is not 1.3 times over it at the API ("prompt is too long"). A working
 * figure, not measured on this repo's text; on an OpenAI model it only makes
 * the budget stricter.
 */
export const CLAUDE_TOKENS_PER_O200K_TOKEN = 1.3;

type LogEntry = {
  kind: "call" | "result" | "note";
  /** "Call 2: webSearch {...}", "Result of call 2 (webSearch):", ... */
  header: string;
  body: string;
};

/** Where an over-long log's result bodies went. */
const RESULT_LEFT_OUT =
  "(left out: the research log was longer than the compression model can read, so the oldest results were dropped first)";

const ENTRY_SEPARATOR = "\n\n";

/**
 * PURE. The researcher's messages as log entries, in order: each tool call
 * with its input, each result labelled with the call it answers, and the
 * researcher's own text. Thinking is skipped: it is not what compression
 * condenses, and a reasoning part carries nothing a later model can read.
 */
export function researchLogEntries(
  messages: readonly ModelMessage[]
): LogEntry[] {
  const callNumbers = new Map<string, number>();
  const entries: LogEntry[] = [];
  const note = (text: string) => {
    if (text.trim().length > 0) {
      entries.push({ kind: "note", header: "Researcher's note:", body: text });
    }
  };

  for (const message of messages) {
    if (message.role === "system") {
      continue;
    }
    if (typeof message.content === "string") {
      note(message.content);
      continue;
    }
    for (const part of message.content) {
      if (part.type === "text") {
        note(part.text);
      } else if (part.type === "tool-call") {
        const number = callNumbers.size + 1;
        callNumbers.set(part.toolCallId, number);
        entries.push({
          kind: "call",
          header: `Call ${number}: ${part.toolName} ${JSON.stringify(part.input)}`,
          body: "",
        });
      } else if (part.type === "tool-result") {
        const number = callNumbers.get(part.toolCallId);
        entries.push({
          kind: "result",
          header: `Result of ${number === undefined ? "a call" : `call ${number}`} (${part.toolName}):`,
          body: toolOutputText(part.output),
        });
      }
    }
  }
  return entries;
}

/** PURE. A tool result's output as text. A failed call says so. */
function toolOutputText(output: ToolResultPart["output"]): string {
  switch (output.type) {
    case "text":
      return output.value;
    case "json":
      return JSON.stringify(output.value);
    case "error-text":
      return `(the call failed) ${output.value}`;
    case "error-json":
      return `(the call failed) ${JSON.stringify(output.value)}`;
    case "content":
      return output.value
        .map((item) => (item.type === "text" ? item.text : `[${item.type}]`))
        .join("\n");
    default:
      return JSON.stringify(output);
  }
}

function entryText(entry: LogEntry): string {
  return entry.body.length > 0
    ? `${entry.header}\n${entry.body}`
    : entry.header;
}

/** PURE. `text` cut at its end until it counts at most `maxTokens`. */
function trimToTokens(
  text: string,
  maxTokens: number,
  countTokens: (text: string) => number
): string {
  let trimmed = text;
  let tokens = countTokens(trimmed);
  while (tokens > maxTokens && trimmed.length > 0) {
    const keep = Math.floor(trimmed.length * (maxTokens / tokens) * 0.95);
    trimmed = trimmed.slice(0, Math.max(0, keep));
    tokens = countTokens(trimmed);
  }
  return trimmed;
}

export type CompressionPrompt = {
  /** The one user message: topic, log, closing instruction. */
  prompt: string;
  /** How many results' bodies were left out, oldest first. */
  resultsLeftOut: number;
  /** True when the newest result had to be cut to fit. */
  newestResultCut: boolean;
  /** Log entries dropped whole, oldest first: only when calls and notes alone overflow. */
  entriesDropped: number;
};

/**
 * PURE. The compression call's user message: the topic, the research log and
 * the closing instruction.
 *
 * OVER BUDGET, THE OLDEST RESULTS GO FIRST. The topic and the closing
 * instruction are always kept whole, and so is every call line, so the note's
 * list of queries stays complete. Result bodies are left out oldest first, all
 * but the newest; if that is not enough, the newest result is cut at its end.
 * Only if the calls and notes alone still overflow, which the researcher's
 * 1,500-token step cap makes all but impossible, are whole entries dropped,
 * oldest first. The budget is the context window less the output cap, in
 * Claude tokens (`CLAUDE_TOKENS_PER_O200K_TOKEN`).
 */
export function buildCompressionPrompt({
  topic,
  messages,
  system,
  instruction,
  contextWindow,
  maxOutputTokens,
  countTokens,
}: {
  topic: string;
  messages: readonly ModelMessage[];
  /** The system prompt, counted against the same window. */
  system: string;
  instruction: string;
  contextWindow: number;
  maxOutputTokens: number;
  countTokens: (text: string) => number;
}): CompressionPrompt {
  const frame = (log: string) =>
    `The topic the researcher was given:\n<Research Topic>\n${topic}\n</Research Topic>\n\nWhat the researcher did, in order: each tool call it made, what the call returned, and its own notes.\n<Research Log>\n${log}\n</Research Log>\n\n${instruction}`;

  const windowInO200k = Math.floor(
    (contextWindow - maxOutputTokens) / CLAUDE_TOKENS_PER_O200K_TOKEN
  );
  const logBudget =
    windowInO200k - countTokens(system) - countTokens(frame(""));

  const entries = researchLogEntries(messages);
  const separatorTokens = countTokens(ENTRY_SEPARATOR);
  const tokens = entries.map(
    (entry) => countTokens(entryText(entry)) + separatorTokens
  );
  let total = tokens.reduce((sum, n) => sum + n, 0);

  const results = entries.flatMap((entry, index) =>
    entry.kind === "result" ? [index] : []
  );
  let resultsLeftOut = 0;
  for (const index of results.slice(0, -1)) {
    if (total <= logBudget) {
      break;
    }
    entries[index] = { ...entries[index], body: RESULT_LEFT_OUT };
    const shorter = countTokens(entryText(entries[index])) + separatorTokens;
    total -= tokens[index] - shorter;
    tokens[index] = shorter;
    resultsLeftOut += 1;
  }

  let newestResultCut = false;
  const newest = results.at(-1);
  if (total > logBudget && newest !== undefined) {
    const room =
      logBudget -
      (total - tokens[newest]) -
      countTokens(entries[newest].header) -
      separatorTokens * 2;
    const body =
      room > 0
        ? `${trimToTokens(entries[newest].body, room, countTokens)}\n(cut here: the research log was longer than the compression model can read)`
        : RESULT_LEFT_OUT;
    entries[newest] = { ...entries[newest], body };
    const shorter = countTokens(entryText(entries[newest])) + separatorTokens;
    total -= tokens[newest] - shorter;
    tokens[newest] = shorter;
    newestResultCut = true;
  }

  let entriesDropped = 0;
  while (total > logBudget && entriesDropped < entries.length) {
    total -= tokens[entriesDropped];
    entriesDropped += 1;
  }

  const log = entries
    .slice(entriesDropped)
    .map(entryText)
    .join(ENTRY_SEPARATOR);
  return {
    prompt: frame(log),
    resultsLeftOut,
    newestResultCut,
    entriesDropped,
  };
}
