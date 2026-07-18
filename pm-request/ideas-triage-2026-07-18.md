# Ideas Triage — 2026-07-18

Feasibility review of the 12-idea backlog against the current `moonshot-impl` codebase.
Method: five parallel deep-read investigations (one per idea cluster), each followed by an
independent skeptical verification pass on every "this already exists at file:line" claim.
All 47 existence claims came back CONFIRMED. Evidence pointers below were read, not guessed.

## Scoreboard

| # | Idea | Verdict | Effort | One-liner |
|---|------|---------|--------|-----------|
| 1 | External-agent parity (Claude Code / Codex / Flowed via the Leash) | **mostly-exists** | **M** | The Leash + full tool set + file_pass workflow all exist; the build is a new `ExternalAgent` trust tier that grants them, plus `local_generate` and config-staleness fixes |
| 12 | Voice (style) toggle | **mostly-exists** | **S** | `custom_instructions` injection is shipped; add a `response_style` preset key + segmented control |
| 10 | Scratch pad file | **mostly-exists** | **S** | All primitives shipped (create_note, agent write tools, auto-versioning, Monaco); just a canonical-file convention |
| 5 | Persistent working memory | **mostly-exists** | **S** | Per-room memory is shipped end-to-end (4 write paths, prompt injection); only polish + the cross-room question remain |
| 8 | Smart file indexing | **mostly-exists** | **S** | `files.ai_summary` + `list_room_files` + Room summary page exist; gap is auto-trigger on import |
| 4 | Edit tool reliability | partial | **M** | Exact-match + replace-all with zero failure logging; fuzzy fallback, logging, and e2e tests all have natural homes |
| 7 | Multi-file atomic ops | new-build | **M** | No mechanism yet, but single-connection + transaction precedent + `set_cells` batch shape make it clean |
| 6 | Diff preview before edit | partial | **M** | Instant-apply + auto-snapshot + one-click Undo already mitigate the risk; approval gate is copy-paste from the MCP gate |
| 11 | Side-by-side compare | partial | **M** | Versions + Time Machine shipped; needs a read-version command + Monaco DiffEditor modal |
| 9 | Version snapshots (room checkpoints) | partial | **M** | Per-file versioning shipped; whole-room checkpoint = `vacuum_into` + manifest + swap-file rollback |
| 2 | LLM graph workflows + scheduler | partial | **L** | Jobs engine is 80% of the executor; scheduler and workflows page are new; conditional edges are the risky part |
| 3 | Supernatural voice (TTS) | partial | **L** (M for MVP) | Zero TTS exists; MVP = AVSpeechSynthesizer + Web Audio DSP archetypes; neural TTS has licensing/runtime traps |

## Recommended sequencing

**Wave 1 — quick wins (mostly wiring):** 1, 12, 10, 8, and the polish half of 5.
In each case the hard substrate already shipped. Idea 1 is the strategic standout — it
turns Private Room into a full capability provider for any external agent (Claude Code,
Codex, Flowed): a files-only `local_generate` version is ~a day, and the full-parity
`ExternalAgent` tier (job tools + discovery file) is the one M in this wave.

**Wave 2 — edit-pipeline reliability (M):** 4 first (fuzzy match + failure logging + e2e
tests), then 7 (batched `edit_files` with one transaction), then 6 if still wanted —
note the app's existing undo-based safety model already covers most of 6's motivation.

**Wave 3 — history surfaces (M):** 11 (text-diff v1 from the Time Machine popover), then
9 (named room checkpoints on `vacuum_into`).

**Wave 4 — big bets (L):** 2 (workflows + scheduler; scope v1 to a form-based builder,
NOT a node canvas) and 3 (voice; ship the DSP MVP before deciding on neural TTS).

---

## Idea 1 — External-Agent Parity via the Leash · mostly-exists · M

*(Scope clarified 2026-07-18: the goal is that any external agent — Claude Code, Codex,
Flowed — can do EVERYTHING the in-room agent can do, including the heavy workflows like
analyzing a huge PDF. Not just file access.)*

