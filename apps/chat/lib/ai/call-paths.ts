import type {
  LanguageModelV3,
  LanguageModelV3Middleware,
  SharedV3ProviderOptions,
} from "@ai-sdk/provider";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";
import {
  anthropicEffortOptions,
  anthropicLeastThinkingOptions,
  CALL_EFFORT,
} from "./anthropic-thinking";

/**
 * WHAT EACH CALL PATH ASKS OF THE MODEL IT RUNS ON, IN ONE PLACE.
 *
 * Effort and thinking used to be added by hand at about eleven call sites, and
 * a call that left them out ran at the model's own default: `high` effort on
 * Sonnet 5.5, with its cost, its latency and, on a capped call, thinking that
 * eats the cap. `getLanguageModel(modelId, path)` (lib/ai/providers.ts) now
 * takes the path as a REQUIRED argument and applies this table through
 * `defaultSettingsMiddleware`, so a new call cannot forget it: it does not
 * compile without a path. Call-level `providerOptions` still merge on top, key
 * by key (the chat's `thinking` for a `-reasoning` variant, the structured-
 * output calls' relaxed OpenAI strict mode).
 *
 * Each entry is a function of the API model id, because what a model accepts
 * is: an option it rejects fails the whole call, so a model whose handling is
 * not established gets nothing.
 */
export type CallPath =
  | keyof typeof CALL_EFFORT
  /** One step of a researcher's tool loop (deep research). */
  | "researcherStep"
  /** Condensing one researcher's findings (deep research). */
  | "compression"
  /** Writing the final report (deep research). */
  | "report";

/** The `gpt-5.6-*` family, with or without a gateway's provider prefix. */
const GPT_5_6_MODEL = /^(?:openai\/)?gpt-5\.6-/;

const effort =
  (path: keyof typeof CALL_EFFORT) =>
  (apiModelId: string): SharedV3ProviderOptions | undefined =>
    anthropicEffortOptions(apiModelId, CALL_EFFORT[path]);

/**
 * The least thinking a Claude 5.5 model takes, else low effort for any other
 * Claude model that takes effort, else nothing: what every deep-research call
 * whose output cap is a time budget gets.
 */
const leastThinkingOrLowEffort = (
  apiModelId: string
): SharedV3ProviderOptions | undefined =>
  anthropicLeastThinkingOptions(apiModelId) ??
  anthropicEffortOptions(apiModelId, CALL_EFFORT.research);

const CALL_PATH_OPTIONS: Record<
  CallPath,
  (apiModelId: string) => SharedV3ProviderOptions | undefined
> = {
  chat: effort("chat"),
  judge: effort("judge"),
  extract: effort("extract"),
  persona: effort("persona"),
  title: effort("title"),
  followups: effort("followups"),
  // Clarify, brief and the supervisor: low effort, because each one runs
  // against the research clock under a small output cap
  // (tools/platform/deep-research/configuration.ts::getDeepResearchConfig).
  research: effort("research"),
  /*
    ONE STEP OF A RESEARCHER'S TOOL LOOP. Its cap, `researcher_step_max_tokens`
    (1,500), is the tightest in the pipeline and counts thinking: it was sized
    from tool-call steps that spent 37 to 53 tokens reasoning. Low effort alone
    leaves adaptive thinking on, and a step that thinks past the cap ends with
    no tool call, or as a first reply that leaves the topic "NOT RESEARCHED". So
    a Claude 5.5 model gets the least thinking it takes (Haiku 5.5, the
    configured researcher, takes `disabled`); any other model keeps what the
    other research calls get.
  */
  researcherStep: leastThinkingOrLowEffort,
  /*
    COMPRESSION: the lowest reasoning effort the model takes, so its reasoning
    does not eat the output cap. Compression condenses text it is handed, and a
    model left at its default effort spent part of the 4,000-token cap on
    reasoning that nothing reads: live QA (re-check 5) saw calls of 3,730, 3,300
    and 1,931 output tokens of which 1,459, 516 and 375 were reasoning, one
    ending 270 short of the cap, and an earlier run ended at exactly the cap
    with a note cut off. The cap is the time budget
    (`compression_model_max_tokens`) and is not raised.

    The `gpt-5.6-*` family is the one this repo has established takes `none`
    (the sidecar's `RESEARCH_SIM_REASONING_EFFORT` is derived as `none` for it,
    and `lib/ai/model-capabilities.ts` records the 400 that names it). That
    holds on the Responses API this call uses, for `gpt-5.6-terra`: live QA
    (re-check 6) sent `reasoningEffort: "none"` on four terra compression calls
    through the app's own path, and none raised an API error; the four reported
    0, 0, 0 and 0 reasoning tokens.

    The Claude 5.5 models get their own least thinking at low effort
    (`anthropic-thinking.ts::anthropicLeastThinkingOptions`): thinking is on by
    default there and counts toward the same cap. Any other Claude model that
    takes effort (4.6 and newer) gets low effort, as `researcherStep` does;
    left at its default (`high`, adaptive thinking on) it would think into the
    cap. Any other model gets no option: whether it takes the key at all is
    unknown, and a rejected option would fail the whole topic's compression,
    which is worse than reasoning tokens.
  */
  compression: (apiModelId) =>
    GPT_5_6_MODEL.test(apiModelId)
      ? { openai: { reasoningEffort: "none" } }
      : leastThinkingOrLowEffort(apiModelId),
  /*
    THE FINAL REPORT. Its 6,000-token cap is the report's time budget too, and
    the report is written as the input of one `createTextDocument` call: a cap
    spent on thinking cuts that input off and the run ends with no document. So
    a Claude 5.5 model writes it with the least thinking it takes, and any
    other Claude model that takes effort with low effort. Nothing for any
    other model.
  */
  report: leastThinkingOrLowEffort,
};

/** PURE. The provider options a call path sends to a model, or none. */
export function callPathProviderOptions(
  path: CallPath,
  apiModelId: string
): SharedV3ProviderOptions | undefined {
  return CALL_PATH_OPTIONS[path](apiModelId);
}

/** The middleware that applies a call path's options, or none to apply. */
export function callPathMiddleware(
  path: CallPath,
  apiModelId: string
): LanguageModelV3Middleware | undefined {
  const providerOptions = callPathProviderOptions(path, apiModelId);
  return providerOptions
    ? defaultSettingsMiddleware({ settings: { providerOptions } })
    : undefined;
}

/**
 * A model built outside `getLanguageModel` (scripts/demo-run.ts, which runs
 * with no Next runtime and so cannot reach the model catalog), with its call
 * path's options applied the same way.
 */
export function withCallPath(
  model: LanguageModelV3,
  path: CallPath,
  apiModelId: string
): LanguageModelV3 {
  const middleware = callPathMiddleware(path, apiModelId);
  return middleware ? wrapLanguageModel({ model, middleware }) : model;
}
