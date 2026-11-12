# `apps/research` — demand-signal and simulation sidecar

Python service behind two TypeScript clients:

- `apps/chat/lib/signals/sidecar.ts` — the demand-signal contract
- `apps/chat/lib/research/simulation.ts` — the Step 8 persona simulation

## Why it exists at all

Two reasons, and neither is "we like Python".

1. **The adapters already exist there.** `mvanhorn/last30days-skill` (MIT) has
   seventeen source adapters carrying years of accumulated knowledge about
   endpoints that fight back. Reimplementing them in TypeScript would mean
   owning an anti-bot maintenance treadmill forever, for no gain.
2. **OASIS is Python and pins `>=3.10,<3.12`.** Step 8 could not live in the
   Next.js app whatever we wanted.

## Python version

**3.11, and the constraint is OASIS.** `camel-ai/oasis` @ `40bf1705` declares
`python = ">=3.10.0,<3.12"` in its own `pyproject.toml` (line 25). 3.11 is the
newest version inside that window. The reasoning is repeated in
`pyproject.toml` and in the `Dockerfile`, because this is the decision most
likely to be "cleaned up" by someone who did not know why it was there.

## Running it

```bash
uv venv --python 3.11 .venv
VIRTUAL_ENV="$PWD/.venv" uv pip install -e ".[dev]"
.venv/bin/python -m uvicorn app.main:app --port 8099
```

The `simulation` extra is **not** installed by default and should not be:
`import oasis` eagerly pulls torch, sentence-transformers and scikit-learn and
probes CUDA at import time. `/v1/simulate` reports `oasis-not-installed` as a
named condition until you install it:

```bash
VIRTUAL_ENV="$PWD/.venv" uv pip install -e ".[simulation]"
```

That extra installs `igraph` (GPL-2.0-or-later) through OASIS, on your machine,
from PyPI. This project ships no `igraph` and publishes no simulation image; if
you build one with `docker build --target simulation`, keep it to yourself or
meet the GPL's terms for it. Details are in `THIRD_PARTY-research.md`.

## Tests

Every test runs with **no network and no API key**. A test that needs either
belongs in a manual probe script, not here.

```bash
.venv/bin/python -m pytest
.venv/bin/python -m ruff check app tests
```

## The one thing you must not break

**An adapter never returns `[]` to mean "something went wrong."** Empty means
"we searched, and the topic genuinely has no coverage" — a legitimate finding
the phase gate acts on. Everything else raises a named error from
`app/errors.py`, which the route turns into `{"ok": false, "kind": ...}`.

The keyless adapters were only ever verified from a **residential IP**. From a
Vercel or AWS egress range, DuckDuckGo's HTML endpoint is expected to 403 or
serve a challenge page. If that came back as `[]`, the app would tell every
founder "nobody is discussing your idea" and the gate would BLOCK them on the
strength of it.

## Sources

| id | Default | Hosted | Credential |
|---|---|---|---|
| `hackernews` | on | allowed | none |
| `web-keyless` | on | allowed | none |
| `github` | off | allowed | `GITHUB_TOKEN` |
| `arctic-shift` | off | allowed | none |

`arctic-shift` is the only Reddit lane. It calls a third party's public archive
API and never Reddit's own servers. Read `app/sources/reddit_gate.py` before
changing it or adding another Reddit lane. The short version: a lane that reads
Reddit's own unauthenticated endpoints works *because* Reddit's `.json`
endpoints 403 while others do not, which is routing around an access control, so
none ships; and storing posts makes the operator a GDPR controller with no lawful
basis and no way to honour erasure, so the archive is asked for a field list
without the author and no username is ever received.

The archive matches every word it is sent, so the lane does not forward the
researcher's web-search string: `keyword_query` drops search operators
(`site:`, `-term`, `OR`), quotes, stopwords and web-search boilerplate and keeps
the first two content words, sent as the archive's `title` keyword parameter, so
the lane matches titles only. (On 2026-11-12 the archive answered the `query`
parameter, title and body together per its README, with HTTP 422 on four probes
out of four and `title` on two out of six; the 422 body reads "Timeout. Maybe
slow down a bit". That sample cannot separate the parameter from the moment each
request was made, so `title` is kept for being the README's own example, not
because it is proven better.) The archive's own timeouts and load-shedding are
the dominant failure, so the lane is polite and bounded:
- one request per second, a pause of two seconds between subreddits, and at most
  two subreddits per call (the best-fitting two; the app lists them best first);