**Already shipped:** the persistent room MCP server ("the Leash", D9) — token-guarded
loopback streamable-HTTP JSON-RPC ([room_mcp.rs:120-153](../src-tauri/src/room_mcp.rs),
authorize :234, dispatch :259), user-togglable per room and auto-restarting on unlock
([server.rs:44](../src-tauri/src/commands/moonshot/server.rs)), with ready-to-paste
mcp-config JSON in Settings. Crucially, **the "complex workflow" capabilities already
exist as agent tools**: `start_file_pass` + `job_status`
(`job_tools_specs`, agent.rs:923) run the checkpointed windowed map/fold/reduce over a
whole huge file (ADD-32) with resume and progress — exactly the "analyze some huge PDF"
case — and the start-then-poll shape is already right for an external MCP client.

**The real gap is the trust model, not the tools.** `ToolScope`
(room_mcp.rs:34-48) has exactly two tiers: `CloudAdvisor` (built-in file tools only —
what the Leash serves external clients today) and `LocalEngine` (file + UI + job tools —
reserved for the Python sidecar bridge). An external agent the *user configured* is
currently lumped into the same tier as a cloud CLI the *app spawns*, and the module doc
explicitly (and rightly) says "do not widen the cloud scope" — so parity means a **third
tier**, not loosening `CloudAdvisor`.

