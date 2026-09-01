/**
 * Wave 4a (Idea 2): the LLM graph workflow engine's DATA MODEL, VALIDATION and
 * COMPILER — the pure, in-memory half of the module. No DB, no sidecar, no file
 * I/O, no network: everything here is a deterministic function of its arguments,
 * and nothing here is stubbed.
 *
 * Ported from `src-tauri/src/commands/jobs/workflow.rs` LINES 1-1030 ONLY (the
 * file is 5855 lines). Everything from the `---- executor ----` banner at line
 * 1031 onward — `execute_workflow_step`, `edge_is_live`, `eval_condition`,
 * `apply_transform`/`apply_merge`, `clean_save_name`, `append_into_html`,
 * `compose_prompt`, `builtin_templates`, `WORKFLOW_NODE_REFERENCE`,
 * `spawn_workflow_job`, the scheduler/resume glue — is a LATER batch's
 * territory and is deliberately not touched here.
 *
 * ============================================================================
 * WIRE FORMAT — READ THIS BEFORE RENAMING A FIELD
 * ============================================================================
 * Unlike almost every other struct this migration has ported, NONE of
 * `WorkflowDef`/`WorkflowNode`/`NodeKind`/`WorkflowEdge`/`WorkflowBinding`/
 * `WorkflowPlan`/`WfArtifact` carries `#[serde(rename_all = "camelCase")]`.
 * Only the enum TAGS get `rename_all = "snake_case"` (`NodeKind`'s "kind"
 * values, `WorkflowBinding`'s "scope" values), plus one field-level
 * `#[serde(rename = "type")]` on `FileSelector.kind`. Every OTHER field
 * serializes under its literal Rust name, which is already snake_case
 * (`name_template` / `max_rounds` / `max_workers` / `file_id` / …).
 *
 * So this file uses those literal snake_case names rather than the migration's
 * usual camelCase, and that is load-bearing rather than cosmetic:
 * {@link compileWorkflow} embeds the whole `WorkflowNode` into a `Step`'s
 * `params`, and a job's plan is PERSISTED as JSON on the jobs row. A camelCase
 * `nameTemplate` here would write a plan the Rust executor, the resume path and
 * the step editor all fail to read. `WfArtifact` is the same story from the
 * other direction — it is parsed straight back out of `db::get_job_artifact`'s
 * stored JSON.
 *
 * `WorkflowNode`'s `#[serde(flatten)]` on `kind: NodeKind` means a node's JSON
 * is ONE flat object (`{"id":"a","label":"","kind":"generate","prompt":"x"}`),
 * not a nested `{"kind":{…}}`. Ported as an intersection type,
 * `WorkflowNode = { id, label } & NodeKind`, which reproduces that flat shape
 * exactly and still lets `switch (node.kind)` narrow every variant's fields
 * directly on `node`.
 *
 * ============================================================================
 * THE PARSE LAYER — WHAT `#[derive(Deserialize)]` DOES THAT HAS NO NAME
 * ============================================================================
 * The derive macro (not a function anyone can cite) is what applies every
 * `default_*` fn when a JSON key is absent. TypeScript has no equivalent, so
 * `parseWorkflowDef` / `parseWorkflowNode` / `parseWorkflowEdge` /
 * `parseWorkflowBinding` are this port's hand-written stand-in — the same thing
 * the Rust test module's own `fn parse(v) { serde_json::from_value(v).unwrap() }`
 * helper leans on. They are STRICT, matching serde: an ABSENT key gets the
 * field's default (or throws, for a field with no `#[serde(default…)]` at all),
 * and a key that is PRESENT but the wrong JSON type ALWAYS throws — serde's
 * `default` only ever fires on absence, never on a type mismatch. Never a
 * silent substitution either way.
 *
 * {@link parseWfArtifact} is the one deliberate exception: it reads the app's
 * OWN already-stored artifact JSON, so a wrong-typed field degrades to the
 * field default instead of throwing, matching `scriptConsent.ts`'s established
 * posture for reading back trusted stored state.
 *
 * A GENUINE, SUBTLE ROUGH EDGE PRESERVED ON PURPOSE: `FileSelector` derives
 * BOTH `Default` AND a field-level `#[serde(default = "sel_newest")]`, and the
 * two disagree. `sel_newest() == "newest"` fires only when a FileSelector
 * OBJECT is present but its own `"type"` key is missing. When the whole
 * `select` KEY is missing from a `summarize_file`/`file_pass`/`for_each_file`
 * node (whose field is a bare `#[serde(default)] select: FileSelector`), serde
 * calls the DERIVED `FileSelector::default()` instead, which builds each field
 * from its own type's `Default` — `String::default()`, i.e. `""`, NOT
 * `"newest"`. A node that omits `select` entirely therefore gets an EMPTY,
 * INVALID selector that {@link validateDefinition} then flags as
 * `unknown file selector ''`, while `"select": {}` correctly gets `"newest"`.
 * No Rust test exercises the fully-omitted case, so this is easy to "fix" by
 * accident. It is reproduced faithfully here
 * ({@link DEFAULT_FILE_SELECTOR_WHEN_KEY_ABSENT}) and pinned by two tests.
 *
 * ============================================================================
 * DEVIATIONS, ALL DELIBERATE
 * ============================================================================
 *  - Rust's `Result<(), Vec<String>>` / `Result<Vec<Step>, Vec<String>>` become
 *    discriminated-union return VALUES ({@link ValidationResult},
 *    {@link CompileResult}, {@link TopoOrderResult}) rather than thrown
 *    exceptions — `jobs.ts`'s `StepResult` and `editMatch.ts`'s
 *    `SectionRangeResult` are this codebase's convention for a `Result` that is
 *    an ordinary, expected outcome.
 *  - `resolve_node_model`, `topo_order` and `node_kind_tag` are module-private
 *    in Rust; its `#[cfg(test)] mod tests` reaches them anyway through
 *    `use super::*`. A separate `.test.ts` file has no such privilege, so the
 *    first two are exported here (`editMatch.ts` sets the same precedent).
 *  - `resolveNodeModel` returns `{ model, lane }` where Rust returns a
 *    `(String, Lane)` tuple — the `PreparedImage` precedent in
 *    `turnContext.ts`, chosen over the positional-tuple one because both
 *    components are read at every call site and a positional swap would be
 *    silent.
 *  - `WorkflowPlan.script_consents` is a `Map`, not a plain object, even though
 *    Rust's `HashMap<String,String>` serializes as a JSON object: its keys are
 *    room-controlled file ids. Whichever future batch persists a `WorkflowPlan`
 *    owns that one `Map` → object hop (and the `Step.dependsOn` ↔ `depends_on`
 *    hop `jobs.ts` already documents for itself).
 *  - `.trim()` stands in for Rust's `str::trim`. The two whitespace sets differ
 *    by exactly two code points nobody puts in a node id: JS also trims U+FEFF,
 *    Rust also trims U+0085.
 */

