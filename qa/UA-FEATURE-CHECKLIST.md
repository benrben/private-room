# Private Room — Complete UA Feature Checklist

**Purpose:** the exhaustive test surface for a user-acceptance agent. Every button, control, menu entry, keyboard shortcut, passive behavior, and background capability in the app, with the path to reach it, the expected outcome, and preconditions. Standard: *not one single feature missed*.

**Built:** 2026-07-20, against version **0.4.1 plus the uncommitted working tree** (Whisper **Metal** dictation, neural-voice picker, new dictation/recording commands). Sources: a 7-agent full-code sweep of the current tree, cross-checked against the 1,587-item feature audit of 2026-07-18. Items marked **(uncommitted)** exist only in the working tree.

**How to use each item:** exercise the control via the stated path, observe the stated outcome, and only then check it off. If a precondition can't be met in the test environment, mark the item *blocked-precondition* rather than skipping silently. File references (`file.tsx:12`) are for debugging failures, not part of the test.

**Global preconditions to arrange before starting:**
- macOS with the app installed (after a local build, run `scripts/macsign.sh` or TCC permission grants die).
- Ollama installed with `qwen3.5:4b` (chat), a vision model, and the embed model for semantic search; some items need Ollama deliberately *stopped* to test degraded states.
- Whisper STT model downloaded (Settings → Model → Dictation) for dictation/transcription items.
- Mic + Screen & System Audio Recording permissions for recording items.
- Network for: neural TTS, web search, YouTube import, auto-update, Ollama `:cloud`.
- Claude Code and/or Codex CLI installed for cloud-engine / advisor / Leash-client items.
- A room with mixed content: PDF (incl. a Hebrew RTL one), DOCX, MD, HTML, code (.py/.js), CSV/XLSX, image, audio, video, a recording, plus folders.

---

## 1. App bootstrap & global behaviors

- [ ] Theme applied before first paint — reload in dark and light; no color flash (`main.tsx:8`, `theme.ts:26`; default dark, stored in `localStorage["prTheme"]`).
- [ ] Silent launch auto-update check — with a newer GitHub release: native confirm "Update available — Install & relaunch"; OK → download + relaunch; Cancel → nothing. Offline/up-to-date → completely silent (`updater.ts:16-38`).
- [ ] Session restore on WebKit reload — reload frontend while a room is open → lands back in workspace, not the gate (`App.tsx:110-122`).
- [ ] `.roomai` Finder double-click, app closed → app launches to that file's Unlock gate (`lib.rs:293-307`).
- [ ] `.roomai` double-click while a *different* room is open → current room closes first, new room's Unlock gate shown (`App.tsx:126-142`).
- [ ] Checkpoint rollback → full workspace remount (every pane rebuilt, Settings closed) (`App.tsx:147-155`).
- [ ] Window: title "Private Room", default 1180×780, min 900×600; no tray, no custom menu (`tauri.conf.json:12-21`).
- [ ] Window title resets to "Private Room" on lock (`App.tsx:441,459`).
- [ ] Seal-unlock animation (~520 ms keyhole bloom) on every successful open; skipped under Reduce Motion (`SealOverlay.tsx`, `App.tsx:254-257`).
- [ ] Seal-lock animation (~460 ms ink veil) on lock; skipped under Reduce Motion (`App.tsx:438-445`).

## 2. Start screen

- [ ] Intro assurances render: "Offline by default", "No account needed", "One file, fully encrypted" (`StartScreen.tsx:26-34`).
- [ ] "Create New Room" → Create screen (`StartScreen.tsx:36`).
- [ ] "Open Room…" → native dialog filtered to `.roomai`; pick → Unlock gate; cancel → stays (`StartScreen.tsx:39`).
- [ ] "Try a demo room" → Create screen pre-seeded with Demo template + name "Demo Room" (`StartScreen.tsx:40`).
- [ ] Recent-rooms list absent when empty; appears after opening a room; auto-refreshes on each Start mount (`StartScreen.tsx:44`, `App.tsx:159`).
- [ ] Recent row shows name, full path, "Opened {relative time}"; click → Unlock gate (`StartScreen.tsx:50-61`).
- [ ] Recent row X ("Remove from list") removes just that row (`StartScreen.tsx:62-69`).
- [ ] "Clear list" (only when non-empty) empties the list (`StartScreen.tsx:73-75`).

## 3. Create room

- [ ] Room-name input (autofocus, placeholder "e.g. Personal, Work, Journal") feeds the default save filename (`CreateScreen.tsx:54-60`).
- [ ] Template chips — exactly 6: Blank, Legal, Medical, Research, Journal, Demo; selection highlighted (`aria-pressed`), blurb updates below (`CreateScreen.tsx:61-81`).
- [ ] Non-blank template seeds instructions + starter memories + Welcome.md (Demo also "Project Brief.md" and "Kickoff Notes.md") — verify after entering the room (`App.tsx:309-340`).
- [ ] Seeding failure is non-fatal: room still opens, error "Room created, but its starter content could not be added." (`App.tsx:342`).
- [ ] Role picker "Give it a role (optional)" appears only when roles load; selection folds instructions into custom instructions and persists `room_role` (`CreateScreen.tsx:82-99`).
- [ ] Password field flags invalid when 0 < length < 8; typing clears the error (`CreateScreen.tsx:100-110`).
- [ ] Strength meter: hidden until first keystroke (space reserved), then Weak/Okay/Strong (`CreateScreen.tsx:114-120`).
- [ ] Criteria checklist ✓/○: "8+ characters", "12+ characters", "Mix of letters, numbers or symbols" (`CreateScreen.tsx:121-130`).
- [ ] Repeat-password mismatch → inline `role=alert` "Passwords do not match." (`CreateScreen.tsx:143-148`).
- [ ] "Create & Enter" disabled while busy / pw < 8 / mismatch; shows "Creating…"; cancelling the save dialog aborts silently (`CreateScreen.tsx:155-166`).
- [ ] "Back" returns to Start (`CreateScreen.tsx:167`).
- [ ] Footer note: "Longer is stronger. You'll get a one-time recovery code next." (`CreateScreen.tsx:171`).

## 4. Recovery-code modal (post-create, shown once)

- [ ] Displays one-time code + "Keep this somewhere safe… never leaves this Mac." (`RecoveryModal.tsx:41-46`).
- [ ] "Copy code" → clipboard; label flips "Copied ✓" (`RecoveryModal.tsx:48-62`).
- [ ] "Print" → native print dialog (`RecoveryModal.tsx:63`).
- [ ] "I saved it" and "Skip for now" both dismiss → room entered with seal animation (`RecoveryModal.tsx:66-72`).
- [ ] If recovery-key write fails, the modal is skipped and the room opens directly (`App.tsx:354-357`).

## 5. Unlock screen

- [ ] Subhead "Unlock {filename}" (`UnlockScreen.tsx:53`).
- [ ] "Use Touch ID" button only when enabled for this room; success → room opens; cancel/fail → error + password fallback (`UnlockScreen.tsx:56-82`).
- [ ] Wrong password → "That password didn't work. Try again."; empty → "Enter your password to unlock this room."; corrupt file → "This room couldn't be unlocked…" (`App.tsx:387-393`).
- [ ] Touch-ID hint shown only when Touch ID *not* set up: "Tip: enable fingerprint unlock in Settings → Privacy." (`UnlockScreen.tsx:101-105`).
- [ ] "Unlock" disabled while busy, label "Unlocking…" (`UnlockScreen.tsx:106`).
- [ ] "Back" → Start (`UnlockScreen.tsx:110`).
- [ ] "Forgot password? Use a recovery code" appears only when a recovery key exists → recovery mode (`UnlockScreen.tsx:116-131`).
- [ ] Recovery mode: code input (placeholder `XXXX-XXXX-…`, auto-capitalize), "Unlock with code" (disabled when empty), bad code → "That recovery code didn't work…", "Use password instead" returns, footer "The recovery code was shown once…" (`UnlockScreen.tsx:143-185`).

## 6. Activity rail (left edge, top-level navigation)

- [ ] Pane toggles with pressed state: Library (⌘1), Workspace (⌘2), AI & Studio (⌘3) (`ActivityRail.tsx:66-99`).
- [ ] AI & Studio toggle shows an amber attention dot when a job is running or an approval is waiting (`ActivityRail.tsx:98`, `Workspace.tsx:107`).
- [ ] Area buttons with current-state highlight: Room home, Room Map, Recordings, Workflows, Scripts, Memory & scratch pad (`ActivityRail.tsx:103-118`).
- [ ] "Search room (⌘K)" button opens the search/command palette (`ActivityRail.tsx:106-114`).
- [ ] "Focus the editor" (zen) hides both side panes; click again restores (`ActivityRail.tsx:121-130`).
- [ ] "Room settings (⌘,)" opens Settings (`ActivityRail.tsx:131-139`).