**Build (M):**
1. `ToolScope::ExternalAgent` — built-in file tools + job tools + room MCP passthrough +
   the new `local_generate`; still NEVER `consult_advisor` (keeps the cloud-recursion
   path closed for every scope) and UI/perception tools excluded by default (an external
   agent driving Private Room's screen is its own decision — sub-toggle if ever wanted).
   Both advertise-time and call-time guards (`served_tools`, `tool_call` :361) pick this
   up automatically since they share one scope check. The Leash toggle in Settings grows
   a tier choice: "Files only" / "Full access".
2. `local_generate` tool wrapping `ollama::generate` (ollama.rs:390) /
   `chat_structured` (:302) so external agents can run local-model inference for
   privacy-sensitive steps.
3. Config-staleness fix: fixed-port option or a discovery file
   (`~/.private-room/leash.json`) so the pasted Codex/Claude Code config survives app
   restarts — without this the feature demos well and annoys daily.

**Risks:** the one-heavy-job-at-a-time guard means an external `start_file_pass` while a
user summary runs returns an error (acceptable — agents can react and retry; idea 2's
queue would erase it). Local 4B on the serial LocalLlm lane means an external file_pass
contends with interactive chat for the single model slot. The full tier is a real
security-boundary change: keep it per-room opt-in with an explicit tier label, and decide
whether it resets to files-only on restart like the cloud sub-option does (recommend:
persist — the Leash is loopback + bearer token, and the user explicitly configured the
client). Effects sink: cloud scope passes `None` today; job tools don't need it, but
verify no downstream reader assumes a sink for job progress.

## Idea 2 — LLM Graph Workflows + Scheduler · partial · L→XL (flagship)

*(Scope upgraded 2026-07-18: the user wants this sophisticated, big, and polished — a
flagship on-screen surface with great UX/UI, a library of saveable custom workflows, a
visual pipeline rendering that animates during runs, and agent-authoring tools so the
in-room agent can compose and save workflows conversationally. The larger effort is
accepted. Detailed design in the master plan.)*

**Already shipped (the executor):** the jobs engine is a persisted, checkpointed,
resumable DAG runner — `Plan = Vec<Step>` with `depends_on` edges, a pure unit-tested
wave scheduler with per-lane concurrency (`plan_dispatch`,
[jobs.rs:61](../src-tauri/src/commands/jobs.rs); lanes :33-40), a pausable
restart-surviving driver (`run_plan` :121), persistence + per-step artifacts
([db/jobs.rs:51-175](../src-tauri/src/db/jobs.rs)), stale-job quiescing, sidebar progress
cards, and agent-initiated starts (`start_file_pass`/`job_status`, local-only trust scope).
`file_pass` proves the whole pattern end-to-end. The sidecar exposes every AI capability
as a stateless HTTP endpoint (`/generate`, `/generate_stream`, `/run`, `/studio`, …) that
workflow nodes can call.

**What must be built:**
1. **Definition format + generic executor.** A `workflows` table storing JSON
   (typed nodes from a curated palette — generate / summarize / file-pass / studio /
   agent-run / save-file — plus edges and simple output-predicate conditions), compiled
   into a Step plan under a new job kind, with a generic `execute_workflow_step`
   dispatching to sidecar endpoints (model: `build_pass_steps` in
   [file_pass.rs](../src-tauri/src/commands/jobs/file_pass.rs)). Today every job kind
   hard-codes its execute closure — the registry is new.
2. **Conditional flow — the riskiest piece.** `run_plan` only gates on dependencies, and
   its resume invariant (cursor = done-step count in topo order, jobs.rs:135-163) breaks
   under skips. v1: condition steps mark their untaken branch skipped-done.
3. **Scheduler — nothing cron-like exists anywhere in src-tauri** (verified; only the
   embedding-backfill poller and Ollama health watcher loop on timers). Add a `schedules`
   table + a generation-pinned tokio tick (pattern:
   [backfill.rs:105-122](../src-tauri/src/commands/retrieval/backfill.rs)) with
   interval/daily/weekly presets and explicit catch-up semantics.
4. **The dedicated page** (per the requirement: not in Settings). Cheap: there's no
   router — the precedent for a full-pane non-file page is FrontPage/Room-map inside
   ViewerPane ([ViewerPane.tsx:46-52](../src/workspace/ViewerPane.tsx)); add a
   `showWorkflows`-style view flag + Sidebar entry listing workflows, schedules,
   next-run, and run history.

**Honest constraints to communicate:** rooms are encrypted SQLCipher — schedules can only
fire while the app is running AND the room unlocked. "Cron" really means *runs when due
while open; catches up on unlock*. The one-job-at-a-time guard (jobs.rs:443/489/614) must
become a queue or scheduled runs will silently collide with summaries. Keep the v1 editor
form-based — a drag-and-drop node canvas alone pushes this to XL. Do NOT dynamically
compose LangGraph graphs in the sidecar: durability and the DB live in Rust; the sidecar's
stateless endpoints are the node primitives.

## Idea 3 — Custom Supernatural Voice · partial · L (M for a strong MVP)

**Exists:** the listening half (whisper dictation into the composer,
[stt.rs](../src-tauri/src/stt.rs), ComposerPane) and the playback substrate (`<audio>` in
AudioView with the WKWebView workaround already solved; Web Audio API in liveRec.ts).
**Zero TTS anywhere** — the podcast studio ships scripts only (verified).

**Recommended MVP (M):** a Rust `speak_text` command on AVSpeechSynthesizer (via
objc2-avf-audio; the objc2 pattern is established in Cargo.toml), with each supernatural
archetype implemented as a **Web Audio DSP preset at playback**: demon = pitch-down +
WaveShaper distortion + convolution reverb; ghost/wraith = whisper-rate + long reverb +
slow chorus; ancient entity = layered detuned copies. Fully local, no model downloads,
user-customizable (expose the DSP parameters as sliders). Add a play/auto-speak toggle
per assistant message in ChatPane, with sentence-chunked synthesis so audio starts before
the full response lands.

**The neural-TTS tier (L) has real traps:** Piper needs espeak-ng phonemization — GPLv3,
likely unusable here; tract-onnx is explicitly validated only for TitaNet (Cargo.toml
warns against swapping in ort), so any ONNX voice model needs its own validation; Kokoro
in the sidecar bloats the signed PyInstaller bundle. Decide after the DSP MVP proves the
feature. Other risks: base AVSpeech voices sound like Siri (the illusion lives or dies on
DSP sound design), and WKWebView autoplay policy may require a prior user gesture.

## Idea 4 — Edit Tool Reliability · partial · M

**Diagnosis (verified):** `edit_file` is Rust-only
([agent.rs:1379-1439](../src-tauri/src/commands/agent.rs)) — the sidecar just relays — so
all fixes land in one place. Matching is **exact-substring, replaces ALL occurrences, no
normalization**: failures are almost certainly whitespace/curly-quote/NBSP drift between
extracted text (what the model saw) and raw bytes, plus docx edits crossing run splits.
Failure handling is better than assumed: ADD-22's `closest_snippet` (:39-67) quotes the
nearest real passage back in the error, and the sidecar permits exactly one retry
(graph.py:297-299). But **nothing is logged anywhere** — failure rates are unknowable.

**Build:** (a) fuzzy fallback in the :1406-1421 text branch — "normalized match found
exactly once → replace that exact byte span" (closest_snippet already computes aligned
byte spans), plus a uniqueness guard fixing the silent replace-all footgun; a separate
run-split-aware pass for docx. (b) Failure logging at the `exec_tool` dispatch or bridge
`tool_call` (room_mcp.rs:429) — per-room counters or outcome on the saved message;
content-free or inside the encrypted DB only. (c) e2e self-tests of `edit_file` through
`exec_tool` over `open_in_memory_schema` with curly-quote/NBSP/CRLF fixtures.

