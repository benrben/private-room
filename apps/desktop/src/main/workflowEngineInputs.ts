/** Cohesive extraction from workflowEngine.ts; the facade preserves its public API. */
/**
 * The LLM-graph workflow engine's PER-NODE EXECUTOR. Ported from
 * `src-tauri/src/commands/jobs/workflow.rs` LINES 1031-2544 (the file is 5855
 * lines): everything from the `---- executor ----` banner through the end of
 * `save_file_node`, stopping right before `park_outcome` (line 2544 — a later
 * batch's territory: the run-outcome Stop-vs-error classification that sits
 * ABOVE this file's own node-level funnel).
 *
 * `workflowModel.ts` already ports lines 1-1030 (the data model, validator and
 * compiler); THIS file builds directly on top of it — `WorkflowNode`/
 * `NodeKind`/`WorkflowPlan`/`WfArtifact`/`FileSelector` and their parsers are
 * imported, never redeclared.
 *
 * ============================================================================
 * WHAT IS A THIN SIDECAR PROXY HERE, AND WHAT IS NOT
 * ============================================================================
 * Per the Rust source's own "MIGRATION slice 1/2/3" comments (2026-07-25,
 * "Rust drives, Python thinks"): the `extract`/`route`/`vote`/`refine`/
 * `plan_and_map` node kinds run ENTIRELY in the Python sidecar behind
 * `/wf_node`. The aggregation logic that used to live in Rust
 * (`aggregate_votes`, `build_extract_schema`, `route_schema_of`,
 * `pick_route_label`) was DELETED there and is NOT reimplemented here: each
 * arm below builds the payload, POSTs it, and unwraps the JSON result — just
 * as Rust's own `wf_node`/`wf_node_value` do. Only `route`'s `branch` is read
 * out separately, because `compileWorkflow` prunes dead edges off it and the
 * executor has to know which one was taken.
 *
 * `summarize_file`'s per-file one-liner is the SAME shape of thin proxy and is
 * ported as one ({@link summarizeOneFileViaSidecar}) rather than stubbed:
 * `commands/summarize.rs::summarize_one_file` is literally a POST to
 * `/summarize_file` plus `v["summary"]`, and `commands/jobs.rs::classify_liner`
 * is a pure sentinel decision whose four outcomes this file's `summarize_file`
 * arm matches on IN RANGE. Refusing a dependency that is one already-existing
 * endpoint away would be dishonest in the other direction.
 *
 * ============================================================================
 * RESERVED KEYS — read before touching {@link buildWfNodePayload}
 * ============================================================================
 * `wf_node_value`'s payload merges a node's own body fields UNDER
 * `kind`/`model`/`base_url`/`keep_alive`/`run_id`/`parallel`, which must never
 * be shadowed: the sidecar keys its PRIVACY DOOR and the Keychain-backed
 * provider credentials off `body["model"]` specifically, so a body field named
 * `model` winning would silently send a protected room's text to whatever
 * engine that field named. The merge is built on an `Object.create(null)` base
 * and skips any body key naming a reserved slot — never a blind
 * `payload[k] = v` loop (rule 2: a `"__proto__"`-named entry polluting
 * `Object.prototype` has been a real bug in this codebase four times already;
 * on a null-prototype object an own `"__proto__"` key is an ordinary data
 * property, not the exotic accessor). Rust additionally `debug_assert!`s the
 * collision — a dev-build-only panic for visibility; this port always drops
 * silently, matching Rust's RELEASE behavior, which is unconditional either
 * way.
 *
 * ============================================================================
 * INTERPOLATION ORDER — a real security property, not a style choice
 * ============================================================================
 * {@link interpolate} substitutes `{{input}}` LAST. `{{input}}` carries model
 * output and file text, so substituting it FIRST would let upstream text that
 * happens to contain the literal string `{{files}}` be expanded as if the
 * workflow AUTHOR had written that placeholder — leaking the room's whole file
 * inventory into a downstream prompt. Pinned by this file's own
 * `upstream_text_cannot_conjure_a_template_placeholder` test.
 *
 * Every substitution here (and in {@link applyTransform}'s `replace`) is done
 * with `split().join()`, NOT `String.replaceAll`: `replaceAll` interprets `$&`,
 * `` $` ``, `$'` and `$1` IN THE REPLACEMENT as substitution patterns, and the
 * replacement here is model output. Rust's `str::replace` is literal, so this
 * one must be too.
 *
 * ============================================================================
 * FILE SELECTORS — the previously-fixed feedback-loop bug
 * ============================================================================
 * `newest`/`all`/`name_like`/`missing_summary` INCLUDE AI-generated files (a
 * room whose useful content IS AI-authored must still be readable by these —
 * excluding `source='generated'` there once matched nothing, so every
 * file-read node returned "No file matched"); `since_last_run` EXCLUDES them,
 * because that selector drives SCHEDULED re-runs and including a workflow's
 * own just-saved output there would feed it back into itself forever. The
 * split is preserved exactly, selector by selector, in {@link resolveFiles}.
 *
 * ============================================================================
 * WHAT IS INJECTED, NEVER FAKED
 * ============================================================================
 * - {@link AgentRunFn} (`agent_run`) — `run_agent_headless` (workflow.rs:2429,
 *   past this file's range) needs concrete room/tool/engine state with no
 *   Electron port anywhere in this migration. Injected exactly as Rust's own
 *   `AgentRunFn` is, defaulting to {@link agentRunNotImplemented}: a labeled
 *   rejection, never a fabricated answer (`jobs.ts`'s
 *   `renderPodcastAudioNotImplemented` / `filePass.ts`'s
 *   `resolvePassEngineNotImplemented` convention).
 * - `emit_workflow_node`'s live pipeline-diagram event has no Electron
 *   renderer bridge yet (Phase 2, gated on owner go-ahead). Ported as an
 *   OPTIONAL injected {@link EmitFn} defaulting to nothing — `recIpc.ts`/
 *   `dictStopTimeout.ts`/`filePass.ts`'s established pattern — never a
 *   simulated `window.emit`.
 * - `file_pass`'s engine resolution is threaded straight through to
 *   `filePass.ts`'s own already-documented `ResolvePassEngine` seam; this file
 *   invents no second copy of that gap.
 * - Every OTHER dependency reaches its REAL already-ported implementation:
 *   `script_run` → `scriptRun.ts`'s `resolveScriptFile`/`runScriptProcess`,
 *   `http_fetch` → `webFetch.ts`'s SSRF-guarded `fetchPage`, `file_pass` →
 *   `filePass.ts`'s `driveFilePass`, `transform`'s `strip_html` →
 *   `editMatchHtml.ts`'s `stripHtml`, and the sidecar transports →
 *   `sidecarJsonCancellable.ts`. Each is overridable for tests, but none is
 *   stubbed by default.
 *
 * ============================================================================
 * STOP VS. ERROR (rule 4)
 * ============================================================================
 * Every cancellable path here (a bare `cancel.load()` check, a sidecar call's
 * own `stopped` outcome, `driveFilePass`'s own `"STOPPED"` throw) surfaces the
 * literal string `"STOPPED"`, exactly as Rust's `Err("STOPPED".into())` does,
 * and a `script_run` that parked for approval is marked {@link NEEDS_APPROVAL}.
 * {@link executeWorkflowStep} — the single funnel, mirroring Rust's own
 * "the badge is decided HERE and nowhere else" invariant — carries BOTH
 * sentinels through UNCHANGED in the `StepResult` it returns, stripping the
 * park marker only from what the diagram shows. Classifying them into a real
 * Paused-vs-Error run outcome is `park_outcome`'s job, one line past this
 * file's range, and is deliberately NOT reimplemented here.
 *
 * ============================================================================
 * DEVIATIONS
 * ============================================================================
 * - {@link executeWorkflowStep} returns a `StepResult` value rather than
 *   throwing, mirroring Rust's `Result<(), String>` — `jobs.ts`'s own
 *   documented reason: a wave run through `Promise.all` must not have one
 *   step's rejection abandon its siblings as unhandled-rejection noise (see
 *   `run_plan_discards_a_failed_waves_completed_siblings`). Internally every
 *   helper throws, and only that outermost boundary converts, exactly as
 *   `filePass.ts`'s `executePassStep` already does.
 * - No `tauri::AppHandle<R>`/`AppState`: every room-pinned function takes
 *   `jobs.ts`'s established `RoomSource` + `pinnedDb` seam.
 * - `NodeReport` is a discriminated union rather than Rust's tuple-like enum
 *   (`StepResult`, `ValidationResult`, … — this port's standing convention).
 */
