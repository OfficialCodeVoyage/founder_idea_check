import { describe, expect, it } from "vitest";
import {
  NEUTRAL_RANKING,
  orderProviders,
  rankSignals,
  rankSourcesFor,
  readAudience,
  sourceOptionsFor,
} from "./audience";
import { ALL_PROVIDERS } from "./providers";
import type { DemandSignal, SignalSourceId } from "./types";

function signal(
  sourceId: SignalSourceId,
  relevance: number,
  id = `${sourceId}-${relevance}`
): DemandSignal {
  return {
    id,
    sourceId,
    title: id,
    url: `https://example.test/${id}`,
    snippet: "",
    publishedAt: null,
    engagement: 0,
    relevance,
  };
}

/** A consumer buyer, in the words a `target_user` fact would hold. */
const PARENT_TARGET_USER =
  "The research scope is a reluctant 5-7-year-old whose parent currently enforces the bedtime routine.";

describe("readAudience", () => {
  it("reads a non-technical buyer out of the target_user fact", () => {
    const view = readAudience({
      targetUserFact: PARENT_TARGET_USER,
      conversation: [],
    });
    expect(view.known).toBe(true);
    if (view.known) {
      expect(view.audience).toBe("non-technical");
      expect(view.evidence).toContain("parent");
    }
  });

  it("reads the two other buyers the live fact store holds", () => {
    const bookkeeper = readAudience({
      targetUserFact:
        "The target user is an in-house bookkeeper or controller at an independent restaurant group with 3 to 15 locations.",
      conversation: [],
    });
    const walker = readAudience({
      targetUserFact: "Independent dog walkers in Berlin are the target users.",
      conversation: [],
    });
    expect(bookkeeper.known && bookkeeper.audience).toBe("non-technical");
    expect(walker.known && walker.audience).toBe("non-technical");
  });

  it("reads a technical buyer", () => {
    const view = readAudience({
      targetUserFact:
        "Backend engineers running Kubernetes at Series-A startups are the buyer.",
      conversation: [],
    });
    expect(view.known && view.audience).toBe("technical");
  });

  it("does not read 'founder' as technical — every user of this app is one", () => {
    const view = readAudience({
      targetUserFact: "Solo founders validating their first idea.",
      conversation: [],
    });
    expect(view.known).toBe(false);
  });

  it("falls back to the conversation when no fact is reachable", () => {
    const view = readAudience({
      targetUserFact: null,
      conversation: [
        {
          role: "user",
          text: "I want to sell a bedtime-routine app to parents of 3-8 year olds.",
        },
      ],
    });
    expect(view.known && view.audience).toBe("non-technical");
  });

  it("reads only the founder's turns, never the assistant's", () => {
    const view = readAudience({
      targetUserFact: null,
      conversation: [
        { role: "user", text: "a tool for parents" },
        { role: "assistant", text: "developers on Hacker News may also care." },
      ],
    });
    expect(view.known && view.audience).toBe("non-technical");
  });

  it("refuses to guess when the founder names both audiences", () => {
    const view = readAudience({
      targetUserFact: null,
      conversation: [
        { role: "user", text: "a tool for parents" },
        { role: "user", text: "and for developers too" },
      ],
    });
    expect(view.known).toBe(false);
    if (!view.known) {
      expect(view.reason).toBe("conflicting-signals");
    }
  });

  it("does not let common words flip a technical buyer", () => {
    // Device drivers, screen readers, CS students, a child process and "pets
    // vs cattle" are infrastructure talk, not a second audience.
    const view = readAudience({
      targetUserFact: null,
      conversation: [
        {
          role: "user",
          text: "Platform engineers on Kubernetes who treat servers as pets vs cattle, write device drivers, test with screen readers, spawn a child process, and onboard CS students.",
        },
      ],
    });
    expect(view.known && view.audience).toBe("technical");
    const options = sourceOptionsFor(rankSourcesFor(view));
    expect(options?.["arctic-shift"]).toEqual({
      subreddits: ["devops", "webdev", "ExperiencedDevs", "programming"],
    });
  });

  it("carries no audience and no weight on the unknown arm", () => {
    const view = readAudience({ targetUserFact: null, conversation: [] });
    expect(view.known).toBe(false);
    // THE HOUSE IDIOM. Nothing on this arm may be read as an ordering: no
    // segment string, no audience, no weight standing at 0.
    expect(Object.keys(view).sort()).toEqual(["known", "reason"]);
  });
});

