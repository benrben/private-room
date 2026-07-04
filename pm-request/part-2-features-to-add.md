# Part 2 — Features to add

Ordered roughly by importance: first the data-lifecycle group (get things
out, undo mistakes), then daily-driver comfort, then roadmap builders.

---

## ADD-1 — Export files out of the room

**Goal**
Anything you put into the room can come back out as a normal file. Today
there is no way at all — the room is a one-way door.

**Task**
Add "Export…" for a single file and "Export all…" for the whole room.

**How to do it**
1. New Tauri command `export_file(id, dest_path)` in
   `src-tauri/src/commands.rs`: read `original_bytes` for the file, write
   them to `dest_path` with `std::fs::write`.
2. Frontend (`src/Workspace.tsx`): an export icon button on each file row
   and in the viewer header. Clicking opens the save dialog
   (`@tauri-apps/plugin-dialog` `save`) with the file's name pre-filled,
   then calls the command.
3. "Export all…": folder picker, loop over files; on name clashes append
   " (2)" etc. rather than overwriting.
4. Show a one-line warning the first time: "Exported copies are normal,
   NOT encrypted files."

**How to check it**
1. Import a PDF, export it, open the copy in Preview — it must be
   byte-identical (`shasum` both files).
2. Export a generated AI note → valid `.md` file.
3. Export-all a room with two files named the same → both arrive, one
   renamed.
4. Pick a folder without write permission → clear error message, app fine.

**Acceptance criteria**
- [ ] Exported bytes are identical to what was imported.
- [ ] Works for every file type, including AI-generated notes.
- [ ] Export-all handles name clashes without overwriting.
- [ ] The "not encrypted" warning is shown.
- [ ] Errors are reported in plain language.

---

## ADD-2 — File version history + undo for AI edits

**Goal**
No change to a file is ever irreversible. Today the AI (and the editor)
overwrite files with no way back — the scariest thing in the app.

**Task**
Keep previous versions every time a file's content changes, and add a
"History" panel in the viewer with one-click restore.

**How to do it**
1. New table in `src-tauri/src/db.rs` `migrate()`:
   `file_versions(id, file_id, bytes BLOB, saved_at, cause TEXT)`.
2. In `store_file_bytes` (`src-tauri/src/commands.rs` ~line 364) — the one
   choke point all writes go through — first copy the CURRENT bytes into
   `file_versions`, then overwrite. Pass a `cause` label from each caller:
   "AI edit", "AI rewrite", "AI cell change", "You edited", "You saved".
   (`update_file_content` for Monaco ⌘S uses the same path — verify.)
3. Cap at 10 versions per file; delete the oldest beyond that.
4. Viewer header gets a "History" button → list of versions with time and
   cause → "Restore". Restore calls `store_file_bytes` with the old bytes
   (which automatically versions the current state too — so restore is
   itself undoable).
5. Delete versions when the file is deleted (FK ON DELETE CASCADE).

**How to check it**
1. Ask the AI to change a sentence in a note → History shows the previous
   version; Restore brings the old text back exactly.
2. Make 11 edits → only 10 versions kept, oldest gone.
3. Edit an `.xlsx` via `set_cells`, restore → the spreadsheet opens and the
   old value is back (binary round-trip).
4. Lock and reopen the room → history still there.

**Acceptance criteria**
- [ ] Every write path (edit_file, write_file, set_cells, Monaco save,
      markdown/CSV edit) creates a version first.
- [ ] Restore returns the exact previous bytes.
- [ ] Version count is capped per file.
- [ ] History survives lock/unlock and is removed with the file.
- [ ] Room size stays bounded (cap + SEC-7 vacuum).

---

## ADD-3 — "Are you sure?" before deleting

**Goal**
Nothing is destroyed by a single accidental click. Today the trash icons
delete files, chats, and memories instantly and forever.

**Task**
Add a lightweight second step to every destructive button.

**How to do it**
1. In `src/Workspace.tsx`: `removeFile`, `removeChat`, and the memory “×”
   all fire on first click. Change each trash button to a two-step control:
   first click turns it into "Delete? ✓ / ✕" for ~3 seconds, second click
   confirms. (Feels faster than a modal and works everywhere.)
2. Use the same pattern for "Delete model" in `src/Settings.tsx`.
3. Once ADD-2 exists, file deletion can offer Undo instead — until then,
   confirmation is the floor.

**How to check it**
1. Click a file's trash once → nothing deleted, button changes.
2. Click ✓ → deleted. Click ✕ or wait 3 s → back to normal, file intact.
3. Same for chat, memory, and model rows.

