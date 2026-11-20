import {
  generateText,
  type LanguageModel,
  NoObjectGeneratedError,
  Output,
} from "ai";
import type { AppModelId } from "@/lib/ai/app-models";
import { DeclinedCallError, isDeclined } from "@/lib/ai/refused-reply";
import type { CostAccumulator } from "@/lib/credits/cost-accumulator";
import type { FactExtractor } from "./extract";
import type { GateJudge } from "./gate";
import { ExtractionOutputSchema, JudgeOutputSchema } from "./types";

/**
 * OpenAI's structured-output STRICT mode requires every property of an object to
 * appear in `required`. Our judge/extraction schemas deliberately use Zod
 * `.default()` on evidence/gap/nextQuestion/confidence so a slightly-off model
 * response fails closed with a readable reason instead of throwing — and a
 * defaulted field is emitted as OPTIONAL, which strict mode rejects outright:
 *
 *   Invalid schema for response_format 'response': ... 'required' is required to
 *   be supplied and to be an array including every key in properties.
 *
 * Verified live on 2026-08-19: with strict mode on, every gate call failed and
 * the phase fell to a fail-closed BLOCK. Relaxing strict mode keeps the lenient
 * schema (which is the deliberate design — see types.ts) and is safe because
 * gate.ts re-validates: normalizeEvaluation() downgrades any malformed
 * evaluation to `not-evaluable`, and decideGate() fails closed on it.
 *
 * Ignored by providers that do not understand it, so it stays correct on the
 * Anthropic gateway.
 *
 * Effort is NOT set here: it comes with the model, from
 * `getLanguageModel(id, "judge" | "extract" | "persona")`
 * (`lib/ai/call-paths.ts`), and merges with these options key by key. The gate
 * eval (`evals/gate-calibration.eval.ts`) asks for its model the same way as
 * the live gate (`runtime.ts`), so the two send the same request.
 */
export const LENIENT_SCHEMA_OPTIONS = {
  openai: { strictJsonSchema: false },
} as const;

/**
 * What a call actually cost, in tokens. Reported rather than logged so the
 * caller decides what to do with it.
 *
 * WHY THIS EXISTS: this is a BYOK product — the spend is the user's, on their
 * key, and a gated workflow makes several model calls per turn (one extraction,
 * one judge) where a chat wrapper makes one. "It felt expensive" is not a bug
 * report anyone can act on. Step 5's research fan-out additionally needs a
 * pre-flight budget cap that REFUSES TO START, and a cap needs a meter.
 */
export type ModelUsage = {
  /** Which seam spent it, e.g. "phase-gate" or "deep-research-brief". */
  functionId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

export type UsageSink = (usage: ModelUsage) => void;

/**
 * A sink that records each call on `costAccumulator` against `modelId`, under
 * the call's own `functionId`. Undefined when there is nothing to record into.
 *
 * A null token count is recorded as absent, which prices that side of the call
 * at zero: an undercount, but one the provider caused by not reporting usage.
 */
export function chargeUsageTo(
  costAccumulator: CostAccumulator | undefined,
  modelId: AppModelId
): UsageSink | undefined {
  if (!costAccumulator) {
    return;
  }
  return (usage) =>
    costAccumulator.addLLMCost(
      modelId,
      {
        inputTokens: usage.inputTokens ?? undefined,
        outputTokens: usage.outputTokens ?? undefined,
      },
      usage.functionId
    );
}

type CallUsage =
  | {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    }
  | undefined;

function reportUsage(
  onUsage: UsageSink | undefined,
  functionId: string,
  usage: CallUsage
): void {
  onUsage?.({
    functionId,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    totalTokens: usage?.totalTokens ?? null,
  });
}

/**
 * Runs one structured-output `generateText` call and reports its usage
 * WHETHER OR NOT THE REPLY PARSED, then hands back the output or re-throws.
 *
 * A reply that is not JSON, or does not match the schema, makes
 * `Output.object().parseCompleteOutput` throw `NoObjectGeneratedError` from
 * inside `generateText`: the provider was paid, but no `response` exists to
 * read `usage` from. The error carries that call's `usage`, so it is reported
 * from there before re-throwing. Re-throwing is what keeps the callers fail
 * closed exactly as before (`gate.ts` turns a rejection into a BLOCK,
 * `extract.ts` and the persona generator into their own refusals, and the
 * deep-research tool's clarify and brief steps in
 * `tools/platform/deep-research/pipeline.ts` fail the run as they did); only
 * the charge changes. Any other error is re-thrown untouched: a call that failed
 * before the provider answered has no usage to report.
 *
 * A DECLINED CALL (Claude's `refusal`, `content-filter`) is recognised HERE,
 * once, and re-thrown as `DeclinedCallError` (`lib/ai/refused-reply.ts`), so
 * each caller can say "the model declined" instead of "the call failed". It
 * has to be here: an EMPTY declined reply never reaches the parser (the SDK
 * parses only a `stop` or a non-empty reply), so `generateText` resolves and
 * it is reading `output` that throws, as `NoOutputGeneratedError`, with no
 * finish reason on it. So the finish reason is read off the resolved result,
 * after its usage is reported and before `output` is touched. A PARTIAL
 * declined reply fails to parse and arrives as `NoObjectGeneratedError` with
 * the finish reason on it. Either way the usage is reported exactly once, and
 * a decline is still a rejection, so every caller stays fail closed. A
 * declined reply that happened to parse is not used either: a refusal is not
 * an answer, whatever shape its text has.
 */
export async function generateReportingUsage<T>(
  onUsage: UsageSink | undefined,
  functionId: string,
  call: () => Promise<{ usage: CallUsage; finishReason: string; output: T }>
): Promise<T> {
  let response: { usage: CallUsage; finishReason: string; output: T };
  try {
    response = await call();
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      reportUsage(onUsage, functionId, error.usage);
      if (isDeclined(error.finishReason)) {
        throw new DeclinedCallError(functionId, { cause: error });
      }
    }
    throw error;
  }
  reportUsage(onUsage, functionId, response.usage);
  if (isDeclined(response.finishReason)) {
    throw new DeclinedCallError(functionId);
  }
  return response.output;
}

export function createModelGateJudge({
  model,
  onUsage,
}: {
  model: LanguageModel;
  onUsage?: UsageSink;
}): GateJudge {
  return ({ system, prompt }) =>
    generateReportingUsage(onUsage, "phase-gate", () =>
      generateText({
        model,
        system,
        prompt,
        output: Output.object({ schema: JudgeOutputSchema }),
        providerOptions: LENIENT_SCHEMA_OPTIONS,
        experimental_telemetry: { isEnabled: true, functionId: "phase-gate" },
      })
    );
}

export function createModelFactExtractor({
  model,
  onUsage,
}: {
  model: LanguageModel;
  onUsage?: UsageSink;
}): FactExtractor {
  return ({ system, prompt }) =>
    generateReportingUsage(onUsage, "phase-extract", () =>
      generateText({
        model,
        system,
        prompt,
        output: Output.object({ schema: ExtractionOutputSchema }),
        providerOptions: LENIENT_SCHEMA_OPTIONS,
        experimental_telemetry: {
          isEnabled: true,
          functionId: "phase-extract",
        },
      })
    );
}
