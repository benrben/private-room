# Part 5 — Project health

Behind-the-scenes work: protecting the code, shipping safely, and keeping
the app fast and stable as rooms grow.

---

## HLT-1 — Put the project in git (do this first)

**Goal**
The code itself gets a safety net. Today there is no version control at
all — one bad day could lose everything with no rewind button.

**Task**
`git init`, a proper `.gitignore` check, and a clean first commit.

**How to do it**
1. In the project root: `git init`.
2. Check ignores before adding: root `.gitignore` should cover
   `node_modules/`, `dist/`, `.DS_Store`; `src-tauri/.gitignore` already
   covers `target/`. Add `.DS_Store` entries if missing (there are stray
   `.DS_Store` files in the tree).
3. `git add -A`, then review `git status` — the staged list must contain
   no build artifacts and nothing huge.
4. Commit: "Initial commit — Private Room 0.1".
5. Optional but recommended: create a PRIVATE GitHub repo and push, so the
   history also lives off this Mac.

**How to check it**
1. `git status` is clean after the commit.
2. Repo size is sane (tens of MB at most — icons and the DMG tiff are the
   biggest legitimate items).
3. `npm run tauri dev` still works (nothing needed was ignored).

**Acceptance criteria**
- [ ] Repository exists with the full source in one clean commit.
- [ ] Build artifacts and OS junk are ignored.
- [ ] (If pushed) the remote is private.

---

## HLT-2 — Sign, notarize, and auto-update

**Goal**
Strangers can install the app without scary warnings, and you can ship a
security fix that actually reaches people.

**Task**
Apple Developer ID signing + notarization in the build, plus the Tauri
updater so the app can update itself.

**How to do it**
1. Join the Apple Developer Program; create a "Developer ID Application"
   certificate.
2. `src-tauri/tauri.conf.json`: set `bundle.macOS.signingIdentity`;
   provide notarization credentials via environment variables
   (`APPLE_ID`, `APPLE_PASSWORD` app-specific, `APPLE_TEAM_ID`) in the
   build step.
3. Add `tauri-plugin-updater`: generate the signing keypair, add the
   public key and an endpoint URL (GitHub Releases with `latest.json`
   works) to the config; wire a small "checking for updates" call on
   launch with a quiet "Update available — Install & relaunch" prompt.
4. Write `RELEASING.md`: bump version, build, notarize, sign update
   bundle, publish — so future releases are a checklist, not archaeology.

**How to check it**
1. On a Mac (or fresh user account) that never saw the app: download the
   DMG, open it → no "unidentified developer" block; app runs first try.
2. `spctl -a -vv "Private Room.app"` says accepted / notarized.
3. Publish a bumped version → running app offers the update, installs,
   relaunches into the new version.

**Acceptance criteria**
- [ ] Gatekeeper-clean install on a fresh machine.
- [ ] End-to-end auto-update verified once for real.
- [ ] Release steps documented in RELEASING.md.

---

## HLT-3 — Fast search index (FTS5)

**Goal**
Asking a question stays fast as rooms grow. Today every question loads
EVERY chunk of every file into memory and scores them one by one.

**Task**
Index chunk text in SQLite's FTS5 full-text engine and query it instead
of scanning.

**How to do it**
1. Confirm the bundled SQLCipher build includes FTS5 (rusqlite feature
   flags); if not, enable it.
2. In `migrate()` (`src-tauri/src/db.rs`): create
   `chunks_fts` (fts5, content='chunks') and backfill from existing rows.
3. Keep it in sync at the three write points (`insert_file`,
   `store_file_bytes`, file delete) — simplest is triggers created in the
   same migration.
