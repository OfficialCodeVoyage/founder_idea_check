# Spec — Market idea finding (2026-11-12)

Status: proposed, nothing built. Code name `idea-finding`. Never "discovery": `lib/phases/definitions-discovery.ts`
already means customer discovery. Paths are under `apps/chat/` unless they say otherwise.

**Goal:** a founder who knows a market but has no idea types it ("hotels"), gets 5–10 ranked problem candidates, each
backed by verbatim public quotes with links, picks one, and starts a new project at phase 1.
**Users / trigger:** a signed-in founder with no project yet, from a "Find a problem" sidebar entry; anonymous users
never (they have no tools). **Not a phase:** `lib/phases/definitions.ts` refuses an intake phase, because a gate that
cannot refuse teaches that gates are decoration. Idea finding has no gate; the new project's gate starts from zero.

## User flow (hotels)
1. The founder types `hotels` (1–200 chars; "independent hotels" narrows it) and sees the cost and "2–5 minutes".
2. **Plan:** one model call names who works there (front-desk agent, night auditor, revenue manager), 8 pain queries
   ("night audit takes hours") and up to 10 subreddits, each checked in code before use (r/hotels: 34,771 members).
3. **Harvest → analyse → synthesise** (next section) runs as stages while a lane report fills in, lane by lane.
4. **Browse:** 5–10 ranked cards, each with statement, target user, F×I×W×P and band, thread and community counts,
   and 3–6 quotes with source, date and link (fewer cards only with a written reason). No author is fetched or shown.
5. **Pick:** creates a Project named after the statement, with facts `problem_statement` and `target_user` of origin
   `idea-finding`. Its first chat asks the founder to restate both in their own words and to plan interviews.

## Scope
**In (v1):** one market per run; Arctic Shift posts and comments; Hacker News stories and comments; semantic
relevance; clustering; synthesis with a verbatim check; scoring in code; two tables; run and pick screens; a third
fact origin; credit reserve and settle; flag `ai.tools.ideaFinding.enabled` (default false).
**Out (v1):** a phase or gate; changing `lib/signals/audience.ts::COMMUNITY_TABLE` (no row of 5 matches hotels) or
deep research's HN lane; `web-keyless` quotes (snippets from sites whose terms forbid scraping); Greenhouse and BLS
(v2); every "avoid" source; comparing markets; scheduled re-runs; quotes as gate evidence.

## How candidates are found (`lib/idea-finding/`; everything is pure except the model and sidecar calls)
- **Communities:** a proposed subreddit is kept only if Arctic Shift's lookup shows it exists, is not `over18` and has
  ≥1,000 subscribers; dropped ones are listed (the prefix "hotel" also returned NSFW and TV-fan subreddits).
- **Fetch:** per community, the newest posts and comments of the last 12 months; HN per query. It reuses
  `lib/signals/provider.ts::runSignalHarvest` and `lib/signals/sidecar.ts::createSidecarSignalFetcher`, so the
  permission gate (`decideProviderGate`; Python `sources/base.py::assert_permitted`, each `gate_reason`) and url
  grounding (`apps/research/app/pipeline/grounding.py::ground_candidates`) apply unchanged. No new source id, only
  `options`: `arctic-shift` `{kind: "posts"|"comments", recent: true}` (subreddit and window, no keyword);
  `hackernews` `{tags: "comment"}` (`story_title` as title, `matches_a_content_word` skipped, author dropped).
- **Caps (constants):** 6 communities, 100 items per community and kind, 8 queries × 2 tags × 25 HN hits; ≤1,200
  items, ≤300 classified, ≤10 themes.
- **Relevance:** `text-embedding-3-small` via `lib/embeddings/provider.ts`. An item is kept when
  `max(cosineSimilarity(item, query_i)) >= RELEVANCE_MIN` (start 0.35, set from the hotels QA run). Word overlap is
  not enough: HN comments for "hotel front desk software" gave 18 hits, and 2 of the first 10 were on topic.
- **Classify:** batches of 25. Per item: `speaker` (`works-in-market`|`customer`|`vendor`|`unclear`), `pain` (one
  sentence), `span` (verbatim) and `levels` (1–5 per rubric dimension shown, using the bands in
  `prompts/persona/problem-validation-rubric.md`). An item with no pain is dropped.
- **Cluster:** greedy leader clustering on each `pain` embedding, cosine `>= THEME_MIN` (start 0.75), largest first.
  The sidecar's `pipeline/cluster.py` is not reused: it is lexical and merges one story across sources.