**Acceptance criteria**
- [ ] No single click anywhere permanently deletes data.
- [ ] The confirm step times out safely back to normal.
- [ ] Pattern is consistent across files, chats, memories, models.

---

## ADD-4 — Room backup & duplicate

**Goal**
One-click safe copy of a whole room — for backup before experiments, or
for sharing a copy with a different password.

**Task**
"Duplicate room…" in Settings: choose destination and (optionally) a new
password.

**How to do it**
1. New command `duplicate_room(dest_path, new_password: Option<String>)`.
2. Safest copy of an OPEN database: `VACUUM INTO '<dest>'` (works with
   SQLCipher; the copy keeps the current key).
3. If a new password was given: open the copy, verify, `PRAGMA rekey` it
   (reuse SEC-4's code).
4. Refuse if the destination already exists. Enforce SEC-2 password rules.
5. UI in Settings under "Privacy": destination picker + optional new
   password fields + explanation ("A full copy of this room as it is right
   now.").

**How to check it**
1. Duplicate a room with a new password → the copy opens with the new
   password only; file count and message count match the original.
2. The original still opens with the old password, untouched.
3. Duplicate onto an existing path → clear refusal.

**Acceptance criteria**
- [ ] Copy contains everything (files, chats, memories, settings).
- [ ] Optional new password works; old room unchanged.
- [ ] Existing destination is never overwritten.

---

## ADD-5 — Recent rooms on the start screen

**Goal**
Returning to yesterday's room takes one click, not a trip through the file
picker.

**Task**
Show up to 5 recently opened rooms (name + path) on the gate screen.

**How to do it**
1. Store the list OUTSIDE rooms, in the app's data folder (e.g.
   `recent.json` via `app.path().app_data_dir()`); rooms are encrypted,
   this list is only names/paths — note that in a comment.
2. New commands `list_recent()` and internal push on every successful
   `open_room`/`create_room` (most recent first, dedup by path, cap 5).
3. Gate screen (`src/App.tsx`, `start` state): render the list under the
   two buttons; click → the unlock screen for that path.
4. If the file no longer exists: friendly message and offer to remove the
   entry. Add a small "clear list" affordance.

**How to check it**
1. Open two different rooms, quit, relaunch → both listed, newest first.
2. Click one → straight to its unlock screen.
3. Delete a listed `.roomai` in Finder, click its entry → polite error and
   the entry can be removed.

**Acceptance criteria**
- [ ] List survives app restarts and is capped at 5, newest first.
- [ ] One click reaches the unlock screen.
- [ ] Missing files are handled gracefully.
- [ ] Nothing about the list is stored inside room files.

---

## ADD-6 — Search your own room (⌘F)

**Goal**
The user can find their own stuff. Today only the AI has a search tool;
humans have nothing.

**Task**
A search overlay (⌘F / ⌘K) covering file names, file contents, chat
messages, and memories — clicking a result opens the right thing.

**How to do it**
1. New command `search_all(query)` returning grouped results:
   - files: name matches + content matches (reuse the chunk scoring from
     `retrieve_context`, return file id + snippet),
   - messages: SQL `LIKE` over `messages.content` (chat id, message id,
     snippet),
   - memories: `LIKE` over content.
2. Frontend: overlay panel with a text box and grouped results.
   - File result → `viewFile(id, { find: snippet })` (viewers already
     highlight).
   - Message result → `setActiveChatId(chatId)` and scroll to the message.
   - Memory result → open the memory panel.
3. Keyboard: ⌘F/⌘K opens, Esc closes, arrows + Enter navigate.
4. Later this rides on FTS5 (HLT-3); `LIKE` is fine to start.

**How to check it**
1. Search a word that exists in a PDF → clicking opens the PDF with the
   spot highlighted.
2. Search a phrase from an old chat → jumps to that chat and message.
3. Search a memory word → panel opens.
4. ⌘F from anywhere in the workspace opens the overlay; Esc closes it.

**Acceptance criteria**
- [ ] All four sources are searched and clearly grouped.
- [ ] Every result type navigates to the real thing.
- [ ] Fully keyboard-operable.
- [ ] Feels instant (<1 s) on a typical room.

---

## ADD-7 — Stop button for AI answers

**Goal**
A running answer can be cancelled. Today you must watch a wrong answer
crawl out for a minute.

**Task**
While the AI is answering, the Send button becomes Stop. Stopping keeps
the partial text, marked "(stopped)".

**How to do it**
1. Backend cancellation: give each `ask` an id; keep a shared cancel flag
   in `AppState` (e.g. `HashMap<String, Arc<AtomicBool>>`). New command
   `cancel_ask(id)` sets it.
2. In `ollama::chat_stream_tools`, accept the flag and break out of the
   stream loop when set. In `agent_loop`, also check between tool calls
   and rounds.
3. Cloud CLIs (`run_external`): keep the child's handle and `kill()` it on
   cancel.
4. On cancel, still run "Phase 3": save whatever text streamed so far with
   a trailing " *(stopped)*" note, so the transcript matches what the user
   saw.
5. Frontend: `send()` stores the ask id; while `asking`, the button shows
   "Stop" and calls `cancel_ask`.

**How to check it**
1. Ask for a long story, press Stop mid-stream → text stops within ~1 s,
   partial answer saved with the note, composer usable immediately.
2. Next question works normally (no zombie state).
3. With a cloud engine selected: Stop kills the process (check Activity
   Monitor).

**Acceptance criteria**
- [ ] Local generation stops within about a second.
- [ ] Cloud CLI processes are killed on stop.
- [ ] Partial answer is saved and marked stopped.
- [ ] The app is immediately ready for the next question.

---

## ADD-8 — Drag-and-drop import + paste screenshots

**Goal**
The two most natural gestures work: drop files onto the app, paste an
image into the chat.

**Task**
Dropping files anywhere on the window imports them; ⌘V of an image in the
composer imports it and attaches it to the next question.

**How to do it**
1. Drag-drop: use Tauri v2's drag-drop events on the main window
   (`onDragDropEvent`) — it delivers real file paths; call the existing
   `api.importFiles(paths)`. Show a highlight overlay while dragging over
   the window ("Drop to add to this room").
2. Paste: on the composer's `onPaste`, look for `clipboardData` items of
   type `image/*`; read as base64. New command
   `import_image_bytes(name, b64)` that decodes and calls `insert_file`
   with source "upload" (name like "Pasted image 14.32.png"). Then
   `toggleAttach` the new file so it rides along with the next question.
3. Reuse the existing import report notice for errors (too big, unreadable).

**How to check it**
1. Drag three files from Finder anywhere onto the window → all imported,
   notice shown, list refreshes.
2. Take a screenshot to clipboard (⌘⇧⌃4), click the composer, ⌘V → image
   appears in the file list AND as an attachment chip; ask "what is in
   this image?" → vision answer.
3. Drag a 300 MB file → friendly size error, nothing crashes.

**Acceptance criteria**
- [ ] Drop works anywhere on the window, multiple files at once.
- [ ] A visible drop highlight appears while dragging.
- [ ] Pasted images are imported AND attached automatically.
- [ ] Errors use the same reporting as normal import.

---

## ADD-9 — Chat basics: rename, copy, regenerate

**Goal**
Chats behave like real documents: name them, copy out of them, retry a bad
answer.

**Task**
Add chat rename, a copy button on every AI message, and "Regenerate" on
the last AI message.

**How to do it**
1. Rename: new command `rename_chat(id, title)`; UI — pencil icon next to
   the chat dropdown swaps it for an inline text input.
2. Copy: button in the message footer; `navigator.clipboard.writeText`
   with the message text minus the hidden ```boxes/```annotation blocks
   (reuse `splitMarkupBlocks` from `src/Workspace.tsx`).
3. Regenerate: on the LAST assistant message only. New command
   `delete_message(id)`; flow = delete that message, re-run `ask` with the
   previous user question. Note: original attachments are not stored per
   message — regenerate re-asks without them (fine; say so in the tooltip).
4. Disable all three while an answer is streaming.

**How to check it**
1. Rename a chat → dropdown shows the new name after relock/reopen.
2. Copy an answer with an image-marking block → clipboard has clean text,
   no JSON garbage.
3. Regenerate → old answer gone, a new (different) one arrives; earlier
   history untouched.

**Acceptance criteria**
- [ ] Rename persists in the room file.
- [ ] Copy yields clean text for any message.
- [ ] Regenerate replaces only the last answer.
- [ ] All disabled while asking.

---

## ADD-10 — Ollama onboarding for beginners

**Goal**
Someone who has never heard of Ollama gets to a working AI without leaving
the app or touching a terminal.

**Task**
Detect three different situations — not installed / installed but not
running / running but no model — and guide each with buttons, not
instructions.

**How to do it**
1. Extend `ai_status` (`src-tauri/src/commands.rs`): today "running:
   false" hides the difference between "not installed" and "not started".
   Add `installed: bool` — check `/Applications/Ollama.app` exists or
   `command -v ollama` via the existing `zsh -lc` trick.
2. Banners in `src/Workspace.tsx`:
   - Not installed → "This room's AI runs on Ollama, a free app." +
     [Get Ollama] (opens https://ollama.com/download via the opener
     plugin) + [I installed it — check again].
   - Installed, not running → [Open Ollama] button (run
     `open -a Ollama`), then auto-recheck a few times.
   - Running, no model → [Download the standard model] with inline
     progress (this is CHG-1).
3. Mirror the same guidance in the empty-chat hero when AI is unavailable.

**How to check it**
1. Temporarily rename Ollama.app → app shows the "Get Ollama" flow.
2. Quit Ollama → "Open Ollama" button starts it and the dot turns green
   without a manual refresh.
3. Fresh Ollama with no models → one-click model download works.

**Acceptance criteria**
- [ ] The three states show three different, correct guides.
- [ ] Every step is a button; no terminal commands anywhere in the flow.
- [ ] Status refreshes itself after each action.

---

## ADD-11 — Touch ID unlock

**Goal**
Unlock a room with a fingerprint. More convenient AND more secure — people
will accept longer passwords they rarely type.

**Task**
Per-room opt-in: after a successful password unlock, offer "Enable Touch
ID for this room". Store the secret in the macOS Keychain guarded by
biometrics.

**How to do it**
1. Store the room password (or a random wrapping key) as a Keychain item
   with access control `biometryCurrentSet`, keyed by the room's path.
   (Security framework via the `security-framework`/`objc2` crates.)
2. Unlock screen: if a Keychain entry exists for this path, show a
   "Use Touch ID" button → system biometric prompt → read secret →
   existing `open_room` path. Password field always remains as fallback.
3. Settings toggle "Touch ID unlock" — turning it off deletes the
   Keychain item. Changing the password (SEC-4) must update or invalidate it.
4. Never write the secret into the room file or any plain file.

**How to check it**
1. Enable, lock, unlock via fingerprint → works; wrong finger →
   falls back to password.
2. Disable → button gone; Keychain Access shows the item removed.
3. Change the room password → Touch ID either updated or cleanly disabled
   with a message (pick one behavior and test it).

**Acceptance criteria**
- [ ] Opt-in per room; system biometric UI used.
- [ ] Password fallback always available.
- [ ] Disabling removes the stored secret.
- [ ] The secret never exists outside the Keychain.

---

## ADD-12 — Save web links into the room

**Goal**
Turn rooms into research vaults: paste a link, keep a readable offline
copy forever.

**Task**
"Add link…" next to "+ Add" in the Files pane: fetch the page, extract the
readable text, save it as a room file.

**How to do it**
1. Reuse `web::fetch_page` (with the SEC-5 guard). This is a manual,
   explicit user action, so it is allowed even when the AI's web tools are
   off — but show "this fetches one page from the internet" in the dialog.
2. Save as a Markdown file: first lines = title, original URL, saved date;
   then the text. `insert_file` with source `"web"` so it gets the web
   icon (`fileKind` already maps html→web; add source check).
3. It is then indexed and searchable like any file; the AI can cite it.
4. (Pairs with RM-2 path A — the cache — but works standalone.)

**How to check it**
1. Add a Wikipedia article → file appears with a sensible name; opening it
   shows readable text with the URL at top.
2. Ask the AI a question answered by that page (web OFF) → it answers from
   the saved copy and cites the file.
3. Add a link to a private address (`http://192.168.1.1`) → blocked.

**Acceptance criteria**
- [ ] One dialog → one saved, readable, offline file with its URL kept.
- [ ] Indexed for retrieval and user search.
- [ ] SEC-5 guard applies; the network step is clearly labeled.

---

## ADD-13 — Meaning-based search (embeddings)

**Goal**
Retrieval finds "vacation schedule" when you ask about "holiday dates".
Keyword matching cannot; this is the app's quality ceiling today.

**Task**
Add local vector search using the reserved `embedding` column plus
sqlite-vec, blended with the current keyword score.

**How to do it**
1. Pick a small local embedding model served by Ollama (e.g.
   `nomic-embed-text` or `embeddinggemma`) — call `/api/embed`.
2. On import/edit (in `insert_file` / `store_file_bytes`), embed each
   chunk and store the vector in `chunks.embedding` (the column already
   exists). Backfill existing rooms lazily in the background after unlock.
3. Bundle the sqlite-vec extension; at ask time, embed the question, take
   top-K by cosine similarity, merge with keyword scores (simple weighted
   sum), keep `MAX_CONTEXT_CHUNKS`.
4. If the embedding model is missing, silently fall back to keywords —
   never block the chat.
5. Mind RAM (HLT-5): the embed model is small, but unload it after
   batch-indexing on 16 GB machines.

**How to check it**
1. Room with a file mentioning "vacation schedule"; ask "when are the
   holiday dates?" → the right excerpt is retrieved (it is not today).
2. Remove the embed model → chat still works via keywords.
3. Ask latency stays under ~1 s extra on a 5,000-chunk room.

**Acceptance criteria**
- [ ] Synonym test set answers improve measurably vs keywords alone.
- [ ] Vectors live inside the room file; nothing leaves the Mac.
- [ ] Clean fallback when the model is absent.
- [ ] Old rooms are backfilled without blocking the UI.

---

## ADD-14 — OCR for scans and photos

**Goal**
Scanned PDFs and photographed papers (receipts, letters, IDs) become
searchable and askable.

**Task**
On import, when a PDF or image yields no text, run local OCR and store the
result as the file's extracted text.

**How to do it**
1. Use Apple's Vision framework (`VNRecognizeTextRequest`) via objc2 —
   on-device, no bundled engine, good multi-language support (verify
   Hebrew).
2. Trigger in `import_files` when `extract_text` returns nothing for a
   PDF/image. Run in the background (async task + progress event) so big
   scans don't freeze import; index chunks when done and emit
   `room-files-changed`.
3. Tag it: extracted text starts with "(text recognized from scan)" so the
   AI can be honest about OCR uncertainty.
4. OCR failure = silent fallback to "no text", exactly like today.

**How to check it**
1. Import a photo of a receipt → after a moment, searching an amount from
   it finds the file; asking "how much was the total?" works.
2. Import a scanned (image-only) PDF → same.
3. Import a huge scan → UI stays responsive; progress visible.

**Acceptance criteria**
- [ ] Image-only PDFs and photos get searchable text, fully on-device.
- [ ] Import never blocks the UI; failures degrade silently.
- [ ] Both English and Hebrew scans recognized acceptably.

---

## ADD-15 — Room templates

**Goal**
A new room is useful in the first minute, and shows off what the AI can do.

**Task**
When creating a room, offer templates (Blank, Legal, Medical, Research,
Journal) that pre-fill instructions, starter memories, and a welcome note.

**How to do it**
1. Define templates as plain data in the frontend: custom instructions
   text, 2–3 starter memories, a `welcome.md` with "what to add here" and
   three example questions to try.
2. Add a template picker step to the create form in `src/App.tsx`
   (Blank preselected).
3. After `create_room` succeeds, apply via existing APIs: `setSetting
   ("custom_instructions", …)`, `addMemory(…)`, `saveGeneratedFile
   ("Welcome.md", …)`.
4. Everything a template creates is normal, editable content — no special
   machinery.

**How to check it**
1. Create a "Medical" room → Settings shows its instructions; the welcome
   note is in Files; memories panel shows the starters.
2. Create a "Blank" room → completely empty, exactly like today.
3. Delete/edit template content freely → nothing resists.

**Acceptance criteria**
- [ ] At least 4 templates plus Blank (the default).
- [ ] Template content is ordinary editable data.
- [ ] Blank rooms contain nothing extra.

---

## ADD-16 — Folders inside the room

**Goal**
Rooms with many files stay organized. Today the file list is one flat
pile sorted by date — fine with 10 files, painful with 30.

**Task**
Add one level of folders to the Files pane: create a folder, move files
in and out, collapse and expand groups. No folders inside folders in v1 —
keep it simple.

**How to do it**
1. Schema (in `migrate()` in `src-tauri/src/db.rs`): new table
   `folders(id TEXT PRIMARY KEY, name TEXT UNIQUE)` and a new nullable
   column `files.folder_id`. NULL means the file sits at the top level.
   (A separate table lets a folder exist while empty and makes rename
   one UPDATE.)
2. Backend commands in `src-tauri/src/commands.rs`:
   - `create_folder(name)`, `rename_folder(id, name)`,
     `delete_folder(id)` — deleting a folder sets its files'
     `folder_id` back to NULL. **Deleting a folder must never delete
     files.**
   - `move_file_to_folder(file_id, folder_id | null)`.
   - Extend `list_files` to return `folderId`, and add `list_folders`.
3. Frontend (`src/Workspace.tsx` sidebar):
   - Group the file list under collapsible folder headers with a count,
     e.g. "▸ Contracts (4)". Files without a folder show above/below the
     groups.
   - "New folder" button next to "+ Add".
   - On each file row, a small "Move to…" menu listing folders +
     "No folder". (Drag-and-drop onto a folder header is a nice bonus,
     not required.)
4. Let the AI see the organization: include folder names in the file
   inventory in the system prompt and in the `list_room_files` tool
   output ("Contracts/lease.pdf"). Optional: let `create_file` accept a
   folder name.
5. Old rooms: migration adds the empty structures; everything keeps
   working with no folders.

**How to check it**
1. Create a folder "Contracts", move two files into it → they appear
   grouped under a collapsible header showing (2).
2. Collapse and expand the group; open a file from inside it — viewing,
   attaching, and deleting files behave exactly as before.
3. Delete the folder → the two files return to the top level, nothing is
   lost.
4. Rename a folder → the header updates everywhere.
5. Ask the AI "what is in the Contracts folder?" → it answers from the
   file list.
6. Open a room created before this change → opens fine, flat list as
   before.

**Acceptance criteria**
- [ ] One level of folders: create, rename, delete, move files in/out.
- [ ] Deleting a folder never deletes or hides files.
- [ ] Attach/view/delete on a file work the same inside a folder.
- [ ] The AI's file listing shows the folder structure.
- [ ] Old rooms migrate automatically and safely.

---

## ADD-17 — "Summarize this room" button

**Goal**
One click answers "what is this room for, and what is inside it?" —
exactly what a returning user needs when reopening a room after weeks.

**Task**
A "Summarize room" button that generates (or refreshes) a single
"Room summary.md" file: a short paragraph on what the room is for, one
line per file, and three suggested questions — then opens it in the
viewer.

**How to do it**
1. New async command `summarize_room` in `src-tauri/src/commands.rs`.
2. The local model has a small memory (8K context), so it cannot read the
   whole room at once. Build the summary in two steps (map, then reduce):
   - **Per-file step:** for each file, one short model call — "In one
     sentence, what is this file?" — using the file name, type, and the
     first ~1,500 characters of its extracted text. Files with no text
     (images without OCR) are listed by name and type only, without
     invented content.
   - **Combine step:** one final call with all the one-line summaries,
     the room name, and the memory notes → ask for: a "What this room is
     for" paragraph, the file list with the one-liners (grouped by
     folder once ADD-16 exists), and three suggested questions to ask.
