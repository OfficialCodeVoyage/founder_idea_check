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
Vercel or AWS egress range, Reddit's feeds and DuckDuckGo's HTML endpoint are
expected to 403 or serve a challenge page. If those came back as `[]`, the app
would tell every founder "nobody is discussing your idea" and the gate would
BLOCK them on the strength of it.

## Sources

| id | Default | Hosted | Credential |
|---|---|---|---|
| `hackernews` | on | allowed | none |
| `web-keyless` | on | allowed | none |
| `github` | off | allowed | `GITHUB_TOKEN` |
| `reddit-rss` | off | **barred** | `REDDIT_ENABLED_ACK` |
| `reddit-shreddit` | off | **barred** | `REDDIT_ENABLED_ACK` |
| `arctic-shift` | off | allowed | none |

Read `app/sources/reddit_gate.py` before enabling either Reddit lane. The short
version: the keyless lanes work *because* Reddit's `.json` endpoints 403 while
its RSS does not, which is routing around an access control; and storing posts
makes the operator a GDPR controller with no lawful basis and no way to honour
erasure.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `RESEARCH_HOSTED` | `true` | Fail-closed. Unset means hosted, which bars Reddit. |
| `RESEARCH_ENABLED_SOURCES` | `hackernews,web-keyless` | Comma-separated ids. Unknown ids are reported at `/v1/health`, not ignored. **Read by the app too** — `parseOperatorEnabledSources` in `apps/chat/lib/signals/providers.ts` parses it the same way, because the app also declines to ask for a source the operator did not enable. |
| `GITHUB_TOKEN` | — | Required by the `github` source. |
| `REDDIT_ENABLED_ACK` | — | Required by both Reddit sources, in addition to enabling the id. |
| `RESEARCH_SEARXNG_URL` | — | **Set it.** Last rung of the keyless ladder, and on a residential connection the only rung that answers: DuckDuckGo serves the sidecar a challenge page, so with this unset `web-keyless` reports `blocked` and Hacker News becomes the only working source — which is how a consumer-parenting idea got researched against Hacker News. Stays a URL because the sidecar runs on the host in dev, where a compose service name would not resolve. |
| `OPENAI_API_KEY` | — | **Required by the simulation lane, in THIS process's own environment.** The Next.js app having it is irrelevant — `/v1/simulate` calls the model from here. Without it every agent fails at call time and the run returns zero reactions. Cost one failed run to discover, which is why it is now first in this table. In dev, start the sidecar through `bunx dotenv-cli -e <repo>/.env.local -- …` so it inherits the repo-root key. |
| `RESEARCH_SIM_MODEL` | `gpt-5.6-luna` | CAMEL model type for the simulation. Moved off `gpt-4o-mini` on 2026-08-21: TAU-Bench measures agentic tool use in multi-turn conversation, which is exactly what an OASIS agent does, and 4o-mini scores 26.7% against luna's 70.7% for about +0.1¢ per run. Checked against `GET {base}/models/{id}` before a run starts: a typo is refused as `unknown-simulation-model` instead of failing per-agent at call time. CAMEL itself accepts any string, so this check is the only thing standing between a misspelling and a silent empty run. |
| `RESEARCH_SIM_REASONING_EFFORT` | derived from the model | Sent as `model_config_dict={"reasoning_effort": …}`. **Leave it unset.** Unset means "derive it": `none` for the `gpt-5.6-*` family, omitted for everything else. That split is not cosmetic — every OASIS action is a function tool call, CAMEL posts to `chat/completions`, and that family refuses tools there at any effort above `none`, while `gpt-4o-mini` refuses the key itself. Setting it to the **empty string** is different from leaving it unset: empty means "never send this", and it overrides the derived default. |
| `RESEARCH_SIM_BASE_URL` | — | OpenAI-compatible gateway for the simulation. Also the base for the model-id check above. |
| `RESEARCH_SIM_CONCURRENCY` | `8` | OASIS `semaphore=`. Its own default is 128, which will 429 a shared gateway. |

## Provenance

Every vendored file carries a banner naming its upstream path, licence and
commit SHA. The ledger is `THIRD_PARTY-research.md` at the repository root.
