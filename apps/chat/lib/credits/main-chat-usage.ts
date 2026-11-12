import type { LanguageModelUsage, TextStreamPart, ToolSet } from "ai";
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
};

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
 *  - Input, when the cut step is the first: `countPromptTokens()`, which the
 *    caller computes from the system prompt and messages with the repo's
 *    tokenizer (`lib/ai/token-utils.ts`, the counter the route's request-size
 *    check uses) rather than a 4-characters-per-token guess. A floor too: tool
 *    definitions are not counted. Called only on that path, since it
 *    tokenizes the whole prompt.
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
 * Tool calls made inside a step (deep research, image generation, …) record
 * their own model calls under their own sources; a step's usage is the chat
 * model's alone, so nothing here overlaps them.
 */
export function createMainChatUsageMeter<TOOLS extends ToolSet>({
  costAccumulator,
  modelId,
  countTokens,
  countPromptTokens,
  onCutStepEstimated,
  onStepWithoutUsage,
}: {
  costAccumulator: CostAccumulator;
  modelId: AppModelId;
  /** Tokens in a piece of streamed output. */
  countTokens: (text: string) => number;
  /** Tokens in the turn's prompt; called only when step 1 is cut. */
  countPromptTokens: () => number;
  onCutStepEstimated?: (estimate: CutStepEstimate) => void;
  onStepWithoutUsage?: (finishReason: string) => void;
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
    const outputTokens = text.length > 0 ? countTokens(text) : 0;
    const estimate: CutStepEstimate = lastCompletedStep
      ? {
          inputTokens:
            lastCompletedStep.inputTokens + lastCompletedStep.outputTokens,
          outputTokens,
          inputBasis: "previous-step",
          streamedChars: text.length,
        }
      : {
          inputTokens: countPromptTokens(),
          outputTokens,
          inputBasis: "prompt-count",
          streamedChars: text.length,
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

  return () => {
    const transformer: MeterTransformer = {
      transform(part, controller) {
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
            recordStep(part.usage, part.finishReason);
            stepOpen = false;
            streamed = [];
            break;
          case "abort":
            closeCutStep();
            break;
          default:
            break;
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
        closeCutStep();
      },
    };
    return new TransformStream(transformer);
  };
}
