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
import { type AgentOptions, createTelemetry } from "./types";
import { getAllTools, getModelContextWindow, getTodayStr } from "./utils";

export async function runResearcher(
  topic: string,
  options: AgentOptions
): Promise<string> {
  const { config, dataStream, toolCallId, abortSignal } = options;

  const model = await getLanguageModel(config.research_model as ModelId);
  const tools = await getAllTools(config, dataStream, toolCallId);

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
    stopWhen: [stepCountIs(config.max_researcher_steps)],
    maxOutputTokens: config.research_model_max_tokens,
    experimental_telemetry: createTelemetry("researcher", options),
    onStepFinish: ({ usage }) => {
      if (usage) {
        options.costAccumulator?.addLLMCost(
          config.research_model as AppModelId,
          usage,
          "deep-research-researcher"
        );
      }
    },
  });

  const { response } = await researcherAgent.generate({
    prompt: topic,
    abortSignal,
  });

  const compressed = await compressResearch(response.messages, options);

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

  const response = await generateText({
    model,
    messages: truncatedMessages,
    maxOutputTokens: config.compression_model_max_tokens,
    experimental_telemetry: createTelemetry("compressResearch", options),
    maxRetries: 3,
    abortSignal,
  });

  if (response.usage) {
    options.costAccumulator?.addLLMCost(
      config.compression_model as AppModelId,
      response.usage,
      "deep-research-compress"
    );
  }

  return response.text;
}
