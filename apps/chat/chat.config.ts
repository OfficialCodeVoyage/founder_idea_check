import { defineConfig } from "@/lib/config-schema";

const isProd = process.env.NODE_ENV === "production";

/**
 * ChatJS Configuration
 *
 * Edit this file to customize your app.
 * @see https://chatjs.dev/docs/reference/config
 */
const config = defineConfig({
  appPrefix: "ideacheck",
  appName: "idea_check",
  appTitle: "idea_check - validate your idea before you build it",
  appDescription:
    "Build and deploy AI chat applications in minutes. ChatJS provides authentication, streaming, tool calling, and all the features you need for production-ready AI conversations.",
  appUrl: "https://www.demo.chatjs.dev",
  organization: {
    name: "ChatJS",
    contact: {
      privacyEmail: "privacy@chatjs.dev",
      legalEmail: "legal@chatjs.dev",
    },
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
    anonymousModels: ["gpt-5.6-luna"],
    workflows: {
      chat: "gpt-5.6-terra",
      title: "gpt-5.6-luna",
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
        enabled: false, // re-enabled in Step 5 on top of the sidecar
        defaultModel: "gpt-5.6-luna",
        finalReportModel: "gpt-5.6-terra",
        allowClarification: true,
        maxResearcherIterations: 1,
        maxConcurrentResearchUnits: 2,
        maxSearchQueries: 2,
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
