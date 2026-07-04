# Part 3 — Things to change

Existing features that should behave differently.

---

## CHG-1 — Model-missing banner: download in-app, not in Terminal

**Goal**
The app never tells users to type terminal commands for something it can
already do itself (Settings has a full model downloader).

**Task**
Replace the "Run `ollama pull …` in a terminal" banner with a
"Download {model}" button showing live progress.

**How to do it**
1. The banner lives in `src/Workspace.tsx` (~line 689, the
   `!modelReady` case).
2. Reuse what `src/Settings.tsx` already does: call `api.pullModel(model)`
   and listen to the `pull-progress` event; render a slim progress bar in
   the banner.
3. On success: `refreshAi()` clears the banner automatically. On failure:
   show the error in the banner.
4. Search the app for any other user-facing text that mentions terminal
   commands and give it the same treatment (the `MODEL_MISSING` notice in
   `send()` is the other spot).

**How to check it**
1. Select a model that is not downloaded → banner shows the button.
2. Click → the progress bar really moves → chat works when done, banner gone.
3. Kill the network mid-pull → readable error, retry possible.

**Acceptance criteria**
- [ ] No user-facing text anywhere tells the user to open a terminal.
- [ ] Download progress is visible in the banner.
- [ ] Success clears the banner without manual refresh.

---

## CHG-2 — One internet switch

**Goal**
One clear place answers the question "can the AI reach the internet?".
Today there are two unrelated paths (Online features + the MCP example).

**Task**
Make Settings → Online features the single search path; make MCP a
generic "advanced connections" section (no shipped search example); unify
the composer badges.

**How to do it**
1. Do RM-5 (empty default MCP config + copy rewrite).
2. In `src/Workspace.tsx` the composer can currently show TWO similar
   badges (`mcpTools` and `webOn`). Merge into one badge component:
   "🌐 This room can reach the internet" with a tooltip listing the
   reasons ("Web search: Brave", "Connected tools: websearch (2 tools)").
3. Settings copy: Online features = "the built-in way to let the AI
   search"; MCP = "advanced: connect external tool programs; they may
   also reach the internet".

**How to check it**
1. Fresh room: both off → no badge anywhere.
2. Turn on Brave → one badge; connect an MCP server too → still one badge,
   tooltip lists both.
3. Read both Settings sections aloud — no overlap or contradiction.

**Acceptance criteria**
- [ ] Exactly one badge communicates "internet on", with details on hover.
- [ ] No shipped config quietly suggests a second search path.
- [ ] Settings copy separates the two sections cleanly.

---

## CHG-3 — Spreadsheet view: real row/column labels

**Goal**
When the AI says "I fixed cell B7", the user can actually see which cell
is B7.

**Task**
Add column letters (A, B, C…) and row numbers (1, 2, 3…) to
`src/viewers/SheetView.tsx`, and stop painting the first data row as a
header.

**How to do it**
1. Render a header row of letters and a leading number column; make both
   sticky with CSS so they stay visible while scrolling.
2. Render ALL data rows as `<td>` (today row 0 becomes `<th>`, which
   misrepresents sheets whose first row is data).
3. Careful with the highlight math: `parseA1Range` indexes are 0-based
   over data rows; after adding label row/column, displayed row "1" must
   still equal data row 0. Verify B7 highlights the cell at column B,
   row 7 as labeled on screen.

**How to check it**
1. Open an `.xlsx`; ask the AI to highlight B2:D5 → the highlighted block
   sits exactly under column labels B–D, rows 2–5.
2. Open a CSV whose first row is data (not headers) → it now looks like
   data.
3. Scroll a big sheet → labels stay pinned.

**Acceptance criteria**
- [ ] Letters and numbers visible and sticky.
- [ ] AI cell references visually match the labels.
- [ ] First row is no longer forced to look like a header.

---

## CHG-4 — Friendly model names

**Goal**
Humans understand the model picker; "qwen3.5:4b" is jargon.

**Task**
Show friendly names for known models everywhere they are listed, keeping
the technical id as secondary text.

**How to do it**
1. Add a map in `src/api.ts` next to `ENGINE_LABELS`, e.g.
   `qwen3.5:4b → "Standard local AI (recommended)"`,
   `qwen2.5vl* → "Vision helper (marks images)"`.
2. Apply in the topbar dropdown (`Workspace.tsx`) and the Settings model
   list: friendly name first, id in smaller/greyer text or a tooltip.
3. Unknown models the user pulled themselves: show the raw id unchanged.
4. The stored setting keeps the raw id — display only.

**How to check it**
1. Dropdown shows "Standard local AI (recommended)" for qwen3.5:4b;
   picking it still saves `qwen3.5:4b` (check settings table).
2. Pull some exotic model → its raw name displays fine.

**Acceptance criteria**
- [ ] Known models get friendly names in both pickers.
- [ ] Underlying stored values unchanged.
- [ ] Unknown models degrade to their id safely.

---

## CHG-5 — Make streaming match what gets saved

**Goal**
What you watch during a multi-step answer is what ends up in the
transcript — today earlier steps' text just vanishes when the final
answer replaces it.

**Task**
Show tool use as separate step lines, reset the live text at each round,
and keep the saved message equal to the final streamed text.

**How to do it**
1. Backend (`agent_loop` in `src-tauri/src/commands.rs`): emit structured
   events instead of mixing everything into `ask-delta`:
   - `ask-step` `{ label }` when a tool runs (replaces the "⚙ name…" text
     emit),
   - `ask-round` when a new model round starts (frontend clears the live
     text area),
   - `ask-delta` only for the current round's text.
