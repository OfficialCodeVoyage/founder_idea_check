import type {
  GatewayImageModelIdMap,
  GatewayModelIdMap,
  GatewayType,
  GatewayVideoModelIdMap,
} from "./gateways/registry";

type VideoDefault<G extends GatewayType> = [GatewayVideoModelIdMap[G]] extends [
  never,
]
  ? { enabled: false }
  :
      | { enabled: true; default: GatewayVideoModelIdMap[G] }
      | { enabled: false; default?: GatewayVideoModelIdMap[G] };

type ImageDefault<G extends GatewayType> = [GatewayImageModelIdMap[G]] extends [
  never,
]
  ? { enabled: false }
  :
      | { enabled: true; default: GatewayImageModelIdMap[G] }
      | { enabled: false; default?: GatewayImageModelIdMap[G] };

export interface ModelDefaultsFor<G extends GatewayType> {
  anonymousModels: GatewayModelIdMap[G][];
  curatedDefaults: GatewayModelIdMap[G][];
  disabledModels: GatewayModelIdMap[G][];
  providerOrder: string[];
  tools: {
    webSearch: { enabled: boolean };
    urlRetrieval: { enabled: boolean };
    codeExecution: { enabled: boolean };
    mcp: { enabled: boolean };
    documents: {
      enabled: boolean;
      types: {
        text: boolean;
        code: boolean;
        sheet: boolean;
      };
    };
    followupSuggestions: { enabled: boolean; default: GatewayModelIdMap[G] };
    text: { polish: GatewayModelIdMap[G] };
    sheet: { format: GatewayModelIdMap[G]; analyze: GatewayModelIdMap[G] };
    code: { edits: GatewayModelIdMap[G] };
    image: ImageDefault<G>;
    video: VideoDefault<G>;
    deepResearch: {
      enabled: boolean;
      researchModel: GatewayModelIdMap[G];
      summarizationModel: GatewayModelIdMap[G];
      compressionModel: GatewayModelIdMap[G];
      finalReportModel: GatewayModelIdMap[G];
      statusUpdateModel: GatewayModelIdMap[G];
      allowClarification: boolean;
      maxResearcherIterations: number;
      maxResearcherSteps: number;
      maxConcurrentResearchUnits: number;
      maxSearchQueries: number;
      maxInputTokensPerRun: number | null;
      hosted: boolean;
      researchSidecarUrl: string;
    };
  };
  workflows: {
    chat: GatewayModelIdMap[G];
    title: GatewayModelIdMap[G];
    /**
     * The fact extractor. Split off `title` so that retuning what decides which
     * claims become facts is never a side effect of retuning chat names.
     */
    extract: GatewayModelIdMap[G];
    pdf: GatewayModelIdMap[G];
    chatImageCompatible: GatewayModelIdMap[G];
  };
}

const vercelDefaults = {
  providerOrder: ["openai", "google", "anthropic"],
  disabledModels: [],
  curatedDefaults: [
    "openai/gpt-5-nano",
    "openai/gpt-5-mini",
    "openai/gpt-5.2",
    "openai/gpt-5.2-chat",
    "google/gemini-2.5-flash-lite",
    "google/gemini-3-flash",
    "google/gemini-3-pro-preview",
    "anthropic/claude-sonnet-4.5",
    "anthropic/claude-opus-4.5",
  ],
  anonymousModels: ["google/gemini-2.5-flash-lite", "openai/gpt-5-nano"],
  workflows: {
    chat: "openai/gpt-5-mini",
    title: "openai/gpt-5-nano",
    extract: "openai/gpt-5-nano",
    pdf: "openai/gpt-5-mini",
    chatImageCompatible: "openai/gpt-4o-mini",
  },
  tools: {
    webSearch: { enabled: false },
    urlRetrieval: { enabled: false },
    codeExecution: { enabled: false },
    mcp: { enabled: false },
    documents: {
      enabled: true,
      types: { text: true, code: true, sheet: true },
    },
    followupSuggestions: {
      enabled: false,
      default: "google/gemini-2.5-flash-lite",
    },
    text: { polish: "openai/gpt-5-mini" },
    sheet: { format: "openai/gpt-5-mini", analyze: "openai/gpt-5-mini" },
    code: { edits: "openai/gpt-5-mini" },
    image: { enabled: false, default: "google/gemini-3-pro-image" },
    video: { enabled: false, default: "xai/grok-imagine-video" },
    deepResearch: {
      enabled: false,
      researchModel: "google/gemini-2.5-flash-lite",
      summarizationModel: "google/gemini-2.5-flash-lite",
      compressionModel: "google/gemini-2.5-flash-lite",
      finalReportModel: "google/gemini-3-flash",
      statusUpdateModel: "google/gemini-2.5-flash-lite",
      allowClarification: true,
      maxResearcherIterations: 1,
      maxResearcherSteps: 6,
      maxConcurrentResearchUnits: 2,
      maxSearchQueries: 2,
      /**
       * FAIL-CLOSED FALLBACK for a deployment that never configured research.
       * `hosted: true` + a finite cap is the restrictive pair:
       * decideResearchBudget() refuses an uncapped hosted run. An empty
       * researchSidecarUrl disables every sidecar-backed source. chat.config.ts
       * overrides all three for this fork.
       */
      maxInputTokensPerRun: 1_500_000,
      hosted: true,
      researchSidecarUrl: "",
    },
  },
} satisfies ModelDefaultsFor<"vercel">;