## Scoring (code, never the model): `lib/idea-finding/score.ts::scoreCandidate`
```ts
// q = the candidate's verified quotes. A dimension counts only when ≥2 distinct threads show it; otherwise it is 1.
const level = (d: Dim) => { const qs = q.filter((x) => x.levels[d] !== undefined);
  return distinctThreads(qs) >= 2 ? Math.floor(median(qs.map((x) => x.levels[d]!))) : 1; };
const rubricScore = DIMS.reduce((p, d) => p * level(d), 1); // frequency·intensity·workarounds·wtp, 1..625
const band = rubricScore >= 250 ? "strong" : rubricScore >= 100 ? "promising" : "weak"; // the rubric's bands
const eligible = (c) => c.quotes.length >= 3 && c.distinctThreads >= 2 && worksInMarketQuotes(c) >= 2;
// order: rubricScore desc, distinctThreads desc, distinctCommunities desc, newest quote desc; keep 10
```
Cards call it a "public-signal score", not a validation score; the gate never reads it.

## Verbatim quotes: `lib/idea-finding/verify-quote.ts::verifyQuote`
The model cites an item id and a quote, never a url. Code requires the item to be from this run, the quote to be
20–300 chars, and `norm(item.title + "\n" + item.snippet).includes(norm(quote))` (`norm`: NFKC, straight quotes,
collapsed whitespace, case kept). A failing quote is dropped, never repaired; a candidate left with fewer than 3 is
dropped and counted in `thinReason`. Url, date and source come from the stored item (≤500 chars from the sidecar),
so every link was fetched in this run; quoted items stay on the run so the check can be replayed.

## Data model (one migration; CHECKs hand-written per `.claude/rules/db.md`)
- `IdeaFindingRun`: `id`, `userId` → User (cascade, indexed), `market` (CHECK 1–200 chars), `stage` (`planning` |
  `fetching` | `analysing` | `synthesising` | `done` | `failed`, CHECK), `failureReason` (CHECK: set ⇔ `failed`),
  `leaseUntil`, `plan` jsonb (roles, queries, checked communities), `lanes` jsonb (`describeLanes` rows from
  `tools/platform/deep-research/lane-report.ts`, plus communities), `items` jsonb (no author; pruned to quoted items
  at `done`), `thinReason`, `reservedCents`, `spentCents` (CHECK ≥ 0), timestamps.
- `ProblemCandidate`: `id`, `runId` → run (cascade, indexed), `rank` (1–10, unique per run), `problemStatement`,
  `targetUser`, `quotes` jsonb `[{itemId, sourceId, url, publishedAt, text, speaker, levels}]` (CHECK length ≥ 3),
  `frequency`/`intensity`/`workarounds`/`wtp` (CHECK 1–5), `rubricScore` (CHECK = their product), `distinctThreads`,
  `distinctCommunities`, `pickedProjectId` → Project (set null).
- Reads put the owner in the `WHERE` (join to `IdeaFindingRun.userId`, as `getAllMessagesByProjectId` does): not
  yours and missing both answer NOT_FOUND. `ProjectFact.origin` gains `idea-finding` with a new CHECK
  `ProjectFact_origin_known` (`DO` block); `ProjectFact_origin_coherent` still holds; confidence is 40.

## Keeping the new origin out of evidence (PR 1, before anything else)
The origin is a two-value union repeated in `lib/phases/types.ts::KnownFactSchema`, `lib/phases/context.ts`,
`lib/phases/runtime.ts`, `lib/db/schema.ts`, `lib/export/grounding.ts` and `components/project/fact-row.tsx`, and
`gate.ts::renderFacts` marks only `founder`: a third value would reach the judge looking extracted. Fix: one
`FACT_ORIGINS` const in `types.ts` that all of them derive from, and an exhaustive `switch` in `renderFacts`. Then:
1. `renderFacts` appends ", suggested by market idea finding from public posts; not stated by the founder; not
   evidence". It reaches the judge, the extractor and the per-turn block (`context.ts`), as Incident 5 requires.
2. `evaluateGate` leaves `idea-finding` facts out of `factCount`: a project holding only them BLOCKs `no-facts-yet`.
3. `decideGate` gains `suggestedOnlyKeys`: an `artifact-exists` criterion whose fact is `idea-finding` drops from
   `met` to `partial` (gap: "the founder's own statement of <key>"), and a blocking partial BLOCKs.
4. `extract.ts::reconcileFacts` always lets an extraction replace an `idea-finding` fact (own branch, before the
   confidence test): that is how the founder's own words take over.
