# Third-party code: the research subsystem

Provenance ledger for `apps/research/` (the Python sidecar), `apps/chat/lib/research/`,
`apps/chat/lib/signals/` and `apps/chat/tools/platform/deep-research/` (the
deep-research tool). `THIRD_PARTY.md` covers everything else; read both. `NOTICE`
holds the attribution notices and `LICENSES/` the full MIT texts, each a
byte-for-byte copy of the upstream `LICENSE` (its git blob id equals the upstream
blob id given below).

Borrowed code is **frozen**: upstream fixes never arrive on their own, so every
entry pins the commit it was taken at. To see what an upstream fixed since:

```bash
gh api "repos/OWNER/REPO/commits?path=PATH&since=YYYY-MM-DD" --jq '.[].commit.message'
```

Every copied or adapted Python file carries that command in its own banner, filled
in with its path.

## One row per upstream

| Upstream | Licence, copyright | Used for | Pinned at |
|---|---|---|---|
| [mvanhorn/last30days-skill](https://github.com/mvanhorn/last30days-skill) | MIT, Copyright (c) 2026 Matt Van Horn | Source adapters, ranking pipeline and text utilities in `apps/research/app/` | `9243a32d823c7c8659e44b92f2dedcf1b7397137` (2026-08-18) |
| [langchain-ai/open_deep_research](https://github.com/langchain-ai/open_deep_research) | MIT, Copyright (c) 2025 LangChain | The deep-research tool in `apps/chat/tools/platform/deep-research/`: prompts near-verbatim, architecture and config names. It arrived with ChatJS. | `c0a160b57a9b5ecd4b8217c3811a14d8eff97f72` (2025-07-25), the last upstream change to `prompts.py` before ChatJS added its port on 2025-08-01 |
| [camel-ai/oasis](https://github.com/camel-ai/oasis) | Apache-2.0 | Optional dependency for the persona simulation. No code copied. | `camel-oasis==0.2.5`; sources read at `40bf170501e4757c993e3f55ff0208f435bb215d` (2026-08-19) |
| igraph ([python-igraph](https://github.com/igraph/python-igraph)) | GPL-2.0-or-later | Pulled in by OASIS, through the optional `simulation` extra only | `igraph==0.11.6` = tag `0.11.6`, `12ab69f1c3477e03f5b3c13c5a671439c58ff73e` (2024-07-08) |
| [miurla/morphic](https://github.com/miurla/morphic) | Apache-2.0 | Design only: one descriptor module per source behind one index. No code copied. | `d4aba02a14a5cb2c6ed0e7ef917123a681b05f14` (2026-08-20) |
| [ArthurHeitmann/arctic_shift](https://github.com/ArthurHeitmann/arctic_shift) | No licence on its source | Its public API is called; none of its source is copied | API contract read from `api/README.md` on 2026-08-09; terms re-read at `7752f2d2c4e450a0c333e165a70d270e75b6cfa4` (2026-10-11) on 2026-11-12 |

## mvanhorn/last30days-skill (MIT)

Licence text: `LICENSES/MIT-mvanhorn-last30days-skill.txt` (blob
`c7d2838bcc549a5cda7b7a3556a422e0074e56a5`, identical at the pinned commit and at
upstream HEAD `70c5b3dbcb42d58f8f901f181ba82651c3ba2350` on 2026-11-12). Upstream
paths below are under `skills/last30days/scripts/lib/`. Every file in the table
below except `config.py` carries a banner naming the upstream path, licence and
commit.

The reason this upstream was taken rather than rewritten: its adapters carry
accumulated knowledge about endpoints that fight back, and reimplementing them
would mean owning that maintenance. The Python sidecar exists because of that and
because OASIS is Python.

| Here (`apps/research/app/`) | Upstream | Kind | What changed |
|---|---|---|---|
| `text/cjk.py` | `cjk.py` | Copied verbatim | Nothing. Byte-identical to upstream apart from the banner (compared 2026-11-12). |
| `text/relevance.py` | `relevance.py` | Copied verbatim | Nothing. Byte-identical to upstream apart from the banner (compared 2026-11-12). |
| `pipeline/dedupe.py` | `dedupe.py` | Copied, trimmed | Dropped the `jobs` special case (no jobs adapter here); import paths retargeted; one docstring changed. |
| `pipeline/entity_extract.py` | `entity_extract.py` | Copied, trimmed | Kept only `extract_text_entities` and `entity_overlap`; dropped the X and Reddit handle and hashtag miners; module docstring changed. |
| `pipeline/fusion.py` | `fusion.py` | Adapted | Kept the weighted reciprocal-rank-fusion core, the URL normaliser, the per-author cap and the per-source diversity floor. Removed the `first_party_handles` allowance and the `fun_score` path. |
| `pipeline/cluster.py` | `cluster.py` | Adapted | Kept the greedy leader clustering, MMR representatives, entity-overlap merge, uncertainty labels and upstream's thresholds. Removed the `polymarket` special case and the discover-mode switch. |
| `sources/hackernews.py` | `hackernews.py` | Adapted | Kept the Algolia query construction with both upstream traps (below). Removed the depth presets, the comment-enrichment fan-out and the `log.source_log` sink. Errors now raise named exceptions instead of returning `{"hits": [], "error": ...}`. Added: a hit is dropped unless its title or text shares a content word with the query, or two distinct weak words (`matches_a_content_word`), because `optionalWords` lets Algolia return a story that matches a single token (or a typo or prefix of one) and a page of hits always came back. Stopwords, numbers and years, countries and regions, month names, file types, research filler (report, survey, study, statistics), time and age words and broad tech words (AI, app, tool, software, platform, model, agent, early, screen) never count, alone or in a pair (`_FILLER_TOKENS`, `_BROAD_TOKENS`, plus the vendored `LOW_SIGNAL_QUERY_TOKENS`). Words that name something but are too common to decide a topic alone (code, review, price, comparison, rate, data, market) count only as two different words in one hit (`_WEAK_TOKENS`). Words are compared on a trailing-plural stem on both sides. A query with no content word falls back to its weak words, then to any word. |
| `sources/github.py` | `github.py` | Adapted | Kept the search-qualifier construction and the "issues are where the pain is" framing. Removed device-flow auth, the repo-activity and release lanes, and the unauthenticated fallback. |
| `sources/web_search_keyless.py` | `web_search_keyless.py` | Adapted | Kept every regex, the DuckDuckGo redirect unwrapper, the positional snippet-window trick and upstream's SearXNG JSON rung. Reordered so a SearXNG the operator runs is tried first, and dropped the Startpage rung (it answered 200 and parsed to zero results when measured on 2026-08-20). Removed the artifact dict and the flat relevance prior. A fully blocked ladder raises `SourceBlocked`. SearXNG itself is opt-in; see `THIRD_PARTY.md`. |
| `schema.py` | `schema.py` | Adapted, trimmed | From 1,046 lines to the five types the pipeline touches, with upstream's field names so the vendored modules run unchanged. `to_demand_signal` emits this app's wire shape and never the author. |
| `pipeline/rerank.py` | `rerank.py` | Reimplemented, with material from upstream | The arithmetic and two constants, including the out-of-window multiplier (0.35) with the upstream comment quoted beside it. Upstream's LLM judge is not present: this service has no model call. |
| `pipeline/grounding.py` | `grounding.py` | Reimplemented from the design | The design of its two grounding checks, written against this service's types without upstream's configuration system. |
| `http.py` | `http.py` | Reimplemented from the design | Stdlib `urllib` only, a browser User-Agent for HTML endpoints, a token-bucket limiter (upstream's design; the one limiter left is set for Arctic Shift, not at upstream's Reddit figure). Failures raise named errors instead of being classified into strings. |
| `config.py` | `env.py` | Nothing taken | Its docstring names upstream only to say what was left out. |

Upstream knowledge kept, each pinned by a test in `apps/research/tests/test_adapters.py`:

1. **HN Algolia `points` is not filterable.** It is absent from that index's
   `numericAttributesForFiltering`, so a `points>N` clause returns HTTP 400 and
   zero stories. Low-engagement filtering happens client-side after overfetching.
2. **Algolia ANDs query tokens by default**, so a four- or five-word theme matches
   nothing. All but the first token go in `optionalWords`.
3. **DuckDuckGo anomaly-blocks datacenter IPs with an HTTP 202 challenge page**, a
   success status carrying no results. That is why the keyless search is a ladder.

The Python files are not reformatted or modernised: `apps/research/pyproject.toml`
tells `ruff` to skip the stylistic rules on the four copied files, because a
`ruff --fix` pass would make them undiffable against upstream, and a vendored file
that cannot be diffed stops receiving upstream fixes.

## langchain-ai/open_deep_research (MIT)

Licence text: `LICENSES/MIT-langchain-ai-open_deep_research.txt` (blob
`82dc7c43f7ba98b72ac619ebfe7599576dc3ce7f`, the same at `c0a160b5` and at upstream
HEAD `1b7d2e80db9faa586165c60e09096dbbfd483a64` on 2026-11-12).

**What happened.** The deep-research tool in
`apps/chat/tools/platform/deep-research/` arrived with the ChatJS fork, under
ChatJS's Apache-2.0. ChatJS added it on 2025-08-01 as a TypeScript port of
LangChain's LangGraph agent, without recording the source: that first version had
the same graph nodes (`write_research_brief`, `research_supervisor`,
`supervisor_tools`, `compress_research`) and TODO comments about LangChain message
types. ChatJS rewrote the control flow on the AI SDK on 2026-02-05. The prompts
stayed. Earlier versions of this ledger said the opposite ("`prompts.py` was NOT
taken"); that was wrong for this directory, and this section replaces it.

**How much is derived**, measured on 2026-11-12 by comparing `prompts.ts` with
upstream `src/open_deep_research/prompts.py`, ignoring whitespace and the
difference between `{x}` and `${x}` placeholders:

| Compared with | Prompt lines identical | Words on identical lines |
|---|---|---|
| Upstream at `c0a160b5` (2025-07-25), the last change to the file before the port | **215 of 221 (97.3%)** | 95.6% |
| Upstream today, `6532a417` (2025-08-06, the last commit to that file) | 152 of 221 (68.8%) | 51.3% |

Upstream rewrote several prompts after the port, which is why the second row is
lower. Per prompt, against `c0a160b5`:

| Prompt in `prompts.ts` | Against upstream |
|---|---|
| `clarifyWithUserInstructions` | 30 of 30 lines identical |
| `transformMessagesIntoResearchTopicPrompt` | 25 of 25 identical |
| `leadResearcherPrompt` | 50 of 50 identical |
| `compressResearchSystemPrompt` | 31 of 31 identical |
| `compressResearchSimpleHumanMessage` | 2 of 2 identical |
| `finalReportGenerationPrompt` | Upstream minus 12 lines (the language-matching instruction and a messages block); nothing added |
| `researchSystemPrompt` | 23 of 29 identical; 6 lines reworded or added (the `ResearchComplete` tool references became "stop making tool calls", and the closing reply is limited to brief notes because the findings are condensed from the search results; one line states the maximum number of search queries) |
| `summarize_webpage_prompt` | Not ported |

So `prompts.ts` is LangChain's prompt text with a few edits, under MIT; it is not
original to this project. The other files in the directory (`types.ts`,
`configuration.ts`, `supervisor-agent.ts`, `researcher-agent.ts`, `pipeline.ts`,
`utils.ts`) follow the same architecture and use the same configuration keys and
tool names (`ConductResearch`, `ResearchComplete`, `max_concurrent_research_units`
and so on), but share only short fragments of upstream text: at most 9.2% of their
six-word sequences (`types.ts`), mostly schema descriptions of 11 to 20 words. No
long run of upstream code is in them.

What is ours: `apps/chat/lib/research/supervisor.ts` (a counting semaphore that
makes `max_concurrent_research_units` a real bound, and `decideOverflow`, which
reimplements upstream's habit of telling the model when it asked for more parallel
research units than are allowed, with its own wording), the sidecar search arm, and
the audience ranking in `apps/chat/lib/signals/`.

To make the prompts this project's own, rewrite `prompts.ts`; until then the MIT
notice in `LICENSES/` and `NOTICE` is what covers them.

## camel-ai/oasis (Apache-2.0)

**No OASIS code is copied.** `apps/research/app/simulation/oasis_runner.py` calls
only the names `oasis/__init__.py` exports, and OASIS is installed by the optional
`simulation` extra (`camel-oasis==0.2.5`, Apache-2.0). Facts the code relies on,
read directly from the OASIS sources at `40bf1705` on 2026-08-19 (the paths in the
second column are in that repository):

| Fact | Where | Consequence here |
|---|---|---|
| `python = ">=3.10.0,<3.12"` | `pyproject.toml:25` | The sidecar pins Python 3.11, in `pyproject.toml`, the `Dockerfile` and the README. |
| The default graph backend is igraph, in memory; neo4j needs an explicit `backend="neo4j"` plus a `Neo4jConfig`, and neither documented generator passes one | `oasis/social_agent/agent_graph.py:178-190` | No graph database in the image or in `docker-compose.yml`. |
| `import oasis` eagerly imports torch, sentence-transformers and scikit-learn, and probes CUDA at import | `oasis/social_platform/recsys.py:26-29`, `:46` | Simulation is an optional extra, imported lazily, with `oasis-not-installed` as a named condition. |
| `import oasis` creates `./log/` relative to the working directory | `env.py:30-32`, `platform.py:37-39`, `agent.py:44-45` | The `Dockerfile`'s `WORKDIR` is owned by the runtime user. |
| `generate_reddit_agent_graph` indexes seven persona keys with no `.get()` and no default | `oasis/social_agent/agents_generator.py:573-596` | Validated up front by `validate_personas` / `toOasisPersonas`, so a malformed persona fails in a millisecond instead of after a torch load. |
| `env.step()` returns `None`; results live in the sqlite `trace`, `post` and `comment` tables | `env.py:136`, `:200-207` | Reactions are read back with plain SQL. |
| `create_db(db_path=None)` falls back to `<package_dir>/data/social_media.db` | `social_platform/database.py:62-66` | Both `database_path=` and `OASIS_DB_PATH` are set. |
| `semaphore` defaults to 128 | `env.py:57`, `:70` | Overridden to 8 through `RESEARCH_SIM_CONCURRENCY`. |
| The model backend is CAMEL's `ModelFactory.create(...)`, whose custom-endpoint argument is `url=`, not `base_url=` | `docs/key_modules/models.mdx:28-38` | `RESEARCH_SIM_BASE_URL` is passed as `url=`. |

## igraph (GPL-2.0-or-later)

**Where it enters.** Only through the optional `simulation` extra in
`apps/research/pyproject.toml`. `camel-oasis==0.2.5` requires `igraph==0.11.6`
(PyPI metadata of `camel-oasis` 0.2.5, read 2026-11-12). The default dependencies
(`fastapi`, `uvicorn`, `pydantic`) do not list it, and the default Docker image does
not install it.

**Which licence exactly.** The GitHub `LICENSE` file is the GPL-2.0 text and PyPI
says only "GNU General Public License (GPL)", with no version. The source says
more: the source header of python-igraph at tag `0.11.6` (checked in
`src/igraph/__init__.py`) grants "either version 2 of the License, or (at your
option) any later version", so it is **GPL-2.0-or-later**. The igraph C library's
sources (one file checked, at its tag `0.10.13`) use the same wording.

**What this project does about it.** It ships no igraph, installs it nowhere by
default, and **publishes no simulation image**. The `Dockerfile` has a
`simulation` stage so that you can build one for yourself. Anyone who builds one
and publishes it, or ships any other bundle containing igraph, takes on the GPL's
terms for that bundle.

In a development environment with the `simulation` extra installed (141 Python
distributions; their declared licences were read on 2026-11-12), igraph is the only
GPL package. Two others are MPL-2.0 (`certifi`, `tqdm`), used unmodified.

## miurla/morphic (Apache-2.0)

Design only. The idea of one descriptor module per source, resolved through a single
index so that adding a source is adding a file, was taken from
`lib/tools/search/providers/` and reimplemented in `apps/chat/lib/signals/providers.ts`
and `apps/research/app/sources/registry.py`. No morphic code is present, so no
Apache-2.0 notice is triggered by this subsystem. Morphic's providers are gated on
whether an API key exists, which answers "can we?"; `decideProviderGate` answers
"may we?", and that part is not from morphic.

## Arctic Shift (no licence on its source)

`ArthurHeitmann/arctic_shift` has no licence file (GitHub reports none), so its
source is all rights reserved and **none of it is copied**.
`apps/research/app/sources/arctic_shift.py` is an original client of its public API,
written from the API's own documentation.

**Terms of use, as found on 2026-11-12.** There is no terms-of-service or
acceptable-use document: the site root shows only navigation, and `/terms`, `/tos`,
`/about` and `/privacy` all answer 404. The API README (`api/README.md`) says: "No
uptime or performance guarantees", "If you're a normal user and only make a couple
requests per second, you have nothing to worry about", and "Remember, this is a free
service, so be considerate. If you want to process massive amounts of data, use the
monthly dumps instead", and it describes 429 rate limiting with `X-RateLimit-Reset`
headers. Those are the only terms found.

**What the adapter does against that.** At most one request per second sustained
(burst of two, `ARCTIC_SHIFT_LIMITER` in `app/http.py`, retries included) and two
seconds between subreddits; at most two subreddits per call; at most one retry,
only for an overload reported in a 200 body (after the wait the archive asks for,
five seconds or less) or for a 422 whose body says "Timeout" (after two seconds,
over the last thirty days); no retry for a 429 or for any other 4xx, and after a
429 the whole lane asks the archive nothing until the pause it named is over
(thirty seconds when it names none, at most sixty); keywords are sent as `title`,
the parameter the archive's own search example uses (ten live GET requests on
2026-11-12 in all, generic queries, nothing stored); the whole lane stops at 25
seconds; never an unscoped search; a field list that excludes `author`, so no username is ever
received; and the monthly dumps are not downloaded or ingested.

**What this does not settle.** The archive republishes Reddit users' posts. Reddit's
own terms, not Arctic Shift's, govern that content, and this review did not assess
them. `DemandSignal` has no `author` field, snippets are capped at 500 characters,
and the permalink points at Reddit.

## Considered and not used

`dzhng/deep-research` (MIT) is not used. A TypeScript port of its recursion was
written in this project's early history and deleted again on 2026-08-21 because
nothing called it. It shared under 1% of its six-word sequences with upstream, code
and comments together (algorithm only), and no dzhng code remains in the tree.