- a 429 is not retried: it starts a cool-down of the lane (the pause the archive
  named, thirty seconds when it names none, at most sixty) during which no search
  asks the archive at all, and the rest of that call's subreddits are not asked;
- a 422 whose body says "Timeout" is the archive's search timing out on its side,
  not a rate limit and not a bad query: it is asked once more after a two-second
  pause with the most recent thirty days only, and reported as a timeout;
- an overload reported in a 200 body is retried once after the wait it asked for
  (up to five seconds); any other 4xx is a rejected query and is not retried;
- twenty-five seconds for the whole lane.

The lane report shows a plain sentence for each failure. The request URL and the
start of the response body are written to the sidecar's log (`research.arctic_shift`)
and never returned, because the report is shown to the founder verbatim. When the
lane returns nothing because it was rate-limited, timed out, rejected the query or
ran out of time, it says so in those words instead of reporting an empty result.

The permission gate (`app/sources/base.py::assert_permitted`) still supports a
source that is barred in hosted mode or needs a credential beyond the operator
toggle; no registered source uses either today.

## Ranking sources against the founder's buyer

**The sidecar does not decide this, and the decision is deliberate rather than
inherited.** Take a founder whose buyer is parents of 3-8 year olds, validating
a bedtime-routine app. A report for them that leads with Hacker News answers in
the wrong room: Hacker News is a developer forum. Nothing prioritised it on
purpose: every project got the same lanes in the same order, and that order was
the order they happen to be written in a registry, which put Hacker News first
(and made it the only lane left whenever the others were switched off).

The ranking now lives in **`apps/chat/lib/signals/audience.ts`**, on the app
side, and the reasoning for that placement is in the file. The short version is
that it could not live here: `POST /v1/signals/{source_id}` runs **exactly one
source per request** and builds its plan with `source_weights={id: 1.0}`, so a
per-source weight in `app/pipeline/fusion.py` multiplies every item in the one
stream by the same number and reorders nothing. Cross-lane ordering only exists
where several lanes meet, which is `runSignalHarvest`, on the other side of the
wire. A weight added here would have looked like a ranking and changed nothing.

What that module decides, given the project's `target_user` segment:

| buyer | order |
|---|---|
| not a developer (parents, teachers, bookkeepers, dog walkers) | Reddit → general web → GitHub → **Hacker News last** |
| a developer | Hacker News → GitHub → Reddit → general web |
| **not established** | general web → Reddit → Hacker News, GitHub |

The neutral row is a named, defended ordering and not a fall-through: the
general web is the only lane that commits to no audience, and Hacker News and
GitHub are narrow single-population corpora that must not lead when the buyer is
unknown. "Unknown" is its own arm carrying no weight — never a `0`, never a
silent default to the developer ordering.

**A weight is a multiplier on the relevance this sidecar already computed, and
it never reaches zero.** Every lane still runs, still appears in the per-lane
report, and can still lead on merit: a Hacker News thread roughly four times more
relevant than the Reddit alternative still comes first for a parent buyer.
Deprioritised is not disabled.

### `options`, and why the Arctic Shift lane used to refuse everything

`SignalRequest.options` is a free-form dict passed straight to
`SourceQuery.options`. Only `arctic-shift` reads it, and only
`options["subreddits"]`.

That adapter **refuses** a query with no subreddits, on purpose: Arctic Shift's
keyword parameters are documented as working only alongside `subreddit` or
`author`, so there is no global keyword search and an unscoped answer would read
as "we searched and found little" when no search happened. The app never sent
`options`, so the lane could be enabled, reachable and correct and still refuse
every single request. `sourceOptionsFor` now chooses the subreddits from the
same segment decision as the weights — r/Parenting, r/daddit, r/Mommit,
r/kindergarten for a parent buyer — because choosing subreddits for a
project *is* the segment question.

