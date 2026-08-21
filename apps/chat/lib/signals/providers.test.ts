import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENABLED_SOURCE_IDS,
  parseOperatorEnabledSources,
} from "./providers";

/**
 * These mirror `load_settings` in apps/research/app/config.py. The sidecar and
 * the app read the SAME variable and must agree on what it means, or the app
 * declines to ask for a source the sidecar would have served — which is how
 * `arctic-shift` stayed dark for a whole QA session with the sidecar
 * configured to allow it.
 */
describe("parseOperatorEnabledSources", () => {
  it("falls back to the keyless defaults when the variable is unset", () => {
    const parsed = parseOperatorEnabledSources(undefined);
    expect(parsed.enabled).toEqual([...DEFAULT_ENABLED_SOURCE_IDS]);
    expect(parsed.unknown).toEqual([]);
  });

  it("treats a blank value as unset rather than as an empty list", () => {
    expect(parseOperatorEnabledSources("   ").enabled).toEqual([
      ...DEFAULT_ENABLED_SOURCE_IDS,
    ]);
  });

  it("parses a comma-separated list, trimming and dropping empty segments", () => {
    const parsed = parseOperatorEnabledSources(
      " hackernews , web-keyless ,, arctic-shift "
    );
    expect(parsed.enabled).toEqual([
      "hackernews",
      "web-keyless",
      "arctic-shift",
    ]);
    expect(parsed.unknown).toEqual([]);
  });

  it("collapses a repeated id so one request is one entry", () => {
    expect(
      parseOperatorEnabledSources("hackernews,hackernews,web-keyless").enabled
    ).toEqual(["hackernews", "web-keyless"]);
  });

  it("REPORTS an unrecognised id instead of dropping it", () => {
    const parsed = parseOperatorEnabledSources(
      "hackernews,redditt,arctic-shift"
    );
    expect(parsed.enabled).toEqual(["hackernews", "arctic-shift"]);
    expect(parsed.unknown).toEqual(["redditt"]);
  });

  it("does NOT restore the defaults when every id was a typo", () => {
    // FAIL CLOSED. A list of nothing but typos means the operator asked for
    // sources that do not exist; quietly handing back the defaults would hide
    // the typo behind a working report.
    const parsed = parseOperatorEnabledSources("hackernewz,redditt");
    expect(parsed.enabled).toEqual([]);
    expect(parsed.unknown).toEqual(["hackernewz", "redditt"]);
  });

  it("passes a gate-barred id through as a REQUEST, refusing nothing itself", () => {
    // `decideProviderGate` owns the legal bar. The parser's only job is to say
    // what the operator asked for; a parser that also refused would put the
    // same decision in two places.
    const parsed = parseOperatorEnabledSources("reddit-rss");
    expect(parsed.enabled).toEqual(["reddit-rss"]);
    expect(parsed.unknown).toEqual([]);
  });
});