## 7. Three-pane layout

- [ ] Default 21/50/29 split; Splitter A (Library|rest) and B (Center|AI) drag-resize with clamps (library 13–34 %, AI 20–45 %, center ≥ 30 %) (`useLayout.ts:18-31`).
- [ ] Splitter keyboard: focus + ArrowLeft/Right (Shift = bigger steps); `aria-valuenow` updates (`useLayout.ts:258-286`).
- [ ] Double-click (or Enter) a splitter → reset layout, unhide all, exit focus (`Splitter.tsx:34-43`).
- [ ] ⌘1/⌘2/⌘3 toggle panes; hiding all auto-restores center; Escape exits focus mode (ignored while typing) (`useLayout.ts:290-306`).
- [ ] Narrow window (< 1080 px): exactly one pane; rail buttons *switch* instead of toggle; priority center > ai > library (`useLayout.ts:35-103`).
- [ ] Per-room persistence: resize/collapse, relock + reopen same room → restored; another room has its own layout (`localStorage["prLayout:{room}"]`, `useLayout.ts:58-93`).

## 8. Status bar (bottom strip)

- [ ] Shield indicator, tooltip "This room is an encrypted file on this Mac" (`StatusBar.tsx:35`).
- [ ] Data-route: green "Local · {engine}" on local; amber "Cloud · {engine}" with leaves-the-Mac tooltip on a cloud engine — flips when the model changes (`StatusBar.tsx:38-53`).
- [ ] File count "{n} file(s)" tracks imports/deletes (`StatusBar.tsx:54`).
- [ ] External-tools: "Internet tools on" (amber, tooltip lists online search / N connected tools) vs "No external tools" (`StatusBar.tsx:57-75`).
- [ ] "{n} approval(s) waiting" button appears only when approvals pending → opens AI-pane Activity tab (`StatusBar.tsx:78-86`).
- [ ] "{n} job(s) running" button appears only with background jobs → Activity tab (`StatusBar.tsx:87-96`).
- [ ] Layout label ("3 panes" / "Editor focus" …) mirrors current layout (`StatusBar.tsx:97`).

---

## 9. Top bar

- [ ] Brand seal + room name; both tooltip the room's file path (`TopBar.tsx:80-88`).
- [ ] "Search room or run a command…" pill → ⌘K palette (`TopBar.tsx:90-101`).
- [ ] Live-recording chip (only mid/post-recording): "Recording" / "Recording paused" / "Saving…" with pulsing dot; click opens the recording file (`TopBar.tsx:106-119`).
- [ ] Workflows ⚡ quick menu (⌘J): up to 3 pinned active general workflows as inline one-click pills, overflow in popover, footer "All workflows…" → Workflows page (`TopBar.tsx:57-65,121-136`).
- [ ] Scripts quick menu: global-shortcut scripts as pills (max 2), footer "All scripts…" (`TopBar.tsx:66-75,139-150`); appears only when a script declares `room-shortcut: global`.
- [ ] Model pill: readiness dot ok/warn/down with matching tooltip ("AI ready" / "Model not downloaded" / "Ollama not running"); click opens the engine-model picker (`TopBar.tsx:151-185`).
- [ ] Model menu: pick model → active model changes (status bar + privacy badge follow); stays open only while a cloud submodel's effort remains unpicked; backdrop closes (`TopBar.tsx:186-214`).
- [ ] "Check AI" fallback button (when no models detected) re-polls AI status (`TopBar.tsx:216-220`).
- [ ] Privacy route badge: "Local & private" ⇄ cloud icon "Cloud model", tooltip states whether prompts leave the Mac (`TopBar.tsx:221-236`).
- [ ] Theme toggle: dark ⇄ light, persists per device (`TopBar.tsx:237-244`).
- [ ] Layout-reset button restores the balanced three panes (`TopBar.tsx:245-252`).
- [ ] Room menu (•••): Room settings · Save a checkpoint (success toast names it) · Export all files… (disabled with 0 files) · Reveal in Finder · Send feedback… (`TopBar.tsx:253-337`).
- [ ] Lock button (⌘L) — locks to the gate; marked `data-agent-blocked` so the UI-driving agent can never press it (`TopBar.tsx:343-350`).
- [ ] Escape closes any open header popover (`TopBar.tsx:44-55`).

## 10. Library pane (sidebar)

- [ ] Header shows the area label + live count (files/workflows/scripts/recordings/memories); focus-pane and collapse-pane buttons (`Sidebar.tsx:53-131`).
- [ ] Browse / AI sources tabs (file areas only); AI sources tab badges the attachment count (`Sidebar.tsx:137-156`).
- [ ] Import progress strip "Importing X of Y" during multi-file imports (`Sidebar.tsx:162-169`).
- [ ] File filter input + × clear; placeholder differs for Recordings (`Sidebar.tsx:173-192`).
- [ ] "Add page or source" footer button opens the add menu **upward** (0.3.1 fix — must not clip at the pane edge) (`Sidebar.tsx:217-222`).
- [ ] Add menu: Upload files · New page (blank dated note opens in edit mode) · New folder (inline input) · Web link · Live recording (disabled while one is live) · Voice note · Speak a journal entry (mic-gated) (`Sidebar.tsx:231-346`); Escape closes (`Sidebar.tsx:89-98`).
- [ ] Browse: drag a file to the list root → ungroup; drag onto a folder → move; drag-over highlight on both (`Sidebar.tsx:373-435`).
- [ ] Folder ops: caret / label click collapse-expand (with count), pencil → inline rename (Enter/blur commit, Esc cancel), trash → two-step DeleteControl (files kept, ungrouped), "Empty — drag a file here…" hint (`Sidebar.tsx:436-495`).
- [ ] Empty states: "Add PDFs, notes…" (no files) and "No files match "…"" (filter) (`Sidebar.tsx:403-411`).
- [ ] AI sources panel: checked "Attached to the next question" group vs "Available in this room"; checkbox toggles attachment; row click opens the file, `.is-current` marks the open one (`Sidebar.tsx:525-585`).
- [ ] Recordings navigator: "New live recording" + "Voice note" rows (disabled per state), empty state, recording rows (`Sidebar.tsx:603-643`).
- [ ] Workflows navigator: "New workflow" row, rows with emoji/name/Active-Draft/Pinned/creator/scope tags → detail (`Sidebar.tsx:653-694`).
- [ ] Scripts navigator: rows show approval status (Approved / "Edited — needs approval again" / "Needs review"), Global-shortcut tag, language tag; click opens the script file (`Sidebar.tsx:704-740`).
- [ ] Memory navigator: "Scratch pad" row (get-or-create pinned `Scratch pad.md`), "All memory" count, per-category counts (`Sidebar.tsx:762-799`).

## 11. File rows

- [ ] Click opens the file in the center viewer; selected row highlighted; attached row styled (`FileRow.tsx:18-55`).
- [ ] Drag row to a folder to move (`FileRow.tsx:24-33`).
- [ ] Right-click anywhere on the row → context menu at cursor; hover ⋯ chip → same menu (`FileRow.tsx:34-39,93-104`).
- [ ] Hover paperclip chip attaches/detaches to the next question; image files tooltip mentions vision (`FileRow.tsx:82-92`).
- [ ] Inline rename: input with Enter commit / Esc cancel / blur commit; no-op on unchanged (`FileRow.tsx:41-53`).
- [ ] Badges: ◐ partial-index tooltip on large files; pulsing dot "Transcribing on this Mac…" during STT; size label (`FileRow.tsx:62-78`).

## 12. File context menu (right-click / ⋯)

- [ ] Open · Attach/Detach (label follows state) · Rename… · Move to… (submenu: "No folder" + each folder, current disabled, "No folders yet" empty state) · Export a copy… (`Overlays.tsx:328-423`).
- [ ] "AI actions · this file" section: one chip per file-scoped AI action, tooltip = description → opens the AI-action modal scoped to that file (`Overlays.tsx:333-354`).
- [ ] "Remove from room": two-step ✓ Remove / ✕ Keep; armed confirm is `data-agent-blocked`; removing also detaches, closes its viewer, cancels a live rec on it (`Overlays.tsx:355-383`, `fileActions.ts:279-287`).

## 13. Import paths

