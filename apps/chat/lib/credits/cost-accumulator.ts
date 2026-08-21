import type { AppModelDefinition, AppModelId } from "../ai/app-models";
import { getAppModelDefinition } from "../ai/app-models";
import { lookupPrices } from "../ai/model-capabilities";

/** Minimal usage info needed for cost calculation */
export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Calculate LLM cost in CENTS from AI SDK usage data and model pricing.
 * Pricing is per-token in dollars (e.g., "0.00000006" = $0.06 per million tokens).
 */
function calculateLLMCost(
  usage: UsageInfo,
  pricing: { input: string; output: string }
): number {
  const inputCost = (usage.inputTokens ?? 0) * Number.parseFloat(pricing.input);
  const outputCost =
    (usage.outputTokens ?? 0) * Number.parseFloat(pricing.output);
  return (inputCost + outputCost) * 100;
}

/** One entry that could not be turned into cents, and why. */
export interface UnpricedEntry {
  modelId: AppModelId;
  reason: string;
  source: string;
}

export interface CostSettlement {
  /** Cents to deduct. Counts only the entries that could actually be priced. */
  cents: number;
  /**
   * Entries that could not be priced. NEVER silently dropped: an empty array
   * means everything was priced, and a non-empty one means `cents` is an
   * undercount whose size is stated here.
   */
  unpriced: UnpricedEntry[];
}

interface LLMCostEntry {
  modelId: AppModelId;
  source: string;
  type: "llm";
  usage: UsageInfo;
}

/**
 * Price one entry, preferring what the gateway reported and falling back to the
 * static table.
 *
 * The gateway is tried first so a provider that DOES report prices stays
 * authoritative; the table exists because OpenAI's `/v1/models` reports none.
 * If neither has a price, this returns a reason rather than a zero.
 */
function priceFor(
  entry: LLMCostEntry,
  model: AppModelDefinition | null | undefined
): { known: true; value: number } | { known: false; reason: string } {
  if (model?.pricing?.input && model?.pricing?.output) {
    return {
      known: true,
      value: calculateLLMCost(entry.usage, {
        input: model.pricing.input,
        output: model.pricing.output,
      }),
    };
  }

  const table = lookupPrices(entry.modelId);
  if (!table.known) {
    return { known: false, reason: table.reason };
  }
  if (table.value.output === null) {
    return {
      known: false,
      reason: `Model "${entry.modelId}" publishes no output price (it produces no output tokens), so a chat completion charged against it cannot be priced.`,
    };
  }
  return {
    known: true,
    value:
      (((entry.usage.inputTokens ?? 0) * table.value.input +
        (entry.usage.outputTokens ?? 0) * table.value.output) /
        1_000_000) /* USD per 1M tokens */ *
      100 /* dollars to cents */,
  };
}

interface APICostEntry {
  apiName: string;
  cost: number;
  type: "api";
}

type CostEntry = LLMCostEntry | APICostEntry;

/**
 * Accumulates costs from multiple LLM and external API calls.
 * Pass through call chain, collect at request end.
 */
export class CostAccumulator {
  private readonly entries: CostEntry[] = [];

  /** Add LLM cost from generateText/streamText usage */
  addLLMCost(modelId: AppModelId, usage: UsageInfo, source: string): void {
    this.entries.push({ type: "llm", modelId, usage, source });
  }

  /** Add fixed external API cost (in cents) */
  addAPICost(apiName: string, cost: number): void {
    if (cost > 0) {
      this.entries.push({ type: "api", apiName, cost });
    }
  }

  /**
   * Settle every recorded entry into cents, and NAME whatever could not be
   * priced.
   *
   * This replaced `getTotalCost(): Promise<number>`, and the reason is the
   * whole point of the change. The old version hit
   * `if (!(model?.pricing?.input && model?.pricing?.output)) continue;` and
   * silently dropped the entry. Because the OpenAI gateway reported `pricing:
   * {}` for every model, that branch was taken on EVERY call: the accumulator
   * always returned 0, `deductCredits(userId, 0)` always ran, and the 402 path
   * could never fire. Verified in the dev database — `UserCredit.credits` for
   * dev-local-user had not moved through 23 recorded turns.
   *
   * A bare number cannot express "I could not price this", so the caller could
   * not have noticed. This shape can, and it forces the caller to look.
   */
  async settle(): Promise<CostSettlement> {
    let total = 0;
    const unpriced: UnpricedEntry[] = [];

    const llmEntries = this.entries.filter(
      (entry): entry is LLMCostEntry => entry.type === "llm"
    );
    const apiEntries = this.entries.filter(
      (entry): entry is APICostEntry => entry.type === "api"
    );

    // Sum API costs directly
    for (const entry of apiEntries) {
      total += entry.cost;
    }

    if (llmEntries.length === 0) {
      return { cents: Math.ceil(total), unpriced };
    }

    // Batch model definition lookups (dedupe by modelId)
    const uniqueModelIds = [...new Set(llmEntries.map((e) => e.modelId))];
    const modelDefinitions = await Promise.all(
      uniqueModelIds.map((id) => getAppModelDefinition(id).catch(() => null))
    );
    const modelById = new Map<AppModelId, AppModelDefinition | null>(
      uniqueModelIds.map((id, i) => [id, modelDefinitions[i]])
    );

    // Sum LLM costs (unrounded) then ceil at the end
    for (const entry of llmEntries) {
      const priced = priceFor(entry, modelById.get(entry.modelId));
      if (priced.known) {
        total += priced.value;
      } else {
        // NOT `continue`. An entry we cannot price is a fact the caller has to
        // be told, because the alternative is billing zero and calling it a
        // total.
        unpriced.push({
          modelId: entry.modelId,
          source: entry.source,
          reason: priced.reason,
        });
      }
    }

    return { cents: Math.ceil(total), unpriced };
  }

  /** Get breakdown of all cost entries */
  getEntries(): CostEntry[] {
    return [...this.entries];
  }

  /** Check if any costs have been recorded */
  hasEntries(): boolean {
    return this.entries.length > 0;
  }
}
