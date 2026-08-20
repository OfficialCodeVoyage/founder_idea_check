# Third-party code — research subsystem (Steps 5 and 8)

Provenance ledger for `apps/research/**`, `apps/chat/lib/research/**` and
`apps/chat/lib/signals/**`.

Kept separate from the shared `THIRD_PARTY.md` so the two can be edited without
conflicting. **Both are authoritative**; a licence audit must read both.

Borrowed code is **frozen** — upstream fixes never arrive on their own — so
every entry pins the SHA it was taken at. To see what upstream fixed since:

```bash
gh api "repos/OWNER/REPO/commits?path=PATH&since=YYYY-MM-DD" --jq '.[].commit.message'
```

Every vendored Python file also carries that exact command in its own header
banner, pre-filled with its path, so the check is one copy-paste away.

---

## Verified provenance

All four upstreams were probed directly with `gh api` on 2026-08-19, not read
from a summary.

| Repo | ★ | Licence (SPDX) | HEAD at probe | Archived |
|---|---|---|---|---|
| `mvanhorn/last30days-skill` | 58,742 | **MIT** | `9243a32d823c7c8659e44b92f2dedcf1b7397137` (2026-08-18) | no |
| `dzhng/deep-research` | 19,574 | **MIT** | `1f8f3e285bbc23e80b98a66a64effab9069f3ad4` (2026-04-11) | no |
| `camel-ai/oasis` | 5,035 | **Apache-2.0** | `40bf170501e4757c993e3f55ff0208f435bb215d` (2026-08-19) | no |
| `miurla/morphic` | 9,049 | **Apache-2.0** | `d4aba02a14a5cb2c6ed0e7ef917123a681b05f14` (2026-08-20) | no |

---

## Vendored verbatim — `mvanhorn/last30days-skill` (MIT) @ `9243a32d`

Copied with a provenance banner prepended and the sibling imports retargeted for
this package layout. **Nothing else was changed**, deliberately: `ruff` is
configured in `apps/research/pyproject.toml` to skip the stylistic modernisers
on these four files, because a `ruff --fix` pass over them would rewrite
`List[str]` to `list[str]`, re-sort `__slots__` and "correct" the Hebrew
stopwords that RUF001 mistakes for Latin lookalikes — and would destroy the
ability to diff against upstream, which is how a vendored file quietly stops
receiving upstream security fixes.

| Vendored to | Upstream path | Modifications |
|---|---|---|
| `apps/research/app/text/cjk.py` | `skills/last30days/scripts/lib/cjk.py` | none — verbatim |
| `apps/research/app/text/relevance.py` | `skills/last30days/scripts/lib/relevance.py` | none to the algorithm |
| `apps/research/app/pipeline/dedupe.py` | `skills/last30days/scripts/lib/dedupe.py` | dropped the `jobs` special case (no jobs adapter here); retargeted imports |
| `apps/research/app/pipeline/entity_extract.py` | `skills/last30days/scripts/lib/entity_extract.py` | kept only `extract_text_entities` and `entity_overlap`; dropped the X/Reddit handle and hashtag miners |

## Adapted — `mvanhorn/last30days-skill` (MIT) @ `9243a32d`

Algorithms, regexes and hard-won constants taken; structure changed to fit this
service. Each file's banner names its own modifications.

| Adapted to | Upstream path | What was taken, and the modification |
|---|---|---|
| `apps/research/app/pipeline/fusion.py` | `lib/fusion.py` | Weighted RRF core, URL normaliser, per-author cap, per-source diversity floor. **Removed** the `first_party_handles` allowance (exists for X person/company topics; no X adapter here) and the `fun_score` path. |
| `apps/research/app/pipeline/cluster.py` | `lib/cluster.py` | Greedy leader clustering, MMR representatives, entity-overlap merge, uncertainty labels, upstream's thresholds. **Removed** the `polymarket` special case and the discover-mode switch. |
| `apps/research/app/sources/hackernews.py` | `lib/hackernews.py` | The Algolia query construction, carrying **both** upstream traps (see below). **Removed** depth presets, comment-enrichment fan-out, the `log.source_log` sink. **Changed**: raises named errors instead of returning `{"hits": [], "error": ...}`. |
| `apps/research/app/sources/web_search_keyless.py` | `lib/web_search_keyless.py` | Every regex, the DDG redirect unwrapper, the positional snippet-window trick, the three-rung ladder. **Removed** the artifact dict and the flat relevance prior. **Changed**: a fully blocked ladder raises `SourceBlocked`. **Fixed a real bug** — see below. |
| `apps/research/app/sources/github.py` | `lib/github.py` | Search-qualifier construction and the "issues are where the pain is" framing. **Removed** device-flow auth, repo-activity and release lanes, and the unauthenticated fallback. |
| `apps/research/app/sources/reddit_rss.py` | `lib/reddit_rss.py` | Atom parsing, feed-URL construction, the two-family search+listing fan-out. **Removed** the ThreadPoolExecutor (already behind a semaphore a layer up) and the shreddit backfill hook. **Changed**: the author is dropped at parse time; failures raise. **Added**: a DOCTYPE/size guard and an Atom-root check. |
| `apps/research/app/sources/reddit_shreddit.py` | `lib/reddit_shreddit.py` | The `<shreddit-comment>` markup parsing — the start-tag lookahead, the thingId-anchored body extraction, the next-anchor bound. **Changed**: the author is dropped at parse time; failures raise. |
| `apps/research/app/schema.py` | `lib/schema.py` | The `SourceItem` / `Candidate` / `SubQuery` / `QueryPlan` / `Cluster` field names, kept identical so the vendored modules run unchanged. **Trimmed** from 1,046 lines to the five types the pipeline touches. |

