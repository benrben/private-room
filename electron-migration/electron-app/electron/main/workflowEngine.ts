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
import { CancelFlag, stopped } from "./cancel.js";
import { laneSlots, pinnedDb, type Lane, type RoomSource, type Step, type StepResult } from "./jobs.js";
import { getJobArtifact, putJobArtifact } from "./db-host/jobs.js";
import {
  currentDate,
  getFileExtractedText,
  getFileMeta,
  inTransaction,
  insertFile,
  listFilesBrief,
  newSourceFileCount,
  setFileAiSummary,
  updateFileContent,
  type FileMeta,
} from "./db-host/files.js";
import { likeEscape } from "./db-host/messages.js";
import { snapshotFileVersion } from "./db-host/versions.js";
import { queryOpt, queryRows, type Row } from "./db-host/util.js";
import { resolvedBaseUrl } from "./engineRouting.js";
import { busy, deliverCancel, ensureUp } from "./sidecar.js";
import {
  humanizeEmptyGeneration,
  sidecarErrorSentinel,
  sidecarJsonCancellable,
  type SidecarPostOutcome,
} from "./sidecarJsonCancellable.js";
import { stripHtml } from "./editMatchHtml.js";
import { fetchPage as realFetchPage, type FetchedPage } from "./webFetch.js";
import {
  executeScriptInWorkspace,
  resolveScriptFile,
  runScriptProcess,
  scriptFingerprint,
  type ScriptRunDeps,
  type ScriptRunReport,
} from "./scriptRun.js";
import {
  driveFilePass,
  type DriveFilePassDeps,
  type EmitFn,
  type PublishedRef,
  type ResolvePassEngine,
  type SidecarPostFn,
} from "./filePass.js";
import { htmlDocument } from "./docsHtml.js";
import { appendIntoHtml, cleanSaveName } from "./workflowSaveFile.js";
import {
  DEFAULT_WF_ARTIFACT,
  nodeKindTag,
  parseWfArtifact,
  parseWorkflowNode,
  type FileSelector,
  type WfArtifact,
  type WorkflowNode,
  type WorkflowPlan,
} from "./workflowModel.js";

export { appendIntoHtml, cleanSaveName, MAX_SAVE_NAME_CHARS } from "./workflowSaveFile.js";
/** `like_escape` (workflow.rs:1258-1267) is byte-identical to the already-
 * ported `db-host/messages.ts` one — same three characters (`\`, `%`, `_`),
 * escaped the same way — so it is REUSED rather than re-spelled, exactly as
 * `db-host/files.ts`'s `availableName` already reuses it instead of deriving
 * a second copy. Re-exported so this module's own callers and tests can reach
 * it by the name the Rust source uses. */
export { likeEscape };
export type { EmitFn, PublishedRef, SidecarPostFn };

/** `commands::models::KEEP_ALIVE_WARM` — a plain literal, not a re-port of
 * that (unported) module: this port's established per-file convention, and the
 * same local copy `filePass.ts` already carries. */
const KEEP_ALIVE_WARM = "30m";

/** Rust's `.ok_or("The room this job belongs to is no longer open.")?` — the
 * sentence every room-pinned function in this module throws. */
export const ROOM_GONE = "The room this job belongs to is no longer open.";

