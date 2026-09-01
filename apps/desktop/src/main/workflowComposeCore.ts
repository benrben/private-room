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
 * WHAT IS REAL — INCLUDING THE ONCE-HONEST SEAM, NOW CLOSEABLE
 * ============================================================================
 * `ollama::generate` (`ollama.rs` lines 408-418 — the actual `/api/generate`
 * HTTP call) has SINCE LANDED as `ollamaGenerate.ts`'s {@link realOllamaGenerate}.
 * {@link withRealOllamaGenerate} installs it into {@link GenerateTextAnyEngineDeps}
 * for any caller that hasn't supplied its own — a host bootstrap should build
 * through it so `compose_workflow` composes through a local Ollama model, not
 * only an external CLI. `skillsCmds.ts`'s own module doc flags the same gap for
 * its unported `compose_skill`, and can now be closed the same way.
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
import { generate as realOllamaGenerate } from "./ollamaGenerate.js";
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

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `serde_json::Map::get` — an OWN-key read, returning `undefined` for a key the
 * object does not itself carry. Every lookup into model-authored JSON in this
 * file goes through here so nothing inherited from `Object.prototype` can be
 * read as something the model said (see this module's doc).
 */
export function ownProp(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

export function hasOwn(obj: Record<string, unknown>, key: string): boolean {
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
export const COMPOSE_PROMPT_PREFIX =
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

export function firstIndexOfAny(s: string, chars: string): number {
  let best = -1;
  for (const c of chars) {
    const idx = s.indexOf(c);
    if (idx !== -1 && (best === -1 || idx < best)) {
      best = idx;
    }
  }
  return best;
}

export function lastIndexOfAny(s: string, chars: string): number {
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
 * Fills {@link GenerateTextAnyEngineDeps.generateOllama} with the real,
 * committed `ollama.rs` port ({@link realOllamaGenerate} from
 * `ollamaGenerate.ts`) for any caller that has not already supplied its own —
 * the seam this module's doc said would be a drop-in once that batch landed,
 * confirmed by that batch's own type-check against {@link GenerateOllamaFn}.
 *
 * Purely additive, mirroring `execTool.ts`'s `withRealAdvisorCli`/
 * `withRealPrivacyGates`: every existing test that builds a bare
 * {@link GenerateTextAnyEngineDeps} object literal still exercises the
 * NOT_IMPLEMENTED seam unchanged, because nothing calls this on their behalf.
 * A real caller should build its deps through this
 * (`generateTextAnyEngine(model, prompt, withRealOllamaGenerate(deps))`) so
 * `compose_workflow` can compose through a local Ollama model, not only an
 * external CLI.
 */
export function withRealOllamaGenerate(deps: GenerateTextAnyEngineDeps): GenerateTextAnyEngineDeps {
  if (deps.generateOllama !== undefined) {
    return deps;
  }
  return { ...deps, generateOllama: realOllamaGenerate };
}

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
