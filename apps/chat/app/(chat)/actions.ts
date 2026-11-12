// Server-only, deliberately NOT "use server": a server action is an HTTP
// endpoint any client can POST to, and this one spends model money with no
// session check. Its callers (`app/(chat)/api/chat/route.ts` and
// `api/chat/prepare/route.ts`) are route handlers that run it only after
// resolving a signed-in user; anonymous chats are not persisted and get no
// title.
import "server-only";
import { generateText, type LanguageModelUsage } from "ai";
import { getLanguageModel } from "@/lib/ai/providers";
import type { ChatMessage } from "@/lib/ai/types";
import { config } from "@/lib/config";
import { CostAccumulator } from "@/lib/credits/cost-accumulator";
import { deductCredits } from "@/lib/db/credits";
import { createModuleLogger } from "@/lib/logger";

const log = createModuleLogger("chat:title");

export async function generateTitleFromUserMessage({
  message,
  userId,
}: {
  message: ChatMessage;
  /** The signed-in user whose new chat this titles, and who pays for it. */
  userId: string;
}) {
  const { text: title, usage } = await generateText({
    model: await getLanguageModel(config.ai.workflows.title),
    system: `Generate a concise title for a chat conversation based on the user's first message.

Rules (strictly follow all):
- Maximum 40 characters — hard limit, never exceed this
- 3-6 words is ideal
- No quotes, colons, or punctuation at the end
- No filler words like "How to" or "Question about"
- Use title case
- Return ONLY the title, nothing else`,
    prompt: JSON.stringify(message),
    experimental_telemetry: { isEnabled: true },
  });

  await chargeTitleCost({ userId, usage });

  return title;
}

/**
 * Charges the title call to the user whose chat it titles. It used to be the
 * one model call on a new chat that was never charged: it runs before the
 * turn's `CostAccumulator` exists (and in `/api/chat/prepare`, in a different
 * request from the turn), so nothing ever recorded its usage.
 *
 * Settled on its own accumulator and deducted at once, the way the post-turn
 * passes are, so the whole-cent rounding in `CostAccumulator.settle` applies to
 * this call separately. NEVER THROWS: a failed charge is logged, and the chat
 * is still created with its title — refusing the founder's first message
 * because a credit write failed would be the worse failure.
 */
async function chargeTitleCost({
  userId,
  usage,
}: {
  userId: string;
  usage: LanguageModelUsage;
}): Promise<void> {
  try {
    const cost = new CostAccumulator();
    cost.addLLMCost(
      config.ai.workflows.title,
      { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      "title"
    );
    const { cents, unpriced } = await cost.settle();
    if (unpriced.length > 0) {
      log.error(
        { unpriced, cents },
        "The title call could not be priced; the deducted total is an undercount"
      );
    }
    if (cents > 0) {
      await deductCredits(userId, cents);
    }
  } catch (error) {
    log.error({ error }, "Failed to charge the title call");
  }
}
