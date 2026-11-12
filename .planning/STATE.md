# Project State
_Last updated: 2026-11-12 (`chore/agent-setup-261112`)_

<!-- This file is public. Nothing private goes here: no personal data, no local paths, no secrets. -->

## Current focus
- Branch: `release/public-prep-261112` (not pushed). Agent-structure setup on `chore/agent-setup-261112`.
- In flight: preparing the first public open-source release of Founder Idea Check.
- Next: 1) code review of the QA batch, then browser QA of its seven manual checks
  2) fix wave (QA findings, three product decisions, deploy-safety items)
  3) open-source clean-up (licences, rebrand, CI, docs for strangers), then the release gate.
- Waiting on owner: nothing.
- Setup progress and the mapping table: `.planning/agent-setup.md`.

## Roadmap (next 3–5 items)
- First public release: clean history, green CI, a stranger can clone and boot it.
- Idea finding for a market: a pre-project stage that returns ranked, evidence-backed problem
  candidates and hands the chosen one to phase 1. Starts with a one-page spec in `docs/specs/`.
- Diagnose what freezes a tool-input stream mid-document (today it is loud and recoverable, not explained).

## Decisions in flight
- 2026-11-12 — Release as Apache-2.0 open source; public history is a clean replay of our commits on
  the upstream fork point — keeps upstream attribution intact and private material out.
- 2026-11-12 — The two keyless Reddit scraper lanes are removed; the Arctic Shift public-API lane stays
  — the scrapers route around an access control (see `.claude/rules/research-sources.md`).

### Blockers/Concerns
<!-- Push gates go here as top-level bullets. Clear with a RESOLVED: line inside the bullet; never delete. -->
- **Public-release push blocker (2026-11-12, from `release/public-prep-261112`): do NOT git push origin main
  until the release gate passes.** Why: the target repository is public, so the first push publishes
  every commit it carries. The gate proves the history holds no private material and that the tested
  tree is the one that ships.

## Session log (newest first, one line each, keep ≤20)
- 2026-11-12 — Agent-operating structure installed (hooks, rules, state, docs skeleton).
