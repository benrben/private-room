# Arcelle — Complete Application Feature Inventory

Compiled 2026-08-19 by reading the full source tree (frontend `src/`, backend `src-tauri/src/`, Python sidecar `sidecar/arcelle_sidecar/`) plus `README.md`, `qa/UA-FEATURE-CHECKLIST.md`, and `CHANGELOG.md` (v0.1.0 → v0.24.1). Eight parallel research passes fed this document: viewers/file formats, settings, shell/navigation/core UI, private browser, Create/Sketch/Workflows/Scripts/Skills, backend Tauri commands & native macOS integration, the Python/LangGraph sidecar (agents/tools/engines/domains), and a cross-check against the app's own QA checklist and README.

This is a reference document, not a design doc — no changes are proposed here.

---

## Table of contents

1. [What this app is (self-positioning)](#1-what-this-app-is)
2. [Navigation & shell](#2-navigation--shell)
3. [Pages, panels & modals](#3-pages-panels--modals)
4. [File viewers & supported formats](#4-file-viewers--supported-formats)
5. [Settings — every section, every option](#5-settings)
6. [Private browser — deep dive](#6-private-browser)
7. [Create / Sketch / Workflows / Scripts / Skills — deep dive](#7-create--sketch--workflows--scripts--skills)
8. [Backend (Rust/Tauri) — commands & native macOS capabilities](#8-backend-rusttauri)
9. [Python/LangGraph sidecar — the AI engine](#9-python-sidecar)
10. [Native menu bar & keyboard shortcuts](#10-native-menu--shortcuts)
11. [The app's own feature taxonomy (QA checklist, 43 sections)](#11-qa-checklist-taxonomy)
12. [Notable small/easy-to-miss features (from changelog)](#12-changelog-highlights)
13. [Explicitly NOT built yet (roadmap "Next")](#13-not-built-yet)

---

## 1. What this app is

**Arcelle** (formerly "Private Room") is a private AI workspace sealed inside a single encrypted file (`.arcelle`/`.roomai`, SQLCipher-encrypted SQLite). Bundle id `com.benreich.privateroom` (kept for signing/Keychain continuity). macOS-only, minimum system version 12.0.

Self-declared differentiators (README):
1. **Citation verification** — a claim is pinned to an exact sentence and verified before display (closest match or nothing, never invented).
2. **AirDrop-the-whole-workspace** — the room is one ordinary file.
3. **One encrypted file, no cloud, no backdoor**, printable one-time recovery key.
4. **Cloud redaction gatekeeper** — mechanical, at every exit point, with a per-file "Cloud view" preview.
5. **"It works while you don't"** — Workflows, Scripts, Studios run as cancellable background jobs.
6. **On-device meeting recording** (mic + system audio) with automatic speaker ID.
7. **Private browser** (no history/cookies/cache/logins) the AI can drive, with ad/tracker blocking before requests leave the Mac.
8. **Engineered for a 4B model** — constrained JSON-schema decoding (with cloud fence-recovery), deterministic keyword-based tool routing, RAM-aware context sizing, KV-cache-stable system prompts.

Also bundled: a standalone `roomai` CLI (`Contents/MacOS/roomai`) that can verify/inspect/export/recover a room file independent of the app — "a room file is never hostage to the app that wrote it."

Room templates: Blank, Legal, Medical, Research, Journal, Demo — each pre-tuned with instructions + starter memories + a welcome note.

Four things intentionally always stay on-device regardless of chosen engine: dictation, quick local generation, image grounding boxes, UI-driving tools.

---

## 2. Navigation & shell

### 2.1 Two-level navigation model

Design: an **Activity Rail** (level 1 — "which part of Arcelle am I in?") plus a **contextual sidebar** (level 2 — "what can I open/manage here?"). The Library is not its own destination — it's Home's contextual sidebar.

**Top-level destinations** (`NAV_AREAS` / `SIDEBAR_TITLES`):

| Destination | Purpose | Second-column contents |
|---|---|---|
| **Home** | Recent work / files | Library — tabs: Browse (folder tree, file rows), AI sources (attach/detach evidence), Trash. Center = Front Page briefing when nothing open. |
| **Recordings** | Mic + system-audio meeting capture | New live recording, Voice note, filterable list of all recordings |
| **Private browser** | No-history web browsing | Vertical tab list of open pages (drag-reorder) |
| **Sketch** | Hand/AI drawing | List of sketches, New sketch |
| **Create** | Image/video generation | Filter (All/Images/Video), "Making now", "Didn't finish", "Made in this room" |
| **Room Map** | File/note relationship graph | Counts, "Search this room", "Summarize the room" |
| **Workflows** | Scheduled pipelines | New workflow, list (active/draft, pinned, file/general scope) |
| **Scripts** | Runnable `.py`/`.js` room files | List with approval state, language badge |
| **Skills** | Reusable AI instructions | List (enabled/disabled, resource count) |
| **Connectors** | MCP third-party tools | Installed connectors with status + tool count |
| **Memory** | Durable, editable AI context | Scratch pad, category breakdown |

Rail: pinned tier (default Home, Recordings, Private browser, Sketch) + collapsible "More tools" (everything else) + Customize Sidebar + Settings. Toggles icon-only ↔ icon+label; auto-collapses under 1180px window width. ⌘K palette always lists every destination regardless of pin state.

**Customize Sidebar**: pin/unpin, reorder within group (up/down arrows), reset to defaults — available both as a rail sheet and inline in Settings → Interface.

### 2.2 Shell chrome

- **StatusBar** — encrypted-room seal, trust/route chip (local / protected-cloud / raw-cloud + online-search/connector reach), file count, offline indicator, pending-approvals count, running/queued job count.
- **TabStrip** — Home's own open-document tabs (not areas, not browser pages); horizontal scroll w/ edge arrows, drag-reorder, model-generated short titles, middle-click/×-close, ⌥⌘1–9 jump-to-tab.
- **ErrorBoundary** — per-pane and root-level crash recovery ("Try again"/"Reload Arcelle") — one broken viewer no longer blanks the whole app.
- **Splitter** — draggable/keyboard-resizable divider between Library/Workspace/Assistant panes.

### 2.3 TopBar & Layout menu

**TopBar**: brand seal, inline-rename room name, ⌘K search entry, pinned workflow/script quick-run pills, live-recording indicator, engine/model pill, privacy/trust badge, Layout menu, Assistant toggle (approval/running badges), room actions menu (Theme, Save checkpoint, Export all files, Reveal in Finder, Keyboard shortcuts, Send feedback), Lock button (⌘L).

**LayoutMenu**: pane checkboxes (Sidebar ⌘1, Assistant ⌘2, Focus the workspace), three presets (Focus / Research / Review), Reset layout.

### 2.4 Quick Actions

`QuickActionsMenu` — generic shortcut container (inline pills + overflow popover), used for: TopBar pinned Workflows, TopBar global-shortcut Scripts, ViewerPane file-header Scripts (bound by declared input/output file match), ViewerPane file-header Actions (file-scoped workflows via `bindingMatches` on file_id/kinds/extension, plus sketch export actions Save as PNG/SVG).

All toolbar popovers (model picker, Layout menu, room-actions menu, pinned menus) share one open-menu slot — opening one closes the rest; Escape always closes the topmost.

---

## 3. Pages, panels & modals

### 3.0 Room lifecycle screens (`src/screens/`, `src/rooms/`)

These run before a room is open, outside the main three-pane shell:

- **StartScreen** — "Create New Room" / "Open Room…" / "Create a demo room"; assurances list (Offline except a launch update check / No account needed / One file, fully encrypted); Recent-rooms list with per-room "Encrypted" tape and a deliberately narrow **place badge** (only "iCloud Drive" or "External volume" — shown only when the path itself proves it, never a guessed "On this Mac" default, and never a third-party sync-folder guess); missing-file rows route to the file picker instead of a password form; per-room Remove + Clear-all.
- **CreateScreen** — new-room form: name, one of 6 templates (Blank/Legal/Medical/Research/Journal/Demo), optional role picker, password field with live strength meter + criteria checklist, repeat-password confirmation.
- **UnlockScreen** — password field (autofocus, inline error), Touch ID button (only shown if enrolled for this room), "Forgot password? Use a recovery code" (only shown if the room has a recovery sidecar) switching to a dedicated recovery-code form (mono-face input, forced uppercase, `XXXX-XXXX-…` grouping) with an explanatory note that only the newest issued code works and using one doesn't consume or change it.
- **RecoveryModal** — the one-time post-create reveal of the room's recovery code: Copy code / Print-or-Save-as-PDF / "I saved it". **"Skip for now" is gated**: skipping without a confirmed copy first raises an explicit warning ("this code is shown once and never again... continue without saving it?") rather than silently discarding the only recovery path; a failed clipboard write is caught and shown, never silently claimed as "Copied."
- **SealOverlay** — the lock/unlock transition animation (~520ms unlock / ~460ms lock), skipped entirely under Reduce Motion.
- **RecoveryKeyIcon** — shared glyph used across Unlock/Recovery/Settings recovery affordances.

### 3.1 Core workspace surfaces

- **Sidebar (LibraryPane)** — implements the contextual second column for every destination; multi-file **SelectionBar** (⌘/Shift-click, batch move/attach/export/trash, 200-file cap); folder tree drag/drop.
- **ChatPane** — chat header (rename, new ⌘N, copy conversation, auto-speak, hands-free, delete), onboarding/model-download banners, transcript with per-turn agent graph, citations/sources, "made N file changes," Play/Copy/Undo/Regenerate/Save-to-room, privacy receipt (entities hidden/bypassed), "worth remembering?" memory-suggestion card.
- **ComposerPane** — import-tidy suggestion chips, cloud/local + internet-reach strips, attach-nudge, attachment chips, TokenBudgetBar, `#`/`@`/`*` autocomplete popover (`*` = specialist-tagging — dispatches directly to a named sub-agent, bypassing the Main hub), `#help` command sheet, tool row (Attach/Action/Skill/Specialist), mic dictation, Send/Stop.
- **FrontPage** (Home's center briefing) — RoomBrief ("needs your attention": raw-cloud exposure, unscanned files, scripts needing review, failed runs, draft workflows), RoomStamp (date/counts/busy state), unified timeline (files+chats+jobs, newest first), area chips, collapsible suggested-questions tray.
- **ViewerPane** — header/breadcrumb, LibraryChip (promote to/from Library), file toolbar (Edit/Run/Minutes/quick-actions/Actions/Export/overflow: cloud-payload preview, Duplicate, Copy all text, Dictate, History/Compare/Restore/Keep/Delete-version, encoding picker), reading-progress stroke, stale-file banner (AI changed file while editing). Routes to every page type below.
- **ViewerRouter** — dispatches a file to the correct viewer/editor with chunk-load error boundary + Suspense fallback.

### 3.2 Distinct pages

- **RecordingsPage** — "Happening now" live panel, shelf tally, "Most recent" card, "Waiting on a transcript" list (worst-reason-first), capped at 5 with overflow note.
- **MemoryView** — add memory (category + mic dictation), filter/sort, grouped list (Instructions/Preferences/Projects/Facts/Other), inline edit/delete, "Save as a note" export, Scratch pad section.
- **AgentGraph** — hub-and-spoke live/replay diagram of delegated specialists per turn: mini-chip roster + inspector (instruction, elapsed time, report/failure, tool steps), "Expand" → full modal canvas w/ SVG edges. Falls back to a flat strip for non-delegating turns.
- **PodcastPanel** — per-host name/voice/speed/pitch, Preview (cloud TTS), Suggest voices, Save cast, Record the episode (background job), privacy/offline warnings before recording.
- **StudioShelf** — "make something" shelf: Flashcards / Mind map / Podcast script cards + room-level AI-actions grid.
- **ConnectorsView** — full MCP connector management page (see §5 Connectors/MCP for detail). Entire page is `data-agent-blocked`.
- **SearchExpanded** (⌘K expanded) — source/type/date/match filters, sort, highlighted results across Files/Conversations/Memories, save/recent searches, "Ask the room instead."
- **TrashPanel** — Home's third Library tab: attributed deletions (by you / by the AI / by Arcelle), restore or permanent delete (per-file or bulk), armed Empty-trash confirm.
- **FileRow** — attach toggle, ••• menu, drag source, partially-indexed/transcribing badges, context menu (Open/Attach/Rename/Move/Export/AI-actions-this-file/Remove-to-trash).

### 3.3 Modals & dialogs

- **CompareModal** — side-by-side or plain-dual-pane version diff (Monaco), armed agent-blocked Restore.
- **DeleteControl** — reusable armed trash/× confirm control used everywhere destructive.
- **EngineModelPicker** — Local/Cloud tabs; local Ollama list; cloud tab lists connected engines/providers with capability filters (Tools/Vision/Reasoning/JSON) and reasoning-effort chips.
- **FeedbackModal** — free-text bug report, optional local-AI drafting into title+body, version-info + recent-error-log inclusion checkboxes (**off by default**), Copy or "Open GitHub issue" (opens the user's own browser; app sends nothing itself).
- **UnsavedEditsDialog** — "Save your changes?" gate on any exit that would drop an editor buffer (12 distinct exit paths including double-confirm ⌘Q).
- **SettingsModals** — wraps the Settings modal, the SEC-1 MCP "wants to start programs" approval dialog, and the Add-link modal (web page vs. video, YouTube-aware, yt-dlp progress).
- **AiActionModal** — editable-prompt modal for a predefined AI action (e.g. translate), @-mention context, cloud-route warning, running/Stop state.
- **TokenBudgetBar** — segmented context-usage meter (System prompt/History/Tool results/Skill content/File reads), shown at ≥70% usage, click-to-expand breakdown, always-available **Hand off** (summarize & continue with smaller context).

---

## 4. File viewers & supported formats

Two systems decide what opens a file: `src-tauri/src/formats.rs` (extension → `kind`, editability, byte delivery) and `src/viewers/registry.tsx` (`kind` → React component + `EditMode`: `grid | editor | copy | docx | null`).

### 4.1 Extension → kind → viewer table

| Extensions | kind | Viewer | Editable |
|---|---|---|---|
| `.pdf` | pdf | PdfView | text-copy only |
| `.docx` | docx | DocxView | in-place (real rewrite) or copy |
| `.xlsx`, `.xls`, `.ods` | sheet | SheetView | `.xlsx` only (cell grid) |
| `.pptx`, `.ppt` | slides | SlidesView | text-copy only |
| `.doc`, `.rtf` | worddoc | OfficeDocView | text-copy only |
| `.epub` | book | BookView | text-copy only |
| `.zip` | archive | ArchiveView | no |
| `.csv`, `.tsv` | csv | SheetView | yes if decode is lossless |
| `.md`, `.markdown` | markdown | MarkdownView / MarkdownEditor | yes |
| `.html`, `.htm` | html | HtmlView | yes (raw source) |
| `.svg` | svg | SvgView | yes (raw markup) |
| `.sketch` | sketch | SketchView | no button — continuous autosave |
| `.ipynb` | notebook | NotebookView | yes (raw JSON) |
| `.json`, `.jsonl`, `.ndjson` | json | JsonView | yes |
| `.srt`, `.vtt` | subtitle | SubtitleView | yes — cue-list editor |
| `.eml` | email | EmailView | no |
| `.txt` | prose | ProseView | yes |
| `.log` | log | LogView | yes |
| any other text extension | code | CodeEditor (Monaco) | yes |
| image MIME | image | ImageView | no (Mark/OCR panel only) |
| audio/video MIME | audio / video | AudioView | no (trim/frame produce new files) |
| app's own live recordings | recording | RecordingView | transcript-level editing |
| everything else | binary | QuickLookView | no (Quick Look picture only) |

### 4.2 Per-viewer capabilities

- **ArchiveView** (`.zip`) — lists central directory as collapsible tree with sizes; nothing inflated to disk.
- **AudioView** (audio/video) — streams via `roommedia://`; clickable timestamped transcript synced to playback; speaker-labeled waveform; on-device re-transcription; video-only real container facts (AVFoundation, no ffmpeg), trim (produces a new lossless-trimmed file), Save frame (full-res PNG export).
- **BookView** (`.epub`) — paginated chapter reader, TOC, font-size steps, light/dark theming; renders in a sandboxed `roomdoc://` iframe (`default-src 'none'`); Page vs Text mode.
- **ChatAnnotatedImage** — draws AI-referenced pictures with labeled bounding boxes inline in chat (distinct from the file-registry ImageView).
- **CloudView** ("PRIV-1") — shows exactly what a cloud model would receive: redacted placeholders or, with the privacy door off, raw text with exposed entities highlighted; reports real outbound UTF-8 byte size.
- **CodeEditor** — Monaco; read-only preview still syntax-colors; dirty-state vs last-saved; ⌘S; Find-widget seeding; RTL/theme handling; exposes `EditorFormatApi` used by MarkdownEditor.
- **DiffPreview** / **DiffView** — read-only Monaco diff (agent change-approval card / version-compare modal); RTL-majority documents get a plain `dir="auto"` fallback (Monaco is LTR-only).
- **DocxView** (`.docx`) — `docx-preview` renders real page breaks/headers/footers/footnotes/comments/numbering; in-place rewrite when full text is present.
- **EmailView** (`.eml`) — custom MIME parser: multipart walking, quoted-printable/base64 decoding, RFC 2047 headers, HTML-only-body stripping; `dir="auto"`.
- **HtmlView** — Page (live sandboxed iframe, page's own JS runs, network blocked) / Text / Source modes; "Open in browser" escape hatch.
- **ImageView** — zoom/pan; **Mark** (vision-model bounding boxes with inline local-model download offer); collapsible stored-OCR-text panel.
- **JsonView** — collapsible tree (auto-expand depth 2, 200-item pagination) + Raw toggle; JSONL parsed one record/line; parse-error fallback.
- **LogView** — severity classification/filter (ERROR/WARN/INFO/DEBUG groups + counts), free-text filter, tail-first pagination (newest 2000 lines).
- **MarkdownEditor** — Split/Source/Preview toggle, Focus mode, formatting toolbar (bold/italic/H1-3/lists/quote/code/link/table).
- **MarkdownView** — GFM tables/task-lists, lazy KaTeX math + syntax-highlighted fences (second chunk), live Mermaid diagrams, citation quote-highlighting, links open system browser.
- **Mermaid** — on-device SVG diagram rendering (`securityLevel: strict`), shows raw source + parser error on failure.
- **NotebookView** (`.ipynb`) — JupyterLab-style rendering: markdown/code cells, image/SVG/text/error outputs, explicit "[HTML output — not rendered]" placeholder for safety.
- **OfficeDocView** (`.doc`/`.rtf`) — macOS `textutil` import → real formatted HTML; fixed light "paper" palette (never dark-inverted); Page/Text toggle; QuickLook fallback.
- **PageSource** — provenance strip above a saved web page (Site/Author/Published/Updated/Source URL/Saved) — no live fetch, absent fields omitted.
- **PdfView** — `pdf.js` virtualized renderer (max 28 live pages), selectable text layer, per-page Copy text, zoom 50–300%, page-jump, in-doc Find (⌘F), citation quote-highlighting with "✓ Verified" badge, Hebrew-aware matching, distinct password/damage recovery panels.
- **ProseView** (`.txt`) — measured-column prose rendering (not code-editor style), reading-progress bar, citation highlighting, `dir="auto"`.
- **QuickLookView** — last-resort macOS Quick Look PNG preview; no selection/search/edit; always offers export-the-original.
- **RecordingView** — the most feature-dense viewer: live capture (mic+system audio) with real-time transcript, on-device Whisper, per-speaker diarization with renameable/voice-recognized chips, per-speaker waveform lanes; transcript editing (word delete/correct, non-destructive until export splices the WAV); Notes/Highlights/Chapters tabs (AI- or user-authored); whole-file translation + live-translate; export as text or `.srt`; "Mark this moment" live capture.
- **SheetView** (`.xlsx`/`.xls`/`.ods`/`.csv`/`.tsv`) — SheetJS virtualized grid (90k+ rows, 512-column cap), true A1 coordinates, cell styling/merges, formula bar, click-to-edit with session Undo (⌘Z), AI-target range highlighting; `.xls`/`.ods` explicitly read-only.
- **SketchView** (`.sketch`) — full vector drawing editor (SVG, no `<canvas>`); autosaves continuously (~1.4s debounce, retry/backoff); shared human+agent document (agent shapes merge live, staged reveal animation, held off mid-gesture); reports live selection to chat.
- **SlidesView** (`.pptx`/`.ppt`) — slides drawn by macOS Quick Look at full fidelity (deck reordered per-slide); separate OOXML parse for title rail, speaker notes, slide-number-accurate citation targeting; next-slide prefetch.
- **SubtitleView** (`.srt`/`.vtt`) — cue-list editor preserving WebVTT header/NOTE/STYLE/REGION blocks and per-cue settings; re-serializes to original dialect.
- **SvgView** — renders as `<img data:...>` (never inline-injected, to block embedded `<script>`); Picture/Source toggle; dark-backdrop toggle.
- **TextEncoding** (shared hook, not a standalone viewer) — applies to csv/markdown/html/svg/notebook/json/subtitle/email/prose/log/code kinds; states whether encoding is BOM-detected, guessed, or user-picked; save always converts to UTF-8 with an explicit warning.
- **Waveform** (shared by AudioView/RecordingView) — precomputed peak envelope via `wavesurfer.js`, adaptive time axis, per-speaker ribbon/lanes, saved-mark bands, chapter markers, theme-aware repaint.
- **Room Map** (`RoomMap.tsx` + `src/viewers/roomMap/`) — *not* a file viewer; the agent/memory-graph "constellation view." Hand-rolled Fruchterman–Reingold force layout (no d3-force) over `room_graph()` similarity; pan/zoom, hover "why linked" tooltips, click-to-open, sticky labels, density/legend filter, and a fully accessible **List view** mirroring the same graph as text.

### 4.3 Supported text encodings (`ENCODING_CHOICES`, via `encoding_rs`)

UTF-8, UTF-16LE, UTF-16BE, Windows-1252/ISO-8859-15 (Western European), Mac Roman, Windows-1250/ISO-8859-2 (Central European), Windows-1254 (Turkish), Windows-1251/KOI8-R/ISO-8859-5 (Cyrillic), Windows-1253 (Greek), Windows-1255 (Hebrew), Windows-1256 (Arabic), Windows-1257 (Baltic), Windows-1258 (Vietnamese), Shift_JIS/EUC-JP (Japanese), GBK/GB18030 (Simplified Chinese), Big5 (Traditional Chinese), EUC-KR (Korean).

### 4.4 Supported syntax-highlight languages (`LANGUAGE_BY_EXT`)

TypeScript/JS, Python, Rust, JSON, Markdown, HTML (incl. Vue/Svelte), CSS/SCSS/Less, YAML, INI/TOML/conf, SQL, Shell, Java, C/C++, C#, Go, Ruby, PHP, Swift, Kotlin, XML/SVG, R, Lua, Scala, Perl, reStructuredText (also used for `.tex`), Dockerfile, GraphQL, Proto. Unlisted extensions fall back to plain text.

---

## 5. Settings

Settings is a modal with ~20 sections; two of them (McpMarketplace + its hook) actually render on the separate **Connectors** top-level page, not inside the modal. Sections marked "device-wide" apply to every room on the Mac; unmarked sections are per-room (stored encrypted inside the room).

- **About** — brand lockup; "Check for updates automatically on launch" toggle (`data-agent-blocked`); manual Check-for-updates/Download & install button with progress; version display; "Reveal logs" (states no room content is ever logged).
- **Advisors** — "Enable AI advisors" (hands a hard subtask to a detected local Claude Code/Codex CLI), off by default; "Let a Claude advisor use this room's tools" sub-toggle (files/search/open/edit + connectors via a local bridge); capped at one consult per question, always shown as a visible step.
- **AI providers** — OpenRouter API key field + Connect (validates, stores in Keychain, never in the room file) / Disconnect (confirm, deletes Keychain entry, falls back to default model if active).
- **Appearance** (device-wide) — Theme: Follow the Mac / Light / Dark, applies instantly.
- **Behavior** (per-room) — Creativity/temperature slider (0–1), Custom instructions textarea, Response style (Default/Terse/Friendly/Formal), "Describe new files automatically" toggle (auto-index), "Save suggested memories automatically" toggle, "Let the local AI write small pieces of the interface" toggle (adaptive text — subtitles/tab titles), "Ask before the AI edits files" (Off / Once per answer / Every edit).
- **Checkpoints** — Create checkpoint (name + button); list with Roll back (two-step confirm, `data-agent-blocked`, auto-snapshots "Before rollback" first) and Delete (permanent, not to Trash) per row; total-usage summary; warning banner past 1GB.
- **Cloud privacy** ("PRIV-1") — room-level on/off (`data-agent-blocked`) with app-wide default override; "Never share these" block-list (text + category: Person/Address/Phone/Email/ID/Organization/Other); "Private topics" free-text (best-effort local-model concept matching); "Scan now" document scan with progress; static disclosures (remote connectors are a separate seam; images never sent while door is on).
- **Helpers** — Vision helper status/download (local grounding model); Semantic search status/download (embedding model); shared download progress with Stop.
- **Interface** (device-wide, instant apply) — embeds Customize Sidebar; Layout presets; Density (Comfortable/Compact); Canvas texture (Subtle/Off); "Reset to Arcelle defaults" (resets sidebar/density/texture/all rooms' saved layouts, never touches room content).
- **Microphone** — single "Clean up microphone audio (echo cancellation & noise suppression)" toggle, default on; recommends off for headphone users; never touches OS input gain.
- **Model** — Engine/model picker (local Ollama, `:cloud` Ollama, connected providers) with tool/vision capability badges and per-model Delete; "Download a model" field + progress; sizing-tip disclosure; Dictation & transcription sub-section (voice/STT model install, "Translate dictation to English" toggle, "Shape dictation as": Exact words / Cleaned up / Notes-bullets / Email body / Chat message / Commit message / Optimized AI prompt).
- **Online features** (per-room, Save-button) — master "Let this room reach the internet" toggle (off by default); "Search the web" sub-toggle (`web_search`/`fetch_page`); "Use the private browser" sub-toggle (agent can click/fill/sign-in); "Show previews on the results page" sub-toggle; "Save & test search" button (runs a real backend test).
- **Privacy** — "Lock automatically after" (Off/5/15/60 min); Change password (strength meter + criteria checklist, re-issues recovery key); Touch ID unlock toggle (Keychain, biometric-gated); Duplicate room (destination picker + optional new password); Compact room (two-step armed VACUUM, irreversible).
- **Recovery key** — "Make a new recovery key" (mints/replaces, invalidates prior code, shown once with Copy/Print/Done).
- **Remote AI** ("the Closet") — Remote Ollama URL field, Test connection, Save; warns this ends the room's local-only guarantee (cloud-privacy redaction still applies).
- **Room role** — radio list of personas (from `list_roles`) shaping conversational stance only, not files/privacy.
- **Room as a tool / MCP server** ("the Leash") — on/off; Access level radio (Files only vs Full agent); read-only Address + Copy-able config JSON for Claude Desktop/Cursor; Regenerate token (Full tier); "Allow cloud AI clients" toggle (Files-only tier, strong warning).
- **Saved voices** — list of learned per-room voiceprints (seconds/recordings/learned date/corrections) with Forget (two-step confirm); stated never sent to any model, encrypted with the room, never shared across rooms.
- **Support matrix** — read-only auto-generated Provider × capability table (Runs on/Live typing/Tools/Images/Strict output/Agents-count) plus a full provider × agent grid disclosure — never hand-maintained.
- **Spoken voice** — Voice select (live-fetched catalog), Archetype (Plain/Demon/Ghost/Wraith/Ancient/Custom), Reverb + Distortion sliders, Preview/Stop, Save; states only the currently-spoken sentence is sent to the cloud TTS service.

### Connectors / MCP marketplace (own top-level page, owned by settings code)

- Mac-wide defaults: "Run connector tools without asking", "Send remote connectors real values" (overrides Cloud-privacy placeholders for remote connectors specifically).
- Per installed connector: enable/disable, Remove (two-step, deletes stored token too), per-connector auto-approve override, per-connector outbound-unmask override, per-tool on/off list, live status.
- "Advanced: paste or edit the raw config" (raw `mcpServers` JSON, warns it shows every stored secret in clear text).
- **Marketplace**: opt-in gate for registry browsing (the app's one self-initiated outbound network call); search; filter chips (Verified/Local only/No API key); install drawer per connector (Run locally vs Use cloud transport toggle, masked secret fields per required env var/auth header, runtime-availability check with "Download `<runtime>` for me", explicit "Yes, connect now" confirmation, OAuth sign-in/sign-out + manual fallback link, source-repo link).

---

## 6. Private browser

Architecture: the "page" is a native **child `WKWebView`** floating above the app window — not a DOM node, so React can never draw over it. React measures a placeholder div and pushes bounds to Rust (`browserSetBounds`). To show anything else (results, start screen, journal, reader) the native view is "parked" at 1×1. A page script (`browser/page.js`) is injected at document start — a deliberate port of the app's own UI-driving agent script, giving the model one unified skill for driving Arcelle's UI and the web.

**Navigation** — `classify()` decides URL vs. search (shared by address bar and the agent's `browse_open`): `?query` forces search, explicit `scheme://` is literal, any whitespace → search, host-shaped/IP/host:port text → URL, everything else → search. Classifying ≠ permitting — every navigation still clears `browse_guard_url` (private-network refusal). Bounds tracked via ResizeObserver + resize + 60fps rAF while dragging + 1s settle interval.

**Tabs** — live only in React state, reconciled against Rust's `browser_tabs()`; agent can open background tabs without stealing focus; one Take-over/Hand-back toggle pauses agent browsing.

**Incognito/privacy** — storage ephemerality re-verified on every URL change (`browser_verify_private`), independently of tracker-block compile state; the privacy chip shows the weaker of the two (breached > degraded > checking > verified). Explicit "not anonymous" disclosure names the AI provider as a fourth party that can still see what's visited. Closing a page **parks** the webview (doesn't destroy the session, to avoid racing in-flight agent tool calls) — only room-close/app-quit tears it down. Password/OTP/card fields are DOM-fenced in `page.js` so the agent can never act on or see their values (presence is still reported).

**Tracker/ad blocking** — WebKit's own `WKContentRuleListStore` compiles rules (network-path blocking, no page-JS bypass possible). Two rule families: a curated ~100-domain tracker/ad list (third-party-scoped), and private-network-range blocking (localhost/.local/RFC1918/CGNAT/link-local/IPv6 variants) as defense-in-depth alongside the navigation-level SSRF guard. All patterns hand-restricted to WebKit's supported regex subset (one unsupported construct silently drops the *entire* compiled list). Failure surfaces as a Retry banner, not silent degradation.

**Journal** — durable, encrypted, in-room audit record of agent (and some user) actions; 12 `kind` values mapped to 6 user-facing facets (Agent/User/Saved/Consent/Errors/Protection); grouped by "sitting"; consecutive identical rows coalesce with `×N`; Clear erases both journal and the room's whole web cache. Ordinary reading by a human is deliberately never journalled — only agent actions and explicit saves.

**Downloads/saves** — `download_to_temp` streams any URL to a size-capped staged temp file (800MB hard cap, 64MB inline-vs-background-job threshold). Toolbar Save strip: **Save page**/**Save selection** (live-DOM capture → Readability-style extraction → `.md` + styled `.html` twin + structured metadata), **Save link** (reuses live capture if it's the on-screen page, else a fresh unauthenticated fetch), **Download video** (background job). Everything lands in room files, never the OS Downloads folder. YouTube links auto-import transcripts (scraped caption tracks, no video download).

**Search** — no scraper in Rust; a Python-sidecar fan-out across **seven engines** (DuckDuckGo, Brave, Mojeek, Marginalia, Wikipedia, DuckDuckGo Instant Answer, Google News), fused and ranked. One search path is shared by address bar, results page, and the agent's `web_search`/`browse_open` — all hit the same 15-minute cache. Results page: feature-card + two-up + compact-row layout, a 7-wedge "consensus dial" per result (which engines agreed), full keyboard nav (↑↓/j/k, Enter, ⌘/Ctrl+Enter, p=peek, a/+=add), Peek inline preview, opt-in enrich pass (favicon/og:image/description, proxied through Rust as data URLs — never a real browser fetch), on-demand AI Summary with mandatory `[n]` citations. Failed engines are named, not absorbed into "no results."

**Reading view** — replaces the live page (not a permanent split); `main` vs `full` extraction modes; same page-script `read` op the agent's `browse_read` uses (Markdown conversion, 40,000-char pagination); refuses extraction below 200px viewport (would silently answer with a reflowed fragment); staleness banner if extracted text no longer matches the live URL. Selection reading (`browser_page_selection`) exposes just the highlighted text, capped 40,000 chars, un-journalled.

**Agent tools** (7, advertised only while Browser is open): `browse_open`, `browse_read`, `browse_find`, `browse_snapshot` (numbered refs, passwords never listed), `browse_do` (batched click/type/select/scroll/key/back/wait_for), `browse_look` (screenshot with Set-of-Marks badges), `browse_save`. Refs capped at 80, staleness-checked before acting; `lowSignal` auto-escalation nudges the model to `browse_look` when the text channel looks unreliable; `settle()` makes "wait for page" deterministic.

**Chat-scope integration** — "answer from this page" / "selected passage" / whole room, only offered when the page is actually readable (not parked). Page text capped at 8,000 chars with an explicit omitted-count.

---

## 7. Create / Sketch / Workflows / Scripts / Skills

### 7.1 Create (image/video generation)

Three tabs: **Images**, **Video**, **Story** (each badge shows a live capable-model count). Single-shot "bench": model dropdown (scoped to media-capable models only), prompt, video-only starting/reference pictures (up to the model's own `maxReferences`), video-only clip length (model's own legal durations), frame shape/size (model's own published lists), variation count (1/2/4), a consent notice naming exactly how many pictures leave the Mac. Canvas shows failed jobs (verbatim provider error), running jobs, and everything made in the room.

**Story tab** — full mini-production pipeline: Cast strip (hand-added or AI-extracted from a room document via review-before-add; each member gets a **face picked from a room picture**, not typed); Shot list (action line, cast, per-shot picture/clip model, clip length); **Script Splitter** (deterministic, local-only Rust text-splitting of a pasted/imported script into shots, no model call); Shape row (one aspect ratio/resolution restricted to what both models support); two-pass **"Make all"** (Draw the frames → Film them, with an optional **continuous** toggle chaining each clip's captured end-frame into the next clip's opening frame); **FilmReview** mandatory pre-flight sheet (assembled prompt per shot, no-face warnings, total cost preview) before any paid generation runs.

Model catalog sourced **only** from OpenRouter's live `output_modalities` field — no hardcoded list, no name-matching; exclusions are surfaced with reasons, not hidden. Cast-from-file extraction and Story prompt assembly are model calls; the Script Splitter itself is not AI.

### 7.2 Sketch (drawing)

Full SVG vector editor (no `<canvas>` element) inside `.sketch` files. Tools: Select (V), Pen (P), Box (R), Ellipse (O), Arrow (A), Note (T), Eraser (E), sticky-mode via double-click. Five fixed ink colors (pink/yellow/green/blue/red) — no free picker. Multi-select, 8-handle resize, align/distribute/z-order/duplicate/lock, snap-to-grid + snap-to-shape, undo/redo (depth 80), trackpad pinch-zoom/pan (0.3–6×), object-strip footer, continuous autosave with retry/backoff. **Connectors** (arrows attached to two shapes auto-reroute when either moves). The room's drawing agent co-edits the same file live (staged reveal animation, merges around in-flight user strokes); publishes live selection to chat.

Powered by the **`creator.draw`** sub-agent (tools: `draw`, `read_drawing`) — issues a whole drawing as one DSL script call, deterministically reads the page first (before any model call), then re-reads its own work to self-check (overlaps, off-page shapes, unlabeled shapes, short arrows) and iterates until clean — a **draw → measure → correct** loop.

### 7.3 Workflows (scheduled pipelines)

Library: card grid + templates; **"Compose with AI"** turns a plain-language description into a validated draft JSON workflow. Visual pipeline editor (`PipelineCanvas`) — deterministic left-to-right layered layout, append/fan-out, per-node param sheet, branch/fan-in editor, live backend validation with humanized errors. Bind to General or Specific files (scoped to kinds/extensions or one exact file — appears in that file's Actions menu instead, cannot be scheduled). Test run / Run now / Activate / Deactivate / Pin / Delete. Run History with per-step artifacts, consecutive-failure collapsing.

**16 step kinds**: Generate text, Summarize a file, Full-file pass, For each file, Ask the agent, Extract fields, Route by content, Vote/consensus, Refine (critique loop), Plan & map, Transform text, Merge branches, Fetch a URL, Run a script, Save a file, Condition.

Scheduling (shared with Scripts): Off / Every N minutes / Daily (HH:MM) / Weekly (day+HH:MM), each with Enabled toggle and "Catch up at unlock" toggle; refused outright for file-scoped workflows.

### 7.4 Scripts

Any `.py`/`.js` room file is automatically a runnable script — no separate creation ceremony. Header-comment manifest: PEP-723 `dependencies`, `room-inputs`, `room-outputs`, `room-timeout`, `room-shortcut: global`. Auto-`uv`-installs deps; materializes declared inputs to a temp folder; saves declared outputs back as versioned room files. Per-script row: language badge, "Needs review" ribbon, running/failure status, manifest display.

**Trust model** — every version of a script must be individually approved by content hash before it can run at all, unconditionally. Unapproved run → consent card naming interpreter, manifest, and every room file the run would decrypt; choice of Allow once / Always allow / Deny. Explicit runtime disclosure shown verbatim: *"it can reach the internet, and it runs with no sandbox — it can read and change files anywhere in your home folder, like any app you launch."* Scheduling requires an approved script.

### 7.5 Skills

Portable Agent-Skills-compatible folders (`SKILL.md` + `scripts/`/`references/`/`assets/`/`agents/`), stored encrypted in the room, fully export/import round-trippable. **"Build with AI"** composes a whole skill folder from a description + up to 12 attached source files. Editor fields: Name (validated slug), Description (the trigger text), "Offered to" (bind to one specialist or leave general), SKILL.md instructions, Enabled/Disabled draft toggle, folder-contents pane grouped by purpose with inline add/edit/remove. Status chips: Enabled / Draft / Incomplete (missing description/instructions — inert regardless of enabled state) / Unknown owner. Only enabled skills are ever advertised to the assistant; invocable directly in chat via `/`.

---

## 8. Backend (Rust/Tauri)

### 8.1 Tauri commands (~305 total, grouped by module)

- **Rooms**: create/open/close, recovery-key write/check/open-with-recovery, Touch ID enable/disable/open, rename, room info.
- **Recent rooms**: list/remove/clear.
- **Safety/versions**: version list/pin/delete/restore, provenance, export file/export all, change password, duplicate room, compact room (VACUUM/rekey).
- **Checkpoints**: create/list/delete/rollback whole-room snapshots, stranded-checkpoint recovery.
- **Files**: import, list, get/decode content, update content, trash/restore/delete-permanently/empty-trash, save-in-library toggle, save generated file, import link, rename.
- **Bulk**: multi-file trash/move/restore/delete.
- **Library/memory**: add/list/update/delete/restore memory, folders CRUD, get/set setting.
- **Search**: `search_all` (files/chats/memories).
- **Chat**: list/create/delete/rename chat, get messages, delete message, import image/audio bytes.
- **Agent**: `ask` (main answer loop), list specialists, cancel, handoff.
- **Chat commands**: list/run `#command` prebuilt pipelines.
- **Edit gate**: resolve edit approval.
- **Agent UI**: resolve requested UI affordance.
- **Skills**: full CRUD + resource CRUD + import/export folder + compose-with-AI + conflict resolution.
- **MCP config/OAuth**: config get/apply, connector-power getters/setters, auto-approve/outbound-unmask getters/setters, approve, status, OAuth authorize/status/sign-out, per-server enable/remove, per-tool prefs, resolve call.
- **MCP registry**: opt-in status/set, marketplace search.
- **Runtimes**: MCP runtime detection + provisioning (npx/uvx etc).
- **Models**: grounding-model resolution, `ai_status`, capabilities, open Ollama, warm/pull/delete model.
- **Providers**: list/connect/disconnect AI providers.
- **External**: list models for external CLI engines.
- **Capabilities**: engine preflight, capabilities, support matrix.
- **Moonshot**: recommended models, ensure-embed-model, list roles, AI Actions (14 fixed actions), memory suggestion, file-meta suggestion, UI-text generation, room graph, room-server status/set, Leash token regen, Ollama URL get/set/test, front page + suggestions.
- **Jobs**: list/cancel/delete, start deep summary/podcast audio/studio/file-pass job, resume, plus Create-page jobs (start create job, story film plan, shot-list job), download job.
- **Workflows**: validate/save/update/set-status/set-pinned/set-schedule/delete/list/get, get schedule, get runs, get step artifact, run, templates, compose-with-AI.
- **Studios**: open/stage HTML preview, prompts, podcast script/cast/voice-preview, flashcards, mindmap.
- **Story**: full cast/shot-list/split CRUD (~20 commands).
- **Create**: list create-capable models.
- **Sketch**: create/save/export-SVG/export-PNG.
- **Vision**: locate-in-image.
- **Video**: probe metadata, trim, save frame.
- **yt-dlp**: cancel download, import YouTube video, import media URL.
- **Peaks**: audio waveform peak data.
- **Office**: slide preview, office HTML.
- **Spreadsheet**: set cell.
- **Docx edit**: update text.
- **Preview**: Quick Look thumbnail.
- **Docs HTML**: open scratch pad.
- **Scripts**: resolve/list/get-manifest/run, set schedule.
- **Privacy**: status, set room/global, add block/remove entity, set concepts, preview, start scan.
- **Speech**: neural TTS speak, list voices.
- **STT/dictation**: cancel-download/status/download-model/delete-model, transcribe, dictation start/push/stop/cancel, AI shape-text cleanup.
- **Recording**: start/push-audio/pause/resume/set-live-translate/set-live-stt/retranscribe/stop/live-status/get, set speaker name, AI "read the meeting", note/chapter/highlight add/set, item delete, voices list/forget, delete-range/correct-range, export-clean, translate.
- **Feedback**: app diagnostics, draft.
- **Shell exit**: set-unsaved-edits, quit-guard-rearm.
- **Top-level**: `web_search_test`.

### 8.2 Recording & diarization

Two capture lanes mixed to one timeline: **mic** and **system audio** (ScreenCaptureKit, macOS 13+, excludes the app's own process audio). Per-lane streaming VAD (bundled Silero neural VAD, energy-gate fallback). Segments capped near Whisper's 30s window, cut at the quietest recent frame. Dedicated decoder thread runs bundled Whisper for live partials (~1.5s) and word-timestamped finals. "Sticky language" lock per lane. Contiguous timeline across pause/resume, checkpointed flush every 8 segments, 3-hour session ceiling. Non-destructive editing (cuts/deletes marked, real audio splice only on export). Echo detection between lanes to avoid double-transcribing.

**Diarization**: TitaNet-small speaker embeddings (ONNX via pure-Rust `tract`, ~150ms/phrase), DSP fallback. Production recipe: fixed 2s sub-window embeddings averaged, session-mean centering, agglomerative clustering, phantom-speaker suppression, Viterbi turn-continuity smoothing. **Sub-window split pass**: phrases re-cut into 1.5s windows / 0.75s hop and reclustered to catch two speakers in one silence-bounded phrase (measured 60% of AMI reference speech is multi-speaker phrases). Cross-recording voice recognition — naming a speaker saves a voiceprint so future recordings recognize them.

### 8.3 Extraction

Dispatch/registry module plus per-format sub-modules: article (Readability-style, via `dom_smoothie`, strict metadata — never invents author/date), chunking (paragraph-boundary, for RAG), data readers (notebooks/eml/subtitles/svg/zip listing), docx (footnotes/headers/comments + position-preserving edit matcher), html (+ html_edit matcher), legacy (pure-Rust native `.doc`/`.xls`/`.ppt` readers, no external MarkItDown dependency), pdf (+ pdf_quality garbage-detection gate that routes bad extractions to OCR), pptx, xlsx (via `umya`, strings+numbers+formulas), windowed/filtered reads for paging large files.

### 8.4 Database

SQLCipher-encrypted per-room SQLite. Tables include: files, folders, chats, messages, memories, meta, settings, file_versions, jobs, job_artifacts, staged_artifacts, workflows, workflow_runs, schedules, skills, skill_resources, story_cast/lists/shots, recordings, rec_chunks, chunks, trashed_chunks, podcasts, privacy_entities/scans, voice_ids/rejects, browse_journal, web_pages/images/searches, scribble.

### 8.5 macOS-specific integration

- **Bundle**: product "Arcelle", id `com.benreich.privateroom`, `.arcelle`/`.roomai` file association (role Editor), bundled Whisper/TitaNet/Silero model files + Python sidecar binary, ad-hoc signing, `Entitlements.plist`, min macOS 12.0. CSP allows only `'self'` + custom schemes `roommedia:`/`roomdoc:`. Auto-updater against GitHub Releases with minisign signature verification.
- **Entitlements**: only `com.apple.security.device.audio-input` — no App Sandbox entitlement.
- **Info.plist**: mic-usage string clarifying on-device transcription; exports a UTI for `.arcelle`/`.roomai`; no custom URL scheme registered.
- **Touch ID / Keychain** — password stored Keychain-gated by `SecAccessControl biometryCurrentSet` (re-enrolling a finger invalidates it); always falls back to password.
- **Quick Look** — `QLThumbnailGenerator` universal preview fallback (20s timeout guard); decrypted bytes written to an owner-only temp file, deleted immediately after render.
- **OCR** — Apple Vision framework, English + Hebrew, fully on-device, silent fallback.
- **Video probing** — AVFoundation (no bundled ffmpeg).
- **Window snapshot** (`view_screenshot` tool) — `WKWebView.takeSnapshot`, not screen capture, so needs no Screen Recording TCC permission.
- **Legacy Office import** — shells out to macOS's own `/usr/bin/textutil`.
- **STT decode** — macOS `afconvert`/`avconvert`; Whisper.cpp with Metal acceleration on Apple Silicon.
- **Native menu bar** — see §10.

### 8.6 Auxiliary binary: `roomai` CLI

`roomai verify|info|recover|export` — standalone offline tool using the identical SQLCipher scheme as the app; secrets accepted **only** via environment variables (`ROOMAI_PASSWORD`/`ROOMAI_RECOVERY`), never CLI flags (argv is readable by other same-user processes on macOS).

---

## 9. Python sidecar

The sole AI reasoning engine for the entire app — every feature (chat, summaries, file passes, AI Actions, translate, studio, suggestions, workflow-generate nodes) runs identically regardless of which model engine backs it ("engine parity").

### 9.1 Agent roster — 16 total (1 hub + 15 specialists) across 8 shared graph "shapes"

**Hub**: `chat.answer` ("Main agent", shape `supervisor`) — no room tools of its own, only dispatches via `ask_*_agent`/`ask_agents` and composes the final answer.

**15 specialists, grouped by 6 routing domains**:

| Domain | Members |
|---|---|
| `file` | `files.read` (File agent), `scripts.run` (Scripts agent), `media.transcribe` (Transcription agent), `media.video` (Video agent), `creator.studio` (Studio agent), `creator.draw` (Drawing agent) |
| `web` | `chat.web` (Web agent — search/fetch, read-only), `chat.browse` (Browser agent — operates a live page) |
| `app` | `app.ui` (App agent — sees/operates Arcelle's own UI) |
| `jobs` | `jobs.run` (Jobs agent — whole-file passes), `jobs.workflows` (Workflow agent) |
| `skills` | `skills.use` (Skills agent), `skills.author` (Skill-builder agent) |
| `connector` | `connectors.use` (Connector agent), `connectors.admin` (Connector setup agent) |

**8 graph shapes** (`graphs.py`): `react`, `supervisor`, `react_verify` (ground-truth check on write claims), `route_act` (deterministic exclusive router), `probe_gate_act` (free probe + blocker gate), `perceive_act` (deterministic opening snapshot), `chain_stage` (ordered multi-stage sequence), `recall_act_check` (probe → act → repair-capped check).

Delegation: the Main agent's catalog is capped at 6 `ask_*_agent` tools (a 4B model's reliable choice ceiling) plus one batch fan-out tool `ask_agents` carrying `{agent, instruction, depends_on}` tasks. Users can also directly address a specialist via a `*tag` composer prefix, bypassing the hub.

### 9.2 Tool catalog

- **Core** (every sub-agent): `list_room_files`, `search_room`, `open_file`, `annotate_file`, `mark_image`, `list_memories`, `update_memory`, `delete_memory`, `list_skills`, `read_skill`, `create_file`, `edit_file`, `edit_files`, `write_file`, `set_cells`, `rename_file`, `move_file`, `add_memory`.
- **Organize**: `organize_files`, `trash_files`, `merge_files`, `set_in_library`.
- **Sketch**: `draw`, `read_drawing`.
- **Skills use/author**: `read_skill_resource`, `run_skill_script`; `save_skill`, `write_skill_resource`, `delete_skill_resource`, `delete_skill`.
- **Connector admin**: `list_mcps`, `read_mcp`, `save_mcp` (always writes a disabled draft), `delete_mcp`.
- **Connector use**: `search_mcp_tools`, `run_mcp_tool` (generic passthrough).
- **App/UI (agent embodiment — `src/agent/driver.ts`)**: `ui_snapshot` (numbered Set-of-Marks list of every interactive element, capped at 80, nearest-to-viewport-top prioritized on overflow; a 2.5s-self-clearing visual badge overlay renders the same marks the model was shown so the user can watch along), `ui_act` (click/type/set/scroll by mark number — click dispatches a full pointer-down/up/click sequence rather than `.click()` since some rows listen on pointerdown; typing goes through the native input-value setter so React's controlled inputs actually see the change; a "ghost ring" flashes over the element being acted on), `view_screenshot` (native whole-window capture in Rust, with a DOM-composite canvas/img fallback capped at 1280px for the vision model), `view_media_frame` (seeks a hidden `<video>` via `roommedia://` and grabs one frame — no decoded bytes ever leave the webview). **Consent fence**: any element inside `[data-agent-blocked]` (Settings, approval cards, armed deletes, the Lock button) is excluded at the DOM-walker level, not just visually — it never receives a mark at all, and is re-checked again at act-time in case a consent dialog opened after the snapshot was taken.
- **Browser**: `browse_open`, `browse_read`, `browse_find`, `browse_snapshot`, `browse_do`, `browse_look`, `browse_save`.
- **Web**: `web_search`, `fetch_page`, `save_link`, `download_url`, `download_media`.
- **Jobs**: `start_file_pass`, `job_status`, `list_workflows`, `save_workflow`, `update_workflow`, `delete_workflow`, `run_workflow`, `test_workflow`.
- **Scripts**: `list_scripts`, `run_script`.
- **Transcription**: `stt_status`, `retranscribe_file`, `read_recording`.
- **Studio**: `studio_flashcards`, `studio_mindmap`, `generate_podcast_script`.
- **Advisor**: `consult_advisor` (labeled "content leaves this Mac").
- **Delegation**: `ask_file_agent`, `ask_web_agent`, `ask_app_agent`, `ask_jobs_agent`, `ask_skills_agent`, `ask_connector_agent`, `ask_agents`.
- **Loop-internal** (never sent to the model bridge): `request_tools` (unlock a group mid-turn), `read_result` (page a shortened tool result).
- **Third-party MCP**: namespaced `server_tool`, offered alongside the registry catalog.
- **Non-agent "AI Actions"** (14 fixed, callable via `POST /ai_action`, not tool calls): file-scope — summarize, analyze, explain, extract, outline, rewrite, qa_pack, fact_check, translate; room-scope — research, compare, timeline, themes, gaps.

### 9.3 Model engines & providers

Four engines behind one seam:
- **Local — Ollama** (loopback `127.0.0.1:11434`), including Ollama's own `:cloud` relay models (treated as non-local for privacy purposes).
- **Cloud API — OpenRouter** (OpenAI-compatible `/chat/completions` + dedicated `/images`; model ids `"openrouter::vendor/slug"`; the only API-key provider today).
- **Cloud CLI — Claude Code** (subprocess `claude` CLI; tool calls routed as **real MCP tools** via a locally-hosted MCP server, since narrated text-protocol tools caused Claude Code to hallucinate failures).
- **Cloud CLI — Codex** (subprocess `codex exec --json`).

Engine parity: every feature calling `llm.generate`/`generate_stream` gets identical reach on a cloud CLI as on local — no per-feature special-casing. Routing is decided purely by the model string (`is_external_model`/`is_cloud_model`) — no load-balancing/failover between providers.

### 9.4 Domains

"Domain" here means agent-routing specialization, not a RAG knowledge-domain concept. The 6 domains (`file`, `web`, `app`, `jobs`, `skills`, `connector`) are capped at 6 for reliable small-model routing; each domain's blurb is filtered per-run to only what's actually reachable in the current room (e.g. a web-off room drops `web`).

### 9.5 MCP support

Two roles, both in-process: (1) an **outbound room bridge** every tool call flows through (minimal JSON-RPC 2.0 client, fresh bearer token per run — the sidecar never touches the encrypted DB directly); (2) the **third-party connector marketplace**, exposed only via `search_mcp_tools`/`run_mcp_tool` (use) and `list_mcps`/`read_mcp`/`save_mcp`/`delete_mcp` (admin, always saves disabled). A separate **hub MCP server** (ephemeral, loopback, one-shot token) exists solely so cloud CLI engines invoke `ask_*_agent` as real MCP tools instead of narrated text. Outbound tool-call args are redacted under the privacy door and restored inbound, recursively over lists/dicts.

### 9.6 Privacy gatekeeper (PRIV-1/PRIV-2)

Pure string mechanics, no model calls, no I/O — engages only for non-local calls (Ollama `:cloud`, cloud CLI, OpenRouter). Enforced at the single model seam every feature shares. Policy (on/off + entity map) is built by a **local-only** AI scanner (PRIV-2) whose every "finding" is re-verified verbatim against source text before counting (can under-mark, never hallucinate a mark). Redacts every text field, tool-call argument, and drops attached images outright (a stripped reference image would silently generate a wrong picture — refused, not redacted). Reply is restored placeholder→real on the way back, stream-safe. Tool-step chips explicitly label exfiltration points ("content leaves this Mac").

### 9.7 Voice — TTS/STT

- **TTS**: Microsoft Edge neural TTS (`edge-tts`) — not Kokoro. Live-fetched voice catalog (no bundled list). Single-utterance synthesis, chunked long-text splitting, and full multi-voice **podcast synthesis** with per-turn voice/rate/pitch, mastering (EQ, LUFS normalization, soft limiter) for one consistent seekable mix.
- **STT**: actual recognition runs on-device in Rust (bundled Whisper.cpp); the Python sidecar only exposes the check/trigger tool surface (`stt_status`, `retranscribe_file`, `read_recording`).

---

## 10. Native menu & shortcuts

Native macOS menu bar fully replaces Tauri's stock menu (data-driven table in `menu.rs`, frontend half in `useNativeMenu.ts`):

- **Apple menu**: About, Services, Hide/Hide Others/Show All, **Quit Arcelle (⌘Q)** — custom row (not the OS-predefined Quit) so it can check for unsaved edits before terminating; a second ⌘Q always quits.
- **File**: New (⌘T, context-aware: new page/sketch/creation/note), Close (⌘W, closes active browser page → open doc → window).
- **Edit**: Undo, Redo, Cut, Copy, Paste, Select All (re-declared to keep clipboard shortcuts working everywhere, including the password gate).
- **View**: Sidebar (⌘1, label follows active destination's own word for "library"), Assistant (⌘2), Focus the Workspace, **Layout** submenu (Focus/Research/Review presets, Reset Layout), Show Destination Names, Toggle Full Screen.
- **Window**: Minimize, Zoom (no Close Window row — that's File → Close).

**Shortcuts owned outside the native menu**: ⌘3 (React-level Assistant alias, one-release-only), ⌥⌘1–9 (jump to tab by position), arrow/Home/End (move within tab strip/browser-page list), Escape (capture-phase — closes topmost popover/dialog, then leaves Focus mode, then closes the open file), ⌘K (search/palette), ⌘F (in-doc find), ⌘J (workflow quick menu), ⌘L (lock), ⌘N (new chat), ⌘S (save in editors), ⌘D (duplicate in Sketch), ⌘Z (undo), ⌘0 (fit/reset zoom).

---

## 11. QA checklist taxonomy

`qa/UA-FEATURE-CHECKLIST.md` (1,172 lines, ~371 items) is the app's own self-maintained feature ontology, organized into 43 numbered sections — a useful independent cross-check that the areas above were not under-scoped. Section headers: App bootstrap & global behaviors; Start screen; Create room; Recovery-code modal; Unlock screen; Sidebar/activity rail; Three-pane layout (+4 sub-sections); Status bar; Top bar; Library pane; File rows; File context menu; Trash; Import paths; Center pane/viewer chrome; Viewers by file type; Compare & versions; Room Map; Studio; Front page; Search/command palette; Global overlays/toasts/approval cards; AI pane/chat/composer; Voice output/dictation/recording capture; Memory area; Workflows; Scripts; Skills area; Connectors area; Settings; In-room agent capabilities; Agent embodiment (UI-driving); Private browser; Leash (external agents); Cloud-privacy enforcement seams; Global behaviors (quit teardown, window geometry, idle lock); QA harness; Multi-file operations; Trash in bulk / File agent organizes; Podcast voices/recording; Sketch; Drawing agent. The document's own closing note: "report anything present in the app but missing from this list — the list is meant to be complete," i.e. it's a living document, not a frozen spec.

---

## 12. Changelog highlights

Small/easy-to-miss features and fixes worth knowing about (full history is v0.1.0→v0.24.1, 2026-07-05→2026-08-19 — the entire project history):

- **v0.24.1** — ⌘Q now asks about unsaved notes with real two-step confirm (previously the App-menu Quit item bypassed the app entirely and just killed the process). `-cloud`-suffixed Ollama model names (vs `:cloud`) are now correctly treated as non-local for privacy purposes — this had been a real privacy leak. Escape now closes notes (previously did nothing — Monaco's caret lives in a hidden `<textarea>` that ate the keydown).
- **v0.24.0** — WebKit content-blocker compile-failure handling; private-page tab titles follow the loaded site; Recordings overview redesigned to one player.
- **v0.23.0** — Sketch gets Select-tool resting state, 8-handle resize, multi-select align/distribute/duplicate/lock/nudge, snap-to-grid, arrow attachment (auto-reroute). Chat can scope to "the drawing you're looking at." Browser shield now checks storage AND tracker-blocking separately (previously conflated into one claim).
- **v0.22.0** — Quote-selection-to-chat now works on saved web pages/e-books/legacy docs (previously silently excluded). Honesty pass: queued jobs stop animating fake progress, error messages persist until dismissed. Hebrew/non-Latin token-budget counting fixed (was byte-counting, 3× undercounting RTL working memory). Native macOS View menu introduced.
- **v0.21.0** — Sketch page introduced. Sidebar reduced from 10 items to 4 pinned + "More tools" disclosure.
- **v0.20.x** — Video continuity (each clip opens on the prior clip's captured end-frame), pre-spend Story review sheet.
- **v0.19.x** — In-app updater payload fix (a macOS `tar` metadata bug had broken self-update for *every* prior release). AI-generated area subtitles/tab titles.
- **v0.18.0** — Multi-file batch operations, AI room-organizing (dry-run preview).
- **v0.17.0** — Hands-free auto-send-on-pause. Memory deletion gets trash/undo (previously permanent). Spreadsheet formula-injection check broadened.
- **v0.16.0** — `arcelle-host.log` decision log introduced (explicitly scrubbed of room content by design). File deletion gets trash/undo. Massive one-release viewer-format expansion (PPTX/legacy Office/epub/zip/ipynb/eml/srt-vtt/JSON tree/SVG source). 50MB viewer size cliff removed.
- **v0.15.0** — 484-fix "repair release" from a full code read; per-panel crash isolation introduced.
- **v0.14.0** — Diarization rewrite (17.9%→1.3% speaker-mix-up on internal benchmark); browser downloads/tabs/search-results page; TTS goes fully neural (on-device fallback voice removed entirely).
- **v0.13.0** — Built-in fused 7-engine web search; Private Browser area introduced.
- **v0.12.0 and earlier** — parallel multi-part question dispatch; OpenRouter provider (v0.11.0); token-budget bar + Hand off (v0.10.0); Skills area (v0.9.0); unified trust indicator (v0.8.0); rename Private Room → Arcelle (v0.7.0); connector marketplace (v0.7.0); streaming dictation + Metal Whisper (v0.5.0); cloud-privacy gatekeeper introduced (v0.4.0).

---

## 13. Explicitly NOT built yet

From README's self-declared roadmap "Next" section — real negative space, not a gap in this audit:

- sqlite-vec vector index
- In-place `.xlsx` editing beyond single cells
- DOCX export
- Authenticated-download support (`startDownloadUsingRequest`)
- Save-as-PDF from the browser
- Notarized releases
- Windows port (blocked on macOS-only dependencies: ScreenCaptureKit, Apple Vision, WKWebView, Keychain, AVFoundation, macOS neural voices, notarization)
- Single-instance guard (known gap — no protection against opening the app twice)

---

*Sources: full reads of `src/viewers/*`, `src/settings/*`, `src/shell/*`, `src/workspace/*` (incl. `create/`, `workflows/`, `scripts/`, `skills/`), `src-tauri/src/*` (commands, recording, extraction, db, browser), `sidecar/arcelle_sidecar/*`, `README.md`, `qa/UA-FEATURE-CHECKLIST.md`, `CHANGELOG.md`, `docs/`.*
