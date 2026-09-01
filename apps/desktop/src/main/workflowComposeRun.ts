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
import {
  composePrompt,
  generateTextAnyEngine,
  isPlainObject,
  ownProp,
  recoverJson,
} from "./workflowComposeCore.js";
import {
  applySchedule,
  backfillNodeLabels,
  parseBinding,
  parseDef,
  scheduleFromArgs,
  validateWorkflowInner,
} from "./workflowComposeParsing.js";

// ============================================================================
// compose_workflow (workflow.rs:3674-3766)
// ============================================================================

/** `compose_workflow`'s own empty-description refusal. */
export const DESCRIBE_WORKFLOW_EMPTY = "Describe the workflow you want.";

/** `let _ = window.emit(...)` — a best-effort UI notification that must never
 * turn a successful compose into a failed one. Same narrowest-possible shape as
 * `docxEdit.ts`'s/`organizeTools.ts`'s/`skillsCmds.ts`'s own `EmitFn`. */
export type EmitFn = (event: string, payload: unknown) => void;

export function emitSafely(emit: EmitFn | undefined, event: string, payload: unknown): void {
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

export interface ParsedComposeResponse {
  readonly object: Record<string, unknown> | null;
  readonly definition: unknown;
}

export type ComposeParseResult<T> = { readonly value: T } | { readonly error: string };

export function composeDescription(descriptionRaw: string): string {
  const description = descriptionRaw.trim();
  if (description === "") throw new Error(DESCRIBE_WORKFLOW_EMPTY);
  return description;
}

export function assertComposeNotRollingBack(deps: ComposeWorkflowDeps): void {
  const isRollingBack = deps.isRollingBack ?? (() => false);
  if (isRollingBack()) throw new Error(ROLLBACK_BUSY);
}

export function composeGenerate(deps: ComposeWorkflowDeps): (model: string, prompt: string) => Promise<string> {
  return deps.generate ?? generateTextAnyEngine;
}

export async function composeModel(db: Database.Database, deps: ComposeWorkflowDeps): Promise<{
  readonly model: string;
  readonly listModels: () => Promise<string[]>;
}> {
  const listModels = deps.listModels ?? listModelsReal;
  const roomModel = modelSetting(db);
  const models = await listModels();
  const model = roomModel !== null && roomModel.trim() !== ""
    ? roomModel
    : defaultResolvedModel(null, models);
  return { model, listModels };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseComposeResponse(raw: string): ComposeParseResult<ParsedComposeResponse> {
  try {
    const value: unknown = JSON.parse(recoverJson(raw));
    const object = isPlainObject(value) ? value : null;
    return { value: { object, definition: object === null ? undefined : ownProp(object, "definition") } };
  } catch (error) {
    return { error: `output was not valid JSON (${errorMessage(error)})` };
  }
}

export function parseComposedDefinition(definition: unknown): ComposeParseResult<WorkflowDef> {
  if (definition === undefined) return { error: "the JSON had no `definition` object" };
  backfillNodeLabels(definition);
  try {
    return { value: parseDef(definition) };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

export function composeOwnValue(object: Record<string, unknown> | null, key: string): unknown {
  return object === null ? undefined : ownProp(object, key);
}

export function nonblankComposeText(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const text = value.trim();
  return text === "" ? fallback : text;
}

export function composeDescriptionField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function composeAttemptPrompt(base: string, attempt: number, lastError: string): string {
  return attempt === 0
    ? base
    : `${base}\n\nYour previous attempt was rejected: ${lastError}\nReturn corrected JSON only.`;
}

export function saveComposedWorkflow(
  db: Database.Database,
  response: ParsedComposeResponse,
  definition: unknown,
  def: WorkflowDef,
): string {
  const name = nonblankComposeText(composeOwnValue(response.object, "name"), "New workflow");
  const emoji = nonblankComposeText(composeOwnValue(response.object, "emoji"), "✨");
  const description = composeDescriptionField(composeOwnValue(response.object, "description"));
  const binding = parseBinding(composeOwnValue(response.object, "binding"));
  const id = createWorkflow(db, name, description, emoji, definition, "agent", binding);
  const schedule = scheduleFromArgs(response.object);
  if (schedule !== null) {
    applySchedule(db, id, def, schedule.kind, schedule.param, schedule.enabled, schedule.catchUp);
  }
  return id;
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
  const description = composeDescription(descriptionRaw);
  assertComposeNotRollingBack(deps);
  const { model, listModels } = await composeModel(db, deps);
  const generate = composeGenerate(deps);
  const base = composePrompt(description);
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = composeAttemptPrompt(base, attempt, lastError);
    // No try/catch on purpose — see this function's doc: Rust's `?`.
    const raw = await generate(model, prompt);
    const response = parseComposeResponse(raw);
    if ("error" in response) {
      lastError = response.error;
      continue;
    }
    // Mutates in place: `definition` is a fresh sub-tree of the just-parsed
    // `val`, aliased nowhere else, so no defensive clone is needed (Rust clones
    // only because `.get()` hands back a borrow it cannot mutate).
    const parsedDefinition = parseComposedDefinition(response.value.definition);
    if ("error" in parsedDefinition) {
      lastError = parsedDefinition.error;
      continue;
    }
    const binding = parseBinding(composeOwnValue(response.value.object, "binding"));
    const errs = await validateWorkflowInner(db, parsedDefinition.value, binding, { listModels });
    if (errs.length > 0) {
      lastError = errs.join("; ");
      continue;
    }
    const id = saveComposedWorkflow(db, response.value, response.value.definition, parsedDefinition.value);
    emitSafely(emit, "workflows-changed", undefined);
    return id;
  }
  throw new Error(
    `Couldn't compose a valid workflow (${lastError}). Try describing it more specifically.`
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
export const MAX_TEST_REPORT_BYTES = 6000;

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
  return `${Buffer.from(s, "utf8").toString("utf8", 0, cut)}…\n(report truncated)`;
}