const openrouterDefaults = {
  providerOrder: ["openai", "google", "anthropic"],
  disabledModels: [],
  curatedDefaults: [
    "openai/gpt-5-nano",
    "openai/gpt-5-mini",
    "openai/gpt-5.2",
    "openai/gpt-5.2-chat",
    "google/gemini-2.5-flash-lite",
    "google/gemini-3-flash",
    "google/gemini-3-pro-preview",
    "anthropic/claude-sonnet-4.5",
    "anthropic/claude-opus-4.5",
    "xai/grok-4",
  ],
  anonymousModels: ["google/gemini-2.5-flash-lite", "openai/gpt-5-nano"],
  workflows: {
    chat: "openai/gpt-5-mini",
    title: "openai/gpt-5-nano",
    extract: "openai/gpt-5-nano",
    pdf: "openai/gpt-5-mini",
    chatImageCompatible: "openai/gpt-4o-mini",
  },
  tools: {
    webSearch: { enabled: false },
    urlRetrieval: { enabled: false },
    codeExecution: { enabled: false },
    mcp: { enabled: false },
    documents: {
      enabled: true,
      types: { text: true, code: true, sheet: true },
    },
    followupSuggestions: {
      enabled: false,
      default: "google/gemini-2.5-flash-lite",
    },
    text: { polish: "openai/gpt-5-mini" },
    sheet: { format: "openai/gpt-5-mini", analyze: "openai/gpt-5-mini" },
    code: { edits: "openai/gpt-5-mini" },
    image: { enabled: false },
    video: { enabled: false },
    deepResearch: {
      enabled: false,
      researchModel: "google/gemini-2.5-flash-lite",
      summarizationModel: "google/gemini-2.5-flash-lite",
      compressionModel: "google/gemini-2.5-flash-lite",
      finalReportModel: "google/gemini-3-flash",
      statusUpdateModel: "google/gemini-2.5-flash-lite",
      allowClarification: true,
      maxResearcherIterations: 1,
      maxResearcherSteps: 6,
      maxConcurrentResearchUnits: 2,
      maxSearchQueries: 2,
      /**
       * FAIL-CLOSED FALLBACK for a deployment that never configured research.
       * `hosted: true` + a finite cap is the restrictive pair:
       * decideResearchBudget() refuses an uncapped hosted run. An empty
       * researchSidecarUrl disables every sidecar-backed source. chat.config.ts
       * overrides all three for this fork.
       */
      maxInputTokensPerRun: 1_500_000,
      hosted: true,
      researchSidecarUrl: "",
    },
  },
} satisfies ModelDefaultsFor<"openrouter">;

