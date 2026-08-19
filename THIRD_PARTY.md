# Third-party code

Provenance ledger for code copied into this repository. Borrowed code is
**frozen** — upstream fixes never arrive on their own — so every entry pins the
SHA it was taken at. To see what upstream fixed since:

```bash
gh api "repos/OWNER/REPO/commits?path=PATH&since=YYYY-MM-DD" --jq '.[].commit.message'
```

`shadcn add` writes files with **no licence or author header**, destroying
provenance at the moment of copy. Every registry component must be recorded here
by hand, at the time it is added.

## Forked wholesale

| What | Source | Licence | Pinned at | Notes |
|---|---|---|---|---|
| Entire application chassis | [FranciscoMoretti/chat-js](https://github.com/FranciscoMoretti/chat-js) | Apache-2.0 | `14113a98c2e3b7675562945ae8acf6a9e15d06be` (2026-08-06) | See `NOTICE` for the modification list. Transitively includes Apache-2.0 code from [vercel/chatbot](https://github.com/vercel/chatbot). |

## Vendored files

| What | Source | Licence | Pinned at | Notes |
|---|---|---|---|---|
| `apps/chat/prompts/persona/problem-validation-rubric.md` (kill rubric) | [assimovt/productskills](https://github.com/assimovt/productskills), `skills/problem-validation/SKILL.md` | MIT | `66f9cee5868d6daf9cf106b4a74090428d6fa83e` (2026-02-18) | Multiplicative score: Frequency × Intensity × Workarounds × WTP, each 1–5. Body is upstream **verbatim** (blob `76c5eda55400472773a4724b28e994c668d5b366`); only the Claude-skill YAML frontmatter was dropped. Repo is a single-commit release, so `main` == this SHA. |
| `apps/chat/prompts/persona/honesty-protocol.md` (skeptical persona) | [ferdinandobons/startup-skill](https://github.com/ferdinandobons/startup-skill), `startup-{design,positioning,pitch,competitors}/references/honesty-protocol.md` | MIT | `a5f97c317b93caedbb49d28f20e9ec283b2ec087` (2026-07-01) | **Distilled, not verbatim**: the union of those four near-identical files (3,107 words) reduced to ~600, because this text is prepended to the system prompt on every turn. Kept the `[Data]`/`[Estimate]`/`[Assumption]`/`[Opinion]` labels, the red/yellow flag taxonomy and the anti-pattern push-back lines. Dropped everything tied to the upstream file-writing workflow (PROGRESS.md, per-document Flags footers, the Phase 8 1–10 scorecard). The "Blunt, not cruel" section is ours, not upstream. |

Still planned, with their licences verified by direct probe:

| Planned | Source | Licence | Verified |
|---|---|---|---|
| `src/deep-research.ts` (research loop) | [dzhng/deep-research](https://github.com/dzhng/deep-research) | MIT | 19,574★ |
| Source adapters (Python sidecar) | [mvanhorn/last30days-skill](https://github.com/mvanhorn/last30days-skill) | MIT | 58,719★ |
| Agent simulation engine | [camel-ai/oasis](https://github.com/camel-ai/oasis) | Apache-2.0 | 5,035★ |
| `lib/tools/search/providers/` | [miurla/morphic](https://github.com/miurla/morphic) | Apache-2.0 | 9,049★ |
| Fan-out topology + prompts | [langchain-ai/open_deep_research](https://github.com/langchain-ai/open_deep_research) | MIT | 12,641★ |

## Shapes and vocabularies (no file copied)

Design taken, code not. Nothing from these projects ships in this repo — the
shape was reimplemented against our own types. Recorded so the origin of the
design is traceable and the licence question stays answered. Full extraction
notes, with the quoted upstream source, live in
`apps/chat/lib/phases/REFERENCES.md`.

| What was taken | Source | Licence | Pinned at | Reimplemented in |
|---|---|---|---|---|
| `GateDecision` shape (`PASS`/`WARN`/`BLOCK` + required human-readable `reason`), most-severe-first rule order, and the empty-set guard (0 of 0 must not score 100%) | [QuintinBotes/warden](https://github.com/QuintinBotes/warden) `packages/orchestrator/src/evaluate-exit-criteria.ts`, `packages/core/src/change-surface.ts` | MIT | `2736c2b35e6db8a9031a0a1aa7a6c247970bfe19` (2026-07-10); guard from `d469abff00cc18aa68bcad005ddf9989c5e62227` | `apps/chat/lib/phases/types.ts` (`GateVerdictSchema`), `apps/chat/lib/phases/gate.ts` (`decideGate`, guards 2/3/6) |
| `Criterion.type` enum (`artifact-exists` \| `requirement-satisfied` \| `metric-threshold` \| `phase-completed` \| `custom`) and the `qualityGates` shape (`enabled`/`autoRetry`/`maxRetries`) | [codename-co/devs](https://github.com/codename-co/devs) `public/schemas/methodology.schema.json` | MIT | `ce05b2c3dce2665e00942c540406a8bf78b39a13` (file last changed `fa3bc4758147395545f37f77c666af2c25c4fa82`, 2025-10-19) | `apps/chat/lib/phases/types.ts` (`ExitCriterionSchema`, `GateConfigSchema`) |

Deliberate divergences from both, and why, are recorded in `REFERENCES.md`. The
short version: warden's library WARNs when it cannot evaluate, we `BLOCK` —
phase advance is our merge, and there is no second gate behind it. And devs'
`Criterion` marks every discriminating field optional; ours is a discriminated
union on `type`.

## shadcn registry components

Record every `shadcn add` here. Sources in use:

| Registry | Licence | URL |
|---|---|---|
| shadcn/ui | MIT | https://ui.shadcn.com |
| AI Elements | Apache-2.0 | https://registry.ai-sdk.dev |

| Component | Registry | Added |
|---|---|---|
| _(none added yet)_ | | |

## Rejected — do not reintroduce

These were evaluated and disqualified. Recorded so they are not re-evaluated.

| Candidate | Why it is barred |
|---|---|
| `tldraw/tldraw` | Proprietary; requires a paid runtime licence key in production. |
| `666ghj/MiroFish` | AGPL-3.0. Use `camel-ai/oasis` (Apache-2.0) underneath instead. |
| `origin-space/originui` | Now redirects to Cal.com `coss`, which is AGPL-3.0. Silent trap. |
| `lobehub/lobehub` | Custom licence: derivative works require a commercial licence. |
| `open-webui/open-webui` | Forbids removing branding above 50 users. |
| `langgenius/dify` | Bars multi-tenant use; asserts an appearance patent on its design. |
| `zaidmukaddam/scira`, `khoj-ai/khoj` | AGPL-3.0 network copyleft. |
| `firecrawl` **server** | AGPL-3.0. The npm client is MIT and is fine. |
| `FranciscoMoretti/ai-sdk-deep-research` | **No licence at all** — all rights reserved. |
| Arctic Shift **source** | `license: null`. Calling its public API is fine; copying code is not. |
| Reddit torrent dumps | Redistributed user content, incl. since-deleted posts. GDPR exposure. |
| `not-an-aardvark/snoowrap` | Archived 2023; depends on `request`, deprecated 2020. |

## Packaging rule for AGPL services

SearXNG, Redlib and self-hosted Firecrawl are **AGPL-3.0**. Calling them over
HTTP is clean. Bundling them in a shipped `docker-compose.yml`, or shipping a
patched build, puts AGPL work in our distribution artefact and triggers its
source-offer obligation. Reference them by URL in docs; never vendor or patch.
