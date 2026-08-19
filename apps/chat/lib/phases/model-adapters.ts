import { generateText, type LanguageModel, Output } from "ai";
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
 * Ignored by providers that do not understand it, so this stays correct if the
 * gateway is switched back to Anthropic.
 */
const LENIENT_SCHEMA_OPTIONS = {
  openai: { strictJsonSchema: false },
} as const;

export function createModelGateJudge({
  model,
}: {
  model: LanguageModel;
}): GateJudge {
  return async ({ system, prompt }) => {
    const response = await generateText({
      model,
      system,
      prompt,
      output: Output.object({ schema: JudgeOutputSchema }),
      providerOptions: LENIENT_SCHEMA_OPTIONS,
      experimental_telemetry: { isEnabled: true, functionId: "phase-gate" },
    });
    return response.output;
  };
}

export function createModelFactExtractor({
  model,
}: {
  model: LanguageModel;
}): FactExtractor {
  return async ({ system, prompt }) => {
    const response = await generateText({
      model,
      system,
      prompt,
      output: Output.object({ schema: ExtractionOutputSchema }),
      providerOptions: LENIENT_SCHEMA_OPTIONS,
      experimental_telemetry: { isEnabled: true, functionId: "phase-extract" },
    });
    return response.output;
  };
}
