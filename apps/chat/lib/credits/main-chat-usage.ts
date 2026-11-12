import type {
  LanguageModelUsage,
  ModelMessage,
  TextStreamPart,
  ToolSet,
} from "ai";
import type { AppModelId } from "../ai/app-models";
import type { CostAccumulator } from "./cost-accumulator";

/** The accumulator source of a step the provider reported usage for. */
export const MAIN_CHAT_SOURCE = "main-chat";

/**
 * The accumulator source of a step an abort or a broken provider connection
 * cut off. The name says it is an estimate, so the entries the route logs
 * before it charges cannot be read as provider-reported usage.
 */
export const MAIN_CHAT_CUT_STEP_SOURCE = "main-chat (estimate: step cut off)";

/** How the cut step's input was estimated. See `createMainChatUsageMeter`. */
export type CutStepInputBasis = "previous-step" | "prompt-count";

export type CutStepEstimate = {
  inputTokens: number;
  outputTokens: number;
  inputBasis: CutStepInputBasis;
  /** Characters of text, reasoning and tool input the cut step streamed. */
  streamedChars: number;
  /**
   * "characters" when the tokenizer threw and a count fell back to
   * `FALLBACK_CHARS_PER_TOKEN`; "tokenizer" otherwise.
   */
  countedBy: "tokenizer" | "characters";
};

/**
 * The repo's characters-per-token heuristic (`lib/phases/context.ts`
 * `approxTokenCount`), used only when the tokenizer throws.
 */
const FALLBACK_CHARS_PER_TOKEN = 4;

/**
 * What step 1's prompt is known to contain at least: text to tokenize, and a
 * fixed token count for the attachments whose tokens text cannot give.
 */
export type PromptFloor = { texts: string[]; attachmentTokens: number };

/**
 * What one image is counted as: OpenAI's flat charge for a low-detail image on
 * its tile-priced models (85 base tokens, GPT-4o class), which every detail
 * level of those models adds at least. Patch-priced models can bill a very
 * small image below it, so it is a conservative per-image minimum rather than
 * a proven floor for every model; it replaces the flat 765 (a typical
 * high-detail image) that overcounted, and the 0 that undercounted.
 */
export const IMAGE_FLOOR_TOKENS = 85;

/**
 * A file that is neither an image nor inline text (a PDF, or a file sent by
 * URL) is counted at the image floor. OpenAI gives the model a PDF as its
 * extracted text plus an image of every page, so one page already costs at
 * least one image; any other file is as small as the provider makes it, and
 * this repo cannot read its text here without parsing it.
 */
const OTHER_FILE_FLOOR_TOKENS = IMAGE_FLOOR_TOKENS;

const TEXT_MEDIA_TYPE = /^(?:text\/|application\/(?:json|xml|csv)\b)/;

type PromptPart = Exclude<ModelMessage["content"], string>[number];
type ToolOutput = Extract<PromptPart, { type: "tool-result" }>["output"];

/** The UTF-8 text of an inline file, or null when it is sent by URL. */
function inlineText(data: string | Uint8Array | ArrayBuffer | URL) {
  if (data instanceof URL) {
    return null;
  }
  if (typeof data === "string") {
    // `DataContent` strings are base64.
    return Buffer.from(data, "base64").toString("utf8");
  }
  return new TextDecoder().decode(data);
}

function addToolOutput(output: ToolOutput, floor: PromptFloor) {
  switch (output.type) {
    case "text":
    case "error-text":
      floor.texts.push(output.value);
      return;
    case "json":
    case "error-json":
      floor.texts.push(JSON.stringify(output.value));
      return;
    case "execution-denied":
      if (output.reason) {
        floor.texts.push(output.reason);
      }
      return;
    case "content":
      for (const item of output.value) {
        if (item.type === "text") {
          floor.texts.push(item.text);
        } else {
          floor.attachmentTokens += IMAGE_FLOOR_TOKENS;
        }
      }
      return;
    default:
      return;
  }
}