2. Frontend: render a list of step chips ("Searched the room",
   "Fetched a page") above the live text; on `ask-round`, move the
   previous partial text into a collapsed/grey "earlier draft" state or
   drop it — but never show it as if it were the final answer.
3. After completion, the message bubble shows exactly the saved content
   (plus effects), and the step chips can collapse into a small
   "N steps" toggle (per-turn UI state only; not saved).

**How to check it**
1. With web on, ask something needing search → steps appear one by one;
   the visible final text equals the saved message after reload.
2. Simple no-tool question → looks exactly like today.
3. Nothing readable "disappears" abruptly at the end of a turn.

**Acceptance criteria**
- [ ] Tool activity is shown as steps, not inline fake-answer text.
- [ ] Live text resets per round; final streamed text == saved message.
- [ ] No regression for plain answers.

---

## CHG-6 — Render Markdown while streaming

**Goal**
No visual "jump" when an answer finishes — formatting appears as it types.

**Task**
Render the live stream through the same Markdown component used for saved
messages.

**How to do it**
1. In `src/Workspace.tsx` (~line 797) the live area renders `{streamText}`
   as plain text. Replace with `<MarkdownView text={patched} />` plus the
   cursor element.
2. Guard half-finished code fences: if `streamText` contains an odd number
   of ``` markers, append a temporary closing fence before rendering
   (display only).
3. Keep the blinking cursor visually after the rendered content.

**How to check it**
1. Ask for "a numbered list with a code example" → list numbers and the
   code block style appear while typing; no re-flow flash at the end.
2. Stop mid-code-block (ADD-7) → no broken layout.

**Acceptance criteria**
- [ ] Live text is formatted identically to the final message.
- [ ] Partial code fences never break the page.
- [ ] The completion moment causes no visible re-layout.

---

## CHG-7 — Make source chips clickable

**Goal**
The little file tags under an answer open the files they name.

**Task**
Clicking a source chip opens that file in the viewer.

**How to do it**
1. In `src/Workspace.tsx` (~line 758) sources render as inert `<span>`s.
   Make them buttons.
2. Sources store file NAMES. On click, resolve name → id against the
   current `files` state (exact name match, newest first — same rule as
   the backend's `find_file_like`). Then `viewFile(id)`.
3. If the file was deleted since: show a notice "That file is no longer in
   the room."
4. Style: hover state + pointer cursor so it looks clickable.

**How to check it**
1. Ask a question grounded in a file → click its chip → file opens.
2. Delete the file, click the chip in the old message → friendly notice,
   no crash.

**Acceptance criteria**
- [ ] Chips are real buttons with hover feedback.
- [ ] Clicking opens the correct file.
- [ ] Deleted files produce a graceful message.

---

## CHG-8 — Cap the creativity slider at 1.0

**Goal**
The slider cannot reach settings where a small model produces word salad.

**Task**
Range 0–1.0, and clamp older saved values above 1.0.

**How to do it**
1. `src/Settings.tsx` (~line 240): `max={1.5}` → `max={1}` (step stays
   0.05).
2. When loading the stored value, clamp anything > 1.0 down to 1.0 and
   save it back.
3. Relabel ends "focused ↔ imaginative" (clearer than precise/creative).

**How to check it**
1. Old room with temperature 1.5 → Settings shows 1.00.
2. Slider physically stops at 1.00.

**Acceptance criteria**
- [ ] Max is 1.0 everywhere; legacy values clamped once.
- [ ] Labels updated.

---

## CHG-9 — Room name in the window title

**Goal**
The title bar (and Mission Control) shows WHICH room is open.

**Task**
Title = "RoomName — Private Room" while unlocked; back to "Private Room"
on lock.

**How to do it**
1. In `Workspace.tsx`, on mount:
   `getCurrentWindow().setTitle(`${info.name} — Private Room`)`
   (`@tauri-apps/api/window`).
2. Reset in the lock path (`handleLock` in `src/App.tsx`).

**How to check it**
1. Open "Taxes.roomai" → title bar reads "Taxes — Private Room".
2. Lock → "Private Room". Mission Control shows the same.

**Acceptance criteria**
- [ ] Title reflects the open room and resets on lock.

---

## CHG-10 — Honest source chips (no credit for filler context)

**Goal**
Chips only name files that really informed the answer. Today, when nothing
matches the question, the app quietly stuffs in "recent chunks" and still
credits those files as sources.

**Task**
When retrieval falls back to recent content (all scores zero), do not add
those files to the message's sources, and tell the model the context is
just "recent content, no direct match".

**How to do it**
1. `retrieve_context` (`src-tauri/src/commands.rs` ~line 1419): return a
   flag `fallback: bool` alongside the chunks.
2. In `ask`: when `fallback` is true, skip the loop that pushes chunk file
   names into `sources` (~line 1581); attachments still count.
3. In the prompt, label the block "Recently added content (may be
   unrelated to the question):" instead of "Context from files…".

**How to check it**
1. Ask "hello, how are you?" in a room with files → answer has NO source
   chips.
2. Ask a real question about a file → chips appear as before.

**Acceptance criteria**
- [ ] Zero-score fallback context never produces source chips.
- [ ] Genuinely matched files are still credited.
- [ ] The model is told when context is only filler.
