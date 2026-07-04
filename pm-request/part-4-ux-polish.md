# Part 4 — UX polish

Smaller annoyances. Each is quick on its own; together they decide whether
the app feels finished.

---

## UX-1 — Right-to-left text (Hebrew / Arabic)

**Goal**
Hebrew text reads correctly everywhere. The settings placeholder literally
anticipates Hebrew users — the chat must not render it badly.

**Task**
Make every text surface direction-aware with `dir="auto"`.

**How to do it**
1. Add `dir="auto"` to: the composer `<textarea>`, message content
   containers (both roles), memory rows and the memory input, chat titles
   in the dropdown, and the custom-instructions textarea in Settings.
2. For the Markdown-rendered assistant messages, set `dir="auto"` on the
   wrapping `msg-content` div and add `unicode-bidi: plaintext` in
   `App.css` so mixed Hebrew/English lines behave.

**How to check it**
1. Type a Hebrew question → right-aligned RTL in the composer AND in the
   sent bubble; the Hebrew answer renders RTL.
2. A mixed sentence (Hebrew with an English word) stays readable.
3. English-only content is unaffected.

**Acceptance criteria**
- [ ] Composer, both message roles, memories, and titles handle RTL.
- [ ] Mixed-direction lines render sanely.
- [ ] No layout breakage in LTR content.

---

## UX-2 — Copy text out of PDFs

**Goal**
Users can get text out of a PDF page. Today pages are pictures (canvas) —
nothing is selectable.

**Task**
Minimum viable: a "Copy text" button per page and a "Copy all text" in
the viewer header. (A fully selectable text layer can come later.)

**How to do it**
1. In `src/viewers/PdfView.tsx`, `page.getTextContent()` is already used
   for highlighting — reuse it: join the items' `str` values into the
   page's text.
2. Add a small button in each `pdf-page-wrap` corner (visible on hover):
   copies that page's text via `navigator.clipboard.writeText`.
3. "Copy all text": the backend already stores `extracted_text`; include
   it as `text` in `get_file_content` for PDFs (`src-tauri/src/commands.rs`,
   the `"pdf"` arm) and wire a header button in `Workspace.tsx`.
4. Hide the buttons when there is no text (scanned PDFs — until ADD-14).

**How to check it**
1. Open a text PDF, click a page's copy button, paste in Notes → matches
   the visible page text.
2. "Copy all" on a long PDF → full document text.
3. A scanned PDF → buttons hidden, no dead controls.

**Acceptance criteria**
- [ ] Per-page copy and whole-document copy both work.
- [ ] Reading order is sensible.
- [ ] Buttons hidden when no text exists.

---

## UX-3 — PDF zoom

**Goal**
Users can zoom PDFs in and out; today it is width-fit only.

**Task**
Add zoom controls (−, percentage, +, "fit width") and ⌘+/⌘− shortcuts
while the viewer is focused.

