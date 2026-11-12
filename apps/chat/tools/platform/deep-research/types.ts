import type { ModelMessage } from "ai";
import { z } from "zod";
import type { StreamWriter } from "@/lib/ai/types";
import type { CostAccumulator } from "@/lib/credits/cost-accumulator";
import type { AudienceView } from "@/lib/signals/audience";
import type { DocumentToolResult } from "../documents/types";
import type { DeepResearchRuntimeConfig } from "./configuration";
import type { ResearchClock } from "./research-clock";

//##################
// Shared Agent Options
//##################

export interface AgentOptions {
  abortSignal?: AbortSignal;
  /**
   * WHO THE FOUNDER'S BUYER IS, read ONCE per run in pipeline.ts and carried
   * unchanged through the supervisor to the researcher's search tool.
   *
   * Read once rather than per search step because it is a fact about the
   * project, not about a query: recomputing it per step would let two searches
   * in the same run rank their sources differently, and the founder would have
   * no way to tell which ordering produced which citation.
   *
   * Its unknown arm carries no audience and no weight — see lib/signals/
   * audience.ts. An absent segment resolves to a named neutral ordering, never
   * to the developer-audience default that put Hacker News first for everyone.
   */
  audience: AudienceView;
  /**
   * The run's deadlines, derived from the chat route's budget, and the record
   * of what was cut short for time. One object for the whole run: the search
   * tool, the researchers and the supervisor all stop against the same clock,
   * and the report reads the cuts they recorded. See research-clock.ts.
   */
  clock: ResearchClock;
  config: DeepResearchRuntimeConfig;
  costAccumulator?: CostAccumulator;
  dataStream: StreamWriter;
  messageId: string;
  requestId: string;
  toolCallId: string;
}

//##################
// Telemetry Helper
//##################

export function createTelemetry(
  functionId: string,
  _options: Pick<AgentOptions, "messageId" | "requestId">
) {
  // Telemetry disabled: this fork makes a privacy claim and ships no vendor
  // telemetry. Re-enable only behind an explicit, self-hosted OTel collector.
  return { isEnabled: false as const, functionId };
}

//##################
// Structured Outputs (Zod Schemas)
//##################

export const ClarifyWithUserSchema = z.object({
  need_clarification: z
    .boolean()
    .describe("Whether the user needs to be asked a clarifying question."),
  question: z
    .string()
    .describe("A question to ask the user to clarify the report scope"),
  verification: z
    .string()
    .describe(
      "Verify message that we will start research after the user has provided the necessary information."
    ),
});

export const ResearchQuestionSchema = z.object({
  research_brief: z
    .string()
    .describe("A research question that will be used to guide the research."),
  title: z.string().describe("The title of the research report."),
});

//##################
// Pipeline IO
//##################

export interface DeepResearchInput {
  messageId: string;
  messages: ModelMessage[];
  requestId: string;
  toolCallId: string;
}

export type DeepResearchResult =
  | {
      type: "clarifying_question";
      data: string;
    }
  | {
      type: "report";
      data: DocumentToolResult;
    };
