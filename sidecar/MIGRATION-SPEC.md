# Migration: all LLM through the Python sidecar (sidecar-only, no fallback)

Decision (user): **every AI feature's logic runs in Python/LangGraph; the sidecar is
the app's SOLE AI service; there is NO native Rust LLM fallback.** Rust's job shrinks
to: gather data from the encrypted SQLCipher DB → call a sidecar endpoint → store the
result. Rust must make **zero direct Ollama HTTP calls** when the migration is done.

The model underneath is still Ollama (local). "Through LangGraph/the sidecar" means all
model I/O and all prompt/orchestration logic live in Python.

## Architecture

```
Rust command (has the DB key)                 Python sidecar (has NO DB key)
  gather text/rows from SQLCipher   --HTTP-->    build prompt, call Ollama via
  store the returned result         <--------    langchain_ollama / ollama client,
                                                 parse, return structured JSON
```

Tool-using AGENT turns already flow through `/run` (the LangGraph graph) + the room MCP
bridge (the sidecar calls back into Rust for file tools). This migration adds the
NON-agent AI features.

## No fallback (user choice)

- Remove the native Rust LLM path. If the sidecar can't start, AI features return a
  clear error (`"AI engine unavailable — the agent sidecar could not start."`), NOT a
  native fallback. `sidecar.rs`'s `SidecarOutcome::Unavailable` should now surface an
  error, not call `answer_locally_native`; the native `agent_loop` and its
  `chat_stream_tools` usage are removed (see "Native agent" below).
- The sidecar must be ensured-up before ANY LLM call. `sidecar_lifecycle::ensure_up()`
  already spawns + health-checks it; call it at the start of every gateway call.

## What stays in Rust (NOT "LLM code")

- `ollama_lifecycle.rs` — spawns/stops the `ollama serve` DAEMON (process management, not
  inference). The sidecar's langchain_ollama needs Ollama running; Rust keeps owning that
  process lifecycle + app-exit teardown. KEEP IT.
- `sidecar_lifecycle.rs`, `room_mcp.rs` — sidecar process + tool bridge. KEEP.
- All DB access, extraction, STT/diarization, web fetch — not LLM. KEEP.
- Pure helpers in `ollama.rs` that are not I/O: `strip_think_spans`, `job_context_chars`,
  `set_base_url_override`/`resolved_base_url` (config the sidecar is told about). KEEP
  these (move to a small `llm_config.rs` if `ollama.rs` is deleted).

## Native agent (`agent_loop`) — removed

With no fallback and app-driving turns unsupported by the sidecar, decide per the user's
"sidecar-only": `stream_answer` routes ALL turns to the sidecar. UI-driving turns
(`wants_ui_tools`) currently need the native perception-image handoff the bridge can't
carry — for this migration, they ALSO go to the sidecar, and the perception tools
(`ui_snapshot`/`view_screenshot`) return their captured image to the sidecar as MCP image
content blocks (extend `room_mcp.rs` `tool_call` to emit image content from
`effects.pending_images`, and the sidecar's `mcp_client`/graph to feed those into the
next model turn as a user image message). If that image-bridge proves too large in one
pass, LEAVE the UI-turn path on the native `agent_loop` and say so explicitly in the
report — but everything else must be sidecar-only.

## PHASE 1 — LLM gateway (foundation). Sequential. Do first.

### Sidecar endpoints (new `privateroom_sidecar/llm.py` + routes in `server.py`)

- `POST /embed` → `{model, texts: [str], base_url, keep_alive?}` → `{embeddings: [[f32]]}`.
  Use the `ollama` python client (`AsyncClient(host=base_url).embed(...)`) — it's a dep.
