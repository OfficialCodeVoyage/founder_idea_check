---
paths:
  - "apps/chat/lib/export/**"
  - "apps/chat/app/actions/build-handoff.ts"
---
# Export (founder handoff) — landmines

- **Fact values are untrusted input.** A fact can name the output folder (`handoff.ts::deriveRepoName`) and fills
  every document. Guard: `lib/export/documents.test.ts` (value-injected structure, multi-line values).
- **Every path in the plan is checked twice:** `paths.ts::slugifySegment` emits only `[a-z0-9-]` (≤64 chars), and
  `checkRelativePath` / `assertSafeTree` run over the whole plan (hard-coded paths included, ≤180 chars). Never add a
  file to the plan that skipped them. Nothing is written on the server (the browser downloads each file), so
  `assertWithinRoot`, the resolved-path layer, has no caller; a server-side writer would have to call it too. Guard:
  `lib/export/paths.test.ts` (traversal, Windows reserved names, `.git`, NTFS streams, bidi override).
- **The export is documentation only, and zero facts is a refusal.** No `package.json`, framework or `LICENSE`: no
  phase records a technology choice, and a licence is not the export's to pick. Guards: `lib/export/documents.test.ts`
  ("refuses to invent a technology choice"), `lib/export/handoff.test.ts` (no facts, no export).
- **Output is byte-identical for the same snapshot.** `buildHandoff` is pure: no clock, fs, git or model;
  `generatedAt` is injected and line endings are LF. Guard: `lib/export/handoff.test.ts`.
- **Absence is rendered, never omitted.** A missing fact shows as missing in the document. Guard:
  `lib/export/documents.test.ts`.
