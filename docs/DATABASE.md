# Database

Everything the app stores lives in one PostgreSQL 17 database with the pgvector extension, reached through Drizzle
ORM (`apps/chat/lib/db/schema.ts`): accounts, chats, the phase engine's facts and verdicts, personas, simulation
runs, and the embeddings that choose which facts a later phase sees. There is no second store. The reasons are in
[ADR-0002](ADR/0002-postgres-pgvector-for-embeddings.md).

The app needs one setting, `DATABASE_URL`. The Docker Compose stack in this repository starts a Postgres that fits:
the `pgvector/pgvector:pg17` image on `127.0.0.1:5433`, user and password `postgres`, database `ideacheck`.

```
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/ideacheck
```

Any other Postgres 17 works if it ships pgvector; several managed Postgres services do. The stock `postgres` image
does not, and on it the migration run fails at `0046_reflective_prima.sql`, which has to create the `vector`
extension.

## Create the database for a new install

One command, from the repository root, with Postgres running and `DATABASE_URL` set in `.env.local`:

```bash
bun run db:migrate
```

It applies every file in `apps/chat/lib/db/migrations/`, in order, in a single transaction, and prints
`Migrations completed`. Run it against a database that has never been touched by `db:push`. Running it again is a
no-op.

`bun run build` runs the same migrator first (`tsx lib/db/migrate`), but the migrator does nothing unless
`VERCEL_ENV=production`, which Vercel sets on production deployments. Anywhere else, run `bun run db:migrate`
yourself: it sets the variable for that one command.

