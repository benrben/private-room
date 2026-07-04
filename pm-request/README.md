# PM Request — Private Room improvement plan

This folder is the product wish list from the full product review (2026-07-04),
turned into work items. It is written in simple English.

Every item has the same five sections:

- **Goal** — why we are doing this (the outcome for the user).
- **Task** — what to build or change, in one or two sentences.
- **How to do it** — suggested steps, with pointers into the code.
- **How to check it** — how a human tests it by hand.
- **Acceptance criteria** — the checklist that must be true before the item is "done".

Line numbers in code pointers are approximate (as of 2026-07-04) — search for the
function name if the line moved.

## The files

| File | What is inside | Items |
|---|---|---|
| [part-1-security.md](part-1-security.md) | Trust & safety fixes. For this product, trust IS the product. | SEC-1 … SEC-7 |
| [part-2-features-to-add.md](part-2-features-to-add.md) | Missing features, from "must have" to roadmap. | ADD-1 … ADD-17 |
| [part-3-things-to-change.md](part-3-things-to-change.md) | Existing things that should work differently. | CHG-1 … CHG-10 |
| [part-4-ux-polish.md](part-4-ux-polish.md) | Smaller annoyances that create real friction. | UX-1 … UX-7 |
| [part-5-project-health.md](part-5-project-health.md) | Behind-the-scenes: code safety, performance, shipping. | HLT-1 … HLT-8 |
| [part-6-remove-cleanup.md](part-6-remove-cleanup.md) | Things to delete or clean up. | RM-1 … RM-5 |
| [part-7-long-term-ideas.md](part-7-long-term-ideas.md) | Big future bets. Explorations, not commitments. | LT-1 … LT-5 |

## Suggested order of work (the "top ten")

1. **HLT-1** — put the code in git (10 minutes, protects everything else).
2. **SEC-1** — ask before running room plug-ins (closes the biggest security hole).
3. **ADD-1** — export files out of the room (your stuff must be able to leave).
4. **ADD-2** — version history + undo for AI edits (no more irreversible changes).
5. **ADD-3** — "Are you sure?" before deleting anything.
6. **ADD-5** — recent rooms list on the start screen.
7. **ADD-8** — drag-and-drop import + paste screenshots.
8. **ADD-7** — Stop button for AI answers.
9. **SEC-6** — permanent "cloud mode" badge (nothing leaks by accident).
10. **HLT-2** — sign the app with Apple + auto-updates (needed before sharing it).

## Ground rules for all items

- Keep the privacy promise: nothing leaves the Mac unless the user clearly turned it on.
- Match the existing design: icons from `src/icons.tsx` (24px grid, 1.6px strokes),
  colors from the README design table.
- Every new user-facing text should be calm, short, and jargon-free.
- If an item needs a schema change, add it to `migrate()` in `src-tauri/src/db.rs`
  so old rooms keep working.