function addPart(part: PromptPart, floor: PromptFloor) {
  switch (part.type) {
    case "text":
      floor.texts.push(part.text);
      return;
    case "tool-call":
      floor.texts.push(JSON.stringify(part.input) ?? "");
      return;
    case "tool-result":
      addToolOutput(part.output, floor);
      return;
    case "image":
      floor.attachmentTokens += IMAGE_FLOOR_TOKENS;
      return;
    case "file": {
      if (part.mediaType.startsWith("image/")) {
        floor.attachmentTokens += IMAGE_FLOOR_TOKENS;
        return;
      }
      const text = TEXT_MEDIA_TYPE.test(part.mediaType)
        ? inlineText(part.data)
        : null;
      if (text === null) {
        floor.attachmentTokens += OTHER_FILE_FLOOR_TOKENS;
      } else {
        floor.texts.push(text);
      }
      return;
    }
    default:
      // Reasoning (OpenAI resends it as encrypted items whose size is not
      // known here) and tool approvals: left out, so the count stays a floor.
      return;
  }
}

/**
 * The floor of a prompt, for the step-1 estimate of `createMainChatUsageMeter`:
 *  - the system prompt, string contents and text parts, as text;
 *  - a tool call's input and a tool result's output, serialised to the JSON
 *    or text the provider is sent, as text: their real content;
 *  - an image, or an image inside a tool result, at `IMAGE_FLOOR_TOKENS`;
 *  - a text file (`text/*`, JSON, XML, CSV) sent inline, as its text; any
 *    other file at `OTHER_FILE_FLOOR_TOKENS`.
 * Left out, so it stays a floor: tool definitions, message framing, reasoning
 * and the provider's own wrapping of every part.
 */
export function promptFloor(
  system: string,
  messages: ModelMessage[]
): PromptFloor {
  const floor: PromptFloor = { texts: [system], attachmentTokens: 0 };
  for (const message of messages) {
    if (typeof message.content === "string") {
      floor.texts.push(message.content);
      continue;
    }
    for (const part of message.content) {
      addPart(part, floor);
    }
  }
  return floor;
}

function hasReportedUsage(usage: LanguageModelUsage): boolean {
  return usage.inputTokens !== undefined || usage.outputTokens !== undefined;
}