### Upstream traps preserved, with the comment that explains them

These are the reason vendoring beat writing from scratch. Each is pinned by a
test in `apps/research/tests/test_adapters.py`.

1. **HN Algolia `points` is not filterable.** It is absent from that index's
   `numericAttributesForFiltering`, so a `points>N` clause returns HTTP 400 and
   **zero stories** — not a warning, not a partial result. Low-engagement
   filtering therefore happens client-side after overfetching.
2. **Algolia ANDs query tokens by default**, so a four- or five-word theme query
   matches nothing at all. All but the first token go in `optionalWords`.
3. **DuckDuckGo anomaly-blocks datacenter IPs with an HTTP 202 challenge page** —
   a success status carrying no results — while Startpage still serves organic
   results from the same egress. That asymmetry is why the ladder exists.
4. **`<shreddit-comment>` needs a whitespace-or-`>` lookahead**, or every
   `<shreddit-comment-tree>` wrapper parses as a comment.
5. **Reddit keyless is 5 req/s.** Above it, the endpoints start returning 403 for
   the rest of the session — converting a working lane into a dead one for
   everybody sharing the egress IP.

### A bug found in upstream and fixed here

`web_search_keyless.parse_startpage` pairs each result with the first
description block whose `start() > match.end()`. When the markup has no
whitespace between `</a>` and `<p>` — which minified Startpage HTML routinely
does not — the description begins exactly **at** the anchor's end and the strict
`>` drops every snippet. Ours uses `>=`;
`tests/test_adapters.py::TestKeylessWebSearch::test_parses_startpage_markup`
pins the boundary. Not reported upstream.

---

## Ported — `dzhng/deep-research` (MIT) @ `1f8f3e28`

**Ported, not copied.** Upstream targets `ai@4` / `zod@3`; this repo is
`ai@6.0.219` / `zod@^4.3.6`, so the `generateObject` call sites, the schema
builders and the module-level provider singletons all had to change.

| Ported to | Upstream file | What survives |
|---|---|---|
| `apps/chat/lib/research/loop.ts` | `src/deep-research.ts` | The ALGORITHM: generate `breadth` SERP queries from the brief plus prior learnings; run them under a concurrency limit (upstream `pLimit`, line 216); halve breadth and decrement depth on recursion (line 230, `Math.ceil(breadth / 2)`); accumulate learnings and urls down the tree; build the next brief from the research goal plus follow-up questions. |
| `apps/chat/lib/research/budget.ts` | `src/deep-research.ts` | `nextBreadth` is the same halving rule, isolated so the budget projection provably models the tree the loop actually walks. `DEFAULT_COST_MODEL.extractionInputTokens` is derived from upstream's own 25,000-character trim × 5 results per query. |

### The one deliberate divergence

Upstream's per-query `catch` returns `{ learnings: [], visitedUrls: [] }`, which
makes "every source 403'd" indistinguishable from "this topic has no coverage".
Since the keyless adapters were only verified from a **residential IP** and are
expected to 403 from a datacenter egress range, that is the single most likely
production failure — and upstream's version of it reports success. Here every
failure becomes a named `ResearchFailure` that rides out with the result, and
`summarizeFanOut().emptyBecauseOfFailures` tells the caller when a report would
be a lie.

---

## Design taken, no code copied

| What was taken | Source | Licence | Pinned at | Reimplemented in |
|---|---|---|---|---|
| Providers-directory pattern: one descriptor module per source, resolved through a single index, so adding a source is adding a file | `miurla/morphic` `lib/tools/search/providers/` | Apache-2.0 | `d4aba02a14a5cb2c6ed0e7ef917123a681b05f14` | `apps/chat/lib/signals/providers.ts`, `apps/research/app/sources/registry.py` |
| Fan-out topology: role-specialised concurrent researchers under a supervisor, with **overflow reported back to the model** rather than silently truncated | `langchain-ai/open_deep_research` `src/open_deep_research/deep_researcher.py` (the `asyncio.gather` at ~:305 and the overflow branch at ~:318) | MIT | not vendored; design only | `apps/chat/lib/research/supervisor.ts` (`runFanOut`, `decideOverflow`) |

**Morphic's gate was NOT taken.** Its providers are gated on whether an API key
is present, which answers *can we?*. `decideProviderGate` answers *may we?* —
see `apps/chat/lib/signals/providers.ts`. That distinction is the whole Reddit
mitigation and it exists nowhere in the surveyed open source.

