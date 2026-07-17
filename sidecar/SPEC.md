# Private Room — Python/LangGraph Agent Sidecar SPEC

This is the authoritative behavioural spec for the Python sidecar that replaces the
native Rust `agent_loop` (`src-tauri/src/commands/agent.rs:1206`). The sidecar is the
"agent brain" only. **All tools, all DB access, all decryption, and all streaming to
the UI stay in the Rust host.** The sidecar never touches the room database, never
sees the encryption key, and never opens a file.

## 1. Architecture

```
Frontend --invoke ask()--> Rust host
                             |- gather_context_and_save_question()   (Rust)
                             |- stream_answer():
                             |     engine = "native"    -> agent_loop        (Rust, fallback)
                             |     engine = "langgraph" -> sidecar (HTTP)    (Python)
                             |         <-- NDJSON events --
                             |     Rust translates events -> ask-delta / ask-step / ask-round
                             |- persist_assistant_reply()             (Rust)
                             |
                             +-- exec_tool  <---- room_mcp bridge (loopback HTTP JSON-RPC + Bearer)
```

The sidecar calls tools **back into the Rust host** over the existing room MCP bridge.
It is a *local, trusted* process — not a cloud client.

## 2. The room MCP bridge protocol (already implemented in Rust)

`src-tauri/src/room_mcp.rs`. Loopback only, ephemeral port, per-run bearer token.

- `POST http://127.0.0.1:{port}/mcp`
- Header: `Authorization: Bearer {token}`
- Body: JSON-RPC 2.0. Methods:
  - `initialize` -> `{protocolVersion, capabilities:{tools:{}}, serverInfo:{...}}`
  - `ping` -> `{}`
  - `tools/list` -> `{"tools": [{name, description, inputSchema}, ...]}`
  - `tools/call` params `{name, arguments}` -> `{"content":[{"type":"text","text":...}], "isError": bool}`
- A JSON-RPC request without `id` is a notification -> HTTP 202, empty body.
- Tool errors come back as `isError: true` results (NOT JSON-RPC errors). The model
  must be able to see and react to them.

### 2.1 IMPORTANT — the trust-scope gap (must be honoured)

The bridge today serves ONLY `tools_catalog(web_enabled)`. It deliberately does **not**
serve:
- the UI/perception tools (`ui_snapshot`, `ui_act`, `view_screenshot`, `view_media_frame`)
- the job tools (`start_file_pass`, `job_status`)
- `consult_advisor` (never — closes the recursion path)

That exclusion is a **security guard against a *cloud* client** (see the doc comments at
`agent.rs:801` and `room_mcp.rs:201`): a cloud CLI must not be able to drive the user's
app or start hours of local compute.

The sidecar is local and trusted, so the Rust host serves it a **wider scope**. The host
passes a scope to the bridge:
- `ToolScope::CloudAdvisor` — current behaviour (builtins only; no ui/job/advisor).
- `ToolScope::LocalEngine` — builtins + ui tools + job tools (still **never**
  `consult_advisor`, so recursion stays closed).

The sidecar simply calls `tools/list` and uses whatever it is served. It must NOT
hardcode the tool list. `consult_advisor` must never appear; if it ever does, ignore it.

## 3. Behaviour to replicate EXACTLY (from `agent_loop`)

### 3.1 Deterministic tool routing (NOT model-driven)

Three keyword routers decide which tool subsets are offered. They are case-insensitive
substring matches on the raw user question. Erring toward YES is safe.

- `wants_write_tools(q)` gates the write tools. If FALSE, remove these from the catalog:
  `create_file, edit_file, write_file, set_cells, rename_file, move_file, add_memory`
  (`WRITE_TOOL_NAMES`). Note `annotate_file`/`mark_image` are NOT in that list.
- `wants_ui_tools(q)` gates the UI tools AND appends the UI system-prompt paragraph.
- `wants_job_tools(q)` gates the job tools AND appends the job system-prompt paragraph.

The exact hint lists are in `agent.rs` (`wants_write_tools:751`, `wants_ui_tools:767`,
`wants_job_tools:788`) and MUST be ported verbatim — they are product behaviour. The Rust
host passes the already-computed routing decisions to the sidecar (see §5) so the two
engines can never drift; the sidecar ALSO implements them locally for offline/testing and
must agree.

### 3.2 The round loop

```
max_rounds = 4  if (no mcp routes AND not web AND no advisors AND not ui AND not jobs)
             else MAX_TOOL_ROUNDS

for round in 0..max_rounds:
    if cancelled: break
    last = (round + 1 == max_rounds) or force_synthesis
    trim_messages_to_budget(messages, tools_chars)
    emit "round"                       # frontend clears live text
    offered = []  if last else tools   # tool-less final round forces a grounded answer
    (content, calls) = chat(model, messages, offered, streaming deltas)
    if calls is empty or cancelled or last:
        final_text = content; break
    push assistant message (content + tool_calls)
    near_budget = (round + 2 >= max_rounds)
    all_dup = True
    for call in calls:
        if cancelled: break
        key = (call.name, canonical_json(call.arguments))
        if key in seen:
            push tool message: "Duplicate call: you already ran {name} with these exact
              arguments this turn; the result is above. Use it, or call with different
              arguments."
            continue
        all_dup = False
        emit "step" tool_step_label(name)
        result = exec_tool(call)        # -> via MCP bridge
        emit "step-status" {ok: bool}
        if ok: seen.add(key)            # only SUCCESSFUL calls are remembered,
        else:  result = "Tool error: {e}"   # so a failed one may retry once
        if near_budget:
            result += "\n[Note: tool budget nearly exhausted — answer the user in your
                       next reply.]"
        push tool message(result, tool_name=name)
        if pending_images:              # a perception tool captured pixels
            push USER message with images and the text:
              "[The capture you requested is attached. Look at it, then continue —
                answer the user or take the next action.]"
            # Ollama reads images from user turns, not tool turns.
    if all_dup: force_synthesis = True  # model is looping -> force tool-less synthesis
    final_text = content

if final_text is blank and not cancelled: final_text = "Done."
```