- [ ] Upload files picker: multi-select, single receipt toast, queue strip for > 1 file (`fileActions.ts:260-277`).
- [ ] OS drag-drop anywhere on the window → "Drop to add to this room" overlay → import + receipt (`Overlays.tsx:430-437`, `effects.ts:166-190`).
- [ ] > 3 import errors collapse into one error toast (`fileActions.ts:237-258`).
- [ ] Post-import tidy-up suggestions (first 3 files): better title/folder chips — apply one, apply all, dismiss one/all; applying renames/moves + "Tidied up" receipt (`fileActions.ts:140-233`).
- [ ] Web-link modal: title auto-switches "Add a web link" ⇄ "Import YouTube video"; boundary copy states what leaves the Mac; URL input (Enter submits, Esc closes) (`SettingsModals.tsx:226-259`).
- [ ] YouTube: "Transcript only" / "Video + transcript" radios; captions import auto-falls back to full download + on-device transcription when no captions; yt-dlp progress bar; success toast + opens the new file (`SettingsModals.tsx:260-328`).
- [ ] New blank note ("New page") creates `Note YYYY-MM-DD ….md` straight into edit mode (`fileActions.ts:298-309`).

## 14. Center pane (viewer chrome)

- [ ] Breadcrumb "Room / [area/folder] / file"; focus-pane and collapse-pane buttons (`ViewerPane.tsx:99-131`).
- [ ] "Cloud view" ⇄ "Normal view" toggle for text-like files only (not image/audio/video/recording/binary); resets per file (`ViewerPane.tsx:139-151`).
- [ ] Edit / Preview toggle: "Edit" for editable text/code, "Edit as text" for pdf/docx (saving makes a Markdown copy), "Preview" back; hidden in cloud view (`ViewerPane.tsx:152-169`).
- [ ] Run button on .py/.js files; disabled while its job runs; dirty editor → "Save your edits first" toast (`ViewerPane.tsx:172-192`).
- [ ] "Scripts" menu on a file listing other scripts that declare this file as input/output → run (`ViewerPane.tsx:193-221`).
- [ ] History (Time Machine) popover: versions with cause + relative time; empty state "No earlier versions yet."; per-version Compare and two-step Restore (confirm is `data-agent-blocked`) (`ViewerPane.tsx:222-298`).
- [ ] "Copy all text" (only when extracted text exists) (`ViewerPane.tsx:299-307`).
- [ ] Dictate (mic) appends spoken words into an editable file; toggles to "Stop and append the words" (`ViewerPane.tsx:308-321`).
- [ ] "Minutes" on audio/video/recording with real timestamped speech → timeline HTML minutes (`ViewerPane.tsx:322-334`).
- [ ] "Actions" menu: active workflows whose binding matches this file → run on this file (`ViewerPane.tsx:335-365`).
- [ ] Export (agent-blocked) and Close buttons (`ViewerPane.tsx:366-379`).
- [ ] Stale-file banner when the AI wrote while your editor buffer was dirty: "Load AI version" / "Keep editing" (AI version stays in History) (`ViewerPane.tsx:385-411`).
- [ ] Area states: Recordings empty state (Start a live recording / Voice note), sealed-room empty state (Add a file / Summarize room / Ask the room + lock note), front-page dashboard (`ViewerPane.tsx:459-530`).
- [ ] Unknown file kind → "No preview available for this file type yet…" (`ViewerRouter.tsx:327-333`).
- [ ] Lazy-viewer chunk failure (e.g. right after an update) → "This viewer couldn't load… Retry" and Retry works (`ViewerRouter.tsx:31-57`).

## 15. Viewers by file type

**PDF (`PdfView.tsx`)**
- [ ] Lazy page rendering: placeholders rasterize near the viewport; far pages recycle (100+-page books stay responsive) (`PdfView.tsx:220-414`).
- [ ] Zoom −/+/% readout/Fit width; ⌘+/⌘−/⌘0 while hovered; clamps 50–300 % (`PdfView.tsx:472-551`).
- [ ] "{n} pages" label; "Rendering PDF…" status (`PdfView.tsx:552-557`).
- [ ] Per-page "Copy text" (hidden when no text) flips to "Copied" (`PdfView.tsx:83-108`).
- [ ] Citation quote target: highlight boxes + green "Verified" receipt badge, auto-scroll; long-doc scan narrates "Searching… page k of n"; miss → "Couldn't locate the highlighted text" + hinted-page fallback (`PdfView.tsx:116-172,352-404`).
- [ ] Hebrew/RTL PDF: quote location works in visual order (re-imported files) (`PdfView.tsx` + `highlight.ts`).
- [ ] Broken PDF → calm "This PDF could not be opened" panel (`PdfView.tsx:510-520`).

**Image (`ImageView.tsx`)**
- [ ] "Ask AI to mark something" + Find → labeled boxes over matches; status "Found N matches" / not-found / error; Clear removes boxes (`ImageView.tsx:80-176`).
- [ ] No vision model + Ollama up → "Download the vision helper (~3 GB)" offer with live progress → "Vision helper ready" (`ImageView.tsx:48-133`).
- [ ] Zoom −/+/100 %/Fit with clamps 25–400 %; boxes track zoom (`ImageView.tsx:223-298`).

**Audio / video (`AudioView.tsx`)**
- [ ] Native player streams via `roommedia://` (base64 fallback) (`AudioView.tsx:196-224`).
- [ ] "Length m:ss · Transcript ready / Transcribing on this Mac… / No speech detected / No transcript yet" states (`AudioView.tsx:225-284`).
- [ ] Clicking a timestamped transcript row seeks + plays; playhead follows with row highlight; chat citation auto-seeks + flashes (`AudioView.tsx:161-258`).

**Recording (`RecordingView.tsx`)** — see §22 for capture; viewer-side:
- [ ] Speaker-grouped transcript with colored speaker chips ("You" = accent); per-turn RTL/LTR (`RecordingView.tsx:290-315,660-721`).
- [ ] Turn timestamp "Jump to this moment" and word click-to-seek (drag-select ≠ seek) (`RecordingView.tsx:671-707`).
- [ ] Select words → action bar "N words · t0–t1": Delete from recording (soft cut; playback skips; toast notes Export makes it permanent) / Keep (`RecordingView.tsx:346-380,737-747`).
- [ ] Translate-into input + button → whole transcript translated into a NEW file, progress "done/total" (`RecordingView.tsx:754-772`).
- [ ] Re-transcribe (two-step confirm) rebuilds from audio, old transcript → History; works as rescue when duration metadata is corrupt (`RecordingView.tsx:774-799`).
- [ ] "Export edited copy" bakes cuts into "<name> (edited)"; disabled with no edits (`RecordingView.tsx:802-809`).
- [ ] "Show deleted" checkbox reveals soft-deleted words (`RecordingView.tsx:810-817`).

**Spreadsheet / CSV (`SheetView.tsx`)**
- [ ] Sheet tabs (multi-sheet); column letters + row numbers sticky; numeric right-align (`SheetView.tsx:104-159`).
- [ ] Edit mode (non-.xls): click cell → input, Enter/blur commits immediately, Esc cancels; "Editing — click a cell…" banner (`SheetView.tsx:95-186`).
- [ ] Citation range target selects sheet + highlights A1 rectangle + scrolls (`SheetView.tsx:58-93`).
- [ ] "Showing first 1,000 of N rows" truncation notice; parse failure → "Could not parse this spreadsheet." (`SheetView.tsx:74-76,193-197`).

**Code (Monaco, `CodeEditor.tsx`)**
- [ ] Editor with language by extension, word wrap, no minimap; read-only in preview (`CodeEditor.tsx:44-83`).
- [ ] Save button + ⌘S; "Save copy" label in copy mode (pdf/docx/text → "<base> (edited).md") (`CodeEditor.tsx:69-104`).
- [ ] "● unsaved changes" ⇄ "all changes saved" dirty indicator (drives the stale-file banner) (`CodeEditor.tsx:37-42`).
- [ ] Search/citation target selects + centers the first match (`CodeEditor.tsx:59-67`).

**HTML (`HtmlView.tsx`)**
- [ ] Sandboxed preview (inline JS/CSS run, network blocked) + "Running in a sandbox…" note (`HtmlView.tsx:32-68`).
- [ ] "Open in browser ↗" (agent-blocked) hands to the real browser (`HtmlView.tsx:51-78`).

**Markdown / DOCX / plain text**
- [ ] Markdown GFM render + quote highlight (`MarkdownView.tsx:11-26`).
- [ ] DOCX render + quote highlight; failure → "Could not render document: …" (`DocxView.tsx:11-43`).
- [ ] Plain text `<pre>` + quote highlight/scroll (`TextView.tsx:5-13`).

