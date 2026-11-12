# Architecture decision records

An accepted ADR is immutable. To change a decision, write a new ADR that supersedes it; the only edit an
accepted ADR ever gets is its Status line.

## Write an ADR when

- the choice is hard to reverse: database, auth provider, hosting, AI vendor, module boundaries, licence;
- a future contributor would otherwise have to rediscover why something is the way it is.

Do not write one for bug fixes, UI tweaks or anything a commit message explains. A smaller durable "why" goes in
the commit message.

## Format

Nygard: Status / Context / Decision ("We will…") / Consequences. One page.

## Index

| # | Title | Status |
|---|---|---|
| [0001](0001-stack-as-found.md) | Keep the ChatJS stack and add a separate Python research sidecar | Accepted |
| [0002](0002-postgres-pgvector-for-embeddings.md) | Keep embeddings in the one Postgres, with pgvector | Accepted |
| [0003](0003-fact-provenance.md) | Every fact records who asserted it, and a founder cannot raise a fact's confidence | Accepted |
| [0004](0004-gate-refusal-ledger.md) | Keep every gate verdict, in an append-only ledger keyed by time | Accepted |
