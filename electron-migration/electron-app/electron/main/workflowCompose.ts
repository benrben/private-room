/**
 * The workflow-COMPOSE path: turning a plain-language description into a saved
 * DRAFT workflow, engine-agnostically — plus the prebuilt template gallery and
 * the small pure helpers `compose_workflow` and its neighbours depend on.
 *
 * Ported from `src-tauri/src/commands/jobs/workflow.rs` lines 3596-4427
 * (`compose_prompt` through the end of `builtin_templates`, stopping before
 * `mod tests` at 4427 — that module is this port's ORACLE, not production code
 * to copy), PLUS the handful of small direct dependencies that live just
 * BEFORE that slice in the same file and that nothing else in this migration
 * had ported: `parse_def` (2945-2952), `human_kind_label` (2957-2978),
 * `backfill_node_labels` (2986-3011), `parse_binding` (3014-3017),
 * `validate_workflow_inner` (3021-3038), `apply_schedule` (3060-3096),
 * `ScheduleArg`/`yes` (3098-3111) and `schedule_from_args` (3473-3493).
 * Without those, `compose_workflow`'s own retry/validate loop could not be
 * real. They are deliberately OUTSIDE this file's nominal line range: if a
 * concurrent "workflow.rs part 2/3" batch lands its own copies, fold them
 * together here rather than keeping two.
 *
 * ============================================================================
 * WHAT IS REAL, AND THE ONE HONEST SEAM
 * ============================================================================
 * Everything in `compose_workflow`'s body is real except a single leaf:
 * `ollama::generate` (`ollama.rs` lines 408-418 — the actual `/api/generate`
 * HTTP call) has NO Electron port anywhere in this migration. That is a
 * confirmed dependency gap, not a shortcut taken here; `skillsCmds.ts`'s own
 * module doc already flags the same gap for its unported `compose_skill`.
 *
 * Three things that LOOK like part of that gap are already real and are reused
 * rather than re-declared or re-flagged:
 *   - `ollama::list_models`      → `engineRouting.ts`'s {@link listModels}
 *   - `ollama::strip_think_spans`→ `engineRouting.ts`'s {@link stripThinkSpans}
 *   - `models.rs::model_setting` → `gatherContext.ts`'s {@link modelSetting}
 * A fourth, `ollama::recover_json` (`ollama.rs` 481-491), is ALSO ported for
 * real here as {@link recoverJson}: read at its actual home it is five lines of
 * pure string slicing over the already-real `strip_think_spans`, with no
 * network dependency at all — genuinely self-contained, not a stand-in for the
 * HTTP client.
 *
 * So: {@link generateTextAnyEngine}'s CLI branch (`claude-cli`/`codex-cli`) is
 * REAL — `externalAdvisor.ts`'s already-committed {@link runExternalCli} — and
 * its Ollama/local-model branch is an injectable seam defaulting to
 * {@link generateOllamaNotImplemented}, an honest rejection naming exactly what
 * is missing ({@link OLLAMA_GENERATE_NOT_IMPLEMENTED}). Never a fabricated
 * answer. Because Rust's own `generate_text_any_engine(…).await?` PROPAGATES a
 * generate failure straight out of `compose_workflow` (it is not one of the two
 * retryable failure modes — see {@link composeWorkflow}'s doc), a room set to a
 * local model sees that NOT_IMPLEMENTED message on the first attempt, honestly,
 * rather than limping through a fake one. A room on a CLI engine composes for
 * real today, including the whole two-attempt generate→validate→repair loop —
 * and that loop is fully testable through {@link ComposeWorkflowDeps.generate}
 * with no subprocess and no network.
 *
 * The seam's signature deliberately mirrors the real Rust call
 * (`ollama::generate(model, msgs, Some(0.2), KEEP_ALIVE_WARM, None)`) rather
 * than collapsing to `(model, prompt)`, so the batch that ports `ollama.rs` can
 * drop its client in without changing a call site or losing the temperature and
 * keep-alive the shipped app sends.
 *
 * ============================================================================
 * REUSED, NOT RE-PORTED (read these modules' own docs before touching them)
 * ============================================================================
 *   - {@link WorkflowDef}/{@link WorkflowBinding}, {@link validateWithBinding},
 *     {@link compileWorkflow}, {@link defaultResolvedModel},
 *     {@link defUsesRunInput}, {@link parseWorkflowDef},
 *     {@link parseWorkflowBinding} — `workflowModel.ts` (this migration's port
 *     of the same Rust file's lines 1-1030). Imported, never redeclared, per
 *     that module's own wire-format warning.
 *   - {@link nextRunFromNow} — `jobScheduler.ts`, ALREADY the exact port of the
 *     `super::next_run_from_now` `apply_schedule` calls.
 *   - {@link createWorkflow}/{@link upsertSchedule} — `db-host/workflows.ts`.
 *   - {@link isCliEngine}, {@link ROLLBACK_BUSY} — `turnContext.ts`.
 *   - {@link KEEP_ALIVE_WARM} — `ollamaModels.ts`.
 *   - `workflow_tools_specs` (4212-4257) — ALREADY ported verbatim by a
 *     concurrent batch as `toolSpecs.ts`'s `workflowToolsSpecs()`. Nothing here
 *     redeclares it; a second copy would silently diverge. A caller wanting the
 *     workflow-authoring tool schemas imports them from `toolSpecs.ts`.
 *
 * NOT ported here, on purpose:
 *   - `WORKFLOW_NODE_REFERENCE` (4187-4210) and the `agent_*` tool arms behind
 *     those specs (`agent_update_workflow`/`agent_delete_workflow`/
 *     `agent_run_workflow`/`agent_test_workflow`, 3768-4133) — `execTool.ts`
 *     stubs all six workflow tool names as `NOT_IMPLEMENTED: … Batch C` and
 *     wiring them is that batch's job. This file therefore adds NO `execTool.ts`
 *     arm, and needs none: `compose_workflow` is a plain `#[tauri::command]` in
 *     `lib.rs`'s handler list (line 485), reached from the Workflows page's
 *     "describe what you want" box, never through `exec_tool`'s dispatch.
 *     {@link testRunTrailer}/{@link clampTestReport} ARE ported here anyway —
 *     they are small pure helpers inside this file's line range, and their only
 *     caller (`agent_test_workflow`) will find them ready.
 *
 * ============================================================================
 * THE `db` PARAMETER AND THE `#[tauri::command]` WRAPPER
 * ============================================================================
 * Rust's `compose_workflow(window, state, description)` takes a
 * `State<AppState>` and reaches the open room via `state.with_room(...)`; no
 * Electron port of `AppState` exists yet (`jobs.ts`/`execTool.ts`/
 * `skillsCmds.ts` all document the same gap for their own slices). Following
 * this migration's settled convention, {@link composeWorkflow} takes an
 * already-resolved `db` directly, an `emit?: EmitFn` in place of the window
 * (`docxEdit.ts`/`organizeTools.ts`/`skillsCmds.ts`'s shape), and
 * {@link ComposeWorkflowDeps.isRollingBack} in place of `state.rolling_back()`
 * — real code, defaulting to "never busy", ready for a live flag later.
 *
 * {@link registerWorkflowComposeIpc} is the `#[tauri::command]` half, on the
 * exact channel names `src/api.ts` already invokes (`compose_workflow`,
 * `workflow_templates`), resolving "which room is open RIGHT NOW" per call.
 * Exported and directly tested but — same as `recIpc.ts`/`docxEdit.ts` —
 * deliberately NOT called from any live main-process entrypoint by this batch.
 *
 * ============================================================================
 * FIDELITY NOTES
 * ============================================================================
 *   - {@link composePrompt}'s text is verified BYTE FOR BYTE against Rust's own
 *     `format!` output: a standalone copy of `compose_prompt` was compiled and
 *     run with `rustc`, and both this implementation and the test's separately
 *     shaped oracle were diffed against that real output (sha256
 *     c4918ee5…8873b8) — not against a hand reading of the `\`-continuation
 *     escaping rules. The model's ability to emit a valid definition rides on
 *     this string, so it is pinned in full, both here (split per line) and in
 *     the test (one flat literal), so a slip in either transcription fails.
 *   - {@link testRunTrailer}'s four verdict strings are likewise pinned against
 *     compiled `rustc` output, in full. A prefix-only assertion (`starts_with
 *     "VALIDATED: no"`) cannot see a drifted tail — one candidate port's
 *     `"paused"` arm had silently swapped Rust's "…on the Scripts page; a
 *     script can only be confirmed by an approved run." for a paraphrase, and
 *     its prefix-only test passed anyway.
 *   - {@link clampTestReport}: Rust's `s.len()`/`char_indices()` count UTF-8
 *     BYTES; JS's `.length` counts UTF-16 code units. This truncates by real
 *     byte offset (via `Buffer`), so non-ASCII reports clamp where Rust clamps.
 *   - Every read of the MODEL's own JSON goes through {@link ownProp}, an
 *     `Object.prototype.hasOwnProperty` guard, so a key inherited from a
 *     polluted `Object.prototype` can never be mistaken for something the model
 *     actually said — matching `serde_json::Map::get`, which is own-key only.
 *     Every WRITE this file performs is to the fixed literal key `"label"`.
 *   - `parse_binding`/`schedule_from_args` are Rust's LOOSE readers (any
 *     malformed shape degrades to a default rather than failing) — distinct
 *     from `workflowModel.ts`'s STRICT {@link parseWorkflowBinding}, which
 *     {@link parseBinding} wraps rather than duplicates: its throw is caught and
 *     collapsed to `{scope:"general"}`, exactly like serde's `.ok()` in
 *     `v.and_then(|v| serde_json::from_value(v).ok()).unwrap_or(General {})`.
 *   - KNOWN, UNAVOIDABLE: the retry loop's `"output was not valid JSON (…)"`
 *     feedback embeds `serde_json`'s parse-error Display text in Rust and
 *     `JSON.parse`'s `SyntaxError` text here. The sentence SHAPE is identical;
 *     only the parenthesised detail — a hint for the MODEL, never a golden
 *     string — differs, and matching it would mean shipping a second JSON
 *     parser.
 */