**Cloud view (`CloudView.tsx`)**
- [ ] Shows the file exactly as a cloud model would receive it, private details as blackout marks; ribbon "…N mentions of M private details stay on this Mac" (or "nothing here is marked private"); loading/error states (`CloudView.tsx:9-83`).

## 16. Compare & versions

- [ ] CompareModal from History → side-by-side Monaco diff "This version vs now" with cause + time header (`CompareModal.tsx:33-72`).
- [ ] Diff view / Plain view toggle (plain = two scrollable panes; tooltip recommends it for Hebrew/Arabic); automatic RTL hint on RTL-dominant text (`CompareModal.tsx:74-86,143-147`).
- [ ] Restore this version: two-step, both stages `data-agent-blocked`; restores and closes (`CompareModal.tsx:89-113`).
- [ ] Esc / backdrop close; "This version has no text to compare." empty state (`CompareModal.tsx:114-123`).

## 17. Room Map

- [ ] Toolbar "Room map · N files · M links" (`RoomMap.tsx:168-177`).
- [ ] File stars (violet) vs memory rings (green); size scales with connectedness; hover halo + tooltip (name, folder/"Top level"/"Memory", summary) (`roomMap/NodeStar.tsx:21-93`).
- [ ] Click a file star → opens the file; memory nodes not openable (`RoomMap.tsx:229-245`).
- [ ] Edge hover → "why linked" tooltip (shared reasons or "N % similar") (`roomMap/Edge.tsx:17-57`).
- [ ] De-cluttered name labels for focused/neighbour/large stars; more appear as you zoom (`RoomMap.tsx:102-164`).
- [ ] Wheel zoom-to-cursor, drag pan, click-empty deselect; + / − / Reset view buttons (`usePanZoom.ts:47-104`, `RoomMap.tsx:262-300`).
- [ ] Settle animation then auto-fit until the user grabs it; live re-fetch on room-files-changed; deterministic layout (`roomMap/useRoomGraph.ts`).
- [ ] Empty state "Add a few files and I'll map how they connect." (< 2 file nodes) (`RoomMap.tsx:182`).

## 18. Studio

- [ ] StudioShelf sections: "From the open file" (file scope) vs "From this room's sources" (room scope) (`StudioShelf.tsx:19-21`).
- [ ] Create rows: Flashcards, Mind map, Podcast script → prompt modal (`StudioShelf.tsx:22-62`).
- [ ] Room-scoped "AI actions" chip grid (tooltip = description, disabled while busy) (`StudioShelf.tsx:63-84`).
- [ ] StudioModal: editable seeded prompt, `@`-mention autocomplete over files & folders (↑↓/Enter/Tab/Esc + mouse), ⌘Enter runs, Cancel, Run disabled on empty prompt (`StudioModal.tsx:26-150`).
- [ ] Run fires a **background job** and closes immediately; progress + result on the job card, which self-opens the finished file. (The old in-modal Stop/status line is gone — its absence is correct.) (`studioActions.ts:111-126`).
- [ ] "Summarize room" starts a deep-summary job; if one exists it resumes/surfaces instead of duplicating (`studioActions.ts:35-67`).
- [ ] Job controls: pause (checkpoint → Resume), resume, dismiss (`studioActions.ts:70-88`).

## 19. Front page (Room home)

- [ ] "Continue where you left off": recent file rows (icon, name, relative time) and recent chat rows → open file / switch chat; "Nothing here yet…" empty state (`FrontPage.tsx:53-94`).
- [ ] Capability rows: Record and transcribe · Automate repeated work · Run a room script · See how files connect (disabled with 0 files) · Manage memory (shows count) · Transform your sources (Studio tab) (`FrontPage.tsx:104-186`).
- [ ] Suggestions tray: toggle with count; clicking a suggestion fills the composer and focuses it (`FrontPage.tsx:193-214`).

## 20. Search / command palette (⌘K, also ⌘F)

- [ ] Input with 200 ms debounced full-room search; ↑↓ move, Enter runs, Esc/backdrop close; hint bar (`Overlays.tsx:438-458,587`, `effects.ts:580-603`).
- [ ] Result groups: Files, Messages, Memories (each row navigates to the hit) + summary counts line; "Nothing matches "…"" empty state (`Overlays.tsx:460-563`).
- [ ] Commands group (filtered by query): New chat (⌘N) · Add files… · New page · Import a web link · Start a live recording · Record a voice note · Summarize the room · Go to Room home · Open the Room Map · Open Workflows · Open Scripts · Open Memory & scratch pad · Focus the editor · Reset the three-pane layout · Switch theme · Save a checkpoint · Export all files… · Room settings (⌘,) · Send feedback… · Lock this room (⌘L) — disabled entries skip on Enter (`Overlays.tsx:89-113,564-585`).

## 21. Global overlays, toasts, approval cards

- [ ] Capture dock above the composer whenever the mic is active: "Preparing the microphone…" / "{owner} — transcribing…" + timer + "Stop & save" (`Overlays.tsx:26-66`).
- [ ] Script-run consent card (`data-agent-blocked`): interpreter line + Installs/Reads/Writes-back; Run once / Always allow this exact script / Don't run (`Overlays.tsx:170-222`).
- [ ] MCP tool-call approval card (`data-agent-blocked`): tool + server + args; Allow once / Always allow this connector / Don't allow (`Overlays.tsx:223-262`).
- [ ] Edit approval card (`data-agent-blocked`): DiffPreview per file (first 5, "+N more", side-by-side ≥ 720 px else inline, "Preview truncated" when clipped); Apply / Apply for the rest of this answer / Don't apply (`Overlays.tsx:263-319`, `DiffPreview.tsx:16-55`). Precondition: Settings → Behavior → "Ask before the AI edits files".
- [ ] Toast stack: success/error/info; error persists 9 s, others 5 s; optional action button (e.g. "Open Ollama", "Open", "Open Settings"); × dismiss (`Toasts.tsx:11-35`, `state.ts:305-316`).
- [ ] Ollama-down error path on any AI action: "Ollama is not running. Start the Ollama app, then try again." with working "Open Ollama" action (`guard.ts:6-12`).
- [ ] Sync-warning one-time banner for rooms in a synced folder (dismiss persists) (`effects.ts:265-272`).
- [ ] Two-step DeleteControl pattern everywhere: arm → ✓/✕, auto-disarm ~3 s, armed state `data-agent-blocked` (`DeleteControl.tsx:24-54`).

## 22. AI pane, chat & composer

**AI pane frame (`AiPane.tsx`)**
- [ ] Tabs Chat / Studio / Activity with `aria-selected`; Activity tab dot: red when approvals pending ("Something needs your approval"), busy-styled when only jobs running (`AiPane.tsx:51-87`).
- [ ] Focus-pane and collapse-pane buttons (`AiPane.tsx:89-104`).
- [ ] Context strip: "N attached source(s)" or "the whole room" button → opens Library "AI sources" tab; read-only Cloud/"On device" mini badge (`AiPane.tsx:113-145`).
- [ ] Studio tab: intro adapts to open-file vs room; StudioShelf; "Summarize the room" row (disabled with 0 files / already starting / job running; "Create" ↔ "Working…"); privacy note flips wording on a cloud engine (`AiPane.tsx:176-204`).
- [ ] Activity tab: "Needs your approval" read-only rows (script / MCP tool call / edit diff); import-progress row; optimistic "Starting…" summary card; "Saving recording" card with stage copy + elapsed + Open button (`AiPane.tsx:261-372`).
- [ ] Job rows: title + elapsed; file-pass heat mosaic ("M of N parts read"); progress bar; foot status (queued "Waiting — Nth in line" / running label / friendly error / "Paused at X of Y"); Remove (queued) · Stop (running, checkpoints) · Retry/Resume (parked) · × dismiss; "Nothing running right now…" empty state (`AiPane.tsx:380-512`).

