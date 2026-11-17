import { generateText, jsonSchema, type LanguageModel, Output } from "ai";
import { z } from "zod";
import { CALL_EFFORT } from "@/lib/ai/anthropic-thinking";
import {
  generateReportingUsage,
  structuredOutputOptions,
  type UsageSink,
} from "../phases/model-adapters";
import type { PersonaGenerator } from "./generate";
import { type PersonaDraft, PersonaDraftSchema } from "./types";

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
 * (`structuredOutputOptions`) keeps the lenient schema (which is the deliberate
 * design — see types.ts) and is safe because generate.ts re-validates:
 * normalizePersona() discards every claim that arrives without evidence, and an
 * unreadable response falls to failClosedPersonaArtifact().
 *
 * Do NOT "fix" this by removing the `.default()`s. Their leniency is the reason
 * a malformed response degrades to "not established" instead of to a persona
 * that looks finished.
 */

/**
 * WHAT IS SENT is the schema's OUTPUT shape: every field required. WHAT PARSES
 * the reply is still the lenient `PersonaDraftSchema`, defaults and all.
 *
 * The AI SDK sends a Zod schema's INPUT shape, where every `.default()` field is
 * optional, and this schema has more than thirty of them counted the way
 * Anthropic counts them (each nested use separately). Anthropic's native
 * structured output (`output_config.format`) refuses a schema with that many
 * optional properties, so `@ai-sdk/anthropic` falls back to a `json` tool it
 * must FORCE the model to call. Sonnet 5.5 and Opus 5.5 reject a forced tool
 * choice, the provider downgrades it to `auto`, and the model may then answer
 * in prose: every such reply would fail the parse and the persona would come
 * back as a refusal. The output shape has no optional property at all, so it
 * goes out as native structured output on every Claude model, and OpenAI (with
 * strict mode relaxed) accepts it just the same.
 */
const PERSONA_DRAFT_OUTPUT = jsonSchema<PersonaDraft>(
  () =>
    z.toJSONSchema(PersonaDraftSchema, {
      target: "draft-7",
      io: "output",
      reused: "inline",
    }),
  {
    validate: async (value) => {
      const result = await PersonaDraftSchema.safeParseAsync(value);
      return result.success
        ? { success: true, value: result.data }
        : { success: false, error: result.error };
    },
  }
);

/**
 * THE ONLY IMPURE PART OF PERSONA GENERATION. Everything upstream of this
 * function — the prompt, the refusal, the normalisation, the versioning — runs
 * with no key, no network and no database.
 */
export function createModelPersonaGenerator({
  model,
  onUsage,
}: {
  model: LanguageModel;
  /** Same seam as the gate judge's: see lib/phases/model-adapters.ts. */
  onUsage?: UsageSink;
}): PersonaGenerator {
  // Usage is reported even when the reply fails the schema: see
  // `generateReportingUsage`.
  return ({ system, prompt }) =>
    generateReportingUsage(onUsage, "persona-generate", () =>
      generateText({
        model,
        system,
        prompt,
        output: Output.object({ schema: PERSONA_DRAFT_OUTPUT }),
        providerOptions: structuredOutputOptions(model, CALL_EFFORT.persona),
        experimental_telemetry: {
          isEnabled: true,
          functionId: "persona-generate",
        },
      })
    );
}
