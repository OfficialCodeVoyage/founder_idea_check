## The problem

<!-- What was wrong or missing? Link the issue if there is one: "Fixes #123". -->

## What this changes

<!-- The fix, in a few lines. Mention anything a reviewer might not expect. -->

## How I checked it

<!-- Commands you ran and what you saw, or the steps you clicked through. -->

- [ ] `bun run verify` passes
- [ ] `bun run test:unit` passes
- [ ] Sidecar changes only: `ruff check app tests` and `pytest` pass in `apps/research`

## Before merging

- [ ] The documentation that owns the facts I changed is updated (schema in `DATA-LAYER.md`,
      environment variables in `apps/chat/.env.example` and `README-DEV.md`, research sources in
      `apps/research/README.md`)
- [ ] No secret, personal detail or local path is in the files, the commits or this description
- [ ] Code copied or adapted from another project is credited with its licence (see `CONTRIBUTING.md`)
- [ ] I agree my contribution is licensed under Apache-2.0, as described in `CONTRIBUTING.md`