4. Rewrite `retrieve_context` (`src-tauri/src/commands.rs`) to build an OR
   query from `question_terms` and rank with bm25(), taking the top
   `MAX_CONTEXT_CHUNKS`. Keep the current "recent chunks" fallback (and
   CHG-10's honesty flag).

**How to check it**
1. Make a stress room (import a few large books, ~5,000 chunks). Time
   `ask` before and after — the retrieval step should drop to a few
   milliseconds.
2. Edit a file, then search for the new words → found (index stayed in
   sync).
3. Delete a file → its text no longer surfaces.

**Acceptance criteria**
- [ ] No full-table scan per question.
- [ ] Index provably stays in sync on create/edit/delete.
- [ ] Old rooms are migrated automatically on open.
- [ ] Result quality is at least as good on a sample of real questions.

---

## HLT-4 — Never index partially in silence

**Goal**
When the app only indexed part of a big file, the user knows.

**Task**
Surface the 2,000-chunk cap (and any future cap) in the UI.

**How to do it**
1. `insert_file` / `store_file_bytes` silently `take(2000)` chunks. Make
   them return a `truncated: bool`.
2. `import_files` adds a line to the import report: "report.txt: very
   large — only the first part is searchable."
3. Show a small badge/tooltip on such files in the file list ("partially
   indexed"); deriving it live (chunk count == 2000) avoids a schema
   change.

**How to check it**
1. Import a text file big enough to exceed the cap → import notice says
   partially indexed; the file row shows the badge.
2. Normal files → no badge.

**Acceptance criteria**
- [ ] Every capped indexing event is visible at import time and on the
      file afterwards.
- [ ] Wording explains the practical impact.

---

## HLT-5 — RAM guard for the two-model dance

**Goal**
A 16 GB Mac never gets overwhelmed by holding the chat model AND the
vision model in memory at once (this exact thing has crashed Ollama here
before).

**Task**
Release the vision model right after grounding calls on low-RAM machines,
instead of keeping both resident for 30 minutes.

**How to do it**
1. All vision/grounding calls go through `ollama::chat_stream_tools` with
   the vision model (`locate_in_image`, `mark_image`, the locate-intent
   pass in `ask`). Add a `keep_alive` parameter to the function; pass a
   short value (e.g. `"2m"` or `0`) for vision calls when the vision
   model differs from the chat model.
2. Read total RAM once (sysinfo crate): on machines with ≥ 32 GB, keep
   the current 30 m behavior for snappier repeated marking.
3. Document the tradeoff in a comment: repeated grounding on 16 GB pays a
   reload, and that is the right default.

**How to check it**
1. On the 16 GB Mac: chat → "mark where X is" → chat again. `ollama ps`
   after a couple of minutes shows only the chat model resident.
2. Marking still works correctly (just reloads when used again).
3. Memory pressure in Activity Monitor stays comfortable through the
   whole flow.

**Acceptance criteria**
- [ ] On 16 GB, the vision model does not stay resident with a 30 m
      keep-alive.
- [ ] Chat model stays warm throughout.
- [ ] Grounding accuracy unchanged.

---

## HLT-6 — Warn about cloud-synced rooms

**Goal**
Nobody corrupts a room by having it open on two Macs through
Dropbox/iCloud (databases + file sync are a known bad mix).

**Task**
Detect rooms living inside a sync folder and show a one-time, per-room
warning.

**How to do it**
1. On open, check the path against the known roots: iCloud
   (`Library/Mobile Documents`), `~/Library/CloudStorage/` (Dropbox,
   Google Drive, OneDrive live there on modern macOS), plus a legacy
   `~/Dropbox` check.
2. If matched and not previously dismissed (flag in the room's settings
   table), show a calm banner: "This room lives in a synced folder. Never
   open it on two computers at the same time — the file can be damaged.
   Lock it before switching machines." with a Dismiss button.

**How to check it**
1. Put a room in iCloud Drive, open it → banner appears once; dismiss;
   reopen → gone.
2. Room in ~/Documents → no banner.

**Acceptance criteria**
- [ ] Known sync locations are detected.
- [ ] Warning shows once per room and can be dismissed.
- [ ] Copy is calm, specific, and actionable.

---

## HLT-7 — Locking during an answer ends cleanly

**Goal**
Hitting Lock while the AI is mid-answer never shows raw errors ("No room
is open") or leaves half-finished state.

**Task**
Lock cancels the generation first, saves the partial answer, then closes
the room.

**How to do it**
1. Depends on ADD-7's cancel plumbing. `close_room` (or the frontend lock
   path): if an ask is in flight → trigger cancel, wait briefly for the
   save-partial step, then close.
2. Harden `ask`'s final phase: if the room is already gone when it tries
   to save, return quietly instead of surfacing an error string to the UI.
3. The frontend lock handler ignores "cancelled" rejections from the
   in-flight `ask` promise.

**How to check it**
1. Start a long answer, click Lock immediately → gate screen appears, no
   error toast/banner anywhere.
2. Reopen the room → the user question is there, plus a partial answer
   marked "(stopped)" (or none — but pick ONE outcome and it must be
   consistent).
3. Ask something new → everything normal.

**Acceptance criteria**
- [ ] No raw error is ever shown for the lock-during-ask flow.
- [ ] The documented outcome (partial saved) happens every time.
- [ ] The app is fully healthy after reopening.

---

## HLT-8 — Smoke tests for the demo path

**Goal**
The core flow — create room, import, view, ask, see an annotation — cannot
silently break. Today only Rust internals have tests; the UI has none.

**Task**
A small end-to-end test that drives the real app through the happy path,
with the AI faked so it runs anywhere.

**How to do it**
1. Make the Ollama base URL configurable (env var read in
   `src-tauri/src/ollama.rs` instead of the `BASE_URL` constant).
2. Write a tiny mock server (node script) that replays recorded
   `/api/chat`, `/api/tags`, `/api/generate` responses — including one
   scripted tool call (e.g. `annotate_file`) so the 📍 chip path is
   covered.
3. Drive the app with WebdriverIO + `tauri-driver` (Tauri's supported
   e2e route): create a room in a temp dir, import fixture files
   (txt + csv), open the viewer, send a question, assert the answer
   bubble and annotation chip appear.
4. `npm run e2e` script; wire into CI later (after HLT-1/HLT-2).

**How to check it**
1. Run `npm run e2e` → green in under ~2 minutes, no real Ollama needed.
2. Intentionally break something on the path (e.g. rename the `ask`
   command) → the test fails loudly.

**Acceptance criteria**
- [ ] Covers create → import → view → ask (mocked) → annotation chip.
- [ ] Runs without a real model or network.
- [ ] Documented one-command run; failure output points at the broken step.
