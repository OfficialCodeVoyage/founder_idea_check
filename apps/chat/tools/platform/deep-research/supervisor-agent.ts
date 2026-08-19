import { hasToolCall, stepCountIs, ToolLoopAgent, tool } from "ai";
import { z } from "zod";
import type { AppModelId, ModelId } from "@/lib/ai/app-models";
import { getLanguageModel } from "@/lib/ai/providers";
import { createSemaphore } from "@/lib/research/supervisor";
import { leadResearcherPrompt } from "./prompts";
import { runResearcher } from "./researcher-agent";
import { type AgentOptions, createTelemetry } from "./types";
import { getTodayStr } from "./utils";

export async function runSupervisor(
  researchBrief: string,
  options: AgentOptions
): Promise<string[]> {
  const { config, dataStream, toolCallId, abortSignal } = options;
  const model = await getLanguageModel(config.research_model as ModelId);

  /**
   * BOUNDED PARALLEL, not serial.
   *
   * What this replaces: a `researchQueue = researchQueue.then(...)` chain, so
   * every conductResearch call waited for the previous one and N topics took N
   * times as long as one. The same function passes
   * `max_concurrent_research_units` into leadResearcherPrompt, telling the model
   * it may request up to N in parallel — so the config value was documentation,
   * not a limit, and nothing in the types or the tests noticed the difference.
   *
   * The semaphore QUEUES the excess, it does not drop it: every topic the model
   * asks for still runs, just at most `max_concurrent_research_units` at a time.
   * That is why `decideOverflow` from lib/research/supervisor.ts is NOT wired in
   * here — its notice tells the model that the excess topics "were NOT run", and
   * on this path that would be false. It belongs to callers that genuinely
   * truncate a request; handing it back here would inject exactly the kind of
   * confident non-finding it exists to prevent.
   */
  const semaphore = createSemaphore(config.max_concurrent_research_units);

  const conductResearchTool = tool({
    description: "Call this tool to conduct research on a specific topic.",
    inputSchema: z.object({
      research_topic: z
        .string()
        .describe(
          "The topic to research. Should be a single topic, and should be described in high detail (at least a paragraph)."
        ),
    }),
    execute: async ({ research_topic }) => {
      const release = await semaphore.acquire();
      try {
        return await runResearcher(research_topic, options);
      } finally {
        release();
      }
    },
  });

  const researchCompleteTool = tool({
    description: "Call this tool to indicate that the research is complete.",
    inputSchema: z.object({}),
    execute: async () => "Research marked as complete.",
  });

  // max_researcher_iterations + 1 to account for the final researchComplete step
  const maxSteps = config.max_researcher_iterations + 1;

  const supervisorAgent = new ToolLoopAgent({
    model,
    instructions: leadResearcherPrompt({
      date: getTodayStr(),
      max_concurrent_research_units: config.max_concurrent_research_units,
    }),
    tools: {
      conductResearch: conductResearchTool,
      researchComplete: researchCompleteTool,
    },
    maxOutputTokens: config.research_model_max_tokens,
    stopWhen: [hasToolCall("researchComplete"), stepCountIs(maxSteps)],
    experimental_telemetry: createTelemetry("supervisor", options),
    onStepFinish: ({ usage, toolCalls }) => {
      if (usage) {
        options.costAccumulator?.addLLMCost(
          config.research_model as AppModelId,
          usage,
          "deep-research-supervisor"
        );
      }

      const topicsResearched = toolCalls
        .filter((tc) => tc.toolName === "conductResearch")
        .map(
          (tc) =>
            (tc as { input: { research_topic: string } }).input.research_topic
        );

      if (topicsResearched.length > 0) {
        dataStream.write({
          type: "data-researchUpdate",
          data: {
            toolCallId,
            title: "Research tasks completed",
            message: `Researched: ${topicsResearched.join(", ")}`,
            type: "thoughts",
            status: "completed",
          },
        });
      }
    },
  });

  const { steps } = await supervisorAgent.generate({
    prompt: researchBrief,
    abortSignal,
  });

  return steps.flatMap((step) =>
    step.toolResults
      .filter((tr) => tr.toolName === "conductResearch")
      .map((tr) => String(tr.output))
  );
}
