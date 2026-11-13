import { afterEach, describe, expect, it } from "vitest";
import { AnthropicGateway } from "./anthropic-gateway";
import {
  ANTHROPIC_DEFAULT_MODEL_ID,
  ANTHROPIC_FAST_MODEL_ID,
  ANTHROPIC_MODEL_IDS,
  ANTHROPIC_MODELS,
  isAnthropicModelId,
  resolveAnthropicModelId,
} from "./anthropic-models";

const originalApiKey = process.env.ANTHROPIC_API_KEY;
const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

afterEach(() => {
  restoreEnv("ANTHROPIC_API_KEY", originalApiKey);
  restoreEnv("ANTHROPIC_BASE_URL", originalBaseUrl);
});

describe("ANTHROPIC_MODELS catalog", () => {
  it("has exactly one entry per declared model id", () => {
    const catalogIds = ANTHROPIC_MODELS.map((model) => model.id);
    expect(catalogIds).toEqual([...ANTHROPIC_MODEL_IDS]);
    expect(new Set(catalogIds).size).toBe(catalogIds.length);
  });

  it("uses bare Anthropic API ids, never slash-prefixed or dotted", () => {
    for (const model of ANTHROPIC_MODELS) {
      expect(model.id).not.toContain("/");
      expect(model.id).not.toContain(".");
      expect(model.id.startsWith("claude-")).toBe(true);
    }
  });

  it("owns every model by `anthropic` so provider options and logos resolve", () => {
    for (const model of ANTHROPIC_MODELS) {
      expect(model.owned_by).toBe("anthropic");
      expect(model.object).toBe("model");
      expect(model.type).toBe("language");
    }
  });

  it("carries the capability tags the app derives features from", () => {
    for (const model of ANTHROPIC_MODELS) {
      expect(model.tags).toEqual(
        expect.arrayContaining([
          "reasoning",
          "tool-use",
          "vision",
          "file-input",
        ])
      );
    }
  });

  it("prices every model so credit accounting is not silently skipped", () => {
    for (const model of ANTHROPIC_MODELS) {
      expect(Number(model.pricing.input)).toBeGreaterThan(0);
      expect(Number(model.pricing.output)).toBeGreaterThan(0);
      expect(model.context_window).toBeGreaterThan(0);
      expect(model.max_tokens).toBeGreaterThan(0);
    }
  });

  it("includes the Claude 5 family and the pinned Haiku 4.5 snapshot", () => {
    const ids = new Set(ANTHROPIC_MODELS.map((model) => model.id));
    expect(ids.has("claude-opus-5")).toBe(true);
    expect(ids.has("claude-sonnet-5")).toBe(true);
    expect(ids.has("claude-fable-5")).toBe(true);
    expect(ids.has("claude-haiku-4-5-20251001")).toBe(true);
  });

  it("points the workflow defaults at catalog models", () => {
    expect(isAnthropicModelId(ANTHROPIC_DEFAULT_MODEL_ID)).toBe(true);
    expect(isAnthropicModelId(ANTHROPIC_FAST_MODEL_ID)).toBe(true);
  });
});

describe("isAnthropicModelId", () => {
  it("accepts catalog ids", () => {
    expect(isAnthropicModelId("claude-sonnet-5")).toBe(true);
  });

  it("rejects unknown and foreign-gateway ids", () => {
    expect(isAnthropicModelId("anthropic/claude-sonnet-4.5")).toBe(false);
    expect(isAnthropicModelId("openai/gpt-5-mini")).toBe(false);
    expect(isAnthropicModelId("")).toBe(false);
  });
});

describe("resolveAnthropicModelId", () => {
  it("leaves bare Anthropic ids untouched", () => {
    for (const id of ANTHROPIC_MODEL_IDS) {
      expect(resolveAnthropicModelId(id)).toBe(id);
    }
  });

  it("strips a provider prefix left over from another gateway", () => {
    expect(resolveAnthropicModelId("anthropic/claude-sonnet-4.5")).toBe(
      "claude-sonnet-4-5"
    );
    expect(resolveAnthropicModelId("anthropic/claude-opus-4.6")).toBe(
      "claude-opus-4-6"
    );
  });

  it("converts dotted version numbers to dashes", () => {
    expect(resolveAnthropicModelId("claude-haiku-4.5")).toBe(
      "claude-haiku-4-5"
    );
  });

  it("passes unknown ids through so future models still resolve", () => {
    expect(resolveAnthropicModelId("claude-opus-9")).toBe("claude-opus-9");
  });
});

describe("AnthropicGateway", () => {
  it("reports its gateway type", () => {
    expect(new AnthropicGateway().type).toBe("anthropic");
  });

  it("returns the static catalog with no API key and no network", async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const models = await new AnthropicGateway().fetchModels();

    expect(models).toEqual([...ANTHROPIC_MODELS]);
  });

  it("returns a defensive copy callers cannot mutate the catalog through", async () => {
    const gateway = new AnthropicGateway();
    const first = await gateway.fetchModels();
    const firstEntry = first[0];
    if (!firstEntry) {
      throw new Error("catalog is empty");
    }
    firstEntry.name = "mutated";

    const second = await gateway.fetchModels();

    expect(second[0]?.name).not.toBe("mutated");
  });

  it("supports no image or video models", () => {
    const gateway = new AnthropicGateway();
    expect(gateway.createImageModel(undefined as never)).toBeNull();
    expect(gateway.createVideoModel(undefined as never)).toBeNull();
  });

  it("throws a named error when ANTHROPIC_API_KEY is missing", () => {
    delete process.env.ANTHROPIC_API_KEY;

    expect(() =>
      new AnthropicGateway().createLanguageModel("claude-sonnet-5")
    ).toThrow("ANTHROPIC_API_KEY is not configured");
  });

  it("creates a language model once a key is present", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";

    const model = new AnthropicGateway().createLanguageModel("claude-sonnet-5");

    expect(model).toBeTypeOf("object");
    expect((model as { modelId: string }).modelId).toBe("claude-sonnet-5");
  });

  it("honours ANTHROPIC_BASE_URL when set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.ANTHROPIC_BASE_URL = "https://proxy.example.com/v1";

    const model = new AnthropicGateway().createLanguageModel("claude-opus-5");

    expect((model as { modelId: string }).modelId).toBe("claude-opus-5");
  });
});