/**
 * Records the chat model's own usage into the turn's accumulator ONE STEP AT A
 * TIME, as a `streamText` transform, and estimates the step an abort cuts off.
 *
 * WHY PER STEP. The route used to record "main-chat" usage once, from the
 * stream's final `finish` part (`totalUsage`). `streamText` writes no `finish`
 * part when the turn is aborted (the stop button, through `canceledAt`, or the
 * route's deadline timer: it writes `abort` and closes) or when a provider
 * error ends a later step (`finish-step`, `error`, close). Every completed step
 * had been paid for by then, and none of it was charged: a stop pressed in
 * step 2 after a 40k-token tool step recorded nothing (verified with mock
 * models on ai@6.0.219). Each step's `finish-step` part carries the usage the
 * provider reported for that step, so recording it there charges what was
 * spent however the turn ends. The route no longer reads `totalUsage`, so no
 * step is counted twice.
 *
 * WHY A TRANSFORM AND NOT `onStepFinish` / `onAbort`. `onAbort` runs at the
 * head of `streamText`'s pipeline, the moment its reader sees the signal; the
 * parts already read are still on their way through the transforms to
 * `onChunk` and `onStepFinish` (`markdownJoinerTransform` holds text back by
 * design). Estimating there could miss streamed text, or estimate a step whose
 * `finish-step` is still in flight and is then recorded as well. A transform
 * sees every part in stream order, and `abort` is always the last one, so the
 * cut step is exactly "a `start-step` with no `finish-step` before `abort`".
 * It must be the FIRST transform, ahead of the markdown joiner, so the text it
 * counts is what the model streamed rather than what the joiner released.
 * Everything is recorded before the part moves on, so it is all in the
 * accumulator by the time `result.consumeStream()` resolves.
 *
 * THE CUT STEP'S ESTIMATE, labelled `MAIN_CHAT_CUT_STEP_SOURCE`:
 *  - Output: the characters the step streamed (text, reasoning and tool-input
 *    deltas) run through `countTokens`. A floor: a reasoning model streams a
 *    summary of its reasoning, not the reasoning tokens it is billed for.
 *  - Input, when an earlier step of this turn completed: that step's input
 *    plus its output, both provider-reported, because the cut step's prompt
 *    is the earlier step's prompt with the earlier step's output appended.
 *    Still a floor: the tool results that also joined the prompt are not
 *    counted. Preferred over counting the prompt because it is the provider's
 *    own number for all but the last addition.
 *  - Input, when the cut step is the first: `getPromptFloor()`, which the
 *    caller builds with `promptFloor` (its docblock lists the rules): the
 *    prompt's text, tool calls and tool results run through `countTokens`
 *    (the repo's tokenizer, `lib/ai/token-utils.ts`) rather than a
 *    4-characters-per-token guess, plus a per-attachment minimum for images
 *    and files. A floor: tool definitions and message framing are not
 *    counted. It deliberately does not reuse `calculateMessagesTokens`, which
 *    adds a flat 765 tokens for every non-text part whatever its size, and so
 *    overcounted a turn with many small tool calls by thousands of tokens.
 *    Called only on that path, since it tokenizes the whole prompt.
 *  - Nothing, when no `start-step` was seen since the last step finished (the
 *    abort landed before the provider sent the next step's first chunk): no
 *    evidence the provider began that step, so nothing is charged for it.
 *
 * A STOP WHILE A TOOL RUNS IS ESTIMATED TOO, though the model call that asked
 * for the tool is over and the provider reported its usage: `streamText`
 * writes a step's `finish-step` only once the step's tool calls have returned
 * (verified on ai@6.0.219), so the abort reaches this transform first and
 * the step's reported usage is never surfaced. The stop button pressed during
 * deep research, and the deadline that a long tool runs into, both take this
 * path.
 *
 * A STEP WHOSE CONNECTION DIES IS ESTIMATED TOO. When the provider's HTTP
 * body breaks mid-step (a socket reset, a network failure), `streamText`
 * errors the stream: no `abort`, `error` or `finish-step` part arrives, and
 * the transform's `cancel` runs instead. It estimates the open step exactly as
 * an abort would; a step already recorded or estimated is closed, so it is
 * never charged twice.
 *
 * A step that ended in a provider error is recorded from its `finish-step`
 * like any other. Whether that carries usage is the provider's call: OpenAI's
 * `response.failed` event carries `response.usage`, which the SDK reports; a
 * bare `error` event carries none, and such a step is then not recorded
 * (`onStepWithoutUsage` says so) rather than recorded as zero.
 *
 * A METER FAILURE NEVER BREAKS THE STREAM OR DROPS THE ESTIMATE. A count that
 * throws falls back to `FALLBACK_CHARS_PER_TOKEN` (the estimate says
 * `countedBy: "characters"`), and anything else the bookkeeping throws is
 * reported through `onMeterError` while the part still moves on. Before this, a
 * tokenizer throw inside the estimate errored the chat stream: the client got
 * `error` instead of `abort`, `onFinish` saw `isAborted` false and ran the
 * post-turn passes on a partial turn, and the cut step was charged nothing.
 *
 * Tool calls made inside a step (deep research, image generation, …) record
 * their own model calls under their own sources; a step's usage is the chat
 * model's alone, so nothing here overlaps them.
 */