**Chat header & banners (`ChatPane.tsx`)**
- [ ] Chat picker select switches chats; pencil → inline rename (Enter/Esc/blur); "＋ New" (⌘N); trash → two-step delete (confirm `data-agent-blocked`; deleting the last chat auto-creates a fresh one) (`ChatPane.tsx:53-125`).
- [ ] Auto-speak toggle (pressed state + tooltips) and Hands-free toggle (mic re-arms after each answer) (`ChatPane.tsx:91-114`).
- [ ] Privacy-off banner (`role=alert`) when a cloud engine runs with privacy off: "Privacy is off — cloud models can see everything…" (`ChatPane.tsx:140-145`).
- [ ] Ollama onboarding: not installed → "Get Ollama" + "I installed it — check again"; installed-not-running → "Open Ollama" (polls status) (`ChatPane.tsx:146-172`).
- [ ] Model-not-ready: live pull progress, or the recommended-model picker cards (qwen3.5:4b Balanced/Recommended · qwen3.5:9b Higher quality · gemma3:4b Compact) each with Download; pull error text (`ChatPane.tsx:175-222`).
- [ ] Sync-warning banner + Dismiss (synced-folder rooms) (`ChatPane.tsx:128-137`).

**Messages (`ChatPane.tsx`)**
- [ ] Empty-state hero + 4 prompt chips (fill composer, don't auto-send) + command-hint chips (`#name`) (`ChatPane.tsx:226-273`).
- [ ] Message rows: "Room AI" vs "You", assistant Markdown / user plain, `dir=auto`; annotated-image answers render the marked image inline (`ChatPane.tsx:276-313`).
- [ ] Citation chips: quote/note/range + file name; verified quotes get check + "Verified" badge, approximate get "· ≈ closest match"; click opens the file at the highlight; "Copy as receipt" on verified quotes (`ChatPane.tsx:314-366`).
- [ ] Assistant footer: source chips (open newest matching file; info toast if gone) · ▶ Play/◼ Stop TTS · Copy · "Undo edit"/"Undo N edits" (when the answer edited files) · Regenerate (last answer only; re-runs the turn, paperclip attachments intentionally dropped) · "Save to room" inline form (name default "AI note.md", Enter saves) (`ChatPane.tsx:374-454`).
- [ ] Streaming: pulsing placeholder ("Thinking locally…" vs "Asking your cloud AI — content leaves this Mac…"), lane + step chips (failed steps ⚠ with tooltip), live Markdown + ▍ cursor (`ChatPane.tsx:460-494`).
- [ ] Privacy receipt after cloud turns: "N private detail(s) hidden…" / "Shielded — nothing private needed hiding" / "Real details were shared this once" (+ "N image(s) kept on this Mac") (`ChatPane.tsx:497-515`).
- [ ] "Ask again with real details (this once)" valve (`data-agent-blocked`): two-step with "Yes, this once" (danger) / Cancel (`ChatPane.tsx:516-545`).
- [ ] Memory-suggestion card (`data-agent-blocked`): "Worth remembering?" — Save to memory / Ignore / Always save (turns on auto-save; auto-saved turns show a "Forget" undo toast) (`ChatPane.tsx:548-580`).
- [ ] Anti-fabrication: an answer claiming an edit/highlight that no tool performed gets a visible appended correction (`agent.rs:312-320`).

**Composer (`ComposerPane.tsx`)**
- [ ] Import-tidy batch card ("N new files could be renamed and filed." — Tidy up / Review / ×) and per-file Apply/Dismiss chips (`ComposerPane.tsx:42-96`).
- [ ] Cloud strip "Cloud · leaves this Mac" + "Use local" button (`ComposerPane.tsx:98-110`).
- [ ] Internet badge "This room can reach the internet" (web on or MCP tools; suppressed for external CLI engines unless advisor-tools on) (`ComposerPane.tsx:115-138`).
- [ ] Attach-nudge when the question names an unattached image + "Attach it" (`ComposerPane.tsx:139-162`).
- [ ] Attachment chips with × remove (`ComposerPane.tsx:163-172`).
- [ ] `#`/`@` autocomplete popover: count header, ↑↓/Enter/Tab/Esc, mouse insert; `@folder/` expands to its files; unknown `#word` → error toast listing valid commands (`ComposerPane.tsx:174-205`, `composer.ts:41-98`).
- [ ] `#help` opens the commands sheet locally (never sent); Esc closes (`ComposerPane.tsx:206-242`).
- [ ] Textarea: Enter sends, Shift+Enter newline, `dir=auto`; paste an image → imported + auto-attached (`ComposerPane.tsx:243-264`, `chatActions.ts:466-488`).
- [ ] "Attach" chip inserts `@`, "# Action" chip inserts `#` (both open the matching autocomplete) (`ComposerPane.tsx:267-281`).
- [ ] Mic button states: "Dictate (transcribed on this Mac)" / "Preparing the microphone…" / "Stop recording" / "Transcribing…"; disabled while asking or another surface holds the mic (`ComposerPane.tsx:283-296`).
- [ ] Send (disabled when empty) ⇄ Stop ("◼", cancels ask + silences speech) (`ComposerPane.tsx:297-314`).
- [ ] MODEL_MISSING on send → toast with a working "Download" action (`chatActions.ts:49-163`).

**AI-action modal (`AiActionModal.tsx`)**
- [ ] Title = action + scope (this file / this folder / whole room); backdrop closes unless running (`AiActionModal.tsx:7-37`).
- [ ] Language input (datalist of 14 languages) when the action needs one; question input when needed; Run disabled until required inputs present (`AiActionModal.tsx:42-94,183-195`).
- [ ] Editable prompt textarea + `@`-mention autocomplete; ⌘Enter runs; Cancel (`AiActionModal.tsx:96-182`).

## 23. Voice output, dictation & recording capture

**Spoken answers (`voice.ts`, `voiceActions.ts`)**
- [ ] Auto-speak reads the streaming answer sentence-by-sentence; external-CLI engines (no delta stream) speak the persisted answer at turn end (`voice.ts:164-242`).
- [ ] Neural engine default: Edge TTS "Andrew", +22 % rate / −2 Hz, ~−16 LUFS; offline/sidecar-down → per-sentence on-device fallback (degrades, never goes silent) (`voice.ts:18-51,426-467`).
- [ ] Archetype DSP (Demon/Ghost/Wraith/Ancient/Custom) applies to both engines; manual ▶ Play uses a clean chain when archetype is off (`voice.ts:64-72,562-670`).
- [ ] New turn / Stop / lock / auto-lock cancel all audio immediately (`voice.ts:182-259`).
- [ ] Hands-free: after the streamed answer's audio fully finishes, the mic re-arms and the next dictation auto-sends (no self-capture of the tail) (`voice.ts:315-317,724-734`).

**Dictation — streaming, on-device (`recordingActions.ts`)** *(uncommitted rewrite: live partial streaming; Whisper now Metal-accelerated)*
- [ ] Composer mic: streamed dictation; final transcript appended to the question; STT model missing → error toast with "Open Settings" (`recordingActions.ts:98-210`).
- [ ] Live partials paint during dictation where a surface subscribes (`dict-partial` events).
- [ ] Dictation shaping: `dict_translate` + `dict_mode` applied to the final text; shaping failure keeps the exact transcript + info toast (`recordingActions.ts:151-180`).
- [ ] Other dictation owners: journal ("Speak a journal entry" → appends to `Journal {date}.md`, created under a "Journal" folder), open-file dictation (ViewerPane), memory draft (MemoryView); one shared mic — other owners' buttons disable while one records (`recordingActions.ts:224-262,196-210`).
- [ ] Voice note (MediaRecorder path): imports `Voice note {stamp}` + toast "transcript is being written…" (`recordingActions.ts:25-89,212-222`).
- [ ] Dictation speed sanity: with Metal STT (uncommitted) decode should be far faster than realtime; Quit during/after dictation must not crash (Metal context unload on exit, `stt.rs unload_ctx`).

**Live recording — capture layer (`recordingActions.ts`, `liveRec.ts`; viewer UI in §15)**
- [ ] Start: guards a second session (info toast + opens the live one); mic acquired first; mic denied → Mac-audio-only continues with explanatory error toast (`recordingActions.ts:269-314`).
- [ ] Pause / Resume (mute state survives) / Stop & save → "Recording saved — transcript included." toast with Open action (`recordingActions.ts:316-362`).
- [ ] Mic mute is track-level (Mac audio keeps recording) (`liveRec.ts:47-55`).
- [ ] Live transcription toggle per session (starts ON); live translate into 16 languages pre-start or mid-session (`RecordingView.tsx:574-594`).
- [ ] System-audio permission failure → banner + "Open System Settings" deep link (Screen & System Audio Recording) (`RecordingView.tsx:601-618`).
- [ ] AudioWorklet tap with ScriptProcessor fallback; ~250 ms PCM batches; teardown flush so the closing word isn't clipped (`liveRec.ts:175-279`).
- [ ] Crash-proofing: checkpoints from an interrupted recording splice back on next unlock; orphaned jobs offer Resume (0.3.0 changelog).

## 24. Memory area

- [ ] Header explains visible/editable memory + auto-save note (`MemoryView.tsx:46-54`).
- [ ] Add row: text input (Enter adds), mic dictate button (appends transcript into the draft), category select (no category/preference/fact/project/instruction), Add button (`MemoryView.tsx:57-96`).
- [ ] Groups: Instructions/Preferences/Projects/Facts/Other, only non-empty (`MemoryView.tsx:119`).
- [ ] Edit mode per memory: content input (Enter save/Esc cancel), category select, ✓ Save / ✕ Cancel (`MemoryView.tsx:119-167`).
- [ ] View mode: content + category pill, pencil → edit, DeleteControl × → two-step delete (`MemoryView.tsx:168-205`).
- [ ] "Nothing saved yet…" empty state; scratch-pad section with "Open the scratch pad" button (`MemoryView.tsx:99-107,209-219`).
- [ ] First-open memory intro appears once per room (`MemoryView.tsx:32-41`, `effects.ts:628-637`).

## 25. Workflows

**Library (`WorkflowLibrary.tsx`)**
- [ ] AI-compose bar: description input (Enter or "Compose with AI"; disabled while busy/empty) → "Composing a workflow…" toast → draft opens with "Draft ready — review and activate it."; failure → error toast (`WorkflowLibrary.tsx:16-56`).
- [ ] Empty state: heading, template cards (emoji, name, schedule badge, description, "Use template →") → instantiates a draft and opens it; "Blank workflow" ＋ card (`WorkflowLibrary.tsx:152-186`).
- [ ] Populated: "＋ New workflow" button; cards with emoji/name, 📌 pin indicator, description, Draft badge, last-run dot (Ran OK / Failed / Running), "Drafted by the agent" badge, schedule badge with live countdown ("· in 5m / due now", 30 s auto-tick), file-binding badge "On: …" (`WorkflowLibrary.tsx:188-225`).
- [ ] Script-created workflows are hidden here (they live on the Scripts page) (`WorkflowLibrary.tsx:96-99`).

**Detail (`WorkflowDetail.tsx`)**
- [ ] Header: ← Library · emoji input · name input (edits mark dirty) · ▶ Run now (active only) · Activate (disabled while invalid) / Deactivate · Save (dirty && valid) · 📌 Pin/Unpin (general-scope only) · 🕒 Schedule · Delete (`data-agent-blocked`) (`WorkflowDetail.tsx:170-222`).
- [ ] Draft banner + "Drafted by the agent" badge; validation panel "Fix these before activating:" recomputed on every edit (`WorkflowDetail.tsx:237-253`).
- [ ] Canvas: auto-layout DAG (no free drag — by design), bezier edges with then/else branch labels, live edge highlight when source node is done, node cards with kind + label + live status (tooltip = peek), click selects; per-node "+" adds a step after; empty-canvas "+" (`PipelineCanvas.tsx:24-167`).
- [ ] Param sheet per node: Step name; Step type select (Generate text / Summarize a file / Full-file pass / Ask the agent / Save a file / Condition) seeding defaults on switch (`NodeParamSheet.tsx:96-114`).
  - [ ] generate: prompt textarea (`{{input}} {{files}} {{date}}` hint) + model segmented Auto/Local/Cloud.
  - [ ] summarize_file & file_pass: "Which file(s)" select — Newest file / **All files (uncommitted)** / Name contains… (+ pattern input) / Files missing a summary / Added since last run / The file this runs on.
  - [ ] file_pass: instruction textarea + merge/stitch segmented control.
  - [ ] agent_run: "Question for the agent" textarea.
  - [ ] save_file: file name (`{{date}}` hint), html/md segmented, "When it exists" Create new/Overwrite/Append.
  - [ ] condition: op select (not empty / empty / contains… / does not contain… / new files since last run) + text input for contains ops; branch editor — per-branch then/else select, target-node select, × remove, "+ Add branch" (forward-target default, disabled with no other nodes) (`NodeParamSheet.tsx:238-293`).
  - [ ] "Delete step" (`data-agent-blocked`) removes node + its edges (`NodeParamSheet.tsx:297-299`).
- [ ] Binding editor "Where it appears": General / Specific files; file scope → 13 kind badges (image…binary), comma-separated extensions input, "Only this specific file" select (incl. "(bound file — not in this room)" fallback) (`WorkflowDetail.tsx:276-348`).
- [ ] Schedule popover: Off / Every N minutes / Daily HH:MM / Weekly day+time; Enabled + "Catch up at unlock" checkboxes; caption "Runs while this room is open and unlocked…"; Save with blank kind clears; file-scoped workflows get the disabled variant (`SchedulePopover.tsx:26-118`).
- [ ] Run history: rows (status dot, trigger, localized start time, error text, ▾ expand) → lazy-loaded per-step artifacts; skipped steps say "Step skipped."; "No runs yet." (`RunHistory.tsx:95-146`).
- [ ] Live per-node status during a run (canvas updates while running) (`WorkflowDetail.tsx:92-94`).
- [ ] File-scoped runs: matching workflow appears in the open file's "Actions" menu and runs on that file with toast "<name> started on <file>" + View action (`workflowActions.ts:51-61`).
- [ ] Pinned workflows run one-click from the TopBar ⌘J menu (`TopBar.tsx:57-65`).

## 26. Scripts

- [ ] Scripts page: header + Close; empty state documents the manifest headers (`dependencies`, `room-inputs`, `room-outputs`, `room-timeout`, `room-shortcut: global`) and the materialize→run→save-back-as-versions model (`ScriptsPage.tsx:13-43`).
- [ ] Script rows: name + language badge; "Needs review" ribbon + styling when edited since approval; live pulsing run indicator with progress label; last-run ok/err badge + finished time; "never run" caption (`ScriptRow.tsx:43-67`).
- [ ] Chips: 📦 deps (uv-installed), "→ file" inputs, "← file" outputs, top-bar/file shortcut chip (`ScriptRow.tsx:70-91`).
- [ ] Run button (disabled while running) → consent card on first run/changed hash; declining shows info toast "<name> was not run." not an error (`ScriptRow.tsx:94-101`, `scriptActions.ts:32-47`).
- [ ] Schedule: approved scripts get the schedule toggle + popover (interval/daily/weekly + catch-up); unapproved scripts see a disabled button with tooltip "Run this script once and choose 'Always allow' — then you can schedule it." (`ScriptRow.tsx:104-138`).
- [ ] "Runs"/"Hide runs" history with per-step script report: exit-code badge, stdout/stderr `<pre>`, "Imported N file(s): …" (`ScriptRow.tsx:139-150`, `RunHistory.tsx:15-40`).
- [ ] Dependencies self-install via uv (declared PEP-723 or on-the-fly self-healing) — verify a script with an undeclared import still runs (`0.3.0 changelog`).
- [ ] Outputs come back as versioned room files (undo via Time Machine).

## 27. Settings

**Shell**
- [ ] Opens from rail ⌘, / room menu / palette; backdrop + Esc close (Esc swallowed inside Custom-instructions and MCP JSON textareas); X close; focus trap; whole backdrop `data-agent-blocked` — the UI-driving agent can never operate Settings (`Settings.tsx:195-215`, `useFocusTrap.ts`).
- [ ] Nav: 14 jump buttons in 5 groups (AI & behavior / Voice & dictation / Privacy & recovery / Connections / History & storage); smooth-scroll; note label≠heading cases ("Online search"→"Online features", "Connectors (MCP)"→"Connections (MCP)", "Room server"→"Room as a tool (MCP server)") (`Settings.tsx:220-262`).
- [ ] On close, workspace re-reads web access, autolock, privacy, memory auto-save (`SettingsModals.tsx:44-50`).

**Model**
- [ ] Engine-model picker: "On this Mac" tab (local models; "Ollama is not running…" empty state); "Cloud" tab (disabled until a cloud option exists; `:cloud` models badged "Cloud · leaves this Mac"; detected CLI engines listed) (`EngineModelPicker.tsx:110-183`).
- [ ] Cloud engine expander fetches its live model list ("Checking…"/error); reasoning-effort chips per model; "[engine]'s default" row (`EngineModelPicker.tsx:184-276`).
- [ ] Capability badges per model: cloud / 🔧 tools / 👁 vision (`ModelSection.tsx:83-108`).
- [ ] Delete model: trash → "Delete?" ✓/✕ (auto-revert 3 s); active model's trash disabled with title (`ModelSection.tsx:109-137`).
- [ ] "No tools" warning when the selected model lacks tool support; cloud privacy warning when cloud engines present (`ModelSection.tsx:140-161`).
- [ ] Download-a-model input + button with live progress; errors in the shared banner (`ModelSection.tsx:164-188`).
- [ ] Dictation: "Download voice model" (~MB + progress) → "Voice model installed ✓"; trash deletes; error line (`ModelSection.tsx:194-227`).
- [ ] "Translate dictation to English" checkbox (immediate) (`ModelSection.tsx:230-237`).
- [ ] "Shape dictation as" select — Exact words / Cleaned up / Notes / Email body / Chat message / Commit message / Optimized AI prompt (immediate; verify dictated text is reshaped) (`ModelSection.tsx:238-258`).

**Behavior**
- [ ] Creativity slider 0–1 (Save-gated); Response style Default/Terse/Friendly/Formal (immediate); Custom instructions textarea (Save); Save → "Saved ✓" (`BehaviorSection.tsx:54-104`).
- [ ] "Describe new files automatically with the local AI" (auto-index, immediate, default on) (`BehaviorSection.tsx:105-112`).
- [ ] "Save suggested memories automatically" (immediate, default off) (`BehaviorSection.tsx:113-120`).
- [ ] "Ask before the AI edits files": Off / Once per answer / Every edit (immediate; drives the edit-approval card) (`BehaviorSection.tsx:121-139`).

**Spoken voice**
- [ ] Engine segmented: Neural (default) / On-device, each with honest helper text (`VoiceSection.tsx:91-121`).
- [ ] **(uncommitted)** Neural voice select — 9 voices: Andrew (default) · Brian · Ava · Emma · Rémy · Vivienne · Seraphina · Avri (Hebrew) · Hila (Hebrew) (`VoiceSection.tsx:122-142`).
- [ ] Archetype segmented: Plain / Demon / Ghost / Wraith / Ancient / Custom; presets load slider defaults; touching any slider flips to Custom (`VoiceSection.tsx:143-156`).
- [ ] Device-only: system-voice select + pitch (0.5–2.0) + rate sliders; always: reverb + distortion sliders (`VoiceSection.tsx:157-177`).
- [ ] Preview/Stop preview speaks the fixed phrase with LIVE unsaved settings (neural needs network) (`VoiceSection.tsx:178-181`).
- [ ] Save applies to the live voice engine without reopening the room; "Saved ✓" (`VoiceSection.tsx:182-184`).

**Cloud privacy (the gatekeeper)**
- [ ] Room toggle "Hide private details from cloud AI" (default on; `data-agent-blocked`); OFF reveals the red open-door warning (`CloudPrivacySection.tsx:112-132`).
- [ ] Global-default toggle with follows/own-choice label (`CloudPrivacySection.tsx:133-150`).
- [ ] "Never share these": text + category (Person/Address/Phone/Email/ID number/Organization/Other) + Add (Enter works) → guaranteed mechanical block (`CloudPrivacySection.tsx:152-182`).
- [ ] Entity map: real text → placeholder rows tagged "guaranteed" vs "found by scan"; × removes (tooltip differs by source) (`CloudPrivacySection.tsx:183-213`).
- [ ] "Private topics" textarea, one per line, saves on blur (best-effort) (`CloudPrivacySection.tsx:215-231`).
- [ ] Scan status line ("Scanning N of M — label…", pending count, "All files scanned."); "Scan now" (disabled while scanning; errors show *under the button*); scan re-runs on import/transcription/rule changes (`CloudPrivacySection.tsx:233-267`).
- [ ] 0.4.1: scanner pauses between files while a chat turn is in flight — Settings shows "Paused while you chat", resumes after.
- [ ] Honest-limits note present (`CloudPrivacySection.tsx:269-273`).

**Privacy**
- [ ] Auto-lock select Off/5/15/60 min (immediate; default 15) — verify idle room locks; live recording and active speech count as activity (`PrivacySection.tsx:79-88`, `effects.ts:452-510`).
- [ ] Change password (current/new/repeat, ≥ 8 + match) → "Password changed ✓"; re-keys checkpoints; issues a NEW recovery code via one-time sheet (Copy/Print/Done); failure warning if recovery re-issue fails (`PrivacySection.tsx:93-166`).
- [ ] Touch ID toggle stores/deletes the Keychain entry; unlock screen follows (`PrivacySection.tsx:168-192`).
- [ ] Duplicate room: choose destination + optional new password → "Duplicated ✓" (`PrivacySection.tsx:199-226`).
- [ ] Compact room: arm → Confirm compact (danger) / Cancel; result message (`PrivacySection.tsx:228-269`).

**Checkpoints**
- [ ] Create (optional name, Enter works) → "Saved checkpoint '…'"; count + disk usage; > 1 GB warning (`CheckpointsSection.tsx:77-112`).
- [ ] Rows: auto-vs-manual dot, name, time + size; Roll back (two-step inline confirm, `data-agent-blocked`; disabled while jobs/recording/streaming with explanatory title; takes a "Before rollback" copy; remounts the room) ; Delete (`CheckpointsSection.tsx:113-170`).

**Online features**
- [ ] Provider select Off / DuckDuckGo (rate-limit hint) / SearXNG (+ instance URL input); Test search runs a REAL search and shows the result; Save → "Saved ✓"; Off removes web tools from the model (`OnlineSection.tsx:41-85`).

**AI advisors**
- [ ] Hidden behind cloud-CLI detection ("No cloud AI CLIs… detected" otherwise); "Enable AI advisors" (immediate) → local model may delegate one hard subtask per question; sub-checkbox "Let a Claude advisor use this room's tools" (`AdvisorsSection.tsx:39-76`).

**Connections (MCP)**
- [ ] Guided add (Name/Command/Arguments → "Add to config" merges JSON); "Advanced: edit the raw JSON" collapsible; "Save & Connect" spawns and reports; per-server live status rows (connected "N tools: …" / connecting / disabled / failed); error line (`McpSection.tsx:50-112`).
- [ ] SEC-1 dialog on opening a room with authored MCP config: "This room wants to start programs" listing name+command — Keep off / Allow ("Starting…") (`SettingsModals.tsx:55-96`).

**Remote AI**
- [ ] Remote Ollama URL (blank = this Mac) + Save; model calls route over LAN, files stay local (`RemoteAiSection.tsx:26-42`).

**Room server (the Leash)**
- [ ] On/off toggle serves the unlocked room as an MCP server (`RoomServerSection.tsx:41-58`).
- [ ] Access level: Files only vs Full agent (restart severs old connections); full-tier warning; read-only Address + client-config JSON (focus selects all); "Copy config" → "Copied ✓" (`RoomServerSection.tsx:59-132`).
- [ ] "Regenerate token" (full tier): new bearer token, rewrites `~/.private-room/leash.json`, revokes pasted configs (`RoomServerSection.tsx:133-141`).
- [ ] Port-17872-taken temporary-port warning; files-tier "dies when you lock" note; files-tier "Allow cloud AI clients" toggle with warning (`RoomServerSection.tsx:143-199`).

**Room role**
- [ ] Radio list persists immediately; **known caveat: write-only — no observable effect on answers** (test that selection persists, not behavior) (`RoleSection.tsx:18-55`).

**AI helpers**
- [ ] Vision helper: "Installed ✓" or Download button; Semantic search: "On ✓" or "Turn on semantic search" (pull + backfill index); shared progress bar; whole section replaced by "Ollama is not running…" when down (`HelpersSection.tsx:36-101`).

**Recovery key**
- [ ] "Create a recovery key" → one-time sheet (Copy / Print / Done); invalidates nothing until created; unlock screen gains the recovery path (`RecoverySection.tsx:29-77`).

## 28. In-room agent capabilities (chat-invocable tools)

Test each by asking the agent in plain language and observing the stated outcome. Tool groups are offered per turn by keyword routing; pure questions get a short catalog (`agent.rs:1043-1083,1165-1281`).

**Read / navigate (ungated)**
- [ ] "What files are here?" → `list_room_files`: bulleted list (name, type, size, one-liner), capped 100.
- [ ] "Find where it says X" → `search_room`: up to 4 verbatim `[file]` excerpts.
- [ ] "Open lease.pdf at the pet clause" → `open_file`: viewer opens and jumps to page/cell/quote (verified; closest-snippet fallback marked approximate).
- [ ] "What do you remember?" → `list_memories` with `[category]` tags.

**Annotate (ungated, persisted as message effects)**
- [ ] "Highlight the termination clause" → `annotate_file`: viewer highlight + verified citation chip in chat.
- [ ] "Draw a box around the total" on an image → `mark_image`: labeled boxes (needs a local vision model).

**Write (gated by Settings → Behavior edit-approval)**
- [ ] "Make a note called X" → `create_file` (HTML-first; "create a scratch pad" redirects to the existing pad).
- [ ] "Change X to Y in file Z" → `edit_file` (unique-match required; curly-quote/NBSP/CRLF-tolerant; fuzzy fallback logged).
- [ ] "Rename X and update every reference" → `edit_files`: atomic all-or-none multi-file batch, one-group Undo.
- [ ] "Rewrite the whole file" → `write_file`; "Set B7 to 120" → `set_cells` (A1-validated, xlsx/csv).
- [ ] "Rename/move that file" → `rename_file` / `move_file` (folder created if missing).
- [ ] "Remember that I prefer …" → `add_memory` (deduped, capped, categorized).
- [ ] With approval "Every edit": each write shows the diff card; "Once per answer" shows one card with "Apply for the rest of this answer"; 180 s timeout = declined; file changed under a pending card → refused as stale (`edit_gate.rs`).

**Web (only when a search provider is on)**
- [ ] "What's the latest news on X?" → `web_search` with "Searching the web… (leaves this Mac)" step chip; provider off → tool absent/blocked message.
- [ ] "Read that page" → `fetch_page` windowed text with continue offsets.

**Jobs & workflows (via chat)**
- [ ] "Translate the whole book, don't miss anything" → `start_file_pass`: durable background pass with live job card (this is the ONLY way to start a file pass — no button exists).
- [ ] "Is it done yet?" → `job_status` plain-language progress.
- [ ] "Automate a weekly synthesis" → `save_workflow`/`update_workflow` produce DRAFTS that require human activation; "run the tidy workflow" → `run_workflow`; `list_workflows` on request.

**Third-party MCP tools**
- [ ] A question needing a connected server's tool → per-call consent card (server, tool, args) with Allow once / Always (per-server, per-session) / Don't allow; decline returns a polite no-data-left message; 180 s timeout declines.

**Deliberate negatives**
- [ ] `consult_advisor` is not reachable: asking to "consult a cloud advisor" must NOT fire a tool (Settings toggle persists but has no behavioral effect — expected).
- [ ] `local_generate` is never available in-room chat (Leash full-tier only).

## 29. Agent embodiment (UI-driving)

- [ ] "Click the Flashcards button" (or similar) → numbered Set-of-Marks badges flash over the UI (≤ 80 marks, self-clear ~2.5 s), then the action executes with a visible ghost ring and an ask-step receipt (`driver.ts:96-318`).
- [ ] Actions available: click, type (append into inputs), set (replace value / pick a `<select>` option), scroll; stale marks answer "take a fresh ui_snapshot" (`driver.ts:318-432`).
- [ ] Consent fence: anything under `data-agent-blocked` (Settings backdrop, approval cards, armed delete confirms, Lock, "real details" valve) is invisible to snapshots AND refused at act time — ask the agent to open Settings or approve its own edit; it must fail (`driver.ts:112,333`).
- [ ] "What do you see on screen?" → `view_screenshot` native window capture (DOM fallback), described locally — no pixels leave the Mac (`agent.rs:1841,2419`).
- [ ] "Look at the video at 12:34" → `view_media_frame` grabs the presented frame via `roommedia://` (`driver.ts:559-637`).

## 30. Leash (external agents), gatekeeper seams, global behaviors, QA harness

**Leash — test from an external MCP client (claude-cli / codex-cli / Claude Desktop)**
- [ ] Files tier: fresh token + ephemeral port per start, paste-only config, no discovery file; serves file tools (+ web if on, + MCP if allow-cloud) — assert `ui_act`, `start_file_pass`, `local_generate` are ABSENT from `tools/list`.
- [ ] Full tier: stable port 17872 + persisted token; writes `~/.private-room/leash.json` (mode 0600, `{url, token, scope, room, pid…}`); removed on stop/lock/app-exit; stale-pid self-heals (`discovery.rs`, `lib.rs:290`).
- [ ] Full tier serves file + job + workflow tools + `local_generate` + `view_media_frame`; NEVER `ui_snapshot`/`ui_act`/`view_screenshot`/`consult_advisor` (`room_mcp.rs:22-30`).
- [ ] Wrong/missing bearer → 401 (constant-time compare); GET → 405; unadvertised tool name → "unknown tool"; loopback-only bind.
- [ ] Tier change / Regenerate token restarts the bridge and severs live connections; `change_password` deliberately does NOT rotate the leash token.
- [ ] `local_generate` over full tier refuses `:cloud`/external model picks (`agent.rs:1155`).

**Cloud-privacy gatekeeper — enforcement seams (all mechanical)**
- [ ] Local-model turns: NO redaction anywhere (door only guards non-local models) (`privacy.py:40,266`).
- [ ] Cloud chat turn: configured entities leave as `[Person A]`-style tags, images stripped, answer restored; `ask-privacy` receipt matches the count (`agent.rs:805-864`).
- [ ] Cloud CLI engines (`claude-cli`/`codex-cli`): same redact-out/restore-in + image block in `run_external` (`external.rs:192-403`).
- [ ] Sidecar features (summarize, file pass, AI actions, structured calls) redact on the same door (`llm.py:100-193`, `summarize.py:436`).
- [ ] MCP bridge (cloud tiers): placeholders restored inbound so tools see real values; every tool RESULT redacted outbound; images dropped (`room_mcp.rs:549-665`).
- [ ] "This once" bypass: receipt flips to "Real details were shared this once" (`agent.rs:797`).
- [ ] Cross-verify with a file's Cloud view + Settings entity map: the same entities are blacked out.

**Global behaviors (beyond §1)**
- [ ] Quit teardown: unloads the Whisper Metal context (Quit must not crash), stops an Ollama daemon *we* started (never a user-started one), stops the sidecar, sweeps decrypted previews, removes leash.json (`lib.rs:274-291`).
- [ ] Orphan protection (0.4.1): kill -9 the app → sidecar exits within seconds (watches its parent).
- [ ] Scanner yields to chat (0.4.1): during a privacy scan, sending a chat message pauses scanning between files ("Paused while you chat") and it resumes after.
- [ ] Live privacy guard hard-capped at 8 s and skipped during scans — chat can never stall behind it (0.4.1).
- [ ] Sidecar `/health` reports the real app version (0.4.1).
- [ ] `roommedia://` streams room audio/video with range support; `roomdoc://` serves sandboxed HTML with a no-network CSP.
- [ ] Idle auto-lock: set 1 min → idle room seals to the gate; playing speech, live recording, or an in-flight ask counts as activity; sleep-gap > 45 s detected (`effects.ts:452-510`).
- [ ] KNOWN GAP: no single-instance guard — a second launch opens a second instance; record behavior, don't fail the run on it.
- [ ] Startup sweeps: leftover browser previews and script workspaces cleaned (`lib.rs:26,269`).

**QA harness — how the UA agent drives the app**
- [ ] Browser harness (UI-only, no Rust): `npm run build && node qa/make-qa.mjs && npx vite preview` → open `dist/qa.html`. `qa-mock.js` stubs Tauri IPC with fixtures (8 files, chats, workflows, scripts, jobs, privacy entities). Hooks: `#gate` hash → onboarding screens; `window.__qaEmit(event, payload)` fires backend events; counters `__qaAsks`/`__qaAskLog`/`__qaSpeaks`/`__qaTranscribes`/`__qaMicGrants`; synthetic oscillator mic lets dictation run headless.
- [ ] Real-backend e2e (`npm run e2e`): WDIO + tauri-driver + mock Ollama — Linux/Windows only (no WebDriver on macOS WKWebView).
- [ ] On macOS, full-fidelity UA = the real app (build, `scripts/macsign.sh`, real Ollama) driven manually or via the computer-use QA loop; the browser harness covers UI structure/flows.

---

## Meta: coverage rules for the UA agent

1. **Every checkbox is one verdict**: pass / fail (with repro + observed vs expected) / blocked-precondition (say which). Never silently skip.
2. **Test degraded states deliberately**: Ollama stopped, STT model absent, offline (neural voice must fall back, web tools absent), no vision model, empty room, 0-byte and huge files, Hebrew/RTL content.
3. **Agent-blocked surfaces must be tested from both sides**: the human can click them; the embodied agent must not be able to.
4. **Privacy claims are load-bearing**: any private entity reaching a cloud seam unredacted is a release-blocking failure, not a cosmetic bug.
5. **Report anything present in the app but missing from this list** — the list is meant to be complete; a discovered omission is itself a finding.