5. Export: `originOf` carries it, no confidence band (the number is the system's), `FACTS.md` and the PRD mark it.
   ADR-0006 records all this (it extends ADR-0003, which is not edited), plus a `CONTEXT.md` row.

## Sources (terms and API docs re-read 2026-11-12; probes used generic queries only)
| Source | What we take | Keyless? | Terms verdict + URL | Rate limits |
|---|---|---|---|---|
| Arctic Shift (Reddit archive) | posts and comments: ≤500-char text, date, score, permalink; `fields` excludes author | yes | **Use (v1)**, API only (repo has no licence). README: "this is a free service, so be considerate". https://github.com/ArthurHeitmann/arctic_shift/blob/master/api/README.md | none fixed: "a couple requests per second" is fine; dynamic 429 with `X-RateLimit-Reset`. Ours: 1/s (`ARCTIC_SHIFT_LIMITER`) |
| Hacker News (Algolia) | stories and comments: text, date, points, permalink; no author | yes | **Use (v1)**, API only: the YC terms HN links as "Legal" forbid "data mining, robots, scraping" of the site (https://www.ycombinator.com/legal/). https://hn.algolia.com/api | 10,000 requests/hour per IP |
| Greenhouse Job Board API | job titles and descriptions of named companies | yes: "authentication is not required for any GET endpoints" | **Use, v2.** Cannot search across boards: 1 of 8 guessed hospitality-tech board tokens existed. https://docs.greenhouse.io/job-board.html | none stated |
| BLS Public Data API | an employment series for market size (CES7072110001 answered) | v1 yes; v2 free key | **Use, v2.** Cite the access date and the required "cannot vouch for the data" sentence. https://www.bls.gov/developers/termsOfService.htm | v1 25 queries/day, 25 series/query; v2 500/day |
| Stack Exchange API | Q&A text | yes (shared IP quota) | **Care, not v1.** Must show Stack Exchange as the source (CC BY-SA); little content from hotel staff. https://stackoverflow.com/legal/api-terms-of-use | >30 req/s per IP is banned; honour `backoff`; a key gives 10,000/day (https://api.stackexchange.com/docs/throttle) |
| Apple App Store review RSS | nothing | yes | **Avoid automated use** (was "care"): https://itunes.apple.com/robots.txt has `Disallow: /*/rss/*` | — |
| HotelTechReport | nothing | — | **Manual reading only**: §3.5, downloading and digital copying "are only permitted for personal non-commercial use". https://help.hoteltechreport.com/legal/terms-conditions | — |
| G2 | nothing | — | **Avoid**: §8 bars "robots, crawlers, scrapers… or other automated means" (updated 2026-11-05). https://legal.g2.com/terms-of-use | — |
| Capterra | nothing | — | **Avoid**: its terms page answers 403 to an automated client, so the text was not read. https://www.capterra.com/legal/terms-of-use/ | — |
| Google Play reviews | nothing | — | **Avoid**: no public API for other apps' reviews; Google bars "using automated means to access content" against robots.txt. https://policies.google.com/terms | — |
| Trade press (checked: Skift) | nothing | — | **Avoid**: bars tools "designed to data mine or scrape Skift content". https://skift.com/terms/ (other titles unchecked) | — |
| Private groups (Facebook, Slack, LinkedIn) | nothing | — | **Avoid**: behind a login, so reading them passes an access control (policy; no terms checked) | — |

## Cost per run (estimate, not measured: no OpenAI call was made for this spec)
Caps × prices in `lib/ai/model-capabilities.ts::MODEL_CAPABILITIES` (`gpt-5.6-luna` $0.20 in / $1.20 out per million
tokens, `gpt-5.6-terra` $2 / $12, `text-embedding-3-small` $0.02), ~130 tokens an item (500 chars), reasoning tokens
0–1× the visible output. Calls, tokens in / out per call, cents: plan 1 luna, 1.5k / 1–2k, 0.2–0.3; embed 1–2
batches, ~160k, 0.3; classify ≤12 luna, 4.1k / 1.25–2.5k, 2.8–4.6; synthesise ≤10 luna, 3k / 0.8–2k, 1.6–3.0.
**A run is about 5–9¢** (≤23 model calls plus embeddings), or about 19–35¢ with terra for synthesis. A run
reserves 10¢ with `lib/db/credits.ts::reserveCredits`, settles through `lib/credits/cost-accumulator.ts::CostAccumulator`
and returns the rest with `addCredits`. Model knob: `ai.tools.ideaFinding.model` (default luna). New accounts get 50¢.

## Interfaces touched
Routes `app/(chat)/idea-finding/` and `.../[runId]/`; `app/actions/idea-finding.ts` (`startIdeaFindingRun`,
`advanceIdeaFindingRun`, `pickProblemCandidate`); a tRPC `ideaFinding` router (list, get) on `protectedProcedure`;
the tables; sidecar `arctic_shift.py`, `hackernews.py`; `chat.config.ts`, `lib/config-schema.ts`. An advance runs
one stage (≤60 s, idempotent, under `leaseUntil`), polled by the run page: nothing relies on `after()` (CONCERNS 5).

## Risks / rollback
- **Arctic Shift is unreliable** ("No uptime or performance guarantees"): in the probes 3 of 3 keyword searches got
  422 "Timeout. Maybe slow down a bit"; 2 of 4 keyword-free fetches and 1 of 2 subreddit lookups answered. Hence the
  window fetch, the adapter's cool-downs, and a thin label on a run that finishes on HN alone.
- **Guests drown out operators:** HN "hotel" stories are mostly guest stories; `speaker` and the eligibility rule
  keep candidates on people who work in the market. **Invented quotes** fail `verifyQuote`; a real but unrepresentative
  quote can still be cited, so cards show thread counts. **Gate laundering:** origin rules 2–3 are code with tests.
- **Personal data:** public text, no author, ≤300 chars, deleted with the run; Reddit's terms still govern the content
  (the repo's position: `apps/research/app/sources/reddit_gate.py`). **Rollback:** the flag hides the screens and the
  migration only adds; the origin value stays once used, hence an ADR.

## Done when
1. `hotels` gives a `done` run with 5–10 candidates (or fewer with a `thinReason`); the lane report names every lane
   and community with its count or failure. In hosted mode with `arctic-shift` refused, it reports why and carries on.
2. Every shown quote passes `verifyQuote` (a test drops a paraphrase and a quote citing another run's item), and
   tests for `scoreCandidate` pin the formula, the bands, the two-thread rule and the order.
3. A pick creates one project with exactly the two facts (`idea-finding`, confidence 40), marked on the facts screen.
4. `lib/phases/gate.test.ts`: with only those facts, a stub judge saying all `met` still BLOCKs (`no-facts-yet`); with
   one extracted fact added, `problem-statement` is `partial`. `extract.test.ts`: an extraction replaces an
   `idea-finding` fact. `runtime.test.ts`: the marker reaches the judge and the extractor.
5. Another user's run or candidate answers NOT_FOUND; `spentCents` equals the drop in `UserCredit.credits`.
6. `bun run verify`, `bun run test:unit` and the sidecar's pytest pass.

**End-to-end:** dev services up; migration applied to `ic-pg` with `psql` (never `db:migrate`); venv sidecar with
`RESEARCH_ENABLED_SOURCES=hackernews,arctic-shift`; `PORT=3100 bun run dev:local`; sign in at `/api/dev-login`; flag
on; run `hotels` (paid: ask first); compare credits; pick the top candidate; send one chat turn; read the phase-1
verdict, the facts screen and the exported `FACTS.md`; record it all on a local HTML compare page.

## Build order (small PRs; each passes `verify` and its tests)
1. Origin groundwork (rules 1–5, `FACT_ORIGINS`, fact row, CHECK migration, ADR-0006, `CONTEXT.md`); nothing visible.
2. Sidecar options with pytest, `apps/research/README.md`, `THIRD_PARTY-research.md`.
3. Tables, migration, owner-filtered queries, `docs/DATABASE.md`.
4. Pure core with tests: plan schema, relevance, clustering, `verifyQuote`, `scoreCandidate`.
5. Run engine (stage advance, lease, model calls, credits, lane report) behind the flag, off.
6. Screens (frontend-design skill pass), `docs/ARCHITECTURE.md`; pick → project with a one-line note in
   `lib/phases/directive.ts` for projects holding `idea-finding` facts.
7. Paid hotels QA run (ask first): set `RELEVANCE_MIN` and `THEME_MIN`, measure the real cost, then turn the flag on.

## Decisions needed from owner (recommendation first)
1. **Names:** recommend feature "market idea finding", code and origin `idea-finding`, tables `IdeaFindingRun` /
   `ProblemCandidate`.
2. **Synthesis model:** recommend luna (~5–9¢ a run) over terra (~19–35¢); revisit after the hotels QA.
3. **Greenhouse and BLS:** recommend v2. Greenhouse cannot search across boards; BLS gives size, not pain.
4. **Apple review RSS:** recommend "avoid" for automated use (robots.txt disallows the feed path).
5. **Community list:** recommend running straight through and showing it, with a re-run after edits, not a confirm
   stop; the subreddit check already removes NSFW and missing names.
6. **Quotes in the project:** recommend a read-only "where this came from" panel; never transcript, facts or judge.
7. **Runs per user:** recommend 3 a day while the 50¢ balance has no top-up (CONCERNS rank 12).
8. **Deep research's HN lane** (CONCERNS rank 11): recommend a follow-up PR that reuses this relevance function.
