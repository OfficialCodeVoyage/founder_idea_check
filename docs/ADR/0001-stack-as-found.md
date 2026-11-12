# ADR-0001 — Keep the ChatJS stack and add a separate Python research sidecar

## Status
Accepted — 2026-11-12. Enforced by: none yet (no module-boundary tool). This records the stack as found when the
agent-operating structure was added.

## Context
Founder Idea Check was built on ChatJS (Apache-2.0): a Bun/turbo monorepo with a Next.js chat app, Drizzle on
Postgres, better-auth, tRPC and the Vercel AI SDK. The product added a gated phase engine, personas, an export and
demand research. The research needed Python libraries (MIT code adapted from `mvanhorn/last30days-skill`, and OASIS
for simulation, which pins Python 3.11 and pulls torch), which do not belong in a Node process.

## Decision
We will keep the inherited stack for the product (Next.js 16, Postgres 17 with pgvector, Drizzle, better-auth, tRPC,
AI SDK 6 with OpenAI models chosen in `apps/chat/chat.config.ts`), and run research as a separate FastAPI service in
`apps/research` that the chat app reaches only over HTTP. The sidecar owns every call to an external research
source and binds to `127.0.0.1`, because it has no auth and its endpoints spend money.

## Consequences
- Two languages and two test runners (vitest/bun test and pytest); the global code-review gate covers only the
  TypeScript side, so `ruff` and `pytest` are the Python side's only automatic checks.
- Source ids and the source permission gate exist in both languages and must be kept in step by hand
  (`.claude/rules/research-sources.md`).
- A deployment must run the sidecar privately next to the app. Its address is the config key `researchSidecarUrl`
  in `apps/chat/chat.config.ts`, not an environment variable (an env variable of the earlier name
  `RESEARCH_SIDECAR_URL` was declared but never read, and has been removed).
- Inherited ChatJS packages (`packages/{thread,cli,registry}`) stay until a later decision removes them.
