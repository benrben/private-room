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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Own-property test only: `"toString" in obj` is true for every object, which
 * would make an absent key look present and skip its serde default. */
function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** A field with NO `#[serde(default)]`: absent is a deserialize failure. */
function requireString(obj: Record<string, unknown>, key: string, context: string): string {
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
function optString(obj: Record<string, unknown>, key: string, fallback: string, context: string): string {
  if (!hasOwn(obj, key)) return fallback;
  const v = obj[key];
  if (typeof v !== "string") {
    throw new Error(`${context}: field '${key}' must be a string`);
  }
  return v;
}

/** `#[serde(default)] Option<String>` — absent OR explicit `null` reads
 * `None`; anything else present is a type error, as serde would report. */
function optStringOrNull(obj: Record<string, unknown>, key: string, context: string): string | null {
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
function optU32(obj: Record<string, unknown>, key: string, fallback: number, context: string): number {
  if (!hasOwn(obj, key)) return fallback;
  const v = obj[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 0xffff_ffff) {
    throw new Error(`${context}: field '${key}' must be an integer in 0..=u32::MAX`);
  }
  return v;
}

/** A `Vec<String>` field with no serde default (`Extract.fields`,
 * `Route.labels`). */
function requireStringArray(obj: Record<string, unknown>, key: string, context: string): string[] {
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
function optStringArray(obj: Record<string, unknown>, key: string, context: string): string[] {
  if (!hasOwn(obj, key)) return [];
  const v = obj[key];
  if (!Array.isArray(v) || !v.every((x): x is string => typeof x === "string")) {
    throw new Error(`${context}: field '${key}' must be an array of strings`);
  }
  return v;
}

/** A FileSelector OBJECT that is actually present — `sel_newest()` applies
 * here, to a MISSING `"type"` subfield. */
function parseFileSelectorPresent(raw: unknown, context: string): FileSelector {
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
function parseNodeSelect(obj: Record<string, unknown>, context: string): FileSelector {
  if (!hasOwn(obj, "select")) {
    return { ...DEFAULT_FILE_SELECTOR_WHEN_KEY_ABSENT };
  }
  return parseFileSelectorPresent(obj.select, context);
}

function parseNodeKind(obj: Record<string, unknown>, context: string): NodeKind {
  const kind = obj.kind;
  if (typeof kind !== "string") {
    throw new Error(`${context}: missing or non-string 'kind'`);
  }
  switch (kind) {
    case "generate":
      return {
        kind,
        prompt: requireString(obj, "prompt", context),
        model: optString(obj, "model", "", context),
      };
    case "summarize_file":
      return { kind, select: parseNodeSelect(obj, context) };
    case "file_pass":
      return {
        kind,
        select: parseNodeSelect(obj, context),
        instruction: optString(obj, "instruction", "", context),
        mode: optString(obj, "mode", DEFAULT_MODE, context),
      };
    case "agent_run":
      return { kind, question: requireString(obj, "question", context) };
    case "save_file":
      return {
        kind,
        name_template: requireString(obj, "name_template", context),
        format: optString(obj, "format", DEFAULT_FORMAT, context),
        mode: optString(obj, "mode", DEFAULT_SAVE_MODE, context),
      };
    case "condition":
      return {
        kind,
        op: requireString(obj, "op", context),
        value: optStringOrNull(obj, "value", context),
      };
    case "script_run":
      return {
        kind,
        file: requireString(obj, "file", context),
        mode: optString(obj, "mode", DEFAULT_SCRIPT_MODE, context),
      };
    case "transform":
      return {
        kind,
        op: requireString(obj, "op", context),
        find: optStringOrNull(obj, "find", context),
        value: optStringOrNull(obj, "value", context),
      };
    case "merge":
      return {
        kind,
        mode: optString(obj, "mode", DEFAULT_MERGE_MODE, context),
        separator: optStringOrNull(obj, "separator", context),
      };
    case "http_fetch":
      return { kind, url: requireString(obj, "url", context) };
    case "extract":
      return {
        kind,
        fields: requireStringArray(obj, "fields", context),
        model: optString(obj, "model", "", context),
      };
    case "route":
      return {
        kind,
        prompt: optString(obj, "prompt", "", context),
        labels: requireStringArray(obj, "labels", context),
        model: optString(obj, "model", "", context),
      };
    case "vote":
      return {
        kind,
        prompt: requireString(obj, "prompt", context),
        model: optString(obj, "model", "", context),
        samples: optU32(obj, "samples", DEFAULT_SAMPLES, context),
        mode: optString(obj, "mode", DEFAULT_VOTE_MODE, context),
      };
    case "for_each_file":
      return {
        kind,
        select: parseNodeSelect(obj, context),
        instruction: requireString(obj, "instruction", context),
        model: optString(obj, "model", "", context),
      };
    case "refine":
      return {
        kind,
        prompt: requireString(obj, "prompt", context),
        rubric: optString(obj, "rubric", "", context),
        model: optString(obj, "model", "", context),
        max_rounds: optU32(obj, "max_rounds", DEFAULT_REFINE_ROUNDS, context),
      };
    case "plan_and_map":
      return {
        kind,
        objective: requireString(obj, "objective", context),
        model: optString(obj, "model", "", context),
        max_workers: optU32(obj, "max_workers", DEFAULT_MAX_WORKERS, context),
      };
    default:
      // serde's "unknown variant" deserialize failure. Real JSON never gets
      // past here — the DEFENSIVE re-check inside `validateInner`
      // (`nodeKindTag`/`NODE_KINDS`) covers a hand-built `WorkflowNode` value
      // that bypassed this parser entirely, exactly as the Rust source's own
      // comment explains.
      throw new Error(`${context}: unknown node kind '${kind}'`);
  }
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
  if (!hasOwn(raw, "nodes")) {
    throw new Error(`${context}: missing required field 'nodes'`);
  }
  const nodesRaw = raw.nodes;
  if (!Array.isArray(nodesRaw)) {
    throw new Error(`${context}: field 'nodes' must be an array`);
  }
  const nodes = nodesRaw.map((n, i) => parseWorkflowNode(n, i));
  let edges: WorkflowEdge[] = [];
  if (hasOwn(raw, "edges")) {
    const edgesRaw = raw.edges;
    if (!Array.isArray(edgesRaw)) {
      throw new Error(`${context}: field 'edges' must be an array`);
    }
    edges = edgesRaw.map((e, i) => parseWorkflowEdge(e, i));
  }
  return { version, nodes, edges };
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

function looseString(obj: Record<string, unknown>, key: string, fallback: string): string {
  const v = obj[key];
  return typeof v === "string" ? v : fallback;
}

function looseStringOrNull(obj: Record<string, unknown>, key: string): string | null {
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

// ============================================================================
// validation constants (workflow.rs:312-384). Order matters: several appear
// verbatim inside a `.join(", ")` in user-visible error text.
// ============================================================================

/** Ported from `NODE_KINDS`. */
export const NODE_KINDS: readonly string[] = [
  "generate",
  "summarize_file",
  "file_pass",
  "agent_run",
  "save_file",
  "condition",
  "script_run",
  "transform",
  "merge",
  "http_fetch",
  "extract",
  "route",
  "vote",
  "for_each_file",
  "refine",
  "plan_and_map",
];

/** Ported from `TRANSFORM_OPS`. */
export const TRANSFORM_OPS: readonly string[] = [
  "append",
  "prepend",
  "replace",
  "upper",
  "lower",
  "trim",
  "truncate",
  "strip_html",
];

/** Ported from `MERGE_MODES`. */
export const MERGE_MODES: readonly string[] = ["concat", "dedupe_lines", "numbered"];
/** Ported from `SCRIPT_MODES`. */
export const SCRIPT_MODES: readonly string[] = ["import", "transform"];
/** Ported from `VOTE_MODES`. */
export const VOTE_MODES: readonly string[] = ["concat", "majority"];
/** Ported from `FILE_SELECTORS`. */
export const FILE_SELECTORS: readonly string[] = [
  "newest",
  "all",
  "name_like",
  "missing_summary",
  "since_last_run",
  "run_input",
];
/** Ported from `CONDITION_OPS`. */
export const CONDITION_OPS: readonly string[] = [
  "contains",
  "not_contains",
  "is_empty",
  "not_empty",
  "new_files_since_last_run",
];

/** True when a node reads the run's input file (requires a file binding).
 * Ported from `selector_is_run_input`. */
export function selectorIsRunInput(sel: FileSelector): boolean {
  return sel.type === "run_input";
}

/** Ported from `node_uses_run_input`. */
export function nodeUsesRunInput(node: WorkflowNode): boolean {
  switch (node.kind) {
    case "summarize_file":
    case "file_pass":
    case "for_each_file":
      return selectorIsRunInput(node.select);
    default:
      return false;
  }
}

/** True if any node in the def reads the run's input file. Ported from
 * `def_uses_run_input`. */
export function defUsesRunInput(def: WorkflowDef): boolean {
  return def.nodes.some(nodeUsesRunInput);
}

/** Upper bounds on a definition. The assistant writes workflows itself, so a
 * runaway one would save and queue with no warning at all; these are far above
 * anything a real workflow needs and exist only to make "runaway" visible. */
export const MAX_NODES = 60;
/** Ported from `MAX_EDGES`. */
export const MAX_EDGES = 240;
/** Longest a single node's free text may be, in Unicode SCALAR VALUES
 * (`chars().count()`, not UTF-16 code units). Ported from `MAX_NODE_TEXT`. */
export const MAX_NODE_TEXT = 20_000;

/** The free text a node carries, for the length cap. Templates only — never a
 * name, id or op. Ported from `node_text_fields`. */
function nodeTextFields(kind: NodeKind): string[] {
  switch (kind.kind) {
    case "generate":
      return [kind.prompt];
    case "agent_run":
      return [kind.question];
    case "vote":
      return [kind.prompt];
    case "route":
      return [kind.prompt];
    case "refine":
      return [kind.prompt, kind.rubric];
    case "plan_and_map":
      return [kind.objective];
    case "file_pass":
      return [kind.instruction];
    case "for_each_file":
      return [kind.instruction];
    default:
      return [];
  }
}

/** The node's `kind` tag string. Already the discriminant field here, where
 * Rust's `node_kind_tag` needs a real `match` (an enum variant's NAME is not a
 * runtime string) — kept as a function so the defensive unknown-kind check in
 * {@link validateDefinition} reads the same as the Rust call site. */
export function nodeKindTag(kind: NodeKind): string {
  return kind.kind;
}

/** `usize::MAX` on every Mac this ships to (`usize` is 64-bit on aarch64 and
 * x86_64 darwin alike). */
const USIZE_MAX = 18_446_744_073_709_551_615n;

/**
 * Does the trimmed text parse as a Rust `usize`, exactly as
 * `value.trim().parse::<usize>()` in `validate_inner`'s truncate check?
 *
 * Two things a naive `/^\d+$/` gets wrong in OPPOSITE directions, both fixed
 * here: Rust's `from_str_radix` accepts a leading `+` (`"+120"` really is
 * `Ok(120)`), and it REFUSES anything past `usize::MAX` with
 * `Err(PosOverflow)`. Only ASCII digits count either way.
 */
function parsesAsUsize(text: string): boolean {
  const s = text.trim();
  if (!/^\+?[0-9]+$/.test(s)) {
    return false;
  }
  return BigInt(s.startsWith("+") ? s.slice(1) : s) <= USIZE_MAX;
}

// ============================================================================
// Rigor / validate_definition / validate_runnable / validate_inner /
// validate_with_binding (workflow.rs:402-845)
// ============================================================================

/**
 * How hard to check a definition. Ported from `Rigor`.
 *
 * `"saving"` — everything: the gate on save/update and the canvas's live check.
 * A new or edited definition must satisfy every rule we know.
 *
 * `"running"` — only the rules that have ALWAYS been enforced: the gate on
 * starting a run. Rules learned after a workflow was written are advice for its
 * author, not grounds to stop it dead: nothing migrates old definitions, and a
 * SCHEDULED start that fails is invisible (the scheduler just advances
 * `next_run_at` — no run row, no error, no notification), so a newly-strict
 * rule at run time reads as an automation that quietly stopped months after the
 * user set it up. Each grandfathered rule below says what the old behaviour
 * was; all of them still block a SAVE, which is where the user is looking.
 */
export type Rigor = "saving" | "running";

/** Rust's `Result<(), Vec<String>>` as a value — a list of model-fixable
 * sentences, not one message. */
export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Validate a definition, returning model-fixable sentences (`ok` = valid).
 * Checks unknown kinds, per-kind params, duplicate/dangling ids, edge refs,
 * branch legality, size limits, and a Kahn topo sort that NAMES a cycle. The
 * SAVE-time gate — see {@link validateRunnable} for the run-time one.
 */
export function validateDefinition(def: WorkflowDef): ValidationResult {
  return validateInner(def, "saving");
}

/**
 * The RUN-time gate: everything structural (unknown kinds and selectors,
 * dangling edges, illegal branch labels, cycles), minus the rules a definition
 * written by an earlier version could not have known about. See {@link Rigor}.
 */
export function validateRunnable(def: WorkflowDef): ValidationResult {
  return validateInner(def, "running");
}

function validateInner(def: WorkflowDef, rigor: Rigor): ValidationResult {
  const saving = rigor === "saving";
  const errs: string[] = [];

  if (def.nodes.length === 0) {
    errs.push("The workflow has no nodes — add at least one step.");
    return { ok: false, errors: errs };
  }
  // Size caps: authoring guard-rails ("make runaway visible"), so they bite
  // when a workflow is written. A big one already saved still runs.
  if (saving && def.nodes.length > MAX_NODES) {
    errs.push(
      `The workflow has ${def.nodes.length} steps — the limit is ${MAX_NODES}. Split it into smaller workflows.`
    );
    return { ok: false, errors: errs };
  }
  if (saving && def.edges.length > MAX_EDGES) {
    errs.push(`The workflow has ${def.edges.length} connections — the limit is ${MAX_EDGES}.`);
    return { ok: false, errors: errs };
  }

  // Unique ids. An empty id is never inserted into `ids` at all — mirrors
  // Rust's `if trim.is_empty() { … } else if !ids.insert(…) { … }`.
  const ids = new Set<string>();
  for (const n of def.nodes) {
    if (n.id.trim() === "") {
      errs.push("A node has an empty id — every node needs a unique id.");
    } else if (ids.has(n.id)) {
      errs.push(`Duplicate node id '${n.id}' — ids must be unique.`);
    } else {
      ids.add(n.id);
    }
    // Same guard-rail shape as the size caps: a long prompt saved before this
    // limit existed (a pasted spec or rubric) still runs.
    if (saving) {
      for (const t of nodeTextFields(n)) {
        if ([...t].length > MAX_NODE_TEXT) {
          errs.push(`Node '${n.id}' has instructions longer than ${MAX_NODE_TEXT} characters — shorten them.`);
          break;
        }
      }
    }
  }

  // Which nodes have something upstream to read (dangling edges excluded —
  // they're reported separately and connect nothing).
  const hasIncoming = new Set<string>();
  for (const e of def.edges) {
    if (ids.has(e.from) && ids.has(e.to)) {
      hasIncoming.add(e.to);
    }
  }

  // Per-kind param checks.
  const conditionIds = new Set<string>();
  // route nodes are branch sources like condition, but their branch labels are
  // the node's own `labels` (not then/else) — collected here for edge legality.
  const routeLabels = new Map<string, string[]>();
  for (const n of def.nodes) {
    switch (n.kind) {
      case "generate": {
        if (n.prompt.trim() === "") {
          errs.push(`Node '${n.id}' (generate) has an empty prompt.`);
        }
        break;
      }
      case "summarize_file":
      case "file_pass": {
        const select = n.select;
        if (!FILE_SELECTORS.includes(select.type)) {
          errs.push(
            `Node '${n.id}' has an unknown file selector '${select.type}' — use one of: ${FILE_SELECTORS.join(", ")}.`
          );
        }
        if (select.type === "name_like" && (select.pattern ?? "").trim() === "") {
          errs.push(`Node '${n.id}' selects by name but has no pattern.`);
        }
        // A full-file pass reads ONE file end to end. Pointed at "all" it
        // silently read only the newest — so someone asking for "read all my
        // files thoroughly" got one file. Say so instead.
        //
        // Grandfathered at run time: the step editor still offers "All files"
        // here, so saved workflows carry it, and they have always read the
        // newest — `run_file_pass_node` now names the file it read and counts
        // the ones it didn't.
        if (saving && select.type === "all" && n.kind === "file_pass") {
          errs.push(
            `Node '${n.id}' (file_pass) reads ONE file, so "all files" would read only the newest — use a for_each_file step to cover every file, or select newest/name_like/run_input.`
          );
        }
        break;
      }
      case "agent_run": {
        if (n.question.trim() === "") {
          errs.push(`Node '${n.id}' (agent_run) has an empty question.`);
        }
        break;
      }
      case "save_file": {
        if (n.name_template.trim() === "") {
          errs.push(`Node '${n.id}' (save_file) has an empty name.`);
        }
        if (!["html", "md"].includes(n.format)) {
          errs.push(`Node '${n.id}' has an unknown format '${n.format}' — use html or md.`);
        }
        if (!["create", "overwrite", "append"].includes(n.mode)) {
          errs.push(`Node '${n.id}' has an unknown save mode '${n.mode}' — use create, overwrite or append.`);
        }
        break;
      }
      case "condition": {
        conditionIds.add(n.id);
        if (!CONDITION_OPS.includes(n.op)) {
          errs.push(`Node '${n.id}' has an unknown condition '${n.op}' — use one of: ${CONDITION_OPS.join(", ")}.`);
        }
        // An empty "contains" needle matches EVERY text, so the branch is
        // decided before it is asked — always then, always else.
        // Grandfathered at run time: that is a pointless workflow, not a
        // broken one, and it has always taken the same branch.
        if (saving && (n.op === "contains" || n.op === "not_contains") && (n.value ?? "").trim() === "") {
          errs.push(
            `Node '${n.id}' checks whether the text contains something but no text was given — type what to look for.`
          );
        }
        // The subject is the joined upstream result, so a text check with
        // nothing wired into it reads an empty string forever. Grandfathered
        // at run time for the same reason as the empty needle: constant, but
        // it has always been constant.
        if (
          saving &&
          (n.op === "contains" || n.op === "not_contains" || n.op === "is_empty" || n.op === "not_empty") &&
          !hasIncoming.has(n.id)
        ) {
          errs.push(
            `Node '${n.id}' checks the text coming into it, but nothing runs before it — connect a step to it, or use new_files_since_last_run.`
          );
        }
        break;
      }
      case "script_run": {
        if (n.file.trim() === "") {
          errs.push(`Node '${n.id}' (script_run) has no script file.`);
        } else if (scriptLangOf(n.file) === null && extensionOf(n.file) === "") {
          // A bare id (no extension) is fine — it's resolved at run time; a
          // name WITH an extension must be .py/.js.
        } else if (scriptLangOf(n.file) === null) {
          errs.push(`Node '${n.id}' points at '${n.file}' — only .py or .js scripts can run.`);
        }
        if (!SCRIPT_MODES.includes(n.mode)) {
          errs.push(`Node '${n.id}' has an unknown script mode '${n.mode}' — use import or transform.`);
        }
        break;
      }
      case "transform": {
        if (!TRANSFORM_OPS.includes(n.op)) {
          errs.push(`Node '${n.id}' has an unknown transform '${n.op}' — use one of: ${TRANSFORM_OPS.join(", ")}.`);
        }
        // NOTE: no `.trim()` on `find` — Rust checks `is_empty()` directly, so
        // a `find` of one space is a legal needle.
        if (n.op === "replace" && (n.find ?? "") === "") {
          errs.push(`Node '${n.id}' (replace) needs a \`find\` string.`);
        }
        if (n.op === "truncate" && !parsesAsUsize(n.value ?? "")) {
          errs.push(`Node '${n.id}' (truncate) needs \`value\` to be a character count.`);
        }
        break;
      }
      case "merge": {
        if (!MERGE_MODES.includes(n.mode)) {
          errs.push(`Node '${n.id}' has an unknown merge mode '${n.mode}' — use one of: ${MERGE_MODES.join(", ")}.`);
        }
        break;
      }
      case "http_fetch": {
        if (n.url.trim() === "") {
          errs.push(`Node '${n.id}' (http_fetch) has no URL.`);
        }
        break;
      }
      case "extract": {
        // `[].every(…)` is `true`, exactly like Rust's `iter().all(…)` on an
        // empty Vec — an `extract` with no fields at all is flagged.
        if (n.fields.every((f) => f.trim() === "")) {
          errs.push(`Node '${n.id}' (extract) lists no fields to pull out.`);
        }
        break;
      }
      case "route": {
        const clean = n.labels.map((l) => l.trim()).filter((l) => l !== "");
        if (clean.length < 2) {
          errs.push(`Node '${n.id}' (route) needs at least two labels to route between.`);
        }
        routeLabels.set(n.id, clean);
        break;
      }
      case "vote": {
        if (n.prompt.trim() === "") {
          errs.push(`Node '${n.id}' (vote) has an empty prompt.`);
        }
        if (!VOTE_MODES.includes(n.mode)) {
          errs.push(`Node '${n.id}' has an unknown vote mode '${n.mode}' — use concat or majority.`);
        }
        break;
      }
      case "for_each_file": {
        const select = n.select;
        if (!FILE_SELECTORS.includes(select.type)) {
          errs.push(
            `Node '${n.id}' has an unknown file selector '${select.type}' — use one of: ${FILE_SELECTORS.join(", ")}.`
          );
        }
        if (select.type === "name_like" && (select.pattern ?? "").trim() === "") {
          errs.push(`Node '${n.id}' selects by name but has no pattern.`);
        }
        if (n.instruction.trim() === "") {
          errs.push(`Node '${n.id}' (for_each_file) has an empty instruction.`);
        }
        break;
      }
      case "refine": {
        if (n.prompt.trim() === "") {
          errs.push(`Node '${n.id}' (refine) has an empty prompt.`);
        }
        break;
      }
      case "plan_and_map": {
        if (n.objective.trim() === "") {
          errs.push(`Node '${n.id}' (plan_and_map) has an empty objective.`);
        }
        break;
      }
      // NO `default:` arm ON PURPOSE. A hand-built node carrying an unknown
      // kind must fall THROUGH to the defensive check below, which reports it
      // as one more validation sentence — throwing here instead would turn a
      // reportable definition error into a crash, and `compileWorkflow` would
      // never get to return its error list.
    }
  }

  // The `kind` tag is validated by the parser at parse time; a defensive check
  // keeps the message actionable if this is ever called on a hand-built def.
  for (const n of def.nodes) {
    const tag = nodeKindTag(n);
    if (!NODE_KINDS.includes(tag)) {
      errs.push(`Node '${n.id}' has an unknown kind '${tag}'.`);
    }
  }

  // Edge refs + branch legality. A branch label must be then|else and may only
  // come off a condition node, and every edge OFF a condition/route must carry
  // one. (An unwired branch simply dead-ends — skip propagation handles it —
  // so both branches are NOT required.)
  for (const e of def.edges) {
    if (!ids.has(e.from)) {
      errs.push(`An edge starts from unknown node '${e.from}'.`);
    }
    if (!ids.has(e.to)) {
      errs.push(`An edge points to unknown node '${e.to}'.`);
    }
    const fromCondition = conditionIds.has(e.from);
    const fromRoute = routeLabels.has(e.from);
    // A branch source's outgoing edges MUST each say which outcome they
    // follow: an unlabelled one is live no matter which way the step went, so
    // a route with unlabelled exits runs every handler at once and pays for
    // all of them. The step editor's "Runs after" checkboxes create exactly
    // these, and nothing flagged it.
    //
    // Grandfathered at run time: this is precisely the edge the old "add a
    // step after this one" path and the still-shipping "Runs after" checkbox
    // produce, so refusing to START on it would stop workflows the app itself
    // wrote — silently, on a schedule.
    if (saving && e.branch === null && (fromCondition || fromRoute)) {
      errs.push(
        fromCondition
          ? `Edge ${e.from}→${e.to} leaves a condition without saying which outcome it follows — set its branch to 'then' or 'else'.`
          : `Edge ${e.from}→${e.to} leaves a route without saying which label it follows — set its branch to one of route '${e.from}'s labels, or every branch runs at once.`
      );
    }
    if (e.branch !== null) {
      const b = e.branch;
      // A branch edge comes off a condition (then|else) OR a route (one of its
      // own labels). Skip-propagation matches the artifact branch string to
      // the edge branch either way, so both fan the graph the same.
      if (fromCondition) {
        if (b !== "then" && b !== "else") {
          errs.push(`Edge ${e.from}→${e.to} has branch '${b}' — a condition only branches 'then' or 'else'.`);
        }
      } else if (fromRoute) {
        const labels = routeLabels.get(e.from) ?? [];
        if (!labels.includes(b)) {
          errs.push(`Edge ${e.from}→${e.to} has branch '${b}', but route '${e.from}' has no such label.`);
        }
      } else {
        errs.push(`Edge ${e.from}→${e.to} has a branch, but '${e.from}' is not a condition or route node.`);
      }
    }
  }

  // Shortcuts extension: a run_input node requires a file binding — but the
  // binding lives outside the def, so it is cross-checked at save time
  // (validateWithBinding). Here we only topo-check.
  const topo = topoOrder(def);
  if (!topo.ok) {
    errs.push(`The workflow has a cycle through: ${topo.cycle.join(" → ")} — remove an edge so it can run in order.`);
  }

  return errs.length === 0 ? { ok: true } : { ok: false, errors: errs };
}

/** Cross-check the def against its binding (a run_input node needs file
 * scope). Ported from `validate_with_binding`. */
export function validateWithBinding(def: WorkflowDef, binding: WorkflowBinding): ValidationResult {
  const base = validateDefinition(def);
  if (!base.ok) {
    return base;
  }
  if (defUsesRunInput(def) && binding.scope !== "file") {
    for (const n of def.nodes) {
      if (nodeUsesRunInput(n)) {
        return {
          ok: false,
          errors: [`Node '${n.id}' reads the run's input file — set the workflow's binding to file-scoped.`],
        };
      }
    }
  }
  return { ok: true };
}

// ============================================================================
// topo_order (workflow.rs:868-906)
// ============================================================================

/** Rust's `Result<Vec<String>, Vec<String>>` as a value. */
export type TopoOrderResult =
  | { readonly ok: true; readonly order: readonly string[] }
  | { readonly ok: false; readonly cycle: readonly string[] };

/**
 * Kahn topo sort over node ids; the `cycle` arm names the nodes still stuck.
 * Ported from `topo_order`.
 *
 * THE TIE-BREAK, EXACTLY. `ready` starts as the nodes' DECLARED array order,
 * filtered to in-degree 0 — so among nodes with nothing upstream, declaration
 * order wins. From there it is a plain FIFO QUEUE: Rust reads
 * `ready.first()` and then `ready.remove(0)` (dequeue the FRONT), and appends a
 * newly-unblocked node to the BACK with `ready.push(m)`, in the order ITS
 * PARENT'S EDGES were declared (`adj`'s child list follows `def.edges`, not
 * `def.nodes`). Two reimplementations that pass a one-layer test and are still
 * wrong: a STACK (`pop()`/`push()`) reverses same-wave siblings, and a
 * re-sorted/priority `ready` pulls a later wave's node ahead of an earlier
 * wave's. Step numbering is user-visible and must reproduce identically.
 */
export function topoOrder(def: WorkflowDef): TopoOrderResult {
  const ids = def.nodes.map((n) => n.id);
  const idset = new Set(ids);
  const indeg = new Map<string, number>(ids.map((i) => [i, 0]));
  const adj = new Map<string, string[]>();
  for (const e of def.edges) {
    // Ignore edges referencing unknown nodes (already reported by validation).
    if (idset.has(e.from) && idset.has(e.to)) {
      const list = adj.get(e.from);
      if (list === undefined) {
        adj.set(e.from, [e.to]);
      } else {
        list.push(e.to);
      }
      indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    }
  }

  const order: string[] = [];
  const ready: string[] = ids.filter((i) => indeg.get(i) === 0);
  while (ready.length > 0) {
    const n = ready.shift() as string;
    order.push(n);
    const next = adj.get(n);
    if (next !== undefined) {
      for (const m of next) {
        const d = (indeg.get(m) ?? 0) - 1;
        indeg.set(m, d);
        if (d === 0) {
          ready.push(m);
        }
      }
    }
  }

  if (order.length === ids.length) {
    return { ok: true, order };
  }
  // Rust reads this list off `indeg` — `indeg.iter().filter(|(_, &d)| d > 0)` —
  // NOT off `ids`, and the difference is visible: `indeg` is a `HashMap` keyed
  // by node id, so a DUPLICATED id (its own reported error, but validation
  // still runs the topo check afterwards) collapses to ONE key and is named
  // ONCE. Filtering `ids` instead re-names it per declaration, so
  // `nodes:[x,x] + x→x` printed "cycle through: x → x" where Rust prints
  // "cycle through: x" (verified against rustc). Iterating this `Map` is the
  // same collapse, and its insertion order additionally pins the DECLARED
  // order Rust's `HashMap` leaves unspecified.
  const cycle: string[] = [];
  for (const [id, d] of indeg) {
    if (d > 0) cycle.push(id);
  }
  return { ok: false, cycle };
}

// ============================================================================
// compiler (workflow.rs:908-1029)
// ============================================================================

/**
 * Resolve a node's model choice to (model_name, lane). Ported from
 * `resolve_node_model` (module-private in Rust; exported here so its own
 * behaviour has a direct test). Mirrors `resolve_pass_engine`'s doctrine —
 * engine parity: "auto" and a literal honor whatever the user chose,
 * INCLUDING external CLIs (the sidecar's external backend runs them); "local"
 * stays a hard local pick; "cloud" prefers an installed `:cloud` proxy.
 * Lane = remote engines → Cloud.
 */
export function resolveNodeModel(
  choice: string,
  roomModel: string | null,
  models: readonly string[]
): { readonly model: string; readonly lane: Lane } {
  const trimmed = choice.trim();
  let name: string;
  if (trimmed === "" || trimmed === "auto") {
    name = roomModel ?? bestDefault(models);
  } else if (trimmed === "local") {
    name = bestLocalDefault(models);
  } else if (trimmed === "cloud") {
    // An installed Ollama entry that is NOT run here — the record's own split,
    // so the `<size>-cloud` spelling counts as a cloud pick too instead of
    // falling through to `bestDefault` (which can be local).
    name = models.find((m) => !runsOnThisMac(m)) ?? bestDefault(models);
  } else {
    name = trimmed;
  }
  const lane: Lane = runsOnThisMac(name) ? "local_llm" : "cloud";
  return { model: name, lane };
}

/** The per-kind model/lane match `compile_workflow` inlines — factored out for
 * readability; not itself a named Rust function. */
function resolveModelForNode(
  node: WorkflowNode,
  roomModel: string | null,
  models: readonly string[]
): { readonly model: string; readonly lane: Lane } {
  switch (node.kind) {
    case "generate":
    case "extract":
    case "route":
    case "vote":
    case "for_each_file":
    case "refine":
    case "plan_and_map":
      return resolveNodeModel(node.model, roomModel, models);
    case "summarize_file":
    case "file_pass":
    case "agent_run":
      return resolveNodeModel("auto", roomModel, models);
    // Deterministic, no model call — the CPU lane (fans out to 4).
    case "save_file":
    case "condition":
    case "script_run":
    case "transform":
    case "merge":
    case "http_fetch":
      return { model: "", lane: "cpu" };
  }
}

/** One compiled step's `params` — Rust's `json!({"node":…, "model":…,
 * "incoming":…})`. `model` is JSON `null` (not `""`) when the node makes no
 * model call, and `incoming[].branch` is `null` for an unlabelled edge. */
export interface WorkflowStepParams {
  readonly node: WorkflowNode;
  readonly model: string | null;
  readonly incoming: ReadonlyArray<{ readonly parent: number; readonly branch: string | null }>;
}

/** Rust's `Result<Vec<Step>, Vec<String>>` as a value. */
export type CompileResult =
  | { readonly ok: true; readonly steps: Step[] }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Compile a validated def into a dense, dependency-ordered `Step` plan. Each
 * step's params carry the node, its resolved model, and its incoming edges (so
 * the executor is self-contained per step — the immutable-snapshot doctrine).
 * Ported from `compile_workflow`.
 */
export function compileWorkflow(
  def: WorkflowDef,
  roomModel: string | null,
  models: readonly string[]
): CompileResult {
  // The RUN-time gate: a definition already on disk must still start. Every
  // save path validates strictly first (`validateWithBinding`), so an
  // authoring mistake is still caught where it can be fixed.
  const runnable = validateRunnable(def);
  if (!runnable.ok) {
    return runnable;
  }
  const topo = topoOrder(def);
  if (!topo.ok) {
    return { ok: false, errors: [`cycle through ${topo.cycle.join(" → ")}`] };
  }
  const order = topo.order;
  // node id -> step index (dense, topo order), and node id -> the node. Both
  // are keyed by a room-controlled node id, so both are Maps, never `{}`.
  const stepOf = new Map<string, number>(order.map((id, i) => [id, i]));
  const nodeOf = new Map<string, WorkflowNode>(def.nodes.map((n) => [n.id, n]));

  const steps: Step[] = [];
  order.forEach((nid, idx) => {
    const original = nodeOf.get(nid);
    /* c8 ignore next 3 -- topoOrder only ever names ids that came from def.nodes */
    if (original === undefined) {
      throw new Error(`internal: topo order named unknown node '${nid}'`);
    }
    let node: WorkflowNode = original;
    // The validator reads a route's labels TRIMMED, and edges are checked
    // against that cleaned list — so a stored label with padding (or an empty
    // one) validated fine and then routed at run time to a string no edge
    // matched, silently skipping every branch. Clean it once, here, and the
    // sidecar payload, the artifact's branch and the edge comparison are all
    // the same strings the definition was validated as. (Rust mutates its own
    // clone in place; a fresh object is the same thing for what gets embedded,
    // and leaves the caller's def untouched.)
    if (node.kind === "route") {
      node = { ...node, labels: node.labels.map((l) => l.trim()).filter((l) => l !== "") };
    }

    const incoming: { parent: number; branch: string | null }[] = [];
    for (const e of def.edges) {
      if (e.to !== nid) continue;
      const parent = stepOf.get(e.from);
      if (parent !== undefined) {
        incoming.push({ parent, branch: e.branch });
      }
    }
    const dependsOn = incoming.map((i) => i.parent);

    const { model, lane } = resolveModelForNode(node, roomModel, models);
    const params: WorkflowStepParams = { node, model: model === "" ? null : model, incoming };

    steps.push({ id: idx, lane, kind: "workflow_node", params, dependsOn });
  });

  return { ok: true, steps };
}

/** The resolved default model for a def (for display/snapshot). Ported from
 * `default_resolved_model`. */
export function defaultResolvedModel(roomModel: string | null, models: readonly string[]): string {
  return resolveNodeModel("auto", roomModel, models).model;
}