With no segment, no subreddits are sent and this lane answers with its own
written refusal naming the parameter it needs. That is the intended outcome: it
tells the founder that naming their buyer is what unlocks the Reddit lane.
`tests/test_api.py` pins both halves of the `options` contract from this side.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `RESEARCH_HOSTED` | `true` | Fail-closed. Unset means hosted, which bars any source that is barred in hosted mode (none is today). |
| `RESEARCH_ENABLED_SOURCES` | `hackernews,web-keyless` | Comma-separated ids. Unknown ids are reported at `/v1/health`, not ignored. **Read by the app too** — `parseOperatorEnabledSources` in `apps/chat/lib/signals/providers.ts` parses it the same way, because the app also declines to ask for a source the operator did not enable. |
| `RESEARCH_SIDECAR_TOKEN` | — | Shared secret for `/v1/signals` and `/v1/simulate` (sent by the app as `Authorization: Bearer …`; `/v1/health` stays open and reports only the mode). **Set, it is required from every caller.** Unset, the sidecar serves loopback callers only, and only requests whose `Host` is `localhost`, `127.0.0.1` or `[::1]` (the DNS-rebinding guard: a hostile web page cannot change the Host its browser sends), and logs one warning at startup — zero setup when the app and the sidecar run on the same machine, no protection from other local processes. **Read by the app too** (`apps/chat/lib/env-schema.ts`): set the same value on both sides whenever the app reaches the sidecar over a network, which includes any Vercel deployment. |
| `RESEARCH_SIDECAR_ALLOW_UNAUTHENTICATED` | `false` | With no token, serve any caller instead of loopback only. Only for the containerised dev sidecar in `docker-compose.yml`, which sees the host's calls arrive from the Docker bridge and is protected by its 127.0.0.1 port binding instead. Never in a deployed environment. |
| `GITHUB_TOKEN` | — | Required by the `github` source. |
| `RESEARCH_SEARXNG_URL` | — | **Set it for usable web search.** First rung of the keyless ladder, and on a residential connection the only rung that answers: DuckDuckGo serves the sidecar a challenge page, so with this unset `web-keyless` reports `blocked` and Hacker News becomes the only working source, which is a poor room for a consumer idea. SearXNG is AGPL-3.0, so the default compose stack does not run it: start the opt-in overlay with `docker compose -f docker-compose.yml -f docker-compose.searxng.yml up -d searxng` and set this to `http://127.0.0.1:8888`, or point it at an instance you already run. Stays a URL because the sidecar runs on the host in dev, where a compose service name would not resolve. |
| `OPENAI_API_KEY` | — | **Required by the simulation lane, in THIS process's own environment.** The Next.js app having it is irrelevant — `/v1/simulate` calls the model from here. Without it every agent fails at call time and the run returns zero reactions. Cost one failed run to discover, which is why it is now first in this table. In dev, start the sidecar through `bunx dotenv-cli -e <repo>/.env.local -- …` so it inherits the repo-root key. |
| `RESEARCH_SIM_MODEL` | `gpt-5.6-luna` | CAMEL model type for the simulation. Moved off `gpt-4o-mini` on 2026-08-21: TAU-Bench measures agentic tool use in multi-turn conversation, which is exactly what an OASIS agent does, and 4o-mini scores 26.7% against luna's 70.7% for about +0.1¢ per run. Checked against `GET {base}/models/{id}` before a run starts: a typo is refused as `unknown-simulation-model` instead of failing per-agent at call time. CAMEL itself accepts any string, so this check is the only thing standing between a misspelling and a silent empty run. |
| `RESEARCH_SIM_REASONING_EFFORT` | derived from the model | Sent as `model_config_dict={"reasoning_effort": …}`. **Leave it unset.** Unset means "derive it": `none` for the `gpt-5.6-*` family, omitted for everything else. That split is not cosmetic — every OASIS action is a function tool call, CAMEL posts to `chat/completions`, and that family refuses tools there at any effort above `none`, while `gpt-4o-mini` refuses the key itself. Setting it to the **empty string** is different from leaving it unset: empty means "never send this", and it overrides the derived default. |
| `RESEARCH_SIM_BASE_URL` | — | OpenAI-compatible gateway for the simulation. Also the base for the model-id check above. |
| `RESEARCH_SIM_CONCURRENCY` | `8` | OASIS `semaphore=`. Its own default is 128, which will 429 a shared gateway. |

## Provenance

Every vendored file carries a banner naming its upstream path, licence and
commit SHA. The ledger is `THIRD_PARTY-research.md` at the repository root, and
the full licence texts are in `LICENSES/`.
