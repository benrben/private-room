# Design Proposal: The Dispatch-First Agent — Arcelle's New Way

**Author:** architect pass over 4 code audits + 4 research reports, 2026-07-23 (rev. 2)
**Thesis in one line:** Arcelle doesn't need a smarter loop; it needs a deterministic front door that pre-digests every request into a structured brief, dispatches the ~80% of turns that are actually closed-form to code, tells the truth about what the local model can see, gives cloud engines a linear read tool, and closes — deterministically — the learning loop that already writes telemetry nobody reads.

---

## 1. Diagnosis — what the audits actually show

### 1.1 The data-path complaint is half right, and right where it hurts

The owner's "file content never really passes through the LLM" is **refuted as a universal claim** — attachment (agent.rs:552, uncapped), `start_file_pass` (32,000-char windows, jobs/file_pass.rs:36 — 100% byte coverage), and summarize's `read_text` paging (up to 64KB windows, summarize.py:50-52) are real whole-file paths. But it is **confirmed for the default interactive experience**, for two precise reasons:

1. **Retrieval keyhole:** an unattached question over a 200KB file injects `MAX_CONTEXT_CHUNKS = 6` (commands.rs:89) × ~1,200-char chunks (db.rs:58 `CHUNK_TARGET_CHARS`) ≈ **7.2KB, ~3.5% of the file**. In-loop, `search_room` returns 4 × `excerpt(…, 800)` = ≤3,200 chars/call (agent.rs:2011-2014) and `open_file` returns a 1,200-byte head (agent.rs:2071). **There is no offset/linear read tool in chat at all** — the model literally cannot page through a room file; the only escape is a minutes-to-hours background job. And these clamps, sized for the 4B, are applied identically to 200K-context cloud engines (model_limits.rs:26-28).
2. **Silent engine-side truncation on the one full path:** the app deliberately omits `num_ctx` (ollama.rs:577) and spawns the daemon with no env overrides (ollama_lifecycle.rs:166), so an attached 200KB file gets silently truncated at Ollama's default ~4K-token window on the local engine. The user attaches a file, believes the model saw it, and it saw ~8%.

The fix is not architectural upheaval, but it is **different per tier**, because the two bottlenecks have different owners:

- **Cloud/CLI tier:** the clamps are the whole problem. Engine-tiered chunk budgets + a `read_text(file, offset, length)` chat tool remove the felt limitation outright — a 200K-context engine can genuinely page through a book.
- **Local tier:** `read_text` does *not* fix it. A 200KB file at a 4,000-char local window means ~50 sequential reads, and the same research this proposal leans on (§1.5) says a 4B cannot sustain goal-directed paging inside a capped loop — it will stop after 2-3 reads and answer confidently from a fragment. The local-tier fix is honesty plus retrieval quality: a RAM-aware `num_ctx` (not a blanket raise — see §2.3), an explicit UI notice when an attachment exceeds the local window ("switch engine or start a full pass") instead of silent truncation, and better chunk selection. The silent truncation is the trust-killer behind the owner's complaint; killing it matters more than raising the ceiling.

Both go in Stage 1, with per-tier success metrics (§5).

### 1.2 The scaffolding audit shows the pattern already works — it's just not systematized

The codebase already practices code-over-model unusually well: 29 of 40 audited mechanisms are structurally sound (retrieval RRF, loop guardrails graph.py:325-526, the privacy door privacy.py:270-286, the fuzzy edit matcher edit_match.rs:130, ToolEffects ground truth agent.rs:1894-1935). The fragility is concentrated in **exactly one place: free-text intent recognition via hand-synced substring lists** — the lane routers (agent.rs:1291-1439, mirrored by convention in routing.py:172-194, "change the Rust in the same commit or the two engines drift"), patched **three times on 2026-07-23 alone**. Meanwhile `is_pure_save_reference` (agent.rs:244-269) proves the bypass pattern, the 13 `#commands` (chat_commands.rs:19-96) prove intent→pipeline in code works (`#checkpoint` runs with Ollama stopped), and the scaffolding audit names **15 intents ready for the same treatment** — including a `delete_file` that doesn't exist at all (absent from agent.rs:1233-1283), so the model can only fail at it today.

The missing pieces are enumerated and small: an intent-dispatch registry instead of accreting inline `if`s, one shared slot grammar, ambiguity-aware file resolution (`find_file_like` silently takes newest match, db/files.rs:346-348 — fatal for write verbs), a referent store for "it/that" (the effects column already knows what each turn touched), and telemetry so router gaps become queries instead of live-QA bug reports. Note the file-resolution history when weighing anything destructive: "newest LIKE match wins" plus substring matchers patched three times in one day sets the consent bar for `delete` very high (§2.2).

### 1.3 Self-improvement: the loop is 80% built and 0% closed

The only durable cross-session learning substrate is the memories table (≤500 chars, no provenance, no usage counts). Everything else is a **write-only channel or an actively destroyed signal**:

