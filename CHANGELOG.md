# Changelog

All notable, user-facing changes to Private Room. Versions follow
[semver](https://semver.org); dates are the GitHub release dates.

## Unreleased

- **Neural spoken voice is the new default.** Answers are read aloud with
  Andrew (en-US, multilingual) — a neural synthetic voice, not a human
  recording — via Microsoft's Edge TTS at +22% rate / −2 Hz pitch, loudness
  normalized to ≈−16 LUFS with a no-clip soft limiter. Only the sentence
  being spoken leaves the Mac, only while speaking is on, and Settings
  disclose exactly that. The original on-device voice remains one switch
  away (Settings → Spoken voice → On-device) and is the automatic
  per-sentence fallback when offline. Voice archetypes (Demon, Ghost,
  Wraith, Ancient, Custom) apply to both engines.

## 0.3.1 — 2026-07-19

- **Fix:** the library's "Add page or source" menu opened downward past the
  pane's clipped edge and was invisible. It now opens upward from the footer
  button, capped to the viewport with its own scroll.

## 0.3.0 — 2026-07-19

The platform release: one AI engine under everything, any brain on top of it,
and a room that works while you don't — workflows, scripts, live meeting
recording, and a redesigned shell to hold it all.

### The shell

- **Redesigned workspace** — a persistent activity rail (Home, Room Map,
  Recordings, Workflows, Scripts, Memory, Settings), three draggable panes
  (Library / Workspace / AI), and a status bar that always shows the engine,
  local-vs-cloud, file count, background jobs, and pending approvals. `⌘K` is
  now both room search and a command palette.
- **Light theme** — every color moved into one design-token system with full
  dark *and* light palettes; switch from the top bar, persisted per device,
  no flash on reload.
- **AI pane** — Chat, Studio, and a new Activity tab (jobs, imports, saves,
  approvals) live in a dockable pane with an attention dot when something is
  running or waiting on you.
- **Room home** — continue where you left off: recent files and chats,
  current background activity, and every capability of the room one click
  away.

### Any engine, every feature

- **Engine parity** — the engine you pick for a room (local Ollama, Ollama
  `:cloud`, Claude Code, or Codex CLI) now powers *every* AI feature:
  summaries, deep file passes, AI actions, studios, suggestions, and workflow
  steps — not just chat. Four things intentionally stay on-device: dictation,
  quick local generation, image grounding boxes, and UI-driving tools.
- **Model & effort picker** — choose the exact model behind an engine (Codex's
  catalog is read live from the CLI) and Claude's reasoning effort, from the
  top bar or Settings.
- **Tools for cloud engines** — Codex now gets the room's tools over the same
  per-question localhost MCP bridge Claude Code had; your connected MCP
  servers can ride along behind an explicit switch. The bridge dies when the
  answer returns.
- **One engine under the hood** — all AI features run through a single
  bundled Python/LangGraph sidecar instead of two parallel implementations
  (thousands of duplicate native lines deleted). The app owns its lifecycle:
  spawn on demand, health checks, localhost-only, never sees the room key.
- **Self-managing Ollama** — the app starts the daemon when an AI call needs
  it and stops it after five idle minutes. A daemon you started yourself is
  left strictly alone.
- **The Leash** — an unlocked room can serve external agents on your Mac
  (Claude Code, Codex, Claude Desktop, Cursor) over loopback with a bearer
  token: **Files only** or **Full agent** tiers, per-app approval, stable
  port/token across relocks, and instant revocation.

### Automation

- **Workflows** — visual multi-step AI pipelines (generate, summarize, deep
  file pass, agent, save, condition branches) on an animated canvas with
  template gallery, per-run history with step artifacts, full hand-editing,
  and **compose-with-AI**: describe the pipeline in plain language and the
  room's model drafts it.
- **Schedules** — interval / daily / weekly (DST-safe), optional catch-up run
  at unlock, consent collected once at activation, and no pile-ups: a trigger
  is skipped if the previous run is still going.
- **Room scripts** — Python/JS files in the room become runnable: Run button,
  Scripts area with status and run history (stdout/stderr), isolated per-run
  workspaces, room files materialized in and saved back as versioned files,
  content-hash-gated consent, and dependencies that install themselves via
  `uv` (PEP-723 declarations or on-the-fly self-healing).
- **Background studios** — flashcards, mind maps, and podcast scripts run as
  cancellable queued jobs (FIFO instead of "one at a time, try later"), pinned
  to the room that started them.

### Recording

- **Live meeting capture** — mic + system audio (ScreenCaptureKit) with a
  real-time transcript, automatic speaker identification via on-device
  TitaNet voice embeddings, color-coded speaker chips, live translation, and
  pause/resume. Edit a recording by editing its transcript; re-transcribe old
  recordings with the current pipeline.
- **Crash-proof** — checkpoints from an interrupted recording are spliced
  back together on next unlock; orphaned jobs offer Resume instead of
  haunting the room as phantom "running" entries.

### Editing & history

- **Reliable AI edits** — normalization-tolerant exact-match editing (curly
  quotes, NBSP, CRLF, dashes) that still requires uniqueness and fails safely
  with a closest-snippet hint; a new atomic `edit_files` tool validates whole
  multi-file batches (including rename + reference updates) before writing,
  undoable as a group; optional **ask-before-AI-edits** with a side-by-side
  diff per batch.
- **Compare view** — open any saved version in a read-only side-by-side diff
  against the current file (RTL-aware) and restore from there.
- **Room checkpoints** — named, encrypted snapshots of the whole room with
  safe rollback (automatic "before rollback" copy, blocked while jobs or
  recordings are in flight).

### Voice

- **Spoken answers** — on-device synthesis with Web-Audio-shaped archetypes
  (Demon, Ghost, Wraith, Ancient, or Custom), sentence-chunked so speech
  starts fast, per-message play buttons, auto-speak, and a hands-free
  listen-back loop for voice conversations.

### Memory

- **Memory area** — browse, add, edit, and delete everything the AI remembers,
  grouped by category; suggestions from conversations wait for approval by
  default (auto-save is opt-in); legacy rooms migrate automatically.
- **Scratch pad** — a pinned, versioned `Scratch pad.md` shared by you and the
  AI, with reconcile-instead-of-clobber when you both edit at once.
- **Style presets** — terse-technical, friendly, or formal; your custom
  instructions always win.

### Platform & quality

- **Security hardening (31 fixes)** — full room teardown before opening
  another (the MCP bridge and its bearer token can never serve the wrong
  room), 8 MB cap on fetched pages, a stricter private-network guard (CGNAT,
  multicast, reserved, IPv4-mapped IPv6), recovery-code re-wrap on password
  change, fully atomic version restore.
- **Hebrew, fixed for real** — visual-order (mirrored) Hebrew PDFs are
  detected and repaired at import with vowel points re-attached; nikud is
  stripped for search so plain queries match pointed text; windows-1255 pages
  decode correctly. (Previously imported Hebrew PDFs need a re-import.)
- **PDF viewer** — the 100-page cap is gone; pages render lazily and recycle,
  so book-length PDFs open fast and stay smooth.
- **Always-on indexing** — new files are indexed and described automatically
  in the background (debounced, resumable, no more 50-file cap) without
  hijacking the viewer or your room summary.
- **Verified agent citations** — when the agent opens a file to show a
  passage, the quote is verified against the real file first (any language,
  pointed Hebrew included); misses anchor to the closest real passage.
- **`:cloud` honesty** — Ollama `:cloud` models are labeled cloud everywhere,
  drive the privacy indicator, are excluded from local-only features, and
  their fence-wrapped JSON is recovered so structured features work.
- **The Role setting works** — the persona picked in Settings is now actually
  injected into the system prompt (it was saved but never read).
- **Regenerate, fixed** — regenerating a `#command` message re-executes the
  command and re-attaches `@files` instead of resending literal text.
- **Audit-driven cleanup** — a 1,626-item feature audit drove deletion of
  dead duplicate engines and API wrappers, fixed the MCP initialize handshake
  (standards-strict servers now connect), and added syntax highlighting to
  diff approval cards.
- **QA harness** — `qa/make-qa.mjs` renders the full UI in a plain browser
  with mocked IPC for visual QA and screenshots.

## 0.2.3 — 2026-07-08

QA-driven fixes: reliable tool calls on Ollama `:cloud` models, honest
local-vision fallback, video frame capture no longer returns black frames,
unlimited agent tool rounds, a UI-driving agent that reliably receives its
tools, and image marking that routes to qwen2.5vl when installed.

## 0.2.1 — 2026-07-08

Agent embodiment: the local AI can operate the app like a human (numbered
control snapshots, click/type/scroll with every action visible), plain-prose
answers with structured highlights, and video previews that stream and seek
properly. Consent surfaces are off-limits to the agent by construction.

## 0.2.0 — 2026-07-08

The "moonshot" release: Front Page dashboard, the Room Map, recordings with
diarization, the Leash (room-as-MCP-server), room templates, and a full
internal modularization.

## 0.1.0 — 2026-07-05

First release: a private, on-device AI workspace for your documents — chat,
search, highlight, transcribe, and summarize with a small local model, sealed
in one encrypted `.roomai` file.
