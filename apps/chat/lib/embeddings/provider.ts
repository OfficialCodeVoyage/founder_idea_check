import { createOpenAI } from "@ai-sdk/openai";
import { type EmbeddingModel, embedMany } from "ai";
import {
  assertIndexableDimensions,
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_DIMENSION_MISMATCH,
  EMBEDDING_DIMENSIONS,
} from "./text";

// Not re-exported: import the pure helpers from "./text" directly. A barrel
// here would pull the AI SDK into every pure module that only wants cosine.

export type EmbeddingVector = number[];

export type EmbeddingResult = {
  /** One vector per input text, in input order. */
  vectors: EmbeddingVector[];
  /** The model that produced them. Stored per row so a mismatch is visible. */
  model: string;
  dimensions: number;
  /** Tokens billed by the provider, or null if it did not report them. */
  tokens: number | null;
};

export interface EmbeddingProvider {
  readonly dimensions: number;
  /** Order-preserving. Rejects rather than returning a short array. */
  embed(texts: string[]): Promise<EmbeddingResult>;
  readonly model: string;
}

/**
 * THE EMBEDDING SEAM.
 *
 * One interface, the same discipline as GateJudge and FactExtractor: the
 * caller is handed a provider and never learns which one it got. Swapping
 * OpenAI for a local sentence-transformers sidecar is a constructor change and
 * nothing else — which is the whole point, because the zero-key promise this
 * project makes to self-hosters has to survive contact with retrieval.
 *
 * This file deliberately does NOT live in chat.config.ts. The config's model
 * ids are LANGUAGE-model ids, typed per gateway (`gatewayModelId<G>()`); an
 * embedding model id is a different namespace with a different provider method
 * and would have to be smuggled through as an untyped string. Defaults live
 * here as named constants instead, where the pgvector constraint that decides
 * them can be stated next to them.
 */

type OpenAIEmbeddingOptions = {
  apiKey: string;
  model?: string;
  dimensions?: number;
};

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private readonly embedder: EmbeddingModel;

  constructor({ apiKey, model, dimensions }: OpenAIEmbeddingOptions) {
    this.model = model ?? DEFAULT_EMBEDDING_MODEL;
    this.dimensions = dimensions ?? EMBEDDING_DIMENSIONS;
    assertIndexableDimensions(this.dimensions);
    this.embedder = createOpenAI({ apiKey }).textEmbeddingModel(
      this.model as never
    );
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    if (texts.length === 0) {
      return {
        vectors: [],
        model: this.model,
        dimensions: this.dimensions,
        tokens: 0,
      };
    }

    const response = await embedMany({
      model: this.embedder,
      values: texts,
      providerOptions: { openai: { dimensions: this.dimensions } },
    });

    // embedMany documents order preservation, but a short or mis-sized array
    // would map the wrong vector onto the wrong fact — a corruption that reads
    // as "retrieval is a bit off" rather than as an error. Fail loudly.
    if (response.embeddings.length !== texts.length) {
      throw new Error(
        `embedding provider returned ${response.embeddings.length} vectors for ${texts.length} inputs`
      );
    }
    for (const vector of response.embeddings) {
      if (vector.length !== this.dimensions) {
        throw new Error(
          `${EMBEDDING_DIMENSION_MISMATCH}: got ${vector.length}, expected ${this.dimensions}`
        );
      }
    }

    return {
      vectors: response.embeddings,
      model: this.model,
      dimensions: this.dimensions,
      tokens: response.usage?.tokens ?? null,
    };
  }
}

/**
 * Returns null — never throws, never a stub that pretends — when no key is
 * configured. The caller's fallback is the keyword selector, which needs no
 * key at all, so "no embeddings" degrades retrieval quality and nothing else.
 * A project must never become unretrievable because a key is absent.
 */
export function getEmbeddingProvider(): EmbeddingProvider | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }
  return new OpenAIEmbeddingProvider({ apiKey });
}
