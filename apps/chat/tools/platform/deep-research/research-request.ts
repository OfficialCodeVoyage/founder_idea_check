import type { ModelMessage } from "ai";
import { getTextContentFromModelMessage } from "@/lib/utils";

/**
 * IS THERE ANYTHING TO RESEARCH? Checked at the call site, before the pipeline.
 *
 * The 2026-08-21 incident: `deepResearch` was invoked with `tool_input = {}` and
 * the founder was shown
 *
 *     Deep research failed with error: Invalid prompt: messages must not be empty
 *
 * Neither `{}` nor an empty conversation was the cause, and this check would not
 * have caught that run. `{}` is not an anomaly — the tool's `inputSchema` IS
 * `z.object({})`, because its subject is the conversation, handed in as
 * `contextForLLM` by tools/platform/tools.ts, and the runs that later succeeded
 * stored `{}` too. The founder's message was also there, in the stored parts.
 * What emptied the prompt was a ZERO TOKEN BUDGET: `getModelContextWindow`
 * passed on the gateway's placeholder `context_window: 0`, `truncateMessages`
 * had no room for even one message and returned `[]`, and the AI SDK's own
 * validator threw three layers down. Fixed in 2cb9c253 at both ends (an
 * unreported window falls back to a floor; `truncateMessages` never returns an
 * empty list for a non-empty one), guarded in lib/ai/token-utils.test.ts. The
 * model then called the tool a second time after the failure, which is why the
 * transcript shows two research blocks: two calls, not one rendered twice.
 *
 * What this file guards is the remaining way to send nothing: a conversation
 * that carries no text at all. No known path builds one today; it is here so the
 * next such bug fails in words, not in the SDK's `messages` array the founder has
 * never heard of.
 *
 * Two properties of the refusal matter more than its wording.
 *
 * 1. IT SAYS NOTHING WAS SEARCHED. A research failure that reads as a research
 *    result is how "no evidence of demand" gets written off the back of a
 *    plumbing bug, and the *Verifying Demand* gate then BLOCKS a founder on it.
 * 2. IT NAMES THE CALL, NOT THE FOUNDER. The model's recovery in the 2026-08-21
 *    transcript was to apologise and ask the founder for "a tiny bit of scope"
 *    — sending them off answering clarifying questions that could not have
 *    helped, because nothing they could say would have changed the budget.
 */

export type ResearchRequestCheck =
  | { ok: true }
  | { ok: false; message: string };

const NOTHING_TO_RESEARCH = `Deep research was started with an empty conversation, so no research question was ever built. Nothing was searched — this is not a finding about your idea, and it is not something you said.

Ask again in a new message saying what you want researched. If it happens a second time on a message that clearly states the topic, the tool is being handed an empty context and that is a bug worth reporting.`;

/** PURE. Refuses a request that carries no text for the brief to be built from. */
export function checkResearchRequest(
  messages: readonly ModelMessage[]
): ResearchRequestCheck {
  const hasText = messages.some(
    (message) => getTextContentFromModelMessage(message).trim().length > 0
  );
  if (hasText) {
    return { ok: true };
  }
  return { ok: false, message: NOTHING_TO_RESEARCH };
}