import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type Database from "better-sqlite3-multiple-ciphers";
import { createWorkflow, upsertSchedule } from "./db-host/workflows.js";
import { listModels as listModelsReal, stripThinkSpans } from "./engineRouting.js";
import {
  runExternalCli as runExternalCliReal,
  type ExternalRunResult,
  type RunExternalOptions,
} from "./externalAdvisor.js";
import { modelSetting } from "./gatherContext.js";
import { nextRunFromNow } from "./jobScheduler.js";
import { KEEP_ALIVE_WARM } from "./ollamaModels.js";
import type { SidecarChatMessage } from "./sidecar.js";
import { isCliEngine, ROLLBACK_BUSY } from "./turnContext.js";
import type { OpenRoom } from "./turnEngine.js";
import {
  compileWorkflow,
  defUsesRunInput,
  defaultResolvedModel,
  parseWorkflowBinding,
  parseWorkflowDef,
  validateWithBinding,
  type WorkflowBinding,
  type WorkflowDef,
} from "./workflowModel.js";

// ============================================================================
// small shared helpers
// ============================================================================

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `serde_json::Map::get` — an OWN-key read, returning `undefined` for a key the
 * object does not itself carry. Every lookup into model-authored JSON in this
 * file goes through here so nothing inherited from `Object.prototype` can be
 * read as something the model said (see this module's doc).
 */
function ownProp(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// ============================================================================
// compose_prompt (workflow.rs:3596-3648)
// ============================================================================

/**
 * The fixed portion of {@link composePrompt}'s output, up to and including
 * "The workflow the user wants: " — the caller's `description` is appended
 * after it. Split at every real newline so a diff against the Rust source (or
 * against the test's own flat oracle) reads line by line. See this module's doc
 * for how this exact text was produced.
 */
const COMPOSE_PROMPT_PREFIX =
  "You compose an automation workflow for a note-taking app, as JSON only.\n" +
  "\n" +
  "Output ONE JSON object with keys: \"name\" (short), \"emoji\" (one emoji), \"description\" (one sentence), \"definition\", and optionally \"binding\" and \"schedule\". No prose, no code fence — JSON only.\n" +
  "\n" +
  "`definition` is a small graph: {\"version\":1,\"nodes\":[...],\"edges\":[...]}. Node kinds and their fields:\n" +
  "- generate {prompt, model:\"auto\"}\n" +
  "- summarize_file {select}\n" +
  "- file_pass {select, instruction, mode}\n" +
  "- for_each_file {select, instruction, model} — runs the instruction on EACH selected file and joins the results (use instead of file_pass to cover many files)\n" +
  "- agent_run {question}\n" +
  "- extract {fields:[\"name\",...]} — pulls named fields out of {{input}} as JSON\n" +
  "- route {prompt, labels:[\"a\",\"b\",...]} — the model tags {{input}} with ONE label; edges off it use branch:<label> (like condition's then/else, but N-way)\n" +
  "- vote {prompt, samples:3, mode:\"concat\"|\"majority\"} — runs the prompt N times, aggregates\n" +
  "- refine {prompt, rubric, max_rounds:2} — generate→critique→revise until it passes\n" +
  "- plan_and_map {objective, max_workers:4} — splits the objective into subtasks, runs each, synthesizes\n" +
  "- transform {op, find?, value?} — deterministic text op (append|prepend|replace|upper|lower|trim|truncate|strip_html)\n" +
  "- merge {mode:\"concat\"|\"dedupe_lines\"|\"numbered\", separator?} — joins parallel branches\n" +
  "- http_fetch {url} — fetches a web page's text (url may use {{input}})\n" +
  "- script_run {file, mode:\"import\"|\"transform\"} — runs a .py/.js room script; transform feeds {{input}} on stdin and returns its stdout as a pipe stage\n" +
  "- save_file {name_template, format:\"html\"|\"md\", mode:\"create\"}\n" +
  "- condition {op, value}\n" +
  "`select` is {\"type\":...,\"pattern\"?}. The ONLY valid types: \"newest\" (latest file), \"all\" (every file), \"name_like\" (needs \"pattern\"), \"missing_summary\" (files with no summary yet), \"since_last_run\" (files added since the previous run), \"run_input\" (the file the workflow is invoked on — file binding only). `op` must be one of: contains, not_contains, is_empty, not_empty, new_files_since_last_run.\n" +
  "Each node needs a unique \"id\", a \"kind\", and a short \"label\" — 2-4 words in the USER'S language describing what THIS step does for them (e.g. \"Find new tickers\", \"Append to dashboard\"), NOT the kind name. edges are [{\"from\",\"to\",\"branch\"?}] (branch \"then\"/\"else\" off a condition, or one of a route's labels off a route; omit branch otherwise). Parallel branches are just several edges out of one node, re-joined by a later node (e.g. a merge). Prompts may use {{input}} (upstream results), {{files}} (the room's file list), {{date}}.\n" +
  "For a workflow that runs on the file the user is viewing, set \"binding\":{\"scope\":\"file\",\"kinds\":[\"pdf\"]} and give input-taking nodes \"select\":{\"type\":\"run_input\"}. Otherwise omit binding (general).\n" +
  "For a schedule use \"schedule\":{\"kind\":\"daily\",\"param\":\"08:00\"} (kind interval|daily|weekly).\n" +
  "\n" +
  "Example: {\"name\":\"Morning digest\",\"emoji\":\"🌅\",\"description\":\"Digest new files each morning.\",\"definition\":{\"version\":1,\"nodes\":[{\"id\":\"gen\",\"kind\":\"generate\",\"label\":\"Write the digest\",\"model\":\"auto\",\"prompt\":\"Digest the files:\\n{{files}}\"},{\"id\":\"save\",\"kind\":\"save_file\",\"label\":\"Save today's digest\",\"name_template\":\"Digest {{date}}\",\"format\":\"html\",\"mode\":\"create\"}],\"edges\":[{\"from\":\"gen\",\"to\":\"save\"}]},\"schedule\":{\"kind\":\"daily\",\"param\":\"08:00\"}}\n" +
  "\n" +
  "The workflow the user wants: ";

/**
 * The instruction handed to the model to turn a plain-language request into a
 * WorkflowDef JSON. Deliberately reuses the `save_workflow` tool's schema prose
 * so the two stay in sync. Ported from `compose_prompt` (workflow.rs
 * 3596-3648) — every node kind's field list, every example, the exact phrasing.
 * This is a prompt whose output quality depends on matching exactly, not code
 * to paraphrase; see this module's doc for the byte-for-byte verification.
 */
export function composePrompt(description: string): string {
  return COMPOSE_PROMPT_PREFIX + description;
}

// ============================================================================
// ollama::recover_json (ollama.rs:481-491) — genuinely self-contained, so
// ported for REAL (see this module's doc for why this differs from the
// generate/HTTP half of the same Rust file, which is NOT ported).
// ============================================================================

function firstIndexOfAny(s: string, chars: string): number {
  let best = -1;
  for (const c of chars) {
    const idx = s.indexOf(c);
    if (idx !== -1 && (best === -1 || idx < best)) {
      best = idx;
    }
  }
  return best;
}

function lastIndexOfAny(s: string, chars: string): number {
  let best = -1;
  for (const c of chars) {
    const idx = s.lastIndexOf(c);
    if (idx > best) {
      best = idx;
    }
  }
  return best;
}

/**
 * Recover the JSON payload from a structured-output response. Models that honor
 * Ollama's `format` return bare JSON, so this is a no-op for them; but some —
 * notably Ollama *cloud* models, which ignore `format` — wrap the JSON in a
 * ` ```json ` code fence or emit a `<think>` preamble, which a strict parse then
 * rejects. Drop any `<think>` span (reusing `engineRouting.ts`'s already-real
 * {@link stripThinkSpans}, exactly as the Rust source reuses its own
 * `strip_think_spans`), then slice from the first opening bracket to the last
 * closing one so callers can parse it regardless of framing — a code fence is
 * stripped as a side effect of that slice, never matched explicitly. Ported
 * verbatim from `ollama::recover_json`.
 *
 * Braces and brackets are single-UTF-16-unit ASCII, so this `indexOf`/
 * `lastIndexOf` walk lands on the same logical positions Rust's byte-indexed
 * `find`/`rfind` do.
 */
export function recoverJson(text: string): string {
  const s = stripThinkSpans(text.trim()).trim();
  const openIdx = firstIndexOfAny(s, "{[");
  const closeIdx = lastIndexOfAny(s, "}]");
  if (openIdx !== -1 && closeIdx !== -1 && closeIdx >= openIdx) {
    return s.slice(openIdx, closeIdx + 1);
  }
  return s;
}

// ============================================================================
// generate_text_any_engine (workflow.rs:3650-3672)
// ============================================================================

/** `ollama::generate`'s temperature at this one call site — Rust's
 * `Some(0.2)`. */
export const COMPOSE_TEMPERATURE = 0.2;

/**
 * The honest refusal {@link GenerateTextAnyEngineDeps.generateOllama} defaults
 * to. Names the exact missing function and where it lives, and says plainly
 * which neighbours are NOT missing, so a caller reading this rejection knows it
 * is a declared gap rather than a bug. Never a fabricated answer.
 */
export const OLLAMA_GENERATE_NOT_IMPLEMENTED =
  "NOT_IMPLEMENTED: ollama::generate (src-tauri/src/ollama.rs lines 408-418, the direct " +
  "Ollama /api/generate HTTP call) has no Electron port anywhere in this migration yet. " +
  "This is distinct from list_models/strip_think_spans/recover_json/model_setting, which ARE " +
  "real (engineRouting.ts / gatherContext.ts / this module) — only the generate call itself " +
  "is missing, so compose_workflow can compose through an external CLI engine " +
  "(claude-cli/codex-cli) today but not through a local model. Inject a real " +
  "GenerateTextAnyEngineDeps.generateOllama once ollama.rs's own batch lands.";

/**
 * `ollama::generate`'s stand-in until `ollama.rs` is ported: rejects with
 * {@link OLLAMA_GENERATE_NOT_IMPLEMENTED}. The signature mirrors the real Rust
 * call so the eventual port is a drop-in.
 */
export const generateOllamaNotImplemented: GenerateOllamaFn = () =>
  Promise.reject(new Error(OLLAMA_GENERATE_NOT_IMPLEMENTED));

/**
 * `ollama::generate(model, msgs, Some(0.2), KEEP_ALIVE_WARM, None)` — the shape
 * the unported HTTP client will have. The trailing `None` (Rust's `num_ctx`
 * override) has no parameter here because this call site never passes one.
 */
export type GenerateOllamaFn = (
  model: string,
  messages: readonly SidecarChatMessage[],
  temperature: number,
  keepAlive: string
) => Promise<string>;

export interface GenerateTextAnyEngineDeps {
  /**
   * `crate::commands::run_external(model, &msgs, None, None, false)` — the
   * CLI-engine branch. REAL by default: `externalAdvisor.ts`'s already-committed
   * {@link runExternalCli}, called with no cancel flag, no MCP bridge and no
   * privacy bypass, matching Rust's three trailing `None, None, false` (the
   * `RunExternalOptions` default already behaves that way). Injectable only so a
   * test never spawns a real subprocess.
   */
  runExternalCli?: (
    engine: string,
    messages: readonly SidecarChatMessage[],
    options?: RunExternalOptions
  ) => Promise<ExternalRunResult>;
  /**
   * The direct-to-Ollama branch — the one genuine gap. NOT_IMPLEMENTED by
   * default; see this module's doc.
   */
  generateOllama?: GenerateOllamaFn;
}

/**
 * Generate text from whatever engine the room is set to — a local/cloud Ollama
 * model or an external CLI (Codex/Claude). Used by {@link composeWorkflow} so it
 * works on ANY engine, including a plain-text external CLI that has no room
 * tools. Ported from `generate_text_any_engine` (workflow.rs 3653-3672).
 *
 * Rust's usage figure is discarded on the CLI branch and so is it here: this
 * one-shot text gateway is out of scope for the chat token-budget bar, per that
 * function's own comment. `strip_think_spans` is applied on the OLLAMA branch
 * only, exactly as in Rust (`run_external` already returns clean text).
 *
 * The one deliberate addition versus the Rust source is the injectable
 * {@link GenerateTextAnyEngineDeps} — the free Rust function reaches
 * `is_cli_engine`/`run_external`/`ollama::generate` directly, and there is no
 * subprocess or HTTP call to stand in for in a test without a seam.
 */
export async function generateTextAnyEngine(
  model: string,
  prompt: string,
  deps: GenerateTextAnyEngineDeps = {}
): Promise<string> {
  const msgs: SidecarChatMessage[] = [{ role: "user", content: prompt }];
  if (isCliEngine(model)) {
    const runCli = deps.runExternalCli ?? runExternalCliReal;
    const { text } = await runCli(model, msgs);
    return text;
  }
  const generate = deps.generateOllama ?? generateOllamaNotImplemented;
  const raw = await generate(model, msgs, COMPOSE_TEMPERATURE, KEEP_ALIVE_WARM);
  return stripThinkSpans(raw);
}

// ============================================================================
// parsing helpers (workflow.rs:2945-3038) — direct dependencies of
// compose_workflow that live earlier in the same file (see this module's doc).
// ============================================================================

/**
 * Parse a definition value into a {@link WorkflowDef}, mapping a parse failure
 * into a model-fixable sentence (unknown kind / missing field). Ported from
 * `parse_def`; wraps `workflowModel.ts`'s STRICT {@link parseWorkflowDef} the
 * same way Rust's `parse_def` wraps `serde_json::from_value`, and THROWS where
 * Rust returns `Err` — the convention `parseWorkflowDef` itself already sets.
 */
export function parseDef(v: unknown): WorkflowDef {
  try {
    return parseWorkflowDef(v);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(
      `The workflow definition is malformed (${detail}). Each node needs a unique id and a valid kind ` +
        "(generate, summarize_file, file_pass, agent_run, save_file, condition) with its params."
    );
  }
}

/**
 * Human label for a step kind — mirrors `KIND_LABELS` in
 * `src/workspace/workflows/kinds.ts` (Rust's own comment; that frontend module
 * is outside this migration's scope). Kept in sync so the stored name and the
 * UI never diverge. Ported verbatim from `human_kind_label`.
 */
export function humanKindLabel(kind: string): string {
  switch (kind) {
    case "generate":
      return "Generate text";
    case "summarize_file":
      return "Summarize a file";
    case "file_pass":
      return "Full-file pass";
    case "for_each_file":
      return "For each file";
    case "agent_run":
      return "Ask the agent";
    case "extract":
      return "Extract fields";
    case "route":
      return "Route by content";
    case "vote":
      return "Vote / consensus";
    case "refine":
      return "Refine (critique loop)";
    case "plan_and_map":
      return "Plan & map";
    case "transform":
      return "Transform text";
    case "merge":
      return "Merge branches";
    case "http_fetch":
      return "Fetch a URL";
    case "script_run":
      return "Run a script";
    case "save_file":
      return "Save a file";
    case "condition":
      return "Condition";
    default:
      // Rust's `other.replace('_', " ")` replaces EVERY occurrence.
      return kind.split("_").join(" ");
  }
}

/**
 * Ensure every node in a definition JSON carries a non-empty human `label`.
 * AI-composed definitions (and the agent's `save_workflow` tool) emit only `id`
 * + `kind`, so their steps would open with a blank "Step name" field even
 * though the canvas shows the kind. Backfilling the RAW JSON at persist time —
 * rather than the parsed struct, which isn't what gets stored — makes the saved
 * name real and consistent across the canvas, the inspector and validation.
 * Ported from `backfill_node_labels`; mutates its argument IN PLACE, exactly
 * like Rust's `&mut serde_json::Value`.
 *
 * The only key written is the fixed literal `"label"` — never a model-chosen
 * one — so no `Object.create(null)`/`Map` guard is needed on the write side;
 * the reads are own-key guarded all the same.
 */
export function backfillNodeLabels(defVal: unknown): void {
  if (!isPlainObject(defVal)) {
    return;
  }
  const nodes = ownProp(defVal, "nodes");
  if (!Array.isArray(nodes)) {
    return;
  }
  for (const node of nodes) {
    if (!isPlainObject(node)) {
      continue;
    }
    const labelVal = ownProp(node, "label");
    const blank = typeof labelVal === "string" ? labelVal.trim() === "" : true;
    if (blank) {
      const kindVal = ownProp(node, "kind");
      node.label = humanKindLabel(typeof kindVal === "string" ? kindVal : "");
    }
  }
}

/**
 * Parse a binding value, defaulting to general on absence or anything
 * malformed — NEVER throws. Ported from `parse_binding`
 * (`v.and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or(General{})`):
 * this is the LOOSE reader, a thin "never fails" wrapper over the same strict
 * parser, distinct from `workflowModel.ts`'s throwing
 * {@link parseWorkflowBinding} which it reuses rather than duplicates.
 */
export function parseBinding(v: unknown): WorkflowBinding {
  try {
    return parseWorkflowBinding(v);
  } catch {
    return { scope: "general" };
  }
}

export interface ValidateWorkflowInnerDeps {
  /** `ollama::list_models().await.unwrap_or_default()` — real by default.
   * `engineRouting.ts`'s {@link listModels} folds EVERY failure to `[]`, which
   * is exactly what `unwrap_or_default()` does. */
  listModels?: () => Promise<string[]>;
}

/**
 * Compile-check a def+binding against the palette, returning the numbered error
 * list (empty = valid). Shared by save/update, the validate-only command and
 * compose. Ported from `validate_workflow_inner` (workflow.rs 3021-3038) — the
 * binding/definition gate short-circuits BEFORE any model list is fetched, just
 * as the Rust `if let Err(errs) = … { return errs; }` does.
 */
export async function validateWorkflowInner(
  db: Database.Database,
  def: WorkflowDef,
  binding: WorkflowBinding,
  deps: ValidateWorkflowInnerDeps = {}
): Promise<string[]> {
  const base = validateWithBinding(def, binding);
  if (!base.ok) {
    return [...base.errors];
  }
  const roomModel = modelSetting(db);
  const models = await (deps.listModels ?? listModelsReal)();
  const compiled = compileWorkflow(def, roomModel, models);
  return compiled.ok ? [] : [...compiled.errors];
}

// ============================================================================
// ScheduleArg / schedule_from_args (workflow.rs:3098-3111, 3473-3493)
// ============================================================================

/** Ported from `ScheduleArg` (`#[serde(rename_all = "camelCase")]`; `param`
 * defaults to `""`, `enabled` and `catchUp` to `true` via `#[serde(default =
 * "yes")]`). */
export interface ScheduleArg {
  kind: string;
  param: string;
  enabled: boolean;
  catchUp: boolean;
}

/**
 * Read an optional `schedule` object out of a compose/tool-args value. An
 * absent `schedule`, an explicitly null one, one that isn't an object, or one
 * with no string `kind` all read as "no schedule" (Rust's `None`) — matching
 * `schedule_from_args`'s chain of `?`s, which abandons the WHOLE read the
 * moment any of those fails.
 *
 * `catchUp`/`catch_up` precedence mirrors Rust's
 * `.get("catchUp").or_else(|| s.get("catch_up"))`: `or_else` fires only on an
 * ABSENT key, so a PRESENT `catchUp` wins even when its value fails to decode
 * as a bool (in which case the `true` default applies) — `catch_up` is consulted
 * only when `catchUp` is entirely absent.
 */
export function scheduleFromArgs(args: unknown): ScheduleArg | null {
  if (!isPlainObject(args)) {
    return null;
  }
  const s = ownProp(args, "schedule");
  if (s === undefined || s === null || !isPlainObject(s)) {
    return null;
  }
  const kind = ownProp(s, "kind");
  if (typeof kind !== "string") {
    return null;
  }
  const param = ownProp(s, "param");
  const enabled = ownProp(s, "enabled");
  const catchUp = hasOwn(s, "catchUp") ? ownProp(s, "catchUp") : ownProp(s, "catch_up");
  return {
    kind,
    param: typeof param === "string" ? param : "",
    enabled: typeof enabled === "boolean" ? enabled : true,
    catchUp: typeof catchUp === "boolean" ? catchUp : true,
  };
}

// ============================================================================
// apply_schedule (workflow.rs:3060-3096)
// ============================================================================

/**
 * Set (or clear, `kind === ""`) a workflow's schedule. Refuses a run_input def
 * (it needs a chosen file, so it can't be scheduled) and an invalid schedule
 * spec. Ported from `apply_schedule`, synchronous here because neither
 * {@link nextRunFromNow} nor {@link upsertSchedule} awaits anything — this
 * migration's settled convention for a `state.with_room(|room| …)` closure with
 * no internal await. Throws (never a silent no-op) exactly where Rust returns
 * `Err`.
 */
export function applySchedule(
  db: Database.Database,
  workflowId: string,
  def: WorkflowDef,
  kind: string,
  param: string,
  enabled: boolean,
  catchUp: boolean
): void {
  if (kind === "") {
    upsertSchedule(db, workflowId, "", "", true, true, null);
    return;
  }
  if (defUsesRunInput(def)) {
    throw new Error("This workflow runs on a chosen file — it can't be scheduled.");
  }
  if (nextRunFromNow(kind, param) === null) {
    throw new Error("That schedule is invalid — check the time or interval.");
  }
  const next = enabled ? nextRunFromNow(kind, param) : null;
  upsertSchedule(db, workflowId, kind, param, enabled, catchUp, next);
}

// ============================================================================
// compose_workflow (workflow.rs:3674-3766)
// ============================================================================

/** `compose_workflow`'s own empty-description refusal. */
export const DESCRIBE_WORKFLOW_EMPTY = "Describe the workflow you want.";

/** `let _ = window.emit(...)` — a best-effort UI notification that must never
 * turn a successful compose into a failed one. Same narrowest-possible shape as
 * `docxEdit.ts`'s/`organizeTools.ts`'s/`skillsCmds.ts`'s own `EmitFn`. */
export type EmitFn = (event: string, payload: unknown) => void;

function emitSafely(emit: EmitFn | undefined, event: string, payload: unknown): void {
  try {
    emit?.(event, payload);
  } catch {
    // Swallowed deliberately, matching Rust's `let _ = window.emit(...)`.
  }
}

export interface ComposeWorkflowDeps {
  /** `generate_text_any_engine(&model, &prompt)` — defaults to this module's
   * own {@link generateTextAnyEngine} with ITS defaults (real CLI branch,
   * honestly-refusing Ollama branch). One injectable seam, so the whole
   * retry/validate/save loop is testable with no subprocess and no network. */
  generate?: (model: string, prompt: string) => Promise<string>;
  /** `ollama::list_models().await.unwrap_or_default()` — real by default.
   * Threaded into {@link validateWorkflowInner} too, so the port makes the same
   * TWO separate calls the Rust source makes (model resolution, then
   * validation) rather than memoizing across them. */
  listModels?: () => Promise<string[]>;
  /** `state.rolling_back()` — see this module's doc for why no live flag is
   * wired through yet. Defaults to "never busy". */
  isRollingBack?: () => boolean;
}

/**
 * Turn a plain-language description into a saved DRAFT workflow,
 * engine-agnostically. Asks the model for the definition JSON as TEXT (not a
 * tool call — so it works even with an external CLI that has no room tools),
 * recovers/validates it (one repair retry), and saves it for review. Returns the
 * new workflow's id so the UI can open it. Ported from `compose_workflow`
 * (workflow.rs 3679-3766), minus the `#[tauri::command]` wrapper's `window`/
 * `AppState` plumbing (see this module's doc, and
 * {@link registerWorkflowComposeIpc} for the wrapper).
 *
 * FIDELITY NOTE, load-bearing: a {@link ComposeWorkflowDeps.generate} FAILURE —
 * the generate call itself rejecting, not the model answering badly —
 * propagates straight OUT, exactly like Rust's
 * `generate_text_any_engine(&model, &prompt).await?`. It is deliberately NOT
 * one of the retryable modes; only a bad JSON parse, a missing `definition`, an
 * unparseable definition and a failed validation feed `lastErr` and continue.
 *
 * What gets STORED is the BACKFILLED RAW JSON (`&definition`), never a
 * round-trip of the parsed struct — matching Rust, and the reason
 * `backfill_node_labels` operates on the raw value in the first place.
 */
export async function composeWorkflow(
  db: Database.Database,
  descriptionRaw: string,
  deps: ComposeWorkflowDeps = {},
  emit?: EmitFn
): Promise<string> {
  const description = descriptionRaw.trim();
  if (description === "") {
    throw new Error(DESCRIBE_WORKFLOW_EMPTY);
  }
  if ((deps.isRollingBack ?? (() => false))()) {
    throw new Error(ROLLBACK_BUSY);
  }

  const listModels = deps.listModels ?? listModelsReal;
  const generate = deps.generate ?? ((m: string, p: string) => generateTextAnyEngine(m, p));

  const roomModel = modelSetting(db);
  const models = await listModels();
  const model =
    roomModel !== null && roomModel.trim() !== "" ? roomModel : defaultResolvedModel(null, models);

  const base = composePrompt(description);
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      attempt === 0
        ? base
        : `${base}\n\nYour previous attempt was rejected: ${lastErr}\nReturn corrected JSON only.`;

    // No try/catch on purpose — see this function's doc: Rust's `?`.
    const raw = await generate(model, prompt);
    const json = recoverJson(raw);

    let val: unknown;
    try {
      val = JSON.parse(json);
    } catch (e) {
      lastErr = `output was not valid JSON (${e instanceof Error ? e.message : String(e)})`;
      continue;
    }

    // Rust reads through `serde_json::Value::get`, which answers `None` for a
    // non-object as well as for a missing key — both land on the same feedback.
    const obj = isPlainObject(val) ? val : null;
    const definition = obj === null ? undefined : ownProp(obj, "definition");
    if (definition === undefined) {
      lastErr = "the JSON had no `definition` object";
      continue;
    }
    // Mutates in place: `definition` is a fresh sub-tree of the just-parsed
    // `val`, aliased nowhere else, so no defensive clone is needed (Rust clones
    // only because `.get()` hands back a borrow it cannot mutate).
    backfillNodeLabels(definition);

    let def: WorkflowDef;
    try {
      def = parseDef(definition);
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      continue;
    }

    const binding = parseBinding(obj === null ? undefined : ownProp(obj, "binding"));
    const errs = await validateWorkflowInner(db, def, binding, { listModels });
    if (errs.length > 0) {
      lastErr = errs.join("; ");
      continue;
    }

    const nameVal = obj === null ? undefined : ownProp(obj, "name");
    const name = typeof nameVal === "string" && nameVal.trim() !== "" ? nameVal.trim() : "New workflow";
    const emojiVal = obj === null ? undefined : ownProp(obj, "emoji");
    const emoji = typeof emojiVal === "string" && emojiVal.trim() !== "" ? emojiVal.trim() : "✨";
    const descVal = obj === null ? undefined : ownProp(obj, "description");
    const descField = typeof descVal === "string" ? descVal.trim() : "";

    const id = createWorkflow(db, name, descField, emoji, definition, "agent", binding);

    const schedule = scheduleFromArgs(obj);
    if (schedule !== null) {
      applySchedule(db, id, def, schedule.kind, schedule.param, schedule.enabled, schedule.catchUp);
    }
    emitSafely(emit, "workflows-changed", undefined);
    return id;
  }
  throw new Error(
    `Couldn't compose a valid workflow (${lastErr}). Try describing it more specifically.`
  );
}

// ============================================================================
// test_run_trailer / clamp_test_report (workflow.rs:4135-4168) — small pure
// helpers `agent_test_workflow` (Batch C's territory) will need.
// ============================================================================

/**
 * The machine-checkable verdict line, so the model cannot paraphrase a failing
 * run into "Fixed" — nor, since 2026-07-25, a still-running one into "broken".
 * Ported verbatim from `test_run_trailer`; all four strings are pinned in full
 * by the test against compiled `rustc` output (see this module's doc for the
 * drift a prefix-only assertion missed).
 */
export function testRunTrailer(status: string): string {
  switch (status) {
    case "done":
      return "VALIDATED: yes — every step ran to completion. You may now tell the user this works and the draft is ready to review & activate.";
    // Why it parked is on the PAUSED line above — an unapproved script, or a
    // Stop. Either way nothing was validated, and neither reason is a step to go
    // and rewrite.
    case "paused":
      return "VALIDATED: no — the run parked before finishing (the PAUSED line above says why), so it did NOT validate the workflow. Do NOT say it's fixed or works, and do NOT start editing steps. If a script needs approving, tell the user to review and run it on the Scripts page; a script can only be confirmed by an approved run.";
    // A timeout is UNKNOWN, not failed: nothing errored, we simply stopped
    // waiting. Telling the model to "fix the failing step" made it report a
    // failure to the user for a run that went on to finish green.
    case "timeout":
      return "VALIDATED: unknown — nothing failed; the run was still going when the wait ended. Do NOT call it broken and do NOT start fixing steps. Tell the user it is still running and they can watch it finish on the Workflows page.";
    default:
      return "VALIDATED: no — this run did not succeed. Fix the failing step with update_workflow and test again. Do NOT tell the user it's fixed or ready until a test_workflow returns VALIDATED: yes.";
  }
}

/** Rust's `const MAX: usize = 6000` — a count of UTF-8 BYTES, not of JS's
 * UTF-16 code units. */
const MAX_TEST_REPORT_BYTES = 6000;

/**
 * Bound the test report so a chatty run can't blow the tool-result budget.
 * Ported from `clamp_test_report`, reproducing its BYTE (not code-unit) budget
 * via `Buffer` and cutting only on a scalar-value boundary so a multi-byte
 * character is never sliced in half.
 */
export function clampTestReport(s: string): string {
  const byteLength = Buffer.byteLength(s, "utf8");
  if (byteLength <= MAX_TEST_REPORT_BYTES) {
    return s;
  }
  // The largest UTF-8 byte offset AT a character boundary that is still <= MAX
  // — Rust's `s.char_indices().map(|(i,_)| i).take_while(|&i| i <= MAX).last()`.
  let cut = 0;
  let offset = 0;
  for (const ch of s) {
    if (offset > MAX_TEST_REPORT_BYTES) {
      break;
    }
    cut = offset;
    offset += Buffer.byteLength(ch, "utf8");
  }
  if (cut === 0) {
    // Rust's own `if cut == 0 { cut = s.len(); }`. PROVABLY unreachable at this
    // cap — the first character's start offset is always 0, and one scalar value
    // is at most 4 UTF-8 bytes, so a string long enough to reach here always has
    // a later character starting at some offset in (0, 6000]. Reproduced anyway
    // rather than "simplified away": if MAX ever shrinks below 4, the fallback is
    // what keeps this from returning a bare "…".
    cut = byteLength;
  }
  return `${Buffer.from(s, "utf8").toString("utf8", 0, cut)}…\n(report truncated)`;
}

// ============================================================================
// builtin_templates (workflow.rs:4259-4424)
// ============================================================================

/**
 * One prebuilt gallery template. Matches the renderer's own
 * `apiTypes.ts::WorkflowTemplate` (the shape `workflow_templates` already
 * returns), except that `definition` stays RAW wire JSON rather than a parsed
 * {@link WorkflowDef}: Rust's return type is `Vec<serde_json::Value>`, and these
 * literals legitimately omit optional keys (an edge with no `branch`) that only
 * {@link parseWorkflowDef} normalizes.
 */
export interface WorkflowTemplate {
  name: string;
  description: string;
  emoji: string;
  binding: WorkflowBinding;
  schedule?: ScheduleArg;
  definition: {
    version: number;
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
  };
}

/**
 * Prebuilt workflows for the empty-state gallery. The JSON doubles as the
 * agent's few-shot examples (one is embedded in `save_workflow`'s spec — see
 * `toolSpecs.ts`'s `workflowToolsSpecs`). Ported VERBATIM from
 * `builtin_templates`, which its own doc comment calls "Four prebuilt
 * workflows" while defining SEVEN — ported as found, not as described.
 */
export function builtinTemplates(): WorkflowTemplate[] {
  return [
    // Morning digest — condition on new files → digest → save (daily 08:00).
    {
      name: "Morning digest",
      description: "Each morning, if new files arrived, write a short digest of them.",
      emoji: "🌅",
      binding: { scope: "general" },
      schedule: { kind: "daily", param: "08:00", enabled: true, catchUp: true },
      definition: {
        version: 1,
        nodes: [
          { id: "check", label: "Any new files?", kind: "condition", op: "new_files_since_last_run" },
          {
            id: "digest",
            label: "Write the digest",
            kind: "generate",
            model: "auto",
            prompt:
              "Write a short, friendly morning digest of what's new in this room. Files:\n{{files}}\nKeep it to a few bullet points.",
          },
          {
            id: "save",
            label: "Save the page",
            kind: "save_file",
            name_template: "Morning digest {{date}}",
            format: "html",
            mode: "create",
          },
        ],
        edges: [
          { from: "check", to: "digest", branch: "then" },
          { from: "digest", to: "save" },
        ],
      },
    },
    // New-file summarizer — index every still-missing file (interval 30 min).
    {
      name: "New-file summarizer",
      description: "Keep every file's one-line description up to date.",
      emoji: "📥",
      binding: { scope: "general" },
      schedule: { kind: "interval", param: "30", enabled: true, catchUp: false },
      definition: {
        version: 1,
        nodes: [
          {
            id: "index",
            label: "Summarize new files",
            kind: "summarize_file",
            select: { type: "missing_summary" },
          },
        ],
        edges: [],
      },
    },
    // Weekly review — what changed this week (weekly Fri 16:00).
    {
      name: "Weekly review",
      description: "A Friday review of what changed and the open questions.",
      emoji: "📅",
      binding: { scope: "general" },
      schedule: { kind: "weekly", param: "5 16:00", enabled: true, catchUp: true },
      definition: {
        version: 1,
        nodes: [
          {
            id: "review",
            label: "Write the review",
            kind: "generate",
            model: "auto",
            prompt:
              "Given these files, write a weekly review: what changed this week and the open questions.\n{{files}}",
          },
          {
            id: "save",
            label: "Save the review",
            kind: "save_file",
            name_template: "Weekly review {{date}}",
            format: "html",
            mode: "create",
          },
        ],
        edges: [{ from: "review", to: "save" }],
      },
    },
    // Deep read — a full pass over the newest file (manual; run from Actions).
    {
      name: "Deep read",
      description: "Read a whole file end to end and save a thorough summary.",
      emoji: "📖",
      binding: { scope: "general" },
      definition: {
        version: 1,
        nodes: [
          {
            id: "pass",
            label: "Full pass",
            kind: "file_pass",
            select: { type: "newest" },
            instruction: "Summarize this file thoroughly — every section, name and figure.",
            mode: "merge",
          },
        ],
        edges: [],
      },
    },
    // Compare perspectives — a DIAMOND: one brief fans out to two parallel
    // reads, which a merge re-joins (fan-out + fan-in, the sectioning pattern).
    {
      name: "Compare perspectives",
      description: "Look at the room from two angles at once, then combine them.",
      emoji: "⚖️",
      binding: { scope: "general" },
      definition: {
        version: 1,
        nodes: [
          {
            id: "brief",
            label: "Gather the material",
            kind: "generate",
            model: "auto",
            prompt: "Briefly summarize what's in this room:\n{{files}}",
          },
          {
            id: "pro",
            label: "The optimistic read",
            kind: "generate",
            model: "auto",
            prompt: "Argue the OPTIMISTIC case about this:\n{{input}}",
          },
          {
            id: "con",
            label: "The skeptical read",
            kind: "generate",
            model: "auto",
            prompt: "Argue the SKEPTICAL case about this:\n{{input}}",
          },
          { id: "merge", label: "Combine both", kind: "merge", mode: "numbered" },
          {
            id: "save",
            label: "Save the memo",
            kind: "save_file",
            name_template: "Two views {{date}}",
            format: "html",
            mode: "create",
          },
        ],
        edges: [
          { from: "brief", to: "pro" },
          { from: "brief", to: "con" },
          { from: "pro", to: "merge" },
          { from: "con", to: "merge" },
          { from: "merge", to: "save" },
        ],
      },
    },
    // Summarize every file — for_each_file sectioning over the whole room.
    {
      name: "Summarize every file",
      description: "Write a short summary of every file, then save one page.",
      emoji: "🗂️",
      binding: { scope: "general" },
      definition: {
        version: 1,
        nodes: [
          {
            id: "each",
            label: "Read each file",
            kind: "for_each_file",
            model: "auto",
            select: { type: "all" },
            instruction: "Summarize this file in a short paragraph.",
          },
          {
            id: "save",
            label: "Save the digest",
            kind: "save_file",
            name_template: "File digest {{date}}",
            format: "md",
            mode: "create",
          },
        ],
        edges: [{ from: "each", to: "save" }],
      },
    },
    // Triage the newest note — a ROUTE fans to three specialized handlers that
    // re-converge on a save (N-way routing pattern).
    {
      name: "Triage the newest note",
      description: "Sort the newest file into a bucket and act on it.",
      emoji: "🧭",
      binding: { scope: "general" },
      definition: {
        version: 1,
        nodes: [
          { id: "read", label: "Read newest", kind: "summarize_file", select: { type: "newest" } },
          {
            id: "route",
            label: "Which bucket?",
            kind: "route",
            prompt: "Which bucket does this belong in?",
            labels: ["action", "reference", "idea"],
          },
          {
            id: "act",
            label: "Make a checklist",
            kind: "generate",
            model: "auto",
            prompt: "Turn this into a short action checklist:\n{{input}}",
          },
          {
            id: "ref",
            label: "Note the reference",
            kind: "generate",
            model: "auto",
            prompt: "Write a one-line reference note for this:\n{{input}}",
          },
          {
            id: "idea",
            label: "Expand the idea",
            kind: "generate",
            model: "auto",
            prompt: "Expand this idea into a paragraph:\n{{input}}",
          },
          {
            id: "save",
            label: "Save it",
            kind: "save_file",
            name_template: "Triage {{date}}",
            format: "html",
            mode: "create",
          },
        ],
        edges: [
          { from: "read", to: "route" },
          { from: "route", to: "act", branch: "action" },
          { from: "route", to: "ref", branch: "reference" },
          { from: "route", to: "idea", branch: "idea" },
          { from: "act", to: "save" },
          { from: "ref", to: "save" },
          { from: "idea", to: "save" },
        ],
      },
    },
  ];
}

/** `#[tauri::command] workflow_templates` (workflow.rs 3461-3464): the prebuilt
 * template gallery (empty-state) — also the agent's few-shot set. */
export function workflowTemplates(): WorkflowTemplate[] {
  return builtinTemplates();
}

// ============================================================================
// the #[tauri::command] half
// ============================================================================

/** The slice of room state these handlers need: whichever room is open RIGHT
 * NOW, not whatever was open when {@link registerWorkflowComposeIpc} ran.
 * Mirrors `recIpc.ts`'s own `RoomSource` rather than importing it, so this
 * module has no runtime dependency on that one. */
export interface RoomSource {
  currentRoom(): OpenRoom | null;
}

/** `AppState::with_room`'s own refusal, spelled the way `recIpc.ts`,
 * `docxEdit.ts` and `skillsCmds.ts` already spell it. */
const NO_ROOM_OPEN = "No room is open.";

function openDb(room: RoomSource): Database.Database {
  const open = room.currentRoom();
  if (open === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  return open.db;
}

/**
 * Register this slice's two `#[tauri::command]`s on `ipcMain`, under the exact
 * channel names `src/api.ts` already invokes (`compose_workflow` at line 782,
 * `workflow_templates` at 749), so the renderer needs no rename. `ipcMain` is a
 * PARAMETER, typed against the real `electron` module without importing it at
 * runtime, so this file resolves and tests under plain Node/vitest — the
 * `registerRecIpc`/`registerDocxEditIpc` precedent.
 *
 * Exported and directly testable, but — same as those two — NOT called from any
 * live main-process entrypoint by this batch. Wiring it in is Phase 2 work
 * pending an explicit owner go-ahead.
 */
export function registerWorkflowComposeIpc(
  ipcMain: Pick<IpcMain, "handle">,
  room: RoomSource,
  deps: ComposeWorkflowDeps = {},
  emit?: EmitFn
): void {
  ipcMain.handle("workflow_templates", (_event: IpcMainInvokeEvent) => workflowTemplates());
  ipcMain.handle(
    "compose_workflow",
    (_event: IpcMainInvokeEvent, args: { description: string }) =>
      composeWorkflow(openDb(room), args.description, deps, emit)
  );
}