const openaiDefaults = {
  providerOrder: ["openai"],
  disabledModels: [],
  /**
   * The deprecated chat-latest model was here and is GONE. GET /v1/models still
   * LISTS it — which is exactly why a listing check does not catch this class of
   * breakage — but both inference endpoints refuse it, verified by calling them
   * on 2026-08-21:
   *
   *   /v1/chat/completions -> 404 "...has been deprecated"
   *   /v1/responses        -> 404 "Model not found"
   *
   * It was live in the model dropdown, so any founder who picked it got a chat
   * that could not answer.
   *
   * The rest of the list moves to the 5.6 family because the 2026-07-30 price
   * cut collapsed the cheap-versus-strong tradeoff this list was built around:
   * luna now costs what the 5.4 nano tier costs while beating 5.4-mini on both
   * GPQA and TAU-Bench, so the older rungs no longer earn a slot.
   */
  curatedDefaults: ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"],
  anonymousModels: ["gpt-5-nano"],
  workflows: {
    chat: "gpt-5-mini",
    title: "gpt-5-nano",
    extract: "gpt-5-nano",
    pdf: "gpt-5-mini",
    chatImageCompatible: "gpt-4o-mini",
  },
  tools: {
    webSearch: { enabled: false },
    urlRetrieval: { enabled: false },
    codeExecution: { enabled: false },
    mcp: { enabled: false },
    documents: {
      enabled: true,
      types: { text: true, code: true, sheet: true },
    },
    followupSuggestions: { enabled: false, default: "gpt-5-nano" },
    text: { polish: "gpt-5-mini" },
    sheet: { format: "gpt-5-mini", analyze: "gpt-5-mini" },
    code: { edits: "gpt-5-mini" },
    image: { enabled: false, default: "gpt-image-1" },
    video: { enabled: false },
    deepResearch: {
      enabled: false,
      researchModel: "gpt-5-nano",
      summarizationModel: "gpt-5-nano",
      compressionModel: "gpt-5-nano",
      finalReportModel: "gpt-5-mini",
      statusUpdateModel: "gpt-5-nano",
      allowClarification: true,
      maxResearcherIterations: 1,
      maxResearcherSteps: 6,
      maxConcurrentResearchUnits: 2,
      maxSearchQueries: 2,
      /**
       * FAIL-CLOSED FALLBACK for a deployment that never configured research.
       * `hosted: true` + a finite cap is the restrictive pair:
       * decideResearchBudget() refuses an uncapped hosted run. An empty
       * researchSidecarUrl disables every sidecar-backed source. chat.config.ts
       * overrides all three for this fork.
       */
      maxInputTokensPerRun: 1_500_000,
      hosted: true,
      researchSidecarUrl: "",
    },
  },
} satisfies ModelDefaultsFor<"openai">;

const openaiCompatibleDefaults = {
  providerOrder: ["openai"],
  disabledModels: [],
  /**
   * The deprecated chat-latest model is dropped here too. It was in this list
   * as well as in `openaiDefaults`, and a curated default that 404s is broken
   * wherever it is offered. The rest is deliberately NOT moved to the 5.6
   * family: this gateway points at an arbitrary OpenAI-compatible endpoint, so
   * which models exist is unknown from here and naming OpenAI's newest ids
   * would be a guess about someone else's server.
   */
  curatedDefaults: ["gpt-5-nano", "gpt-5-mini", "gpt-5.2"],
  anonymousModels: ["gpt-5-nano"],
  workflows: {
    chat: "gpt-5-mini",
    title: "gpt-5-nano",
    extract: "gpt-5-nano",
    pdf: "gpt-5-mini",
    chatImageCompatible: "gpt-4o-mini",
  },
  tools: {
    webSearch: { enabled: false },
    urlRetrieval: { enabled: false },
    codeExecution: { enabled: false },
    mcp: { enabled: false },
    documents: {
      enabled: true,
      types: { text: true, code: true, sheet: true },
    },
    followupSuggestions: { enabled: false, default: "gpt-5-nano" },
    text: { polish: "gpt-5-mini" },
    sheet: { format: "gpt-5-mini", analyze: "gpt-5-mini" },
    code: { edits: "gpt-5-mini" },
    image: { enabled: false, default: "gpt-image-1" },
    video: { enabled: false },
    deepResearch: {
      enabled: false,
      researchModel: "gpt-5-nano",
      summarizationModel: "gpt-5-nano",
      compressionModel: "gpt-5-nano",
      finalReportModel: "gpt-5-mini",
      statusUpdateModel: "gpt-5-nano",
      allowClarification: true,
      maxResearcherIterations: 1,
      maxResearcherSteps: 6,
      maxConcurrentResearchUnits: 2,
      maxSearchQueries: 2,
      /**
       * FAIL-CLOSED FALLBACK for a deployment that never configured research.
       * `hosted: true` + a finite cap is the restrictive pair:
       * decideResearchBudget() refuses an uncapped hosted run. An empty
       * researchSidecarUrl disables every sidecar-backed source. chat.config.ts
       * overrides all three for this fork.
       */
      maxInputTokensPerRun: 1_500_000,
      hosted: true,
      researchSidecarUrl: "",
    },
  },
} satisfies ModelDefaultsFor<"openai-compatible">;

