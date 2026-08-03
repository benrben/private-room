# Tool contracts: the full fix plan

**Date:** 2026-08-04
**Branch context:** `audit-waves-2026-08-04`
**Scope:** all 70 agent-facing tools (63 in `BUILTIN_TOOL_NAMES`, 6 `ask_*_agent` domains, `ask_agents`)
**Source of findings:** the external best-practice review dated 2026-08-04, checked line by line against this codebase.
**Status:** plan only. Nothing in here has been implemented.

---

## 0. What this document is

The external review graded our tool platform against MCP, OpenAI, Anthropic, Google, AWS and Microsoft tool-design guidance, plus OWASP/RFC security baselines. Its verdict, restated honestly:

> The architecture is right. The **contracts** are thin.

We separate reads from writes, we gate executable artifacts on content digests, we keep secrets away from the model, and we cap each specialist's tool count below what every vendor recommends. What we lack is the boring layer underneath: typed results, versions, retry safety, and paging.

But the review missed the single thing that hurts users most, because it read our schemas and not our dispatch code:

**The app's default document format is the one format `edit_file` refuses.** Every edit to an agent-authored document is a full rewrite from zero.

This plan leads with that, then covers everything else. Every fix below is written as steps against named functions that exist today.

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

The diagnosis was correct. The remedy chosen — steer to whole-file rewrite — was the cheap one, and it has become the dominant editing experience.

### 1.2 Current editability by format

