import { describe, expect, it } from "vitest";
import {
  decideProviderGate,
  harvestSignals,
  runSignalHarvest,
  sanitizeSignals,
  selectEnabledProviders,
} from "./provider";
import {
  ALL_PROVIDERS,
  DEFAULT_ENABLED_SOURCE_IDS,
  findProvider,
  GITHUB,
  HACKERNEWS,
  REDDIT_RSS,
  REDDIT_SHREDDIT,
  WEB_KEYLESS,
} from "./providers";
import type {
  DemandSignal,
  DeploymentMode,
  SignalFetchOutcome,
  SignalSourceId,
} from "./types";

function mode(overrides: Partial<DeploymentMode> = {}): DeploymentMode {
  return {
    hosted: false,
    availableCredentials: [],
    operatorEnabled: [...DEFAULT_ENABLED_SOURCE_IDS],
    ...overrides,
  };
}

function signal(
  id: string,
  url: string,
  sourceId: SignalSourceId = "hackernews"
): DemandSignal {
  return {
    id,
    sourceId,
    title: `title ${id}`,
    url,
    snippet: "s",
    publishedAt: "2026-08-01",
    engagement: 10,
    relevance: 0.5,
  };
}

describe("the default source set — this is the legal position, as code", () => {
  it("defaults to Hacker News plus keyless web search, and nothing else", () => {
    expect([...DEFAULT_ENABLED_SOURCE_IDS].sort()).toEqual([
      "hackernews",
      "web-keyless",
    ]);
  });

  it("bars BOTH Reddit lanes in hosted mode", () => {
    expect(REDDIT_RSS.enabledInHosted).toBe(false);
    expect(REDDIT_SHREDDIT.enabledInHosted).toBe(false);
  });

  it("permits Reddit in self-host, where the operator is their own data subject", () => {
    expect(REDDIT_RSS.enabledInSelfHost).toBe(true);
  });

  it("keeps the two default sources keyless", () => {
    expect(HACKERNEWS.requiredCredentials).toEqual([]);
    expect(WEB_KEYLESS.requiredCredentials).toEqual([]);
  });

  it("states the actual legal reasoning on the Reddit gate, not boilerplate", () => {
    for (const descriptor of [REDDIT_RSS, REDDIT_SHREDDIT]) {
      expect(descriptor.gateReason).toContain("403");
      expect(descriptor.gateReason).toContain("access control");
      expect(descriptor.gateReason).toContain("GDPR");
      expect(descriptor.gateReason).toContain("erasure");
    }
  });

  it("gives every source a non-empty gate reason", () => {
    for (const descriptor of ALL_PROVIDERS) {
      expect(descriptor.gateReason.length).toBeGreaterThan(40);
    }
  });

  it("returns null for an unknown id rather than a default", () => {
    // NOT "arctic-shift" — that is a real provider id now, and an unknown-id
    // test that names a known id proves the opposite of what it claims.
    expect(findProvider("no-such-source")).toBeNull();
    expect(findProvider("hackernews")).toBe(HACKERNEWS);
  });
});

describe("decideProviderGate", () => {
  it("allows a keyless default source in either mode", () => {
    expect(decideProviderGate(HACKERNEWS, mode()).allowed).toBe(true);
    expect(decideProviderGate(HACKERNEWS, mode({ hosted: true })).allowed).toBe(
      true
    );
  });

  it("REFUSES Reddit in hosted mode even when the operator turned it on", () => {
    const outcome = decideProviderGate(
      REDDIT_RSS,
      mode({
        hosted: true,
        operatorEnabled: ["reddit-rss"],
        availableCredentials: ["REDDIT_ENABLED_ACK"],
      })
    );
    expect(outcome.allowed).toBe(false);
    expect(outcome).toMatchObject({ kind: "disabled" });
    expect(outcome.reason).toContain("off in hosted mode");
  });

  it("REFUSES a source the operator never enabled — default-off means default-off", () => {
    const outcome = decideProviderGate(REDDIT_RSS, mode());
    expect(outcome.allowed).toBe(false);
    expect(outcome.reason).toContain("not enabled");
  });

  it("REFUSES an enabled source with a missing credential instead of falling back to keyless", () => {
    const outcome = decideProviderGate(
      GITHUB,
      mode({ operatorEnabled: ["github"] })
    );
    expect(outcome.allowed).toBe(false);
    expect(outcome).toMatchObject({ kind: "missing-credential" });
    expect(outcome.reason).toContain("GITHUB_TOKEN");
    expect(outcome.reason).toContain("will not fall back");
  });

  it("allows Reddit in self-host once BOTH the toggle and the credential are set", () => {
    const outcome = decideProviderGate(
      REDDIT_RSS,
      mode({
        operatorEnabled: ["reddit-rss"],
        availableCredentials: ["REDDIT_ENABLED_ACK"],
      })
    );
    expect(outcome.allowed).toBe(true);
  });

  it("checks the legal bar BEFORE the operator toggle, so the toggle can never override it", () => {
    // Both would refuse, but the REASON has to be the legal one — that is the
    // text the operator reads, and "not enabled" would invite them to enable it.
    const outcome = decideProviderGate(
      REDDIT_RSS,
      mode({ hosted: true, operatorEnabled: [] })
    );
    expect(outcome.reason).toContain("off in hosted mode");
  });
});