const litellmDefaults = {
  providerOrder: ["openai"],
  disabledModels: [],
  curatedDefaults: [
    "openai/gpt-4o-mini",
    "openai/gpt-4o",
    "openai/gpt-5-mini",
    "openai/gpt-5-nano",
  ],
  anonymousModels: ["openai/gpt-4o-mini"],
  workflows: {
    chat: "openai/gpt-4o-mini",
    title: "openai/gpt-4o-mini",
    extract: "openai/gpt-4o-mini",
    pdf: "openai/gpt-4o-mini",
    chatImageCompatible: "openai/gpt-4o-mini",
  },
  tools: {
    webSearch: { enabled: false },
    urlRetrieval: { enabled: false },
    codeExecution: { enabled: false },
    mcp: { enabled: false },
    documents: {
      enabled: true,
      types: { text: true, code: true, sheet: true },
    },
    followupSuggestions: { enabled: false, default: "openai/gpt-4o-mini" },
    text: { polish: "openai/gpt-4o-mini" },
    sheet: { format: "openai/gpt-4o-mini", analyze: "openai/gpt-4o-mini" },
    code: { edits: "openai/gpt-4o-mini" },
    image: { enabled: false },
    video: { enabled: false },
    deepResearch: {
      enabled: false,
      researchModel: "openai/gpt-4o-mini",
      summarizationModel: "openai/gpt-4o-mini",
      compressionModel: "openai/gpt-4o-mini",
      finalReportModel: "openai/gpt-4o",
      statusUpdateModel: "openai/gpt-4o-mini",
      allowClarification: true,
      maxResearcherIterations: 1,
      maxResearcherSteps: 6,
      maxConcurrentResearchUnits: 2,
      maxSearchQueries: 2,
      /**
       * FAIL-CLOSED FALLBACK for a deployment that never configured research.
       * `hosted: true` + a finite cap is the restrictive pair:
       * decideResearchBudget() refuses an uncapped hosted run. An empty
       * researchSidecarUrl disables every sidecar-backed source. chat.config.ts
       * overrides all three for this fork.
       */
      maxInputTokensPerRun: 1_500_000,
      hosted: true,
      researchSidecarUrl: "",
    },
  },
} satisfies ModelDefaultsFor<"litellm">;

const anthropicDefaults = {
  providerOrder: ["anthropic"],
  disabledModels: [],
  curatedDefaults: [
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
  ],
  anonymousModels: ["claude-haiku-4-5"],
  workflows: {
    chat: "claude-sonnet-5",
    title: "claude-haiku-4-5",
    extract: "claude-haiku-4-5",
    pdf: "claude-sonnet-5",
    chatImageCompatible: "claude-haiku-4-5",
  },
  tools: {
    webSearch: { enabled: false },
    urlRetrieval: { enabled: false },
    codeExecution: { enabled: false },
    mcp: { enabled: false },
    documents: {
      enabled: true,
      types: { text: true, code: true, sheet: true },
    },
    followupSuggestions: { enabled: false, default: "claude-haiku-4-5" },
    text: { polish: "claude-haiku-4-5" },
    sheet: { format: "claude-haiku-4-5", analyze: "claude-haiku-4-5" },
    code: { edits: "claude-sonnet-4-6" },
    // Anthropic ships no image or video models, so no `default` key is allowed.
    image: { enabled: false },
    video: { enabled: false },
    deepResearch: {
      enabled: false,
      researchModel: "claude-haiku-4-5",
      summarizationModel: "claude-haiku-4-5",
      compressionModel: "claude-haiku-4-5",
      finalReportModel: "claude-sonnet-5",
      statusUpdateModel: "claude-haiku-4-5",
      allowClarification: true,
      maxResearcherIterations: 1,
      maxResearcherSteps: 6,
      maxConcurrentResearchUnits: 2,
      maxSearchQueries: 2,
      /**
       * FAIL-CLOSED FALLBACK for a deployment that never configured research.
       * `hosted: true` + a finite cap is the restrictive pair:
       * decideResearchBudget() refuses an uncapped hosted run. An empty
       * researchSidecarUrl disables every sidecar-backed source. chat.config.ts
       * overrides all three for this fork.
       */
      maxInputTokensPerRun: 1_500_000,
      hosted: true,
      researchSidecarUrl: "",
    },
  },
} satisfies ModelDefaultsFor<"anthropic">;

// Record ensures a compile error if a new gateway is added but not here.
export const GATEWAY_MODEL_DEFAULTS: {
  [G in GatewayType]: ModelDefaultsFor<G>;
} = {
  vercel: vercelDefaults,
  openrouter: openrouterDefaults,
  openai: openaiDefaults,
  "openai-compatible": openaiCompatibleDefaults,
  litellm: litellmDefaults,
  anthropic: anthropicDefaults,
};