| Format | Part-edit? | Path | Notes |
|---|---|---|---|
| `.html` / `.htm` | ❌ **No** | `write_file` (full rewrite) | **The app default** |
| `.pdf` | ❌ No | none | `annotate_file` highlights only — correct and intended |
| `.xlsx` / `.xls` | ✅ Yes | `set_cells` by A1 range | Correctly rejected by `edit_file` ([`edit_match.rs:479`](../src-tauri/src/commands/edit_match.rs#L479)) |
| `.docx` | ✅ Yes | `edit_file` → docx branch | Matches across split runs |
| `.md`, `.txt`, `.csv`, code | ✅ Yes | `edit_file` exact + fuzzy | `TEXT_EXTENSIONS`, [`extraction.rs:27`](../src-tauri/src/extraction.rs#L27) — note `html` is **absent** |

### 1.3 Second-order damage

- **Content loss risk.** The model must reproduce the entire document to change one sentence. Anything it forgets is deleted. Our empty-write guard catches a *blank* rewrite; it cannot catch a *shorter* one.
- **Token cost.** A 40 KB report costs 40 KB of output to fix a typo — on a local 4B, minutes.
- **Truthfulness pressure.** A model asked to reproduce a document it cannot hold will produce something plausible. This is the failure class the audit waves have been fighting.
- **Version-history noise.** Every trivial change creates a whole-file version.

### 1.4 The primitive we need already exists — twice

The comment says "the fold table cannot bridge that." That was true of the **fold table**, but not of the machinery built around it. Two existing pieces solve the harder half of the problem.

**Piece 1 — a span-preserving normalizer for plain text.**
[`normalize_with_spans`](../src-tauri/src/commands/edit_match.rs#L50) walks a string and returns:

```rust
struct NormText { chars: Vec<char>, spans: Vec<Range<usize>> }
```

— one folded comparison char per entry, each carrying **the byte range in the source it came from**. `fuzzy_find` then matches against `chars` and recovers the exact byte range to rewrite via `hay.spans[i].start .. hay.spans[i + n - 1].end` ([`edit_match.rs:156`](../src-tauri/src/commands/edit_match.rs#L156)).

That is precisely "match what the model sees, write where it actually lives." It is already in production for every `.md`, `.txt`, `.csv` and code file.

**Piece 2 — the same trick across a markup format.**
`.docx` is a harder case: stored bytes are XML, and Word splits one sentence across many `<w:t>` runs.

| Piece | Location | What it does |
|---|---|---|
| `scan_docx_text(xml)` | [`docx.rs:67`](../src-tauri/src/extraction/docx.rs#L67) | Returns `(nodes with byte spans, flattened char haystack, map: hay index → (node, offset))` |
| `find_sub` | [`docx.rs:178`](../src-tauri/src/extraction/docx.rs#L178) | Finds the needle in the flattened text |
| `replace_in_text_nodes` | [`docx.rs:190`](../src-tauri/src/extraction/docx.rs#L190) | Maps matches back to nodes, splices **right-to-left** so byte spans stay valid, handles matches spanning nodes |

**So HTML is strictly easier than what already ships.** It needs no zip repackaging, no `xml:space` handling, and no node struct — a single `NormText` over the raw markup is enough, because the replacement is one `String::replace_range`.

The whole of E1 is therefore: **write an HTML-aware sibling of `normalize_with_spans`.** Everything downstream is reuse.

**What cannot be reused:** `strip_html` ([`html.rs:3`](../src-tauri/src/extraction/html.rs#L3)). It narrows to `<main>`/`<article>`, injects newlines, and deletes the bodies of `<script>`, `<style>`, `<nav>`, `<header>`, `<footer>`, `<aside>`, `<form>` and `<svg>`. It is lossy **by design**, for retrieval, and keeps no offsets. Editing needs a second, position-preserving scanner. These are different jobs and must stay different functions — the plan never touches `strip_html`.

---

## 2. Cross-cutting contract gaps

Four properties are absent from **all 70 tools**. Listed once here rather than 70 times in §4.

### G1 — Results are prose, not data

`exec_tool` returns `Result<String, String>` ([`agent.rs:2623`](../src-tauri/src/commands/agent.rs#L2623)). Every tool answers in English: `list_room_files` → `"- name (mime, N bytes) — summary"` lines; `search_room` → `"[filename]\nexcerpt"`. No `outputSchema` anywhere, so the review's `output_schema_violation_rate` is unmeasurable by construction.

Some failures are deliberately returned as `Ok(...)` so the model can recover (`"No memory contains X"`). Good *product* behaviour, bad *typing* — success and failure are indistinguishable to any caller that isn't a language model.

### G2 — No optimistic concurrency on any write

No tool accepts `if_version` or `expected_sha256`. The only staleness check is [`apply_with_staleness`](../src-tauri/src/commands/edit_gate.rs#L148), which exists solely because the approval gate introduces an `await`; plans without a token are applied unchecked, and the gate is **off by default** by owner decision. Result: agent-vs-agent and agent-vs-user writes are last-write-wins. Snapshot + Undo give *recovery*, not *prevention*.

### G3 — No idempotency keys

`create_file`, `download_url`, `download_media`, `save_link`, `run_script`, `run_workflow` all duplicate their side effect on retry. We have already been bitten by a `test_workflow` retry storm.

### G4 — No pagination

- `list_memories` returns **every** memory in full, always ([`agent.rs:3563`](../src-tauri/src/commands/agent.rs#L3563)) — the review names this exact anti-pattern.
- `list_room_files` hard-stops at 100 with an honest prose note ([`agent.rs:2648`](../src-tauri/src/commands/agent.rs#L2648)), but file 101 is unreachable **by listing at all**.
- `list_skills`, `list_scripts`, `list_workflows`, `list_mcps` take no bound.

---

## 3. Where we are already ahead

Recorded so no future wave "fixes" something already correct.

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

## 4. The fix register, step by step

Effort: **S** ≤ 1 day · **M** 2–4 days · **L** ≥ 1 week.

---

## Wave E — Smart editing

### E2 — HTML part-edit, single text run *(ship first)*

**Goal:** `edit_file` succeeds on an `.html` file when the quoted text lies inside one run of text between tags. Refuse anything else, clearly.

**Why first:** it is strictly narrower than E1, shares all of E1's scanner work, and covers the dominant real case — "change this sentence."

**Files:** new `src-tauri/src/extraction/html_edit.rs`; [`extraction.rs`](../src-tauri/src/extraction.rs) (module decl + re-export); [`edit_match.rs:493`](../src-tauri/src/commands/edit_match.rs#L493).

**Steps**

1. Create `extraction/html_edit.rs`. Declare `pub(crate) mod html_edit;` in `extraction.rs` and re-export the two public functions.
2. Write the scanner:
   ```rust
   /// One matchable chunk of readable text, with the byte range in the RAW
   /// markup it occupies. Never spans a tag.
   pub(crate) struct HtmlTextRun { pub span: Range<usize>, pub text: String }

   pub(crate) fn scan_html_runs(html: &str) -> Vec<HtmlTextRun>
   ```
   Walk the markup once with a byte cursor:
   - `<!--` … `-->` → skip entirely.
   - `<script`/`<style` → skip to the matching close tag, case-insensitively. Reuse the pair-skipping shape from `strip_html` but **do not** call it.
   - `<` … `>` → a tag; skip. Never emit text from inside a tag, so attribute values can never be matched as content.
   - Anything else → a text run. Record `span` = its byte range in `html` and `text` = the decoded string.
3. Decode entities inside a run (`&amp; &lt; &gt; &quot; &#39; &nbsp;` at minimum). Keep a per-char byte-span vector so one decoded char can map to a multi-byte entity. This mirrors how `FoldOut::Pair` already lets two chars share one source span ([`edit_match.rs:74`](../src-tauri/src/commands/edit_match.rs#L74)) — the same relationship, inverted.
4. Write the matcher:
   ```rust
   pub(crate) fn find_in_html(html: &str, needle: &str)
       -> Result<HtmlHit, HtmlMatchError>;   // HtmlHit { span: Range<usize>, run_index: usize }
   ```
   For each run, fold its text through the **existing** `fold_edit_char` table so HTML edits tolerate exactly the same typographic drift as text edits — one fold table, no second dialect. Count matches **across all runs**; require exactly one.
5. Return the three outcomes the caller needs: `NotFound`, `Ambiguous(n)`, `Unique(span)`.
6. Add a re-escaping helper: the replacement text must be HTML-escaped (`&`, `<`, `>`) before splicing, or a `new_text` containing `<b>` silently injects markup. `html_escape` already exists in [`docs_html.rs:96`](../src-tauri/src/commands/docs_html.rs#L96) — reuse it.
7. In `compute_edit_bytes` ([`edit_match.rs:456`](../src-tauri/src/commands/edit_match.rs#L456)), replace the `"html" | "htm"` rejection arm with:
   - `find_in_html` → on `Unique(span)`, `html.replace_range(span, &html_escape(new_text))`, return `(bytes, 1, EditMethod::Html)`.
   - On `Ambiguous(n)` → `EditError::new(multi_occurrence_error(...), "ambiguous")`, reusing the existing wording.
   - On `NotFound` → the existing not-found message plus a `closest_snippet` hint, exactly as the text branch does at [`edit_match.rs:557`](../src-tauri/src/commands/edit_match.rs#L557).
8. Add `EditMethod::Html` to the enum and to `outcome()` ([`edit_match.rs:168`](../src-tauri/src/commands/edit_match.rs#L168)) so telemetry can distinguish it.
9. **Cross-run refusal (the E2/E1 boundary).** If the unique match's span contains any `<`, the match crossed markup — replacing that span would delete the intervening tags. Refuse with:
   > *"That text is split across formatting in the page (for example part of it is bold). Quote a piece that sits in one unbroken stretch of text, or rewrite the section with write_file."*
   E1 removes this refusal.
10. Add `"html"`/`"htm"` to the tool's user-facing capability text **only after** tests pass — `edit_file`'s description currently says nothing about HTML, which is correct while it refuses.

**Edge cases to handle explicitly**

| Case | Required behaviour |
|---|---|
| Match inside `<script>` or `<style>` | Never matched — those runs are not emitted |
| Match inside an attribute (`alt="Q3 revenue"`) | Never matched — tag interiors are skipped |
| `new_text` contains `<` or `&` | Escaped before splicing |
| Source contains `&amp;`, model quotes `&` | Matches; the entity's full byte range is replaced |
| Self-closing / void tags (`<br/>`, `<img>`) | Treated as tags; they end a run |
| Malformed markup (unclosed `<`) | Scanner terminates safely; no panic, no partial write |
| Non-UTF-8 bytes | Same guard as the text branch — refuse with the existing `non_utf8_error` |

**Tests** (`extraction/html_edit.rs` unit + `edit_match.rs` integration)

- `html_edit_replaces_text_in_a_single_run`
- `html_edit_never_matches_inside_script_or_style`
- `html_edit_never_matches_attribute_text`
- `html_edit_escapes_the_replacement`
- `html_edit_matches_across_entities`
- `html_edit_refuses_a_match_that_crosses_a_tag`
- `html_edit_is_idempotent_edit_then_revert_is_byte_identical`
- `html_edit_survives_malformed_markup`

**Done when:** `create_file("Q3 report", …)` then `edit_file` on one of its sentences succeeds, History shows a small diff, and every pre-existing `edit_file` test still passes untouched.

---

### E1 — HTML part-edit, cross-run

**Goal:** remove E2's step-9 refusal. A quote spanning `<strong>`, `<em>` or a `<span>` edits correctly, preserving the surrounding tags.

**Files:** `extraction/html_edit.rs`.

**Steps**

1. Change `find_in_html` to return the run indices and per-run char offsets the match covers, not just a byte span — the same `(n1, off1) … (n2, off2)` shape `replace_in_text_nodes` produces at [`docx.rs:205`](../src-tauri/src/extraction/docx.rs#L205).
2. Build the flattened haystack across **all** runs, with a `map: Vec<(run_index, char_offset)>` — the direct analogue of `scan_docx_text`'s third return value.
3. Insert an unmatchable sentinel between runs that belong to different **block** elements (`</p>`, `</div>`, `</li>`, `</h1-6>`, `</tr>`) so a match can never silently jump a paragraph. `scan_docx_text` does exactly this with `'\u{0}'` at paragraph boundaries ([`docx.rs:133`](../src-tauri/src/extraction/docx.rs#L133)); `normalize_with_spans` has the same idea as `PARA_SENTINEL`. Inline elements (`<b>`, `<i>`, `<span>`, `<a>`, `<em>`, `<strong>`, `<code>`) get **no** sentinel — crossing those is the whole point.
4. Apply the docx replacement discipline: the replacement lands in the **first** run (keeping its formatting); the matched remainder in later runs is cleared; intervening tags are untouched.
5. Splice **right-to-left** across runs so earlier byte spans stay valid — copy the loop at [`docx.rs:223`](../src-tauri/src/extraction/docx.rs#L223).
6. Delete E2's cross-tag refusal and its test; replace with the cross-run success tests below.

**Tests**

- `html_edit_replaces_a_match_spanning_bold` — `Q3 revenue was <strong>$4M</strong>` → `$5M`, `<strong>` survives
- `html_edit_never_matches_across_a_paragraph_boundary`
- `html_edit_crosses_inline_tags_but_not_block_tags`
- `html_edit_leaves_intervening_tags_byte_identical`
- Round-trip: 10 sequential edits leave the document byte-stable outside the edited spans

**Done when:** the E2 refusal message is unreachable and a bold-spanning edit succeeds.

---

### E3 — `prefix_context` / `suffix_context`

**Goal:** disambiguate without forcing the model to quote ever-longer passages.

**Steps**

1. Add two optional string properties to `edit_file`'s schema ([`agent.rs:1974`](../src-tauri/src/commands/agent.rs#L1974)). Keep descriptions to one line each — every character is paid on every turn.
2. Thread them through `PreviewEdit` ([`edit_match.rs:242`](../src-tauri/src/commands/edit_match.rs#L242)) and into `compute_edit_bytes`.
3. Matching rule: find all candidate spans for `old_text` first, then keep only those whose preceding text ends with the folded `prefix_context` and whose following text begins with the folded `suffix_context`. Fold both through `fold_edit_char` like everything else.
4. If context filtering leaves exactly one candidate → proceed. Zero → `"…the surrounding text you gave doesn't appear next to it"`. More than one → the existing ambiguity error with the post-filter count.
5. Apply uniformly to the text, docx and HTML branches — all three go through `compute_edit_bytes`, so this is one implementation.

**Tests:** `context_disambiguates_a_repeated_quote`; `wrong_context_reports_it_rather_than_guessing`; `context_folds_like_the_needle`.

---

### E4 — `occurrence: <n>`

**Steps**

1. Add `occurrence` (integer ≥ 1) to `edit_file`'s schema.
2. Reject `occurrence` together with `all: true` in `missing_required_arg`'s sibling validation ([`agent.rs:2635`](../src-tauri/src/commands/agent.rs#L2635)) — one message, before any file work.
3. In `compute_edit_bytes`, when `occurrence` is set, collect all matches and select the *n*-th (1-based). Out of range → `"…there are only N"`.
4. Suppress the ambiguity error when `occurrence` is supplied — ambiguity is exactly what it resolves.

**Tests:** `occurrence_selects_the_nth_and_leaves_the_rest`; `occurrence_out_of_range_reports_the_count`; `occurrence_with_all_is_rejected`.

---

### E5 — `dry_run`

**Goal:** show the change and the count without writing. Also the safe way for a model to ask "how many?" without going through an error.

**Steps**

1. Add `dry_run` (boolean, default false) to `edit_file` and `edit_files`.
2. Do **not** route a dry run through `gated_write` ([`edit_gate.rs:194`](../src-tauri/src/commands/edit_gate.rs#L194)) — approval is meaningless for a call that never commits. Instead, in the `edit_file` arm: take the room lock, call `plan_single_edit`, build the summary from the returned `PlannedWrite`, drop the lock, return. `commit_plans` is never called.
3. Summary contents: match count, method (`exact` / `fuzzy` / `html` / `docx`), file name, and a clipped before/after excerpt around each changed span (cap total output, reuse the existing clamp helpers).
4. Parity is the whole value: the dry run must call the *same* `plan_single_edit`, so it cannot drift from the real path.

**Tests:** `dry_run_writes_nothing` (file bytes and version unchanged); `dry_run_and_real_call_agree_on_count`; `dry_run_reports_the_same_method`.

---

### E6 — `section` targeting

**Goal:** "under the '2026 Outlook' heading, replace X" — how people actually describe an edit.

**Steps**

1. Add optional `section` (string) to `edit_file`.
2. In `html_edit`, locate the heading run whose folded text matches `section`; the section's byte range runs from that heading to the next heading of the same or higher level, or end of document.
3. Restrict matching to runs inside that range.
4. For Markdown, do the same over `#`-prefixed lines — this is why the parameter is worth having beyond HTML.
5. Unknown section → list the headings found, exactly as memory ambiguity lists candidates. Never fall back to whole-document matching: a silent widening is how wrong-target writes happen.

**Tests:** `section_scopes_the_match`; `unknown_section_lists_the_real_headings`; `section_never_widens_to_the_whole_document`.

---

### E7 — `search_room` returns an editable anchor

**Goal:** end quote-from-memory. The model points at what search returned.

**Steps**

1. Extend the `search_room` result to carry, per hit, a short opaque anchor id plus the file name (keep the human-readable excerpt exactly as it is — small models act on prose).
2. Store `anchor → (file_id, byte span, content hash)` in a per-turn side table held by `ToolEffects`. Not persisted; not a database change.
3. Accept `anchor` on `edit_file` and `annotate_file` as an alternative to `old_text`.
4. On use, verify the stored content hash still matches the file. Mismatch → `"that passage changed since the search; search again"`. This is G2's protection applied at the passage level, and it lands before P1.
5. Anchors expire with the turn. An expired anchor gets a clear message, never a silent fallback to text matching.

**Tests:** `anchor_edits_the_exact_passage_search_returned`; `stale_anchor_is_refused_not_guessed`; `expired_anchor_reports_clearly`.

---

### E8 — Revisit the HTML default *(product decision)*

Once E1 ships, HTML-first is fine and this becomes a free choice. Until then it is the amplifier. Option if E1 slips: default plain documents to `.md` at [`agent.rs:3468`](../src-tauri/src/commands/agent.rs#L3468), keeping HTML for anything with charts or layout. **Owner decides — not an engineering call.**

---

### E9 — `write_file` reports what changed

**Steps**

1. In the `write_file` arm ([`agent.rs:2887`](../src-tauri/src/commands/agent.rs#L2887)), diff old vs new before committing.
2. Return lines added/removed and the size delta alongside the existing character count.
3. Flag a suspicious shrink: if the new content is under ~50% of the old, say so in the result. A rewrite that accidentally drops half the document currently reports plain success — this is the one guard that catches the E-wave's own worst failure mode.

**Tests:** `write_file_reports_added_and_removed_lines`; `write_file_flags_a_large_shrink`.

---

## Wave A — The `all` parameter

`all` defaults to `false`; `true` replaces every occurrence **in one file**. It never spans files — `edit_files` deliberately has no `all`, and the `Option<bool>` distinguishes "tool has no such field" from "caller omitted it" ([`edit_match.rs:453`](../src-tauri/src/commands/edit_match.rs#L453)).

**Keep exactly as-is:** the count-bearing ambiguity error; the per-tool wording (`edit_files` is told "use edit_file", not sent round a loop that returns the identical error); the identical guard on the docx branch. All three were hard-won.

### A1 — `all: true` is silently ignored on a fuzzy match

**The bug.** In `compute_edit_bytes`, when the exact count is 0 the code falls to `fuzzy_find` ([`edit_match.rs:539`](../src-tauri/src/commands/edit_match.rs#L539)). That branch **never reads `all`**. `FuzzyFind::Unique` replaces one span and returns. The model asked for every occurrence, got one, and was not told. The reply says `"Replaced 1 occurrence(s)"` with a fuzzy note — not false, but not an answer to what was asked.

**Steps**

1. In the fuzzy branch, if `all == Some(true)`, return an error instead of replacing:
   > *"`all` needs an exact quote — your text only matched approximately, so replacing every occurrence isn't safe. Copy the text exactly as it appears, or drop `all` to change this one place."*
2. Give it its own outcome tag (`"all_needs_exact"`) so telemetry can count how often this fires.
3. Do **not** extend `all` to the fuzzy path. Fuzzy tolerates drift; "every drifted occurrence" is unbounded and cannot be previewed honestly.

**Tests:** `all_with_a_fuzzy_quote_is_refused_not_silently_single`; `fuzzy_without_all_still_replaces_one`.

### A2 — No size threshold on a replace-all

**Steps**

1. Add `const REPLACE_ALL_PREVIEW_THRESHOLD: usize = 10;` in `edit_gate.rs`.
2. In `gated_write` phase 1 ([`edit_gate.rs:203`](../src-tauri/src/commands/edit_gate.rs#L203)), after `compute` succeeds, sum `plans.iter().map(|p| p.count)`.
3. Gate on the tool name — `count` means *occurrences* for `edit_file`/`edit_files` but *characters* for `write_file`, so only apply the threshold when `tool` is one of the two edit tools.
4. If the sum exceeds the threshold, force the preview card **even when `approval_needed` returns false**. The card already renders a diff; no UI work.
5. Label it: *"This will change N places in <file>."*

**Tests:** `replace_all_above_threshold_forces_the_card_with_the_gate_off`; `small_replace_all_still_applies_instantly`; `write_file_character_count_never_trips_the_threshold`.

### A3 / A4 — covered by E5 (`dry_run`) and E4 (`occurrence`)

---

## Wave P — Platform contracts

### P1 — `if_version` on writes

**Steps**

1. Decide the token. `PlannedWrite` already carries a staleness token for the gate path; reuse that representation rather than inventing a second.
2. Surface it: `open_file`, `search_room` and the edit results return the file's current version token.
3. Accept optional `if_version` on `edit_file`, `edit_files`, `write_file`, `set_cells`, `rename_file`, `move_file`.
4. Check inside the lock, immediately before `commit_plans`. Mismatch → a distinct recoverable error naming the file: *"…changed since you read it; open it again and redo the change."*
5. **Optional, not required.** A required token would break every existing prompt and every small model. Absent token = today's behaviour.
6. Make `apply_with_staleness` the single implementation so the gate path and the `if_version` path cannot diverge.

**Tests:** `stale_if_version_is_rejected_and_the_file_is_unchanged`; `absent_if_version_behaves_exactly_as_today`; `token_from_open_file_round_trips_into_an_edit`.

### P2 — Idempotency keys

**Steps**

1. The **runtime** generates the key from `(turn id, tool name, canonical args)`. The model never sees or supplies it — the review is explicit, and our `list_skills` hidden-`agent` parameter is the precedent ([`agent.rs:2043`](../src-tauri/src/commands/agent.rs#L2043)).
2. Add a per-room table `tool_idempotency(key, tool, result_ref, created_at)`.
3. Wrap the six side-effecting tools: on entry, look up the key; on hit, return the stored result; on miss, run and store.
4. Expire entries with the turn for chat tools; keep them for the job's lifetime for `download_*` and `run_workflow`.
5. Emit an `obs` event when a duplicate is suppressed — that count is the proof the fix works.

**Tests:** `same_call_twice_creates_one_file`; `duplicate_download_returns_the_first_result`; `different_args_are_not_deduplicated`.

### P3 — Pagination

**Steps**

1. Add optional `cursor` and `limit` to `list_memories`, `list_room_files`, `list_skills`, `list_scripts`, `list_workflows`, `list_mcps`.
2. Cursor is opaque — encode `(sort key, id)`, never a raw row offset.
3. Default limits: memories 50, files 100 (today's cap, now honest), others 50.
4. Keep the prose "…and N more" line and add how to get them.
5. Deterministic ordering with an id tie-breaker, or pages will duplicate and drop rows.

**Tests:** `every_item_appears_exactly_once_across_pages`; `cursor_is_stable_when_an_unrelated_row_is_inserted`; `list_memories_is_bounded_by_default`.

### P4 — Structured results *(the careful one)*

**Constraint that dominates the design:** our prose results are load-bearing. Small models act on sentences better than on JSON, and several strings encode truthfulness lessons — `"quote these values"`, `"printed nothing"`, `"VALIDATED: no"`, `"Replaced N occurrence(s)"`. **Any version that changes what the model reads is a regression, not an improvement.**

**Steps**

1. Change `exec_tool`'s return type to `Result<ToolOutput, ToolFailure>` where `ToolOutput { text: String, data: Option<serde_json::Value> }`.
2. Populate `text` with **byte-identical** strings to today. Mechanical change, no wording edits.
3. Add `data` opportunistically, highest value first: `search_room`, `list_room_files`, `list_memories`, `job_status`.
4. The model seam keeps sending `text` only. `data` serves the room MCP bridge, the frontend, and tests.
5. Assert prose parity: a test that pins the exact strings for a sample of tools, so the migration cannot silently reword them.

**Tests:** `every_tool_returns_the_same_text_as_before` (golden-string suite, written *before* the refactor).

### P5 — Error vocabulary

**Steps**

1. `ToolFailure { message: String, kind: ErrorKind }` with `NotFound`, `Ambiguous`, `VersionConflict`, `ApprovalRequired`, `LimitExceeded`, `Timeout`, `WrongType`, `Unavailable`, `Internal`.
2. `EditError.outcome` already carries `"ambiguous"`, `"not_found"`, `"wrong_type"`, `"failed"` — map these first; the vocabulary is half-built.
3. Keep recoverable-`Ok` product behaviour. The kind travels beside the sentence; it does not change which arm returns.
4. Feed `kind` into `obs` via the existing `one_of` whitelist — compile-time constants, safe to log.

### P6 — Annotation completeness

**Steps**

1. Add a test asserting every name in `BUILTIN_TOOL_NAMES` has an entry in `arcelle_tool_annotations` ([`room_mcp.rs:828`](../src-tauri/src/room_mcp.rs#L828)).
2. Add `EditMethod::Html` and any new tool names as they land.

---

## Wave S — Safety and correctness

### S1 — `mark_image` on cloud models

**The bug.** The privacy door strips images for non-local models and only counts them. The call still runs, `ground_prepared_image` returns `[]`, and [`agent.rs:3366`](../src-tauri/src/commands/agent.rs#L3366) reports *"Could not locate X"* — a claim about a photo the model never saw.

**Steps**

1. Have the privacy door report *how many* images it stripped, not just strip them.
2. In `mark_image` and the vision path, if images were stripped, return a truthful refusal naming the cause and the fix (choose a local vision model, or enable image sending for this room) — **before** interpreting an empty result.
3. Never let "grounding returned nothing" and "grounding never ran" produce the same sentence.

**Tests:** `stripped_images_produce_a_refusal_not_a_not_found`; `local_vision_path_is_unchanged`.

### S2 — `set_cells` formula injection

**Steps**

1. Add `value_mode: "text" | "formula"` to `set_cells` ([`agent.rs:1999`](../src-tauri/src/commands/agent.rs#L1999)), default `"text"`.
2. Under `text`, write a leading `=`, `+`, `-`, `@` as a literal string, not a formula.
3. Under `formula`, preserve today's behaviour.
4. Mention in the description that pasted web values default to text — the model needs to know the default is safe.

**Tests:** `leading_equals_is_stored_as_text_by_default`; `formula_mode_still_writes_a_formula`.

### S3 — `download_url` content typing

**Steps**

1. In `import_download` ([`files.rs:219`](../src-tauri/src/commands/files.rs#L219)), sniff magic bytes before `mime_guess::from_path`.
2. On disagreement, prefer the sniffed type and add a warning to the result.
3. Rename the stored file's extension to match the sniffed type when the mismatch is dangerous (`.pdf` that is really a script).
4. Leave `safe_file_name` alone — it is already correct.

**Tests:** `sniffed_type_wins_over_a_lying_extension`; `mismatch_is_reported_to_the_model`.

### S4 — Type `browse_do`'s actions

**Steps**

1. Replace `"items": {"type": "object"}` ([`browse.rs:95`](../src-tauri/src/commands/browse.rs#L95)) with a real one-of union: `click`, `type`, `select`, `scroll`, `key`, `click_at`, `back`, `wait_for`, each with its own properties and `required`.
2. Validate server-side before executing **any** action in the batch — a malformed action 3 must not leave actions 1–2 applied.
3. Shorten the description once the schema carries the shape; today it duplicates the whole union in prose.

**Tests:** `malformed_action_rejects_the_whole_batch_before_acting`; `each_action_kind_round_trips`.

### S5 — Page-freshness stamps

**Steps**

1. Add a monotonic `snapshot_epoch` to the browser page state, bumped on navigation and after any action that changes the DOM.
2. Return it from `browse_snapshot`, `browse_find`, `browse_read`, `browse_look`.
3. Accept it as a required field on `browse_do`; reject a mismatch with *"the page changed — take a fresh snapshot"*.
4. Same for `ui_snapshot` → `ui_act`.
5. Ship the reject as a **warning first** for one release so we can measure how often the model gets it wrong before it becomes a hard failure.

**Tests:** `stale_epoch_is_rejected_before_any_action_runs`; `fresh_epoch_passes`; `epoch_bumps_on_navigation`.

### S6 — Consequential-action confirmation

**Steps**

1. Build a conservative classifier over the accessible name and role of the target control: purchase, send, publish, delete, accept-terms, permission-change.
2. On a hit, stop the batch **before** the action, surface the existing consent card with the control's label and the page's origin, and end the batch there.
3. Do not reuse the outbound-typing door — different question, different card. Room data leaving the Mac and money leaving the user are separate consents.
4. Keep the MCP annotation as-is. A blanket `destructiveHint: true` already made non-interactive Codex refuse every connector call ([`room_mcp.rs:1003`](../src-tauri/src/room_mcp.rs#L1003)); the fix belongs in our gate, not in a label the client interprets.

**Tests:** `a_buy_button_stops_the_batch_and_asks`; `an_ordinary_link_does_not`; `declining_leaves_the_page_untouched`.

### S7 — `move_file` destination

**Steps**

1. Replace the empty-string sentinel ([`agent.rs:2016`](../src-tauri/src/commands/agent.rs#L2016)) with an explicit value (`folder: "/"` or a separate `top_level: true`).
2. Add `create_folder` (boolean, default **false**). Unknown folder without it → list the folders that exist.
3. Accept the old empty-string form for one release, with a deprecation note in the result.

**Tests:** `top_level_move_uses_the_explicit_form`; `unknown_folder_without_create_lists_existing_folders`; `legacy_empty_string_still_works_and_warns`.

### S8 — Script network policy *(deferred)*

`env_clear()` covers credentials; nothing blocks sockets. The right shape is deny-by-default with a manifest-declared allowlist surfaced on the consent card. **Deferred** because it breaks existing user scripts and needs a migration story and an owner decision — not because it is unimportant.

### S9 — Soft-delete memories

**Steps**

1. Add `deleted_at` to the memories table; `delete_memory` sets it instead of removing the row.
2. Exclude soft-deleted notes from `list_memories` and from prompt injection.
3. Purge after a fixed window; expose an undo path in the Memory panel.

**Tests:** `deleted_memory_stops_appearing_but_is_recoverable`; `purge_after_the_window`.

---

## Wave D — Discoverability and honesty

| ID | Fix | Steps | Effort |
|---|---|---|---|
| **D1** | Bound `list_memories` | Covered by P3; ship it **first** in that wave | S |
| **D2** | `fetch_page` returns final URL + status | Thread the response's final URL and status out of `guarded_get`; append one line to the result | S |
| **D3** | Opaque continuation marker | Replace the raw character offset with a token encoding `(url, offset, content hash)`; refuse a token whose hash no longer matches | S |
| **D4** | `save_link` transcript control | Add `transcript: auto\|never\|always`, default `auto` (today's behaviour); state it in the result | S |
| **D5** | `job_status` by id | Add optional `job_id`; no id keeps today's summary | S |
| **D6** | Memory verbs accept an id | Return ids from `list_memories`; accept `id` **or** `find`; keep the candidate list | S |
| **D7** | Trim workflow descriptions | Move detail from `save_workflow` (~700 chars) and `test_workflow` (~1,100) into `list_workflows`' node reference, already the "call this first" tool. Keep every truthfulness clause — trim mechanics, not honesty | S |
| **D8** | `read_skill` version + checksums | Hash each resource at read; return alongside the tree | S |

---

## 5. Sequencing

Each wave ends green (Rust + sidecar + tsc/vite) and is separately revertible.

| Wave | Contents | Why here |
|---|---|---|
| **1 — Editing, fast path** | E2, E3, E4, A1, A2, E9 | All small. Turns rewrite-only into part-editable for most real edits within days, and closes the silent `all` downgrade. |
| **2 — Editing, full** | E1, E5, E6, E8 | The cross-run scanner plus dry-run and section targeting. E8 becomes a free choice once E1 lands. |
| **3 — Truthfulness** | S1, S2, S3, D1, D2, D5, S9 | Every item stops the app stating something untrue or accepting something unsafe. All small. |
| **4 — Concurrency & retry** | P1, P2, P3, D6, E7 | Must follow waves 1–2: `if_version` has to cover the new edit paths, not just the old ones. E7's anchors sit naturally beside P1. |
| **5 — Browser hardening** | S4, S5, S6 | Largest behavioural risk; wants its own live-QA cycle. |
| **6 — Structure** | P4, P5, P6, D3, D4, D7, D8 | The typed layer, once everything above has settled its final shape. |
| **Deferred** | S8 | Needs a migration story and an owner decision. |

**Hard ordering constraints**

- E2 before E1 (E1 deletes E2's refusal).
- E4 before A4, E5 before A3 (they *are* those fixes).
- Wave 2 merged before wave 4 starts — `if_version` must wrap the final edit paths.
- P4's golden-string suite written **before** P4's refactor, or parity is unprovable.
- One wave at a time: `edit_match.rs` and `agent.rs` are single-owner for the duration. Parallel agents collided on these files twice in the last wave.

---

## 6. Test plan summary

Existing suites: Rust 564, sidecar 982, plus tsc/vite. Everything below is additive.

| Area | New tests | Guards against |
|---|---|---|
| HTML editing | 14 (E1 + E2) | Markup corruption, script/attribute matching, entity drift |
| `all` parameter | 5 | Silent single-replacement; unpreviewd mass replace |
| Context / occurrence / dry-run | 9 | Wrong-target edits; dry-run drift |
| Anchors | 3 | Editing a passage that moved |
| Concurrency | 3 | Lost updates |
| Idempotency | 3 | Duplicate files and downloads |
| Pagination | 3 | Duplicated or dropped rows |
| Browser | 7 | Stale refs, mass action, unconfirmed purchases |
| Safety | 6 | False vision claims, formula injection, lying extensions |
| Prose parity | 1 golden suite | P4 silently rewording model-facing strings |

**Regression rule for every wave: no existing test is modified to make a new one pass.** If an old test must change, that is a behaviour change and needs its own line in the wave notes.

---

## 7. Measurement

`obs.rs` records which tools were served and how jobs progressed; there is no per-tool quality signal. Minimum viable version — do **not** build the review's full framework:

1. **A golden prompt set.** ~60 asks, each labelled with the tool(s) that should fire, including negatives ("don't search the web for this"). Ingredients exist in `test_e2e_tasks.py` and `qa/UA-FEATURE-CHECKLIST.md`.
2. **Two numbers per model family:** did the right tool fire, did it fire when it should.
3. **Three edit-specific numbers, baselined before wave 1 and re-measured after wave 2** — this is the plan's own falsifier:

   | Metric | Definition | Target |
   |---|---|---|
   | Rewrite-instead-of-edit rate | `write_file` calls on a file the turn could have part-edited ÷ all document changes | **Sharp fall.** If it doesn't move, E1/E2 missed. |
   | First-attempt edit success | `edit_file` calls succeeding without a retry | Rise |
   | Ambiguity rate | edits failing with `"ambiguous"` | Fall after E3/E4 |

4. **Extend `obs.rs`** with per-tool outcome counts. Its `one_of` whitelist already fits — tool names and outcome tags are compile-time constants and safe to log.

---

## 8. What we will deliberately not do

| Recommendation | Decision | Reason |
|---|---|---|
| Replace all fuzzy names with opaque IDs | **Reject as stated; adopt the compromise** | A 4B cannot carry a UUID between calls — measured, recorded at [`agent.rs:3579`](../src-tauri/src/commands/agent.rs#L3579). Accept ids *as well as* names (D6, E7), keep the resolver and the candidate list. |
| `additionalProperties: false` everywhere | **Partial** | We already preserve it when a connector sends it ([`agent.rs:2394`](../src-tauri/src/commands/agent.rs#L2394)). Adding it to our own schemas costs tokens on the catalog a small model reads most; do it only where confusion is observed. |
| `input_examples` broadly | **Reject** | Descriptions already carry inline examples where they earned their place. More examples is more prompt on the model least able to afford it — D7 goes the other way. |
| Full trace/span instrumentation | **Defer** | `obs.rs` covers decisions with a privacy property we will not weaken for span coverage. |
| Provider-copied latency SLOs | **Reject** | The review says so itself: baseline from production. A local 4B and a cloud CLI share no budget. |
| Mark `browse_do` destructive | **Reject as stated** | A blanket destructive label made non-interactive Codex refuse every connector call, leaving that room with no connectors — reasoning at [`room_mcp.rs:1003`](../src-tauri/src/room_mcp.rs#L1003). Honest marking + our own gate is correct; S6 adds confirmation where it belongs. |
| Require `if_version` on writes | **Reject; make it optional** | Required tokens break every existing prompt and every small model. Optional gets the protection for callers that can use it. |

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| E1/E2 corrupt markup | E2 ships first and is strictly narrower. Idempotence and round-trip tests. Every edit is snapshotted; Undo already works. |
| Entity/encoding bugs silently mangle text | Dedicated entity tests; refuse non-UTF-8 exactly as the text branch does. |
| P4 changes what the model reads | Additive only. Golden-string suite written first; prose parity asserted. |
| S5/S6 make the browser agent refuse work it does today | S5 warns for one release before rejecting. S6 ships in its own wave with live QA. |
| S7 churns a prompt small models have learned | Accept both forms for one release; the old form warns. |
| Wave 4 lands `if_version` on paths wave 2 is still reshaping | Strict ordering; wave 4 does not start until wave 2 is merged. |
| Parallel agents collide on `edit_match.rs` / `agent.rs` | Single-owner for the duration. This has already happened twice. |
| The plan's own premise is wrong | Metric 1 in §7 is the falsifier. Baseline before wave 1; if the rewrite rate does not fall, stop and re-diagnose. |

---

## 10. Appendix — full tool register

✅ ahead of the review · ➖ meets it · ⚠️ falls short · ✏️ part of the editing problem

### Core file, memory and skill tools

| # | Tool | Standing | | Fixes |
|---|---|---|---|---|
| 1 | `list_room_files` | Stops at 100, honestly; file 101 unreachable | ⚠️ | P3 |
| 2 | `search_room` | 4 results / 800 chars fixed; no ids or locations. Injected-chunk exclusion is app-side ✅ | ⚠️✏️ | **E7**, P3 |
| 3 | `open_file` | Verifies the quote against real text, swaps in closest ✅ | ✅ | P1 (returns token) |
| 4 | `annotate_file` | Closest-passage fallback, flagged approximate ✅ | ✅✏️ | E3, E7 |
| 5 | `mark_image` | Real capability probe ✅; cloud images stripped → false "not found" | ➖ | **S1** |
| 6 | `create_file` | Refuses empty writes, honours Stop ✅; silent HTML default | ✅/⚠️✏️ | **E8**, P2 |
| 7 | `edit_file` | Strong guards; **refuses HTML** | ➖/⚠️✏️ | **E1–E7, A1, A2**, P1 |
| 8 | `edit_files` | Genuinely atomic; no `all` hatch ✅ | ➖✏️ | E3–E5, A2, P1 |
| 9 | `write_file` | Only path for HTML; no version; silent about changes | ⚠️✏️ | **E9**, P1 |
| 10 | `set_cells` | Real range editing ✅; no text-vs-formula switch | ➖/⚠️ | **S2**, P1 |
| 11 | `rename_file` | Keeps extension; no collision check | ➖ | P1 |
| 12 | `move_file` | Empty-string sentinel; always creates folders | ⚠️ | **S7**, P1 |
| 13 | `add_memory` | Dedupes, caps length ✅; no provenance or expiry | ➖ | P2 |
| 14 | `list_memories` | Returns everything, always | ⚠️ | **D1/P3**, D6 |
| 15 | `update_memory` | Phrase-only, but lists candidates; preserves category ✅ | ➖ | D6 |
| 16 | `delete_memory` | Irreversible | ⚠️ | **S9**, D6 |
| 17 | `list_skills` | Asking-agent injected app-side and hidden ✅ | ✅ | P3 |
| 18 | `read_skill` | No version or checksums | ⚠️ | D8 |

### Scripts

| # | Tool | Standing | | Fixes |
|---|---|---|---|---|
| 19 | `list_scripts` | Approval state + dependencies, no source ✅ | ➖ | P3 |
| 20 | `run_script` | Byte-exact consent, cleared env, process group, timeouts ✅; network open | ✅ | S8 *(deferred)*, P2 |

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
| 28 | `browse_find` | Text only | ⚠️ | S5 |
| 29 | `browse_snapshot` | Password fields fenced ✅ | ➖ | S5 |
| 30 | `browse_do` | Untyped actions; no epoch; no consequence confirmation | ⚠️ | **S4, S5, S6** |
| 31 | `browse_look` | Shares the snapshot's numbering ✅ | ➖ | S5 |
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
| `list_workflows` | Fine; long description | ➖ | D7, P3 |
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
| `run_skill_script` | Isolated copy + same consent card ✅ | ✅ | S8 *(deferred)* |
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

Editing is the product problem — the app's default format is the one `edit_file` refuses, and both halves of the machinery to fix it already ship (`normalize_with_spans` for text, `replace_in_text_nodes` for markup). Everything else is contract hygiene, sequenced so the parts that stop the app saying untrue things land early and the typed-result rewrite lands last, behind a golden-string suite that proves the model still reads exactly what it reads today.
