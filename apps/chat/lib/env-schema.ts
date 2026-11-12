import { z } from "zod";
import { isPlaywrightTestEnvironment } from "@/lib/playwright-test-environment";

const isPlaywrightTestEnvironmentEnabled = isPlaywrightTestEnvironment(
  process.env
);

/**
 * Server environment variable schemas with descriptions.
 *
 * Descriptions are the single source of truth used by:
 * - The CLI env checklist (derived at build time)
 * - The .env.example comments
 *
 * Exported separately from `env.ts` so the CLI can import
 * without triggering `createEnv` runtime validation.
 */
export const serverEnvSchema = {
  // Required core
  DATABASE_URL: z
    .preprocess(
      (value) =>
        isPlaywrightTestEnvironmentEnabled && (value == null || value === "")
          ? "postgres://postgres:postgres@127.0.0.1:5432/playwright"
          : value,
      z.string().min(1)
    )
    .describe("Postgres connection string"),
  AUTH_SECRET: z
    .preprocess(
      (value) =>
        isPlaywrightTestEnvironmentEnabled && (value == null || value === "")
          ? "playwright-test-auth-secret"
          : value,
      z.string().min(1)
    )
    .describe("NextAuth.js secret for signing session tokens"),

  // Authentication providers (enable in chat.config.ts)
  AUTH_GOOGLE_ID: z.string().optional().describe("Google OAuth client ID"),
  AUTH_GOOGLE_SECRET: z
    .string()
    .optional()
    .describe("Google OAuth client secret"),
  AUTH_GITHUB_ID: z.string().optional().describe("GitHub OAuth app client ID"),
  AUTH_GITHUB_SECRET: z
    .string()
    .optional()
    .describe("GitHub OAuth app client secret"),
  VERCEL_APP_CLIENT_ID: z
    .string()
    .optional()
    .describe("Vercel OAuth integration client ID"),
  VERCEL_APP_CLIENT_SECRET: z
    .string()
    .optional()
    .describe("Vercel OAuth integration client secret"),

  // AI Gateway keys (one required depending on config.ai.gateway)
  AI_GATEWAY_API_KEY: z
    .string()
    .optional()
    .describe("Vercel AI Gateway API key"),
  VERCEL_OIDC_TOKEN: z
    .string()
    .optional()
    .describe("Vercel OIDC token (auto-set on Vercel deployments)"),
  OPENROUTER_API_KEY: z.string().optional().describe("OpenRouter API key"),
  OPENAI_COMPATIBLE_BASE_URL: z
    .string()
    .url()
    .optional()
    .describe("Base URL for OpenAI-compatible provider"),
  OPENAI_COMPATIBLE_API_KEY: z
    .string()
    .optional()
    .describe("API key for OpenAI-compatible provider"),
  OPENAI_API_KEY: z.string().optional().describe("OpenAI API key"),
  ANTHROPIC_API_KEY: z
    .string()
    .optional()
    .describe('Anthropic API key (gateway: "anthropic")'),
  ANTHROPIC_BASE_URL: z
    .string()
    .url()
    .optional()
    .describe("Override the Anthropic API base URL (proxies, gateways)"),
  LITELLM_BASE_URL: z
    .string()
    .url()
    .optional()
    .describe("LiteLLM proxy base URL"),
  LITELLM_API_KEY: z
    .string()
    .optional()
    .describe("LiteLLM proxy API key (master or virtual key)"),

  // Optional cleanup cron job secret
  CRON_SECRET: z
    .string()
    .optional()
    .describe("Secret for cleanup cron job endpoint"),

  // Optional features (enable in chat.config.ts)
  REDIS_URL: z.string().optional().describe("Redis URL for resumable streams"),
  TAVILY_API_KEY: z
    .string()
    .optional()
    .describe("Tavily API key for web search"),
  EXA_API_KEY: z.string().optional().describe("Exa API key for web search"),
  FIRECRAWL_API_KEY: z
    .string()
    .optional()
    .describe("Firecrawl API key for web search and URL retrieval"),
  GITHUB_TOKEN: z
    .string()
    .optional()
    .describe("GitHub token for demand-signal search (raises rate limits)"),
  /**
   * The SECOND of two locks on the Reddit lanes: the operator must both list
   * the source id in `operatorEnabled` AND set this. Deliberately not a boolean
   * and deliberately not defaulted — one switch gets flipped by somebody who
   * did not read why it was off.
   */
  REDDIT_ENABLED_ACK: z
    .string()
    .optional()
    .describe("Operator acknowledgement required to enable Reddit signals"),
  RESEARCH_SIDECAR_URL: z
    .string()
    .optional()
    .describe("Base URL of the apps/research sidecar; empty disables it"),
  RESEARCH_MAX_INPUT_TOKENS: z
    .string()
    .optional()
    .describe("Hard ceiling on projected input tokens for one research run"),
  RESEARCH_HOSTED: z
    .string()
    .optional()
    .describe('Set to "false" only for BYOK self-host; defaults to hosted'),
  /**
   * The SAME variable apps/research reads. Both sides parse it, because both
   * sides decide with it: the sidecar refuses a source it was not told to run,
   * and the app declines to ask for one. Unset means the two keyless defaults,
   * never "everything" — see `parseOperatorEnabledSources`.
   */
  RESEARCH_ENABLED_SOURCES: z
    .string()
    .optional()
    .describe(
      "Comma-separated demand-signal source ids; unset means hackernews,web-keyless"
    ),
  MCP_ENCRYPTION_KEY: z
    .union([z.string().length(44), z.literal("")])
    .optional()
    .describe("Encryption key for MCP server credentials (base64, 44 chars)"),

  // Sandbox (for non-Vercel deployments)
  VERCEL_TEAM_ID: z
    .string()
    .optional()
    .describe("Vercel team ID for sandbox (non-Vercel deployments)"),
  VERCEL_PROJECT_ID: z
    .string()
    .optional()
    .describe("Vercel project ID for sandbox (non-Vercel deployments)"),
  VERCEL_TOKEN: z
    .string()
    .optional()
    .describe("Vercel API token for sandbox (non-Vercel deployments)"),
  VERCEL_SANDBOX_RUNTIME: z
    .string()
    .min(1)
    .optional()
    .describe("Legacy default Vercel sandbox runtime identifier for Python"),
  VERCEL_SANDBOX_RUNTIME_PYTHON: z
    .string()
    .min(1)
    .optional()
    .describe("Vercel sandbox runtime identifier for Python execution"),
  VERCEL_SANDBOX_RUNTIME_JAVASCRIPT: z
    .string()
    .min(1)
    .optional()
    .describe("Vercel sandbox runtime identifier for JavaScript execution"),

  // This deployment's public URL - full URL including https://. Auth trusts
  // only this origin (plus the Vercel ones below); required in production
  // outside Vercel.
  APP_URL: z
    .url()
    .optional()
    .describe(
      "This deployment's public URL (full URL including https://); required in production outside Vercel"
    ),

  // Vercel platform (auto-set by Vercel)
  VERCEL_URL: z.string().optional().describe("Auto-set by Vercel platform"),
  VERCEL_ENV: z
    .string()
    .optional()
    .describe(
      "Auto-set by Vercel platform: production, preview or development"
    ),
  VERCEL_PROJECT_PRODUCTION_URL: z
    .string()
    .optional()
    .describe("Auto-set by Vercel platform: the project's production domain"),
};