import type Database from "better-sqlite3-multiple-ciphers";
import { CancelFlag } from "./cancel.js";
import { pinnedDb, type RoomSource } from "./jobs.js";
import { getJobArtifact, putJobArtifact } from "./db-host/jobs.js";
import { currentDate, listFilesBrief, newSourceFileCount } from "./db-host/files.js";
import { likeEscape } from "./db-host/messages.js";
import { queryOpt, queryRows, type Row } from "./db-host/util.js";
import { type SidecarPostOutcome } from "./sidecarJsonCancellable.js";
import { type EmitFn } from "./filePass.js";
import { parseWfArtifact, type FileSelector, type WfArtifact } from "./workflowModel.js";


/** `commands::models::KEEP_ALIVE_WARM` — a plain literal, not a re-port of
 * that (unported) module: this port's established per-file convention, and the
 * same local copy `filePass.ts` already carries. */
export const KEEP_ALIVE_WARM = "30m";


/** Rust's `.ok_or("The room this job belongs to is no longer open.")?` — the
 * sentence every room-pinned function in this module throws. */
export const ROOM_GONE = "The room this job belongs to is no longer open.";


export function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}


// ============================================================================
// emit_workflow_node (workflow.rs:1085-1106)
// ============================================================================

function emitSafely(emit: EmitFn | undefined, event: string, payload: unknown): void {
  try {
    emit?.(event, payload);
  } catch {
    // Swallowed deliberately, matching Rust's `let _ = w.emit(...)`.
  }
}


