import { describe, expect, it } from "vitest";
import { HACKERNEWS, REDDIT_RSS, WEB_KEYLESS } from "./providers";
import {
  classifySidecarStatus,
  createSidecarSignalFetcher,
  normalizeFailureKind,
  parseSignalResponse,
} from "./sidecar";
import type { SignalQuery } from "./types";

const QUERY: SignalQuery = {
  query: "dog walking apps",
  limit: 10,
  from: "2026-07-01",
  to: "2026-08-01",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("normalizeFailureKind", () => {
  it("passes a known kind through", () => {
    expect(normalizeFailureKind("blocked")).toBe("blocked");
    expect(normalizeFailureKind("rate-limited")).toBe("rate-limited");
  });

  it("maps an unknown kind to schema-drift, NOT to unavailable", () => {
    // These send an operator to different actions. Collapsing them tells
    // someone to wait out a problem that waiting cannot fix.
    expect(normalizeFailureKind("teapot")).toBe("schema-drift");
  });
});

describe("classifySidecarStatus", () => {
  it("maps the sidecar's own statuses", () => {
    expect(classifySidecarStatus(429)).toBe("rate-limited");
    expect(classifySidecarStatus(401)).toBe("missing-credential");
    expect(classifySidecarStatus(403)).toBe("missing-credential");
    expect(classifySidecarStatus(422)).toBe("schema-drift");
    expect(classifySidecarStatus(500)).toBe("unavailable");
    expect(classifySidecarStatus(502)).toBe("unavailable");
  });
});

describe("parseSignalResponse", () => {
  it("maps a successful body onto DemandSignals", () => {
    const outcome = parseSignalResponse(HACKERNEWS, {
      ok: true,
      source_id: "hackernews",
      signals: [
        {
          id: "HN1",
          title: "Ask HN: how do you manage dog walkers?",
          url: "https://news.ycombinator.com/item?id=1",
          snippet: "we use a spreadsheet",
          published_at: "2026-07-20",
          engagement: 42,
          relevance: 0.8,
        },
      ],
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.signals[0].sourceId).toBe("hackernews");
      expect(outcome.signals[0].publishedAt).toBe("2026-07-20");
    }
  });

  it("carries an upstream 403 through as `blocked` — the datacenter-IP case", () => {
    const outcome = parseSignalResponse(WEB_KEYLESS, {
      ok: false,
      source_id: "web-keyless",
      kind: "blocked",
      detail:
        "every rung of the keyless ladder returned 403 or a challenge page",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe("blocked");
      expect(outcome.failure.detail).toContain("403");
    }
  });

  it("REFUSES a body attributed to a different source rather than relabelling it", () => {
    const outcome = parseSignalResponse(HACKERNEWS, {
      ok: true,
      source_id: "reddit-rss",
      signals: [],
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe("schema-drift");
      expect(outcome.failure.detail).toContain("reddit-rss");
    }
  });

  it("rejects a body that does not match the contract at all", () => {
    const outcome = parseSignalResponse(HACKERNEWS, { whatever: true });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe("schema-drift");
    }
  });

  it("carries a null published_at through rather than inventing a date", () => {
    const outcome = parseSignalResponse(REDDIT_RSS, {
      ok: true,
      source_id: "reddit-rss",
      signals: [
        {
          id: "R1",
          title: "t",
          url: "https://reddit.com/r/x/comments/1",
          snippet: "s",
          published_at: null,
          engagement: 0,
          relevance: 0.4,
        },
      ],
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.signals[0].publishedAt).toBeNull();
    }
  });
});

describe("createSidecarSignalFetcher", () => {
  it("posts to the per-source route with the query in snake_case", async () => {
    let seenUrl = "";
    let seenBody: unknown;
    const fetcher = createSidecarSignalFetcher({
      baseUrl: "http://sidecar:8099/",
      fetchImpl: (input, init) => {
        seenUrl = String(input);
        seenBody = JSON.parse(String(init?.body));
        return Promise.resolve(
          jsonResponse({ ok: true, source_id: "hackernews", signals: [] })
        );
      },
    });

    await fetcher(HACKERNEWS)(QUERY);

    expect(seenUrl).toBe("http://sidecar:8099/v1/signals/hackernews");
    expect(seenBody).toEqual({
      query: "dog walking apps",
      limit: 10,
      date_from: "2026-07-01",
      date_to: "2026-08-01",
    });
  });

  it("returns unavailable rather than throwing when the sidecar is down", async () => {
    const fetcher = createSidecarSignalFetcher({
      baseUrl: "http://sidecar:8099",
      fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
    });

    const outcome = await fetcher(HACKERNEWS)(QUERY);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe("unavailable");
      expect(outcome.failure.detail).toContain("ECONNREFUSED");
    }
  });

  it("classifies a sidecar HTTP error without throwing", async () => {
    const fetcher = createSidecarSignalFetcher({
      baseUrl: "http://sidecar:8099",
      fetchImpl: () => Promise.resolve(new Response("nope", { status: 503 })),
    });

    const outcome = await fetcher(HACKERNEWS)(QUERY);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe("unavailable");
      expect(outcome.failure.detail).toContain("503");
    }
  });

  it("reports a non-JSON body as schema-drift rather than crashing", async () => {
    const fetcher = createSidecarSignalFetcher({
      baseUrl: "http://sidecar:8099",
      fetchImpl: () => Promise.resolve(new Response("<html>502</html>")),
    });

    const outcome = await fetcher(HACKERNEWS)(QUERY);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe("schema-drift");
    }
  });
});
