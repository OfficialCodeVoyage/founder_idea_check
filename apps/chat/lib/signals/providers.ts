import type { ProviderDescriptor, SignalSourceId } from "./types";

/**
 * THE BUILT-IN SOURCE REGISTRY.
 *
 * Directory pattern taken from `miurla/morphic` `lib/tools/search/providers/`
 * (Apache-2.0) — one descriptor per source, resolved through a single index,
 * so adding a source is adding a file rather than editing a switch. What is NOT
 * taken from morphic is the gating: morphic's providers are gated on whether an
 * API key is present, which answers "can we?" and never "may we?".
 *
 * Every descriptor's `gateReason` is written for a human operator who is about
 * to flip the toggle. If the prose here reads like boilerplate, the toggle gets
 * flipped without being read, and the gate has done nothing.
 */

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT SOURCES — on everywhere, keyless, and legally boring.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hacker News via the Algolia API.
 *
 * Chosen as a default because it is the only high-signal founder-adjacent
 * corpus with a public, documented, keyless, rate-limited-but-not-hostile API
 * that its operator intends third parties to call. There is no anti-bot posture
 * to route around, so nothing here resembles the access-control theory in the
 * Reddit litigation.
 *
 * KNOWN TRAP, carried over from `mvanhorn/last30days-skill` `hackernews.py`:
 * the HN Algolia index does NOT list `points` in
 * `numericAttributesForFiltering`, so a `points>N` clause makes the API return
 * HTTP 400 and zero stories. Low-engagement filtering happens client-side in
 * the sidecar after overfetching. Do not "optimise" it back into the query.
 */
export const HACKERNEWS: ProviderDescriptor = {
  id: "hackernews",
  label: "Hacker News",
  enabledInHosted: true,
  enabledInSelfHost: true,
  requiredCredentials: [],
  gateReason:
    "Public, documented, keyless API that its operator intends third parties to call. No anti-bot posture and no personal data stored beyond a public permalink.",
};

/**
 * Keyless web search (DuckDuckGo HTML, then Startpage, then an operator-run
 * SearXNG instance).
 *
 * EXPECT 403s AND 202 CHALLENGE PAGES FROM A DATACENTER IP. Upstream
 * (`web_search_keyless.py`) documents that DuckDuckGo anomaly-blocks datacenter
 * egress with a 202 challenge page and that Startpage still serves organic
 * results there; that is why the ladder exists rather than a single endpoint.
 * The sidecar reports a blocked ladder as `blocked`, never as an empty result.
 *
 * SearXNG is AGPL-3.0. It is referenced BY URL only. It is not vendored, not
 * patched, and deliberately not present in this repo's `docker-compose.yml` —
 * AGPL attaches by packaging, not by calling, and putting it in a shipped
 * compose file would put AGPL work in our distribution artefact.
 */
export const WEB_KEYLESS: ProviderDescriptor = {
  id: "web-keyless",
  label: "Keyless web search",
  enabledInHosted: true,
  enabledInSelfHost: true,
  requiredCredentials: [],
  gateReason:
    "Reads ordinary public search result pages with no credential and no access control to route around. Falls through DuckDuckGo, Startpage and an optional operator-supplied SearXNG URL; a fully blocked ladder is reported as blocked, not as zero results.",
};

/**
 * GitHub search — issues, discussions and repository activity.
 *
 * Keyless works but is rate-limited to 60 requests/hour per IP, which one
 * research run exhausts. A token raises it to 5,000/hour, so the descriptor
 * asks for one rather than pretending the keyless path is viable at production
 * volume. Absent the token this source is refused with `missing-credential` —
 * it does NOT quietly degrade to the 60/hour path and then report an empty
 * result when it runs out.
 */
export const GITHUB: ProviderDescriptor = {
  id: "github",
  label: "GitHub",
  enabledInHosted: true,
  enabledInSelfHost: true,
  requiredCredentials: ["GITHUB_TOKEN"],
  gateReason:
    "Official REST API used with a token, within its documented rate limits. Requires GITHUB_TOKEN because the 60/hour keyless limit is exhausted by a single research run.",
};

