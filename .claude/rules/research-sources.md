---
paths:
  - "apps/research/app/**"
  - "apps/research/pyproject.toml"
  - "apps/chat/lib/signals/**"
  - "apps/chat/tools/platform/deep-research/**"
---
# Research sources and the sidecar — landmines

- **A source id lives in four places that must agree:** `apps/research/app/sources/registry.py::ALL_DESCRIPTORS`,
  `apps/research/app/config.py::KNOWN_SOURCE_IDS`, `apps/chat/lib/signals/providers.ts::ALL_PROVIDERS` and the
  `SignalSourceId` union in `lib/signals/types.ts`. No test reads both languages; check by hand.
- **The permission gate is mirrored:** Python `sources/base.py::assert_permitted`, TypeScript
  `lib/signals/provider.ts::decideProviderGate`. Same order: hosted bar, self-host bar, operator toggle,
  credentials. Missing credentials never fall back to a keyless path. Guard: `apps/research/tests/test_gate.py`.
- **Defaults fail closed:** `RESEARCH_HOSTED` unset means hosted; `RESEARCH_ENABLED_SOURCES` unset means
  `hackernews,web-keyless`; unknown ids are refused and reported at `/v1/health`, never silently dropped.
- **An adapter never returns `[]` to mean failure.** It raises a named `SourceError` subclass (`app/errors.py`);
  an empty hit list is a finding. Guard: `tests/test_adapters.py`.
- **No author is ever stored.** `DemandSignal` (`lib/signals/types.ts`) has no `author` field on purpose; the
  Reddit adapter never requests the author and sets `author=None` at parse time as a backstop.
- **Reddit: public-API access only.** `arctic-shift` is the one Reddit lane. A lane that reads Reddit's own
  unauthenticated endpoints routes around an access control and does not ship (two did, and were removed before
  the public release). The reasoning is `apps/research/app/sources/reddit_gate.py`; the gate machinery stays.
- **The sidecar has no auth and its endpoints spend money:** bind it to `127.0.0.1` only (`docker-compose.yml`).
- **Python 3.11 only** (OASIS); `mcp<2` is load-bearing. Use `apps/research/.venv`, never system Python/pytest/ruff.
- **Vendored files are not modernised or reformatted** (`app/text/cjk.py`, `app/text/relevance.py`,
  `app/pipeline/{dedupe,entity_extract}.py`, see `pyproject.toml` per-file-ignores). `ruff format` is not enforced.
- **`RESEARCH_ENABLED_SOURCES` must stay in `turbo.json` `globalEnv`:** `bun run dev` runs through turbo's strict env
  mode and drops any variable not listed there. Guard: `apps/chat/lib/env-schema.test.ts` (census of `serverEnvSchema`
  against `globalEnv`). The sidecar's own variables (`RESEARCH_SEARXNG_URL`, `RESEARCH_SIM_*`) are read by the Python
  process, not by turbo tasks.
- Source or policy change → update `apps/research/README.md` and `THIRD_PARTY-research.md` in the same commit.
