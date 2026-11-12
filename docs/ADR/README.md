# Architecture decision records

An accepted ADR is immutable. To change a decision, write a new ADR that supersedes it; the only edit an
accepted ADR ever gets is its Status line.

## Write an ADR when

- the choice is hard to reverse: database, auth provider, hosting, AI vendor, module boundaries, licence;
- a future contributor would otherwise have to rediscover why something is the way it is.

Do not write one for bug fixes, UI tweaks or anything a commit message explains. Smaller durable "why"
notes go in `docs/DECISIONS.md`.

## Format

Nygard: Status / Context / Decision ("We will…") / Consequences. One page.

## Index

| # | Title | Status |
|---|---|---|
