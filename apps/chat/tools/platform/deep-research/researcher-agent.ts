import {
  generateText,
  type ModelMessage,
  stepCountIs,
  ToolLoopAgent,
} from "ai";
import type { AppModelId, ModelId } from "@/lib/ai/app-models";
import { getLanguageModel } from "@/lib/ai/providers";
import { truncateMessages } from "@/lib/ai/token-utils";
import {
  compressResearchSimpleHumanMessage,
  compressResearchSystemPrompt,
  researchSystemPrompt,
} from "./prompts";
import { recordCut, stopAt } from "./research-clock";
import { type AgentOptions, createTelemetry } from "./types";
import { getAllTools, getModelContextWindow, getTodayStr } from "./utils";

export async function runResearcher(
  topic: string,
  options: AgentOptions
): Promise<string> {
  const { audience, clock, config, dataStream, toolCallId, abortSignal } =
    options;

  const model = await getLanguageModel(config.research_model as ModelId);
  // `audience` rides along so the sidecar arm can rank its lanes against the
  // founder's buyer. The cloud arms ignore it: Tavily and Firecrawl are single
  // opaque lanes, so there is nothing to rank. `clock` lets the sidecar arm
  // cap each search step and refuse one that cannot finish in time.
  const tools = await getAllTools(
    config,
    dataStream,
    toolCallId,
    audience,
    clock
  );

  if (Object.keys(tools).length === 0) {
    throw new Error(
      "No tools found to conduct research: Please configure either your search API or add MCP tools to your configuration."
    );
  }

  dataStream.write({
    type: "data-researchUpdate",
    data: {
      toolCallId,
      title: "Starting research on topic",
      message: topic,
      type: "thoughts",
      status: "running",
    },
  });

  let finishedMessages: ModelMessage[] = [];

  const researcherAgent = new ToolLoopAgent({
    model,
    instructions: researchSystemPrompt({
      mcp_prompt: config.mcp_prompt || "",
      date: getTodayStr(),
      max_search_queries: config.search_api_max_queries,
    }),
    tools,
    // EXPLICIT, and it must stay explicit. ToolLoopAgent defaults stopWhen to
    // stepCountIs(20) (ai@6.0.219, dist/index.js:8641), so omitting this does
    // not mean one pass — it means up to twenty model round trips per topic,
    // times max_concurrent_research_units, times the supervisor's iterations.
    // The supervisor next door has always bounded itself; this agent was
    // silently inheriting that 20.
    stopWhen: [
      stepCountIs(config.max_researcher_steps),
      // Evaluated only when the last step called a tool, i.e. when the
      // researcher wanted to search again. Past the search deadline it stops.
      () => {
        if (clock.now() < clock.searchStopAt) {
          return false;
        }
        recordCut(
          clock,
          "a researcher stopped searching at the search deadline"
        );
        return true;
      },
    ],
    maxOutputTokens: config.research_model_max_tokens,
    experimental_telemetry: createTelemetry("researcher", options),
    onStepFinish: ({ usage, response }) => {
      // Cumulative: each step's response carries every message so far, with
      // each tool call next to its result. Kept so a researcher stopped at
      // the deadline still hands its finished steps to compression.
      finishedMessages = response.messages;
      if (usage) {
        options.costAccumulator?.addLLMCost(
          config.research_model as AppModelId,
          usage,
          "deep-research-researcher"
        );
      }
    },
  });

  const stop = stopAt(clock, clock.searchStopAt, abortSignal);
  let researchMessages: ModelMessage[];
  try {
    const { response } = await researcherAgent.generate({
      prompt: topic,
      abortSignal: stop.signal,
    });
    researchMessages = response.messages;
  } catch (error) {
    // Only the planned search deadline is absorbed; the route's abort and
    // every real failure still propagate. The step in flight is lost, the
    // steps before it are kept.
    if (!stop.stoppedByDeadline()) {
      throw error;
    }
    recordCut(
      clock,
      "a researcher was stopped mid-step at the search deadline"
    );
    researchMessages = finishedMessages;
  }

  // Stopped before any step finished: there is nothing to condense, and a
  // compression call over an empty transcript would be paid for nothing.
  const compressed =
    researchMessages.length === 0
      ? `NOT RESEARCHED: the search time ran out before any search for this topic finished. Topic: ${topic}`
      : await compressResearch(researchMessages, options);

  dataStream.write({
    type: "data-researchUpdate",
    data: {
      toolCallId,
      title: "Research topic completed",
      message: topic,
      type: "thoughts",
      status: "completed",
    },
  });

  return compressed;
}

async function compressResearch(
  researchMessages: ModelMessage[],
  options: AgentOptions
): Promise<string> {
  const { config, abortSignal } = options;
  const model = await getLanguageModel(config.compression_model as ModelId);

  const messages: ModelMessage[] = [
    {
      role: "system" as const,
      content: compressResearchSystemPrompt({ date: getTodayStr() }),
    },
    ...researchMessages,
    {
      role: "user" as const,
      content: compressResearchSimpleHumanMessage,
    },
  ];

  const contextWindow = await getModelContextWindow(
    config.compression_model as ModelId
  );
  // ISSUE #189: this is the only truncateMessages call site with real history,
  // and it drops the oldest turns silently. Left as-is deliberately — a research
  // loop is stateless between runs, so nothing durable is lost here. The phase
  // workflow solves the same problem the other way: lib/phases/extract.ts
  // distils turns into project facts and lib/phases/context.ts re-injects them,
  // ranked and budgeted, into every system prompt, so state survives truncation
  // instead of being raced by it. Use that pattern if this loop ever needs to
  // remember something across calls.
  const truncatedMessages = truncateMessages(messages, contextWindow);

  // Compression must finish by `compressionDueAt` so the report keeps its
  // time (research-clock.ts). Stopped there, the researcher's own words and
  // search results go forward uncondensed rather than being lost.
  const stop = stopAt(
    options.clock,
    options.clock.compressionDueAt,
    abortSignal
  );
  let response: Awaited<ReturnType<typeof generateText>>;
  try {
    response = await generateText({
      model,
      messages: truncatedMessages,
      maxOutputTokens: config.compression_model_max_tokens,
      experimental_telemetry: createTelemetry("compressResearch", options),
      maxRetries: 3,
      abortSignal: stop.signal,
    });
  } catch (error) {
    if (!stop.stoppedByDeadline()) {
      throw error;
    }
    recordCut(
      options.clock,
      "condensing a researcher's findings was stopped, so they were passed on uncondensed"
    );
    return uncondensedFindings(researchMessages);
  }

  if (response.usage) {
    options.costAccumulator?.addLLMCost(
      config.compression_model as AppModelId,
      response.usage,
      "deep-research-compress"
    );
  }

  return response.text;
}

/**
 * Enough of the raw transcript to cite from, bounded so that several of these
 * cannot crowd the report prompt. 12,000 characters is roughly 3,000 tokens,
 * about what a compression call would have written.
 */
const UNCONDENSED_FINDINGS_MAX_CHARS = 12_000;

/** PURE. The researcher's text and tool results, as plain text. */
function uncondensedFindings(messages: readonly ModelMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      parts.push(message.content);
      continue;
    }
    for (const part of message.content) {
      if (part.type === "text") {
        parts.push(part.text);
      } else if (part.type === "tool-result") {
        parts.push(JSON.stringify(part.output));
      }
    }
  }
  const body = parts.join("\n\n").slice(0, UNCONDENSED_FINDINGS_MAX_CHARS);
  return `UNCONDENSED FINDINGS (condensing was stopped for time; these are the researcher's own notes and raw search results):\n\n${body}`;
}