- `edit_outcomes` persisted per message "so failure rates" can be computed (written at agent.rs:2132-2187, promised at agent.rs:1916) — **no code anywhere reads it back**. Note what this means: the flagship lesson this proposal wants ("edit_file on .docx: fuzzy match failed 3/5 — open and copy exact text first") is *computable today by a SQL aggregation, with zero model calls*. That fact shapes the whole reflection design in §2.6.
- Tool traces "never survive a turn" (handoff.py:49-51); successful multi-step sequences are unminable.
- Regenerate **deletes** the rejected message before re-asking (chatActions.ts:432-464) — so even the raw counter is unrecoverable. But regenerate is a *dirty* signal: users press it for tone, length, or dice-rolling as often as for errors. It's worth capturing; it is not, by itself, a negative-feedback trigger (§2.6).
- `memory_suggestion` sees only the last exchange, 2,000-byte clamp (ai_actions.rs:260-297) — multi-turn lessons structurally invisible.
- Handoff recaps explicitly containing "user's stated preferences" die with the chat.
- Skills/workflows can be agent-authored into review-gated drafts (skills.rs:356-444 — the entire human-review safety story is already built), but only when the user literally says "skill" (`wants_skill_tools`, agent.rs:1384-1388).

This is the cheapest section of the whole proposal: the stores, the draft gating, the confirmation UI, and the injection path all exist. What's missing is reading back what's written — and most of that read-back is arithmetic, not judgment.

### 1.4 Orchestration: eight paths, one product

