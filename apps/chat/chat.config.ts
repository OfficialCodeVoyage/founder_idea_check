import { defineConfig } from "@/lib/config-schema";

const isProd = process.env.NODE_ENV === "production";

/**
 * Founder Idea Check configuration
 *
 * Edit this file to customize your app. The schema and every default live in
 * `lib/config-schema.ts`.
 *
 * There is no `appUrl` here on purpose: the public URL is read at runtime from
 * `lib/url.ts::getBaseUrl` (APP_URL, then the Vercel URLs, then localhost).
 */
const config = defineConfig({
  appPrefix: "ideacheck",
  appName: "Founder Idea Check",
  appTitle: "Founder Idea Check - validate your idea before you build it",
  appDescription:
    "Test a startup idea before you build it: an eight-phase conversation whose gates refuse to advance without evidence, backed by public demand research.",
  organization: {
    name: "Founder Idea Check",
    // No mailbox is published for this project: the privacy and terms pages
    // point to the issue tracker (`lib/project-links.ts`) until one is set.
    contact: {},
  },
  services: {
    hosting: "Vercel",
    aiProviders: ["OpenAI"],
    paymentProcessors: [],
  },
  features: {
    attachments: false, // needs Vercel Blob; re-enable when storage is wired
    parallelResponses: true,
  },
  legal: {
    minimumAge: 13,
    governingLaw: "United States",
    refundPolicy: "no-refunds",
  },
  policies: {
    privacy: {
      title: "Privacy Policy",
      lastUpdated: "July 24, 2025",
    },
    terms: {
      title: "Terms of Service",
      lastUpdated: "July 24, 2025",
    },
  },
  // AUTHENTICATION BLOCK ONLY — changed by the key-ready-devx pass.
  // github was `true` while .env.local held placeholder credentials, so the
  // login page advertised a "Continue with GitHub" button that redirected to
  // github.com with a bogus client_id and could never succeed. Local sign-in is
  // GET /api/dev-login (development only); see GETTING-STARTED.md.
  // Flip github back to true once you have a real OAuth app + AUTH_GITHUB_ID /
  // AUTH_GITHUB_SECRET.
  authentication: {
    google: false,
    github: false, // Requires a real OAuth app: AUTH_GITHUB_ID + AUTH_GITHUB_SECRET
    vercel: false,
  },
  desktopApp: {
    enabled: false, // Electron app removed from this fork
  },
  ai: {
    // Native Anthropic BYOK: paste ANTHROPIC_API_KEY into .env.local and the
    // whole app works. Model IDs below are bare Anthropic API IDs.
    gateway: "openai",
    providerOrder: ["anthropic"],
    disabledModels: [],

    /**
     * THE CEILING ON ONE TURN'S OUTPUT, SET DELIBERATELY.
     *
     * There was none before 2026-08-22 — output length was whatever the
     * provider happened to default to, and nothing checked whether a cap had
     * been hit. That is the config gap behind QA-BACKLOG #5: a
     * `createTextDocument` whose input stopped mid-table-row at 26,731
     * characters, with no output, no error, and no `Document` row.
     *
     * READ AT lib/ai/core-chat-agent.ts, in the `streamText` call — this is
     * NOT another `maxInputTokensPerRun`. That knob has no reader at all, and
     * a second dead one would be worse than none; if you change this number,
     * that call site is where it lands.
     *
     * 32,000 is chosen against the incident, not plucked: the protocol that
     * was lost had ~26,300 characters of content, roughly 7,000 tokens, so
     * this leaves better than 4x headroom for the longest document this
     * product actually asks for. It is clamped at the call site to the
     * selected model's own `max_tokens` (terra allows 128,000), so it can only
     * ever lower a limit, never claim one the model will not honour.
     */
    maxOutputTokens: 32_000,
    anonymousModels: ["gpt-5.6-luna"],
    workflows: {
      // THE GATE JUDGE, and it stays on terra by decision. +4.6pp TAU-Bench and
      // +2pp GPQA over luna for roughly $0.80 across an 8-phase project. The
      // gate IS the product and a wrong verdict is user-visible and
      // irreversible, so the quality is bought deliberately.
      chat: "gpt-5.6-terra",
      title: "gpt-5.6-luna",
      // Same model as `title` today, different knob on purpose — see the note
      // on `extract` in lib/config-schema.ts. Moving the fact extractor must
      // never be a side effect of changing how chats are named.
      extract: "gpt-5.6-luna",
      pdf: "gpt-5.6-terra",
      chatImageCompatible: "gpt-5.6-luna",
    },
    tools: {
      webSearch: {
        enabled: false, // replaced by the Python research sidecar (Step 5)
      },
      urlRetrieval: {
        enabled: false, // replaced by the Python research sidecar (Step 5)
      },
      codeExecution: {
        enabled: false, // code sandbox removed from this fork
      },
      mcp: {
        enabled: false, // MCP connectors removed from this fork
      },
      followupSuggestions: {
        enabled: true,
      },
      text: {
        polish: "gpt-5.6-luna",
      },
      sheet: {
        format: "gpt-5.6-luna",
        analyze: "gpt-5.6-luna",
      },
      code: {
        edits: "gpt-5.6-luna",
      },
      image: {
        // Anthropic ships no image models, so `default` is not a valid key here.
        enabled: false, // image generation removed from this fork
      },
      deepResearch: {
        /**
         * Live on the sidecar arm. `getSearchApi` returns "sidecar" whenever
         * `researchSidecarUrl` is non-empty, so this no longer depends on a
         * Tavily or Firecrawl key. Turning it on without a reachable sidecar
         * yields named `unavailable` failures, not silent empty research.
         */
        enabled: true,
        /**
         * Five roles, assigned rather than defaulted.
         *
         * luna runs the tool loop: 70.7% TAU-Bench and a 1.05M context is
         * exactly the shape of a research loop, at $0.20/$1.20.
         *
         * terra runs summarization and compression because BOTH ARE LOSSY.
         * They decide what survives into the final report, and nothing
         * downstream can recover what they discard — the report model would
         * simply write confidently over a thinner evidence base. Paying
         * frontier prices at the two stages that throw information away is the
         * whole point; paying it at the stage that only rephrases what
         * survived would be the wrong place.
         *
         * Status updates are cosmetic progress lines, so luna is plenty.
         */
        researchModel: "gpt-5.6-luna",
        summarizationModel: "gpt-5.6-terra",
        compressionModel: "gpt-5.6-terra",
        finalReportModel: "gpt-5.6-terra",
        statusUpdateModel: "gpt-5.6-luna",
        allowClarification: true,
        maxResearcherIterations: 1,
        maxConcurrentResearchUnits: 2,
        maxSearchQueries: 2,

        /**
         * Hard step ceiling for ONE researcher agent's tool loop, per topic.
         *
         * This must be set explicitly. `ToolLoopAgent` in ai@6.0.219 defaults
         * `stopWhen` to `stepCountIs(20)` (`ai/dist/index.js:8641`), so omitting
         * it does not mean "one pass" — it means up to twenty model round trips
         * per topic, multiplied by `maxConcurrentResearchUnits` and again by the
         * supervisor's iterations. The supervisor has always been bounded
         * explicitly; the researcher inherited that 20 silently.
         *
         * 6 is deliberate: enough to search, read results, refine once and
         * answer, which is the loop the research prompt actually asks for, and
         * comfortably above `maxSearchQueries: 2`. Raise it only with a cost
         * projection in hand — this number multiplies.
         */
        maxResearcherSteps: 6,

        /**
         * Hard ceiling on PROJECTED input tokens for one research run, across
         * the whole fan-out. `null` disables the cap and is only legal when
         * `hosted: false` — decideResearchBudget() REFUSES an uncapped hosted
         * run, because a missing cap is a misconfiguration and the safe reading
         * of a misconfiguration is not "unlimited".
         *
         * One full 4-researcher pass at breadth 4 / depth 2 projects ~1.1M
         * input tokens. 1_500_000 leaves headroom; 400_000 forces breadth 2 /
         * depth 1.
         */
        maxInputTokensPerRun: 1_500_000,

        /**
         * True when one provider key serves users who are not the operator.
         * Under BYOK self-host this is false and the cap may be null.
         */
        hosted: false,

        /** Base URL of apps/research. Empty disables every sidecar source. */
        researchSidecarUrl: "http://localhost:8099",
      },
    },
  },
  paths: {
    tools: "@/tools/chatjs",
  },
  anonymous: {
    credits: isProd ? 10 : 1000,
    availableTools: [],
    rateLimit: {
      requestsPerMinute: isProd ? 5 : 60,
      requestsPerMonth: isProd ? 10 : 1000,
    },
  },
  attachments: {
    maxBytes: 1024 * 1024, // 1MB
    maxDimension: 2048,
    acceptedTypes: {
      "image/png": [".png"],
      "image/jpeg": [".jpg", ".jpeg"],
      "application/pdf": [".pdf"],
    },
  },
});

export default config;