**open_deep_research's `prompts.py` was NOT taken**, though it is MIT and 21 KB
of usable prompt text. Its prompts are written for a generic "research anything"
agent; `apps/chat/lib/research/roles.ts` is written for a founder being told
uncomfortable things about their idea, and that difference is the product. The
prompt text there is original.

---

## Dependency — `camel-ai/oasis` (Apache-2.0) @ `40bf1705`

**No OASIS code is copied.** `apps/research/app/simulation/oasis_runner.py`
calls only the twelve names exported from `oasis/__init__.py`.

Facts verified by direct file read, each load-bearing:

| Fact | Where | Consequence here |
|---|---|---|
| `python = ">=3.10.0,<3.12"` | `pyproject.toml:25` | The sidecar pins **Python 3.11**. Stated in `pyproject.toml`, the `Dockerfile` and the README. |
| Default graph backend is **igraph, in memory** — neo4j needs an explicit `backend="neo4j"` plus a valid `Neo4jConfig`, and neither documented generator passes one | `oasis/social_agent/agent_graph.py:178-190` | **No graph database** in the image or in `docker-compose.yml`. |
| `import oasis` eagerly imports torch, sentence-transformers and sklearn, and probes CUDA at import time | `oasis/social_platform/recsys.py:26-29`, `:46` | Simulation is an **optional extra**, imported lazily, with `oasis-not-installed` as a named condition. |
| `import oasis` creates `./log/` relative to CWD at import time | `env.py:30-32`, `platform.py:37-39`, `agent.py:44-45` | The Dockerfile's `WORKDIR` is owned by the runtime user. |
| `generate_reddit_agent_graph` indexes **seven** persona keys with no `.get()` and no default | `oasis/social_agent/agents_generator.py:573-596` | Validated up front by `validate_personas` / `toOasisPersonas`, so a malformed persona costs a millisecond instead of a torch load followed by a `KeyError`. |
| `env.step()` returns `None`; results live in the sqlite `trace`/`post`/`comment` tables | `env.py:136`, `:200-207` | Reactions are read back with plain SQL. |
| `create_db(db_path=None)` falls back to `<package_dir>/data/social_media.db` | `social_platform/database.py:62-66` | Both `database_path=` and `OASIS_DB_PATH` are set, as every OASIS example does. |
| `semaphore` defaults to **128** | `env.py:57`, `:70` | Overridden to 8 via `RESEARCH_SIM_CONCURRENCY`; 128 will 429 a shared gateway, and a 429 storm surfaces as agents "choosing to do nothing", which is indistinguishable from disinterest. |
| Model backend is CAMEL's `ModelFactory.create(...)`, whose custom-endpoint kwarg is **`url=`, not `base_url=`** | `docs/key_modules/models.mdx:28-38` | `RESEARCH_SIM_BASE_URL` is passed as `url=`. |

---

## Barred — do not reintroduce

Re-stated here because this subsystem is where the temptation lives.

| Candidate | Why it is barred |
|---|---|
| **Arctic Shift source** | `license: null` — all rights reserved. Its **public API is fine to call**, and `app/sources/arctic_shift.py` now does exactly that: the contract was read from its published `api/README.md` and verified against the running service, and not one line of its source appears in this repo. |
| Reddit torrent dumps | Redistributed user content including since-deleted posts. The erasure problem in its purest form. |
| `666ghj/MiroFish` | AGPL-3.0. `camel-ai/oasis` (Apache-2.0) is the same engine without it. |
| `lobehub/lobehub` | Custom licence: derivative works require a commercial licence. |
| `open-webui/open-webui` | Forbids removing branding above 50 users. |
| `langgenius/dify` | Bars multi-tenant use; asserts an appearance patent on its design. |
| `zaidmukaddam/scira`, `khoj-ai/khoj` | AGPL-3.0 network copyleft. |
| `firecrawl` **server** | AGPL-3.0. The npm client is MIT and is fine. |
| SearXNG / Redlib / self-hosted Firecrawl **in a shipped compose file** | AGPL-3.0 attaches by packaging. Reference by URL only — `RESEARCH_SEARXNG_URL` exists for exactly this. `docker-compose.yml` says so in a comment. |

---

## Licence obligations discharged

- **MIT** (`last30days-skill`, `deep-research`): the licence text and copyright
  notice must travel with substantial portions. Every vendored file carries a
  banner naming the repo, path, licence and SHA. Upstream's `LICENSE` reads
  `Copyright (c) 2026 Matt Van Horn`.
- **Apache-2.0** (`oasis`, `morphic`): §4(d) requires retaining NOTICE and §4(b)
  requires stating modifications. No Apache-2.0 **code** from either is present
  in this subsystem — OASIS is a runtime dependency called through its public
  API, and only morphic's directory *pattern* was reused — so no NOTICE
  attribution is triggered by this subsystem. Recorded here anyway so the
  question stays answered rather than re-litigated.