The orchestration audit's verdict: most of the ~22K-LOC orchestration surface is **a reliability prosthesis for the 4B, not capability**. The registry is the product — proven by path 8 (external CLIs drive the *same* room_mcp registry with `ToolScope::ExternalAgent` and none of graph.py's babysitting). "Summarize this file" has **six routes** today. ~5,100 LOC (ai_actions ~700, studios ~950, #commands ~1,400 net, deep_summary ~450, workflow LLM-pattern nodes route/vote/refine/plan_and_map ~1,200, compose_workflow ~250, scheduling shim ~150) are deletable with zero capability loss because every deleted surface is reachable through the registry — *provided* the migrations preserve one non-obvious invariant: several #commands work with no model running at all, and that must be proven per command, not assumed (§5, Stage 3c).

### 1.5 The research consensus that frames everything

Every runtime studied converges on the same three facts:

1. **4B cannot own a free-form tool loop.** ZeroClaw issues #3999/#3079/#5311 (qwen 4-9B fail tool calling even with a multi-dialect parser), PicoClaw #430/#1161, Hermes's own ~9B floor, OpenClaw's 24K-char prompt sinking 3-7B models. The Claw family did *not* solve small-model agency — they solved **host-does-orchestration, model-does-one-capped-loop**, and they run it on 24-32B+ models.
2. **What *does* work at ≤8B is constrained classification + deterministic execution.** Rasa CALM ships a Llama-8B command generator over declarative flows; Home Assistant runs deterministic-intent-first with LLM fallback on millions of devices; grammar-constrained decoding via Ollama `format` makes qwen-class models reliably emit schema-valid enums; Octopus v2 (2B, 99.5% dispatch) and xLAM-1B prove the ceiling. The evidence is specifically for **closed-set classification** — it does not extend to free-text slot generation, and the architecture below respects that line strictly.
3. **Files-as-memory + progressive disclosure + a per-turn state brief carry weak models.** OpenClaw's workspace convention, Manus's recitation/todo.md, PicoClaw's prompt contributors + context budget, Hermes's frozen-snapshot MEMORY.md/USER.md with hard char caps. The *conventions* (frozen snapshots, hard caps, add/replace/remove-only writes) transfer; note that all of these runtimes trust a much larger model to maintain the file, so Arcelle borrows the injection discipline while keeping the store itself structured and code-enforced (§2.4).

**Conclusion:** Arcelle's existing "engine-tiered" instinct (2026-07-22 analysis) is validated externally. The new way is not a new loop — it's a new *front door* plus a code-enforced room-notes store plus a deterministic learning loop, with the model loop demoted to the fuzzy remainder.

---

## 2. The new architecture

```
user turn
   │
   ▼
┌────────────────────────────────────────────────────────┐
│ LAYER 0 — INTENT BRIEF BUILDER (pure Rust, no model)   │
│  normalizes text, extracts slots, resolves anaphora    │
│  from the referent store, resolves file fragments,     │
│  assembles a structured TurnBrief                      │
└────────────────────────────────────────────────────────┘
   │
   ▼
┌────────────────────────────────────────────────────────┐
│ LAYER 1 — DETERMINISTIC DISPATCH (Rust registry)       │
│  matcher hits + slots complete → execute code path,    │
│  no model call; near-miss → one grammar-constrained    │
│  LOCAL 4B call that labels the INTENT ONLY             │
└────────────────────────────────────────────────────────┘
   │ fuzzy remainder only
   ▼
┌────────────────────────────────────────────────────────┐
│ LAYER 2 — THE LOOP (engine-tiered, unchanged shape)    │
│  local 4B: capped loop, small tool bundle from the     │
│    brief, honest window limits                         │
│  cloud/CLI: full registry, big context budgets,        │
│    linear read_text paging                             │
│  every turn opens with room notes + the TurnBrief      │
└────────────────────────────────────────────────────────┘
   │
   ▼
┌────────────────────────────────────────────────────────┐
│ LAYER 3 — REFLECTION (deterministic: SQL aggregations  │
│  over effects; always local; writes template lessons   │
│  and note suggestions as review-gated chips)           │
└────────────────────────────────────────────────────────┘
```

### 2.1 The TurnBrief (intent-brief pattern)

A Rust struct built in `ask()` before anything touches a model, replacing today's scattered lane hints. Contents:

```rust
struct TurnBrief {
    normalized_text: String,          // lowercased, Hebrew marks stripped, tokenized
    intent: IntentMatch,              // Hit(intent, slots) | Partial(intent, missing_slot) | None
    referents: Referents,             // last file created/opened/edited, last table, last answer
    file_resolution: FileResolution,  // Unique(id) | Ambiguous(candidates) | None
    active_jobs: Vec<JobSummary>,     // from the jobs table
    room_state: RoomStateCard,        // file count by type, recent writes (from effects)
    lessons: Vec<Lesson>,             // budgeted read-back from effects aggregation (§2.6)
    tool_bundle: Vec<ToolName>,       // 3-6 tools selected for this turn
    engine_tier: EngineTier,          // drives all budgets
}
```

Three uses: (a) Layer 1 dispatches off it; (b) if the turn falls through to the loop, a compact rendering is injected as the ephemeral per-turn note — the generalization of the turn-progress note (prompts.py:121) and the anaphora hint (agent.rs:799-806), both of which already prove ephemeral injection is the right vehicle; (c) `Partial` matches inject the half-match hint the scaffolding audit asked for ("call start_file_pass; you still need the language") instead of falling through silently.

*Caveat:* the brief **replaces** the turn-progress note and anaphora hint — those two injectors must be retired in the same commit that ships the brief rendering, or two ephemeral-injection systems will fight for the same prompt budget. They belong in the §2.7 deletion accounting.

**Key sub-components, all named by the scaffolding audit:**
- **Shared slot grammar** — quoted-name-first capture, file-fragment slot, language table, folder slot; one module, Hebrew mirrors as required fields. Replaces `requested_file_name`'s 6 markers, `#translate`'s `rsplit_once(" to ")`, etc. This grammar is the **only** source of slot values in the entire dispatch layer — no model ever fills a slot (§2.2).
- **Referent store** — per-chat, populated from `ToolEffects` (which already records exactly this). Resolves "rename it", "translate it too" in code. The audit calls this the single highest-leverage addition; the #1 measured 4B failure is misassuming conversation state (agent.rs:1307-1311).
- **`resolve_unique`** — Match/Multiple/None replacing newest-LIKE-wins for write verbs; Multiple produces a deterministic "did you mean A or B?" reply. Code can ask questions too — and for anything mutating, code asking is the default, not the fallback.
- **Word-boundary matching** over the normalized tokens — kills the "passport"/"booking" false-positive class without touching a single hint list.

### 2.2 Layer 1: the intent-dispatch registry

An ordered table of `(matcher, slot_extractor, executor, confirm_policy, effects)` evaluated before `stream_answer` — exactly what `run_command` already is for `#commands` (chat_commands.rs:333-347), promoted to natural language. The registry lives as **Rust code behind a small matcher trait**, not a declarative data file: the hard cases (Hebrew morphology, quoted-name capture) will not fit a checked-in matcher DSL, and forcing them into one just reopens drift through code escape hatches. What *is* checked in as one shared data file — codegen'd to both Rust and Python — is the **hint and slot vocabulary** (verb lists, language table, transform words), ending the routing.py:38 drift-by-convention regime where it actually bites: the word lists, not the logic.

**Migration order matters:** the 13 existing `#commands` migrate into the registry **first**. They are the easiest rows (intent and slots already explicit), they give an instant parity test against a shipped surface, and they mean Stage 2 never runs `run_command` and the registry side by side for long. Rollout waves for natural-language intents, in risk order:

| Wave | Intents | Confirm policy |
|---|---|---|
| Read-only (zero risk) | open/show file, job status, room inventory, find/search, show transcript | none |
| Additive | remember, checkpoint, save-that (exists), table→sheet, start translation/summary pass | none (undoable) |
| Mutating | rename, move, undo | edit_gate card (edit_gate.rs:42) or auto-snapshot + Undo chip |
| Destructive (later) | **delete (new)** | exact-match resolution + explicit confirmation card, always |

Rules carried over from the save-that lessons: every bypass emits `effects` and an ask-step so the transcript stays honest; one shared **transform-veto** function (generalizing TRANSFORMS, agent.rs:1347-1351) guards every matcher; per-turn telemetry logs hit/partial/miss and whether `request_tools` had to rescue a lane — hint gaps become SQL queries.

**The fuzzy-confirmation tier — intent only, never slots.** When a matcher is a near-miss (verb hit, structure unclear), one grammar-constrained 4B call via Ollama `format`, schema `{reasoning, intent: enum(~20 values incl. "none")}`, reasoning field first per the structured-output guidance. The evidence base (Octopus, xLAM, CALM, HA) supports closed-set *classification* at this model size; it does not support free-text slot generation, and a schema-valid-but-wrong filename on a write verb is the worst failure class in the system — Layer 1 would then execute it deterministically and confidently. Therefore:

- The classifier returns a **label only**. Slots come exclusively from the deterministic slot grammar over the actual utterance. If the grammar cannot fill a required slot, the deterministic reply is a question, not a guess.
- **Mutating and destructive intents require an exact deterministic matcher hit.** The classifier path can reach read-only and additive executors only; it can never reach a write verb.
- The classifier **always runs on the local engine, unconditionally**, regardless of the session's chat engine. (Caveat worth one sentence in the spec: if dispatch ever rode the session engine, every message — including deterministically handled ones — would transit the cloud before Layer 1 decided anything.)

On "none", fall to Layer 2. The intent label (or "none" + the brief's noun analysis) selects the tool bundle, which is what retires the dual Rust/Python lane routers. The old routers stay as a flagged fallback during Stage 2 **with a deletion date tied to a telemetry threshold** (e.g., two consecutive weeks with <1% of turns rescued by the fallback), not "eventually" — three routing systems in parallel is the drift regime this design exists to end, and it must be a measured transition state, not a resting state.

**`delete_file` gets its own bar.** The file-resolution history here is newest-LIKE-wins (db/files.rs:346-348), and the matchers are heirs to substring machinery patched three times in one day. One "delete the draft" hitting the wrong of two drafts erases trust permanently. So: exact-match resolution + explicit confirmation card always (no auto-snapshot-and-chip shortcut, no classifier path), and it ships **one release after** the rest of the mutating wave, gated on telemetry showing rename/move dispatch accuracy >95%.

*Caveat on telemetry storage:* dispatch telemetry that includes user utterances is a new plaintext store outside the chat tables. Rows are keyed to room_id and ride the same teardown path as chat data (the 2026-07-12 security-wave class of invariant); by default they store a content hash + slot *types*, with full normalized text only behind a debug flag, and they stay out of any diagnostics export.

### 2.3 Layer 2: the loop, demoted and fed properly

The loop shape stays — graph.py's guardrails (tool-less final round, dup suppression, single-call cap, request_tools) are exactly the right 4B crutches and all survive. Changes:

1. **`read_text(file, offset, length)` chat tool** — the missing linear read. Engine-tiered window: 32,000 chars on cloud/CLI, 4,000 local. Be clear-eyed about who this serves: on cloud/CLI it closes the audit's #1 bottleneck outright; on the local tier it exists but is not the story — a 4B will not page 50 windows through a 200KB file, and the product must not promise that it will. Local users get honesty (item 3) and retrieval quality, not paging.
2. **Engine-tiered context budgets** — `MAX_CONTEXT_CHUNKS` 6→24 and `excerpt` 800→3,200 on cloud/CLI tiers; local stays. One match on `engine_tier` at gather time.
3. **Local window: RAM-aware, and honest.** The current omission of `num_ctx` is quietly load-bearing — KV cache at 16-32K on an 8GB Mac means swap or OOM next to the resident model. So `num_ctx` is set per **(model, available RAM)** via a lookup at daemon spawn, capped conservatively, and the primary fix is the UI: when an attachment exceeds the local window, say so ("file exceeds the local model's window — switch engine or start a full pass") instead of truncating silently. Honesty about truncation matters more than the ceiling.
4. **Tool bundle from the brief** — 3-6 tools per turn on the local tier (RAG-MCP/MCP-Zero finding: accuracy collapses past ~10-15 tools), full registry on CLI tier. Definitions kept stable within a session where possible (Manus: mask, don't churn).
5. **Room notes** (§2.4) injected at session start, above the cache boundary.

### 2.4 Room notes: a structured store, rendered as ROOM.md — not an agent-owned file

The workspace-file runtimes (§1.5) prove the *injection discipline* — frozen snapshot at session start, hard char cap, add/replace/remove-only writes. But every one of them trusts a 24B+ model to maintain the file, and their write rules ("read before writing; never placeholders") are prompt-enforced, i.e., unenforceable at 4B. An agent-owned free-text markdown file in this app would be a second, worse memory system beside the one that already exists (memories table + confirmation chip + injection path + review-gated skill drafts): the 4B would clobber sections, duplicate entries, and write placeholders, and a stale frozen snapshot above the cache boundary would poison every turn of every session.

So the store is **structured, and the file is a view**:

- **`room_notes` table** beside memories — same chip UI, same provenance, plus: kind (`room_fact` | `file_note` | `project` | `preference`), optional `file_id` foreign key, char-capped content, `created_by`, `app_version`. Dedupe by content hash, caps, and staleness are enforced **in code** — e.g., a `file_note` whose `file_id` no longer exists is auto-dropped, which no prompt rule can guarantee.
- **Injection** steals Hermes verbatim where it's model-agnostic: one frozen snapshot rendered at session start, hard cap ~2,200 chars, §-delimited entries, prefix-cache-safe (matters enormously at 4B token rates). The agent's write path is three actions (add/replace/remove) against *rows*, each surfacing as the existing confirmation chip.
- **`ROOM.md` in the `.arcelle` bundle is rendered at save time** from the table — user-inspectable, travels with the room, on-brand for the file-format story — **but only `room_fact`/`file_note`/`project` rows render into it.** `preference` rows (and all agent-performance data) are **app-private, always**: the privacy gatekeeper guards outbound-to-cloud seams, not file export, and a shared room must never ship a behavioral dossier on the user in plaintext. Export additionally gets a visible "this room includes AI notes — include or strip?" step. This is a data-class split, not a filename split, and it settles the bundle-vs-private question outright.
- **No LESSONS.md.** Agent-performance lessons are derivable from `effects`/`edit_outcomes` (§2.6) as structured rows; a free-text lesson file has no content today that isn't computable, and it would be the clobber-prone store all over again. If a lesson class ever emerges that genuinely isn't derivable from effects, revisit — as rows, not markdown.
- Handoff recaps (handoff.py:26-78) graduate their durable lines into `room_notes` (via chips) instead of dying with the chat; the pre-compaction flush bolts onto the existing hand-off button as one silent "persist durable context now" pass — over rows.

**Privacy composition:** the rendered snapshot passes through the existing outbound redaction door like everything else, and — stealing OpenClaw's trust-scope split — lesson rows and the entity map are never injected into cloud-routed turns beyond what the gatekeeper already permits.

### 2.5 Skills-as-procedures + progressive disclosure

- **ai_actions, studios, and most #commands collapse into skill files** (the orchestration audit's table): 14 ai_actions become 14 SKILL.md-style files (prompt + scope + tool bundle); studios become 3 skills + one deterministic `render_template` tool preserving the JSON-fallback guarantee; deep_summary becomes a shipped template over file_pass. The skills infra (progressive disclosure agent.rs:494/739-747, `/name` invocation, draft gating) already exists — this is migration, not construction.
- **`command-dispatch: tool` frontmatter** (OpenClaw's trick): a skill may declare it dispatches straight to a registry tool/code path with no model call — this is how #checkpoint/#to-sheet/#transcribe survive as skills without regressing to model mediation. The no-model-running invariant this preserves is proven per command with tests, not asserted (§5, Stage 3c).
- **Procedures are hand-authored draft workflows, not mined.** AWM's +24-51% gains come from thousands of benchmark trajectories; a single-user desktop app produces n≈3 per intent with high variance, and mined "repeated sequences" at that N encode coincidence. The app also already ships two step-sequence formats — workflows (deterministic nodes + agent_run + templates + a user-visible editor) and skills — and a third would be two too many. So: **hand-author the top ~5 procedures as draft workflows** (the scaffolding audit already names the intents), reusing the workflow executor and the existing review UI wholesale. The 4B's role in a procedure run stays CALM-shaped — fill one grammar-constrained slot per step, never plan.
- **Cheap seed, non-gating:** persist a content-free `tools: [{name, ok}]` array per turn into `effects_json` (same channel as edit_outcomes, one field). It costs nothing, feeds the failure-rate aggregations in §2.6 immediately, and — if Stage-2 telemetry ever shows real repetition volume — is the raw material for revisiting mining. Until that volume demonstrably exists, no miner and no bespoke template executor get built.
- **Selection is code**, not the 4B: BM25/keyword match of procedure descriptions against the brief; load at most one per task on the local tier.

### 2.6 The self-improvement loop — deterministic, local, and honest about signals

The design principle here follows from the rest of the proposal: distilling a transcript into a lesson is a judgment task, and this document spends five sections arguing the local 4B cannot be trusted with judgment tasks. Meanwhile the flagship lesson everyone wants — "edit_file on .docx: fuzzy match failed 3/5, open and copy exact text first" — is a SQL aggregation over data already being written (agent.rs:2132-2187). So:

1. **Reflection is deterministic on the local tier — SQL, not a model.** Aggregations over `effects`/`edit_outcomes`/the tool trace produce **template-filled lessons** (per-tool failure rates by file type, per-intent rescue rates, repeated `resolve_unique` ambiguity on the same fragment). No free-text model-written lessons locally: a 4B asked "worth_saving?" over a chunked transcript yields schema-valid generic mush that accumulates.
2. **No autonomous cloud reflection, ever.** A post-answer, user-uninitiated background call shipping the transcript to a cloud engine is exactly the class of send this product's consent model forbids — redaction is not consent, and recombining a whole transcript can recombine entities the per-turn gatekeeper redacted piecemeal. Anything reflective runs on the local engine regardless of the chat engine (it's async; latency is free) — and per (1), locally it's SQL. The only model-written review permitted is one the **user explicitly initiates** ("review this session"), which then follows the normal engine + consent path like any other request.
3. **Lesson read-back:** the aggregations surface as one budgeted line in the TurnBrief at gather time. Closes the loop agent.rs:1916 promised; zero schema change beyond the Stage-1 trace field.
4. **Regenerate is a counter, not a trigger.** It's captured (before `deleteMessage` destroys it, chatActions.ts:432-464) with a message snapshot — and that's all, until cause can be attributed: regenerate *plus an edited prompt* is signal; bare regenerate is tone/length/dice-rolling noise, and it's the most frequent event in the list, so promoting it manufactures wrong negative lessons at scale.
5. **Curation is correctness-based, not just time-based.** Time-based staleness alone keeps a *wrong but frequently matched* lesson alive forever — the inverse of the goal. So: (a) **strike system** — a lesson injected in a turn whose related tool then fails takes a strike; three strikes auto-archives; (b) every lesson row is stamped with `app_version`, and a subsystem rewrite (e.g., a new edit matcher) flushes its lesson category — the old lessons are falsified, not stale; (c) chip **dismissals are persisted**, and near-duplicate re-proposals are suppressed by content hash, so declined suggestions don't return as chip fatigue; (d) mechanical caps and `use_count`/`last_used_at` bookkeeping (bumped at read_skill/select_memories) stay, as the floor not the ceiling. No LLM consolidation on the 4B, ever.
6. **Approval default ON:** all agent-originated writes to room_notes/lessons surface as the existing confirmation chip (memory_suggestion UI) or land as disabled drafts. Right call for a privacy-first app.
7. **Measure it:** log tokens + tool calls per recurring intent; compare procedure-loaded vs suppressed runs (SkillAudit-style). Hermes's community ~30% token drop is the benchmark; if no visible delta in weeks, the loop is noise — kill it.

### 2.7 What gets DELETED

| Delete | Replaced by | LOC |
|---|---|---|
| ai_actions machinery (Rust table + sidecar prompt table) | 14 skill files; keep memory_suggestion/suggest_file_meta as plain endpoints | ~700 |
| Studios (4 files + studio job kind) | 3 skills + `render_template` tool | ~950 |
| #commands dispatcher + chat_docs.py pipelines | registry rows first (§2.2), then skills + `command-dispatch: tool`; ~200 LOC of deterministic executors kept | ~1,400 |
| deep_summary job kind | shipped workflow template over file_pass | ~450 |
| Workflow nodes route/vote/refine/plan_and_map/extract | the loop's job (agent_run node for the 4B tier) | ~1,200 |
| compose_workflow | agent already has save_workflow | ~250 |
| script→auto-workflow scheduling shim | direct schedule rows | ~150 |
| Lane keyword routers (both languages) | brief + dispatch registry + constrained classifier — deletion date set by telemetry threshold (§2.2) | net negative churn |
| Turn-progress note (prompts.py:121) + anaphora hint (agent.rs:799-806) | TurnBrief rendering, same commit it ships | small |

**~5,100 LOC**, zero capability loss — with the invariant that "zero loss" is *tested*, not asserted: several #commands run with the daemon and sidecar down (`#checkpoint` proves it), and each migrated command gets an offline invariant test (sidecar + daemon stopped) that gates its deletion commit. Each surface is deleted in its own commit for revertability. Workflows themselves stay, palette shrunk to deterministic nodes + agent_run + file_pass + for_each_file + save_file + script_run — and the shrunken palette is also what hand-authored procedures compile to (§2.5), so there is exactly one step-sequence format in the product. The radical ceiling (delete workflow authoring, ~8,500-9,500 LOC) is explicitly **deferred** until the floor engine is no longer a 4B — headless scheduled runs must not depend on loop reliability the local tier measurably lacks.

---

## 3. Steal map

| Element | Stolen from | Specifics |
|---|---|---|
| TurnBrief / state card each turn | Manus (recitation, todo.md rewritten every step), PicoClaw (prompt contributors + context_budget.go), Anthropic context-engineering | Harness rebuilds a small fresh brief; model never sees raw sprawl. Keep failures visible in the brief (Manus). |
| Deterministic-first dispatch, LLM fallback | **Home Assistant Assist** (`prefer_local_intents`), Rasa CALM (8B command generator over declarative flows) | The inverse of agent stacks; it's what ships on-device at millions of installs. |
| Grammar-constrained intent enum, reasoning-field-first | Rasa CALM, Ollama `format`/GBNF, dottxt "Say What You Mean" | Classification — labels from a closed set — is the 4B's job. Slot values are not; those stay deterministic (§2.2). |
| Small per-turn tool bundle; mask don't churn | ZeroClaw (default_tools = 3), RAG-MCP/MCP-Zero, Manus (logit-mask, keep definitions stable) | Directly attacks the 40-tool / 4B mismatch. |
| Workspace-notes conventions: frozen snapshot, hard caps, add/replace/remove-only | **Hermes** (MEMORY.md 2,200 chars, §-delimited, prefix-cache-preserving), OpenClaw (write rules, main-session-only injection), NanoClaw | Injection discipline copied verbatim; the *store* diverges — structured rows with code-enforced dedupe/caps, file rendered as a view (§2.4), because those runtimes trust a 24B+ maintainer and Arcelle can't. |
| Pre-compaction memory flush | OpenClaw (`memoryFlush` before compaction) | Bolt onto the existing hand-off button: one silent "persist durable context now" pass over rows. |
| Progressive disclosure (name+description only, ~24 tokens/skill), `command-dispatch: tool` | OpenClaw skills, Hermes Level-0/Level-1, Anthropic Skills / agentskills.io | Body read on demand; deterministic skills skip the model entirely. |
| Deterministic triggers + mechanical curator | **Hermes** (nudge counters, curator Phase 1, provenance tags, write_approval) | Taken further than Hermes: the review call itself is replaced by SQL on the local tier, and no autonomous fork exists at all — consent model + 4B judgment ceiling (§2.6). |
| Procedures as replayable step lists, model fills one slot per step | Rasa CALM templates, OpenAI routines/handoffs | Hand-authored as draft workflows over the existing executor; AWM-style *mining* (+24.6%/+51.1% Mind2Web/WebArena) is noted and deferred — its gains come from trajectory volumes a single-user app doesn't produce. |
| Host owns orchestration; one capped loop; engine tiers | All four Claws (NanoClaw's split is cleanest), NVIDIA SLM-agents paper | Validates keeping jobs/queue/scheduler in Rust and both loops as tiers. Registry-is-the-product = the ZeroClaw/NanoClaw lesson, already proven internally by path 8. |
| Tolerant tool-call recovery as one shared layer | ZeroClaw `tool-call-parser` crate | Generalize the 6 duplicated `recover_json` copies into one sidecar-seam module — necessary but not sufficient at 4B (their issue tracker proves both halves). |
| Cache-boundary prompt layout | OpenClaw system-prompt assembly | Already practiced (byte-stable prompt, agent.rs:575); room-notes snapshot above the boundary, brief below. |
| What NOT to copy | OpenClaw's 24K-char prompt (kills 3-7B, issue #55762); Hermes's free-roaming 16-iteration review fork (breaks this product's consent model on any engine, and exceeds the local tier's judgment); ZeroClaw's text-parsing-as-primary (fails at 4-9B); AWM mining at n=3 | The failure modes are as instructive as the wins. |

---

## 4. What must stay (untouched or strengthened)

- **The privacy walls, all of them:** outbound redaction door at every non-local seam (privacy.py:270-286, external.rs:306-321, room_mcp.rs:885-894), StreamRestorer inbound, entity map, consent gates. New rules added, not relaxed: lesson rows and the entity map are trust-scoped (never in cloud turns beyond gatekeeper policy); preference/agent-performance data never renders into the shareable bundle (§2.4); no user-uninitiated cloud calls of any kind (§2.6); the Layer-1 classifier is pinned local. The open outbound-remote-MCP-arg gap remains a standing bug to fix independently.
- **room_mcp registry + ToolScope (~1,200 LOC)** — it becomes the entire ACI; it is the product.
- **Jobs substrate** (run_plan/queue/lanes/resume, ~1,500) — durability and single-resident-model serialization are deterministic infra no loop provides. NanoClaw's group-queue is the external validation.
- **file_pass (~1,050)** — the coverage guarantee is a deterministic map/fold that cannot live in a context window; it's the "coverage-grade" tier of every content task, and on the local tier it is the honest answer to whole-file questions (§1.1).
- **Scripts runner (~1,550)** — separate trust domain, SHA-256 consent; untouched.
- **Scheduler (~270)**; **workflows, shrunk** to the one pipeline language (deterministic nodes + agent_run) — now also the substrate for procedures (§2.5).
- **Both loops as engine tiers** — external CLIs own the loop when present; graph.py is the local-tier loop. Correct shape, confirmed by every Claw.
- **graph.py's guardrails** — tool-less final round, dup suppression, single-call cap, request_tools escape hatch, cancel seams. These are the good crutches.
- **Edit safety stack** — fuzzy_find unique-match-only, edit_gate approval, snapshot/undo, `claims_unbacked_action` (extend its phrase list to Hebrew; don't remove it).

---

## 5. Staged rollout — each shippable, each with a kill switch

### Stage 1 — "Tell the truth, and let big engines read" (days)

Four gating items:

1. `read_text(file, offset, length)` chat tool, engine-tiered window — advertised as the cloud/CLI whole-file fix; present but unadvertised on local (a 4B won't page, §2.3).
2. Engine-tiered `MAX_CONTEXT_CHUNKS`/excerpt sizes (one match statement at gather).
3. RAM-aware `num_ctx` lookup at daemon spawn (per model + available RAM, conservative cap) + the attachment-overflow UI notice. This alone kills the trust-destroying silent-truncation behavior.
4. **Telemetry on the existing lane routers** (hit/miss/rescued per turn, hashed per §2.2's storage caveat) — measure the incumbent before building its replacement, so Stage 2's dispatch target is baseline-informed rather than guessed.

Two non-gating freebies, shipped when convenient: persist `tools: [{name, ok}]` into effects_json (one field, feeds §2.6); capture the regenerate counter + message snapshot before deleteMessage (frontend-only; a counter, not a trigger).

*Kill switch:* each item behind a settings flag; read_text absent from the catalog = exactly today's behavior. *Risk:* near zero — no orchestration touched. *Success metrics, per tier:* **cloud/CLI** — attached-file and read_text answers cover whole 200KB files in live QA; **local** — attachment overflow produces the notice, never silence; **process** — one week of router telemetry in hand before any Stage-2 code is written.

### Stage 2 — The front door (1-2 weeks)
1. TurnBrief builder: normalizer, shared slot grammar (Hebrew mirrors required), referent store from effects, `resolve_unique`; turn-progress note + anaphora hint retired into the brief in the same commit.
2. **#commands migrate into the registry first** — easiest rows, instant parity test. Then the 5 read-only intents + the 5 additive ones; save-that migrates in as an early row. No delete yet.
3. Grammar-constrained classifier (intent-only, local-pinned) for near-misses; brief-driven tool bundles begin replacing lane routers. Routers stay as a flagged fallback **with a pre-committed deletion threshold** (e.g., <1% fallback-rescued turns for two consecutive weeks), measured against the Stage-1 baseline.
4. Dispatch telemetry (hit/partial/miss/rescued) into effects, hashed by default.
5. Shared hint/slot vocabulary as one checked-in data file, codegen'd to Rust + Python; matcher logic stays Rust code behind the matcher trait.

*Kill switch:* `intent_dispatch: off` setting routes every turn to the current path; the registry is additive in front of `stream_answer`, exactly like the save bypass today. *Success metric:* deterministic-or-one-constrained-call dispatch rate beats the Stage-1 baseline and trends toward ≥60%; router live-QA patches drop to zero; per-intent accuracy dashboard from telemetry; rename/move (when the mutating wave lands late in this stage) >95% dispatch accuracy — the precondition for `delete_file` shipping in Stage 3.

### Stage 3 — Notes, lessons, deletion (3-4 weeks, three independent flags)
1. **3a Room notes:** `room_notes` table + chip UI + code-enforced dedupe/caps/staleness; frozen-snapshot injection above the cache boundary; add/replace/remove row actions; pre-handoff flush; handoff→notes graduation; render-at-save ROOM.md with the data-class split and the export "include AI notes?" step; trust-scoped cloud injection. *Kill:* don't inject; the table is inert and nothing renders into the bundle.
2. **3b Deterministic reflection + procedures:** SQL lesson aggregations + brief read-back; strike-based curation, version stamps, dismissal persistence; hand-author the top ~5 procedures as draft workflows over the existing executor and review UI. `delete_file` ships here, behind its Stage-2 accuracy gate. *Kill:* aggregation flag off; drafts are inert by design.
3. **3c Deletion:** migrate ai_actions/studios/#commands to skills + `command-dispatch: tool`, delete the ~5,100 LOC per §2.7, shrink the workflow palette. Each migrated command first gets an **offline invariant test** (sidecar + daemon down) that gates its deletion commit; each surface deleted in its own commit; goes last, only after Stage-2 telemetry shows the skills path handles the traffic.

*Success metric:* six-routes-to-summarize becomes two; Hermes-benchmark token/latency delta on ≥3 recurring intents with procedures loaded vs suppressed; zero offline-invariant regressions.

---

## 6. Open decisions for the owner

1. **Classifier engagement on the local tier: matcher-only vs classify-on-near-miss vs always-classify.** Pure deterministic matchers (HA-style) never misfire creatively but miss paraphrases; running the constrained classifier on *every* non-matched turn adds ~1-3s latency per message on local hardware. (Recommendation: matcher-first, classifier on near-miss only, revisit with Stage-2 telemetry. Either way the classifier labels intent only and never touches write verbs — that part is not open.)
2. **Approval default for agent-originated note/lesson writes: chips forever, or auto-apply after trust is earned?** The privacy-first posture says approval-on, but a chip for every lesson trains the user to dismiss chips — and dismissals are now persisted, so fatigue is at least measurable. Options: approval-on forever / auto-apply for `room_fact` rows only with an Undo toast / per-category setting. This decides how much the "gets better each time" feel actually materializes.
3. **Floor-model re-evaluation cadence.** The heavy 4B-insurance components (mined procedures, a bespoke template executor) are explicitly *not* being built — hand-authored draft workflows cover the near term, and deleting later is cheap. The remaining question is when to re-test the floor: an 8-14B qwen on the same Macs may land within months and would raise the local read_text/loop ceilings materially. Suggest a standing check per Ollama model drop rather than a calendar date.
4. **Workflow authoring: shrink now or hold?** §2.7 shrinks the palette (deletes route/vote/refine/plan_and_map). The radical option deletes user workflow authoring entirely (~4,000 more LOC) once procedures + scheduler cover the use cases — but workflows are a shipped, user-visible feature with templates, and they just became the procedure substrate too. Shrink-only is reversible; full deletion is a product decision about whether "scheduled procedures" replaces "visual pipeline editor" in the story you tell users.

---

*Residual caveats (small, tracked, not blocking):* the Layer-1 classifier's local pinning deserves an explicit line in SPEC.md so "engine-tiered" is never read as applying to dispatch; dispatch telemetry must be included in the room-teardown test matrix alongside the 2026-07-12 invariants; and the §2.7 table's last row (turn-progress note + anaphora hint) must land in the same commit as the TurnBrief rendering to avoid double ephemeral injection during the transition.