describe("rankSourcesFor", () => {
  it("puts Reddit and the general web above Hacker News for a parent buyer", () => {
    const ranking = rankSourcesFor(
      readAudience({ targetUserFact: PARENT_TARGET_USER, conversation: [] })
    );
    const order = orderProviders(ALL_PROVIDERS, ranking).map((p) => p.id);
    expect(order.indexOf("arctic-shift")).toBeLessThan(
      order.indexOf("web-keyless")
    );
    expect(order.indexOf("web-keyless")).toBeLessThan(
      order.indexOf("hackernews")
    );
    // "if at all" — HN is dead last for a buyer who does not read it.
    expect(order.at(-1)).toBe("hackernews");
  });

  it("puts Hacker News and GitHub first for a developer buyer", () => {
    const ranking = rankSourcesFor(
      readAudience({
        targetUserFact: "Platform engineers who operate Kubernetes clusters.",
        conversation: [],
      })
    );
    const order = orderProviders(ALL_PROVIDERS, ranking).map((p) => p.id);
    expect(order[0]).toBe("hackernews");
    expect(order[1]).toBe("github");
  });

  it("never zeroes a lane — deprioritised is not disabled", () => {
    for (const view of [
      readAudience({ targetUserFact: PARENT_TARGET_USER, conversation: [] }),
      readAudience({ targetUserFact: "Backend engineers.", conversation: [] }),
      readAudience({ targetUserFact: null, conversation: [] }),
    ]) {
      const ranking = rankSourcesFor(view);
      for (const provider of ALL_PROVIDERS) {
        expect(ranking.weights[provider.id]).toBeGreaterThan(0);
      }
    }
  });

  it("keeps every lane in the order, dropping none", () => {
    const ranking = rankSourcesFor(
      readAudience({ targetUserFact: PARENT_TARGET_USER, conversation: [] })
    );
    const order = orderProviders(ALL_PROVIDERS, ranking).map((p) => p.id);
    expect(order.slice().sort()).toEqual(ALL_PROVIDERS.map((p) => p.id).sort());
  });

  it("gives an unknown segment the NAMED neutral ranking, not the developer one", () => {
    const neutral = rankSourcesFor(
      readAudience({ targetUserFact: null, conversation: [] })
    );
    expect(neutral).toBe(NEUTRAL_RANKING);
    const order = orderProviders(ALL_PROVIDERS, neutral).map((p) => p.id);
    // The general web leads: it is the only lane that commits to no audience.
    expect(order[0]).toBe("web-keyless");
    // And it is NOT the accident this task exists to remove.
    expect(order[0]).not.toBe("hackernews");
    expect(neutral.weights.hackernews < neutral.weights["web-keyless"]).toBe(
      true
    );
  });
});

describe("sourceOptionsFor", () => {
  it("names the parenting subreddits the Arctic Shift lane needs", () => {
    const ranking = rankSourcesFor(
      readAudience({ targetUserFact: PARENT_TARGET_USER, conversation: [] })
    );
    const options = sourceOptionsFor(ranking);
    expect(options?.["arctic-shift"]).toEqual({
      subreddits: ["Parenting", "daddit", "Mommit", "kindergarten"],
    });
  });

  it("passes NO subreddits when the segment is unknown, so the lane refuses by name", () => {
    // Arctic Shift's own refusal names the parameter to pass. Handing it an
    // empty list instead would produce the same refusal with a worse reason.
    const options = sourceOptionsFor(NEUTRAL_RANKING);
    expect(options).toBeUndefined();
  });
});

describe("rankSignals", () => {
  it("lifts a Reddit result above a more relevant Hacker News one for a parent buyer", () => {
    const ranking = rankSourcesFor(
      readAudience({ targetUserFact: PARENT_TARGET_USER, conversation: [] })
    );
    const ranked = rankSignals(
      [signal("hackernews", 0.9), signal("arctic-shift", 0.5)],
      ranking
    );
    expect(ranked[0].sourceId).toBe("arctic-shift");
  });

  it("still lets an overwhelmingly better Hacker News result through", () => {
    // Deprioritised is not disabled: the weighting is a multiplier on the
    // sidecar's own relevance, not a filter.
    const ranking = rankSourcesFor(
      readAudience({ targetUserFact: PARENT_TARGET_USER, conversation: [] })
    );
    const ranked = rankSignals(
      [signal("arctic-shift", 0.05), signal("hackernews", 1)],
      ranking
    );
    expect(ranked[0].sourceId).toBe("hackernews");
  });

  it("drops nothing", () => {
    const ranking = rankSourcesFor(
      readAudience({ targetUserFact: PARENT_TARGET_USER, conversation: [] })
    );
    const input = [
      signal("hackernews", 0.9),
      signal("github", 0.4),
      signal("web-keyless", 0.4),
      signal("arctic-shift", 0.2),
    ];
    expect(rankSignals(input, ranking)).toHaveLength(input.length);
  });

  it("separates lanes even when every relevance is 0", () => {
    // A zero relevance is a real score, not an unknown — but it must not make
    // the audience weighting unreadable by collapsing every lane onto one tie.
    const ranking = rankSourcesFor(
      readAudience({ targetUserFact: PARENT_TARGET_USER, conversation: [] })
    );
    const ranked = rankSignals(
      [signal("hackernews", 0), signal("arctic-shift", 0)],
      ranking
    );
    expect(ranked[0].sourceId).toBe("arctic-shift");
  });

  it("is stable within a lane, preserving the sidecar's own ordering", () => {
    const ranking = rankSourcesFor(
      readAudience({ targetUserFact: PARENT_TARGET_USER, conversation: [] })
    );
    const ranked = rankSignals(
      [
        signal("arctic-shift", 0.5, "first"),
        signal("arctic-shift", 0.5, "second"),
      ],
      ranking
    );
    expect(ranked.map((s) => s.id)).toEqual(["first", "second"]);
  });
});
