import { describe, expect, it } from "vitest";
import { config } from "@/lib/config";

/**
 * THE POINT OF THIS FILE IS THAT `maxOutputTokens` IS NOT ANOTHER DEAD KNOB.
 *
 * `chat.config.ts` already carried `ai.tools.deepResearch.maxInputTokensPerRun`,
 * which is parsed, typed, documented — and read by nothing. A second setting
 * with the same fate would be worse than no setting at all, because the next
 * person to hit a truncated turn would change the number and watch nothing
 * happen.
 *
 * So this asserts two things: that the value survives `applyDefaults` (a field
 * missing from the zod schema is silently STRIPPED, so a typo would leave
 * `config.ai.maxOutputTokens` undefined at the call site rather than failing
 * loudly), and that the reader in lib/ai/core-chat-agent.ts still names it.
 */
describe("ai.maxOutputTokens", () => {
  it("survives config parsing as a positive integer", () => {
    expect(config.ai.maxOutputTokens).toBe(32_000);
    expect(Number.isInteger(config.ai.maxOutputTokens)).toBe(true);
  });

  it("is read where a turn's output is actually bounded", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        new URL("./lib/ai/core-chat-agent.ts", import.meta.url),
        "utf8"
      )
    );
    // streamText is the only place an output ceiling can be enforced. If this
    // fails, the knob has gone dead and must be removed or rewired.
    expect(source).toContain("maxOutputTokens: Math.min(");
    expect(source).toContain("config.ai.maxOutputTokens");
  });
});