**Hard rule:** fuzzy must never edit the wrong span — require uniqueness or fail with the
hint. This is also the prerequisite for idea 7.

## Idea 5 — Persistent Working Memory · mostly-exists · S

**Verified as shipped end-to-end within a room:** memories persist in the SQLCipher DB,
are relevance-selected under a 1500-char budget and injected into every prompt
(agent.rs:605-617), and have four write paths — Library CRUD, `#remember`, the agent's
`add_memory` tool, and the D6 post-exchange suggestion chip. Remaining work is polish:
opt-in auto-save, memory categories column, a first-class panel. **Cross-room memory is
the only real build hiding here and it contradicts the room-as-portable-encrypted-file
model** — scope it out or treat it as its own architectural decision. If the pitch means
per-room memory: it exists; polish and market it.

## Idea 6 — Diff Preview Before Editing · partial · M

**Context that reframes the idea:** the current safety model is the inverse — edits apply
instantly, every write auto-snapshots (files.rs:319-332), and each answer has one-click
Undo (ChatPane.tsx:356-366). The regret-edit risk is already mitigated post-hoc.

**If built anyway, everything is on the shelf:** all engines funnel through one
`exec_tool` dispatch (single gate covers sidecar, cloud, advisors);
`mcp_call_approved` ([mcp_cmds.rs:247-309](../src-tauri/src/commands/mcp_cmds.rs)) is a
copy-paste template for await-user-decision plumbing with its Overlays.tsx approval card
(including the `data-agent-blocked` guard so the UI-driving agent can't approve its own
edit); Monaco DiffEditor is already bundled for a rich preview. **Engineering care:** the
edit arms hold a `std::sync::Mutex` room lock (agent.rs:1386) that cannot be held across
an await — approval must run before acquiring the guard (or lock-read / await / lock-apply
with staleness re-check). Decide approval cadence (per-turn approve-all / per-room
setting / session "always allow") or agent runs become click-fests.

## Idea 7 — Multi-File Atomic Operations · new-build · M

**No mechanism exists, but the substrate is unusually good:** every mutation funnels
through `store_file_bytes` (files.rs:323) which snapshots before overwriting; all writes
share one mutex-guarded connection; and `restore_file_version`
([safety.rs:19-49](../src-tauri/src/commands/safety.rs)) is the in-repo BEGIN
IMMEDIATE/COMMIT/ROLLBACK precedent. Wrapping N `store_file_bytes` calls in one such
transaction gives genuine all-or-nothing semantics — snapshots, content, and FTS rebuilds
roll back together.

**Design constraint:** do NOT ship begin/commit as separate agent tools — an open
transaction across model rounds wedges the shared connection. Ship a single batched
`edit_files([{name, old_text, new_text}, …])` tool following `set_cells`'
validate-everything-up-front-then-write shape (agent.rs:1464-1515). Validate every match
before the first write. Group-undo comes almost free by tagging batch snapshots with a
shared cause id. **Depends on idea 4's match reliability landing first.**

## Idea 8 — Smart File Indexing · mostly-exists · S

**Verified as shipped:** per-file AI descriptions exist (`files.ai_summary`, filled by
`summarize_room`, the resumable `deep_summary` job, opportunistic post-STT fill,
invalidated on edit), and the agent already answers "what's in here" via
`list_room_files` (returns every file with its cached one-liner) plus the Room
summary.html page. Chunk-level hybrid RAG (FTS5 + embeddings, RRF) is a separate shipped
layer. **The gap is purely triggering:** hook file import to enqueue/extend the existing
deep_summary job (it already has skip-cached + resume-cursor logic). Optionally raise the
200-char one-liner cap. Use the job machinery, not inline calls — a 200-file drop on a
local 4B model would queue-storm otherwise. Frame as "always-on indexing."

