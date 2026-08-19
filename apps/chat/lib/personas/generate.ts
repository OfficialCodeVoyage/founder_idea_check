import {
  emptyPersona,
  normalizePersona,
  personaAttributeEntries,
} from "./normalize";
import {
  type BuildPersonaPromptInput,
  buildPersonaPrompt,
  type PersonaPromptRequest,
} from "./prompt";
import {
  PERSONA_CONTENT_VERSION,
  type Persona,
  type PersonaArtifact,
  PersonaDraftSchema,
} from "./types";

/**
 * THE SEAM. `PersonaGenerator` is the single injected model-calling function —
 * same shape and same discipline as `GateJudge` in gate.ts and `FactExtractor`
 * in extract.ts.
 *
 * Tests pass a plain async closure; the route passes
 * createModelPersonaGenerator({ model: await getLanguageModel(...) }).
 *
 * Nothing reachable from this file imports "ai", "@/lib/ai/providers" or
 * "@/lib/db/*". That is the property that makes persona generation runnable
 * under vitest with no API key, no network and no database — and it is why the
 * refusal path, which is the one that actually protects the founder, is the
 * best-tested path in the module.
 */
export type PersonaGenerator = (
  request: PersonaPromptRequest
) => Promise<unknown>;

export type PersonaGenerationStage =
  /** The fact store was too thin to ground a persona. No model call was made. */
  | "refused-no-grounding"
  /** The model call threw — no key, rate limit, network. */
  | "generator-call-failed"
  /** The model answered in a shape the lenient draft schema could not read. */
  | "generator-schema-mismatch"
  /** The model answered, but nothing survived normalisation. */
  | "nothing-established"
  /** A fact a BLOCKING criterion names was evicted by the token budget. */
  | "pinned-fact-evicted";

export type PersonaDeps = {
  generate: PersonaGenerator;
  /**
   * Optional failure sink. PURE MODULE RULE: this file must not import the
   * logger (it would drag `server-only` into vitest), so the caller injects one.
   * Same arrangement as ExtractDeps.onError.
   */
  onError?: (error: unknown, stage: PersonaGenerationStage) => void;
};

/**
 * PURE. Assembles the stored artifact.
 *
 * `degradedReasons` is reserved for "THIS VERSION IS NOT A FINDING": a refusal,
 * a failed call, an unreadable response, an empty result, or a pinned fact the
 * budget evicted. It is deliberately NOT used for "the store does not contain
 * fact X yet" — that is the normal state of an early project, it is already
 * visible as a not-established attribute, and reporting it here would mark every
 * honest early persona as degraded until the word meant nothing.
 */
export function personaArtifact({
  persona,
  groundedInFactKeys,
  droppedPinnedFactKeys,
  degradedReasons,
}: {
  persona: Persona;
  groundedInFactKeys: string[];
  droppedPinnedFactKeys: string[];
  degradedReasons: string[];
}): PersonaArtifact {
  return {
    artifact: "persona",
    contentVersion: PERSONA_CONTENT_VERSION,
    persona,
    groundedInFactKeys,
    droppedPinnedFactKeys,
    degradedReasons,
  };
}

/**
 * PURE. The artifact for "no persona could be produced". Mirrors
 * failClosedVerdict in gate.ts: a named reason, and an artifact whose every
 * field is explicitly not established rather than blank.
 */
export function failClosedPersonaArtifact(
  reason: string,
  provenance: {
    groundedInFactKeys?: string[];
    droppedPinnedFactKeys?: string[];
  } = {}
): PersonaArtifact {
  return personaArtifact({
    persona: emptyPersona(reason),
    groundedInFactKeys: provenance.groundedInFactKeys ?? [],
    droppedPinnedFactKeys: provenance.droppedPinnedFactKeys ?? [],
    degradedReasons: [reason],
  });
}

const NOTHING_ESTABLISHED =
  "the generator returned an answer, but not one attribute in it carried evidence, so nothing was stored";

function evictedPinnedFactsReason(keys: string[]): string {
  return `the persona was generated without ${keys.join(", ")} — facts a blocking phase-3 criterion names, which did not fit the token budget. Raise PERSONA_FACT_BUDGET_TOKENS`;
}

/**
 * Runs one persona generation. NEVER throws and NEVER rejects.
 *
 * Fail-closed at every step, in the same order as evaluateGate:
 *  1. Refuse before spending a token if the fact store cannot ground a persona.
 *  2. A thrown call ⇒ the fail-closed persona, not a retry with a looser prompt.
 *  3. An unparseable response ⇒ the fail-closed persona, not a partial read.
 *  4. A parsed response ⇒ pure normalisation, which discards every unsourced
 *     claim in it.
 *
 * There is no branch anywhere in this function that produces a persona with a
 * value the model did not source. That is the entire contract.
 */
export async function generatePersona(
  deps: PersonaDeps,
  input: BuildPersonaPromptInput
): Promise<PersonaArtifact> {
  const build = buildPersonaPrompt(input);
  const provenance = {
    groundedInFactKeys: build.groundedInFactKeys,
    droppedPinnedFactKeys: build.droppedPinnedFactKeys,
  };

  // 1. REFUSE. No model call at all — an ungrounded persona is not a cheaper
  //    persona, it is a different and much more dangerous artifact.
  const [refusal] = build.refusals;
  if (refusal) {
    deps.onError?.(new Error(refusal), "refused-no-grounding");
    return failClosedPersonaArtifact(refusal, provenance);
  }

  if (build.droppedPinnedFactKeys.length > 0) {
    // Not fatal — the persona is still generated — but it is a defect in the
    // budget, not in the founder's evidence, and it must not be silent.
    deps.onError?.(
      new Error(evictedPinnedFactsReason(build.droppedPinnedFactKeys)),
      "pinned-fact-evicted"
    );
  }

  let raw: unknown;
  try {
    raw = await deps.generate(build.request);
  } catch (error) {
    deps.onError?.(error, "generator-call-failed");
    return failClosedPersonaArtifact(
      `the persona generator call failed (${error instanceof Error ? error.message : String(error)})`,
      provenance
    );
  }

  const parsed = PersonaDraftSchema.safeParse(raw);
  if (!parsed.success) {
    deps.onError?.(parsed.error, "generator-schema-mismatch");
    return failClosedPersonaArtifact(
      "the persona generator returned a response that did not match the expected shape",
      provenance
    );
  }

  const persona = normalizePersona(parsed.data);
  const established = personaAttributeEntries(persona).filter(
    (e) => e.attribute.status !== "not-established"
  );

  const degradedReasons: string[] = [];
  if (established.length === 0) {
    deps.onError?.(new Error(NOTHING_ESTABLISHED), "nothing-established");
    degradedReasons.push(NOTHING_ESTABLISHED);
  }
  if (build.droppedPinnedFactKeys.length > 0) {
    degradedReasons.push(evictedPinnedFactsReason(build.droppedPinnedFactKeys));
  }

  return personaArtifact({ persona, ...provenance, degradedReasons });
}