3. Cache the per-file one-liners in a new nullable column
   `files.ai_summary` (clear it inside `store_file_bytes` whenever a
   file's content changes). Re-running the button then only summarizes
   new or changed files — fast and cheap.
4. Save the result as ONE canonical file, "Room summary.md" (source
   "generated"): create it the first time, overwrite it on refresh
   (ADD-2's version history keeps the old ones). Put the generation date
   in the first line. Exclude this file from its own summary.
5. UI: a "✨ Summarize room" button at the top of the Files pane.
   While running, show progress ("Summarizing file 3 of 12…" via an
   event) and disable the button. When done, emit `room-files-changed`
   and open the summary in the viewer (reuse the `agent-open-file` path).
6. Guard rails: cap at ~50 files per run (list the rest by name with a
   note); if Ollama is down, show the normal friendly error and write
   nothing half-finished.

**How to check it**
1. In a room with a few PDFs and notes, click the button → progress
   counts up → "Room summary.md" opens with a purpose paragraph, one
   line per file, and three suggested questions, dated today.
2. Add one new file and click again → only the new file is summarized
   (fast), and the summary now includes it.
3. A room with an image and no OCR → the image is listed by name and
   type, with no made-up description.
4. Quit Ollama and click → friendly error, no broken half-summary file.
5. Lock and reopen the room → the summary is right there in the file
   list, so "what is this room?" is answered before asking anything.

**Acceptance criteria**
- [ ] One click produces or refreshes a single "Room summary.md" and
      opens it.
- [ ] It contains: purpose paragraph, one line per file, suggested
      questions, and the generation date.
- [ ] Re-runs are incremental thanks to cached per-file summaries.
- [ ] Works on any room size within the 8K context (two-step build,
      capped with an honest note).
- [ ] Files without text are listed honestly, never invented.
- [ ] The summary file never summarizes itself; offline failure is clean.