import type { Lane, Step } from "./jobs.js";
import { bestDefault } from "./turnContext.js";
import { bestLocalDefault } from "./ollamaModels.js";
import { runsOnThisMac } from "./capabilities.js";
import { scriptLangOf } from "./scriptRun.js";
import { extensionOf } from "./editMatchExtraction.js";

// ============================================================================
// definition (workflow.rs:19-308) — the named `default_*` fns, one constant
// each, so a default is never an unattributed literal at a use site.
// ============================================================================

/** `default_version()` — a definition with no `version` key reads as 1. */
export const DEFAULT_VERSION = 1;
/** `sel_newest()` — `FileSelector.type`'s default WHEN THE SELECTOR OBJECT IS
 * PRESENT. See {@link DEFAULT_FILE_SELECTOR_WHEN_KEY_ABSENT} for the other,
 * different, default. */
export const SEL_NEWEST = "newest";
/** `default_mode()` — `FilePass.mode`. */
export const DEFAULT_MODE = "merge";
/** `default_format()` — `SaveFile.format`. */
export const DEFAULT_FORMAT = "html";
/** `default_save_mode()` — `SaveFile.mode`. */
export const DEFAULT_SAVE_MODE = "create";
/** `default_script_mode()` — `ScriptRun.mode`. */
export const DEFAULT_SCRIPT_MODE = "import";
/** `default_merge_mode()` — `Merge.mode`. */
export const DEFAULT_MERGE_MODE = "concat";
/** `default_vote_mode()` — `Vote.mode`. */
export const DEFAULT_VOTE_MODE = "concat";
/** `default_samples()` — `Vote.samples`. */
export const DEFAULT_SAMPLES = 3;
/** `default_refine_rounds()` — `Refine.max_rounds`. */
export const DEFAULT_REFINE_ROUNDS = 2;
/** `default_max_workers()` — `PlanAndMap.max_workers`. */
export const DEFAULT_MAX_WORKERS = 4;