// ─────────────────────────────────────────────────────────────────────────────
// REDDIT — OFF BY DEFAULT IN HOSTED MODE. Read the reasoning before changing.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * REDDIT: WHY IT IS OFF BY DEFAULT IN HOSTED MODE.
 *
 * Two independent reasons. Either one on its own is sufficient; together they
 * make hosting this on someone else's behalf indefensible.
 *
 * 1. ACCESS CONTROL. The keyless Reddit lanes work *because* Reddit's `.json`
 *    endpoints — and, as of the last probe, even `/robots.txt` — return HTTP
 *    403, while `/search.rss` and `/svc/shreddit/` still return 200. Reaching
 *    the content anyway by picking the endpoints that have not been closed yet
 *    is routing around an access control. That is the precise theory pleaded in
 *    "Reddit v. Perplexity / SerpApi / Oxylabs" (Oct 2025) and
 *    "Reddit v. Anthropic" (Jun 2025), both of which were unresolved when this was
 *    written. Reddit's free API tier is separately non-commercial-only, so the
 *    credentialled path does not rescue a commercial hosted deployment either.
 *
 * 2. GDPR. A demand signal is a person's post: a username plus a verbatim
 *    quote, i.e. personal data. Storing it makes the operator a data controller
 *    with (a) no lawful basis to rely on — legitimate interest does not survive
 *    a balancing test against a subject who was never told, and consent is
 *    impossible to obtain — and (b) no mechanism to honour an erasure request,
 *    because a deleted Reddit post leaves no signal that would reach our store.
 *    In self-host the operator is the data subject's counterparty and can make
 *    that call for themselves. In hosted mode the operator would be making it
 *    for strangers, on data about other strangers.
 *
 * MITIGATION ALREADY BUILT IN: `DemandSignal` in `./types.ts` has no `author`
 * field at all, and the sidecar's Reddit adapters drop the author before the
 * item leaves Python. The shape refuses to carry the identifier, so no future
 * adapter can reintroduce it by accident. Snippets are capped to an excerpt
 * rather than the full body, and the permalink is retained so a reader goes to
 * the source rather than to our copy of it.
 *
 * NOTE ON ARCTIC SHIFT: its API is fine to CALL. Its source is `license: null`
 * — all rights reserved — so not one line of it is copied anywhere in this
 * repo, and the historical torrent dumps are not ingested at all (they
 * redistribute since-deleted user content, which is the erasure problem in its
 * most concentrated form).
 *
 * TO TURN THIS ON in self-host you must do both: add the id to
 * `operatorEnabled` and set the credential. It is not one switch on purpose.
 */
const REDDIT_GATE_REASON =
  "Off by default in hosted mode. The keyless Reddit lanes work because Reddit's .json endpoints return 403 while its RSS does not, which is routing around an access control — the theory in Reddit v. Perplexity (Oct 2025) and Reddit v. Anthropic (Jun 2025), both unresolved. Separately, storing posts makes the operator a GDPR data controller with no lawful basis and no way to honour erasure. Self-host operators may enable it for their own data; a hosted operator would be making that decision for strangers.";

export const REDDIT_RSS: ProviderDescriptor = {
  id: "reddit-rss",
  label: "Reddit (RSS discovery)",
  enabledInHosted: false,
  enabledInSelfHost: true,
  requiredCredentials: ["REDDIT_ENABLED_ACK"],
  gateReason: REDDIT_GATE_REASON,
};

export const REDDIT_SHREDDIT: ProviderDescriptor = {
  id: "reddit-shreddit",
  label: "Reddit (comment enrichment)",
  enabledInHosted: false,
  enabledInSelfHost: true,
  requiredCredentials: ["REDDIT_ENABLED_ACK"],
  gateReason: REDDIT_GATE_REASON,
};

/**
 * Reddit history via the Arctic Shift archive.
 *
 * ON in hosted mode, where both keyless Reddit lanes are off, and the
 * distinction is not a loophole. The lanes above are off because they read
 * Reddit's own edge — RSS answers where `.json` returns 403, which is routing
 * around an access control, and that is the theory in the Perplexity and
 * Anthropic suits. This one calls a THIRD PARTY's documented public API that
 * its operator invites people to use, from that party's own hosting.
 *
 * The GDPR half is answered differently too, and more strongly: the request
 * carries an explicit `fields` list with no `author` in it, so the username is
 * never received rather than received and dropped.
 *
 * NOT in the defaults: the archive lags real time and cannot keyword-search
 * across all of Reddit — it needs subreddits chosen for it, so it is a lane an
 * operator opts into for a reason, not one that should quietly run everywhere.
 */