describe("selectEnabledProviders", () => {
  it("runs only the two defaults on a fresh hosted deployment", () => {
    const selection = selectEnabledProviders(
      ALL_PROVIDERS,
      mode({ hosted: true })
    );
    expect(selection.enabled.map((d) => d.id).sort()).toEqual([
      "hackernews",
      "web-keyless",
    ]);
    // github, reddit-rss, reddit-shreddit, arctic-shift. Arctic Shift is
    // PERMITTED in hosted mode but is still not a default: it cannot keyword
    // search across Reddit and needs subreddits chosen for it, so it is a lane
    // an operator opts into deliberately.
    expect(selection.refused).toHaveLength(4);
    expect(selection.refused.map((r) => r.descriptor.id).sort()).toEqual([
      "arctic-shift",
      "github",
      "reddit-rss",
      "reddit-shreddit",
    ]);
  });

  it("gives every refusal a reason the UI can display", () => {
    const selection = selectEnabledProviders(
      ALL_PROVIDERS,
      mode({ hosted: true })
    );
    for (const { outcome } of selection.refused) {
      expect(outcome.allowed).toBe(false);
      expect(outcome.reason.length).toBeGreaterThan(10);
    }
  });
});

describe("sanitizeSignals", () => {
  it("drops a signal with no permalink — the gate cannot verify an uncitable claim", () => {
    expect(sanitizeSignals([signal("a", "  ")])).toEqual([]);
  });

  it("drops a non-http url", () => {
    expect(sanitizeSignals([signal("a", "javascript:alert(1)")])).toEqual([]);
    expect(sanitizeSignals([signal("a", "file:///etc/passwd")])).toEqual([]);
  });

  it("dedupes by url across sources", () => {
    const kept = sanitizeSignals([
      signal("a", "https://x.test/1", "hackernews"),
      signal("b", "https://X.test/1", "web-keyless"),
    ]);
    expect(kept).toHaveLength(1);
  });
});

describe("harvestSignals", () => {
  it("marks a run inconclusive when everything was blocked", () => {
    const harvest = harvestSignals([
      {
        ok: false,
        failure: {
          kind: "blocked",
          sourceId: "web-keyless",
          detail: "403 from a datacenter IP",
        },
      },
    ]);
    expect(harvest.inconclusive).toBe(true);
  });

  it("does NOT mark a run inconclusive when the sources worked and found nothing", () => {
    const harvest = harvestSignals([
      { ok: true, sourceId: "hackernews", signals: [] },
    ]);
    expect(harvest.inconclusive).toBe(false);
    expect(harvest.signals).toEqual([]);
  });

  it("does not mark a run inconclusive on a disabled source alone", () => {
    // A disabled source is a deliberate choice, not a failure to look.
    const harvest = harvestSignals(
      [],
      [{ kind: "disabled", sourceId: "reddit-rss", detail: "off in hosted" }]
    );
    expect(harvest.inconclusive).toBe(false);
  });

  it("keeps gate refusals in the failure list so a thin report is explicable", () => {
    const harvest = harvestSignals(
      [
        {
          ok: true,
          sourceId: "hackernews",
          signals: [signal("a", "https://x.test/1")],
        },
      ],
      [{ kind: "disabled", sourceId: "reddit-rss", detail: "off in hosted" }]
    );
    expect(harvest.failures).toHaveLength(1);
    expect(harvest.sourcesWithSignals).toEqual(["hackernews"]);
  });
});

describe("runSignalHarvest", () => {
  it("never calls a source the gate refused", async () => {
    const called: string[] = [];
    await runSignalHarvest(
      {
        fetcherFor: (descriptor) => () => {
          called.push(descriptor.id);
          return Promise.resolve<SignalFetchOutcome>({
            ok: true,
            sourceId: descriptor.id,
            signals: [],
          });
        },
      },
      {
        descriptors: ALL_PROVIDERS,
        mode: mode({
          hosted: true,
          operatorEnabled: ["reddit-rss", "hackernews"],
        }),
        query: { query: "q", limit: 10, from: "2026-07-01", to: "2026-08-01" },
      }
    );
    expect(called).toEqual(["hackernews"]);
  });

  it("turns a throwing provider into an unavailable failure instead of losing the others", async () => {
    const harvest = await runSignalHarvest(
      {
        fetcherFor: (descriptor) => () => {
          if (descriptor.id === "web-keyless") {
            throw new Error("socket hang up");
          }
          return Promise.resolve<SignalFetchOutcome>({
            ok: true,
            sourceId: descriptor.id,
            signals: [signal("a", "https://x.test/1", descriptor.id)],
          });
        },
      },
      {
        descriptors: ALL_PROVIDERS,
        mode: mode({ hosted: true }),
        query: { query: "q", limit: 10, from: "2026-07-01", to: "2026-08-01" },
      }
    );

    expect(harvest.signals).toHaveLength(1);
    const unavailable = harvest.failures.find((f) => f.kind === "unavailable");
    expect(unavailable?.detail).toContain("socket hang up");
    expect(unavailable?.detail).toContain(
      "threw instead of returning a failure"
    );
  });
});
