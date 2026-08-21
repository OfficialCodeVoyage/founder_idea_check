import { describe, expect, it } from "vitest";
import {
  gatewayFieldsFor,
  lookupContextWindow,
  lookupModelCapabilities,
  lookupPrices,
  lookupToolTransport,
  MODEL_CAPABILITIES,
  toApiModelId,
} from "./model-capabilities";

describe("the capability table refuses to invent numbers", () => {
  it("reports a model with no entry as UNKNOWN, never as zero", () => {
    const found = lookupModelCapabilities("some-model-nobody-added");
    expect(found.known).toBe(false);
    // The whole point: there is no value to read. A caller cannot accidentally
    // treat this as a context window of 0 or a price of 0, because the unknown
    // arm carries no number at all.
    expect("value" in found).toBe(false);
    if (!found.known) {
      expect(found.reason).toContain("some-model-nobody-added");
      expect(found.reason).toContain("do not assume zero");
    }
  });

  it("reports an unknown context window as unknown, not as 0", () => {
    const window = lookupContextWindow("some-model-nobody-added");
    expect(window.known).toBe(false);
    expect("value" in window).toBe(false);
  });

  it("distinguishes 'not in the table' from 'in the table, never stated'", () => {
    // text-embedding-3-small IS covered, but its docs page states no context
    // window. That is a different fact from an unrecognised model, and the two
    // reasons must not read the same.
    const missing = lookupContextWindow("some-model-nobody-added");
    const unstated = lookupContextWindow("text-embedding-3-small");
    expect(missing.known).toBe(false);
    expect(unstated.known).toBe(false);
    if (!(missing.known || unstated.known)) {
      expect(missing.reason).toContain("No capability entry");
      expect(unstated.reason).toContain("never stated by the source");
    }
  });
});

describe("known models report their real numbers", () => {
  it("returns the real context window rather than a fallback", () => {
    const luna = lookupContextWindow("gpt-5.6-luna");
    expect(luna.known).toBe(true);
    if (luna.known) {
      expect(luna.value).toBe(1_050_000);
    }
    const mini = lookupContextWindow("gpt-4o-mini");
    if (mini.known) {
      expect(mini.value).toBe(128_000);
    }
  });

  it("prices luna at the post-2026-07-30 rates", () => {
    const prices = lookupPrices("gpt-5.6-luna");
    expect(prices.known).toBe(true);
    if (prices.known) {
      expect(prices.value).toEqual({
        input: 0.2,
        cachedInput: 0.02,
        output: 1.2,
      });
    }
  });

  it("knows which models refuse function tools on chat/completions", () => {
    const luna = lookupToolTransport("gpt-5.6-luna");
    const terra = lookupToolTransport("gpt-5.6-terra");
    const legacy = lookupToolTransport("gpt-4o-mini");
    if (luna.known && terra.known && legacy.known) {
      expect(luna.value).toBe("responses-only");
      expect(terra.value).toBe("responses-only");
      expect(legacy.value).toBe("chat-completions");
    }
  });
});

describe("reasoning variants resolve to their API model", () => {
  it("strips the -reasoning suffix before looking up", () => {
    expect(toApiModelId("gpt-5.6-luna-reasoning")).toBe("gpt-5.6-luna");
    expect(toApiModelId("gpt-5.6-luna")).toBe("gpt-5.6-luna");
  });

  it("prices a reasoning variant like the model it is", () => {
    // Without this, every reasoning variant would look unknown and go
    // unpriced — the original defect, reintroduced through a naming
    // convention rather than through a placeholder.
    const plain = lookupPrices("gpt-5.6-luna");
    const reasoning = lookupPrices("gpt-5.6-luna-reasoning");
    expect(reasoning.known).toBe(true);
    if (plain.known && reasoning.known) {
      expect(reasoning.value).toEqual(plain.value);
    }
  });
});

describe("gatewayFieldsFor", () => {
  it("converts USD-per-million into the per-token strings the gateway uses", () => {
    const fields = gatewayFieldsFor("gpt-5.6-luna");
    expect(fields).toBeDefined();
    // $0.20 per 1M = $0.0000002 per token. Getting this factor wrong by 10^6
    // would bill a thousand-token turn as if it were a billion.
    expect(Number(fields?.pricing.input)).toBeCloseTo(0.2 / 1_000_000, 15);
    expect(Number(fields?.pricing.output)).toBeCloseTo(1.2 / 1_000_000, 15);
    expect(fields?.context_window).toBe(1_050_000);
    expect(fields?.max_tokens).toBe(128_000);
  });

  it("returns undefined for an uncovered model so the gateway keeps its own values", () => {
    expect(gatewayFieldsFor("some-model-nobody-added")).toBeUndefined();
  });

  it("omits an output price the model does not publish", () => {
    // Embeddings produce no output tokens. Emitting `output: "0"` here would
    // put a real-looking zero into the pricing object, which is exactly the
    // class of value this table exists to remove.
    const fields = gatewayFieldsFor("text-embedding-3-small");
    expect(fields?.pricing.input).toBeDefined();
    expect(fields?.pricing.output).toBeUndefined();
    expect(fields?.context_window).toBeUndefined();
  });
});

describe("the table itself", () => {
  it("covers every model the app is configured to use", () => {
    // If a workflow points at a model with no entry, its calls go unpriced and
    // its context window falls back — silently, before this test existed.
    for (const modelId of [
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.2",
      "gpt-5-mini",
      "gpt-5-nano",
      "gpt-4o-mini",
      "text-embedding-3-small",
    ]) {
      expect(
        MODEL_CAPABILITIES[modelId],
        `missing entry: ${modelId}`
      ).toBeDefined();
    }
  });

  it("never carries a zero price or a zero window", () => {
    for (const [modelId, entry] of Object.entries(MODEL_CAPABILITIES)) {
      expect(entry.prices.input, modelId).toBeGreaterThan(0);
      expect(entry.contextWindow === null || entry.contextWindow > 0).toBe(
        true
      );
      expect(entry.maxOutput === null || entry.maxOutput > 0).toBe(true);
      // null is allowed and means "not published"; 0 is not, because 0 is a
      // number a caller can multiply by.
      expect(entry.prices.output).not.toBe(0);
      expect(entry.prices.cachedInput).not.toBe(0);
    }
  });
});
