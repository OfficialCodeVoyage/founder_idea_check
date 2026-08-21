import { describe, expect, it } from "vitest";
import { resolveChatSeedModel, resolveOpeningModelId } from "./chat-seed-model";
import type { ChatMessage, SelectedModelValue } from "./types";

const KNOWN = new Set(["gpt-5.2", "gpt-5.6-terra", "claude-x"]);
const isKnownModel = (id: string) => KNOWN.has(id);

/**
 * `selectedModel` is deliberately typed `unknown` here. Every value this
 * function has to survive — `""`, a retired model id, a counts object holding
 * one — is a value the TYPE says cannot occur and the DATABASE produces anyway:
 * queries.ts writes `"" as ChatMessage["metadata"]["selectedModel"]` for a
 * column it cannot parse, and a model can be removed from the catalogue after a
 * chat has used it. Casting at the fixture boundary is what lets the test feed
 * the real thing.
 */
function message(
  role: ChatMessage["role"],
  selectedModel: unknown
): ChatMessage {
  return {
    id: `${role}-${String(selectedModel)}`,
    metadata: {
      activeStreamId: null,
      createdAt: new Date("2026-08-21T00:00:00Z"),
      parentMessageId: null,
      selectedModel: selectedModel as SelectedModelValue,
    },
    parts: [],
    role,
  } as ChatMessage;
}

function resolve(messages: ChatMessage[]) {
  return resolveChatSeedModel({ isKnownModel, messages });
}

describe("resolveChatSeedModel", () => {
  it("seeds from the newest USER message, not the newest message", () => {
    // The user row carries the composer's full selection; the assistant row
    // carries only the model that answered.
    expect(
      resolve([
        message("user", "gpt-5.6-terra"),
        message("assistant", "gpt-5.2"),
      ])
    ).toEqual({ modelId: "gpt-5.6-terra", selection: "gpt-5.6-terra" });
  });

  it("does not narrow a parallel selection to one model", () => {
    const counts = { "claude-x": 2, "gpt-5.2": 1 } as SelectedModelValue;
    const seed = resolve([message("user", counts)]);

    expect(seed?.selection).toEqual(counts);
    // `getPrimarySelectedModelId` takes the FIRST entry with a positive count,
    // i.e. insertion order — not alphabetical, and not the highest count.
    expect(seed?.modelId).toBe("claude-x");
    // Identity preserved when nothing was dropped, so ChatSystem's shallow memo
    // does not see a new object on every render.
    expect(seed?.selection).toBe(counts);
  });

  it("rejects the empty string queries.ts writes for an unreadable column", () => {
    // `"" as AppModelId` is typed as a model id and is not one.
    expect(resolve([message("user", "")])).toBeNull();
  });

  it("rejects a model the catalogue does not know", () => {
    expect(resolve([message("user", "gpt-4o-retired")])).toBeNull();
  });

  it("keeps only the known ids in a counts object", () => {
    const seed = resolve([
      message("user", { "gpt-4o-retired": 1, "gpt-5.2": 2 }),
    ]);

    expect(seed).toEqual({
      modelId: "gpt-5.2",
      selection: { "gpt-5.2": 2 },
    });
  });

  it("returns null when no id in a counts object survives", () => {
    expect(resolve([message("user", { "gpt-4o-retired": 1 })])).toBeNull();
  });

  it("falls back to any role when no user row carries a readable model", () => {
    expect(
      resolve([message("user", ""), message("assistant", "claude-x")])
    ).toEqual({ modelId: "claude-x", selection: "claude-x" });
  });

  it("returns null for an empty thread, so a NEW chat honours the default", () => {
    expect(resolve([])).toBeNull();
  });

  it("skips an unreadable newer user row for a readable older one", () => {
    expect(
      resolve([message("user", "gpt-5.2"), message("user", null)])
    ).toEqual({ modelId: "gpt-5.2", selection: "gpt-5.2" });
  });
});

describe("resolveOpeningModelId — which model a chat opens in", () => {
  const known = (id: string) =>
    ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5-nano"].includes(id);

  it("opens a NEW project chat in the configured interviewer", () => {
    // The point of T10e: the same eight-phase interview should not be conducted
    // by whatever model a founder last picked in an unrelated chat.
    expect(
      resolveOpeningModelId({
        isKnownModel: known,
        projectInterviewerModelId: "gpt-5.6-terra",
      })
    ).toBe("gpt-5.6-terra");
  });

  it("leaves a plain chat alone so the global default still applies", () => {
    expect(resolveOpeningModelId({ isKnownModel: known })).toBeUndefined();
  });

  it("lets the founder's own choice WIN over the configured interviewer", () => {
    // This is what keeps it a default rather than a pin. A model the founder
    // picked mid-chat is written to the user row and comes back as the seed.
    expect(
      resolveOpeningModelId({
        isKnownModel: known,
        projectInterviewerModelId: "gpt-5.6-terra",
        seedModelId: "gpt-5.6-luna",
      })
    ).toBe("gpt-5.6-luna");
  });

  it("lets an explicit deep link outrank everything", () => {
    expect(
      resolveOpeningModelId({
        deepLinkModelId: "gpt-5-nano",
        isKnownModel: known,
        projectInterviewerModelId: "gpt-5.6-terra",
        seedModelId: "gpt-5.6-luna",
      })
    ).toBe("gpt-5-nano");
  });

  it("falls through when the configured interviewer is not a servable model", () => {
    // A config naming a model this gateway does not serve must not seed the
    // composer with something unselectable — better the global default than a
    // picker showing a model that cannot answer.
    expect(
      resolveOpeningModelId({
        isKnownModel: known,
        projectInterviewerModelId: "gpt-5.2-chat-latest",
      })
    ).toBeUndefined();
  });
});