/** A file-choosing selector shared by summarize_file / file_pass /
 * for_each_file nodes. Ported from `FileSelector`; its Rust field is named
 * `kind` but `#[serde(rename = "type")]` puts it on the wire — and in this
 * port — as `type`. Values: newest | all | name_like | missing_summary |
 * since_last_run | run_input. */
export interface FileSelector {
  type: string;
  pattern: string | null;
}

/** The struct-level DERIVED `FileSelector::default()` a selector-typed field
 * falls back to when the KEY HOLDING IT is entirely absent — `""`, not
 * {@link SEL_NEWEST}. See this module's doc for why the two differ. */
export const DEFAULT_FILE_SELECTOR_WHEN_KEY_ABSENT: FileSelector = Object.freeze({
  type: "",
  pattern: null,
});

/**
 * The node palette. Ported from `NodeKind`
 * (`#[serde(tag = "kind", rename_all = "snake_case")]`) as a TS discriminated
 * union on the same `kind` strings, one variant per Rust variant, carrying the
 * variant's own params under their literal wire names.
 */
export type NodeKind =
  /** One model call. `model` = "" / "auto" (per-run resolve) | "local" |
   * "cloud" | an explicit name. */
  | { kind: "generate"; prompt: string; model: string }
  /** Cache a one-liner for the selected file(s). */
  | { kind: "summarize_file"; select: FileSelector }
  /** A real, durable child file_pass over ONE selected file. */
  | { kind: "file_pass"; select: FileSelector; instruction: string; mode: string }
  /** One headless agent turn. */
  | { kind: "agent_run"; question: string }
  /** Write the pipeline's output into the room as a new file. */
  | { kind: "save_file"; name_template: string; format: string; mode: string }
  /** A deterministic branch over the JOINED live input; its artifact records
   * branch then|else. There is deliberately no `input` field. */
  | { kind: "condition"; op: string; value: string | null }
  /** Run a `.py`/`.js` room script in a throwaway workspace. `mode` =
   * "import" (artifact is the run report) | "transform" (a pipe stage). */
  | { kind: "script_run"; file: string; mode: string }
  /** A deterministic text transform on the joined input — no model call. */
  | { kind: "transform"; op: string; find: string | null; value: string | null }
  /** A fan-in reducer: combine EVERY live incoming branch deterministically. */
  | { kind: "merge"; mode: string; separator: string | null }
  /** Deterministic HTTP GET of `url` (SSRF-guarded, readable text extracted). */
  | { kind: "http_fetch"; url: string }
  /** Structured output: pull named `fields` out of the input as JSON. */
  | { kind: "extract"; fields: string[]; model: string }
  /** Routing (fuzzy classifier): the model picks ONE of `labels`; the chosen
   * label is the taken branch (edges carry `branch: <label>`). */
  | { kind: "route"; prompt: string; labels: string[]; model: string }
  /** Parallelization–voting: run the same `prompt` `samples` times. */
  | { kind: "vote"; prompt: string; model: string; samples: number; mode: string }
  /** Parallelization–sectioning: run `instruction` against EACH selected file. */
  | { kind: "for_each_file"; select: FileSelector; instruction: string; model: string }
  /** Evaluator-optimizer: generate → evaluate against `rubric` → revise. */
  | { kind: "refine"; prompt: string; rubric: string; model: string; max_rounds: number }
  /** Orchestrator-workers: decompose `objective`, run a worker per subtask. */
  | { kind: "plan_and_map"; objective: string; model: string; max_workers: number };

/** Ported from `WorkflowNode`. `#[serde(flatten)]` on its `kind` field means
 * id/label and the variant's own fields share ONE flat JSON object; the
 * intersection type reproduces exactly that. */