export function createMainChatUsageMeter<TOOLS extends ToolSet>({
  costAccumulator,
  modelId,
  countTokens,
  getPromptFloor,
  onCutStepEstimated,
  onStepWithoutUsage,
  onMeterError,
}: {
  costAccumulator: CostAccumulator;
  modelId: AppModelId;
  /** Tokens in a piece of streamed output. */
  countTokens: (text: string) => number;
  /**
   * The floor of the turn's prompt (`promptFloor`), counted as step 1's
   * input; called only when step 1 is cut.
   */
  getPromptFloor: () => PromptFloor;
  onCutStepEstimated?: (estimate: CutStepEstimate) => void;
  onStepWithoutUsage?: (finishReason: string) => void;
  /** Something in the meter threw; the stream went on regardless. */
  onMeterError?: (error: unknown) => void;
}): () => TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>> {
  let stepOpen = false;
  let streamed: string[] = [];
  let lastCompletedStep: { inputTokens: number; outputTokens: number } | null =
    null;

  function recordStep(usage: LanguageModelUsage, finishReason: string) {
    if (!hasReportedUsage(usage)) {
      onStepWithoutUsage?.(finishReason);
      return;
    }
    costAccumulator.addLLMCost(modelId, usage, MAIN_CHAT_SOURCE);
    lastCompletedStep = {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    };
  }

  function recordCutStep(text: string) {
    let countedBy: CutStepEstimate["countedBy"] = "tokenizer";
    const count = (piece: string) => {
      if (piece.length === 0) {
        return 0;
      }
      try {
        return countTokens(piece);
      } catch (error) {
        countedBy = "characters";
        onMeterError?.(error);
        return Math.ceil(piece.length / FALLBACK_CHARS_PER_TOKEN);
      }
    };
    const countPromptFloor = () => {
      let floor: PromptFloor;
      try {
        floor = getPromptFloor();
      } catch (error) {
        // The output is still charged; the input has no count to fall back to.
        countedBy = "characters";
        onMeterError?.(error);
        return 0;
      }
      const { texts, attachmentTokens } = floor;
      let tokens = attachmentTokens;
      for (const piece of texts) {
        tokens += count(piece);
      }
      return tokens;
    };

    const outputTokens = count(text);
    const estimate: CutStepEstimate = lastCompletedStep
      ? {
          inputTokens:
            lastCompletedStep.inputTokens + lastCompletedStep.outputTokens,
          outputTokens,
          inputBasis: "previous-step",
          streamedChars: text.length,
          countedBy,
        }
      : {
          inputTokens: countPromptFloor(),
          outputTokens,
          inputBasis: "prompt-count",
          streamedChars: text.length,
          countedBy,
        };
    costAccumulator.addLLMCost(
      modelId,
      {
        inputTokens: estimate.inputTokens,
        outputTokens: estimate.outputTokens,
      },
      MAIN_CHAT_CUT_STEP_SOURCE
    );
    onCutStepEstimated?.(estimate);
  }

  /** Estimates the open step, if any, exactly once, and closes it. */
  function closeCutStep() {
    const wasOpen = stepOpen;
    const text = streamed.join("");
    stepOpen = false;
    streamed = [];
    if (wasOpen) {
      recordCutStep(text);
    }
  }

  // `cancel` is in the Streams standard and in Node's TransformStream, but not
  // yet in TypeScript's `Transformer` type, so the type adds it.
  type MeterTransformer = Transformer<
    TextStreamPart<TOOLS>,
    TextStreamPart<TOOLS>
  > & { cancel: (reason: unknown) => void };

  function track(part: TextStreamPart<TOOLS>) {
    switch (part.type) {
      case "start-step":
        stepOpen = true;
        streamed = [];
        break;
      case "text-delta":
      case "reasoning-delta":
        streamed.push(part.text);
        break;
      case "tool-input-delta":
        streamed.push(part.delta);
        break;
      case "finish-step":
        stepOpen = false;
        streamed = [];
        recordStep(part.usage, part.finishReason);
        break;
      case "abort":
        closeCutStep();
        break;
      default:
        break;
    }
  }

  return () => {
    const transformer: MeterTransformer = {
      transform(part, controller) {
        try {
          track(part);
        } catch (error) {
          onMeterError?.(error);
        }
        controller.enqueue(part);
      },
      // The stream ended without an `abort` part: the provider's connection
      // died mid-step (a socket reset, undici's "terminated"), so `streamText`
      // errored the stream, or the reader downstream cancelled it. Neither
      // writes a `finish-step`, `error` or `abort` part, and the step the
      // provider had begun is as spent as one a stop cut off (verified with a
      // mock model on ai@6.0.219 and Node 24, which calls `cancel` when the
      // upstream errors). `closeCutStep` estimates it only while it is still
      // open, so a step already recorded or estimated is never charged twice.
      cancel() {
        try {
          closeCutStep();
        } catch (error) {
          onMeterError?.(error);
        }
      },
    };
    return new TransformStream(transformer);
  };
}