**How to do it**
1. Add a `scale` state to `PdfView.tsx`; multiply the computed `cssWidth`
   by it; re-render pages on change (debounce ~200 ms so button mashing
   doesn't queue renders).
2. Keep the reader's place: before re-render, note the topmost visible
   page and scroll back to it after.
3. Re-run the quote highlight after re-render (positions depend on scale).
4. Range 50–300%; "fit width" resets to 100% of container.

**How to check it**
1. Zoom to 200% → text is crisp (device-pixel-ratio aware, already
   handled), page position roughly kept.
2. A highlighted quote stays correctly placed after zooming.
3. 50-page PDF: zooming stays responsive (pages render progressively).

**Acceptance criteria**
- [ ] Controls + keyboard zoom work within 50–300%.
- [ ] Highlights track the zoom level.
- [ ] No frozen UI on large documents.

---

## UX-4 — Warn when an attachment was only partly read

**Goal**
The user knows when the AI saw only part of a file, instead of trusting a
quietly incomplete answer.

**Task**
When an attached text file is cut at the 6,000-character limit, say so
visibly.

**How to do it**
1. The cut happens in `ask` (`src-tauri/src/commands.rs`, ~line 1571).
   When truncation occurs, emit a notice event (e.g. reuse `ask-delta`
   with a marker line, or add a small `ask-notice` event) naming the file.
2. Frontend shows it as a notice banner/toast: "Only the beginning of
   'report.txt' was included (file is large). For full coverage, ask
   about it in sections."
3. Longer term this pairs with HLT-4 (indexing caps) — same principle:
   silent partial coverage is never OK.

**How to check it**
1. Attach a 100 KB text file, ask for a summary → the notice appears with
   the file's name.
2. Attach a small file → no notice.

**Acceptance criteria**
- [ ] Every truncation event produces a visible, named notice.
- [ ] Wording explains the impact and what to do about it.

---

## UX-5 — Memory: edit in place, no duplicates

**Goal**
The memory list stays clean and maintainable — today entries can only be
deleted and retyped, and the AI can save the same fact five times.

**Task**
Add inline editing of memories and duplicate-protection on every add.

**How to do it**
1. New command `update_memory(id, content)`; UI in the memory panel:
   pencil icon swaps the row for an input, Enter saves.
2. Dedup: before inserting (both the UI `add_memory` command and the AI's
   `add_memory` tool in `exec_tool`), compare `normalize_for_match(new)`
   against existing memories; if an exact normalized match exists, skip.
   The AI tool returns "Already remembered." so the model doesn't retry.
3. Consider showing the memory count chip even when the panel is
   collapsed (it already does) — no change needed there.

**How to check it**
1. Add "The dog is named Rex" twice via UI → one entry.
2. Tell the AI "remember my dog is named Rex" when it already is → reply
   acknowledges it, list unchanged.
3. Edit a memory → new text persists after relock.

**Acceptance criteria**
- [ ] Exact duplicates (ignoring case/spacing) are impossible from both
      paths.
- [ ] Inline edit works and persists.
- [ ] The AI gets a sensible tool response for duplicates.

---

## UX-6 — Mac keyboard shortcuts

**Goal**
The app feels Mac-native from the keyboard.

**Task**
Add: ⌘N new chat, ⌘L lock, ⌘F search (ADD-6), ⌘, open Settings, Esc close
modal/viewer.

**How to do it**
1. One `keydown` listener at the Workspace level. Only act when the ⌘ key
   is involved (never steal plain typing); Esc acts when Settings/search
   overlay is open, else closes the open file viewer.
2. Map: ⌘N → `newChat()`, ⌘L → `onLock()`, ⌘, → `setShowSettings(true)`,
   ⌘F → search overlay.
3. Add the shortcuts to button tooltips ("Lock ⌘L") so they are
   discoverable.

**How to check it**
1. Each combo does its job from anywhere in the workspace.
2. Typing the letters normally in the composer does nothing special.
3. Esc closes Settings first; with nothing open, closes the file viewer.

**Acceptance criteria**
- [ ] All listed shortcuts work and are shown in tooltips.
- [ ] No interference with normal typing.
- [ ] Esc has a sensible priority order.

---

## UX-7 — Toast notifications instead of one shared banner

**Goal**
Messages to the user stack up readably and clean themselves up, instead of
overwriting each other in a single `notice` slot.

**Task**
Replace the single notice string with a small toast system: stacked,
auto-dismissing for successes, sticky for errors.

**How to do it**
1. In `src/Workspace.tsx`, replace `notice: string` with
   `toasts: { id, kind: "info" | "success" | "error", text }[]` and a tiny
   `pushToast` helper; render them stacked bottom-right of the chat pane.
2. Success/info auto-dismiss after ~5 s; errors stay until closed.
3. Migrate all `setNotice` call sites; the import report shows one toast
   per failed file (grouped if more than 3).

**How to check it**
1. Import 3 unreadable files at once → three readable error toasts (or a
   grouped one), none lost.
2. "Saved into the room" success → disappears by itself.
3. Trigger an error while a success is showing → both visible, stacked.

**Acceptance criteria**
- [ ] Multiple messages can be visible at once without overwriting.
- [ ] Successes auto-dismiss; errors persist until closed.
- [ ] Every old notice call site is migrated.
