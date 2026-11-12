import { generateText, type ModelMessage, Output, streamText } from "ai";
import type { z } from "zod";
import type { AppModelId, ModelId } from "@/lib/ai/app-models";
import { getLanguageModel } from "@/lib/ai/providers";
import { truncateMessages } from "@/lib/ai/token-utils";
import { readAudience } from "@/lib/signals/audience";
import { generateUUID, getTextContentFromModelMessage } from "@/lib/utils";
import { createTextDocumentTool } from "../documents/create-text-document";
import type { DocumentToolResult } from "../documents/types";
import type { ToolSession } from "../types";
import type { DeepResearchRuntimeConfig } from "./configuration";
import {
  clarifyWithUserInstructions,
  finalReportGenerationPrompt,
  transformMessagesIntoResearchTopicPrompt,
} from "./prompts";
import { describeMissingReportDocument } from "./report-outcome";
import { type ResearchClock, reportWordBudget } from "./research-clock";
import { runSupervisor } from "./supervisor-agent";
import {
  type AgentOptions,
  ClarifyWithUserSchema,
  createTelemetry,
  type DeepResearchInput,
  type DeepResearchResult,
  ResearchQuestionSchema,
} from "./types";
import { getModelContextWindow, getTodayStr } from "./utils";

// Main deep research pipeline
export async function runDeepResearchPipeline(
  input: DeepResearchInput,
  config: DeepResearchRuntimeConfig,
  dataStream: AgentOptions["dataStream"],
  options: {
    session: ToolSession;
    costAccumulator: NonNullable<AgentOptions["costAccumulator"]>;
    abortSignal?: AbortSignal;
    clock: ResearchClock;
  }
): Promise<DeepResearchResult> {
  const { session, costAccumulator, abortSignal, clock } = options;
  console.log("runDeepResearchPipeline invoked", {
    requestId: input.requestId,
    messageId: input.messageId,
  });

  const ctx: AgentOptions = {
    /*
      WHO THE BUYER IS, DECIDED ONCE, HERE.

      For a product aimed at, say, parents of 3-8 year olds, a report that leads
      with Hacker News is answering in the wrong room. Nothing prioritised it —
      it just happens to be first in `ALL_PROVIDERS`, and no part of this
      pipeline had any notion that a source can be the wrong room for a buyer.
      `readAudience` is that notion, and this is the only place it is read, so
      every search step in a run ranks its sources the same way.

      THE PLUMBING GAP, STATED RATHER THAN PAPERED OVER. The authoritative
      answer is the `target_user` project fact — a phase-1 fact key, stored on
      `ProjectFact`, read by `getProjectFacts`. This tool cannot reach it:
      `route.ts` knows the projectId but `createCoreChatAgent` -> `getTools` ->
      `deepResearch` never carries it, and inventing a route through three files
      two other agents are editing would be a worse trade than saying so. So
      `targetUserFact` is null here and the segment is read from the
      conversation the tool DOES have — by turn, because `readAudience` reads
      only the founder's (`user`) turns, so an assistant turn mentioning
      developers cannot flip a parenting product onto the developer ordering.

      Closing the gap is passing one string into `targetUserFact`. Nothing else
      here changes.
    */
    audience: readAudience({
      targetUserFact: null,
      conversation: input.messages.map((message) => ({
        role: message.role,
        text: getTextContentFromModelMessage(message),
      })),
    }),
    clock,
    config,
    dataStream,
    requestId: input.requestId,
    messageId: input.messageId,
    toolCallId: input.toolCallId,
    costAccumulator,
    abortSignal,
  };

  // Step 1: Clarify with user
  const clarification = await clarifyWithUser(input.messages, ctx);

  if (clarification.needsClarification) {
    return {
      type: "clarifying_question",
      data: clarification.clarificationMessage,
    };
  }

  dataStream.write({
    type: "data-researchUpdate",
    data: {
      toolCallId: input.toolCallId,
      title: "Starting research",
      type: "started",
      timestamp: Date.now(),
    },
  });

  // Step 2: Write research brief
  const brief = await writeResearchBrief(input.messages, ctx);

  // Step 3: Supervisor research loop
  const notes = await runSupervisor(brief.research_brief, ctx);

  // Step 4: Final report generation
  const reportResult = await generateFinalReport({
    ...ctx,
    notes,
    researchBrief: brief.research_brief,
    reportTitle: brief.title,
    session,
  });

  dataStream.write({
    type: "data-researchUpdate",
    data: {
      toolCallId: input.toolCallId,
      title: "Research complete",
      type: "completed",
      timestamp: Date.now(),
    },
  });

  return {
    type: "report",
    data: reportResult,
  };
}

