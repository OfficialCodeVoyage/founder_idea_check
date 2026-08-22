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
 * `{}` is not the anomaly — the tool's `inputSchema` IS `z.object({})`, because
 * its subject is the conversation, handed in as `contextForLLM` by
 * tools/platform/tools.ts. The anomaly is that the conversation was empty, which
 * nothing checked. `clarifyWithUser` built a one-element prompt from it,
 * `truncateMessages` had nothing to keep, and the AI SDK's own validator threw
 * three layers down. That message names a `messages` array the founder has never
 * heard of and offers them nothing to do.
 *
 * Two properties of the replacement matter more than its wording.
 *
 * 1. IT SAYS NOTHING WAS SEARCHED. A research failure that reads as a research
 *    result is how "no evidence of demand" gets written off the back of a
 *    plumbing bug, and the *Verifying Demand* gate then BLOCKS a founder on it.
 * 2. IT NAMES THE CALL, NOT THE FOUNDER. The model's actual recovery in the
 *    transcript was to apologise and ask the founder for "a tiny bit of scope"
 *    — sending them off answering clarifying questions that could not have
 *    helped, because the tool had never received their brief in the first place.
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
