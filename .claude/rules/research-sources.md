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
- **The sidecar's endpoints spend money.** `/v1/signals` and `/v1/simulate` go through `app/main.py::require_caller`:
  `RESEARCH_SIDECAR_TOKEN` set means a bearer token is required from every caller; unset means loopback callers
  only. The compose sidecar turns the loopback check off (`RESEARCH_SIDECAR_ALLOW_UNAUTHENTICATED`) and relies on
  its `127.0.0.1` port binding instead. Both no-token modes also require `Host` to be `localhost`, `127.0.0.1` or
  `::1` (DNS rebinding); never drop that check. Guard: `tests/test_api.py::TestCallerAuth`.
- **Python 3.11 only** (the tested version; OASIS 0.2.6 itself allows `<3.15`); keep `mcp<2` (a guard for the OASIS extra). Use `apps/research/.venv`, never system Python/pytest/ruff.
- **Vendored files are not modernised or reformatted** (`app/text/cjk.py`, `app/text/relevance.py`,
  `app/pipeline/{dedupe,entity_extract}.py`, see `pyproject.toml` per-file-ignores). `ruff format` is not enforced.
- **`RESEARCH_ENABLED_SOURCES` must stay in `turbo.json` `globalEnv`:** `bun run dev` runs through turbo's strict env
  mode and drops any variable not listed there. Guard: `apps/chat/lib/env-schema.test.ts` (census of `serverEnvSchema`
  against `globalEnv`). The sidecar's own variables (`RESEARCH_SEARXNG_URL`, `RESEARCH_SIM_*`) are read by the Python
  process, not by turbo tasks.
- Source or policy change → update `apps/research/README.md` and `THIRD_PARTY-research.md` in the same commit.