- `POST /generate` → `{model, messages: [Message], base_url, temperature?, num_ctx?,
  keep_alive?, format?: <json-schema>, images?: [b64]}` → `{text: str}`.
  Non-streaming. When `format` is set, pass it to Ollama as the structured-output grammar
  (langchain_ollama `ChatOllama(format=<schema>)` or the ollama client's `format=`). When
  `images` set, attach them to the last user message (vision). Reuse `OllamaChatModel`
  where possible; add a non-streaming `generate()`.
- `POST /models` → `{base_url}` → `{models: [str]}` (ollama client `list`).
- `POST /warm`, `/pull`, `/capabilities` as thin ollama-client passthroughs (model mgmt).

All keep the SPEC §6 privacy rules (loopback only, tracing env cleared). Add pytest for
each (mock the ollama client / langchain).

### Rust gateway (`ollama.rs` becomes a sidecar proxy)

Keep the SAME public signatures (so all ~22 callers compile unchanged), but the bodies
now POST to the sidecar instead of Ollama:
- `embed(...)` → `sidecar_lifecycle::ensure_up()` then POST `/embed`.
- `chat_structured(...)` → POST `/generate` with the schema (and images if the messages
  carry any). Return the `text`.
- `list_models`/`warm`/`pull`/`capabilities` → the sidecar mgmt endpoints.
- `chat_stream_tools*` — only used by the native `agent_loop`; when that's removed, delete
  these. If the native UI path is retained (see above), keep them pointing at the sidecar
  `/generate` (non-streamed) or leave until Phase 3.
- Remove ALL direct `reqwest` calls to Ollama's `/api/*` from `ollama.rs`. No fallback.
- The Ollama base URL the sidecar should use is passed in each request body
  (`ollama::resolved_base_url()`).

Verify: `PATH=/usr/bin:/opt/homebrew/bin:/bin:/usr/sbin:/sbin cargo test --lib` (0 failed)
and `<venv>/bin/python -m pytest sidecar/tests -q`.

## PHASE 2 — feature logic → Python. Python graphs are PARALLEL-safe; Rust rewiring is SERIAL.

For each feature: move the PROMPT + orchestration into a sidecar endpoint/graph; Rust
gathers the DB text and calls it. Features (Rust file → new sidecar endpoint):

1. `commands/summarize.rs` (map-reduce one-liners + room summary) → `/summarize` graph
   (per-file summary + combine). Rust gathers file texts, posts, stores the summary file.
2. `commands/studios/{flashcards,mindmap,podcast}.rs` + `studios.rs` `run_studio` →
   `/studio` (kind ∈ flashcards|mindmap|podcast) returning the structured cards/nodes/turns
   AND/OR the HTML. Keep HTML rendering in Python or return data and render in Rust —
   pick one, keep behavior.
3. `commands/moonshot/ai_actions.rs` (13 AI actions, memory suggestion, file-meta suggest)
   → `/ai_action` (action id + gathered text) returning the markdown/result.
4. `commands/vision.rs` `locate_in_image` (image grounding boxes) → `/vision_locate`
   (image b64 + query) returning boxes. Uses `/generate` with images + the boxes schema.
5. `commands/jobs/file_pass.rs` (map/merge/compose steps) → `/file_pass_step` endpoints.
6. `commands/chat_commands/{knowledge,generate}.rs` → `/knowledge_extract`, `/generate_doc`.
7. `commands/moonshot/front_page.rs` + `moonshot/graph.rs` AI labeling → `/label` endpoints.
8. `commands/feedback.rs` (GitHub issue draft) → `/feedback_draft`.

Each Python endpoint gets pytest (mock the model). Rust rewiring keeps each command's
external behavior (same stored files, same emitted events, same errors).

## PHASE 3 — verify + build

- `cargo test --lib` green, `pytest` green, `ruff` clean, `tsc` clean.
- Rebuild the sidecar bundle: `./sidecar/build-sidecar.sh`.
- Confirm `grep -rn 'reqwest.*api/' src-tauri/src/ollama.rs` returns NOTHING (no direct
  Ollama I/O left in the gateway).
- Build the app: `PATH=/usr/bin:/opt/homebrew/bin:… npm run tauri build -- --bundles app`.

## Guardrails

- Broken rustup shims: ALWAYS `PATH=/usr/bin:/opt/homebrew/bin:/bin:/usr/sbin:/sbin cargo`.
- Preserve every "why" comment and all privacy/security scoping.
- Keep behavior identical from the user's view (same files created, same events, same
  error surfaces) — only the compute location moves to Python.
- If a feature can't be cleanly ported in one pass, leave it calling the Phase-1 gateway
  (`ollama::chat_structured` → sidecar `/generate`) — that STILL routes its inference
  through Python — and note it as "inference-ported, logic-not-yet-moved" in the report.