function asRecord(v: unknown): Record<string, unknown> | null {
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

/** Pure condition evaluation → `true` = "then" branch. Ported from
 * `eval_condition`. */
export function evalCondition(op: string, subject: string, value: string | null, newFiles: number): boolean {
  const needle = (value ?? "").toLowerCase();
  switch (op) {
    case "contains":
      return subject.toLowerCase().includes(needle);
    case "not_contains":
      return !subject.toLowerCase().includes(needle);
    case "is_empty":
      return subject.trim() === "";
    case "not_empty":
      return subject.trim() !== "";
    case "new_files_since_last_run":
      return newFiles > 0;
    default:
      return false;
  }
}

// ============================================================================
// interpolate (workflow.rs:1108-1157)
// ============================================================================

/** Literal, non-regex, non-`$`-expanding replacement of every occurrence —
 * see this module's doc on why `String.replaceAll` is wrong for a replacement
 * that carries model output. */
function replaceLiteral(haystack: string, needle: string, replacement: string): string {
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
  switch (sel.type) {
    case "run_input": {
      if (inputFileId === null) {
        throw new Error("this workflow needs a file to run on");
      }
      const row = queryOpt(
        db,
        "SELECT name, coalesce(mime_type,'') FROM files WHERE id = ? AND trashed_at IS NULL",
        [inputFileId],
        (r) => [r[0] as string, r[1] as string] as const
      );
      if (row === null) {
        throw new Error("the file this run was invoked on is no longer in the room");
      }
      return [[inputFileId, row[0], row[1]] as const];
    }
    // newest / all / name_like INCLUDE generated files (see module doc).
    case "newest":
      return queryFiles(
        db,
        "SELECT id, name, coalesce(mime_type,'') FROM files WHERE trashed_at IS NULL ORDER BY created_at DESC LIMIT 1",
        []
      );
    // Same 50-file cap as the other bulk selectors. A file_pass node reads ONE
    // file, so `all` is rejected on it at validation (use for_each_file to
    // cover every file) — every other reader here uses the whole list.
    case "all":
      return queryFiles(
        db,
        "SELECT id, name, coalesce(mime_type,'') FROM files WHERE trashed_at IS NULL ORDER BY created_at DESC LIMIT 50",
        []
      );
    case "name_like": {
      const pat = `%${likeEscape((sel.pattern ?? "").toLowerCase())}%`;
      return queryFiles(
        db,
        "SELECT id, name, coalesce(mime_type,'') FROM files " +
          "WHERE trashed_at IS NULL AND lower(name) LIKE ? ESCAPE '\\' " +
          "ORDER BY created_at DESC LIMIT 20",
        [pat]
      );
    }
    // missing_summary INCLUDES generated files: summarizing only caches a
    // one-liner into the file's `ai_summary` metadata (never a new file), so
    // there is no feedback loop.
    case "missing_summary":
      return queryFiles(
        db,
        "SELECT id, name, coalesce(mime_type,'') FROM files " +
          "WHERE trashed_at IS NULL AND ai_summary IS NULL " +
          "AND extracted_text IS NOT NULL AND trim(extracted_text) != '' " +
          "ORDER BY created_at DESC LIMIT 50",
        []
      );
    // since_last_run EXCLUDES generated files — the feedback-loop guard.
    case "since_last_run":
      return queryFiles(
        db,
        "SELECT id, name, coalesce(mime_type,'') FROM files " +
          "WHERE trashed_at IS NULL AND source != 'generated' AND created_at > ? " +
          "ORDER BY created_at DESC LIMIT 50",
        [prevRunAt ?? ""]
      );
    default:
      return [];
  }
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

/**
 * A `CancelFlag` that, the FIRST time it observes its wrapped flag go `true`,
 * fires a best-effort `/cancel` delivery for `runId`. `delivered()` resolves
 * once that attempt has settled.
 *
 * This exists so {@link sidecarJsonCancellableRun} can reuse the already-
 * reviewed {@link sidecarJsonCancellable} transport verbatim instead of
 * hand-copying its fetch/abort/poll/timeout loop a second time (a copy would
 * be one more place to forget to clear a ten-hour timer, and one more place
 * for the two to drift). The one deliberate ordering difference from Rust —
 * the socket drop and the `/cancel` POST race, rather than strictly
 * sequencing "deliver, THEN drop" — does not change what actually stops the
 * sidecar's work: that is the `/cancel` POST landing on a SEPARATE
 * connection, which happens either way.
 */
class DeliverCancelOnStop extends CancelFlag {
  private deliveryPromise: Promise<void> | null = null;

  constructor(
    private readonly inner: CancelFlag,
    private readonly runId: string
  ) {
    super();
  }

  override load(): boolean {
    const flagged = this.inner.load();
    if (flagged && this.deliveryPromise === null) {
      this.deliveryPromise = (async () => {
        try {
          const base = await ensureUp();
          const guard = busy();
          try {
            await deliverCancel(base, this.runId);
          } finally {
            guard.release();
          }
        } catch {
          // Best-effort, matching Rust's `if let Ok(base) = ensure_up().await`:
          // if the sidecar is unreachable the chain finishes on its own, which
          // is the pre-existing behavior, not worse.
        }
      })();
    }
    return flagged;
  }

  delivered(): Promise<void> {
    return this.deliveryPromise ?? Promise.resolve();
  }
}

/**
 * Like {@link sidecarJsonCancellable}, but for a CHAIN endpoint (`/wf_node`)
 * that runs many generations behind one POST and therefore cannot be stopped
 * by hanging up: measured against the sidecar's pinned uvicorn/starlette, a
 * non-streaming handler kept running seconds past a hard disconnect, which on
 * `Lane::LocalLlm`'s single slot would waste up to six more generations. So
 * Stop is DELIVERED, not implied — POST `/cancel` with the same `run_id` the
 * body carried. Ported from `sidecar_json_cancellable_run`.
 */
export async function sidecarJsonCancellableRun(
  path: string,
  body: unknown,
  cancel: CancelFlag,
  runId: string,
  timeoutMs: number = SIDECAR_CHAIN_TIMEOUT_MS
): Promise<SidecarPostOutcome> {
  if (cancel.load()) {
    // Never reached the sidecar at all — nothing is registered under `runId`
    // for a `/cancel` to find, so there is nothing to deliver.
    return { kind: "stopped" };
  }
  const derived = new DeliverCancelOnStop(cancel, runId);
  const outcome = await sidecarJsonCancellable(path, body, derived, timeoutMs);
  await derived.delivered();
  return outcome;
}

/**
 * The workflow's single LLM entry point: one cancellable `/generate` call with
 * an optional structured-output `format` schema. The `generate` node and
 * `for_each_file`'s per-file calls both come through here, so engine-parity
 * and Stop behave identically across them. Ported from `wf_generate`.
 */
export async function wfGenerate(
  post: SidecarPostFn,
  model: string,
  prompt: string,
  format: unknown | undefined,
  cancel: CancelFlag
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    base_url: resolvedBaseUrl(),
    messages: [{ role: "user", content: prompt }],
    keep_alive: KEEP_ALIVE_WARM,
  };
  if (format !== undefined) {
    body.format = format;
  }
  const outcome = await post("/generate", body, cancel);
  if (outcome.kind === "stopped") {
    throw new Error("STOPPED");
  }
  if (outcome.kind === "error") {
    throw new Error(sidecarErrorSentinel(outcome.error, model));
  }
  const text = asRecord(outcome.value)?.text;
  return typeof text === "string" ? text : "";
}

/** The reserved top-level payload keys `wf_node_value` guards. A node's own
 * body fields are merged UNDER these, never over them — see this module's
 * doc. */
const WF_NODE_RESERVED_KEYS: ReadonlySet<string> = new Set([
  "kind",
  "model",
  "base_url",
  "keep_alive",
  "run_id",
  "parallel",
]);

/**
 * Build one `/wf_node` payload. Ported from `wf_node_value`'s payload
 * construction — read this module's RESERVED KEYS section before changing it.
 */
export function buildWfNodePayload(
  kind: string,
  model: string,
  runId: string,
  lane: Lane,
  body: unknown
): Record<string, unknown> {
  const payload: Record<string, unknown> = Object.create(null);
  payload.kind = kind;
  // TOP-LEVEL, deliberately: `sidecar_json` keys `inject_policy` and
  // `inject_provider_runtime` off `body["model"]`, so nesting it would
  // silently drop the privacy door and the Keychain-backed provider
  // credentials on a cloud engine.
  payload.model = model;
  payload.base_url = resolvedBaseUrl();
  payload.keep_alive = KEEP_ALIVE_WARM;
  payload.run_id = runId;
  // The lane budget, re-imposed INSIDE the step. `plan_dispatch` enforces
  // `local_llm => 1` ACROSS steps because the local model and Whisper are
  // serial; a fan-out inside ONE step would bypass it entirely.
  payload.parallel = laneSlots(lane);
  const fields = asRecord(body);
  if (fields !== null) {
    for (const [k, v] of Object.entries(fields)) {
      if (!WF_NODE_RESERVED_KEYS.has(k)) {
        payload[k] = v;
      }
    }
  }
  return payload;
}

/**
 * Run one workflow CHAIN node in the sidecar's LangGraph (MIGRATION slice
 * 1/2/3, owner decision 2026-07-25: "Rust drives, Python thinks"). Ported from
 * `wf_node_value`.
 */
export async function wfNodeValue(
  post: WfNodePostFn,
  kind: string,
  model: string,
  jobId: string,
  stepId: number,
  lane: Lane,
  body: unknown,
  cancel: CancelFlag
): Promise<Record<string, unknown>> {
  const runId = `${jobId}:${stepId}`;
  const payload = buildWfNodePayload(kind, model, runId, lane, body);
  const outcome = await post("/wf_node", payload, cancel, runId, SIDECAR_CHAIN_TIMEOUT_MS);
  if (outcome.kind === "stopped") {
    throw new Error("STOPPED");
  }
  if (outcome.kind === "error") {
    throw new Error(sidecarErrorSentinel(outcome.error, model));
  }
  const v = asRecord(outcome.value);
  // The sidecar's own Stop answer maps to the same sentinel the host-side one
  // produces — `spawn_workflow_job` normalises it to Paused either way.
  if (v?.stopped === true) {
    throw new Error("STOPPED");
  }
  return v ?? {};
}

/** The common case: a chain node whose whole artifact is its text. Ported from
 * `wf_node`. */
export async function wfNode(
  post: WfNodePostFn,
  kind: string,
  model: string,
  jobId: string,
  stepId: number,
  lane: Lane,
  body: unknown,
  cancel: CancelFlag
): Promise<string> {
  const v = await wfNodeValue(post, kind, model, jobId, stepId, lane, body, cancel);
  return typeof v.result === "string" ? v.result : "";
}

// ============================================================================
// summarize_file's shared sentinel policy (jobs.rs::classify_liner /
// summarize_one_liner + summarize.rs::summarize_one_file)
// ============================================================================

/** What caching ONE file's one-liner produced. Ported from `LinerOutcome`. */
export type LinerOutcome =
  | { readonly kind: "cached"; readonly liner: string }
  | { readonly kind: "stuck" }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "hard"; readonly error: string };