/** How many Unicode CODE POINTS (not UTF-16 units) of a node's result the
 * diagram's hover peek shows — `chars().take(200)`. */
const PEEK_MAX_CHARS = 200;


function peekChars(text: string): string {
  const chars = Array.from(text);
  return chars.length > PEEK_MAX_CHARS ? chars.slice(0, PEEK_MAX_CHARS).join("") : text;
}


/** The status a node's box shows on the live pipeline diagram. */
export type WorkflowNodeStatus = "running" | "skipped" | "done" | "error";


/** Ported from `emit_workflow_node`. `peek` is `null` for none, matching
 * Rust's `peek.map(...)` over an `Option<&str>`; an unwired `emit` (the
 * pre-Phase-2 default) is a no-op, matching Rust's own "no window, no event"
 * branch. */
export function emitWorkflowNode(
  emit: EmitFn | undefined,
  jobId: string,
  workflowId: string,
  nodeId: string,
  status: WorkflowNodeStatus,
  peek: string | null
): void {
  emitSafely(emit, "workflow-node", {
    jobId,
    workflowId,
    nodeId,
    status,
    peek: peek === null ? null : peekChars(peek),
  });
}


// ============================================================================
// load_wf_artifact / store_wf_artifact (workflow.rs:1040-1083)
// ============================================================================

/**
 * Ported from `load_wf_artifact`. A stored artifact that fails to parse (or is
 * simply absent) reads as `null` — Rust's
 * `db::get_job_artifact(...).and_then(|s| serde_json::from_str(&s).ok())`.
 *
 * The parse goes through {@link parseWfArtifact}, NOT a bare `as WfArtifact`
 * cast: every field of the Rust struct is `#[serde(default)]`, so a stored
 * `{}` (or one written by an older shape) must read as all-defaults. A cast
 * would leave `result` `undefined` and the very next `a.result.trim()` in
 * {@link runWorkflowNode} would throw a `TypeError` instead.
 */
export function loadWfArtifact(db: Database.Database, jobId: string, stepId: number): WfArtifact | null {
  const raw = getJobArtifact(db, jobId, stepId);
  if (raw === null) {
    return null;
  }
  try {
    return parseWfArtifact(JSON.parse(raw));
  } catch {
    return null;
  }
}


/** Ported from `store_wf_artifact`. */
export function storeWfArtifact(db: Database.Database, jobId: string, stepId: number, a: WfArtifact): void {
  putJobArtifact(db, jobId, stepId, JSON.stringify(a));
}


// ============================================================================
// edge_is_live / eval_condition (workflow.rs:1044-1069)
// ============================================================================

