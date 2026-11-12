# ADR-0005 — The research sidecar requires a shared secret, or serves loopback callers only

## Status
Accepted — 2026-11-12. Supersedes the "binds to `127.0.0.1`, because it has no auth" part of ADR-0001. Enforced by:
`apps/research/tests/test_api.py` (refusals without the token, the loopback-only default, the token never appearing in
`/v1/health`) and `apps/chat/lib/signals/sidecar.test.ts` (the app sends the token and names the variable when refused).

## Context
ADR-0001 kept the sidecar safe by binding it to `127.0.0.1`. Its two working endpoints spend money: `/v1/simulate`
spends the sidecar's own model key and `/v1/signals` makes search calls (and spends `GITHUB_TOKEN` when that source is
on). Loopback binding stops working the moment the app runs somewhere else (on Vercel, for example) and has to reach
the sidecar over a network, and a security review before the public release found nothing else protecting it.

## Decision
We will check every caller of `/v1/signals` and `/v1/simulate` in one FastAPI dependency,
`apps/research/app/main.py::require_caller`:
- With `RESEARCH_SIDECAR_TOKEN` set, every caller must send `Authorization: Bearer <token>`, loopback included, compared
  in constant time. The app sends it from `apps/chat/lib/signals/sidecar.ts` and
  `apps/chat/lib/research/sidecar-simulation.ts`.
- With it unset, only loopback callers are served, and the sidecar logs one warning at startup. A stranger's first local
  run needs no setup.
- `RESEARCH_SIDECAR_ALLOW_UNAUTHENTICATED=true` serves any caller. It exists only for the Docker Compose sidecar, whose
  requests arrive from the Docker bridge rather than loopback and whose port is published on `127.0.0.1` only. It must
  never be set in a deployed environment. A set token always wins over it.

`/v1/health` stays open and reports which of the three modes is active (`caller_auth`), never the token.

## Consequences
- A deployment that runs the app and the sidecar on different hosts must set the same `RESEARCH_SIDECAR_TOKEN` on both.
  When they disagree, research lanes report `missing-credential` and name the variable.
- Without a token, any other process on the same host can still call the sidecar. That is the trade-off for a
  zero-setup first run; a reverse proxy on the same host that hides the caller's address would also get through.
- The request models cap what one call can spend (seat count and pitch length mirror the app's limits), so even an
  allowed caller is bounded.