/** One file's one-liner model call — Rust's `summarize_one_file`. Throws on
 * failure (this port's `Result<String,String>` convention). */
export type SummarizeOneFileFn = (model: string, name: string, mime: string, text: string) => Promise<string>;

/**
 * The REAL `/summarize_file` client — a thin proxy, exactly like Rust's
 * `summarize_one_file`: all of the compute (smart_filter, the read_text
 * paging, the structured call and `clean_one_liner`) already lives in the
 * sidecar endpoint, so this posts the same six fields and reads `summary`.
 *
 * Rust calls the NON-cancellable `sidecar_json` here deliberately — the
 * `summarize_file` node checks Stop BETWEEN files, never mid-call, so a call
 * that has started always runs to completion. A fresh {@link CancelFlag} that
 * nothing can flip reproduces exactly that through the already-ported
 * cancellable transport, rather than duplicating a second POST client for the
 * sake of one missing feature.
 */
export const summarizeOneFileViaSidecar: SummarizeOneFileFn = async (model, name, mime, text) => {
  const body = { model, name, text, mime, base_url: resolvedBaseUrl(), keep_alive: KEEP_ALIVE_WARM };
  const outcome = await sidecarJsonCancellable("/summarize_file", body, new CancelFlag());
  if (outcome.kind === "error") {
    throw new Error(sidecarErrorSentinel(outcome.error, model));
  }
  if (outcome.kind === "stopped") {
    // Unreachable: the flag above is never handed to anything that could set
    // it. Kept as an honest branch rather than a cast that claims otherwise.
    throw new Error("STOPPED");
  }
  // Already clean_one_liner'd on the sidecar (≤200 chars, may be "").
  const summary = asRecord(outcome.value)?.summary;
  return typeof summary === "string" ? summary : "";
};

/**
 * The sentinel policy as a pure decision over what the model call returned —
 * testable without a model. Ported from `classify_liner`. See `LinerOutcome`
 * for why an empty ANSWER and a failed CALL must not land in the same bucket.
 *
 * ONE ADDITION beyond the Rust original: an error whose text starts with this
 * port's own `NOT_IMPLEMENTED:` sentinel (which cannot occur in Rust, and
 * cannot come from the real endpoint) classifies as `hard`, never `failed` — a
 * per-file "trying again next time" line would silently mask an entire
 * unported capability as ordinary network flakiness.
 */
export function classifyLiner(reply: { ok: true; liner: string } | { ok: false; error: string }): LinerOutcome {
  if (reply.ok) {
    return reply.liner.trim() !== "" ? { kind: "cached", liner: reply.liner } : { kind: "stuck" };
  }
  const e = reply.error;
  if (e === "OLLAMA_DOWN" || e.startsWith("MODEL_MISSING") || e.startsWith("NOT_IMPLEMENTED")) {
    return { kind: "hard", error: e };
  }
  return { kind: "failed", error: e };
}

