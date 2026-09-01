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
import { hasOwn, isPlainObject, ownProp } from "./workflowComposeCore.js";

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
export const HUMAN_KIND_LABELS: ReadonlyMap<string, string> = new Map([
  ["generate", "Generate text"],
  ["summarize_file", "Summarize a file"],
  ["file_pass", "Full-file pass"],
  ["for_each_file", "For each file"],
  ["agent_run", "Ask the agent"],
  ["extract", "Extract fields"],
  ["route", "Route by content"],
  ["vote", "Vote / consensus"],
  ["refine", "Refine (critique loop)"],
  ["plan_and_map", "Plan & map"],
  ["transform", "Transform text"],
  ["merge", "Merge branches"],
  ["http_fetch", "Fetch a URL"],
  ["script_run", "Run a script"],
  ["save_file", "Save a file"],
  ["condition", "Condition"],
]);

export function humanKindLabel(kind: string): string {
  // Rust's `other.replace('_', " ")` replaces EVERY occurrence.
  return HUMAN_KIND_LABELS.get(kind) ?? kind.split("_").join(" ");
}

export function nodesFromDefinition(defVal: unknown): unknown[] | null {
  if (!isPlainObject(defVal)) return null;
  const nodes = ownProp(defVal, "nodes");
  return Array.isArray(nodes) ? nodes : null;
}

export function needsNodeLabel(node: Record<string, unknown>): boolean {
  const label = ownProp(node, "label");
  return typeof label !== "string" || label.trim() === "";
}

export function fillNodeLabel(node: unknown): void {
  if (!isPlainObject(node) || !needsNodeLabel(node)) return;
  const kind = ownProp(node, "kind");
  node.label = humanKindLabel(typeof kind === "string" ? kind : "");
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
  const nodes = nodesFromDefinition(defVal);
  if (nodes === null) return;
  for (const node of nodes) fillNodeLabel(node);
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

export function scheduleObject(args: unknown): Record<string, unknown> | null {
  if (!isPlainObject(args)) return null;
  const schedule = ownProp(args, "schedule");
  return isPlainObject(schedule) ? schedule : null;
}

export function stringOrDefault(value: unknown, defaultValue = ""): string {
  return typeof value === "string" ? value : defaultValue;
}

export function booleanOrDefault(value: unknown, defaultValue = true): boolean {
  return typeof value === "boolean" ? value : defaultValue;
}

export function scheduleCatchUp(schedule: Record<string, unknown>): boolean {
  const value = hasOwn(schedule, "catchUp")
    ? ownProp(schedule, "catchUp")
    : ownProp(schedule, "catch_up");
  return booleanOrDefault(value);
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
  const schedule = scheduleObject(args);
  if (schedule === null) return null;
  const kind = ownProp(schedule, "kind");
  if (typeof kind !== "string") return null;
  return {
    kind,
    param: stringOrDefault(ownProp(schedule, "param")),
    enabled: booleanOrDefault(ownProp(schedule, "enabled")),
    catchUp: scheduleCatchUp(schedule),
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
