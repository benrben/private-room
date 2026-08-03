# Tool contracts: the full fix plan

**Date:** 2026-08-04
**Branch context:** `audit-waves-2026-08-04`
**Scope:** all 70 agent-facing tools (63 in `BUILTIN_TOOL_NAMES`, 6 `ask_*_agent` domains, `ask_agents`)
**Source of findings:** the external best-practice review dated 2026-08-04, checked line by line against this codebase.

---

## 0. What this document is

The external review graded our tool platform against MCP, OpenAI, Anthropic, Google, AWS and Microsoft tool-design guidance, plus OWASP/RFC security baselines. Its verdict, restated honestly:

> The architecture is right. The **contracts** are thin.

We separate reads from writes, we gate executable artifacts on content digests, we keep secrets away from the model, and we cap each specialist's tool count below what every vendor recommends. What we lack is the boring layer underneath: typed results, versions, retry safety, and paging.

But the review missed the single thing that hurts users most, because it read our schemas and not our dispatch code:

**The app's default document format is the one format `edit_file` refuses.** Every edit to an agent-authored document is a full rewrite from zero.

This plan leads with that, then covers everything else.

---

## 1. Headline finding — editing is rewrite-only for the app's own documents

### 1.1 The chain

Three independent decisions compose into one bad outcome:

