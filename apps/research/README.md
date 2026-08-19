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

Read `app/sources/reddit_gate.py` before enabling either Reddit lane. The short
version: the keyless lanes work *because* Reddit's `.json` endpoints 403 while
its RSS does not, which is routing around an access control; and storing posts
makes the operator a GDPR controller with no lawful basis and no way to honour
erasure.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `RESEARCH_HOSTED` | `true` | Fail-closed. Unset means hosted, which bars Reddit. |
| `RESEARCH_ENABLED_SOURCES` | `hackernews,web-keyless` | Comma-separated ids. Unknown ids are reported at `/v1/health`, not ignored. |
| `GITHUB_TOKEN` | — | Required by the `github` source. |
| `REDDIT_ENABLED_ACK` | — | Required by both Reddit sources, in addition to enabling the id. |
| `RESEARCH_SEARXNG_URL` | — | Optional last rung of the keyless ladder. Referenced by URL only — SearXNG is AGPL-3.0 and is deliberately absent from `docker-compose.yml`. |
| `RESEARCH_SIM_MODEL` | `gpt-4o-mini` | CAMEL model type for the simulation. |
| `RESEARCH_SIM_BASE_URL` | — | OpenAI-compatible gateway for the simulation. |
| `RESEARCH_SIM_CONCURRENCY` | `8` | OASIS `semaphore=`. Its own default is 128, which will 429 a shared gateway. |

## Provenance

Every vendored file carries a banner naming its upstream path, licence and
commit SHA. The ledger is `THIRD_PARTY-research.md` at the repository root.
