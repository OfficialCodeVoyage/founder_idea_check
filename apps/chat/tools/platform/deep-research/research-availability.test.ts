import { describe, expect, it } from "vitest";
import {
  ARCTIC_SHIFT,
  GITHUB,
  HACKERNEWS,
  REDDIT_RSS,
  WEB_KEYLESS,
} from "@/lib/signals/providers";
import type { DeploymentMode } from "@/lib/signals/types";
import {
  decideResearchAvailability,
  researchUnavailableMessage,
} from "./research-availability";

/**
 * PREFLIGHT: is there any way for this deployment to research anything?
 *
 * On 2026-08-21 the founder's first message asked for a source-cited study with
 * primary sources. The model offered one, `deepResearch` ran, and zero citations
 * came back — because neither TAVILY_API_KEY nor FIRECRAWL_API_KEY was set and
 * four of six sidecar lanes were gate-refused. The founder only discovered any
 * of this by asking "why am I only seeing Y Combinator?".
 *
 * Nothing here decides anything new. `decideProviderGate` already produces a
 * named reason per source; this is the same verdict, read BEFORE the model is
 * told the tool exists rather than after the founder has been promised sources.
 */

const HOSTED: DeploymentMode = {
  hosted: true,
  availableCredentials: [],
  operatorEnabled: ["hackernews", "web-keyless", "arctic-shift"],
};

const ALL_OFF: DeploymentMode = {
  hosted: true,
  availableCredentials: [],
  operatorEnabled: [],
};

describe("decideResearchAvailability", () => {
  it("is available when a cloud key is what the config picked", () => {
    const view = decideResearchAvailability({
      searchApi: "tavily",
      mode: ALL_OFF,
      descriptors: [HACKERNEWS],
      unknownSourceIds: [],
    });

    expect(view.available).toBe(true);
  });

  it("is UNAVAILABLE with no sidecar and no cloud key", () => {
    const view = decideResearchAvailability({
      searchApi: "none",
      mode: HOSTED,
      descriptors: [HACKERNEWS],
      unknownSourceIds: [],
    });

    expect(view.available).toBe(false);
    if (!view.available) {
      // Name the knobs, not the symptom. The founder saw an AI-SDK string.
      expect(view.headline).toContain("researchSidecarUrl");
      expect(view.headline).toContain("TAVILY_API_KEY");
      expect(view.headline).toContain("FIRECRAWL_API_KEY");
    }
  });

  it("is available when the live config's two keyless lanes are permitted", () => {
    // The verified live shape: SearXNG works, hackernews works, arctic-shift is
    // enabled but refuses per request, reddit is deliberately off, github has
    // no token.
    const view = decideResearchAvailability({
      searchApi: "sidecar",
      mode: HOSTED,
      descriptors: [HACKERNEWS, WEB_KEYLESS, REDDIT_RSS, GITHUB, ARCTIC_SHIFT],
      unknownSourceIds: [],
    });

    expect(view.available).toBe(true);
    if (view.available) {
      expect(view.lanes).toContain("Hacker News");
      expect(view.lanes).toContain("Keyless web search");
      expect(view.lanes).not.toContain("GitHub");
    }
  });

  it("is UNAVAILABLE when every sidecar lane is gate-refused, and carries each reason verbatim", () => {
    const view = decideResearchAvailability({
      searchApi: "sidecar",
      mode: ALL_OFF,
      descriptors: [HACKERNEWS, REDDIT_RSS],
      unknownSourceIds: [],
    });

    expect(view.available).toBe(false);
    if (!view.available) {
      expect(view.refusals).toHaveLength(2);
      // `decideProviderGate` already wrote these sentences for a human. They are
      // passed through, never summarised.
      const reddit = view.refusals.find((r) => r.sourceId === "reddit-rss");
      expect(reddit?.detail).toContain("hosted mode");
      expect(reddit?.detail).toContain(REDDIT_RSS.gateReason);
    }
  });

  it("names a misspelled source id rather than letting it read as absence", () => {
    const view = decideResearchAvailability({
      searchApi: "sidecar",
      mode: ALL_OFF,
      descriptors: [HACKERNEWS],
      unknownSourceIds: ["hacker-news"],
    });

    expect(view.available).toBe(false);
    if (!view.available) {
      expect(view.headline).toContain("hacker-news");
    }
  });
});

describe("researchUnavailableMessage", () => {
  it("says nothing was searched, and lists every reason in full", () => {
    const view = decideResearchAvailability({
      searchApi: "sidecar",
      mode: ALL_OFF,
      descriptors: [HACKERNEWS, REDDIT_RSS],
      unknownSourceIds: [],
    });
    if (view.available) {
      throw new Error("expected an unavailable verdict");
    }

    const message = researchUnavailableMessage(view);

    // The founder must be able to tell "we could not look" from "nobody cares".
    expect(message).toContain("Nothing was searched");
    expect(message).toContain(REDDIT_RSS.gateReason);
    expect(message).toContain("Hacker News");
    // And it must not leak the SDK internal that started this.
    expect(message).not.toContain("Invalid prompt");
  });
});
