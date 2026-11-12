import { hasToolCall, stepCountIs, ToolLoopAgent, tool } from "ai";
import { z } from "zod";
import type { AppModelId, ModelId } from "@/lib/ai/app-models";
import { getLanguageModel } from "@/lib/ai/providers";
import { createSemaphore } from "@/lib/research/supervisor";
import { leadResearcherPrompt } from "./prompts";
import { canStartResearchTopic, recordCut, stopAt } from "./research-clock";
import { runResearcher } from "./researcher-agent";
import { type AgentOptions, createTelemetry } from "./types";
import { getTodayStr } from "./utils";

export async function runSupervisor(
  researchBrief: string,
  options: AgentOptions
): Promise<string[]> {
  const { clock, config, dataStream, toolCallId, abortSignal } = options;
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

  /*
    NOTES ARE COLLECTED AS EACH TOPIC FINISHES, not read back from the agent's
    steps at the end. The supervisor is stopped at `findingsDueAt` so the report
    keeps its time (research-clock.ts); a stopped `generate` returns no steps,
    and reading notes from them would throw away every topic already finished.
  */
  const notes: string[] = [];

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
        // Checked AFTER the semaphore: a topic queued behind two others may
        // reach the front with no search time left.
        if (!canStartResearchTopic(clock)) {
          // WITH THE TOPIC. Without it the report could only say that "a
          // planned research topic" was not run, and the founder could not tell
          // which part of their question had no search behind it.
          recordCut(
            clock,
            "a planned research topic was not started because the search time had run out",
            {},
            research_topic
          );
          return `NOT RESEARCHED: the search time for this run ran out before this topic could start, so nothing was searched for it. Topic: ${research_topic}`;
        }
        const note = await runResearcher(research_topic, options);
        notes.push(note);
        return note;
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
    stopWhen: [
      hasToolCall("researchComplete"),
      stepCountIs(maxSteps),
      // Evaluated only when the last step called a tool, i.e. when the
      // supervisor wanted another round. Past the search deadline it gets none.
      ({ steps }) => {
        const finished = steps
          .at(-1)
          ?.toolCalls.some((call) => call.toolName === "researchComplete");
        if (finished || clock.now() < clock.searchStopAt) {
          return false;
        }
        recordCut(
          clock,
          "the lead researcher wanted another round of research and the search time had run out"
        );
        return true;
      },
    ],
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

  const stop = stopAt(clock, clock.findingsDueAt, abortSignal);
  try {
    await supervisorAgent.generate({
      prompt: researchBrief,
      abortSignal: stop.signal,
    });
  } catch (error) {
    // The route's abort ends the request, and any other error is a real
    // failure: both rethrow. Only the planned `findingsDueAt` stop is
    // absorbed, and the report is written from the topics that finished.
    if (!stop.stoppedByDeadline()) {
      throw error;
    }
    recordCut(
      clock,
      "the lead researcher was stopped so the report could start on time"
    );
  }

  return [...notes];
}
