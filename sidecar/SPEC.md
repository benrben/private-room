# Arcelle — Python/LangGraph Agent Sidecar SPEC

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

The bridge catalog is scoped by the Rust host. `ToolScope::LocalEngine` includes
local UI/job capabilities, while consulted-advisor and persistent external scopes
remain restricted. `consult_advisor` is not granted by any base scope: Rust
attaches it through a per-turn `AdvisorRuntime` only for an enabled **top-level**
model turn.

Owner decision 2026-07-25: a cloud CLI chosen as the room's OWN engine gets
`ToolScope::CloudEngine` — the local tier minus the UI/screen tools, so
jobs, workflows, scripts, studio, transcription and connector management all
work on a Claude/Codex room. It is a distinct variant precisely because the same
bridge serves *consulted* advisors, which must stay narrow.

This separation lets Ollama, API-provider, and primary Claude/Codex models use an
advisor without opening recursion. A consulted advisor receives a distinct
`ToolScope::CloudAdvisor` bridge with no `AdvisorRuntime`, so its `tools/list`
cannot contain `consult_advisor` even if it fabricates a call.

The sidecar calls `tools/list` and uses whatever the host serves. It does not
hardcode the catalog; it only drops `consult_advisor` when the `/run` request has
no enabled advisor list, providing a second settings gate.

## 3. Behaviour to replicate EXACTLY (from `agent_loop`)

### 3.1 Deterministic tool routing (NOT model-driven)

Keyword routers decide which tool subsets are offered. They are case-insensitive
substring matches (hint lists include Hebrew stems). Erring toward YES is safe.

- The WRITE tools (`create_file, edit_file, edit_files, write_file, set_cells,
  rename_file, move_file, add_memory` — `WRITE_TOOL_NAMES`) are ALWAYS offered
  (2026-07-23): the base system prompt teaches them by name every turn, so the
  catalog must agree. `wants_write_tools(q)` now feeds only the lane label.
  Note `annotate_file`/`mark_image` are not write tools either — always offered.
- `wants_ui_tools(q)` gates the UI tools AND appends the UI system-prompt paragraph.
- `wants_job_tools(q)` gates the job tools AND appends the job system-prompt paragraph.
- Lanes LATCH per conversation: the host ORs each router over the chat's prior
  user turns (`sidecar.rs sticky_lanes`, excluding the composed final message),
  so a follow-up phrased without a keyword keeps the tools a prior turn opened.
  The booleans reach the sidecar as PRIORS for its manager (below).
- **The agentic hub (2026-07-23 v3, owner decisions):** the MAIN AGENT
  (`chat.answer`, `AgentSpec.main`) is the user's single interlocutor and the
  ONLY model that decides delegation. Its tool catalog is its specialists —
  the `ask_*_agent` domain tools (agents.py `AGENT_TOOL_DOMAINS`, ≤6 entries;
  unreachable domains are dropped per scope). It calls as many specialists as
  the request needs, one at a time locally (a later delegation is PENDING
  until the current one finishes), and answers directly what it knows
  (greetings, general knowledge). Each `ask_*_agent` call is intercepted in
  `execute_tools` (never sent to the bridge): `manager.resolve_worker` picks
  the concrete registry worker inside the domain by instruction vocabulary,
  the worker runs its OWN loop with CORE + its ≤6-tool box against the
  original conversation plus a `delegation_note` (which carries the referent
  baton — what earlier specialists produced), and only its REPORT returns to
  the main thread. A hub guard rejects any direct room-tool call from the
  main agent before it reaches the bridge. Delegation is NOT capped by count —
  `MAX_WORKER_CALLS` was deleted with the rest of the per-agent budgets. The
  bound is `config.TURN_ROUND_BUDGET` (64): a whole-ask ceiling on model
  rounds, spent by every loop in the tree through `Deps.spend_round`, because
  `max_rounds` bounds ONE loop and every delegated child starts a fresh one at
  round 0. Exhausting it aborts nothing — every remaining round is served
  tool-less, so each live loop unwinds into a text answer and the user is told
  once (`ROUND_BUDGET_STEP`). Measured 2026-07-27, before it existed: a Main
  agent starved of history spent 32 rounds and 890 s across 16 delegations and
  answered "not included in this room's content".
  The `plan` event carries the GROWING pipeline roster
  (invoked workers in call order, Main agent always last) and `agent` events
  mark the active entry, so the UI renders e.g. File agent → Main agent live;
  the queue-jump guard still withholds the connector proxy pair from workers
  that don't own it. One `final` event per ask — the Main agent's own words.