// Step 1: Clarification

type ClarificationResult =
  | { needsClarification: true; clarificationMessage: string }
  | { needsClarification: false; clarificationMessage?: undefined };

async function clarifyWithUser(
  messages: ModelMessage[],
  ctx: AgentOptions
): Promise<ClarificationResult> {
  const { config, costAccumulator, abortSignal } = ctx;

  if (!config.allow_clarification) {
    return { needsClarification: false };
  }

  const model = await getLanguageModel(config.research_model as ModelId);
  const contextWindow = await getModelContextWindow(
    config.research_model as ModelId
  );

  const clarifyMessages = [
    {
      role: "user" as const,
      content: clarifyWithUserInstructions({
        messages: messagesToString(messages),
        date: getTodayStr(),
      }),
    },
  ];
  const truncatedMessages = truncateMessages(clarifyMessages, contextWindow);

  const response = await generateText({
    model,
    output: Output.object({ schema: ClarifyWithUserSchema }),
    messages: truncatedMessages,
    maxOutputTokens: config.research_model_max_tokens,
    experimental_telemetry: createTelemetry("clarifyWithUser", ctx),
    abortSignal,
  });

  if (response.usage) {
    costAccumulator?.addLLMCost(
      config.research_model as AppModelId,
      response.usage,
      "deep-research-clarify"
    );
  }

  const output = response.output as z.infer<typeof ClarifyWithUserSchema>;
  if (output.need_clarification) {
    return {
      needsClarification: true,
      clarificationMessage: output.question,
    };
  }
  return { needsClarification: false };
}

// Step 2: Research Brief

interface ResearchBrief {
  research_brief: string;
  title: string;
}

async function writeResearchBrief(
  messages: ModelMessage[],
  ctx: AgentOptions
): Promise<ResearchBrief> {
  const { config, dataStream, toolCallId, costAccumulator, abortSignal } = ctx;
  const model = await getLanguageModel(config.research_model as ModelId);
  const dataPartId = generateUUID();

  dataStream.write({
    id: dataPartId,
    type: "data-researchUpdate",
    data: {
      toolCallId,
      title: "Writing research brief",
      type: "writing",
      status: "running",
    },
  });

  const contextWindow = await getModelContextWindow(
    config.research_model as ModelId
  );

  const briefMessages = [
    {
      role: "user" as const,
      content: transformMessagesIntoResearchTopicPrompt({
        messages: messagesToString(messages),
        date: getTodayStr(),
      }),
    },
  ];
  const truncatedMessages = truncateMessages(briefMessages, contextWindow);

  const result = await generateText({
    model,
    output: Output.object({ schema: ResearchQuestionSchema }),
    messages: truncatedMessages,
    maxOutputTokens: config.research_model_max_tokens,
    experimental_telemetry: createTelemetry("writeResearchBrief", ctx),
    abortSignal,
  });

  if (result.usage) {
    costAccumulator?.addLLMCost(
      config.research_model as AppModelId,
      result.usage,
      "deep-research-brief"
    );
  }

  const output = result.output as z.infer<typeof ResearchQuestionSchema>;

  dataStream.write({
    id: dataPartId,
    type: "data-researchUpdate",
    data: {
      toolCallId,
      title: "Writing research brief",
      message: output.research_brief,
      type: "writing",
      status: "completed",
    },
  });

  return {
    research_brief: output.research_brief,
    title: output.title,
  };
}

// Step 4: Final Report Generation

type FinalReportInput = AgentOptions & {
  notes: string[];
  researchBrief: string;
  reportTitle: string;
  session: ToolSession;
};

