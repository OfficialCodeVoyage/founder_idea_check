import { type ModelMessage, Output, streamText } from "ai";
import { z } from "zod";
import { getLanguageModel } from "@/lib/ai/providers";
import type { StreamWriter } from "@/lib/ai/types";
import { config } from "@/lib/config";
import type { CostAccumulator } from "@/lib/credits/cost-accumulator";
import { createModuleLogger } from "@/lib/logger";
import { generateUUID, getTextContentFromModelMessage } from "@/lib/utils";

const FOLLOWUP_CONTEXT_MESSAGES = 2;

const log = createModuleLogger("ai:followup-suggestions");

/**
 * PURE. The last few conversational turns, AS PLAIN TEXT ONLY.
 *
 * This used to be `modelMessages.slice(-2)`. After a turn that called a tool,
 * the tail of the conversation is an assistant tool call, a `tool` message
 * carrying its result, and the closing assistant text — so a two-message slice
 * kept the result and cut off the call it answers. OpenAI rejects that request
 * with HTTP 400 "No tool call found for function call output", and the
 * follow-up suggestions failed after every tool turn.
 *
 * Keeping only text makes an orphan impossible by construction rather than by
 * pairing calls with results: `tool` messages are dropped whole, tool-call,
 * tool-result, reasoning and file parts are dropped from the rest, and a
 * message left with no text is skipped so the window still holds real turns.
 * Suggesting the next question needs what was said, not the tool payloads.
 */
export function followupContext(
  modelMessages: readonly ModelMessage[]
): ModelMessage[] {
  const turns: ModelMessage[] = [];
  for (const message of modelMessages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }
    const text = getTextContentFromModelMessage(message).trim();
    if (text.length === 0) {
      continue;
    }
    turns.push({ role: message.role, content: text });
  }
  return turns.slice(-FOLLOWUP_CONTEXT_MESSAGES);
}

export async function generateFollowupSuggestions(
  modelMessages: ModelMessage[]
) {
  const maxQuestionCount = 5;
  const minQuestionCount = 3;
  const maxCharactersPerQuestion = 80;
  const recentMessages = followupContext(modelMessages);
  return streamText({
    model: await getLanguageModel(config.ai.tools.followupSuggestions.default),
    messages: [
      ...recentMessages,
      {
        role: "user",
        content: `What question should I ask next? Return an array of suggested questions (minimum ${minQuestionCount}, maximum ${maxQuestionCount}). Each question should be no more than ${maxCharactersPerQuestion} characters.`,
      },
    ],
    output: Output.object({
      schema: z.object({
        suggestions: z
          .array(z.string())
          .min(minQuestionCount)
          .max(maxQuestionCount),
      }),
    }),
  });
}

export async function streamFollowupSuggestions({
  followupSuggestionsResult,
  writer,
  costAccumulator,
}: {
  followupSuggestionsResult: ReturnType<typeof generateFollowupSuggestions>;
  writer: StreamWriter;
  /**
   * The turn's accumulator. This call is a model call like any other and was
   * the one in the turn that never reached it, so its tokens went unbilled.
   */
  costAccumulator?: CostAccumulator;
}) {
  const dataPartId = generateUUID();
  const result = await followupSuggestionsResult;

  for await (const chunk of result.partialOutputStream) {
    writer.write({
      id: dataPartId,
      type: "data-followupSuggestions",
      data: {
        suggestions:
          chunk.suggestions?.filter(
            (suggestion): suggestion is string => suggestion !== undefined
          ) ?? [],
      },
    });
  }

  if (!costAccumulator) {
    return;
  }
  // Awaited HERE, inside the route's `execute`, so the entry is recorded
  // before onFinish settles the accumulator. Suggestions are optional, so a
  // failure to read usage is logged rather than allowed to fail the turn.
  try {
    costAccumulator.addLLMCost(
      config.ai.tools.followupSuggestions.default,
      await result.totalUsage,
      "followup-suggestions"
    );
  } catch (error) {
    log.error({ error }, "could not read follow-up suggestion usage; unbilled");
  }
}