/**
 * Pure liveness rule for one incoming edge: a parent is live iff its artifact
 * exists and is not skipped, and (the edge has no branch, or the parent is a
 * condition/route whose taken branch equals the edge's). A MISSING parent
 * artifact is NOT live (same as skipped). Ported from `edge_is_live`.
 */
export function edgeIsLive(parent: WfArtifact | null, branch: string | null): boolean {
  if (parent === null || parent.skipped) {
    return false;
  }
  return branch === null ? true : parent.branch === branch;
}


type ConditionEvaluator = (subject: string, value: string | null, newFiles: number) => boolean;


function subjectContains(subject: string, value: string | null): boolean {
  return subject.toLowerCase().includes((value ?? "").toLowerCase());
}


const CONDITION_EVALUATORS: Readonly<Record<string, ConditionEvaluator>> = {
  contains: (subject, value) => subjectContains(subject, value),
  not_contains: (subject, value) => !subjectContains(subject, value),
  is_empty: (subject) => subject.trim() === "",
  not_empty: (subject) => subject.trim() !== "",
  new_files_since_last_run: (_subject, _value, newFiles) => newFiles > 0,
};


/** Pure condition evaluation → `true` = "then" branch. Ported from
 * `eval_condition`. */
export function evalCondition(op: string, subject: string, value: string | null, newFiles: number): boolean {
  return CONDITION_EVALUATORS[op]?.(subject, value, newFiles) ?? false;
}


// ============================================================================
// interpolate (workflow.rs:1108-1157)
// ============================================================================

/** Literal, non-regex, non-`$`-expanding replacement of every occurrence —
 * see this module's doc on why `String.replaceAll` is wrong for a replacement
 * that carries model output. */
export function replaceLiteral(haystack: string, needle: string, replacement: string): string {
  return haystack.split(needle).join(replacement);
}


/**
 * Interpolate `{{input}}`, `{{files}}`, `{{date}}` in a template. Room-pinned:
 * a room that has swapped or closed by the time this runs reads `{{files}}`/
 * `{{date}}` as empty text (Rust: `.unwrap_or_default()`) and never throws.
 * `{{input}}` is substituted LAST — see this module's doc. Ported from
 * `interpolate`.
 */
export function interpolate(rooms: RoomSource, roomPath: string, template: string, inputs: string): string {
  let out = template;
  if (out.includes("{{files}}")) {
    const db = pinnedDb(rooms, roomPath);
    let files = "";
    if (db !== null) {
      try {
        files = listFilesBrief(db)
          .map(([name, , , liner]) => (liner !== null && liner.trim() !== "" ? `- ${name}: ${liner}` : `- ${name}`))
          .join("\n");
      } catch {
        // Rust's `db::list_files_brief(&r.conn).ok()` — a failed inventory
        // read leaves the placeholder empty; it never fails the step.
        files = "";
      }
    }
    out = replaceLiteral(out, "{{files}}", files);
  }
  if (out.includes("{{date}}")) {
    const db = pinnedDb(rooms, roomPath);
    const date = db === null ? "" : currentDate(db);
    out = replaceLiteral(out, "{{date}}", date);
  }
  return replaceLiteral(out, "{{input}}", inputs);
}


// ============================================================================
// resolve_files / query_files / count_new_files (workflow.rs:1159-1298)
// ============================================================================

/** `(id, name, mime)` — Rust's `Vec<(String, String, String)>`. */
export type FileTriple = readonly [id: string, name: string, mime: string];


function queryFiles(db: Database.Database, sql: string, params: readonly unknown[]): FileTriple[] {
  return queryRows(db, sql, params, (r: Row) => [r[0] as string, r[1] as string, r[2] as string] as const);
}


function resolveRunInputFile(db: Database.Database, inputFileId: string | null): FileTriple[] {
  if (inputFileId === null) {
    throw new Error("this workflow needs a file to run on");
  }
  const row = queryOpt(
    db,
    "SELECT name, coalesce(mime_type,'') FROM files WHERE id = ? AND trashed_at IS NULL",
    [inputFileId],
    (result) => [result[0] as string, result[1] as string] as const
  );
  if (row === null) {
    throw new Error("the file this run was invoked on is no longer in the room");
  }
  return [[inputFileId, row[0], row[1]] as const];
}


function newestFiles(db: Database.Database): FileTriple[] {
  return queryFiles(
    db,
    "SELECT id, name, coalesce(mime_type,'') FROM files WHERE trashed_at IS NULL ORDER BY created_at DESC LIMIT 1",
    []
  );
}


