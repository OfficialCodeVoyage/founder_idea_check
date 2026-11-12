// Server-only, deliberately NOT "use server": a server action is an HTTP
// endpoint any client can POST to, and this one spends model money with no
// session check. Its callers (`app/(chat)/api/chat/route.ts` and
// `api/chat/prepare/route.ts`) are route handlers that run it only after
// resolving a signed-in user; anonymous chats are not persisted and get no
// title.
import "server-only";
import { generateText } from "ai";
import { getLanguageModel } from "@/lib/ai/providers";
import type { ChatMessage } from "@/lib/ai/types";
import { config } from "@/lib/config";

export async function generateTitleFromUserMessage({
  message,
}: {
  message: ChatMessage;
}) {
  const { text: title } = await generateText({
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

  return title;
}
