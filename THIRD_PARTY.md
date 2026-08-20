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

The AI Elements generator (`bunx ai-elements@latest add …`) strips provenance
the same way `shadcn add` does — it emits no licence header and no source
comment — so the rows below are the only record that these files are
Apache-2.0 code owned by somebody else. `apps/chat/biome.jsonc` excludes
`components/ai-elements` from linting precisely because these are vendored
copies, which is also why a formatter will never re-add what the generator
removed. `NOTICE` carries the matching 4(d) attribution.

| Component | Registry | Licence | Added | Pinned at | Notes |
|---|---|---|---|---|---|
| `apps/chat/components/ai-elements/canvas.tsx` | AI Elements | Apache-2.0 | 2026-08-19, `ai-elements@1.9.0` | [`1310612d305d6c2694a920ff87e38a74ec859e61`](https://github.com/vercel/ai-elements) (2026-03-06), `packages/elements/src/canvas.tsx` | **Verbatim** — `diff` against upstream at that SHA is empty. Wraps `@xyflow/react`'s `ReactFlow` with a `Background`. |
| `apps/chat/components/ai-elements/plan.tsx` | AI Elements | Apache-2.0 | 2026-08-19, `ai-elements@1.9.0` | [`1310612d305d6c2694a920ff87e38a74ec859e61`](https://github.com/vercel/ai-elements) (2026-03-06), `packages/elements/src/plan.tsx` | Upstream **except** the generator's alias rewrite: `@repo/shadcn-ui/components/ui/*` → `@/components/ui/*`, `@repo/shadcn-ui/lib/utils` → `@/lib/utils`. Nothing else differs. |
| `apps/chat/components/ai-elements/chain-of-thought.tsx` | AI Elements | Apache-2.0 | 2026-08-19, `ai-elements@1.9.0` | [`1310612d305d6c2694a920ff87e38a74ec859e61`](https://github.com/vercel/ai-elements) (2026-03-06), `packages/elements/src/chain-of-thought.tsx` | Same alias rewrite as `plan.tsx`, and nothing else. Pulls `@radix-ui/react-use-controllable-state`, already in the tree. |

Earlier files under `apps/chat/components/ai-elements/` arrived with the ChatJS
fork and are covered by the "Forked wholesale" row, not by these.

## Previously rejected — bar lifted for local-only use

**Policy reversal, 2026-08-20, by the project owner.** This repository is a
private, local-only project: it is not distributed, not deployed, not offered to
users over a network, and has exactly one user, who is also its author. Every
row below was disqualified on a licence ground that only bites on one of those
activities. With none of them happening, the ground does not apply and the bar
is lifted.

The table is KEPT rather than deleted, and the reason it is kept is the third
column. AGPL-3.0 obligations trigger on conveying the work or offering it as a
network service; a custom "no derivative works" clause triggers on distributing
a derivative. None of that is happening today. If it ever does, each row below
becomes a live obligation again, and the cost of discharging it is not the same
for every row — which is exactly what a "delete the table" reconciliation would
have thrown away.

| Candidate | Original ground | What it costs IF this ever ships or is networked |
|---|---|---|
| SearXNG, Redlib, self-hosted Firecrawl **in this compose file** | AGPL-3.0 attaches by packaging | Remove from `docker-compose.yml` and reference by URL, or publish this repo's source under AGPL-3.0. See the retired packaging rule below. |
| `firecrawl` **server** | AGPL-3.0 | Same as above. The npm client is MIT and was never barred. |
| `666ghj/MiroFish` | AGPL-3.0 | Same as above. `camel-ai/oasis` (Apache-2.0) remains the engine underneath regardless. |
| `zaidmukaddam/scira`, `khoj-ai/khoj` | AGPL-3.0 network copyleft | Offering either over a network obliges a source offer to every user. |
| `lobehub/lobehub` | Custom licence: derivative works need a commercial licence | Buy the commercial licence, or remove the derived code. |
| `open-webui/open-webui` | Forbids removing branding above 50 users | Keep the branding, or stay under 50 users. Irrelevant at one user. |
| `langgenius/dify` | Bars multi-tenant use; asserts an appearance patent on its design | Single-tenant is compliant. Multi-tenant is not, and the design patent is a separate exposure from the licence. |
| `origin-space/originui` | Redirects to a `coss` monorepo whose root LICENSE is AGPL-3.0 | Bar lifted, and the boundary is now MEASURED rather than assumed. `LICENSING.md` carves out exactly two directories as MIT — `apps/origin/` and `apps/ui/` — and `apps/origin/LICENSE.md` is a plain MIT notice ("Copyright (c) 2025 coss.com / Originally Copyright (c) 2025 Origin UI"). So Origin UI itself is MIT and always was; everything in `packages/` and the rest of the tree is AGPL. Take from `apps/origin/` only. Note `apps/ui/` is the Base UI successor and syncs its components FROM the AGPL `packages/ui`, so its MIT carve-out does not obviously cover the sources it imports. |

### Different risk class: no licence at all

These two are **not** copyleft. There is no licence, so the default applies and
all rights are reserved. Copyleft obligations attach to distribution; the
copyright owner's exclusive right of reproduction attaches to **copying**. That
makes these a distinct category, and their remediation is deletion and a
rewrite rather than a source offer.

| Candidate | Ground | Remediation if it ever matters |
|---|---|---|
| `FranciscoMoretti/ai-sdk-deep-research` | No `LICENSE` file — all rights reserved | Delete the copied code and reimplement the approach from the observable behaviour. |
| Arctic Shift **source** | `license: null` — all rights reserved | Same. Calling its public **API** was never barred and never needed to be. |

### Evaluated after the reversal and declined on merit

Not licence decisions. Recorded so the same two candidates are not re-costed.

| Candidate | Why it was declined |
|---|---|
| Origin UI `hooks/use-file-upload.ts` | Redundant. It is a headless dropzone with zero dependencies, which would be attractive if we had nothing — but `react-dropzone@^14.3.8` is already a dependency and already wired in `components/multimodal-input.tsx` (`useDropzone`, `getRootProps`, `isDragActive`, `onDrop`, `accept`). Replacing a working, maintained library with a vendored copy of someone else's reimplementation is a downgrade. |
| Origin UI `ui/multiselect.tsx` | No call site. 619 lines, and its only dependency (`cmdk`) is already present, so the cost is low — but there is no multi-value input anywhere in this UI to attach it to. Unimported components rot: they are not exercised, not linted into shape by use, and become misleading when a real requirement finally arrives with different needs. Revisit when something actually needs to select many of a thing. |

### Provenance discipline: reviewed after the reversal, and KEPT

Two follow-up tasks proposed dropping the attribution and SHA-pinning overhead
now that the licence pressure is gone. Both were evaluated and both are
declined, because in each case the licence was only ever half the reason.

| Proposed removal | Why it stays |
|---|---|
| The Apache-2.0 §4(d) `NOTICE` attributions for ChatJS and AI Elements | §4(d) attaches to distribution, so strictly it is not triggered by a private tree. But the notice is also the only record of WHAT was taken and HOW it was modified — the AI Elements generator emits files with no licence or author header at all, so deleting this leaves vendored third-party code indistinguishable from ours. That is a comprehension cost paid forever to save 47 lines once. |
| The pinned upstream SHAs and the `gh api …&since=` line in every vendored file's banner | This is not a licence mechanism, it is a SECURITY mechanism, and the header of this very file says why: borrowed code is frozen, and upstream fixes never arrive on their own. The pinned SHA plus that one command is the entire apparatus for discovering that an upstream fixed a bug in code we copied. Removing it does not reduce obligation, it removes the ability to notice. |
| The `biome.jsonc` exclusion of `components/ai-elements` | Kept for the same reason. It exists so a formatter cannot rewrite vendored files and destroy the ability to `diff` them against upstream. That diff is how the previous row's mechanism is actually exercised. |

The general rule this leaves behind: a practice justified on BOTH licence and
engineering grounds does not become removable when only the licence ground is
withdrawn. Check the second reason before deleting.

## Still barred — and NOT for licence reasons

The reversal above is a licence decision. It does not reach these, and reading
it as a blanket "everything is allowed now" is the specific mistake this
section exists to prevent.

| Candidate | Why it is still barred | Category |
|---|---|---|
| Reddit torrent dumps | Redistributed user content including since-deleted posts. This is the erasure problem in its purest form, and a data-protection decision is not a licence decision. Independently, the dumps are 3.97 TB against 63 GB of free disk, so the task as specified is also physically impossible. | Data protection + physically infeasible |
| `tldraw/tldraw` | Not adopted, but the previously recorded reason was WRONG and the real one is worse. Verified 2026-08-20 against `LICENSE.md` and `apps/docs/content/sdk-features/license-key.mdx` upstream. (a) The licence explicitly PERMITS this use: it bars "Production Environments" and defines those to exclude internal development, and a private local stack on loopback is a Development Environment by its own definition. (b) There is no watermark here — unlicensed **development** runs fully, and the watermark belongs to the *Hobby* licence tier; nothing is transmitted from development environments either. (c) What actually happens is a cliff, not a degradation: in production (HTTPS, non-loopback host, `NODE_ENV=production`) an unlicensed SDK "logs errors to the console and, after five seconds, **stops rendering the editor**". So a canvas built on tldraw would work perfectly throughout development and die on first deploy — the worst possible failure timing. `@xyflow/react` already works, is already wired, and has no such cliff, so the swap is speculative work with an invisible tripwire. | Works in dev, stops rendering in prod |
| `not-an-aardvark/snoowrap` | Archived 2023; depends on `request`, deprecated 2020. Rot, not licensing. | Unmaintained dependency |
| `redlib-org/redlib` | Licence bar lifted, then **rejected on measurement**. Redlib is a proxy: it inherits this machine's egress IP and fetches Reddit's `.json` endpoints, which are the blocked ones. Probed 2026-08-20 with `redlib:latest` v0.36.0 running locally — every route returned its "Failed to parse page JSON data" error page, and its own logs showed `403 Forbidden` from Reddit on `/r/rust/hot.json`. Meanwhile the `.rss` endpoints this repo already uses returned **200** with 50 KB of Atom from the same machine and the same second. Adopting Redlib would have swapped a working lane for a broken one. Upstream tracks this as issue #446. | Does not work, measured |
| Arctic Shift **self-hosted ingestion** | Licence bar lifted; **blocked on physics**, and it is the same wall as the Reddit dumps rather than a separate one. Upstream's README opens its usage section with "First download one or more dumps" and directs bulk users to "use the monthly dumps instead" of the API. That corpus is 3.97 TB against 66 GB free. The public API remains fine to call and this repo still calls it — which is why the retry/backoff/overload machinery in `arctic_shift.py` was NOT deleted as planned. | Physically infeasible |

**The GDPR and erasure posture is unchanged.** `DemandSignal` still has no
`author` field; usernames are still dropped at parse time in
`apps/research/app/sources/reddit_rss.py` and
`apps/research/app/sources/reddit_shreddit.py`, or never requested at all. That
is a data-protection decision taken on its own merits and it survives this
reversal untouched. Do not conflate the two.

## The research subsystem has its own ledger

`apps/research/**`, `apps/chat/lib/research/**` and `apps/chat/lib/signals/**`
are recorded in **`THIRD_PARTY-research.md`**, kept separate only so the two
files can be edited without conflicting. **Both are authoritative — a licence
audit must read both.** Every entry there pins the upstream SHA it was taken
at, because borrowed code is frozen and upstream fixes never arrive on their
own.

## Packaging rule for AGPL services — RETIRED 2026-08-20

The rule read: SearXNG, Redlib and self-hosted Firecrawl are AGPL-3.0; calling
them over HTTP is clean, but bundling them in a shipped `docker-compose.yml`
puts AGPL work in our distribution artefact and triggers the source-offer
obligation, so reference them by URL and never vendor or patch.

**Retired because its premise is a shipped artefact, and this compose file is
not one.** It describes a local development stack on one machine. Nothing is
conveyed to anybody, so there is no distribution for AGPL to attach to.

The reasoning is preserved verbatim above rather than deleted, because it is
correct and becomes live again the moment this repository is published or the
compose file is used to deploy anything for anyone else. If that day comes: the
AGPL services must either come out of the file, or this repository's own source
must be offered under AGPL-3.0.

One part of the old rule stands on its own merits and is NOT retired: **never
vendor or patch these services.** A patched build is a maintenance liability
and forfeits upstream security fixes, which was true before the licence
question and stays true after it.