function allFiles(db: Database.Database): FileTriple[] {
  return queryFiles(
    db,
    "SELECT id, name, coalesce(mime_type,'') FROM files WHERE trashed_at IS NULL ORDER BY created_at DESC LIMIT 50",
    []
  );
}


function nameLikeFiles(db: Database.Database, selector: FileSelector): FileTriple[] {
  const pattern = `%${likeEscape((selector.pattern ?? "").toLowerCase())}%`;
  return queryFiles(
    db,
    "SELECT id, name, coalesce(mime_type,'') FROM files " +
      "WHERE trashed_at IS NULL AND lower(name) LIKE ? ESCAPE '\\' " +
      "ORDER BY created_at DESC LIMIT 20",
    [pattern]
  );
}


function filesMissingSummary(db: Database.Database): FileTriple[] {
  return queryFiles(
    db,
    "SELECT id, name, coalesce(mime_type,'') FROM files " +
      "WHERE trashed_at IS NULL AND ai_summary IS NULL " +
      "AND extracted_text IS NOT NULL AND trim(extracted_text) != '' " +
      "ORDER BY created_at DESC LIMIT 50",
    []
  );
}


function filesSinceLastRun(db: Database.Database, prevRunAt: string | null): FileTriple[] {
  return queryFiles(
    db,
    "SELECT id, name, coalesce(mime_type,'') FROM files " +
      "WHERE trashed_at IS NULL AND source != 'generated' AND created_at > ? " +
      "ORDER BY created_at DESC LIMIT 50",
    [prevRunAt ?? ""]
  );
}


type FileSelectorResolver = (db: Database.Database, selector: FileSelector, prevRunAt: string | null) => FileTriple[];


const FILE_SELECTOR_RESOLVERS: Readonly<Record<string, FileSelectorResolver>> = {
  newest: (db) => newestFiles(db),
  all: (db) => allFiles(db),
  name_like: (db, selector) => nameLikeFiles(db, selector),
  missing_summary: (db) => filesMissingSummary(db),
  since_last_run: (db, _selector, prevRunAt) => filesSinceLastRun(db, prevRunAt),
};


/**
 * Resolve a file selector to (id, name, mime) rows (room-pinned). Ported from
 * `resolve_files` — see this module's doc for the generated-file split, which
 * is preserved exactly, selector by selector.
 */
export function resolveFiles(
  rooms: RoomSource,
  roomPath: string,
  sel: FileSelector,
  inputFileId: string | null,
  prevRunAt: string | null
): FileTriple[] {
  const db = pinnedDb(rooms, roomPath);
  if (db === null) {
    throw new Error(ROOM_GONE);
  }
  if (sel.type === "run_input") return resolveRunInputFile(db, inputFileId);
  const resolve = FILE_SELECTOR_RESOLVERS[sel.type];
  return resolve === undefined ? [] : resolve(db, sel, prevRunAt);
}


/** Count source files created after `since` — the `new_files_since_last_run`
 * condition op. Ported from `count_new_files`. */
export function countNewFiles(rooms: RoomSource, roomPath: string, prevRunAt: string | null): number {
  const db = pinnedDb(rooms, roomPath);
  if (db === null) {
    return 0;
  }
  try {
    return newSourceFileCount(db, prevRunAt ?? "");
  } catch {
    return 0;
  }
}


// ============================================================================
// the sidecar transports: sidecar_json_cancellable_run, wf_generate,
// wf_node_value, wf_node (workflow.rs:1305-1426, sidecar.rs:546-588)
// ============================================================================

/** `sidecar.rs::SIDECAR_CHAIN_TIMEOUT` (`Duration::from_secs(3600 * 10)`) —
 * an outer backstop for a `/wf_node` chain that can legitimately run many
 * sequential generations behind one POST. */
export const SIDECAR_CHAIN_TIMEOUT_MS = 3600 * 10 * 1000;


/** `(path, body, cancel, runId, timeoutMs) => …` — the `/wf_node` transport
 * {@link wfNodeValue} speaks through. */
export type WfNodePostFn = (
  path: string,
  body: unknown,
  cancel: CancelFlag,
  runId: string,
  timeoutMs: number
) => Promise<SidecarPostOutcome>;