export type WorkflowNode = { id: string; label: string } & NodeKind;

/** Ported from `WorkflowEdge`. `branch` is only legal off a condition
 * ("then"|"else") or a route (one of its own labels) — checked in
 * {@link validateDefinition}, not at parse time. */
export interface WorkflowEdge {
  from: string;
  to: string;
  branch: string | null;
}

/** The immutable workflow definition: a node palette + edges. Ported from
 * `WorkflowDef`. */
export interface WorkflowDef {
  version: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/** Shortcuts extension: where a workflow surfaces. `general` = top bar /
 * library only; `file` = the open-file header, run on that file. Ported from
 * `WorkflowBinding` (`#[serde(tag = "scope", rename_all = "snake_case")]`). */
export type WorkflowBinding =
  | { scope: "general" }
  | { scope: "file"; kinds: string[]; exts: string[]; file_id: string | null };

/**
 * The immutable plan snapshot stored on the jobs row — a later edit of the
 * workflow never corrupts a paused run. Ported from `WorkflowPlan`.
 *
 * A TYPE ONLY in this slice: nothing here constructs, parses or persists one
 * (that is `start_workflow_run`, past line 1031). `steps` is the RUNTIME
 * `Step[]` from `jobs.ts`, and `script_consents` is a `Map` — see this module's
 * doc for the two adapter hops the persisting batch will own.
 */
export interface WorkflowPlan {
  workflow_id: string;
  workflow_name: string;
  /** manual | schedule | catchup | agent — gates the terminal auto-open. */
  trigger: string;
  def: WorkflowDef;
  resolved_model: string;
  input_file_id: string | null;
  /** The previous run's start time — feeds `since_last_run` /
   * `new_files_since_last_run`. */
  prev_run_at: string | null;
  /** Per-script-node consent snapshot: script file id → approved SHA-256 of
   * the script bytes, stamped at ENQUEUE. */
  script_consents: Map<string, string>;
  steps: Step[];
}

/**
 * One workflow step's artifact. Ported from `WfArtifact` (private in Rust;
 * exported here because the executor batch and this file's tests both need it).
 * EVERY field is individually `#[serde(default)]`, so a bare `{}` — how a fresh
 * step's artifact reads before it has run — parses to all-defaults.
 *
 * `node_label`/`node_kind` additionally carry `skip_serializing_if =
 * "Option::is_none"`, which only affects WRITING an artifact; nothing in this
 * slice writes one.
 */
export interface WfArtifact {
  result: string;
  skipped: boolean;
  /** condition nodes: the taken branch. */
  branch: string | null;
  /** save_file / file_pass: the written file id (idempotent re-execution). */
  file_id: string | null;
  /** The node's human name + kind, stamped at store time so the run-history
   * view can label each step by its node (the compiled step order isn't the
   * def order, so the frontend can't derive this itself). */
  node_label: string | null;
  node_kind: string | null;
}

/** `WfArtifact::default()` — what `{}` parses to. */
export const DEFAULT_WF_ARTIFACT: WfArtifact = Object.freeze({
  result: "",
  skipped: false,
  branch: null,
  file_id: null,
  node_label: null,
  node_kind: null,
});

// ============================================================================
// the parse layer — this file's stand-in for `#[derive(Deserialize)]`.
// ============================================================================

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Own-property test only: `"toString" in obj` is true for every object, which
 * would make an absent key look present and skip its serde default. */
export function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** A field with NO `#[serde(default)]`: absent is a deserialize failure. */
export function requireString(obj: Record<string, unknown>, key: string, context: string): string {
  if (!hasOwn(obj, key)) {
    throw new Error(`${context}: missing required field '${key}'`);
  }
  const v = obj[key];
  if (typeof v !== "string") {
    throw new Error(`${context}: field '${key}' must be a string`);
  }
  return v;
}

/** `#[serde(default)]` / `#[serde(default = "…")]` on a `String` field. */
export function optString(obj: Record<string, unknown>, key: string, fallback: string, context: string): string {
  if (!hasOwn(obj, key)) return fallback;
  const v = obj[key];
  if (typeof v !== "string") {
    throw new Error(`${context}: field '${key}' must be a string`);
  }
  return v;
}

/** `#[serde(default)] Option<String>` — absent OR explicit `null` reads
 * `None`; anything else present is a type error, as serde would report. */
export function optStringOrNull(obj: Record<string, unknown>, key: string, context: string): string | null {
  if (!hasOwn(obj, key)) return null;
  const v = obj[key];
  if (v === null) return null;
  if (typeof v !== "string") {
    throw new Error(`${context}: field '${key}' must be a string or null`);
  }
  return v;
}

/** `#[serde(default = "…")]` on a `u32`. Present-but-fractional, negative or
 * past `u32::MAX` is a deserialize failure in Rust, so it throws here. */
export function optU32(obj: Record<string, unknown>, key: string, fallback: number, context: string): number {
  if (!hasOwn(obj, key)) return fallback;
  const v = obj[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 0xffff_ffff) {
    throw new Error(`${context}: field '${key}' must be an integer in 0..=u32::MAX`);
  }
  return v;
}

/** A `Vec<String>` field with no serde default (`Extract.fields`,
 * `Route.labels`). */
export function requireStringArray(obj: Record<string, unknown>, key: string, context: string): string[] {
  if (!hasOwn(obj, key)) {
    throw new Error(`${context}: missing required field '${key}'`);
  }
  const v = obj[key];
  if (!Array.isArray(v) || !v.every((x): x is string => typeof x === "string")) {
    throw new Error(`${context}: field '${key}' must be an array of strings`);
  }
  return v;
}

/** `#[serde(default)] Vec<String>` (`WorkflowBinding::File`'s kinds/exts). */
export function optStringArray(obj: Record<string, unknown>, key: string, context: string): string[] {
  if (!hasOwn(obj, key)) return [];
  const v = obj[key];
  if (!Array.isArray(v) || !v.every((x): x is string => typeof x === "string")) {
    throw new Error(`${context}: field '${key}' must be an array of strings`);
  }
  return v;
}

/** A FileSelector OBJECT that is actually present — `sel_newest()` applies
 * here, to a MISSING `"type"` subfield. */
export function parseFileSelectorPresent(raw: unknown, context: string): FileSelector {
  if (!isPlainObject(raw)) {
    throw new Error(`${context}: field 'select' must be an object`);
  }
  return {
    type: optString(raw, "type", SEL_NEWEST, context),
    pattern: optStringOrNull(raw, "pattern", context),
  };
}

/** A node's `select` field, honoring the two-different-defaults split
 * documented at the top of this file: the key present (even `{}`) defaults its
 * `type` to `"newest"`; the key ABSENT yields
 * {@link DEFAULT_FILE_SELECTOR_WHEN_KEY_ABSENT}, whose type is `""`. */
export function parseNodeSelect(obj: Record<string, unknown>, context: string): FileSelector {
  if (!hasOwn(obj, "select")) {
    return { ...DEFAULT_FILE_SELECTOR_WHEN_KEY_ABSENT };
  }
  return parseFileSelectorPresent(obj.select, context);
}

export type NodeKindParser = (obj: Record<string, unknown>, context: string) => NodeKind;

export function parseGenerateNode(obj: Record<string, unknown>, context: string): NodeKind {
  return { kind: "generate", prompt: requireString(obj, "prompt", context), model: optString(obj, "model", "", context) };
}
export function parseSummarizeFileNode(obj: Record<string, unknown>, context: string): NodeKind {
  return { kind: "summarize_file", select: parseNodeSelect(obj, context) };
}
export function parseFilePassNode(obj: Record<string, unknown>, context: string): NodeKind {
  return { kind: "file_pass", select: parseNodeSelect(obj, context), instruction: optString(obj, "instruction", "", context), mode: optString(obj, "mode", DEFAULT_MODE, context) };
}
export function parseAgentRunNode(obj: Record<string, unknown>, context: string): NodeKind {
  return { kind: "agent_run", question: requireString(obj, "question", context) };
}
export function parseSaveFileNode(obj: Record<string, unknown>, context: string): NodeKind {
  return { kind: "save_file", name_template: requireString(obj, "name_template", context), format: optString(obj, "format", DEFAULT_FORMAT, context), mode: optString(obj, "mode", DEFAULT_SAVE_MODE, context) };
}
export function parseConditionNode(obj: Record<string, unknown>, context: string): NodeKind {
  return { kind: "condition", op: requireString(obj, "op", context), value: optStringOrNull(obj, "value", context) };
}
export function parseScriptRunNode(obj: Record<string, unknown>, context: string): NodeKind {
  return { kind: "script_run", file: requireString(obj, "file", context), mode: optString(obj, "mode", DEFAULT_SCRIPT_MODE, context) };
}
export function parseTransformNode(obj: Record<string, unknown>, context: string): NodeKind {
  return { kind: "transform", op: requireString(obj, "op", context), find: optStringOrNull(obj, "find", context), value: optStringOrNull(obj, "value", context) };
}
export function parseMergeNode(obj: Record<string, unknown>, context: string): NodeKind {
  return { kind: "merge", mode: optString(obj, "mode", DEFAULT_MERGE_MODE, context), separator: optStringOrNull(obj, "separator", context) };
}
export function parseHttpFetchNode(obj: Record<string, unknown>, context: string): NodeKind {
  return { kind: "http_fetch", url: requireString(obj, "url", context) };
}
export function parseExtractNode(obj: Record<string, unknown>, context: string): NodeKind {
  return { kind: "extract", fields: requireStringArray(obj, "fields", context), model: optString(obj, "model", "", context) };
}
export function parseRouteNode(obj: Record<string, unknown>, context: string): NodeKind {
  return { kind: "route", prompt: optString(obj, "prompt", "", context), labels: requireStringArray(obj, "labels", context), model: optString(obj, "model", "", context) };
}
export function parseVoteNode(obj: Record<string, unknown>, context: string): NodeKind {
  return { kind: "vote", prompt: requireString(obj, "prompt", context), model: optString(obj, "model", "", context), samples: optU32(obj, "samples", DEFAULT_SAMPLES, context), mode: optString(obj, "mode", DEFAULT_VOTE_MODE, context) };
}
export function parseForEachFileNode(obj: Record<string, unknown>, context: string): NodeKind {
  return { kind: "for_each_file", select: parseNodeSelect(obj, context), instruction: requireString(obj, "instruction", context), model: optString(obj, "model", "", context) };
}
export function parseRefineNode(obj: Record<string, unknown>, context: string): NodeKind {
  return { kind: "refine", prompt: requireString(obj, "prompt", context), rubric: optString(obj, "rubric", "", context), model: optString(obj, "model", "", context), max_rounds: optU32(obj, "max_rounds", DEFAULT_REFINE_ROUNDS, context) };
}
export function parsePlanAndMapNode(obj: Record<string, unknown>, context: string): NodeKind {
  return { kind: "plan_and_map", objective: requireString(obj, "objective", context), model: optString(obj, "model", "", context), max_workers: optU32(obj, "max_workers", DEFAULT_MAX_WORKERS, context) };
}

export const NODE_KIND_PARSERS = new Map<string, NodeKindParser>([
  ["generate", parseGenerateNode], ["summarize_file", parseSummarizeFileNode], ["file_pass", parseFilePassNode],
  ["agent_run", parseAgentRunNode], ["save_file", parseSaveFileNode], ["condition", parseConditionNode],
  ["script_run", parseScriptRunNode], ["transform", parseTransformNode], ["merge", parseMergeNode],
  ["http_fetch", parseHttpFetchNode], ["extract", parseExtractNode], ["route", parseRouteNode],
  ["vote", parseVoteNode], ["for_each_file", parseForEachFileNode], ["refine", parseRefineNode],
  ["plan_and_map", parsePlanAndMapNode],
]);

export function parseNodeKind(obj: Record<string, unknown>, context: string): NodeKind {
  const kind = obj.kind;
  if (typeof kind !== "string") throw new Error(`${context}: missing or non-string 'kind'`);
  const parser = NODE_KIND_PARSERS.get(kind);
  if (parser !== undefined) return parser(obj, context);
  // serde's "unknown variant" deserialize failure. The defensive re-check in
  // `validateInner` still protects a hand-built WorkflowNode that bypasses this parser.
  throw new Error(`${context}: unknown node kind '${kind}'`);
}

/** Ported from `WorkflowNode`'s derived `Deserialize`. */
export function parseWorkflowNode(raw: unknown, index = 0): WorkflowNode {
  if (!isPlainObject(raw)) {
    throw new Error(`node[${index}] must be an object`);
  }
  const id = requireString(raw, "id", `node[${index}]`);
  const context = `node '${id}'`;
  const label = optString(raw, "label", "", context);
  return { id, label, ...parseNodeKind(raw, context) } as WorkflowNode;
}

/** Ported from `WorkflowEdge`'s derived `Deserialize`. */
export function parseWorkflowEdge(raw: unknown, index = 0): WorkflowEdge {
  if (!isPlainObject(raw)) {
    throw new Error(`edge[${index}] must be an object`);
  }
  const context = `edge[${index}]`;
  return {
    from: requireString(raw, "from", context),
    to: requireString(raw, "to", context),
    branch: optStringOrNull(raw, "branch", context),
  };
}

export function workflowNodes(raw: Record<string, unknown>, context: string): WorkflowNode[] {
  if (!hasOwn(raw, "nodes")) throw new Error(`${context}: missing required field 'nodes'`);
  const values = raw.nodes;
  if (!Array.isArray(values)) throw new Error(`${context}: field 'nodes' must be an array`);
  return values.map((value, index) => parseWorkflowNode(value, index));
}

export function workflowEdges(raw: Record<string, unknown>, context: string): WorkflowEdge[] {
  if (!hasOwn(raw, "edges")) return [];
  const values = raw.edges;
  if (!Array.isArray(values)) throw new Error(`${context}: field 'edges' must be an array`);
  return values.map((value, index) => parseWorkflowEdge(value, index));
}

/** Ported from `WorkflowDef`'s derived `Deserialize` — the direct analogue of
 * the Rust test module's own `fn parse(v) -> WorkflowDef` helper, and the
 * reader every real caller of a stored/model-composed definition goes
 * through. */
export function parseWorkflowDef(raw: unknown): WorkflowDef {
  if (!isPlainObject(raw)) {
    throw new Error("workflow definition must be an object");
  }
  const context = "workflow definition";
  const version = optU32(raw, "version", DEFAULT_VERSION, context);
  return { version, nodes: workflowNodes(raw, context), edges: workflowEdges(raw, context) };
}

/** Ported from `WorkflowBinding`'s derived `Deserialize`. */
export function parseWorkflowBinding(raw: unknown): WorkflowBinding {
  if (!isPlainObject(raw)) {
    throw new Error("workflow binding must be an object");
  }
  const context = "workflow binding";
  const scope = raw.scope;
  if (scope === "general") {
    return { scope: "general" };
  }
  if (scope === "file") {
    return {
      scope: "file",
      kinds: optStringArray(raw, "kinds", context),
      exts: optStringArray(raw, "exts", context),
      file_id: optStringOrNull(raw, "file_id", context),
    };
  }
  throw new Error(`${context}: unknown scope '${String(scope)}'`);
}

export function looseString(obj: Record<string, unknown>, key: string, fallback: string): string {
  const v = obj[key];
  return typeof v === "string" ? v : fallback;
}

export function looseStringOrNull(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" ? v : null;
}

/** Ported from `WfArtifact`'s derived `Deserialize`. Deliberately PERMISSIVE
 * where the `WorkflowDef` family is strict: this reads the app's own
 * previously-stored artifact JSON, so a wrong-shaped field degrades to that
 * field's default rather than throwing — the posture `scriptConsent.ts` takes
 * for its own stored state. A non-object input reads as all-defaults. */
export function parseWfArtifact(raw: unknown): WfArtifact {
  const obj = isPlainObject(raw) ? raw : {};
  return {
    result: looseString(obj, "result", ""),
    skipped: typeof obj.skipped === "boolean" ? obj.skipped : false,
    branch: looseStringOrNull(obj, "branch"),
    file_id: looseStringOrNull(obj, "file_id"),
    node_label: looseStringOrNull(obj, "node_label"),
    node_kind: looseStringOrNull(obj, "node_kind"),
  };
}
