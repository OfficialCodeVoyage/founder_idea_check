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
    compression_model: compressionModel,
    compression_model_max_tokens: 4000,
    final_report_model: finalReportModel,
    final_report_model_max_tokens: 6000,
    status_update_model: statusUpdateModel,
    status_update_model_max_tokens: 4000,
  };
}
