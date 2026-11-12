---
paths:
  - "apps/chat/lib/db/**"
  - "apps/chat/drizzle.config.ts"
  - "apps/chat/scripts/with-db.sh"
  - "apps/chat/scripts/db-branch-*.sh"
---
# Database — landmines

- **Never run `bun run db:migrate` against a database that was built with `db:push`**, such as the maintainers'
  local `ic-pg`. Its migration bookkeeping is incomplete, and drizzle's migrator applies every pending file in ONE
  transaction: the first already-pushed change aborts the whole batch. Apply a new migration to such a database with
  `docker exec -i ic-pg psql -U postgres -d ideacheck < <file>.sql`. Proof: `docs/DATABASE.md` (push versus migrate).
  A new install is the other case: it has no history, and `bun run db:migrate` is how it gets its schema.
- **`db:migrate` forces `VERCEL_ENV=production`**, and `lib/db/migrate.ts` skips unless it is set; `bun run build`
  runs the same migrator first. A production build therefore applies migrations.
- **CHECK constraints are written by hand** (Incident 9). drizzle-kit once recorded the `Part_*` checks in a snapshot
  and emitted no DDL (`lib/db/migrations/0051_absent_part_checks.sql`). Hand-added migrations (`0046`, `0051`) say so
  in their header and guard with `DO` blocks so they also run on push-built databases. Never trust a generated CHECK.
  No test replays the chain against an empty database; the replay recipe is in `docs/DATABASE.md`.
- **New migrations need a strictly larger journal `when`** than every existing entry in `meta/_journal.json`; the
  migrator skips a file whose timestamp is not newer than the last applied one.
- **Replay a new migration on a throwaway `pgvector/pgvector:pg17` container** before touching `ic-pg`. Plain
  `postgres:17-alpine` fails: migration `0046` creates the `vector` extension.
- **`ProjectPhaseAttempt` is append-only and keyed `(projectId, phaseKey, evaluatedAt)`, never by attempt number**
  (ADR-0004, Incident 4). Nothing updates or prunes it, and it has no uniqueness on `(projectId, phaseKey)`. Guard:
  `lib/db/phase-attempt.test.ts`.
- **`ProjectFact.origin` and `correctedAt` move together** (`ProjectFact_origin_coherent`: founder ⇔ corrected;
  ADR-0003). Provenance is never inferred from `sourceMessageId IS NULL`. Guard: `lib/db/fact-assertion.test.ts`.
- **`SimulationRun.usable` NULL means "not assessed", never false** (`SimulationRun_assessment_coherent`, Incident 1).
  Readers narrow on `null` first; `!usable` folds the two states together. Guard: the CHECK only, no test.
- Schema or migration change → update `docs/DATABASE.md` in the same commit.
