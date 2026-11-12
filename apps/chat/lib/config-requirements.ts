import type { GatewayType } from "./ai/gateways/registry";
import type { AiConfig, AuthenticationConfig } from "./config-schema";

type EnvVarName = keyof NodeJS.ProcessEnv;

export interface EnvRequirement {
  description?: string;
  options: EnvVarName[][];
}

export function formatRequirementDescription(
  requirement: EnvRequirement
): string {
  return (
    requirement.description ??
    requirement.options.map((option) => option.join(" + ")).join(" or ")
  );
}

export const gatewayEnvRequirements: Record<GatewayType, EnvRequirement> = {
  openrouter: {
    options: [["OPENROUTER_API_KEY"]],
    description: "OPENROUTER_API_KEY",
  },
  openai: {
    options: [["OPENAI_API_KEY"]],
    description: "OPENAI_API_KEY",
  },
  vercel: {
    options: [["AI_GATEWAY_API_KEY"], ["VERCEL_OIDC_TOKEN"]],
    description: "AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN",
  },
  "openai-compatible": {
    options: [["OPENAI_COMPATIBLE_BASE_URL", "OPENAI_COMPATIBLE_API_KEY"]],
    description: "OPENAI_COMPATIBLE_BASE_URL, OPENAI_COMPATIBLE_API_KEY",
  },
  litellm: {
    options: [["LITELLM_BASE_URL"]],
    description: "LITELLM_BASE_URL",
  },
  anthropic: {
    options: [["ANTHROPIC_API_KEY"]],
    description: "ANTHROPIC_API_KEY",
  },
};

export const aiToolEnvRequirements: Partial<
  Record<keyof AiConfig["tools"], EnvRequirement>
> = {
  webSearch: {
    options: [["TAVILY_API_KEY"], ["FIRECRAWL_API_KEY"]],
    description: "TAVILY_API_KEY or FIRECRAWL_API_KEY",
  },
  mcp: {
    options: [["MCP_ENCRYPTION_KEY"]],
    description: "MCP_ENCRYPTION_KEY",
  },
  codeExecution: {
    options: [
      ["VERCEL_OIDC_TOKEN"],
      ["VERCEL_TEAM_ID", "VERCEL_PROJECT_ID", "VERCEL_TOKEN"],
    ],
    description:
      "VERCEL_OIDC_TOKEN (auto on Vercel) or VERCEL_TEAM_ID + VERCEL_PROJECT_ID + VERCEL_TOKEN",
  },
};

/**
 * Deep research's one real requirement: A SEARCH BACKEND, which is any of the
 * apps/research sidecar, Tavily or Firecrawl.
 *
 * It is not an entry in `aiToolEnvRequirements` because the sidecar's address
 * is the config key `researchSidecarUrl`, not an environment variable. The
 * entry that stood there said "TAVILY_API_KEY or FIRECRAWL_API_KEY" and was
 * written before the sidecar existed, so a clean checkout with the shipped
 * `chat.config.ts` (sidecar URL set, no cloud key) failed `prebuild` on a
 * requirement the research tool does not have.
 *
 * Mirrors `getSearchApi` in tools/platform/deep-research/configuration.ts:
 * a non-empty `researchSidecarUrl` is a backend by itself, otherwise a Tavily
 * or Firecrawl key is. With none of them the tool registers as unavailable and
 * says so (research-availability.ts), so naming it here is a build-time
 * courtesy, not the only thing standing between the founder and a silent
 * failure.
 */
const deepResearchCloudKeyRequirement: EnvRequirement = {
  options: [["TAVILY_API_KEY"], ["FIRECRAWL_API_KEY"]],
};

export function getMissingDeepResearchBackend(
  deepResearch: { researchSidecarUrl: string },
  env: NodeJS.ProcessEnv
): string | null {
  if (deepResearch.researchSidecarUrl) {
    return null;
  }
  return isRequirementSatisfied(deepResearchCloudKeyRequirement, env)
    ? null
    : "researchSidecarUrl in chat.config.ts (the apps/research sidecar), TAVILY_API_KEY or FIRECRAWL_API_KEY";
}

export const authEnvRequirements: Record<
  keyof AuthenticationConfig,
  EnvRequirement
> = {
  google: {
    options: [["AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET"]],
    description: "AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET",
  },
  github: {
    options: [["AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET"]],
    description: "AUTH_GITHUB_ID, AUTH_GITHUB_SECRET",
  },
  vercel: {
    options: [["VERCEL_APP_CLIENT_ID", "VERCEL_APP_CLIENT_SECRET"]],
    description: "VERCEL_APP_CLIENT_ID, VERCEL_APP_CLIENT_SECRET",
  },
};

export function isRequirementSatisfied(
  requirement: EnvRequirement,
  env: NodeJS.ProcessEnv
): boolean {
  return requirement.options.some((option) =>
    option.every((name) => !!env[name])
  );
}

export function getMissingRequirement(
  requirement: EnvRequirement,
  env: NodeJS.ProcessEnv
): string | null {
  return isRequirementSatisfied(requirement, env)
    ? null
    : formatRequirementDescription(requirement);
}