/** Ported from `summarize_one_liner` — the classify-wrapped call. */
async function summarizeOneLiner(
  fn: SummarizeOneFileFn,
  model: string,
  name: string,
  mime: string,
  text: string
): Promise<LinerOutcome> {
  try {
    return classifyLiner({ ok: true, liner: await fn(model, name, mime, text) });
  } catch (err) {
    return classifyLiner({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

// ============================================================================
// apply_transform / apply_merge (workflow.rs:1428-1471) — pure, unit-tested
// ============================================================================

const USIZE_DIGITS = /^\+?[0-9]+$/;

/** `v.trim().parse::<usize>().unwrap_or(0)` — a STRICT integer parse (a
 * decimal point, a `-`, or trailing junk is the Rust parse FAILURE, i.e. 0),
 * never `parseInt`'s lenient "read a prefix" behavior. */
function parseUsizeOrZero(raw: string): number {
  const t = raw.trim();
  if (!USIZE_DIGITS.test(t)) {
    return 0;
  }
  const big = BigInt(t.startsWith("+") ? t.slice(1) : t);
  // No realistic text is longer than Number.MAX_SAFE_INTEGER characters, so
  // clamping here reads as "take everything" — which is what a `usize` that
  // large would also do.
  return big > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(big);
}

/** Pure deterministic text transform (unit-tested). Ported from
 * `apply_transform`. */
export function applyTransform(op: string, find: string | null, value: string | null, input: string): string {
  const v = value ?? "";
  switch (op) {
    case "append":
      return `${input}${v}`;
    case "prepend":
      return `${v}${input}`;
    case "replace":
      // LITERAL, like Rust's `str::replace` — see this module's doc on why
      // `String.replaceAll` would expand `$&`/`` $` ``/`$'`/`$1` in `v`.
      return find !== null && find !== "" ? replaceLiteral(input, find, v) : input;
    case "upper":
      return input.toUpperCase();
    case "lower":
      return input.toLowerCase();
    case "trim":
      return input.trim();
    case "truncate":
      return Array.from(input).slice(0, parseUsizeOrZero(v)).join("");
    case "strip_html":
      return stripHtml(input);
    default:
      return input;
  }
}

/** Rust's `str::lines()`: split on `\n`, strip a preceding `\r`, and — unlike
 * a bare `.split("\n")` — never yield a trailing EMPTY segment for a string
 * that simply ended with `\n`. `""` has zero lines, not one empty one. */
function rustLines(s: string): string[] {
  if (s === "") {
    return [];
  }
  const parts = s.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts.map((p) => (p.endsWith("\r") ? p.slice(0, -1) : p));
}

/** Pure fan-in reducer over the live incoming branch results (unit-tested).
 * Ported from `apply_merge`. */
export function applyMerge(mode: string, separator: string | null, inputs: readonly string[]): string {
  const sep = separator ?? "\n\n";
  switch (mode) {
    case "numbered":
      return inputs.map((s, i) => `${i + 1}. ${s}`).join(sep);
    case "dedupe_lines": {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const block of inputs) {
        for (const line of rustLines(block)) {
          if (!seen.has(line)) {
            seen.add(line);
            out.push(line);
          }
        }
      }
      return out.join("\n");
    }
    default: // "concat", and anything unrecognized — validation catches that earlier.
      return inputs.join(sep);
  }
}

// ============================================================================
// executor seams
// ============================================================================

/** A headless agent-turn runner, injected by the concrete spawner so the
 * generic executor stays mock-drivable. Ported from `AgentRunFn`. */
export type AgentRunFn = (question: string) => Promise<string>;

export const AGENT_RUN_NOT_IMPLEMENTED =
  "NOT_IMPLEMENTED: run_agent_headless (workflow.rs:2429-2535, past this batch's range — a headless " +
  "agent turn needs room/tool/engine state, the sidecar loop or an external-CLI bridge) has no Electron port yet.";

/** The stub the `agent_run` arm falls back to — "stub, don't fake",
 * `jobs.ts`'s `renderPodcastAudioNotImplemented` convention. */
export const agentRunNotImplemented: AgentRunFn = () => Promise.reject(new Error(AGENT_RUN_NOT_IMPLEMENTED));

/**
 * Marks the error of a `script_run` step that PARKED for the user's approval
 * instead of failing. A later batch's `park_outcome` strips it and lands the
 * run as paused with the reason attached. It has exactly two readers, and both
 * strip it before anything is shown: that one, and the node-status emit in
 * {@link executeWorkflowStep}. Ported from `NEEDS_APPROVAL`.
 */
export const NEEDS_APPROVAL = "NEEDS_APPROVAL: ";

/**
 * Everything {@link executeWorkflowStep}/{@link runWorkflowNode} need beyond
 * their own arguments — the "no `AppState`/`tauri::Window` port exists yet"
 * seam `jobs.ts`/`filePass.ts`/`scriptRun.ts` already establish, not a second
 * one. Every optional field defaults to the REAL implementation, except
 * `agentRun` and `resolveEngine`, whose Rust originals genuinely have no
 * Electron port and which fall back to labeled refusals.
 */
export interface WorkflowStepDeps {
  rooms: RoomSource;
  /** `app.path().app_cache_dir()` — `runScriptProcess`'s script workspaces
   * live underneath it. Required, because `scriptRun.ts` IS ported: refusing a
   * `script_run` node for a directory Electron can always supply would be a
   * fake gap. */
  cacheDir: string;
  /** The live pipeline-diagram sink — see this module's doc (Phase 2 gap).
   * Also forwarded to `driveFilePass`, which emits its own progress. */
  emit?: EmitFn;
  /** `/generate` transport (the `generate` node, and `for_each_file`'s
   * per-file calls). Defaults to the real {@link sidecarJsonCancellable}. */
  post?: SidecarPostFn;
  /** `/wf_node` transport (extract/route/vote/refine/plan_and_map). Defaults
   * to the real {@link sidecarJsonCancellableRun}. */
  wfNodePost?: WfNodePostFn;
  /** `run_agent_headless` — genuinely unported; defaults to a refusal. */
  agentRun?: AgentRunFn;
  /** `resolve_pass_engine` — genuinely unported; passed straight through to
   * {@link driveFilePass}, which applies its OWN refusal default. */
  resolveEngine?: ResolvePassEngine;
  /** Defaults to the real {@link summarizeOneFileViaSidecar}. */
  summarizeOneFile?: SummarizeOneFileFn;
  /** `crate::web::fetch_page` — defaults to `webFetch.ts`'s SSRF-guarded
   * {@link realFetchPage}; overridable so tests need no network. */
  fetchPage?: (url: string) => Promise<FetchedPage>;
  /** `main_window(app).emit("room-files-changed", ())` — the same optional
   * callback shape `turnEngine.ts`'s `AskDeps` uses for the identical Rust
   * broadcast, since no `BrowserWindow` wiring exists in this migration yet. */
  notifyFilesChanged?: () => void;
  /** Test seam passed straight through to `runScriptProcess`'s own
   * `ScriptRunDeps.execute`. */
  scriptExecute?: typeof executeScriptInWorkspace;
}

/** How one step ended, for the pipeline diagram. Ported from `NodeReport`
 * (`Skipped | Done(String)`). */
export type NodeReport = { readonly kind: "skipped" } | { readonly kind: "done"; readonly result: string };

// ============================================================================
// step.params reading (loose — this is the app's OWN state)
// ============================================================================

function stepParamsRecord(step: Step): Record<string, unknown> {
  return asRecord(step.params) ?? {};
}

function stepModel(params: Record<string, unknown>): string | null {
  return typeof params.model === "string" ? params.model : null;
}

/** `i["parent"].as_u64()` — a non-integer or negative parent is skipped, the
 * same way `as_u64()` returns `None` for one. */
function stepIncoming(params: Record<string, unknown>): Array<{ parent: number; branch: string | null }> {
  const raw = params.incoming;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: Array<{ parent: number; branch: string | null }> = [];
  for (const item of raw) {
    const rec = asRecord(item);
    if (rec === null) {
      continue;
    }
    const parent = rec.parent;
    if (typeof parent === "number" && Number.isInteger(parent) && parent >= 0) {
      out.push({ parent, branch: typeof rec.branch === "string" ? rec.branch : null });
    }
  }
  return out;
}

// ============================================================================
// run_file_pass_node / run_script_node (workflow.rs:2109-2264)
// ============================================================================

/** Ported from `run_file_pass_node`. */
async function runFilePassNode(
  deps: WorkflowStepDeps,
  jobId: string,
  roomPath: string,
  plan: WorkflowPlan,
  select: FileSelector,
  instruction: string,
  mode: string,
  cancel: CancelFlag,
  published: PublishedRef
): Promise<WfArtifact> {
  const files = resolveFiles(deps.rooms, roomPath, select, plan.input_file_id, plan.prev_run_at);
  // A full-file pass reads ONE file end to end. `all` is rejected at
  // validation for this node kind, but a narrowing selector can still match
  // several — name the one that was read and how many were left, rather than
  // dropping the rest in silence.
  const matched = files.length;
  const first = files[0];
  if (first === undefined) {
    return { ...DEFAULT_WF_ARTIFACT, result: "No file matched — nothing to read." };
  }
  const [id, name] = first;
  const driveDeps: DriveFilePassDeps = {
    rooms: deps.rooms,
    emit: deps.emit,
    post: deps.post,
    resolveEngine: deps.resolveEngine,
  };
  const { message, meta } = await driveFilePass(driveDeps, jobId, roomPath, id, name, instruction, mode, cancel);
  const fileId = meta?.id ?? null;
  if (meta !== null) {
    published.value = meta;
  }
  const result =
    matched > 1
      ? `${message}\n\nRead "${name}" only — ${matched - 1} other matching file(s) were not read. ` +
        `A full-file pass covers one file; use a "for each file" step to cover them all.`
      : message;
  return { ...DEFAULT_WF_ARTIFACT, result, file_id: fileId };
}

/**
 * Wave 5 (Idea 13): the `script_run` node arm. Resolves the script file id,
 * reads its consent hash from the IMMUTABLE plan snapshot (a mid-run script
 * edit parks, never silently runs new code), runs it, records the report JSON
 * as the step artifact, and publishes the first imported output. Ported from
 * `run_script_node`.
 */
async function runScriptNode(
  deps: WorkflowStepDeps,
  jobId: string,
  stepId: number,
  roomPath: string,
  plan: WorkflowPlan,
  file: string,
  mode: string,
  stdin: string | null,
  cancel: CancelFlag,
  published: PublishedRef
): Promise<WfArtifact> {
  const db = pinnedDb(deps.rooms, roomPath);
  if (db === null) {
    throw new Error(ROOM_GONE);
  }
  // Resolve the node's `file` (a stored file id, or a name) through the ONE
  // resolver the consent stamping and the consent card also use.
  const resolved = resolveScriptFile(db, file);

  let consent = plan.script_consents.get(resolved.id) ?? null;
  if (consent === null) {
    // A NAME resolves to the newest matching file, so a similarly named file
    // arriving between approval and run can move the id out from under the
    // stamped consent. Consent is content-addressed, so a byte-exact match
    // against a hash THIS plan stamped as approved IS the same approval —
    // anything else still parks.
    const sha = scriptFingerprint(resolved.bytes);
    for (const v of plan.script_consents.values()) {
      if (v === sha) {
        consent = v;
        break;
      }
    }
  }
  const consentHash = consent ?? "";

  const scriptDeps: ScriptRunDeps = {
    rooms: deps.rooms,
    cacheDir: deps.cacheDir,
    notifyFilesChanged: deps.notifyFilesChanged,
    execute: deps.scriptExecute,
  };
  let report: ScriptRunReport;
  try {
    report = await runScriptProcess(scriptDeps, jobId, stepId, roomPath, resolved.id, consentHash, stdin, cancel);
  } catch (err) {
    // A script this run holds no matching approval for did not FAIL — it
    // parked for a person to approve it, and there is nothing about the
    // workflow to fix. Marked (the process's own sentence kept as the cause)
    // so the run lands as paused rather than as a broken step.
    if (scriptFingerprint(resolved.bytes) !== consentHash) {
      throw new Error(`${NEEDS_APPROVAL}${err instanceof Error ? err.message : String(err)}`);
    }
    throw err;
  }

  // Publish the first imported output so a MANUAL run can auto-open it.
  const first = report.imported[0] ?? null;
  if (first !== null) {
    published.value = first;
  }
  const n = report.imported.length;
  // transform mode is a pipe stage: the artifact is the script's STDOUT, so a
  // downstream {{input}} reads the script's output. import mode records the
  // run report JSON (the Wave-5 behavior the run-history view renders
  // specially) — `ScriptRunReport` is already `#[serde(rename_all =
  // "camelCase")]` on the Rust side, so `JSON.stringify` reproduces exactly
  // the wire shape `serde_json::to_string` would.
  let result: string;
  if (mode === "transform") {
    const out = report.stdoutTail.trim();
    result = out === "" ? `(the script produced no output; ${n} file(s) imported)` : out;
  } else {
    try {
      result = JSON.stringify(report);
    } catch {
      result = `Script finished (exit ${report.exitCode}), ${n} file(s) imported.`;
    }
  }
  return { ...DEFAULT_WF_ARTIFACT, result, file_id: first?.id ?? null };
}

// ============================================================================
// summarize_file / for_each_file node bodies
// ============================================================================

async function summarizeFileNode(
  deps: WorkflowStepDeps,
  roomPath: string,
  plan: WorkflowPlan,
  select: FileSelector,
  modelChoice: string | null,
  cancel: CancelFlag
): Promise<WfArtifact> {
  const model = modelChoice ?? plan.resolved_model;
  const files = resolveFiles(deps.rooms, roomPath, select, plan.input_file_id, plan.prev_run_at);
  if (files.length === 0) {
    return { ...DEFAULT_WF_ARTIFACT, result: "No files matched — nothing to summarize." };
  }
  const summarizeOneFile = deps.summarizeOneFile ?? summarizeOneFileViaSidecar;
  const lines: string[] = [];
  for (const [id, name, mime] of files) {
    if (cancel.load()) {
      throw new Error("STOPPED");
    }
    const readDb = pinnedDb(deps.rooms, roomPath);
    const full = readDb === null ? null : getFileExtractedText(readDb, id);
    if (full === null || full.trim() === "") {
      continue;
    }
    // The SHARED sentinel policy (jobs.rs::summarize_one_liner), not a second
    // copy of it: a file the model can't describe is marked with the ''
    // sentinel so it leaves the missing-summary set instead of costing one
    // pointless model call every tick, and a file that simply fails no longer
    // aborts the whole run and strands every later file without a description.
    const outcome = await summarizeOneLiner(summarizeOneFile, model, name, mime, full);
    const cacheDb = pinnedDb(deps.rooms, roomPath);
    if (outcome.kind === "cached") {
      if (cacheDb !== null) {
        setFileAiSummary(cacheDb, id, outcome.liner);
      }
      lines.push(`${name}: ${outcome.liner}`);
    } else if (outcome.kind === "stuck") {
      if (cacheDb !== null) {
        setFileAiSummary(cacheDb, id, "");
      }
      lines.push(`${name}: (no description could be written)`);
    } else if (outcome.kind === "failed") {
      // The CALL failed (timeout / quota / a 502), which says nothing about
      // the file — cache nothing, so this file stays in the missing set and
      // the next run retries it. Caching the sentinel here would have been
      // permanent: every retry selector matches NULL only.
      lines.push(`${name}: (not described this run — trying again next time)`);
    } else {
      throw new Error(outcome.error);
    }
  }
  return { ...DEFAULT_WF_ARTIFACT, result: lines.join("\n") };
}

/** Per-file text budget for a for_each_file map — the local model's Job-tier
 * ctx. Ported from `PER_FILE_CHARS`. */
export const PER_FILE_CHARS = 12_000;

async function forEachFileNode(
  deps: WorkflowStepDeps,
  roomPath: string,
  plan: WorkflowPlan,
  select: FileSelector,
  instructionTemplate: string,
  modelChoice: string | null,
  inputsJoined: string,
  cancel: CancelFlag
): Promise<WfArtifact> {
  const model = modelChoice ?? plan.resolved_model;
  const files = resolveFiles(deps.rooms, roomPath, select, plan.input_file_id, plan.prev_run_at);
  if (files.length === 0) {
    return { ...DEFAULT_WF_ARTIFACT, result: "No files matched — nothing to do." };
  }
  const instr = interpolate(deps.rooms, roomPath, instructionTemplate, inputsJoined);
  const post = deps.post ?? sidecarJsonCancellable;
  const sections: string[] = [];
  for (const [id, name] of files) {
    if (cancel.load()) {
      throw new Error("STOPPED");
    }
    const readDb = pinnedDb(deps.rooms, roomPath);
    const full = readDb === null ? null : getFileExtractedText(readDb, id);
    if (full === null || full.trim() === "") {
      continue;
    }
    // One file, one model call — so a long file is CLIPPED to the local
    // model's job-tier window. Say so, in the prompt and in the section
    // heading: a summary headed with the file's name otherwise reads as a
    // summary of the whole thing when it only saw the first few pages.
    // (`chars.length > PER_FILE_CHARS` is the code-point equivalent of Rust's
    // `clipped.len() < full.len()` byte compare — both mean "characters were
    // dropped", since dropping any UTF-8 character strictly shortens the byte
    // length too.)
    const chars = Array.from(full);
    const cut = chars.length > PER_FILE_CHARS;
    const clipped = cut ? chars.slice(0, PER_FILE_CHARS).join("") : full;
    const note = cut
      ? `\n\n(Only the first ${PER_FILE_CHARS} characters of this file are shown — it is longer. Do not describe it as complete.)`
      : "";
    const prompt = `${instr}\n\nFile: ${name}${note}\n\n${clipped}`;
    const r = await wfGenerate(post, model, prompt, undefined, cancel);
    const heading = cut ? `## ${name}\n\n_Read the first ${PER_FILE_CHARS} characters only._` : `## ${name}`;
    sections.push(`${heading}\n\n${r.trim()}`);
  }
  return {
    ...DEFAULT_WF_ARTIFACT,
    result: sections.length === 0 ? "No files had readable text." : sections.join("\n\n"),
  };
}

// ============================================================================
// save_file_node (workflow.rs:2316-2427)
// ============================================================================

/** `store_file_bytes` (`commands/files.rs`) — snapshot the file's current
 * state into version history, then overwrite it, as ONE write (a failed
 * overwrite taken separately still cuts a version, evicting the oldest
 * snapshot for nothing). A local copy for the same reason
 * `organizeTools.ts`/`safetyTools.ts`/`filePass.ts`/`scriptRun.ts`/
 * `recBridge.ts`/`editMatch.ts` each already carry one: there is no shared
 * port of this two-call pairing to import, only its two halves. */
function storeFileBytes(db: Database.Database, id: string, bytes: Uint8Array, text: string | null, cause: string): void {
  inTransaction(db, () => {
    snapshotFileVersion(db, id, cause);
    updateFileContent(db, id, bytes, text);
  });
}

/**
 * Write the workflow's output as a room file. Idempotent: if this node already
 * created a file (recorded in its artifact), overwrite that file id. Every
 * overwrite is snapshotted first, so a scheduled run can never destroy a page
 * the user edited — Time Machine restores it. Ported from `save_file_node`.
 */
export function saveFileNode(
  rooms: RoomSource,
  roomPath: string,
  nameTemplate: string,
  format: string,
  mode: string,
  inputs: string,
  existing: WfArtifact | null,
  published: PublishedRef,
  cause: string,
  notifyFilesChanged?: () => void
): { result: string; fileId: string } {
  const nameRaw = cleanSaveName(interpolate(rooms, roomPath, nameTemplate, inputs));
  const ext = format === "md" ? "md" : "html";
  const name = nameRaw.toLowerCase().endsWith(`.${ext}`) ? nameRaw : `${nameRaw}.${ext}`;
  const mime = ext === "md" ? "text/markdown" : "text/html";
  const content = ext === "md" ? inputs : htmlDocument(name, inputs);

  const db = pinnedDb(rooms, roomPath);
  if (db === null) {
    throw new Error(ROOM_GONE);
  }

  const prevFileId = existing?.file_id ?? null;
  let meta: FileMeta;
  if (prevFileId !== null) {
    // Idempotent re-run: overwrite the recorded file — unless it is gone
    // (deleted/trashed), in which case a fresh file is inserted instead.
    if (getFileExtractedText(db, prevFileId) !== null) {
      storeFileBytes(db, prevFileId, Buffer.from(content, "utf8"), content, cause);
      meta = getFileMeta(db, prevFileId);
    } else {
      meta = insertFile(db, name, mime, Buffer.from(content, "utf8"), content, "generated");
    }
  } else if (mode === "overwrite" || mode === "append") {
    // Find an existing generated file of this name.
    const existingId = queryOpt(
      db,
      "SELECT id FROM files WHERE name = ? AND source = 'generated' AND trashed_at IS NULL " +
        "ORDER BY created_at DESC LIMIT 1",
      [name],
      (r) => r[0] as string
    );
    if (existingId !== null && mode === "append") {
      const old = getFileExtractedText(db, existingId) ?? "";
      const joined = ext === "md" ? `${old}\n\n${inputs}` : appendIntoHtml(old, name, inputs);
      storeFileBytes(db, existingId, Buffer.from(joined, "utf8"), joined, cause);
      meta = getFileMeta(db, existingId);
    } else if (existingId !== null) {
      storeFileBytes(db, existingId, Buffer.from(content, "utf8"), content, cause);
      meta = getFileMeta(db, existingId);
    } else {
      meta = insertFile(db, name, mime, Buffer.from(content, "utf8"), content, "generated");
    }
  } else {
    meta = insertFile(db, name, mime, Buffer.from(content, "utf8"), content, "generated");
  }

  notifyFilesChanged?.();
  published.value = meta;
  return { result: `Saved "${meta.name}" into the room.`, fileId: meta.id };
}

// ============================================================================
// execute_workflow_step / run_workflow_node (workflow.rs:1496-2107)
// ============================================================================

/**
 * Execute one workflow step and mark the node on the live pipeline diagram.
 *
 * The badge is decided HERE and nowhere else. The work itself is full of error
 * paths — a room closed mid-run, a Stop inside a per-file loop, a store that
 * failed — and each one used to return straight past the diagram, so the box
 * either lost its badge when the run ended or spun forever. One funnel means a
 * step that broke is always the box that turns red. Ported from
 * `execute_workflow_step`; returns a `StepResult` rather than throwing (see
 * this module's DEVIATIONS), so it plugs straight into `jobs.ts`'s `runPlan`.
 */
export async function executeWorkflowStep(
  deps: WorkflowStepDeps,
  jobId: string,
  roomPath: string,
  plan: WorkflowPlan,
  step: Step,
  cancel: CancelFlag,
  published: PublishedRef
): Promise<StepResult> {
  let node: WorkflowNode;
  try {
    node = parseWorkflowNode(stepParamsRecord(step).node);
  } catch {
    return { ok: false, error: "this workflow step is unreadable" };
  }
  emitWorkflowNode(deps.emit, jobId, plan.workflow_id, node.id, "running", null);
  try {
    const report = await runWorkflowNode(deps, jobId, roomPath, plan, step, cancel, published, node);
    if (report.kind === "skipped") {
      emitWorkflowNode(deps.emit, jobId, plan.workflow_id, node.id, "skipped", null);
    } else {
      emitWorkflowNode(deps.emit, jobId, plan.workflow_id, node.id, "done", report.result === "" ? null : report.result);
    }
    return { ok: true };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // Single funnel for EVERY node kind — clean an empty-generation / cloud-
    // quota failure into one actionable line here, so agent_run (which passes
    // its error through raw) reads the same as generate.
    const e = humanizeEmptyGeneration(raw) ?? raw;
    // The park marker is private to the runner: the diagram shows the
    // sentence, never the flag in front of it. The RETURNED error keeps the
    // prefix intact — `park_outcome` (a later batch) reads it there.
    const shown = e.startsWith(NEEDS_APPROVAL) ? e.slice(NEEDS_APPROVAL.length) : e;
    emitWorkflowNode(deps.emit, jobId, plan.workflow_id, node.id, "error", shown);
    return { ok: false, error: e };
  }
}

/**
 * The step's actual work. Room-pinned throughout (every DB touch re-pins,
 * because an `await` is exactly where the open room can be swapped out).
 * Emits nothing — its caller owns the diagram. Ported from
 * `run_workflow_node`.
 */
export async function runWorkflowNode(
  deps: WorkflowStepDeps,
  jobId: string,
  roomPath: string,
  plan: WorkflowPlan,
  step: Step,
  cancel: CancelFlag,
  published: PublishedRef,
  node: WorkflowNode
): Promise<NodeReport> {
  const params = stepParamsRecord(step);
  const modelChoice = stepModel(params);
  const incoming = stepIncoming(params);

  // Liveness: gather live parents' results (a MISSING/skipped parent, or a
  // branch mismatch, is not live). A non-root node with no live incoming edge
  // is skipped (dead subgraph) — skip propagates transitively.
  const readDb = pinnedDb(deps.rooms, roomPath);
  if (readDb === null) {
    throw new Error(ROOM_GONE);
  }
  const liveInputs: string[] = [];
  let livePresent = false;
  for (const { parent, branch } of incoming) {
    const a = loadWfArtifact(readDb, jobId, parent);
    if (edgeIsLive(a, branch)) {
      livePresent = true;
      if (a !== null && a.result.trim() !== "") {
        liveInputs.push(a.result);
      }
    }
  }
  if (incoming.length > 0 && !livePresent) {
    const skipDb = pinnedDb(deps.rooms, roomPath);
    if (skipDb !== null) {
      storeWfArtifact(skipDb, jobId, step.id, {
        ...DEFAULT_WF_ARTIFACT,
        skipped: true,
        node_label: node.label,
        node_kind: nodeKindTag(node),
      });
    }
    return { kind: "skipped" };
  }

  const inputsJoined = liveInputs.join("\n\n");

  // Idempotency: a save_file / file_pass / script_run node that already
  // published (crash between completion and checkpoint) reuses its recorded
  // file instead of inserting a duplicate.
  const existingDb = pinnedDb(deps.rooms, roomPath);
  const existing = existingDb === null ? null : loadWfArtifact(existingDb, jobId, step.id);

  let artifact: WfArtifact;
  switch (node.kind) {
    case "generate": {
      // Rust's Generate arm spells the same `/generate` POST inline that
      // `wf_generate` already makes (same body, no `format`), so this calls
      // {@link wfGenerate} rather than duplicating it a second time — a reuse
      // decision, not a behavior change.
      const prompt = interpolate(deps.rooms, roomPath, node.prompt, inputsJoined);
      const model = modelChoice ?? plan.resolved_model;
      const text = await wfGenerate(deps.post ?? sidecarJsonCancellable, model, prompt, undefined, cancel);
      artifact = { ...DEFAULT_WF_ARTIFACT, result: text };
      break;
    }
    case "summarize_file":
      artifact = await summarizeFileNode(deps, roomPath, plan, node.select, modelChoice, cancel);
      break;
    case "file_pass": {
      // Reuse a prior publish if this node already ran (idempotency).
      if (existing !== null && existing.file_id !== null && !existing.skipped) {
        artifact = { ...DEFAULT_WF_ARTIFACT, result: existing.result, file_id: existing.file_id };
      } else {
        artifact = await runFilePassNode(
          deps,
          jobId,
          roomPath,
          plan,
          node.select,
          node.instruction,
          node.mode,
          cancel,
          published
        );
      }
      break;
    }
    case "agent_run": {
      const q = interpolate(deps.rooms, roomPath, node.question, inputsJoined);
      const agentRun = deps.agentRun ?? agentRunNotImplemented;
      artifact = { ...DEFAULT_WF_ARTIFACT, result: await agentRun(q) };
      break;
    }
    case "save_file": {
      // Owner replacement #3: the one node in this dispatch that COMMITS.
      // `http_fetch` below already refuses on a stopped run, but Save File is
      // the arm that WRITES into the room — a Stop (or a room lock, which
      // flips the same flag) landing on the step before it left the
      // workflow's page in the library after the card said stopped.
      if (stopped(cancel)) {
        throw new Error("STOPPED");
      }
      const { result, fileId } = saveFileNode(
        deps.rooms,
        roomPath,
        node.name_template,
        node.format,
        node.mode,
        inputsJoined,
        existing,
        published,
        `Workflow saved — ${plan.workflow_name}`,
        deps.notifyFilesChanged
      );
      artifact = { ...DEFAULT_WF_ARTIFACT, result, file_id: fileId };
      break;
    }
    case "condition": {
      const newFiles =
        node.op === "new_files_since_last_run" ? countNewFiles(deps.rooms, roomPath, plan.prev_run_at) : 0;
      const taken = evalCondition(node.op, inputsJoined, node.value, newFiles);
      const branch = taken ? "then" : "else";
      artifact = { ...DEFAULT_WF_ARTIFACT, result: `branch: ${branch}`, branch };
      break;
    }
    case "script_run": {
      // Idempotency, the same rule save_file and file_pass keep: an artifact
      // is stored only once the process has FINISHED, so a stored,
      // non-skipped one means this script already ran in THIS job. A wave that
      // failed beside it is never checkpointed, so without this the Resume
      // executes the script a second time — importing a second copy of
      // everything it produced.
      if (existing !== null && !existing.skipped) {
        artifact = { ...DEFAULT_WF_ARTIFACT, result: existing.result, file_id: existing.file_id };
      } else {
        // transform mode makes the script a pipe stage: {{input}} → stdin,
        // stdout → the step artifact. import mode is the Wave-5 behavior.
        const stdin = node.mode === "transform" ? inputsJoined : null;
        artifact = await runScriptNode(
          deps,
          jobId,
          step.id,
          roomPath,
          plan,
          node.file,
          node.mode,
          stdin,
          cancel,
          published
        );
      }
      break;
    }
    case "transform":
      artifact = { ...DEFAULT_WF_ARTIFACT, result: applyTransform(node.op, node.find, node.value, inputsJoined) };
      break;
    case "merge":
      // Merge reduces the live branches individually, so dedupe/numbered can
      // see each branch (not the pre-joined blob).
      artifact = { ...DEFAULT_WF_ARTIFACT, result: applyMerge(node.mode, node.separator, liveInputs) };
      break;
    case "http_fetch": {
      if (cancel.load()) {
        throw new Error("STOPPED");
      }
      const url = interpolate(deps.rooms, roomPath, node.url, inputsJoined);
      const page = await (deps.fetchPage ?? realFetchPage)(url);
      artifact = { ...DEFAULT_WF_ARTIFACT, result: `${page.title}\n\n${page.text}` };
      break;
    }
    case "extract": {
      // MIGRATION slice 3: one structured call, run in the sidecar.
      // `build_extract_schema` moved WITH it, so the schema is not built in
      // two places.
      const model = modelChoice ?? plan.resolved_model;
      const result = await wfNode(
        deps.wfNodePost ?? sidecarJsonCancellableRun,
        "extract",
        model,
        jobId,
        step.id,
        step.lane,
        { fields: node.fields, context: inputsJoined },
        cancel
      );
      artifact = { ...DEFAULT_WF_ARTIFACT, result };
      break;
    }
    case "route": {
      // MIGRATION slice 3. This arm returns a BRANCH as well as text —
      // `compileWorkflow` prunes the dead edges from it — so `wfNode` alone is
      // not enough here and the branch is read explicitly.
      const model = modelChoice ?? plan.resolved_model;
      const ask = interpolate(deps.rooms, roomPath, node.prompt, inputsJoined);
      const v = await wfNodeValue(
        deps.wfNodePost ?? sidecarJsonCancellableRun,
        "route",
        model,
        jobId,
        step.id,
        step.lane,
        { prompt: ask, labels: node.labels, context: inputsJoined },
        cancel
      );
      artifact = {
        ...DEFAULT_WF_ARTIFACT,
        result: typeof v.result === "string" ? v.result : "",
        branch: typeof v.branch === "string" ? v.branch : null,
      };
      break;
    }
    case "vote": {
      // MIGRATION slice 2: self-consistency sampling runs as a LangGraph
      // fan-out in the sidecar. `interpolate` still runs HERE, against the
      // encrypted DB, before the call.
      const model = modelChoice ?? plan.resolved_model;
      const p = interpolate(deps.rooms, roomPath, node.prompt, inputsJoined);
      const result = await wfNode(
        deps.wfNodePost ?? sidecarJsonCancellableRun,
        "vote",
        model,
        jobId,
        step.id,
        step.lane,
        { prompt: p, mode: node.mode, samples: node.samples },
        cancel
      );
      artifact = { ...DEFAULT_WF_ARTIFACT, result };
      break;
    }
    case "for_each_file":
      artifact = await forEachFileNode(
        deps,
        roomPath,
        plan,
        node.select,
        node.instruction,
        modelChoice,
        inputsJoined,
        cancel
      );
      break;
    case "refine": {
      // MIGRATION slice 1 ("Rust drives, Python thinks"): the
      // evaluator-optimizer loop runs as a LangGraph graph in the sidecar.
      // Interpolation happens HERE, before the call — the sidecar never sees a
      // room handle, only finished text.
      const model = modelChoice ?? plan.resolved_model;
      const base = interpolate(deps.rooms, roomPath, node.prompt, inputsJoined);
      const result = await wfNode(
        deps.wfNodePost ?? sidecarJsonCancellableRun,
        "refine",
        model,
        jobId,
        step.id,
        step.lane,
        { prompt: base, rubric: node.rubric, max_rounds: node.max_rounds },
        cancel
      );
      artifact = { ...DEFAULT_WF_ARTIFACT, result };
      break;
    }
    case "plan_and_map": {
      // MIGRATION slice 1: the orchestrator-worker fan-out runs as a LangGraph
      // graph. A cloud step gets its workers overlapped 4-wide for free; a
      // local one still serializes, because the lane's slot count rides along
      // in the payload and becomes a semaphore there.
      const model = modelChoice ?? plan.resolved_model;
      const obj = interpolate(deps.rooms, roomPath, node.objective, inputsJoined);
      const result = await wfNode(
        deps.wfNodePost ?? sidecarJsonCancellableRun,
        "plan_and_map",
        model,
        jobId,
        step.id,
        step.lane,
        { prompt: obj, context: inputsJoined, max_workers: node.max_workers },
        cancel
      );
      artifact = { ...DEFAULT_WF_ARTIFACT, result };
      break;
    }
    default: {
      // Exhaustiveness guard: a future `NodeKind` variant added to
      // `workflowModel.ts` without an arm here fails to COMPILE rather than
      // silently falling through to a fabricated artifact.
      const exhaustive: never = node;
      throw new Error(`internal: unhandled node kind ${JSON.stringify(exhaustive)}`);
    }
  }

  artifact = { ...artifact, node_label: node.label, node_kind: nodeKindTag(node) };
  const writeDb = pinnedDb(deps.rooms, roomPath);
  if (writeDb === null) {
    throw new Error(ROOM_GONE);
  }
  storeWfArtifact(writeDb, jobId, step.id, artifact);
  return { kind: "done", result: artifact.result };
}
