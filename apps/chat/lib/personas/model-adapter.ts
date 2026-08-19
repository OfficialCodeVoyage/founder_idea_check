import { generateText, type LanguageModel, Output } from "ai";
import type { PersonaGenerator } from "./generate";
import { PersonaDraftSchema } from "./types";

/**
 * OpenAI's structured-output STRICT mode requires every property of an object to
 * appear in `required`. `PersonaDraftSchema` deliberately uses Zod `.default()`
 * on every field so a slightly-off model response fails CLOSED with a readable
 * reason instead of throwing — and a defaulted field is emitted as OPTIONAL,
 * which strict mode rejects outright:
 *
 *   Invalid schema for response_format 'response': ... 'required' is required to
 *   be supplied and to be an array including every key in properties.
 *
 * This is the same trap lib/phases/model-adapters.ts documents hitting live on
 * 2026-08-19, where strict mode made every gate call fail. Relaxing strict mode
 * keeps the lenient schema (which is the deliberate design — see types.ts) and
 * is safe because generate.ts re-validates: normalizePersona() discards every
 * claim that arrives without evidence, and an unreadable response falls to
 * failClosedPersonaArtifact().
 *
 * Do NOT "fix" this by removing the `.default()`s. Their leniency is the reason
 * a malformed response degrades to "not established" instead of to a persona
 * that looks finished.
 *
 * Ignored by providers that do not understand it, so this stays correct if the
 * gateway is switched back to Anthropic.
 */
const LENIENT_SCHEMA_OPTIONS = {
  openai: { strictJsonSchema: false },
} as const;

/**
 * THE ONLY IMPURE PART OF PERSONA GENERATION. Everything upstream of this
 * function — the prompt, the refusal, the normalisation, the versioning — runs
 * with no key, no network and no database.
 */
export function createModelPersonaGenerator({
  model,
}: {
  model: LanguageModel;
}): PersonaGenerator {
  return async ({ system, prompt }) => {
    const response = await generateText({
      model,
      system,
      prompt,
      output: Output.object({ schema: PersonaDraftSchema }),
      providerOptions: LENIENT_SCHEMA_OPTIONS,
      experimental_telemetry: {
        isEnabled: true,
        functionId: "persona-generate",
      },
    });
    return response.output;
  };
}