Do not build a new install with `bun run db:push`. `push` makes the database match `schema.ts` and skips the
hand-written parts of the chain (the `vector` extension, the ledger backfill, the guarded constraints). It exists for
maintainers iterating on the schema (see [push versus migrate](#push-versus-migrate-history-and-rule)).

## Tables

Table names are the Drizzle names in `lib/db/schema.ts`. The comments there are the column-level reference; this is
the map.

| Table | Holds | Worth knowing |
|---|---|---|
| `user`, `session`, `account`, `verification` | better-auth's tables | Lowercase names, owned by the auth library. |
| `UserCredit` | One balance per user, in cents | Default 50, which is $0.50. `canSpend` is `credits > 0`; a turn in flight may take it slightly negative. |
| `UserModelPreference` | Which models a user turned on | |
| `Project` | One idea a founder is validating | Owns facts, phases, tasks, personas and simulation data; all of those cascade on delete. |
| `Chat`, `Message`, `Vote` | Conversations | `Chat.projectId` is `ON DELETE SET NULL`: deleting a project keeps its chats. |
| `Part` | One row per message part | Typed, prefix-named columns (`text_*`, `tool_*`, `data_*`, ...) instead of a JSON blob. Seven CHECK constraints (below). |
| `Document`, `Suggestion` | Artifacts the assistant writes, and edit suggestions | Versioned: the primary key is `(id, createdAt)`, so every save is a new row. Persona documents are `kind = 'persona'` with a `projectId`. |
| `McpConnector`, `McpOAuthSession` | MCP connector settings | Inherited from ChatJS. Connectors are disabled in `chat.config.ts`; the tables remain. |
| `ProjectPhase` | Current state of one phase of one project | One row per `(projectId, phaseKey)`, updated in place. |
| `ProjectPhaseAttempt` | The gate's refusal ledger | Append-only, one row per gate run. See [ADR-0004](ADR/0004-gate-refusal-ledger.md). |
| `ProjectFact` | The fact store | Unique on `(projectId, key)`. Carries provenance (`origin`) and an optional embedding. See [ADR-0003](ADR/0003-fact-provenance.md). |
| `ProjectTask` | The founder's state for one unblocking task | `taskId` is deterministic, `phaseKey::criterionId::kind`, so re-running the gate reconciles with what the founder already ticked. `unknown` is deliberately not a storable state. |
| `SimulationProfile` | The founder's stated demographics for one simulated person | One row is one agent (a "seat"), not one customer segment. |
| `SimulationRun` | One persona-simulation run | `usable` has three states: true, false, and NULL for "not assessed". |

Personas are not a table of their own. A persona is a `Document` row with `kind = 'persona'`, scoped by
`Document.projectId` and read through `Document_project_kind_idx`. `Document.messageId` is nullable for them (they
are regenerated from the fact store, not produced by one assistant turn), and the public-visibility queries join
through `Message` and `Chat`, so a persona document is visible to its owner only.

An earlier `ProjectPersona` table was dropped (`0049_naive_gargoyle.sql`) because nothing in the history of the
project ever wrote to it; its one reader returned an empty list every time, and the simulation told founders they had
no personas while a finished persona sat in `Document`. A plausible empty table next to the real store was the bug.

### Why `ProjectPhase` and `ProjectPhaseAttempt` are separate

`ProjectPhase` is the hot read: one row per phase, updated in place. It is not a cache of the ledger's newest row. A
phase can be activated with no verdict and no ledger row, and `phaseOrder`, `status` and `attemptCount` are not
projections of any attempt. The ledger is keyed by `(projectId, phaseKey, evaluatedAt)`, not by the attempt number.
The number comes from a mutable counter; if that counter ever fell behind its own maximum (a restore, a manual
repair), every later insert would raise a primary-key violation, roll back the transaction it shares with the phase
row, and collide again on the next turn: a permanent write outage that freezes a stale PASS. A clock cannot do that.
The retention is unbounded (a stored verdict is 6 to 8 KB), which has one consequence worth knowing: the founder's
words quoted in a verdict outlive the message they quote, until the project is deleted. Details are in ADR-0004.

### Why a fact has an `origin`

Every fact used to be written by the extractor. Once a founder could correct or add one, "where did this claim come
from" needed a column: the gate reads facts, and personas, simulations and the export are grounded in them, so an
unmarked founder edit could be laundered into evidence. `origin` is `extracted` or `founder`; `correctedAt` is set
exactly when `origin = 'founder'`. It is never inferred from `sourceMessageId IS NULL`, because that column is
`ON DELETE SET NULL` and is already null for some extractor writes. See ADR-0003.

### Embeddings

`ProjectFact.embedding` is `vector(1536)` with an HNSW cosine index, plus `embeddingModel`, `embeddingDims` and
`embeddedAt`. The column is nullable on purpose: a fact whose embedding failed is still a fact, and a keyword ranker
selects it. `ProjectFact_embedding_labelled` makes an embedding without its model and width unrepresentable, because
two models at the same width give cosine distances that are valid arithmetic and meaningless as similarity.
Correcting a fact's value clears all four embedding columns together, and the next turn re-embeds the row.
The width is a schema decision: changing it is a migration plus a full re-embed (ADR-0002).

## CHECK constraints

Thirteen CHECK constraints are declared in `schema.ts`. Each one makes a state that would mislead a reader
unstorable instead of merely discouraged.

| Constraint | Table | Refuses |
|---|---|---|
| `Part_text_required_if_type_text`, `Part_reasoning_required_if_type_reasoning`, `Part_file_required_if_type_file`, `Part_source_url_required_if_type_source_url`, `Part_source_document_required_if_type_source_document`, `Part_tool_required_if_type_tool`, `Part_data_required_if_type_data` | `Part` | A part whose type needs fields it does not have: a text part with no text, a tool part with no `toolCallId` or `state`, a file part with no URL. |
| `ProjectFact_confidence_range` | `ProjectFact` | A confidence outside 0 to 100. |
| `ProjectFact_embedding_labelled` | `ProjectFact` | An embedding without its model and width, or labels without an embedding. |
| `ProjectFact_origin_coherent` | `ProjectFact` | A founder-asserted fact with no correction time, or an extracted fact that has one. |
| `SimulationProfile_age_range` | `SimulationProfile` | An age outside 13 to 120 (the range the simulator accepts). |
| `SimulationProfile_text_present` | `SimulationProfile` | A blank handle, gender or country, or an MBTI that is blank rather than NULL. The empty string, not NULL, is the trap: it slips past `?? placeholder` downstream. |
| `SimulationRun_assessment_coherent` | `SimulationRun` | `usable` NULL without a stated reason, or a reason beside a non-NULL `usable`. |

No unit test talks to a database, so these are checked by replaying the chain on a throwaway database (below).

## Migrations

Files live in `apps/chat/lib/db/migrations/`, with the journal and per-migration snapshots in `meta/`.

To change the schema:

1. Edit `apps/chat/lib/db/schema.ts`.
2. `bun run db:generate` from the repository root.
3. Review the generated SQL. **Write any CHECK constraint by hand.** drizzle-kit can record a CHECK in its snapshot
   and emit no SQL for it. That is how seven constraints went missing (below).
4. Replay the chain on a throwaway database before trusting it.
5. Update this document if the change alters what it describes.

Rules that have each cost someone time:

- **A migration that needs something drizzle-kit never emits is hand-written, and says so in its header.**
  `0046` creates the `vector` extension. `0048` backfills the ledger from existing phase rows. `0051` adds the seven
  `Part` constraints. `0052` and `0053` are written to be re-runnable (`ADD COLUMN IF NOT EXISTS`, guarded
  `ADD CONSTRAINT` in `DO` blocks) so they also run on a database that `push` already changed.
- **Split a rename-looking change into two migrations.** One diff that drops one table and creates a similar one
  makes drizzle-kit ask whether it was a rename, which needs a terminal and, answered wrongly, carries the dead
  table's columns forward. `0049` (drop) and `0050` (create) are separate for this reason.
- **A new migration needs a `when` in `meta/_journal.json` strictly larger than every existing entry.** The migrator
  skips a file whose timestamp is not newer than the last one applied.
- **The migrator applies all pending files in one transaction.** One failing file takes the others with it.
- **Do not run `bun run db:up`.** drizzle-kit 0.31 uses the flat migration layout; `up` targets the newer folder
  layout.
- `bun run db:check` (drizzle-kit's consistency check, no database needed) should say `Everything's fine`.

### Replay recipe

Prove a new migration on a database that is not yours:

```bash
docker run --rm -d --name replay-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=replay \
  -p 127.0.0.1:55432:5432 pgvector/pgvector:pg17
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/replay bun run db:migrate
```

Use the pgvector image: plain `postgres` fails at migration `0046`. A value already in the environment wins over
`.env.local`, so the throwaway `DATABASE_URL` is the one used. Then check the result against the schema: the
number of CHECK constraints should match the number declared in `schema.ts` (13 today),

```sql
SELECT count(*) FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace;
```

and, for each, `pg_get_constraintdef` should match a database you trust. Remove the container when you are done
(`docker rm -f replay-pg`).

## Push versus migrate: history and rule

Drizzle offers two ways to make a database match the schema, and they keep different records.

- `db:migrate` runs the SQL files and records each in `drizzle.__drizzle_migrations`.
- `db:push` diffs `schema.ts` against the live database and changes it directly. It records nothing in that table and
  never runs the hand-written SQL.

The maintainers' local database was built with `push` while the schema was changing every day. Two things followed.

**First, the migrator cannot be pointed at a push-built database.** Its bookkeeping is incomplete, and the migrator
replays everything it believes is pending in one transaction, so the first change `push` had already made aborts the
whole batch.

**Second, nobody had ever run the chain from an empty database, and when it was run, it built the wrong schema.**
All files applied without error, and the result had 4 of the 11 CHECK constraints `schema.ts` declared at that time.
`0044` recorded seven `Part` constraints in its snapshot and emitted no SQL for them. Every later `generate` diffed
against a snapshot that already claimed they existed, so no later migration emitted them either. They were real on
every developer machine, because `push` put them there, and absent from any database the chain built, which is every
production database. The consequence: a `text` part with no text, a tool part with no call id, a file part with no URL
were all storable, on the table the app writes on every turn. `0051_absent_part_checks.sql` repairs it, guarded so that
push-built databases (which already have the constraints) still run it. After it, the chain applied from empty with
every declared constraint present, `db:check` was clean, and `pg_get_constraintdef` for each constraint was identical
to the push-built database. This is Incident 9 in [INCIDENTS.md](INCIDENTS.md).

The rules that come out of it:

1. **A database is built by one path.** A new install, a test database and production use `bun run db:migrate`.
   Do not mix `push` and `migrate` on one database.
2. **Maintainers: never run `bun run db:migrate` against the local dev database (`ic-pg`),** which was built with
   `push`. Apply a new migration to it with `docker exec -i ic-pg psql -U postgres -d ideacheck < <file>.sql`,
   after replaying the chain on a throwaway database. The other option, if the data is disposable, is to drop the
   database's volume and build it again with `db:migrate`.
3. **`drizzle-kit push` is never clean here, and that is known.** `Suggestion`'s foreign key name,
   `Suggestion_documentId_documentCreatedAt_Document_id_createdAt_fk`, is 64 characters and Postgres truncates
   identifiers at 63. drizzle-kit compares its own untruncated name with the stored one, never matches, and proposes
   dropping and re-adding that key (and the table's primary key) on every push. The name is the same on every
   database, so it changes nothing at runtime. Its cost is that "push wants to change something" carries no signal;
   that is what hid the missing constraints. Renaming the constraint is a real schema change and has not been made.
