---
paths:
  - "CLAUDE.md"
  - "AGENTS.md"
  - "docs/**"
  - ".claude/**"
  - ".planning/**"
---
# Docs ownership — which doc owns which fact

| Changing… | Update in the same commit |
|---|---|
| the DB schema or a migration | `docs/DATABASE.md` |
| env vars or deploy config | the root `.env.example`, `README-DEV.md` |
| a prerequisite, a port or a quick-start command | `README.md`, `GETTING-STARTED.md` and `README-DEV.md` (the same commands in each) |
| a research source or its policy | `apps/research/README.md`, `THIRD_PARTY-research.md` |
| copied or adapted third-party code | `THIRD_PARTY.md` or `THIRD_PARTY-research.md`, plus `NOTICE` if it is a new upstream |
| a phase, criterion or borrowed gate idea | `apps/chat/lib/phases/REFERENCES.md` |
| a top-level dir or core module | `docs/ARCHITECTURE.md` |
| a domain term | `CONTEXT.md` |
| a hard-to-reverse choice | a new ADR in `docs/ADR/` (accepted ADRs are never edited) |
| an incident | `docs/INCIDENTS.md` entry with its guard, plus a rule bullet citing it |
| a command or a binding invariant | `CLAUDE.md` (≤200 lines) or `AGENTS.md` if every agent tool needs it |

- `.planning/` is public: no personal data, local paths or secrets.
- Rules live in CLAUDE.md and `.claude/rules/`; geography in `docs/ARCHITECTURE.md`. Point, don't copy.
