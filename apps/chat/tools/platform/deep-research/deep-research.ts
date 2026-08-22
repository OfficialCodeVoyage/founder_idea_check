import { type ModelMessage, tool } from "ai";
import { z } from "zod";
import type { StreamWriter } from "@/lib/ai/types";
import type { CostAccumulator } from "@/lib/credits/cost-accumulator";
import { createModuleLogger } from "@/lib/logger";
import { ALL_PROVIDERS } from "@/lib/signals/providers";
import { generateUUID } from "@/lib/utils";
import type { ToolSession } from "../types";
import { getDeepResearchConfig } from "./configuration";
import { currentDeployment } from "./deployment-mode";
import { runDeepResearchPipeline } from "./pipeline";
import {
  decideResearchAvailability,
  researchToolDescriptionFor,
  researchUnavailableMessage,
} from "./research-availability";
import { checkResearchRequest } from "./research-request";

const log = createModuleLogger("tools/deep-research");

const BASE_DESCRIPTION = `Conducts deep, autonomous research based on a conversation history. It automatically clarifies the user's intent if the request is ambiguous, breaks down the query into parallel research tasks, scours multiple web sources for information, and then synthesizes the findings into a comprehensive, well-structured report with citations. This is best for complex questions that require in-depth analysis and a detailed answer, not just a simple search.


Important:
- If a message with role tool and toolname "deepResearch" is found in the conversation history, and this tool has an output with format "clarifying_questions", you must call this tool again to continue the research process.
- If research is successful, a report will be created by this tool and displayed to the user. No need to repeat it in your answer.

Use for:
- Start a research or to continue a research process
- Perform deep research (also autonomous research, deep search, or similar aliases)
- Use again if this tool was previously used, produced a clarifying question, and the user has now responded
`;

export const deepResearch = ({
  session,
  dataStream,
  messageId,
  messages,
  costAccumulator,
}: {
  session: ToolSession;
  dataStream: StreamWriter;
  messageId: string;
  messages: ModelMessage[];
  costAccumulator: CostAccumulator;
}) => {
  const researchConfig = getDeepResearchConfig();

  /*
    PREFLIGHT, AT REGISTRATION TIME — before the model is told the tool exists.

    On 2026-08-21 a founder's first message asked for a source-cited study with
    primary sources. The model read a description promising "multiple web
    sources" and "citations", offered exactly that, and delivered zero — four of
    six lanes were gate-refused and neither cloud key was set. The gate already
    knew, per source, with a written reason; it was just never consulted until
    after the promise had been made. `decideResearchAvailability` reads the same
    verdict from the same function, here, where the description is built.
  */
  const { mode, unknownSourceIds } = currentDeployment();
  const availability = decideResearchAvailability({
    searchApi: researchConfig.search_api,
    mode,
    descriptors: ALL_PROVIDERS,
    unknownSourceIds,
  });
  if (!availability.available) {
    log.warn(
      { headline: availability.headline, refusals: availability.refusals },
      "deepResearch is registered as unavailable"
    );
  }

  return tool({
    description: researchToolDescriptionFor(availability, BASE_DESCRIPTION),
    inputSchema: z.object({}),
    execute: async (_, { toolCallId, abortSignal }) => {
      // The description tells the model not to call this. Models call it anyway,
      // and an unavailable tool that then throws its way to a stack trace is
      // worse than one that refuses in words the founder can act on.
      if (!availability.available) {
        return {
          answer: researchUnavailableMessage(availability),
          format: "unavailable" as const,
        };
      }

      // NEVER RUN WITH AN EMPTY CONVERSATION. This is where `tool_input = {}`
      // became "Invalid prompt: messages must not be empty" — an AI-SDK
      // validator firing three layers down, inside `clarifyWithUser`. See
      // research-request.ts for why the replacement wording is shaped as it is.
      const request = checkResearchRequest(messages);
      if (!request.ok) {
        log.error(
          { messageId, messageCount: messages.length },
          "deepResearch was called with no conversation to research"
        );
        return { answer: request.message, format: "problem" as const };
      }

      try {
        const requestId = generateUUID();
        // Log both requestId and messageId for traceability
        console.log("DeepResearch start", { requestId, messageId });

        const researchResult = await runDeepResearchPipeline(
          {
            requestId,
            messageId,
            toolCallId,
            messages,
          },
          researchConfig,
          dataStream,
          { session, costAccumulator, abortSignal }
        );

        // biome-ignore lint/style/useDefaultSwitchClause: researchResult is of type never but this might be reached other
        switch (researchResult.type) {
          case "report":
            return {
              ...researchResult.data,
              format: "report" as const,
            };

          case "clarifying_question":
            return {
              answer: researchResult.data,
              format: "clarifying_questions" as const,
            };
        }
      } catch (error) {
        console.error("Deep research error:", error);
        dataStream.write({
          id: generateUUID(),
          type: "data-researchUpdate",
          data: {
            toolCallId,
            timestamp: Date.now(),
            title: "Deep research failed",
            type: "completed",
          },
        });
        return {
          answer: `Deep research failed with error: ${error instanceof Error ? error.message : String(error)}`,
          format: "problem" as const,
        };
      }
    },
  });
};
