---
paths:
  - "apps/chat/lib/export/**"
  - "apps/chat/app/actions/build-handoff.ts"
---
# Export (founder handoff) — landmines

- **Fact values are untrusted input.** A fact can name the output folder (`handoff.ts::deriveRepoName`) and fills
  every document. Guard: `lib/export/documents.test.ts` (value-injected structure, multi-line values).
- **Every path is checked three times:** `paths.ts::slugifySegment` emits only `[a-z0-9-]` (≤64 chars),
  `checkRelativePath` / `assertSafeTree` run over the whole plan (hard-coded paths included, ≤180 chars), and the
  writer calls `assertWithinRoot`. Never write a file that skipped them. Guard: `lib/export/paths.test.ts`
  (traversal, Windows reserved names, `.git`, NTFS streams, bidi override).
- **Output is byte-identical for the same snapshot.** `buildHandoff` is pure: no clock, fs, git or model;
  `generatedAt` is injected and line endings are LF. Guard: `lib/export/handoff.test.ts`.
- **Absence is rendered, never omitted.** A missing fact shows as missing in the document. Guard:
  `lib/export/documents.test.ts`.
