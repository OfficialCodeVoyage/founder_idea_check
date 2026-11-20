/** A per-token rate for prompts of `min` to `max` (inclusive) input tokens. */
export interface PricingTier {
  cost: string;
  max?: number;
  min: number;
}

export interface ModelData {
  context_window: number;
  description: string;
  id: string;
  input: {
    image: boolean;
    text: boolean;
    pdf: boolean;
    video: boolean;
    audio: boolean;
  };
  max_tokens: number;
  name: string;
  object: string;
  output: {
    image: boolean;
    text: boolean;
    audio: boolean;
    video: boolean;
  };
  owned_by: string;
  pricing: {
    input?: string;
    output?: string;
    input_cache_read?: string;
    input_cache_write?: string;
    web_search?: string;
    image?: string;
    /** Per-token rates by prompt size; see `cost-accumulator.ts::rateFor`. */
    input_tiers?: readonly PricingTier[];
    output_tiers?: readonly PricingTier[];
  };
  reasoning: boolean;
  tags?: string[];
  toolCall: boolean;
  type: "language" | "embedding" | "image" | "video";
}