- `request_tools` escape hatch: when a served group is locked, the sidecar
  offers a local mini-tool that unlocks it mid-turn (graph.py `_unlock_group`,
  groups = agents.py `GROUPS`); the system prompt names locked groups via
  `TOOL_GROUPS_PROMPT` so the model keeps a stable self-image without unseen
  schemas.

The exact hint lists are in `agent.rs` (`wants_write_tools:751`, `wants_ui_tools:767`,
`wants_job_tools:788`) and MUST be ported verbatim — they are product behaviour. The Rust
host passes the already-computed routing decisions to the sidecar (see §5) so the two
engines can never drift; the sidecar ALSO implements them locally for offline/testing and
must agree.

Small-local mode (plain Ollama model — no API provider, no `:cloud`): each round
executes at most ONE tool call, and the turn's verified action log is re-injected
each round as an ephemeral system note (`turn_progress_note`). Evidence base:
pm-request/small-model-agent-reliability-2026-07-23.md.

### 3.2 The round loop

```
max_rounds = agents.budget_for(agent_id, run_max)   # the agent's own flow.act_rounds,
                                                   # floored by the request ceiling
                                                   # (AGENT_ROUND_BACKSTOP if unset)

for round in 0..max_rounds:
    if cancelled: break
    last = (round + 1 == max_rounds) or force_synthesis
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

### 3.3 Fitting the window

The host hands over the WHOLE conversation (`commands::HISTORY_HANDOFF_MAX`, 200 KB) and
the sidecar makes it fit. It used to hand over a window-derived slice; measured
2026-07-28, cutting there cost the model 0.44 of the facts it needed (4/4 paired losses)
and nothing downstream can restore what was already amputated.

1. `compaction.compact_to_budget` — **compress, don't amputate**, in place of step 3 when
   a payload cannot fit. The system message leads and the recent tail stays verbatim;
   everything between becomes one `user` message of extracted facts, chunk-digested and
   cached by content hash. The trailing partial chunk is left verbatim on purpose: it is
   the only one whose contents shift as a turn grows, so digesting it would miss the
   cache every round at a full model call each time.

   **A safety valve, not a policy** — `SPEND_FRACTION` is 0.9, so an ordinary turn is
   sent verbatim. Compaction beat TRUNCATION decisively at the same budget (0.44 vs 0.25
   on a 2B, 1.00 vs 0.25 on a large model), which is why it exists; but measured end to
   end against not compacting at all, verbatim beat compacted 0.38 to 0.19 (n=4, paired
   1 win / 1 loss / 2 ties — no evidence of benefit once the payload already fits).
   Wired and tested on every engine, local and cloud; `CLOUD_SPEND_FRACTION` stays at 0.9
   until there is a cloud e2e arm, because the only end-to-end evidence is local.
   A failed digest, or an engine whose window nobody stated, means no change at all.
2. `model_limits.pick_num_ctx(payload_bytes, native_ctx)` — smallest bucket of
   `(8k, 16k, 32k, 64k, 128k)` that fits the payload plus generation headroom, clamped by
   RAM (`max_num_ctx()`: 128k on a 32 GB+ Mac, else 64k) and by the model's own native
   window. Every local call sends one; `None` only for non-local models. The daemon's
   answer to an oversized prompt is to silently context-shift the FRONT of it away — the
   system prompt, the tool doctrine and the question — which is what this prevents.
3. `budget.trim_messages_to_window(messages, reserved_bytes, num_ctx)` — the last resort,
   when the payload still exceeds the window that was requested. `None` num_ctx is a
   no-op, so a non-local model is never truncated. Two passes over `role: "tool"` content
   only, never the system message and never a user/assistant turn:
   - **stub** older results (before the last 4 messages) whose content is > 80 bytes;
   - **truncate** the survivors, newest included, to an equal share of the remaining
     budget, keeping each one's HEAD.
   Every cut leaves a marker, so a short answer is explainable in the transcript.

Bytes-per-token is **measured, not assumed**: `model_limits.observe_token_ratio` feeds the
engine's own `prompt_eval_count` back into an EWMA that `pick_num_ctx` and
`window_budget_bytes` both consult. The flat 3 B/token they shared was measured at 51% of
the true ratio for English prose and 121% for a number-dense turn — wrong in both
directions, and a constant cannot be right for that spread. Clamped to
`[BYTES_PER_TOKEN, 6.0]` with a 0.85 safety factor, so it can only ever grant more context
than the constant did, never less.

### 3.4 `tool_step_label(name)`

Exact map in `labels.py` — the ONLY step-label table in the product since the native
agent loop (and its own `tool_step_label`) was deleted in 14111c6. Unknown names ->
`"Ran the {name} tool"`, which is how every connected MCP tool arrives (namespaced
`server_tool`) and must stay unenumerated. `tests/test_labels.py` pins that every
`agents.ALL_REGISTRY_TOOLS` name has a row, so a new tool cannot ship label-less.

## 4. Streaming protocol (sidecar -> Rust host)

`POST /run` on the sidecar returns `application/x-ndjson`, one JSON object per line.
The Rust host translates each to the existing Tauri events, so the **frontend contract is
unchanged**:

| sidecar event            | Rust emits         |
|--------------------------|--------------------|
| `{"t":"plan","v":[{agent,label,instruction,status,batch,key}]}` | `ask-plan` (the agent roster) |
| `{"t":"agent","v":{id,label,step,total,active_steps}}` | `ask-agent` (the active roster entry/entries) |
| `{"t":"lane","v":str}`   | `ask-lane`         |
| `{"t":"round"}`          | `ask-round`        |
| `{"t":"delta","v":str}`  | `ask-delta`        |
| `{"t":"step","v":str,"node":str}` | `ask-step` (as `{label,node}`) |
| `{"t":"step_status","ok":bool,"node":str}` | `ask-step-status` |
| `{"t":"final","v":str}`  | (return value)     |
| `{"t":"error","v":str}`  | (Err -> fallback)  |

`plan` fires for every ask (single-step turns get a 1-item roster) so the chat
UI always shows WHO is handling the ask.

**Every `plan` is a COMPLETE snapshot, not a delta.** Since delegations in one
round run in parallel, a single active marker cannot describe the turn — three
children can be running at once and finish in any order. So each entry carries
its own `status` (`pending` | `running` | `done` | `failed`), the dispatch round
that sent it (`batch` — entries sharing one were launched TOGETHER, which is
what makes the fan-out legible and is not recoverable by diffing rosters), and a
`key` that addresses the node uniquely (`"main"`, or `"<agent id>#<slot>"`; the
registry id will not do, because one round can dispatch two `files.read`
children). A consumer needs no event ordering and no diffing: the last `plan` it
saw is the whole truth. That matters because children emit concurrently, so the
relative order of their events guarantees nothing.

A `plan`+`agent` pair is emitted when a batch is dispatched, when EACH child
finishes (its own slot flips there, not where the parent collects it — reports
are gathered in call order, so a fast third child would otherwise keep pulsing
until the slow first one returned), and once more when the batch is collected.

`step`/`step_status` carry `node`: the `key` of the loop that emitted them.
Arrival order attributes nothing once siblings interleave, so this stamp is the
only way to file a tool step under the agent that actually ran it.

The legacy single-marker fields (`agent.id`/`label`/`step`/`total`) stay
populated — `step` points at the first still-running child — so the older flat
strip and any other consumer keep working unchanged. The frontend renders the
roster as a hub-and-spoke graph (`src/workspace/AgentGraph.tsx`), falling back
to a single chip when nothing was delegated.

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
- `POST /web_search` body `{"query": "...", "limit": 12}` -> `{"hits": [{"title", "url",
  "source", "date", "score"}, ...]}` — the room's ONE web search provider
  (`websearch.py`): several independent engines queried and fused into a single
  relevance ranking (70% reciprocal-rank fusion across engines + 30% title match).
  The only endpoint here with no model in it. A blocked engine drops out silently, so
  an empty `hits` means "no results", not "a scraper broke". Rust owns the room's
  internet switch (it checks before calling), the 15-minute result cache, and the
  `web_search` tool plumbing; the sidecar owns the engines. There is deliberately no
  `resolve_dates` knob — filling missing dates means fetching each RESULT url from
  Python, around the Rust SSRF guard every other outbound fetch goes through.

## 6. Privacy — HARD REQUIREMENTS

This product's entire promise is that nothing leaves the Mac.

- Bind **127.0.0.1 only**. Never 0.0.0.0.
- `LANGCHAIN_TRACING_V2`, `LANGSMITH_*`, `LANGCHAIN_API_KEY` must be forcibly disabled at
  import time (delete from `os.environ`) — LangSmith tracing would exfiltrate room content.
- No telemetry, no analytics, no outbound network except: the Ollama base URL, the
  loopback MCP bridge, and the two seams that exist in order to leave the Mac — the
  neural-voice synthesiser (`tts.py`) and web search (`websearch.py`). There must be a
  test asserting this, and it must name the allowed hosts rather than waive the check:
  `test_privacy.py` pins web search to its engine list and holds every other module to
  loopback-only, so a new outbound host anywhere else fails the suite.
- Web search reaches the public internet ONLY when the room's internet switch is on.
  Rust checks that before it calls `/web_search`; the sidecar has no copy of the setting
  and must not grow one.
- The sidecar never logs message content at INFO or above.

## 7. Tests (pytest)

Every invariant above has a test. Mock the Ollama chat model and the MCP bridge; no
network, no real model. Cover at minimum:
- routing (write/ui/jobs) incl. verbatim hint-list parity with the Rust lists
- write tools always offered (and the request_tools unlock flow)
- the tool-less final round
- duplicate-call suppression + the exact duplicate message text
- failed calls are NOT memoised (retry allowed)
- all-duplicate round -> forced synthesis
- `near_budget` note injection
- `pick_num_ctx`: bucketed, RAM-clamped, never above the model's native window
- `trim_messages_to_window`: no-op under budget and for non-local models; stubs old tool
  msgs then truncates the survivors; never touches the system message or a user turn
- `compact_to_budget`: system + newest turn survive verbatim, old turns become facts
  rather than disappearing, the input list is not mutated, digests are cached, and a
  failing digest degrades to the trim instead of failing the turn
- `bytes_per_token`: cold start equals the constant, a measured ratio can raise it but
  never lower it, a wild sample cannot move it, and it stays the inverse of
  `window_budget_bytes`
- the turn-wide round budget bounds the whole delegation tree (not one loop), still
  answers when exhausted, and announces itself exactly once
- pending images become a USER message
- cancellation between rounds and between tool calls
- blank final -> "Done."; blank + cancelled -> stays blank
- `tool_step_label` mapping incl. the unknown-name fallback
- MCP client: `tools/list`, `tools/call`, `isError` handling, bearer auth, notification
  (no-id) handling
- the NDJSON streaming event sequence
- privacy: tracing env vars are cleared; bind address is loopback

Context-window sizing (2026-07-23): every LOCAL Ollama call sends an explicit
payload-fitted `num_ctx` (`model_limits.pick_num_ctx` — buckets 8k/16k/32k,
capped at the model's native length). The daemon's own default is a ~4k window
that silently context-shifts the FRONT of an oversized prompt away (system
prompt, question) — the "Done."/garbage live regressions. `:cloud` models send
none (their window is remote). The token bar's `max_context` reports the window
the call actually requested, not the native capability ceiling.

## 8. Live e2e (tests/e2e_live)

Opt-in, real-model, production-turn-shaped: `ARCELLE_E2E=1 uv run pytest
tests/e2e_live -q` (needs Ollama serving `qwen3.5:4b`; override via
`ARCELLE_E2E_MODEL`/`ARCELLE_E2E_OLLAMA`). Guards the class unit tests cannot
see — live QA proved twice that a phrase passing 4/4 in small synthetic turns
can fail 100% inside a production-size turn. Scenarios: both "Done."
regressions, agent roster/active events, compound EN + Hebrew plans with
pending sequential execution, write-verb self-image ("save a note", "save
that" anaphora), tool-grounded room summary. Architecture outcomes (plan
shape, one final) assert strictly; model-choice outcomes sample up to twice
(`run_ask_sampled`).