export const ARCTIC_SHIFT: ProviderDescriptor = {
  id: "arctic-shift",
  label: "Reddit (Arctic Shift archive)",
  enabledInHosted: true,
  enabledInSelfHost: true,
  requiredCredentials: [],
  gateReason:
    "Third-party public archive with a documented keyless API its operator invites third parties to call, served from that party's own hosting rather than Reddit's edge — so it neither routes around an access control nor depends on a residential IP. Queried with an explicit field list that excludes the author, so no Reddit username is ever received.",
};

// ─────────────────────────────────────────────────────────────────────────────
// THE REGISTRY.
// ─────────────────────────────────────────────────────────────────────────────

export const ALL_PROVIDERS: readonly ProviderDescriptor[] = [
  HACKERNEWS,
  WEB_KEYLESS,
  GITHUB,
  REDDIT_RSS,
  REDDIT_SHREDDIT,
  ARCTIC_SHIFT,
];

/**
 * The sources a fresh deployment runs with. Hacker News plus keyless web
 * search, exactly as the plan specifies — both keyless, both legally boring,
 * neither requiring the operator to accept somebody else's risk.
 *
 * GitHub is NOT in this list despite being permitted in both modes: it needs a
 * token, and a default that is always refused for a missing credential trains
 * operators to ignore the refusal list.
 */
export const DEFAULT_ENABLED_SOURCE_IDS: readonly SignalSourceId[] = [
  "hackernews",
  "web-keyless",
];

/** PURE. Looks a descriptor up by id. Unknown ids return null, never a default. */
export function findProvider(id: string): ProviderDescriptor | null {
  return ALL_PROVIDERS.find((p) => p.id === id) ?? null;
}

/**
 * What the operator asked for, split from what that request actually names.
 *
 * TWO ARMS BECAUSE AN UNRECOGNISED ID CARRIES NO READABLE VALUE. There is no
 * descriptor behind `redditt`, so it cannot be held as a `SignalSourceId`, and
 * folding it into `enabled` would make a typo indistinguishable from a source
 * that ran and found nothing.
 */
export type OperatorSourceRequest = {
  /** Ids naming a real descriptor. A REQUEST — `decideProviderGate` still rules. */
  enabled: readonly SignalSourceId[];
  /** Ids naming nothing. Surfaced to the operator, never quietly dropped. */
  unknown: readonly string[];
};

/**
 * PURE. Reads `RESEARCH_ENABLED_SOURCES` the way the sidecar reads it.
 *
 * This exists because the app and the sidecar were disagreeing about the same
 * variable. `apps/research/app/config.py` parsed it; the app hardcoded
 * `DEFAULT_ENABLED_SOURCE_IDS`, so a source the operator had switched on and
 * the sidecar was willing to serve was refused locally before a request was
 * ever made — a refusal with a true reason ("not enabled for this deployment")
 * and a false cause. One variable, one meaning, kept in both places.
 *
 * FAIL CLOSED, matching `load_settings`:
 *   - unset or blank -> the two keyless defaults, not "everything"
 *   - a list of nothing but typos -> NO sources, not a silent fallback to the
 *     defaults, because a working report would then hide the typo
 *   - a barred id -> passed through as a request; refusing it here would put
 *     the legal gate in two places
 */
export function parseOperatorEnabledSources(
  raw: string | undefined
): OperatorSourceRequest {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) {
    return { enabled: [...DEFAULT_ENABLED_SOURCE_IDS], unknown: [] };
  }

  const enabled: SignalSourceId[] = [];
  const unknown: string[] = [];
  for (const part of trimmed.split(",")) {
    const id = part.trim();
    if (id.length === 0) {
      continue;
    }
    const descriptor = findProvider(id);
    if (descriptor === null) {
      if (!unknown.includes(id)) {
        unknown.push(id);
      }
      continue;
    }
    if (!enabled.includes(descriptor.id)) {
      enabled.push(descriptor.id);
    }
  }
  return { enabled, unknown };
}