## Idea 9 — Version Snapshots (room checkpoints) · partial · M

**Shipped:** per-file versioning with Time Machine UI and transactional, itself-undoable
restore (ADD-2). **Missing:** whole-room named checkpoints — but the hard primitive
exists: `vacuum_into` ([versions.rs:294-298](../src-tauri/src/db/versions.rs)) produces a
consistent encrypted copy keeping the current key, already used by duplicate-room.

**Build:** `<room>.checkpoints/` beside the room file + a manifest (name/date/size,
following the `.recovery` sidecar pattern), create = `vacuum_into`, rollback = close
connection → swap file (keep a before-rollback safety copy) → reopen same password. UI
cribs the Time Machine panel. **Edges that make it M:** block/cancel running jobs during
rollback (job pin/cancel machinery exists, must be wired); disk growth warning (a
checkpoint is a full DB copy incl. blobs/recordings); the registry can't live only inside
the DB being rolled back. **Naming trap:** `src-tauri/src/snapshot.rs` is webview
screenshot capture (ADD-25), totally unrelated — pick a different module name.

## Idea 10 — Scratch Pad File · mostly-exists · S

The cheapest idea on the list. Every primitive is shipped: files as DB rows, `create_note`
(docs_html.rs:17-23), user editing in Monaco with Cmd+S, agent write tools, and
auto-versioning on every overwrite from either side (so the pad gets Time Machine undo for
free). Build is a convention layer copied from the Room-summary pattern
(`SUMMARY_FILE_NAME` + `is_summary_file`): a canonical `Scratch pad.md` with get-or-create,
a pinned UI button, and one system-prompt line telling the agent it exists. **Two
decisions:** concurrent-edit policy when the agent writes while the user has a dirty
Monaco buffer; and do NOT inject pad content into every prompt — mention its existence and
let the agent `open_file` it (memory-style user-message injection if ever needed, to keep
the byte-stable system-prompt caveat intact).

## Idea 11 — Side-by-Side Compare View · partial · M

**Shipped:** compound version snapshots with cause labels + the Time Machine popover with
restore. **Missing exactly two things:** (1) a read-version-without-restoring command —
trivial, `db::get_version` (versions.rs:58-68) already returns the full snapshot and only
restore calls it today; (2) the compare surface — v1 is a house-pattern modal hosting
Monaco DiffEditor over **extracted text**, which works for every file type because
snapshots always carry extracted text, with the entry point as a "Compare" action beside
each Time Machine row (ViewerPane.tsx:92-154). **Scope guard:** true visual two-up for
pdf/docx/sheet mounts two viewer instances (mechanically possible, ViewerRouter viewers
are props-driven) but doubles viewer memory and drifts to L — defer. Watch: pre-compound
versions carry NULL text (reuse the restore fallback, safety.rs:28-31); only 10 versions
kept, which users will notice once compare makes history visible; RTL/bidi care for
Hebrew text in side-by-side.

## Idea 12 — Voice (style) Toggle · mostly-exists · S

The mechanism is shipped: per-room `custom_instructions` read at agent.rs:372, injected
into the system prompt at :583-590, with a working Settings textarea (BehaviorSection).
The system prompt is assembled in Rust and forwarded verbatim by the sidecar — **zero
sidecar changes.** Build: a `response_style` settings key (terse-technical / friendly /
formal / default) as a segmented control above the free-text box, appending a canned
paragraph alongside (not replacing) custom instructions. Keep it a separate key so user
text survives preset switches. It's naturally per-room (settings live in the room DB).
Tune preset wording on the actual qwen3.5:4b — it follows style instructions loosely.
Define precedence: free text wins.

---

*Process note: triage ran as a 10-agent workflow (5 investigators + 5 verifiers,
~1.1M tokens); a mid-run network outage killed 5 agents on the first attempt and the run
was resumed from cache. Full structured findings: session scratchpad `triage-results.json`.*
