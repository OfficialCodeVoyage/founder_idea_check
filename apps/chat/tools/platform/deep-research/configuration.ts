import { config } from "@/lib/config";
import { env } from "@/lib/env";

export type SearchAPI = "firecrawl" | "sidecar" | "tavily" | "none";

export interface DeepResearchRuntimeConfig {
  allow_clarification: boolean;
  compression_model: string;
  compression_model_max_tokens: number;
  final_report_model: string;
  final_report_model_max_tokens: number;
  max_concurrent_research_units: number;
  max_researcher_iterations: number;
  /** Step ceiling for one researcher's tool loop. See chat.config.ts. */
  max_researcher_steps: number;
  // General Configuration
  max_structured_output_retries: number;

  // MCP server configuration (not yet implemented)
  mcp_config?: {
    url?: string;
    tools?: string[];
    headers?: Record<string, string>;
  };
  mcp_prompt?: string;
  research_model: string;
  research_model_max_tokens: number;
  /**
   * Output ceiling for ONE step of a researcher's tool loop, reasoning included.
   * Far below `research_model_max_tokens` on purpose: a researcher's steps are
   * tool calls (about 200 tokens) and, at the end, brief notes; its findings are
   * condensed from the search results by the compression step. See the value in
   * `getDeepResearchConfig`.
   */
  researcher_step_max_tokens: number;

  // Research Configuration
  search_api: SearchAPI;
  search_api_max_queries: number;
  status_update_model: string;
  status_update_model_max_tokens: number;

  // Model Configuration
  summarization_model: string;
  summarization_model_max_tokens: number;
}

/**
 * Picks the search arm, most-preferred first.
 *
 * The sidecar is checked BEFORE the cloud providers deliberately. Its config
 * key is documented as "empty disables it", so a non-empty `researchSidecarUrl`
 * is an explicit operator choice, not a default that happens to be populated —
 * an operator who wants Tavily clears it. Ordering it last would instead mean a
 * stray key in the environment silently overrode the local, keyless, no-egress
 * path, which is the opposite of what this deployment wants.
 *
 * `"none"` remains the floor: no sidecar and no key still yields no tools, and
 * `runResearcher` still refuses rather than pretending to research.
 */
function getSearchApi(): SearchAPI {
  if (config.ai.tools.deepResearch.researchSidecarUrl) {
    return "sidecar";
  }
  if (env.TAVILY_API_KEY) {
    return "tavily";
  }
  if (env.FIRECRAWL_API_KEY) {
    return "firecrawl";
  }
  return "none";
}

/** The `gpt-5.6-*` family, with or without a gateway's provider prefix. */
const GPT_5_6_MODEL = /^(?:openai\/)?gpt-5\.6-/;

/**
 * Provider options for the COMPRESSION call, and for no other: the lowest
 * reasoning effort the model takes, so its reasoning does not eat the output
 * cap. Compression condenses text it is handed, and a model left at its default
 * effort spent part of the 4,000-token cap on reasoning that nothing reads: live
 * QA (re-check 5) saw calls of 3,730, 3,300 and 1,931 output tokens of which
 * 1,459, 516 and 375 were reasoning, one ending 270 short of the cap, and an
 * earlier run ended at exactly the cap with a note cut off. The cap is the time
 * budget (`compression_model_max_tokens`) and is not raised.
 *
 * The `gpt-5.6-*` family is the one this repo has established takes `none` (the
 * sidecar's `RESEARCH_SIM_REASONING_EFFORT` is derived as `none` for it, and
 * `lib/ai/model-capabilities.ts` records the 400 that names it). Any other model
 * gets no option: whether it takes the key at all is unknown, and a rejected
 * option would fail the whole topic's compression, which is worse than reasoning
 * tokens.
 */
export function getCompressionProviderOptions(
  modelId: string
): { openai: { reasoningEffort: "none" } } | undefined {
  return GPT_5_6_MODEL.test(modelId)
    ? { openai: { reasoningEffort: "none" } }
    : undefined;
}

export function getDeepResearchConfig(): DeepResearchRuntimeConfig {
  const {
    researchModel,
    summarizationModel,
    compressionModel,
    statusUpdateModel,
    finalReportModel,
    allowClarification,
    maxConcurrentResearchUnits,
    maxSearchQueries,
    maxResearcherIterations,
    maxResearcherSteps,
  } = config.ai.tools.deepResearch;

  return {
    // General Configuration
    max_structured_output_retries: 3,
    allow_clarification: allowClarification,
    max_concurrent_research_units: maxConcurrentResearchUnits,

    // Research Configuration
    search_api: getSearchApi(),
    search_api_max_queries: maxSearchQueries,
    max_researcher_iterations: maxResearcherIterations,
    max_researcher_steps: maxResearcherSteps,

    // Model Configuration — FIVE DISTINCT ROLES, five config keys. These used
    // to be two: `defaultModel` drove summarization, research, compression and
    // status updates alike, which meant the two LOSSY stages were priced by the
    // same knob as a progress line. What summarization and compression discard,
    // the final report model cannot recover.
    summarization_model: summarizationModel,
    summarization_model_max_tokens: 4000,
    research_model: researchModel,
    research_model_max_tokens: 4000,
    /*
      WHY 1,500 AND NOT 4,000 FOR A RESEARCHER STEP. Live QA (2026-11-12): two
      of a run's five researcher steps ended with finishReason "length" at 4,000
      output tokens, no tool call, 50 to 60 s each. They were the researcher
      writing its findings out as free text after its searches, which compression
      (`compressResearch`) rebuilds from the raw search results anyway, so the
      time bought nothing and the text was cut off mid-sentence. Those two steps
      pushed the run past the search stop (cut at 140 s against 120 s).

      The researcher's steps that DO matter are tool calls: the same run's were
      145 to 201 output tokens, 37 to 53 of them reasoning. 1,500 leaves a tool
      call about seven times its measured size, and a closing "brief notes" reply
      (see researchSystemPrompt) room for its reasoning and about 100 words; at
      the throughput measured in that run (about 70 tokens/s) the worst case for
      one step is about 21 s, against the 57 s that 4,000 tokens took. A step
      that still hits the cap is handled in researcher-agent.ts, not retried.
    */
    researcher_step_max_tokens: 1500,
    compression_model: compressionModel,
    // The cap is the time budget, not a length target: `compressResearchSystemPrompt`
    // asks for a note of at most about 2,000 words (about 2,800 tokens) so that it
    // ends well before this. Lower or raise one with the other in mind.
    compression_model_max_tokens: 4000,
    final_report_model: finalReportModel,
    final_report_model_max_tokens: 6000,
    status_update_model: statusUpdateModel,
    status_update_model_max_tokens: 4000,
  };
}