| # | Location | Code | Effect |
|---|---|---|---|
| 1 | [`agent.rs:3468`](../src-tauri/src/commands/agent.rs#L3468) | `if extension_of(&name).is_empty() { format!("{name}.html") }` | A document with no extension becomes **`.html`** (ADD-22, "HTML-first") |
| 2 | [`agent.rs:3474`](../src-tauri/src/commands/agent.rs#L3474) | `html_document(&name, &content)` | The model's body markup is **wrapped** in a styled standalone page — the stored bytes are no longer what the model wrote |
| 3 | [`edit_match.rs:493`](../src-tauri/src/commands/edit_match.rs#L493) | `"html" \| "htm" => Err(...)` | `edit_file` **refuses HTML outright**: *"Rewrite it with write_file"* |

The refusal's own comment states the reason accurately:

> `.html` is the app's DEFAULT AI-document format, but its stored bytes are tag-bearing markup while the model quotes from `strip_html`-extracted text — the fold table cannot bridge that, so an in-place quote match is unreliable.

The diagnosis was correct. The remedy chosen — steer to whole-file rewrite — was the cheap one, and it has now become the dominant editing experience.

### 1.2 Current editability by format

| Format | Part-edit? | Path | Notes |
|---|---|---|---|
| `.html` / `.htm` | ❌ **No** | `write_file` (full rewrite) | **The app default** |
| `.pdf` | ❌ No | none | `annotate_file` highlights only — correct and intended |
| `.xlsx` / `.xls` | ✅ Yes | `set_cells` by A1 range | Correctly rejected by `edit_file` ([`edit_match.rs:479`](../src-tauri/src/commands/edit_match.rs#L479)) |
| `.docx` | ✅ Yes | `edit_file` → docx branch | Matches across split runs |
| `.md`, `.txt`, `.csv`, code | ✅ Yes | `edit_file` exact + fuzzy | `TEXT_EXTENSIONS`, [`extraction.rs:27`](../src-tauri/src/extraction.rs#L27) — note `html` is **absent** |

### 1.3 Second-order damage

This is not only an ergonomics problem. A forced full rewrite means:

- **Content loss risk.** The model must reproduce the entire document to change one sentence. Anything it forgets is deleted. Our empty-write guard catches a *blank* rewrite; it cannot catch a *shorter* one.
- **Token cost.** A 40 KB report costs 40 KB of output to fix a typo — on a local 4B model, minutes.
- **Truthfulness pressure.** A model that cannot faithfully reproduce a long document, but has been asked to, will produce something plausible. This is the exact failure class the audit waves have been fighting.
- **Version history noise.** Every trivial change creates a whole-file version.

### 1.4 We have already solved this problem once

`.docx` is a markup format whose stored bytes differ from its readable text, where the format splits a sentence across many elements. That is a *harder* version of the HTML problem, and it works today:

| Piece | Location | What it does |
|---|---|---|
| `scan_docx_text(xml)` | [`docx.rs:195`](../src-tauri/src/extraction/docx.rs#L195) | Returns `(nodes with byte spans, flattened char haystack, map: haystack index → (node, offset))` |
| `find_sub` | [`docx.rs:178`](../src-tauri/src/extraction/docx.rs#L178) | Finds the needle in the flattened text |
| `replace_in_text_nodes` | [`docx.rs:190`](../src-tauri/src/extraction/docx.rs#L190) | Maps matches back to nodes, splices **right-to-left** so byte spans stay valid, handles matches spanning nodes |
| `docx_replace_text` | [`docx.rs:254`](../src-tauri/src/extraction/docx.rs#L254) | Repackages, returns `(bytes, count)` — pure, no writes |

**The HTML fix is a port, not an invention.** Only the scanner changes; the match/map/splice engine is proven and unit-tested.

Critically, `strip_html` ([`html.rs:3`](../src-tauri/src/extraction/html.rs#L3)) **cannot** be reused for this. It is a destructive rewrite pipeline built for retrieval: it narrows to `<main>`/`<article>`, injects newlines, and deletes the bodies of `<script>`, `<style>`, `<nav>`, `<header>`, `<footer>`, `<aside>`, `<form>` and `<svg>`. It is lossy by design and keeps no offsets. Editing needs a **second, position-preserving** scanner. These are different jobs and must stay different functions.

---

## 2. Cross-cutting contract gaps

Four properties are absent from **all 70 tools**. Each is listed once here rather than 70 times in §4.

### G1 — Results are prose, not data

`exec_tool` returns `Result<String, String>` ([`agent.rs:2623`](../src-tauri/src/commands/agent.rs#L2623)). Every tool answers in English.

- `list_room_files` → `"- name (mime, N bytes) — summary"` lines
- `search_room` → `"[filename]\nexcerpt"`
- No `outputSchema` anywhere, so the review's `output_schema_violation_rate` is unmeasurable by construction.

Some failures are deliberately returned as `Ok(...)` so the model can recover (`"No memory contains X"`). That is good *product* behaviour and bad *typing* — success and failure are indistinguishable to any caller that isn't a language model.

### G2 — No optimistic concurrency on any write

No tool accepts `if_version` or `expected_sha256`. The only staleness check in the codebase is [`apply_with_staleness`](../src-tauri/src/commands/edit_gate.rs#L148), which exists solely because the approval gate introduces an `await`; plans without a token are applied unchecked, and the gate is **off by default** by owner decision.

Result: agent-vs-agent and agent-vs-user writes on one file are last-write-wins. Auto-snapshot and Undo give *recovery*, not *prevention*.

### G3 — No idempotency keys

`create_file`, `download_url`, `download_media`, `save_link`, `run_script`, `run_workflow` all duplicate their side effect on retry. We have already been bitten by a `test_workflow` retry storm.

### G4 — No pagination

- `list_memories` returns **every** memory in full, always ([`agent.rs:3563`](../src-tauri/src/commands/agent.rs#L3563)) — the review names this exact anti-pattern.
- `list_room_files` hard-stops at 100 with an honest prose note ([`agent.rs:2648`](../src-tauri/src/commands/agent.rs#L2648)), but file 101 is unreachable **by listing at all**.
- `list_skills`, `list_scripts`, `list_workflows`, `list_mcps` take no bound.

---

## 3. Where we are already ahead

Recorded so no future wave "fixes" something that is already correct.

| Area | What we do | Where |
|---|---|---|
| MCP safety hints | Full `readOnly/destructive/idempotent/openWorld` quad, per tool, with reasoning | [`room_mcp.rs:828`](../src-tauri/src/room_mcp.rs#L828) |
| SSRF | Literal-IP check → resolve **all** addresses → pin the connection → re-check **every** redirect hop; IPv4-mapped IPv6; CGNAT/benchmark/protocol ranges | [`web/guard.rs`](../src-tauri/src/web/guard.rs) |
| Script consent | SHA of exact bytes; a script the agent just wrote is by definition unapproved; approvals stored outside the room | [`scripts.rs:669`](../src-tauri/src/commands/scripts.rs#L669) |
| Script sandbox | `env_clear()`, fixed PATH, workspace TMPDIR, own process group, SIGTERM→SIGKILL, clamped timeout, ring-buffered output | [`script_run.rs:634`](../src-tauri/src/commands/jobs/script_run.rs#L634) |
| Draft-by-default | `save_skill` disabled · `save_mcp` disabled · `save_workflow` draft · `update_workflow` demotes an active workflow | various |
| Runtime arg validation | Checked centrally against each tool's **own advertised schema**, so guard and prompt cannot drift | [`agent.rs:2635`](../src-tauri/src/commands/agent.rs#L2635) |
| Atomic batch writes | `edit_files` genuinely prevalidates then commits all-or-nothing, renames included | [`edit_match.rs:742`](../src-tauri/src/commands/edit_match.rs#L742) |
| Ambiguity over guessing | Memory verbs list candidates and stop | [`agent.rs:3620`](../src-tauri/src/commands/agent.rs#L3620) |
| Tool search | `search_mcp_tools`/`run_mcp_tool` — the review's own recommended pattern, and our **only** schemas with `required` + annotations inline | [`room_mcp.rs:972`](../src-tauri/src/room_mcp.rs#L972) |
| Privacy-safe audit log | `obs.rs` makes logging room content *inexpressible* — no function accepts a free string | [`obs.rs`](../src-tauri/src/obs.rs) |
| Small tool boxes | `MAX_BOX_TOOLS = 7` vs Google's suggested 10–20 | [`agents.py:1013`](../sidecar/arcelle_sidecar/agents.py#L1013) |
| Honest capability gating | `consult_advisor` returns **no tool** rather than an empty `enum` | [`agent.rs:1870`](../src-tauri/src/commands/agent.rs#L1870) |

**`run_mcp_tool` is the template.** Every schema we touch should end up looking like it.

---

## 4. The fix register

Effort: **S** ≤ 1 day · **M** 2–4 days · **L** ≥ 1 week. Risk is the chance of regressing working behaviour.

### Wave E — Smart editing (the headline)

| ID | Fix | Where | Effort | Risk |
|---|---|---|---|---|
| **E1** | **HTML part-editing.** Add `scan_html_text(html) -> (nodes, haystack, map)` mirroring `scan_docx_text`. Reuse `find_sub` + the right-to-left splice verbatim. Route `"html"\|"htm"` in `compute_edit_bytes` to it instead of the rejection. | new `extraction/html_edit.rs`; [`edit_match.rs:493`](../src-tauri/src/commands/edit_match.rs#L493) | M | Med |
| **E2** | **Interim, ship first:** allow an HTML edit only when the match lies inside a **single** text node. Refuse cross-node matches with a specific message. Covers "change this sentence" — the overwhelming majority of real edits. | same | S | Low |
| **E3** | `prefix_context` / `suffix_context` on `edit_file` — disambiguate without inventing longer quotes. | [`agent.rs:1974`](../src-tauri/src/commands/agent.rs#L1974), `compute_edit_bytes` | S | Low |
| **E4** | `occurrence: <n>` — "replace the 3rd one". Mutually exclusive with `all`. | same | S | Low |
| **E5** | `dry_run: true` — return count + diff, write nothing. Doubles as the safe way to ask "how many?" without an error round-trip. | `plan_single_edit`, `gated_write` | M | Low |
| **E6** | `section` targeting — "under heading X, replace…". Natural for reports; trivial once E1's node map exists. | `html_edit.rs` | M | Low |
| **E7** | `search_room` returns a **location anchor** the edit tools accept, ending quote-from-memory. | [`agent.rs:2669`](../src-tauri/src/commands/agent.rs#L2669) + `retrieval` | M | Med |
| **E8** | Reconsider the HTML default. Once E1 lands, HTML-first is fine. Until then, consider `.md` for plain documents (charts/dashboards stay HTML). | [`agent.rs:3468`](../src-tauri/src/commands/agent.rs#L3468) | S | Med — product decision |
| **E9** | `write_file` returns a **change summary** (lines added/removed, size delta) instead of only a character count. | [`agent.rs:2887`](../src-tauri/src/commands/agent.rs#L2887) | S | Low |

#### E-wave acceptance criteria

1. `create_file("Q3 report", …)` → `edit_file` on one sentence of it **succeeds**, and History shows a small diff, not a whole-file version.
2. A cross-node HTML match under E2 fails with a message naming the reason — never a silent partial write.
3. `dry_run` and the real call report the **same** count on the same input (parity test).
4. Round-trip: edit an HTML file 10 times; the rendered output is byte-stable except at the edited spans.
5. Every existing `edit_file` test still passes unchanged.

### Wave A — The `all` parameter

`all` defaults to `false`, and `true` replaces every occurrence **in one file** (never across files — `edit_files` has no `all`, deliberately, [`edit_match.rs:453`](../src-tauri/src/commands/edit_match.rs#L453)). The guard rails are good; four holes remain.

| ID | Fix | Where | Effort | Risk |
|---|---|---|---|---|
| **A1** | **`all: true` is silently ignored on a fuzzy match.** If the exact count is 0, the forgiving matcher runs, replaces **one** span, and never consults `all`. The model asked for every occurrence, got one, and was not told. → Reject `all: true` on the fuzzy path with an explicit message. | [`edit_match.rs:539`](../src-tauri/src/commands/edit_match.rs#L539) | S | Low |
| **A2** | **No size threshold.** Replacing 2 and replacing 400 are identical. → Above a configured count (start at 10), force the preview card **regardless** of the cadence setting. | `gated_write` / [`edit_gate.rs:42`](../src-tauri/src/commands/edit_gate.rs#L42) | S | Low |
| **A3** | No dry run for a replace-all. → Covered by **E5**. | — | — | — |
| **A4** | No `occurrence`, so the only choices are *one* or *all*. → Covered by **E4**. | — | — | — |

Keep unchanged: the count-bearing error message, the per-tool wording (`edit_files` is told "use edit_file", not sent round a loop), and the identical guard on the docx branch. These are correct and were hard-won.

### Wave P — Platform contracts

| ID | Fix | Addresses | Effort | Risk |
|---|---|---|---|---|
| **P1** | `if_version` (or `expected_sha256`) on `edit_file`, `edit_files`, `write_file`, `set_cells`, `rename_file`, `move_file`. Reject stale writes with a distinct, recoverable error. | G2 | M | Med |
| **P2** | Runtime-injected idempotency key on `create_file`, `download_url`, `download_media`, `save_link`, `run_script`, `run_workflow`. Store outcome by key; a retry returns the same resource. **The model must never supply it.** | G3 | M | Med |
| **P3** | `cursor` + `limit` on `list_memories`, `list_room_files`, `list_skills`, `list_scripts`, `list_workflows`, `list_mcps`. | G4 | M | Low |
| **P4** | A shared result wrapper: data + warnings + IDs + page info, adapted to prose at the model seam so small-model behaviour is unchanged. | G1 | L | High |
| **P5** | A stable error vocabulary (`NOT_FOUND`, `AMBIGUOUS`, `VERSION_CONFLICT`, `APPROVAL_REQUIRED`, `LIMIT_EXCEEDED`, `TIMEOUT`, …) carried alongside the human sentence — keeping today's recoverable-`Ok` behaviour while making the kind machine-readable. | G1 | M | Med |
| **P6** | Extend `arcelle_tool_annotations` coverage to every tool and assert completeness in a test, so a new tool cannot ship unannotated. | — | S | Low |

**P4 is the one to be careful with.** Our prose results are load-bearing: small models act on sentences better than on JSON, and several messages encode truthfulness lessons ("quote these values", "printed nothing", "VALIDATED: no"). The wrapper must be additive — structured data underneath, the same sentence on top. Any version that changes what the model reads is a regression.

### Wave S — Safety and correctness

| ID | Fix | Where | Effort | Risk |
|---|---|---|---|---|
| **S1** | **`mark_image` on cloud models.** The privacy door strips images for non-local models and only counts them; the call still runs, returns `[]`, and we report "could not locate that" about a photo the model never saw. → Refuse the call with a truthful reason. | privacy door / `grounding_pick` | S | Low |
| **S2** | **`set_cells` formula injection.** No way to say "treat this as text". A value from a web page beginning `=` becomes a live formula. → Add `value_mode: text\|formula`, default `text`. | [`agent.rs:1999`](../src-tauri/src/commands/agent.rs#L1999) | S | Low |
| **S3** | **`download_url` trusts the filename for content type.** `mime_guess::from_path` on a server-suggested name. → Sniff magic bytes; on mismatch, prefer sniffed type and warn. (Filename sanitisation via `safe_file_name` is already solid.) | [`files.rs:219`](../src-tauri/src/commands/files.rs#L219) | S | Low |
| **S4** | **`browse_do` actions are untyped** — `items: {type: object}` with the union in prose, on the tool that submits forms and signs in. → Type the union properly. | [`browse.rs:95`](../src-tauri/src/commands/browse.rs#L95) | M | Med |
| **S5** | **No page-freshness check.** The model is told in prose to snapshot first. → Add a required `snapshot_epoch`; reject a stale batch. Same for `ui_act`. | `browse.rs`, `agent_ui.rs` | M | Med |
| **S6** | **No consequential-action confirmation.** Our consent door covers room data leaving the Mac, not buying/sending/publishing on a site. → Detect consequential controls and confirm; a confirmation ends the batch. | `browse.rs` | M | High |
| **S7** | **`move_file`'s empty-string sentinel + always-on folder creation** — the review names this design specifically. → Explicit top-level value; `create_folder` opt-in. | [`agent.rs:2016`](../src-tauri/src/commands/agent.rs#L2016) | S | Med — prompt churn |
| **S8** | **Scripts have unrestricted network.** `env_clear` covers credentials, nothing blocks sockets. → Deny by default with a declared allowlist in the manifest, surfaced on the consent card. | `script_run.rs` | L | High |
| **S9** | **`delete_memory` is irreversible.** → Soft delete with a recovery window. | [`agent.rs:3583`](../src-tauri/src/commands/agent.rs#L3583) | S | Low |

### Wave D — Discoverability and honesty

| ID | Fix | Where | Effort |
|---|---|---|---|
| **D1** | `list_memories` bound (also **P3**) — highest-signal single violation. | `agent.rs:3563` | S |
| **D2** | `fetch_page` returns final URL + HTTP status, so a redirect stops being invisible. | `web/fetch.rs` | S |
| **D3** | `fetch_page.start` becomes an opaque continuation marker instead of a raw character offset. | `agent.rs:2114` | S |
| **D4** | `save_link`: make the "YouTube saves a transcript" behaviour an explicit parameter rather than hidden behaviour. | `agent.rs:2143` | S |
| **D5** | `job_status` accepts a job id instead of returning everything. | `agent.rs:1826` | S |
| **D6** | `update_memory`/`delete_memory` accept an id **as well as** a phrase; keep the phrase resolver and its candidate list. | `agent.rs:3583` | S |
| **D7** | Trim `save_workflow` (~700 chars) and `test_workflow` (~1,100 chars) descriptions. Every character is paid on every turn by our smallest model. Move detail into `list_workflows`' node reference, which is already the "call this first" tool. | `workflow.rs:4084` | S |
| **D8** | `read_skill` returns a version + per-resource checksums. | `agent.rs:2053` | S |

---

## 5. Sequencing

Each wave ends green (Rust + sidecar + tsc/vite) and is separately revertible.

| Wave | Contents | Why here |
|---|---|---|
| **1 — Editing, fast path** | E2, E3, E4, A1, A2, E9 | All small. Turns rewrite-only into part-editable for most real edits within days, and closes the silent `all` downgrade. |
| **2 — Editing, full** | E1, E5, E6, E8 | The real scanner plus dry-run and section targeting. E8 becomes a free choice once E1 lands. |
| **3 — Truthfulness** | S1, S2, S3, D1, D2, D5, S9 | Every item stops the app stating something untrue or accepting something unsafe. All small. |
| **4 — Concurrency & retry** | P1, P2, P3, D6 | Needs waves 1–2 settled first: `if_version` must cover the new edit paths, not just the old ones. |
| **5 — Browser hardening** | S4, S5, S6 | Largest behavioural risk; wants its own live-QA cycle. |
| **6 — Structure** | P4, P5, P6, D3, D4, D7, D8, E7 | The typed layer, once everything above has settled on its final shape. |
| **Deferred** | S8 (script network policy) | Real, but it will break existing user scripts. Needs a migration story and its own decision. |

---

## 6. Tests to write

Behaviour we would otherwise re-break. Existing suites: Rust 564, sidecar 982, plus tsc/vite.

**Editing**
- HTML edit: single-node hit; cross-node hit (E2 refuses, E1 accepts); a match inside `<script>` is never edited; entities survive; attribute text is never matched as content.
- Idempotence: edit → revert → edit produces byte-identical output.
- `all: true` + fuzzy → explicit error, never a silent single replacement (A1).
- `all: true` above the threshold → preview forced even with the gate off (A2).
- `dry_run` vs real call → identical counts (E5).
- `occurrence: 3` on 5 matches → the 3rd changes, the other 4 are untouched (E4).
- Every existing `edit_file`/`edit_files` test passes unchanged.

**Platform**
- Stale `if_version` → rejected, file unchanged, error is recoverable (P1).
- Same idempotency key twice → one resource, one side effect (P2).
- Paging: every item appears exactly once across pages; no duplicates, no gaps (P3).
- Annotation completeness: every name in `BUILTIN_TOOL_NAMES` has an entry in `arcelle_tool_annotations` (P6).

**Safety**
- `set_cells` with a leading `=` stores text under the default mode (S2).
- Download whose bytes contradict its extension → sniffed type wins, warning surfaced (S3).
- `browse_do` with a stale epoch → rejected before any action runs (S5).
- `mark_image` on a cloud model → truthful refusal, never an empty-box "not found" (S1).

---

## 7. Measurement

Section 3 of the review is the part we implement least: `obs.rs` records which tools were served and how jobs progressed, but there is no per-tool quality signal.

Minimum viable version — do **not** build the full framework:

1. **A golden prompt set.** ~60 asks, each labelled with the tool(s) that should fire, including negatives ("don't search the web for this"). We already have the ingredients in `test_e2e_tasks.py` and `qa/UA-FEATURE-CHECKLIST.md`.
2. **Two numbers per model:** did the right tool fire (precision), did it fire when it should (recall). Reported per model family — the whole point is that a 4B and a cloud CLI differ.
3. **Edit-specific numbers**, because that is what this plan changes: *first-attempt edit success rate*, *ambiguity rate*, *rewrite-instead-of-edit rate*. Baseline before wave 1, re-measure after wave 2. If E1/E2 don't move the rewrite rate down sharply, the fix missed.
4. **Extend `obs.rs`** with per-tool outcome counts. Its `one_of` whitelist mechanism already fits: tool names are compile-time constants and safe to log.

---

## 8. What we will deliberately not do

The review is generic guidance; some of it does not fit this product.

| Recommendation | Decision | Reason |
|---|---|---|
| Replace all fuzzy names with opaque IDs | **Reject as stated; adopt the compromise** | A 4B cannot carry a UUID between calls — a measured failure, recorded at [`agent.rs:3579`](../src-tauri/src/commands/agent.rs#L3579). Accept ids *as well as* names (D6), keep the resolver, keep the candidate list. |
| `additionalProperties: false` on every schema | **Partial** | We already preserve it when a connector sends it ([`agent.rs:2394`](../src-tauri/src/commands/agent.rs#L2394)). Adding it to our own schemas costs tokens on the catalog a small model reads most; do it only where confusion is observed. |
| `input_examples` broadly | **Reject** | Our descriptions already carry inline examples where they earned their place. More examples is more prompt on the model least able to afford it — see D7, which goes the other way. |
| Full trace/span instrumentation | **Defer** | `obs.rs` covers decisions with a privacy property we are not willing to weaken for span coverage. |
| Provider-copied latency SLOs | **Reject** | The review says so itself: baseline from production. A local 4B and a cloud CLI share no budget. |
| Mark `browse_do` destructive | **Reject as stated** | A blanket destructive label made non-interactive Codex refuse every connector call, leaving that room with no connectors at all — reasoning preserved at [`room_mcp.rs:1003`](../src-tauri/src/room_mcp.rs#L1003). The honest marking plus our own approval gate is correct. S6 adds the confirmation where it belongs. |

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| E1's HTML scanner corrupts markup | E2 ships first and is strictly narrower. Round-trip and idempotence tests. Every edit is snapshotted; Undo already works. |
| P4 changes what the model reads and regresses small-model behaviour | Additive only: structured underneath, identical sentence on top. Prose parity asserted in tests. |
| S5/S6 make the browser agent refuse work it does today | Live-QA cycle of its own; ship behind the browser wave, not bundled. |
| S7's `move_file` change churns a prompt small models have learned | Accept both shapes for one release; the old empty-string form warns. |
| Wave 4 lands `if_version` on edit paths that wave 2 is still reshaping | Strict ordering — wave 4 does not start until wave 2 is merged. |
| Parallel agents collide on these files (happened twice in the last wave) | One wave at a time; `edit_match.rs` and `agent.rs` are single-owner for the duration. |

---

## 10. Appendix — full tool register

✅ ahead of the review · ➖ meets it · ⚠️ falls short · ✏️ part of the editing problem

### Core file, memory and skill tools

| # | Tool | Standing | | Fixes |
|---|---|---|---|---|
| 1 | `list_room_files` | Stops at 100, honestly; file 101 unreachable | ⚠️ | P3 |
| 2 | `search_room` | 4 results / 800 chars fixed; no ids or locations. Injected-chunk exclusion is app-side ✅ | ⚠️✏️ | E7, P3 |
| 3 | `open_file` | Verifies the quote against real text, swaps in closest | ✅ | reuse for E1 |
| 4 | `annotate_file` | Closest-passage fallback, flagged approximate | ✅✏️ | E3 shares machinery |
| 5 | `mark_image` | Real capability probe ✅; cloud images stripped → false "not found" | ➖ | **S1** |
| 6 | `create_file` | Refuses empty writes, honours Stop ✅; silent HTML default | ✅/⚠️✏️ | **E8**, P2 |
| 7 | `edit_file` | Strong guards; **refuses HTML** | ➖/⚠️✏️ | **E1–E5, A1, A2**, P1 |
| 8 | `edit_files` | Genuinely atomic; no `all` hatch ✅ | ➖✏️ | inherits E-wave, P1 |
| 9 | `write_file` | Only path for HTML; no version; silent about changes | ⚠️✏️ | **E9**, P1 |
| 10 | `set_cells` | Real range editing ✅; no text-vs-formula switch | ➖/⚠️ | **S2**, P1 |
| 11 | `rename_file` | Keeps extension; no collision check | ➖ | P1 |
| 12 | `move_file` | Empty-string sentinel; always creates folders | ⚠️ | **S7**, P1 |
| 13 | `add_memory` | Dedupes, caps length ✅; no provenance or expiry | ➖ | later |
| 14 | `list_memories` | Returns everything, always | ⚠️ | **D1/P3** |
| 15 | `update_memory` | Phrase-only, but lists candidates; preserves category ✅ | ➖ | D6 |
| 16 | `delete_memory` | Irreversible | ⚠️ | **S9** |
| 17 | `list_skills` | Asking-agent injected app-side and hidden ✅ | ✅ | P3 |
| 18 | `read_skill` | No version or checksums | ⚠️ | D8 |

### Scripts

| # | Tool | Standing | | Fixes |
|---|---|---|---|---|
| 19 | `list_scripts` | Approval state + dependencies, no source | ➖ | P3 |
| 20 | `run_script` | Byte-exact consent, cleared env, process group, timeouts ✅; network open | ✅ | S8 (deferred), P2 |

### Web

| # | Tool | Standing | | Fixes |
|---|---|---|---|---|
| 21 | `web_search` | One phrase; 7-engine merge ✅ | ⚠️/✅ | later |
| 22 | `fetch_page` | SSRF beats the review ✅; raw offset; no final URL | ✅/⚠️ | **D2, D3** |
| 23 | `save_link` | Keeps provenance ✅; transcript behaviour hidden | ➖/⚠️ | D4, P2 |
| 24 | `download_url` | Filename sanitisation solid ✅; type from name, no scan | ⚠️ | **S3**, P2 |
| 25 | `download_media` | URL only | ⚠️ | P2 |

### Browser

| # | Tool | Standing | | Fixes |
|---|---|---|---|---|
| 26 | `browse_open` | One field means URL *or* search words | ⚠️ | later |
| 27 | `browse_read` | Article/full choice ✅; no epoch | ➖/⚠️ | S5 |
| 28 | `browse_find` | Text only | ⚠️ | later |
| 29 | `browse_snapshot` | Password fields fenced ✅ | ➖ | S5 |
| 30 | `browse_do` | Untyped actions; no epoch; no consequence confirmation | ⚠️ | **S4, S5, S6** |
| 31 | `browse_look` | Shares the snapshot's numbering ✅ | ➖ | later |
| 32 | `browse_save` | Saves with site/author/date ✅ | ➖ | P2 |

### App UI

| # | Tool | Standing | | Fixes |
|---|---|---|---|---|
| 33 | `ui_snapshot` | Consent-sensitive controls never listed ✅ | ➖ | S5 |
| 34 | `ui_act` | Proper action enum ✅; no epoch | ➖/⚠️ | **S5** |
| 35 | `view_screenshot` | Read-only | ➖ | — |
| 36 | `view_media_frame` | Read-only | ➖ | — |

### Jobs, workflows, connectors, skills authoring, studio, delegation

| Tool | Standing | | Fixes |
|---|---|---|---|
| `start_file_pass` | Whole-file by design ✏️ | ➖ | section-scoped pass, later |
| `job_status` | No id, returns everything | ⚠️ | **D5** |
| `list_workflows` | Fine; long description | ➖ | D7 |
| `save_workflow` | Saves as draft ✅ | ✅ | D7, P2 |
| `update_workflow` | Demotes an active workflow ✅ | ✅ | — |
| `delete_workflow` | Cancels unfinished runs | ➖ | — |
| `run_workflow` | No retry protection | ➖/⚠️ | **P2** |
| `test_workflow` | Refuses to claim success unless every step ran ✅ | ✅ | D7 |
| `list_mcps` | Connectors + live state | ➖ | P3 |
| `read_mcp` | Secrets redacted from the model ✅ | ✅ | — |
| `save_mcp` | Saves disabled ✅ | ✅ | — |
| `delete_mcp` | Removes the token too | ➖ | — |
| `search_mcp_tools` | The review's own pattern, built ✅ | ✅ | — |
| `run_mcp_tool` | Only fully-specified schema in the app ✅ | ✅ | **use as template** |
| `read_skill_resource` | Plain read | ➖ | — |
| `write_skill_resource` | Whole-file only ✏️ | ✅/⚠️ | part-edit, later |
| `delete_skill_resource`, `delete_skill` | Explicit request only | ➖ | — |
| `run_skill_script` | Isolated copy + same consent card ✅ | ✅ | S8 (deferred) |
| `studio_flashcards`, `studio_mindmap`, `generate_podcast_script` | Plain generators | ➖ | — |
| `stt_status` | Lets the model check before promising ✅ | ✅ | — |
| `retranscribe_file` | On-device only | ➖ | — |
| `local_generate` | Cloud advisors structurally excluded ✅ | ✅ | — |
| `consult_advisor` | Offers nothing rather than an empty enum ✅ | ✅ | — |
| `ask_file_agent` … `ask_connector_agent` (6) | Clean non-overlapping domains; ≤7 tools each ✅ | ✅ | — |
| `ask_agents` | One call, several tasks — avoids small-model count errors ✅ | ✅ | — |

### Named in the review, not built

| Missing | Effect | Plan |
|---|---|---|
| `read_result` | Long results truncate; no way to read a large file in parts in order to edit part of it | Wave 6, alongside P4 |
| Job addressable by id | `job_status` returns everything | **D5** |

---

## 11. One-line summary

Editing is the product problem — the app's default format is the one `edit_file` refuses, and the machinery to fix it already exists in the `.docx` path. Everything else is contract hygiene, sequenced so the parts that stop the app saying untrue things land early and the typed-result rewrite lands last.
