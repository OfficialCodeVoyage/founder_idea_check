import { describe, expect, it } from "vitest";
import {
  ARCTIC_SHIFT,
  GITHUB,
  HACKERNEWS,
  WEB_KEYLESS,
} from "@/lib/signals/providers";
import type { DemandSignal, SignalFailure } from "@/lib/signals/types";
import { describeLanes } from "./lane-report";

/**
 * WHICH LANES RAN, AND WHICH REFUSED.
 *
 * The founder asked for a source-cited study, got zero citations, and had to ask
 * "why am I only seeing Y Combinator?" before anyone told them four of six lanes
 * were off. Every refusal already existed as a `SignalFailure` with a written
 * reason; none of it reached the UI.
 */

const DESCRIPTORS = [HACKERNEWS, WEB_KEYLESS, GITHUB, ARCTIC_SHIFT] as const;

function signal(sourceId: DemandSignal["sourceId"], id: string): DemandSignal {
  return {
    id,
    sourceId,
    title: "Founders keep rebuilding this by hand",
    url: `https://example.com/${id}`,
    snippet: "…",
    publishedAt: "2026-08-01",
    engagement: 10,
    relevance: 0.5,
  };
}

const GITHUB_REFUSAL: SignalFailure = {
  kind: "missing-credential",
  sourceId: "github",
  detail:
    "GitHub is enabled but GITHUB_TOKEN is not set. It will not fall back to a keyless path.",
};

const ARCTIC_REFUSAL: SignalFailure = {
  kind: "unavailable",
  sourceId: "arctic-shift",
  detail:
    "Arctic Shift cannot search all of Reddit for a phrase — its `query` parameter is documented as working only with a `subreddit` or `author`. Pass options['subreddits']; use the web-search lane to discover which subreddits to ask about.",
};

describe("describeLanes", () => {
  it("reports every descriptor, not only the ones that spoke", () => {
    const lanes = describeLanes({
      descriptors: DESCRIPTORS,
      signals: [],
      failures: [],
      attempted: true,
    });

    expect(lanes.map((lane) => lane.sourceId)).toEqual([
      "hackernews",
      "web-keyless",
      "github",
      "arctic-shift",
    ]);
  });

  it("counts what each lane returned", () => {
    const lanes = describeLanes({
      descriptors: DESCRIPTORS,
      signals: [
        signal("hackernews", "a"),
        signal("hackernews", "b"),
        signal("web-keyless", "c"),
      ],
      failures: [],
      attempted: true,
    });

    expect(lanes[0].outcome).toEqual({ kind: "returned", signals: 2 });
    expect(lanes[1].outcome).toEqual({ kind: "returned", signals: 1 });
  });

  it("tells RAN-AND-FOUND-NOTHING apart from REFUSED, and carries no count on either", () => {
    const lanes = describeLanes({
      descriptors: DESCRIPTORS,
      signals: [signal("hackernews", "a")],
      failures: [GITHUB_REFUSAL],
      attempted: true,
    });

    const webKeyless = lanes.find((lane) => lane.sourceId === "web-keyless");
    const github = lanes.find((lane) => lane.sourceId === "github");

    // Ran, genuinely nothing there. A finding, and it names itself as one.
    expect(webKeyless?.outcome).toEqual({ kind: "found-nothing" });
    // Never looked. Must not read as "nobody cares".
    expect(github?.outcome.kind).toBe("refused");
    expect(webKeyless?.outcome).not.toHaveProperty("signals");
    expect(github?.outcome).not.toHaveProperty("signals");
  });

  it("passes the refusal detail through VERBATIM, whole", () => {
    const lanes = describeLanes({
      descriptors: DESCRIPTORS,
      signals: [],
      failures: [GITHUB_REFUSAL, ARCTIC_REFUSAL],
      attempted: true,
    });

    const github = lanes.find((lane) => lane.sourceId === "github");
    const arctic = lanes.find((lane) => lane.sourceId === "arctic-shift");

    // These sentences were written for a human on purpose — one names the
    // missing credential, the other names the parameter to pass instead.
    expect(github?.outcome).toEqual({
      kind: "refused",
      failureKind: "missing-credential",
      detail: GITHUB_REFUSAL.detail,
    });
    expect(arctic?.outcome).toEqual({
      kind: "refused",
      failureKind: "unavailable",
      detail: ARCTIC_REFUSAL.detail,
    });
  });

  it("uses the human label, never the id", () => {
    const lanes = describeLanes({
      descriptors: DESCRIPTORS,
      signals: [],
      failures: [],
      attempted: true,
    });

    expect(lanes.map((lane) => lane.label)).toContain("Keyless web search");
    expect(lanes.map((lane) => lane.label)).toContain(
      "Reddit (Arctic Shift archive)"
    );
  });

  it("marks every lane NOT-ATTEMPTED when no harvest ran", () => {
    // A malformed tool call is refused before any fetch. Rendering those lanes
    // as "found nothing" would claim searches that never happened.
    const lanes = describeLanes({
      descriptors: DESCRIPTORS,
      signals: [],
      failures: [],
      attempted: false,
    });

    expect(lanes.every((lane) => lane.outcome.kind === "not-attempted")).toBe(
      true
    );
  });

  it("prefers what a lane returned over a failure it also recorded", () => {
    // Two queries, one harvest each: the lane answered one and was rate-limited
    // on the other. It demonstrably ran, so its count is the honest headline.
    const lanes = describeLanes({
      descriptors: DESCRIPTORS,
      signals: [signal("hackernews", "a")],
      failures: [
        { kind: "rate-limited", sourceId: "hackernews", detail: "429" },
      ],
      attempted: true,
    });

    expect(lanes[0].outcome).toEqual({ kind: "returned", signals: 1 });
  });
});