Critical invariants (each has a test):
- The **final round is always tool-less** (`offered = []`), so the loop always ends with
  a text answer grounded in prior tool results rather than an unread side-effect call.
- **Only successful calls enter `seen`** — a failed call may be retried once.
- An **all-duplicate round sets `force_synthesis`**, ending the loop next round.
- Cancellation is checked between rounds AND between tool calls.
- Blank final text becomes `"Done."` — but NOT when cancelled (never invent "Done." over
  an answer the user stopped).

### 3.3 `trim_messages_to_budget(messages, tools_chars)`

- `msg_len(m) = len(m.content) + len(json(m.tool_calls) if present else "")`
- `total = tools_chars + sum(msg_len)`
- If `total <= CTX_CHAR_BUDGET`: return unchanged.
- Otherwise stub older **tool** messages whose content is > 80 chars, replacing content
  with `"[{tool_name} result trimmed to fit context — already used above]"`, subtracting
  the saved chars from `over`, until `over` reaches 0.
- **Never** stub index 0 (the system message) nor the most recent 4 messages.

### 3.4 `tool_step_label(name)`

Exact map (see `agent.rs:1172`). Unknown names -> `"Ran the {name} tool"`.

## 4. Streaming protocol (sidecar -> Rust host)

`POST /run` on the sidecar returns `application/x-ndjson`, one JSON object per line.
The Rust host translates each to the existing Tauri events, so the **frontend contract is
unchanged**:

| sidecar event            | Rust emits         |
|--------------------------|--------------------|
| `{"t":"lane","v":str}`   | `ask-lane`         |
| `{"t":"round"}`          | `ask-round`        |
| `{"t":"delta","v":str}`  | `ask-delta`        |
| `{"t":"step","v":str}`   | `ask-step`         |
| `{"t":"step_status","ok":bool}` | `ask-step-status` |
| `{"t":"final","v":str}`  | (return value)     |
| `{"t":"error","v":str}`  | (Err -> fallback)  |

## 5. Sidecar HTTP API

- `GET /health` -> `{"ok": true, "version": "..."}` — used by the Rust lifecycle manager.
- `POST /run` -> NDJSON stream. Body:

```json
{
  "model": "qwen3.5:9b",
  "question": "the raw user question",
  "messages": [{"role":"system","content":"..."}, {"role":"user","content":"..."}],
  "temperature": 0.7,
  "ollama_base_url": "http://127.0.0.1:11434",
  "mcp": {"url": "http://127.0.0.1:53421/mcp", "token": "..."},
  "routing": {"write": true, "ui": false, "jobs": false},
  "web_enabled": false,
  "max_rounds": 24,
  "run_id": "uuid"
}
```

- `POST /cancel` body `{"run_id": "..."}` -> cancels that run (the loop checks between
  rounds and between tool calls).

## 6. Privacy — HARD REQUIREMENTS

This product's entire promise is that nothing leaves the Mac.

- Bind **127.0.0.1 only**. Never 0.0.0.0.
- `LANGCHAIN_TRACING_V2`, `LANGSMITH_*`, `LANGCHAIN_API_KEY` must be forcibly disabled at
  import time (delete from `os.environ`) — LangSmith tracing would exfiltrate room content.
- No telemetry, no analytics, no outbound network except: the Ollama base URL and the
  loopback MCP bridge. There must be a test asserting this.
- The sidecar never logs message content at INFO or above.

## 7. Tests (pytest)

Every invariant above has a test. Mock the Ollama chat model and the MCP bridge; no
network, no real model. Cover at minimum:
- routing (write/ui/jobs) incl. verbatim hint-list parity with the Rust lists
- write-tool filtering when `wants_write_tools` is false
- the tool-less final round
- duplicate-call suppression + the exact duplicate message text
- failed calls are NOT memoised (retry allowed)
- all-duplicate round -> forced synthesis
- `near_budget` note injection
- `trim_messages_to_budget`: no-op under budget; stubs old tool msgs; never stubs system
  or last 4
- pending images become a USER message
- cancellation between rounds and between tool calls
- blank final -> "Done."; blank + cancelled -> stays blank
- `tool_step_label` mapping incl. the unknown-name fallback
- MCP client: `tools/list`, `tools/call`, `isError` handling, bearer auth, notification
  (no-id) handling
- the NDJSON streaming event sequence
- privacy: tracing env vars are cleared; bind address is loopback