async function generateFinalReport(
  input: FinalReportInput
): Promise<DocumentToolResult> {
  const {
    notes,
    researchBrief,
    reportTitle,
    config,
    dataStream,
    session,
    messageId,
    toolCallId,
    costAccumulator,
    abortSignal,
    clock,
  } = input;

  const findings = notes.join("\n");
  const timeNote = reportTimeInstructions(
    clock,
    config.final_report_model_max_tokens
  );

  const finalReportPromptText = finalReportGenerationPrompt({
    research_brief: researchBrief,
    findings,
    date: getTodayStr(),
  });

  const finalReportUpdateId = generateUUID();
  dataStream.write({
    id: finalReportUpdateId,
    type: "data-researchUpdate",
    data: {
      toolCallId,
      title: "Writing final report",
      type: "writing",
      status: "running",
    },
  });

  const contextWindow = await getModelContextWindow(
    config.final_report_model as ModelId
  );

  const finalReportMessages = [
    { role: "user" as const, content: finalReportPromptText },
  ];
  const truncatedMessages = truncateMessages(
    finalReportMessages,
    contextWindow
  );

  const truncatedReportPrompt =
    truncatedMessages.length > 0
      ? truncatedMessages
          .map((msg) => getTextContentFromModelMessage(msg))
          .join("\n\n")
      : finalReportPromptText;

  const reportTool = createTextDocumentTool({
    session,
    messageId,
    selectedModel: config.final_report_model as ModelId,
    costAccumulator,
  });

  const systemPrompt = `You are a research report writer. Your task is to write the final research report and save it using the createTextDocument tool.

IMPORTANT: You MUST call the createTextDocument tool with the complete report content. Do not output the report as text - save it using the tool.`;

  const result = streamText({
    model: await getLanguageModel(config.final_report_model as ModelId),
    system: systemPrompt,
    prompt: `Write a comprehensive research report with the title "${reportTitle}" based on the following instructions and findings.

${truncatedReportPrompt}

${timeNote}

To write the report, call the createTextDocument tool with:
- title: "${reportTitle}"
- content: the full markdown content of your report`,
    tools: { createTextDocument: reportTool },
    maxOutputTokens: config.final_report_model_max_tokens,
    experimental_telemetry: createTelemetry("finalReportGeneration", input),
    abortSignal,
  });

  dataStream.merge(result.toUIMessageStream());

  const usage = await result.usage;
  if (usage) {
    costAccumulator?.addLLMCost(
      config.final_report_model as AppModelId,
      usage,
      "deep-research-final-report"
    );
  }

  const createdDocumentToolResult = (await result.toolResults).find(
    (tr) => tr?.toolName === "createTextDocument"
  );

  dataStream.write({
    id: finalReportUpdateId,
    type: "data-researchUpdate",
    data: {
      toolCallId,
      title: "Writing final report",
      type: "writing",
      status: "completed",
    },
  });

  if (!createdDocumentToolResult) {
    return {
      status: "error",
      error: await describeMissingReportDocument(result),
    };
  }

  const output =
    createdDocumentToolResult.output as unknown as DocumentToolResult;
  if (output.status === "error") {
    return {
      status: "error",
      error: output.error,
    };
  }

  return {
    status: "success",
    documentId: output.documentId,
    result: "A document was created and is now visible to the user.",
    date: output.date,
  };
}

// Helpers

/**
 * THE REPORT'S TIME, stated to the model that writes it.
 *
 * Kept out of `finalReportGenerationPrompt` on purpose: that prompt is derived
 * from upstream and THIRD_PARTY-research.md measures how far it differs.
 *
 * Two parts. A word limit from the time actually left before `reportDueAt`
 * (`reportWordBudget`), so a report that starts late is shorter rather than
 * cut off by the route's timer mid-sentence. And, when the run stopped
 * searching early, what was cut, so the report says that the coverage is
 * partial instead of presenting missing evidence as an absence of evidence.
 */
function reportTimeInstructions(
  clock: ResearchClock,
  maxOutputTokens: number
): string {
  const words = reportWordBudget(clock, maxOutputTokens);
  const limit = `<Length>\nKeep the whole report, sources list included, under ${words} words. It must be finished in the time left; a complete shorter report is worth more than a longer one that is cut off.\n</Length>`;
  if (clock.cuts.length === 0) {
    return limit;
  }
  return `${limit}

<Search cut short for time>
The research stopped searching early to leave time for this report: ${clock.cuts.join("; ")}.
Say so near the top of the report, in a short section titled "Research cut short", in plain words: the search was cut short for time and some planned searches did not run. Do not present a topic that was not searched as a topic with no evidence.
</Search cut short for time>`;
}

function messagesToString(messages: ModelMessage[]): string {
  return messages
    .map((m) => `${m.role}: ${JSON.stringify(m.content)}`)
    .join("\n");
}
