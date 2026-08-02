# Changelog

All notable, user-facing changes to Arcelle. Versions follow
[semver](https://semver.org); dates are the GitHub release dates.

## 0.14.0 — 2026-08-01

### Recordings finally split speakers where they actually change

- **Two people talking back and forth no longer melt into one "Speaker 1".**
  The old pipeline labeled whole phrases, and most real conversation puts two
  voices inside a single phrase — so short exchanges collapsed into one
  speaker. Recordings are now re-examined in 1.5-second steps and the
  transcript is cut exactly where the voice changes, both for live
  recordings and for **Re-transcribe** on anything you already recorded.
  On our meeting test set this took speaker mix-ups from 17.9% to 1.3%.
- **No more phantom speakers.** A couple of seconds of laughter, overlap, or
  an odd-sounding word could previously mint a "Speaker 4" who owned one
  line. A voice now has to carry real speech mass before it counts as a
  person; short odd moments join the nearest real voice instead.
- **The recording benchmark ships with the code.** A permanent acceptance
  harness scores the real pipeline against reference meetings, so future
  changes to speaker separation get measured, not eyeballed.

### The browser grows downloads, search, and tabs

- **Downloads that behave.** Click a download link and the file lands through
  one guarded funnel — size-capped, origin-checked, recorded as a job you can
  watch. The assistant can save a link, a file, or a page's media for you,
  and video sites work through the same door.
- **A real search page.** Searching in the browser opens a results page of
  its own — with previews, and an on-demand AI summary whose every claim
  links back to the result it came from.
- **Tabs.** The browser now holds several pages at once.
- *Not yet:* saving a file that no link points at but that needs the site's own
  login, and "Save as PDF" of the page you're reading. Clicking a download link
  on a site you're signed in to does work — those carry the session with them.

### Spoken voice is now fully neural

- **The robotic fallback voice is gone.** Arcelle speaks only with the neural
  voices; the on-device engine and its settings have been removed.
- **The voice list is live.** Voices come from the speech engine's actual
  catalog (322 voices today), grouped by language, with preview — instead of
  a bundled list that goes stale.

## 0.13.0 — 2026-07-30

### One search engine, built in

- **No more picking a search provider.** Settings → Online features used to make
  you choose between DuckDuckGo and running your own SearXNG server (and, before
  that, Brave with an API key you had to get yourself). All of that is gone. It's
  now a single switch: let this room reach the internet, or don't.
- **Search asks several engines at once and merges the answers.** One query fans
  out to seven independent sources — general web engines, an encyclopedia, and a
  news feed — and the results come back as one list, ranked by how highly the
  engines rated each page *and* how many of them agreed on it. Pages several
  engines put near the top rise to the top.
- **A blocked engine no longer means a failed search.** Any single engine can be
  rate-limited, ask for a human check, or change its layout; when that happens it
  simply drops out and the rest still answer. The old setup had one engine, so
  one bad day meant "search is broken, try again in a minute".
- **Every result says where it came from.** Each hit now carries the engine that
  found it, its date when the source publishes one, and how relevant it scored —
  instead of the marketing blurb search pages print under a link.
- **Rooms you already have keep working.** A room where you'd picked a provider
  opens with the internet switch already on. Nothing to redo.

### A private browser, and an assistant that can use it

- **New Browser area: a web browser that keeps nothing.** It has no history, no
  cookies, no cache and no saved logins — not "cleared on exit", but never
  written to disk in the first place — and it blocks ads and trackers before
  the request leaves your Mac. The shield in the toolbar is a live check of the
  browser's own storage, not a label.
- **Ask the assistant to look something up and it opens the page itself.** It
  can read a page, find and click things, fill in forms, and look at the page
  as a picture with every clickable thing numbered — the same numbers it uses
  when it describes them to you, so you can follow along.
- **You can take the wheel at any time.** "Take over" pauses the assistant's
  browsing; it will say its tools are paused rather than pretending to act.
- **Nothing of yours goes into a web page without you saying so.** If the
  assistant is about to type something you marked private into a site, it stops
  and shows you the exact text and the exact site first.
- **The web forgets; your room remembers.** Everything the assistant did in the
  browser — every page, click and consent — is kept in a Journal inside your
  encrypted room, so you can read back exactly what happened. You can clear it
  whenever you like.
- **The browser can't be used to reach this Mac.** Addresses on your own
  computer or home network are refused, in the address bar and inside pages
  alike, and passwords fields are fenced off from the assistant entirely.
- **Two separate switches for what the assistant may do online.** Searching the
  web and driving the browser are now independent: turn either off and the
  assistant is not offered those tools at all, so it cannot use one by mistake
  — and it will say plainly that it can't rather than pretend. Your own Browser
  area is unaffected either way; these govern the assistant, not you.
- **"Go to", "browse to", "navigate to" always open the page.** Asking to go
  somewhere specific used to fall through to the search agent, which looked the
  site up instead of opening it. Naming a destination now reaches the browser
  every time, in English and Hebrew alike.

### Answers you can trust

- **A room with the internet turned off says so, instead of answering from your
  files.** Arcelle still described "the internet" as one of its specialities in
  a room where web access was off, so asking for the weather could quietly reach
  the file specialist, which answered out of your documents. Every list of what
  Arcelle can do is now built from what that room actually has, and a request
  for a specialist the room does not have is reported plainly rather than
  handed to a different one.
- **Changing several files at once is all-or-nothing, as promised.** If one
  entry in a multi-file change was missing its file name, that entry was
  silently dropped and the rest were applied — and the result still said the
  change had landed. Now the whole batch stops and names the entry to fix.
- **A tool called without a file name no longer edits the wrong file.** A
  missing name was treated as an empty search, which matched the most recently
  added file in the room — so a malformed request could open, or edit, a file
  nobody named. Every tool now refuses a request that is missing something it
  requires, and says which part was missing.
- **A skill can no longer be filed under a specialist that does not exist.** One
  mistyped character used to save the skill to nowhere: it was never offered to
  anyone and never shown to you again.
- **Reading a heavy page no longer kills the whole request.** Fetching a big
  site handed the entire page to the model in one go. On a cloud room nothing
  trimmed it, so the request was rejected and the specialist came back with
  nothing — you saw a failed step and an assistant improvising about why it
  couldn't read the page. Pages now arrive a chunk at a time, with the
  assistant told how to read on, and no single result can overflow the model
  again whichever engine you use.
- **The assistant stops denying things it can do.** On a cloud engine it would
  answer "I can't browse the web" or "I have no way to inspect connected
  services" while those very tools were available to it. The sentence that
  tells it otherwise was being dropped on exactly the turns where it decides
  what to do.
- **Once the browser was open, the assistant's other tools stopped working.**
  Opening a page changed how the app found its own main window, and every tool
  that needed it failed — silently, including background jobs and the
  scheduler.

### When something goes wrong

- **A failed answer now leaves a trace.** If a run ends without producing an
  answer, the reason is written to a log file on this Mac instead of vanishing.
  Nothing about your room or your question is logged — only the failure.

### Connected services

- **Connector tools keep their warnings.** Descriptions from connected services
  were trimmed mid-sentence with nothing to show they had been cut, so a tool
  documented as permanent and irreversible could arrive reading as routine.
  Trimmed text is now marked, and the budget is measured in characters, so
  Hebrew and other non-Latin descriptions get the same room as English.
- **Connector options are no longer quietly hidden.** Where a connected tool
  offered a long list of allowed values, everything past the first sixteen was
  dropped with nothing said — those choices were simply unreachable. The list is
  now far longer, and when it is still shortened Arcelle says so.

### Faster on small models

- **Less of every request is spent describing the tools.** The full workflow
  node reference — the largest tool description in the app — moved out of every
  turn and into the moment Arcelle actually looks up your workflows, leaving
  more of a small local model's context for your actual question.

## 0.12.0 — 2026-07-27

### Answers you can trust

- **A failed send is never reported as sent.** The agent that sends email and
  Slack messages had no check on its own claims, so a message that failed to go
  out could still be described to you as sent. It is now held to the same
  ground-truth check as anything that writes to your room.
- **A successful save is never reported as failed.** Editing several files at
  once — or moving one — recorded nothing, so Arcelle told you the change had
  not landed when it had, and spent an extra round doing it.
- **Every step of a multi-step task is checked, not just the first.** A task
  like "summarize the lease, then save the notes" lost its safety check on the
  step that does the writing.
- **Transcribing a file you named loosely now works.** Asking to re-transcribe
  "the meeting recording" made the agent look up which file you meant — and
  that lookup used up its only turn, so it finished having found the file and
  never transcribed it, while telling you it was done.
- **Web answers are sourced.** Arcelle could answer from a search-result
  snippet without opening the page, which its own rules call "not a source".
- **A specialist that comes back empty-handed now says so** instead of showing
  a green tick.

### Faster multi-part questions

- **Independent parts of a question run at the same time.** Ask "what does my
  lease say about rent, and what is the current rate" and both are worked on
  together, so the answer takes as long as the slower half rather than the sum.
- **One request can carry a whole plan.** Arcelle can now dispatch a list of
  tasks in a single step, saying which depend on which — dependent work waits,
  everything else runs immediately, and each dependent step is handed what the
  earlier one found.
- **No more arbitrary limits.** The caps on how many specialists a question
  could consult, and how many turns each could spend, are gone.

### Sturdier under pressure

- **One thing going wrong no longer loses the rest.** If a specialist fails
  mid-question, its part is reported as failed and everything else still
  arrives.
- **Stop keeps what already finished.** Stopping a question used to discard
  completed work; you now get what came back, clearly labelled as partial.
- **Long answers degrade gracefully.** When a conversation outgrows the model's
  window, Arcelle trims what it has already used before it touches the material
  your answer is built from.

### Image marking tells the truth

- **"Could not locate that in this image" no longer hides a missing model.**
  With no vision model installed, marking silently ran on a model that cannot
  see and reported that your image did not contain the thing. It now says a
  vision model is needed and offers to download it.

## 0.11.0 — 2026-07-21

### Bring your own cloud models

- **OpenRouter is now a first-class AI provider.** Connect an API key from
  Settings; it is validated and stored in macOS Keychain, never in a room file.
- **A live catalog instead of a hardcoded list.** Arcelle loads the models
  available to the connected OpenRouter account, with search, context windows,
  and live input/output pricing.
- **Choose by capability.** Filter models for tool calling, vision, reasoning,
  and structured JSON output, then use the selection anywhere Arcelle uses the
  room's AI engine.
- **Cloud models keep Arcelle's agent workflow.** OpenRouter models stream
  answers, use room and MCP tools when supported, work across background
  actions and workflows, and pass through the same cloud-privacy door.
- **Failures say what actually happened.** Provider validation and upstream
  errors are no longer mislabeled as a sidecar startup failure; incompatible
  tool catalogs recover to ordinary chat without exposing credentials.

## 0.10.0 — 2026-07-21

### See — and reclaim — your context budget

- **A live token-budget bar.** The composer now shows how full the model's
  context window is, right where you're typing — a segmented bar colored by
  what's actually taking up the space.
- **Click for the exact breakdown.** See precisely how many tokens come from
  the system prompt, conversation history, tool results, skills, and file
  reads, each with an exact count and percentage.
- **Hand off when you're running low.** One click summarizes the conversation
  so far and continues the same chat with a fresh, much smaller context — no
  need to start a new chat just to keep going.
- **Real counts wherever the engine reports them.** Local models, Ollama cloud
  models, Claude Code, and Codex all report their actual token usage now;
  anywhere else, the bar says plainly that it's estimating.

## 0.9.0 — 2026-07-21

### Skills turn repeatable work into a reusable capability

- **A dedicated Skills workspace.** Skills now live in their own encrypted
  area instead of masquerading as ordinary room files. Create them manually or
  describe what you need and let the room's current AI engine draft one for
  review.
- **Portable, folder-shaped skills.** Import and export the familiar
  `SKILL.md` structure with optional `scripts/`, `references/`, and `assets/`
  folders, so a skill can move between Arcelle and other agent-skill systems
  without being flattened or rewritten.
- **Everything needed stays together.** Browse the skill tree, edit its
  instructions and text resources, add supporting files, and maintain many
  independent skills from one place.

### The assistant loads only the expertise it needs

- **Progressive disclosure keeps context focused.** The assistant initially
  sees only enabled skill names and trigger descriptions, then reads the full
  instructions or a specific resource when the task actually calls for it.
- **Skills work across every engine.** Local models, cloud models, Codex, and
  Claude share the same room skill catalog and can list, read, draft, and
  extend skills through the agent tool bridge.
- **Review before activation.** Imported and AI-generated skills begin as
  disabled drafts. Script helpers run only from reviewed, enabled skills,
  require approval for their exact content, and execute from an isolated
  temporary skill tree without access to the encrypted room key.

## 0.8.0 — 2026-07-21

### Always know where your content is going

- **One trust indicator, everywhere.** The room now states its privacy state
  in one consistent way — **Local only**, **Protected cloud**, or **Raw
  cloud** — with the same words and the same color in the status bar, the top
  bar's engine badge, and the chat pane, instead of "Cloud model" in one place
  and "nothing leaves on its own" in another. Click it to jump straight to
  Cloud privacy in Settings.
- **See exactly what a cloud model would receive.** "Cloud view" is now
  **Preview cloud payload** — it shows the estimated size, states plainly
  whether the door is protecting you or off, and if it's off, marks the
  details that would otherwise be hidden.
- **The AI's source scope is explicit.** The sidebar now says outright whether
  the assistant is drawing on the **whole room** or only your **selected
  files** — no more guessing what an empty checkbox means.
- **Spoken answers default to on-device.** Voice replies now default to the
  on-device synthesizer, which never sends anything off this Mac; the cloud
  neural voice is an explicit opt-in, and the Voice settings page states which
  one is active before you touch anything.

### Home leads with what needs you

- **A new "Needs your attention" section.** Home now opens with the things
  that actually need a decision — a raw-cloud model in use, files still
  waiting on a privacy scan, scripts that need review, workflows stuck as
  drafts — each with a one-click fix, instead of only a list of recent files.

### Workflows and scripts you can trust

- **Steps have real names.** A workflow step no longer opens to a blank "Step
  name" while the canvas shows `file_pass` — every step gets a short,
  human-language name, backfilled automatically for existing workflows and
  requested up front when the assistant builds a new one.
- **One incident, not five identical errors.** A script that fails the same
  way repeatedly now shows as a single incident — the cause, how many times,
  and one recovery action — instead of five raw error rows.
- **The assistant won't say "fixed" until it's actually fixed.** Testing a
  workflow now returns an explicit validated/not-validated result, and the
  assistant is instructed never to claim a script or workflow works until a
  real test confirms it — a script step that only *parked* for your approval
  is no longer reported as working.

### A calmer, clearer shell

- **Settings is six focused pages**, not one long scroll — AI & behavior,
  Voice, Privacy & recovery, Connections, History & storage, and App.
- **Every rail icon has a label.** The left rail is no longer icon-only —
  Library, Workspace, AI, Home, Map, Recordings, Workflows, Scripts, Memory,
  Connect, Focus, and Settings are all named, and the Focus button now reads
  "Focus" / "Unfocus" instead of relying on a tooltip.
- **The workspace is the star.** New rooms open with a wider, more dominant
  center pane; the AI pane eases open and closed instead of snapping.
- **Room Map handles outlier files.** A file unrelated to everything else in
  the room no longer drifts off-screen and breaks the map's auto-fit.

### Re-transcribe on demand

- **A Re-transcribe button on every recording and video.** If a transcript
  came out wrong, or you've since installed the voice model, one click reruns
  on-device transcription and replaces it — no need to delete and re-import.

## 0.7.0 — 2026-07-20

### Private Room is now Arcelle

- **New name, same sealed room.** Private Room is now **Arcelle** — "a little
  ark." Same app, same encrypted file, same local AI inside; only the name and
  the icon changed. This update renames the app in place, so your rooms,
  memories, Touch ID, and granted permissions carry over untouched.
- **New vaults are `.arcelle` files.** Rooms you create from now on save with
  the `.arcelle` extension; every existing `.roomai` file still opens exactly as
  before — nothing to convert, nothing left behind.
- **A new mark.** The app icon is a single unbroken ribbon folded into an "A" —
  one continuous ribbon for the one file that holds everything, with a small
  amber seam for the one key that opens it.

### A marketplace for tool connectors

- **Browse and install MCP connectors from a live registry.** A new
  **Connectors** area in the sidebar rail lets you search the public Model
  Context Protocol registry, filter to verified publishers, local-only, or "no
  API key needed," and install a connector in one click. Browsing the registry
  is the only time the app reaches out on its own, so it's behind an explicit
  opt-in — nothing about your room is sent, only the catalog comes back.
- **Local by default, cloud by choice.** A connector that ships both a local
  package and a hosted endpoint installs the local one (nothing leaves your
  Mac), with a one-tap switch to the cloud version. Remote connectors are
  badged loudly; before their arguments leave the Mac, Arcelle redacts the
  room's sensitive spans and asks first.
- **Sign in without leaving the app.** Remote connectors that use OAuth get a
  **Connect account** button that runs the whole browser sign-in and stores the
  token in the room — with a manual open/copy-link fallback if your browser
  doesn't open on its own.
- **Manage every connector and every tool.** Installed connectors can be turned
  on or off, removed, and expanded to a per-tool list where you switch
  individual tools on or off — or flip one override to send a connector's whole
  toolset to the assistant. Cloud models now get a much larger tool budget than
  the small on-device model, so a big connector's tools all come through.

### Workflows do more — and in parallel

- **Nine new step types** join generate / summarize / deep-pass / agent /
  save / condition: **HTTP fetch** a URL, **extract** structured fields into a
  table, **transform** text with no model call at all, **merge** several
  branches back together, **route** to labeled branches, **vote** across
  parallel attempts for consensus, **fan out over every matching file**,
  **refine** an output until it passes its own check, and **plan-then-map** an
  objective into sub-tasks. Each type gets its own parameter sheet in the
  builder.
- **Steps run in parallel.** Independent branches now execute concurrently —
  lane-gated so the single local model stays serialized while cloud and CPU
  work fan out — instead of everything running one after another.
- **Scripts and workflows mix.** A workflow step can run one of your room
  scripts — importing its output, or piping text through it — so deterministic
  code and model calls live in the same pipeline.
- **A friendlier builder.** Parallel-branch authoring, an icon picker per
  workflow, clickable validation errors that jump to the offending step, and
  richer run history with per-step output and copy buttons. The "describe a
  workflow" box grows to fit a long description, and the icon picker's choices
  are reliably clickable.
- **The assistant tests as it builds.** Ask the assistant to build a workflow
  and it can now run it, read what each step actually produced, fix the step
  that failed, and try again — handing you a working draft instead of a guess.
  It still leaves the workflow as a draft for you to review and activate, and a
  step that runs one of your scripts still asks your approval first.
- **Workflows read your generated files.** Steps that pick files — newest, all,
  by name, or "needs a summary" — now include the pages and sheets the
  assistant created, not just files you imported, so a workflow can summarize or
  cross-check the very reports it made.
- **Deep-pass handles code and data.** A full pass over a script or a CSV no
  longer comes back empty when the on-device model can't summarize a dense
  window — the content is kept and covered instead of dropped.
- **Running a workflow's script asks once.** A workflow step that runs one of
  your room scripts now shows the same one-time approval card as the Scripts
  page, instead of silently refusing with a confusing "changed since approved."
- **Dashboards the assistant builds render in place.** HTML pages the assistant
  writes are now self-contained — charts drawn inline, data embedded — so they
  display in the app's private, offline viewer instead of arriving blank because
  they reached for a chart library or live data on the internet.

### A calmer, more professional look

- **One icon family, no emoji.** Every native emoji in the interface — the
  workflow template gallery, pins, schedules, run/stop/pause controls, and the
  "saved / copied / installed" status checks across Settings — is now a line
  icon from a single system (24px grid, monochrome, with the violet accent
  reserved for selected and primary actions). The workflow template gallery in
  particular reads as one professional set instead of seven colorful
  pictograms.

### Updates

- **Check for updates in-app.** A new **Settings → App → Updates & version**
  shows your current version and, in one click, checks the signed GitHub
  release, downloads and verifies it, installs, and relaunches — the visible,
  on-demand counterpart to the quiet check that already runs on launch.

## 0.5.1 — 2026-07-20

- **Recovery codes show as you type them.** The recovery-code box on the
  unlock screen now uppercases each character as you type, matching the
  `XXXX-XXXX-…` format the code was shown in. (It always accepted lowercase —
  this is a display fix, so what you type looks like what you were given.)

## 0.5.0 — 2026-07-20

### Dictation that keeps up with you

- **Words appear as you speak.** Dictation now streams: the composer paints
  your words into the box live while you talk, and the journal, file, and
  memory mics show the rolling transcript in the capture pill. The wait that
  used to start when you hit Stop now happens while you're speaking — Stop
  just finalizes. Still 100% on this Mac, nothing leaves the room.
- **The voice engine finally uses your GPU.** Whisper now runs on Metal on
  Apple Silicon: transcription runs ~2.5× faster (about 15× realtime), and
  the first-dictation model load dropped from ~26 seconds to a few. Live
  recording transcripts and imported audio/video transcription get the same
  speedup.

### Workflows

- New **"All files"** selector for summarize and file-pass nodes.
- The workflow composer is now taught every selector and condition it may
  use, so AI-drafted workflows stop failing validation on selectors the
  model was never told about.

## 0.4.1 — 2026-07-19

Post-incident hardening: the "every model feels stuck" failure chain can't
happen again.

- **The scan yields to you.** The document scanner pauses between files
  whenever a chat turn is in flight (Settings shows "Paused while you
  chat"), so questions never queue behind library scanning on the same
  local model. It quietly resumes when you stop chatting.
- **No more orphan sidecars.** Each sidecar watches its parent app and
  exits within seconds if the app dies (crash, force-quit, reinstall) — a
  leftover process can never hog the local model with nobody listening.
- **The live privacy guard can't stall chat.** Hard-capped at 8 seconds
  and skipped while the scan runs; the mechanical exact-word rules apply
  regardless.
- The sidecar's `/health` now reports the real app version.

## 0.4.0 — 2026-07-19

### Cloud privacy, mechanically enforced

- **The gatekeeper.** With the door on, private details are swapped for
  stable neutral tags (`[Person A]`, `[Address B]`, …) before anything
  reaches a cloud model — and put back in the answer you read. Enforcement
  is mechanical at **every** exit: the sidecar chat/features gateway, Ollama
  `:cloud` models, the Claude/Codex CLIs, and the MCP bridge cloud agents
  use to read room files. Images never leave while the door is on.
- **The scanner.** A local model reads each imported file once and builds
  the room's protected-entity map; it re-runs automatically on import,
  transcription, and rule changes. ("Scan now" also stopped failing
  silently — it never woke the local engine, and the 4B model's off-schema
  replies were discarded; errors now show under the button.)
- **The live guard.** The question you type is scanned before any cloud
  turn, so a name the scanner never met is still caught.
- **Settings → Cloud privacy.** Per-room switch over a global default, an
  iron-clad "Never share these" block list (mechanical, guaranteed),
  best-effort private topics in your own words, and scan status — plus an
  honest-limits note about what redaction can and cannot promise.
- **Cloud view.** Every file gets a toggle showing the blocked version,
  blackouts included — exactly what a cloud model would receive.
- **Chat receipts.** A green "N details hidden" receipt on protected cloud
  turns, a loud red banner when privacy is off on a cloud engine, and a
  confirmed "Ask again with real details (this once)" valve.

### Voice

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
