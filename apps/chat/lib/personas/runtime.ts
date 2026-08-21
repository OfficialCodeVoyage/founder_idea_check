import "server-only";
import { getLanguageModel } from "@/lib/ai/providers";
import { countTextTokens } from "@/lib/ai/token-utils";
import type { ChatMessage } from "@/lib/ai/types";
import { config } from "@/lib/config";
import { getProjectFacts } from "@/lib/db/phase-queries";
import { getAllMessagesByProjectId } from "@/lib/db/queries";
import { createModuleLogger } from "@/lib/logger";
import type { StoredFact } from "@/lib/phases/context";
import { PHASE_THREE } from "@/lib/phases/definitions-discovery";
import { loadPersonaPrompt, loadPrompt } from "@/lib/phases/runtime";
import type { TranscriptTurn } from "@/lib/phases/types";
import {
  describePersonaWriteFailure,
  type PersonaPersistence,
  type PersonaVersion,
} from "./artifact";
import { failClosedPersonaArtifact, generatePersona } from "./generate";
import { createModelPersonaGenerator } from "./model-adapter";
import { createPersonaStore } from "./store";
import type { PersonaArtifact } from "./types";

/**
 * THE WIRING. Impure by design and deliberately thin: it fetches, it calls the
 * seam, it writes. Every judgement — what grounds the prompt, when to refuse,
 * what survives normalisation, which timestamp the new version gets — lives in
 * the pure files, where it is unit-tested with no key and no database.
 *
 * Mirrors lib/phases/runtime.ts, including the rule that this pass must never
 * throw into whatever called it.
 */

const log = createModuleLogger("personas:runtime");

function toTranscript(messages: ChatMessage[]): TranscriptTurn[] {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      text: m.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("\n")
        .trim(),
    }))
    .filter((t) => t.text.length > 0);
}

function toStoredFacts(
  rows: {
    key: string;
    value: string;
    confidence: number;
    updatedAt: Date;
    phaseKey: string;
  }[]
): StoredFact[] {
  return rows.map((r) => ({
    key: r.key,
    value: r.value,
    confidence: r.confidence,
    updatedAt: r.updatedAt,
    phaseKey: r.phaseKey,
  }));
}

export type RegeneratePersonaInput = {
  projectId: string;
  /**
   * The Document id whose version history this persona lives in. Reuse it to
   * add a version; pass a fresh uuid to start a new persona at v1.
   *
   * Still caller-supplied, but no longer because the schema forces it:
   * `Document.projectId` landed, and `Document_project_kind_idx` makes "the
   * persona for this project" a real query. What remains is a choice about
   * WHICH version history to append to when a project has more than one
   * persona document, which the caller knows and this function does not.
   */
  documentId: string;
  userId: string;
  /**
   * `Document.messageId` is NULLABLE in the schema — a persona is regenerated
   * from the fact store, not produced by one assistant turn. It stays required
   * HERE because every current caller regenerates in response to a message and
   * a persona with no provenance is worse than one with a redundant link.
   */
  messageId: string;
  /** Ranks the fact block against what the founder just asked for. */
  latestUserMessage?: string;
};

export type RegeneratePersonaResult = {
  artifact: PersonaArtifact;
  /**
   * WHAT HAPPENED TO THE WRITE. Replaces a nullable `version`, which collapsed
   * "deliberately not persisted because degraded" and "the write failed" into
   * one null — so a database refusal returned success with an empty
   * explanation. Callers must switch on `status`.
   */
  persistence: PersonaPersistence;
};

/**
 * Generates one persona version. NEVER throws.
 *
 * A DEGRADED ARTIFACT IS NEVER PERSISTED. If the model call fails, or the fact
 * store cannot ground a persona, the founder sees the refusal — but no version
 * is written. The version history is the record of what was ESTABLISHED, not a
 * log of when the button was pressed: persisting a failure would make "the
 * latest version" mean "the last time we tried", and one 500 would push a good
 * persona out of view of every downstream reader (the canvas, the export, the
 * next regeneration's `previous`).
 */
export async function regeneratePersona(
  input: RegeneratePersonaInput
): Promise<RegeneratePersonaResult> {
  const store = createPersonaStore();

  const [factRows, projectMessages, existing] = await Promise.all([
    getProjectFacts({ projectId: input.projectId }),
    getAllMessagesByProjectId({ projectId: input.projectId }),
    store.readLatest(input.documentId),
  ]);

  // Resolved INSIDE the guarded path on purpose: with no gateway key this
  // throws, and that has to become a visible refusal rather than a 500.
  let generate: Awaited<ReturnType<typeof buildGenerator>>;
  try {
    generate = await buildGenerator();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(
      { error, projectId: input.projectId },
      "no language model available for persona generation"
    );
    const reason = `no language model is available for persona generation (${message})`;
    return {
      artifact: failClosedPersonaArtifact(reason),
      persistence: { status: "withheld", reasons: [reason] },
    };
  }

  const artifact = await generatePersona(
    {
      generate,
      onError: (error, stage) =>
        log.error(
          { err: error, stage, projectId: input.projectId },
          "persona generation degraded"
        ),
    },
    {
      personaPrompt: loadPersonaPrompt(),
      phasePrompt: loadPrompt(PHASE_THREE.promptFile),
      facts: toStoredFacts(factRows),
      transcript: toTranscript(projectMessages),
      latestUserMessage: input.latestUserMessage,
      previous: existing?.artifact?.persona ?? null,
      countTokens: countTextTokens,
    }
  );

  // Destructured rather than length-checked so the non-empty tuple is produced
  // by narrowing instead of by an assertion.
  const [firstReason, ...otherReasons] = artifact.degradedReasons;
  if (firstReason !== undefined) {
    log.warn(
      { projectId: input.projectId, reasons: artifact.degradedReasons },
      "persona was not persisted — this version is not a finding"
    );
    return {
      artifact,
      persistence: {
        status: "withheld",
        reasons: [firstReason, ...otherReasons],
      },
    };
  }

  try {
    const version = await store.appendVersion({
      documentId: input.documentId,
      artifact,
      userId: input.userId,
      messageId: input.messageId,
      // Without this the row lands with a NULL projectId and is reachable only
      // by a documentId nobody can look up — which is the exact problem
      // Document.projectId was added to solve. The canvas reads personas by
      // project, so an unscoped write is a persona that silently never appears.
      projectId: input.projectId,
    });
    return { artifact, persistence: { status: "stored", version } };
  } catch (error) {
    // The persona was generated but could not be stored. Say so: telling the
    // caller it was saved would have them regenerate and see the old one, and
    // reporting it as "degraded" would blame the model for a database fault.
    log.error(
      { error, projectId: input.projectId, documentId: input.documentId },
      "persona version could not be written"
    );
    return {
      artifact,
      persistence: {
        status: "write-failed",
        reason: describePersonaWriteFailure(error),
      },
    };
  }
}

function buildGenerator() {
  // workflows.chat is the strong model, the same one the gate judge uses. The
  // persona IS the product's output for phase 3, so it does not get the cheap
  // model the extractor runs on.
  return getLanguageModel(config.ai.workflows.chat).then((model) =>
    createModelPersonaGenerator({ model })
  );
}

/** Reads the accumulated version history for one persona. */
export async function listPersonaVersions(
  documentId: string
): Promise<PersonaVersion[]> {
  return await createPersonaStore().listVersions(documentId);
}

/** The newest version that actually parses, or null. */
export async function readLatestPersona(
  documentId: string
): Promise<PersonaVersion | null> {
  return await createPersonaStore().readLatest(documentId);
}
