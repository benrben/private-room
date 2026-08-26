/**
 * Wave 5 (Idea 13) — the SCRIPT surface's consent layer: the SEC-1 approval
 * store, the auto-workflow bookkeeping, script scheduling, and the pure
 * run-output shaping the agent seam hands back to the model.
 *
 * Ported from `src-tauri/src/commands/scripts.rs` (876 lines, read in full,
 * including its `#[cfg(test)] mod tests`), plus the two helpers scripts.rs
 * only CALLS: `stamp_script_consents` (`jobs/workflow.rs`, still stubbed) and
 * `resolve_script_file`/`script_fingerprint` (`jobs/script_run.rs`, now landed
 * as `scriptRun.ts` — this file imports and re-exports both rather than
 * keeping its own copy; see the import block below).
 *
 * ============================================================================
 * THE SEC-1 DOCTRINE, AND THE ONE PROPERTY THIS FILE EXISTS TO GUARANTEE
 * ============================================================================
 * Copied verbatim from `mcp_cmds.rs` — the way this migration already ported
 * it in `mcpConfig.ts`: THE ROOM'S AUTHOR IS THE ATTACKER. A `.roomai` is
 * attacker-authored content, so "the user let this code run on this Mac" is:
 *
 *   - PER-MAC. {@link scriptApprovalsFile} is a direct sibling of
 *     `mcpConfig.ts`'s `mcpApprovalsFile` — `script_approvals.json` in the
 *     app's own data folder, NEVER inside a room. A booby-trapped room opened
 *     on a fresh Mac can therefore not ship its own "already approved" stamp.
 *
 *   - CONTENT-ADDRESSED. The key is {@link scriptFingerprint} — SHA-256 of the
 *     script's raw BYTES — not its file id and not its name. ANY edit, down to
 *     a single byte, produces a different hash, so the old approval silently
 *     stops matching and the next run re-prompts. That is the whole gate: it
 *     costs nothing and it cannot be forgotten, because every consumer here
 *     ({@link stampScriptConsents}, {@link setScriptSchedule}) hashes the
 *     file's CURRENT bytes at decision time rather than trusting a hash handed
 *     to it. `scriptConsent.test.ts` proves that end to end — edit a real row
 *     in a real room, then watch the old grant stop covering it.
 *
 * ============================================================================
 * WHAT IS REAL HERE (no unported dependency)
 * ============================================================================
 *   - The approval store: {@link scriptApprovalsFile} /
 *     {@link readScriptApprovals} / {@link addScriptApproval}.
 *   - {@link scriptFingerprint} and {@link resolveScriptFile} — imported and
 *     re-exported from `scriptRun.ts`, not redefined here (see below).
 *   - {@link wfIsForScript} / {@link ensureScriptWorkflow} — the auto-workflow
 *     find-or-create. These LOOK `WorkflowDef`-shaped but are not: a
 *     `db::Workflow`'s `definition` is a `serde_json::Value` (this port's
 *     `Workflow.definition: unknown`), and the Rust source reads it as plain
 *     JSON here (`.get("nodes")`/`.as_array()`) and writes it with a bare
 *     `serde_json::json!` — never the typed struct. So they need only
 *     `db-host/workflows.ts`, already ported.
 *   - {@link stampScriptConsents} — the consent decision itself, ported whole
 *     (node walk, resolve, hash, filter) for the same reason: the Rust
 *     original's only `WorkflowDef` dependency is the shape of the node list,
 *     which is plain JSON on both sides of the wire.
 *   - {@link setScriptSchedule} — checked line by line against
 *     `set_script_schedule`: it touches the fingerprint, the approvals file,
 *     `ensure_script_workflow`, `db::upsert_schedule` and `next_run_from_now`
 *     (`db-host/workflows.ts`, `jobScheduler.ts`) — never `ScriptManifest` or
 *     `WorkflowDef`.
 *   - {@link interpreterLine} / {@link parseScriptDecision} — the pure
 *     fragments of the manual-run consent card.
 *   - {@link createPendingScriptApprovals} / {@link resolveScriptRun} — the
 *     pending-request registry behind the `script-approve-request` card
 *     (Rust's `AppState.script_pending` + the `resolve_script_run` command),
 *     as a plain map so it is testable without a renderer.
 *   - {@link printedOutput} / {@link scriptOutput} / {@link clampScriptOutput}
 *     — what a finished run hands the model.
 *
 * NOT ported, mirroring `mcpConfig.ts`'s own precedent for the analogous piece
 * (`mcp_call_approved`, "the caller's", because it needs a live renderer round
 * trip): `script_run_approved`'s `window.emit` + oneshot wait. Its pure
 * decision half is {@link parseScriptDecision}; its registry half is
 * {@link resolveScriptRun}; only the emit-and-await plumbing between them
 * belongs to a later integration batch.
 *
 * ============================================================================
 * WHAT IS STILL STUBBED — ONE unported dependency
 * ============================================================================
 * `jobs/workflow.rs` (5855 lines) — `WorkflowDef`/`NodeKind`, the definition
 * compiler, `start_workflow_run`. `jobs/script_run.rs` has since landed as
 * `scriptRun.ts` (`ScriptManifest`/`ScriptLang`/`Shortcut`/`Runner`,
 * `script_lang_of`, `parse_script_manifest`, `resolve_interpreter`,
 * `referenced_room_files`, the sandboxed executor) and is no longer stubbed
 * here — {@link scriptFingerprint}/{@link resolveScriptFile} are imported
 * from it directly.
 *
 * The `jobs/workflow.rs` stub below follows this codebase's established shape
 * (`autoIndex.ts`'s `START_REC_READ_NOT_IMPLEMENTED`, `jobScheduler.ts`'s
 * `startWorkflowRunNotImplemented`): an exported message constant naming the
 * real blocker, and a function that fails loudly rather than fabricating a
 * result.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { findFileLike, getFileBytes, getFileBytesNamed, listFiles } from "./db-host/files.js";
import type { RoomHandle } from "./jobs.js";
import { getJobArtifact } from "./db-host/jobs.js";
import {
  createWorkflow,
  getSchedule,
  listWorkflowRuns,
  listWorkflows,
  setWorkflowStatus,
  upsertSchedule,
  type Schedule,
  type Workflow,
  type WorkflowRun,
} from "./db-host/workflows.js";
import { nextRunFromNow } from "./jobScheduler.js";
import {
  parseScriptManifest,
  referencedRoomFiles,
  resolveScriptFile,
  scriptFingerprint,
  scriptLangOf,
  type ResolvedScriptFile,
} from "./scriptRun.js";
import { clampBytes } from "./textClamp.js";
import { readRoomFile } from "./workspace/roomContent.js";

export { resolveScriptFile, scriptFingerprint, type ResolvedScriptFile };

export async function resolveScriptFileInRoom(
  room: RoomHandle,
  file: string,
): Promise<ResolvedScriptFile> {
  if (room.workspace === undefined) return resolveScriptFile(room.db, file);
  const exact = room.db.prepare(
    "SELECT id FROM files WHERE id = ? AND trashed_at IS NULL",
  ).get(file) as { id: string } | undefined;
  const id = exact?.id ?? findFileLike(room.db, file)[0];
  const content = await readRoomFile(room, id);
  return { id, name: content.name, bytes: content.bytes ?? Buffer.alloc(0) };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ============================================================================
// The per-Mac approval store (SEC-1) — ported from `script_approvals_file` /
// `read_script_approvals` / `add_script_approval`.
// ============================================================================

function readFileIfExists(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Approved script fingerprints live OUTSIDE any room, in the app's own data
 * folder — a clone of `mcp_approvals_file`, targeting `script_approvals.json`
 * instead of `mcp_approvals.json`.
 *
 * Rust reads the folder from `app.path().app_data_dir()`; this port takes it
 * as a plain `userDataDir` string, the convention `mcpConfig.ts` already set,
 * so the module stays testable Node with no Electron import. Rust also
 * `create_dir_all`s here; this port creates the folder at WRITE time
 * ({@link addScriptApproval}) instead — a read of a non-existent folder is
 * already "nothing approved", and a reader has no business creating state.
 */
export function scriptApprovalsFile(userDataDir: string): string {
  return path.join(userDataDir, "script_approvals.json");
}

/**
 * Ported from `read_script_approvals`. A missing, empty or corrupt file reads
 * as "nothing approved yet" rather than throwing — fail-closed, the same
 * answer a brand-new Mac gives.
 *
 * DEVIATION, shared verbatim with `mcpConfig.ts`'s `readMcpApprovals` so the
 * two SEC-1 stores behave identically: Rust parses `Vec<String>` all-or-
 * nothing, so one non-string element discards EVERY approval; this keeps the
 * string elements. It can never invent an approval — the only direction that
 * would matter — and it keeps the sibling ports in step.
 */
export function readScriptApprovals(userDataDir: string): string[] {
  const raw = readFileIfExists(scriptApprovalsFile(userDataDir));
  if (raw === null) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Ported from `add_script_approval`. Idempotent — approving the same
 * fingerprint twice does not duplicate the entry. */
export function addScriptApproval(userDataDir: string, fingerprint: string): void {
  const list = readScriptApprovals(userDataDir);
  if (list.includes(fingerprint)) return;
  list.push(fingerprint);
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(scriptApprovalsFile(userDataDir), JSON.stringify(list, null, 2));
}

// FUTURE CONSOLIDATION, done: `scriptFingerprint` and `resolveScriptFile` now
// land unsuffixed in `scriptRun.ts`; this file imports and re-exports them
// (see the top of this file) rather than keeping its own copy, so the
// consent card, the stamper and the executor can never disagree about which
// file is being approved.

// ============================================================================
// The manual-run gate — the pure fragments of the consent card.
// ============================================================================

/**
 * The human command line the run would execute, e.g. "uv run --no-project
 * x.py" — what the card shows. Ported from `interpreter_line`, taken over a
 * structural `{program, argvPrefix}` rather than `jobs/script_run.rs`'s
 * (unported) `Runner`, so it is usable today and needs no change when that
 * type lands.
 *
 * Rust's `Path::file_name()` answers None for a path with no final component
 * ("/", ".."), falling back to the whole program string; `path.basename`
 * returns "" for those, so the same fallback is spelled out here.
 */
export function interpreterLine(
  runner: { program: string; argvPrefix: readonly string[] },
  scriptName: string
): string {
  const base = path.basename(runner.program);
  const prog = base === "" ? runner.program : base;
  return [prog, ...runner.argvPrefix, scriptName].join(" ");
}

/** The frontend's answer to a `script-approve-request`. */
export interface ScriptDecision {
  approved: boolean;
  remember: boolean;
}

/**
 * Ported from `resolve_script_run`'s match arms: "once" runs without
 * remembering; "always" runs AND persists the fingerprint (the caller does the
 * persisting via {@link addScriptApproval}, exactly where Rust's
 * `script_run_approved` does); ANYTHING else declines — a stray string, an
 * empty one, and the 180 s no-answer timeout all land on Rust's `_ =>` arm.
 */
export function parseScriptDecision(decision: string): ScriptDecision {
  switch (decision) {
    case "once":
      return { approved: true, remember: false };
    case "always":
      return { approved: true, remember: true };
    default:
      return { approved: false, remember: false };
  }
}

export type PendingScriptResolver = (decision: ScriptDecision) => void;

/**
 * Rust's `AppState.script_pending: Mutex<HashMap<String, oneshot::Sender<_>>>`
 * — the registry of approve-requests awaiting the renderer's answer. Whoever
 * wires the live card owns the emit half (populating this); {@link
 * resolveScriptRun} is the consume half.
 */
export function createPendingScriptApprovals(): Map<string, PendingScriptResolver> {
  return new Map();
}

/**
 * Ported from the `resolve_script_run` command: apply the frontend's decision
 * to the matching pending request, if it is still waiting. A no-op for an
 * unknown or already-answered id — Rust's `if let Some(tx) = …` drops that
 * case too, with no `else`. Consuming the entry is what makes a second answer
 * to the same card harmless.
 */
export function resolveScriptRun(
  pending: Map<string, PendingScriptResolver>,
  id: string,
  decision: string
): void {
  const resolve = pending.get(id);
  if (resolve === undefined) return;
  pending.delete(id);
  resolve(parseScriptDecision(decision));
}

// ============================================================================
// The auto-workflow — ported from `wf_is_for_script` / `ensure_script_workflow`.
// ============================================================================

/** True when `wf` is the auto-created single-node workflow for `fileId`.
 * Reads `wf.definition` as plain JSON, exactly as the Rust source does at this
 * call site (never the typed `WorkflowDef`). */
export function wfIsForScript(wf: Workflow, fileId: string): boolean {
  if (wf.createdBy !== "script") return false;
  if (!isPlainObject(wf.definition)) return false;
  const nodes = wf.definition["nodes"];
  if (!Array.isArray(nodes)) return false;
  return nodes.some(
    (nd) => isPlainObject(nd) && nd["kind"] === "script_run" && nd["file"] === fileId
  );
}

/**
 * Find-or-create the auto-workflow for a script (a single `script_run` node,
 * `createdBy: 'script'`, `status: 'active'` so the scheduler can fire it).
 * These rows are hidden from the Workflow library — the Scripts page is their
 * home. Scheduling a script = a schedule on this workflow; a manual run =
 * `run_workflow` on it — so status/last-run/history all come from one place.
 *
 * Ported from `ensure_script_workflow`; idempotent — a second call for the
 * same file returns the same id rather than adding a duplicate row.
 */
export function ensureScriptWorkflow(db: Database.Database, fileId: string, name: string): string {
  const existing = listWorkflows(db).find((wf) => wfIsForScript(wf, fileId));
  if (existing !== undefined) return existing.id;
  const definition = {
    version: 1,
    nodes: [{ id: "run", label: `Run ${name}`, kind: "script_run", file: fileId }],
    edges: [] as unknown[],
  };
  const binding = { scope: "general" };
  const id = createWorkflow(db, name, "", "📜", definition, "script", binding);
  // Activation is implicit for a script auto-workflow (the script's own
  // consent is the gate); flip it active so the scheduler can fire it.
  setWorkflowStatus(db, id, "active");
  return id;
}

// ============================================================================
// Consent stamping — ported from `stamp_script_consents` (`jobs/workflow.rs`;
// scripts.rs only calls it). `definition` is a workflow's already-parsed JSON,
// i.e. `Workflow.definition` from `db-host/workflows.ts`; a typed `WorkflowDef`
// from the future workflow.rs port satisfies it unchanged.
// ============================================================================

/**
 * For every `script_run` node in `definition`, resolve its file through the
 * ONE resolver and hash the bytes THAT ARE THERE NOW; keep `fileId -> hash`
 * only when that hash is in `approved` (the per-Mac approvals ∪ this run's
 * freshly granted ones). An unapproved, edited, or unresolvable script gets no
 * entry, so the executor parks instead of running it.
 *
 * THE SEC PROPERTY LIVES IN THE RE-HASH. The approval set is keyed by content,
 * and the content is read here, at decision time — so an approval granted for
 * yesterday's bytes cannot cover today's, and a caller cannot smuggle a stale
 * hash past the gate by computing it early.
 */
export function stampScriptConsents(
  db: Database.Database,
  definition: unknown,
  approved: ReadonlySet<string>
): Map<string, string> {
  const out = new Map<string, string>();
  const nodes =
    isPlainObject(definition) && Array.isArray(definition["nodes"]) ? definition["nodes"] : [];
  for (const node of nodes) {
    if (!isPlainObject(node) || node["kind"] !== "script_run") continue;
    const file = node["file"];
    if (typeof file !== "string") continue;
    let resolved: ResolvedScriptFile;
    try {
      resolved = resolveScriptFile(db, file);
    } catch {
      // An unresolvable script is left to the executor to surface honestly —
      // no consent for a file we cannot even read. (Rust: `if let Ok(…)`.)
      continue;
    }
    const sha = scriptFingerprint(resolved.bytes);
    if (approved.has(sha)) {
      out.set(resolved.id, sha);
    }
  }
  return out;
}

export async function stampScriptConsentsInRoom(
  room: RoomHandle,
  definition: unknown,
  approved: ReadonlySet<string>,
): Promise<Map<string, string>> {
  if (room.workspace === undefined) return stampScriptConsents(room.db, definition, approved);
  const out = new Map<string, string>();
  const nodes = isPlainObject(definition) && Array.isArray(definition["nodes"])
    ? definition["nodes"]
    : [];
  for (const node of nodes) {
    if (!isPlainObject(node) || node["kind"] !== "script_run" || typeof node["file"] !== "string") continue;
    try {
      const resolved = await resolveScriptFileInRoom(room, node["file"]);
      const sha = scriptFingerprint(resolved.bytes);
      if (approved.has(sha)) out.set(resolved.id, sha);
    } catch {
      // The executor reports missing or unreadable scripts.
    }
  }
  return out;
}

// ============================================================================
// Scripts-page command: scheduling. Ported from `set_script_schedule`.
// ============================================================================

/**
 * Schedule (or clear, `kind === ""`) a script. Server-side requires the
 * script's CURRENT fingerprint to be approved on this Mac — defense in depth
 * against a driven UI: a scheduled run must never introduce new or changed
 * code, because nobody is watching when it fires. Delegates to the schedule
 * table on the script's auto-workflow.
 *
 * Throws (Rust's `Err(String)`) when an unapproved script is scheduled or the
 * schedule param is unreadable. Clearing needs no approval — turning something
 * OFF is never the dangerous direction.
 */
export function setScriptSchedule(
  db: Database.Database,
  userDataDir: string,
  fileId: string,
  kind: string,
  param: string,
  enabled: boolean
): void {
  const [name, bytes] = getFileBytesNamed(db, fileId);
  const sha = scriptFingerprint(bytes ?? Buffer.alloc(0));
  if (kind !== "" && !readScriptApprovals(userDataDir).includes(sha)) {
    throw new Error(
      "Approve this script (run it once and choose “Always allow”) before scheduling it."
    );
  }
  const wfId = ensureScriptWorkflow(db, fileId, name);
  if (kind === "") {
    upsertSchedule(db, wfId, "", "", true, true, null);
    return;
  }
  // catch-up ON for daily/weekly (a missed nightly run should catch up);
  // interval runs are frequent enough that a single catch-up adds noise.
  const catchUp = kind === "daily" || kind === "weekly";
  const next = enabled ? nextRunFromNow(kind, param) : null;
  if (enabled && next === null) {
    throw new Error("That schedule is invalid — check the time or interval.");
  }
  upsertSchedule(db, wfId, kind, param, enabled, catchUp, next);
}

export async function setScriptScheduleInRoom(
  room: RoomHandle,
  userDataDir: string,
  fileId: string,
  kind: string,
  param: string,
  enabled: boolean,
): Promise<void> {
  if (room.workspace === undefined) {
    setScriptSchedule(room.db, userDataDir, fileId, kind, param, enabled);
    return;
  }
  const resolved = await resolveScriptFileInRoom(room, fileId);
  const sha = scriptFingerprint(resolved.bytes);
  if (kind !== "" && !readScriptApprovals(userDataDir).includes(sha)) {
    throw new Error("Approve this script (run it once and choose “Always allow”) before scheduling it.");
  }
  const wfId = ensureScriptWorkflow(room.db, fileId, resolved.name);
  if (kind === "") {
    upsertSchedule(room.db, wfId, "", "", true, true, null);
    return;
  }
  const catchUp = kind === "daily" || kind === "weekly";
  const next = enabled ? nextRunFromNow(kind, param) : null;
  if (enabled && next === null) throw new Error("That schedule is invalid — check the time or interval.");
  upsertSchedule(room.db, wfId, kind, param, enabled, catchUp, next);
}

// ============================================================================
// Agent seam: what a finished run hands the model. Ported from
// `printed_output` / `script_output` / `clamp_script_output`.
// ============================================================================

/**
 * What one stored step artifact means by "output". An import-mode `script_run`
 * records the whole run REPORT as its result, so the printed text is the
 * report's `stdoutTail`; a transform-mode step's result already IS the stdout.
 *
 * The stdout is not the WHOLE answer, though: an import-mode script's point is
 * the files it wrote. Quoting the raw report JSON at the model was wrong, but
 * so was dropping it — a script that writes chart.png and prints nothing came
 * back as "it finished successfully and printed nothing", so the assistant
 * could neither name what it produced nor relay why an output was skipped. The
 * printed text leads; the record's short, human parts follow it.
 */
export function printedOutput(rawArtifact: string): string {
  let result = "";
  try {
    const v: unknown = JSON.parse(rawArtifact);
    if (isPlainObject(v) && typeof v["result"] === "string") {
      result = v["result"];
    }
  } catch {
    // Not JSON at all — `result` stays "" (Rust: `.ok()` → `unwrap_or_default`).
  }

  let report: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(result);
    if (isPlainObject(parsed) && typeof parsed["stdoutTail"] === "string") {
      report = parsed;
    }
  } catch {
    // Not a run record — a transform step's result already IS the stdout.
  }
  if (report === null) {
    return result;
  }

  const parts: string[] = [];
  const tail = (report["stdoutTail"] as string).trim();
  if (tail !== "") {
    parts.push(tail);
  }

  const imported = Array.isArray(report["imported"]) ? report["imported"] : [];
  const created = imported
    .map((f) => (isPlainObject(f) && typeof f["name"] === "string" ? f["name"] : null))
    .filter((n): n is string => n !== null);
  if (created.length > 0) {
    parts.push(`Created: ${created.join(", ")}`);
  }

  // Why a declared output did NOT arrive (not written, over the size cap, the
  // new-file import cap) — the user needs to hear these.
  const skipped = Array.isArray(report["skipped"]) ? report["skipped"] : [];
  for (const note of skipped) {
    if (typeof note === "string") {
      parts.push(`Note: ${note}`);
    }
  }

  // Rust: `as_i64().unwrap_or(0) != 0` — a missing or non-numeric exit code
  // reads as 0, and a clean exit is not worth a line.
  const exitCode = typeof report["exitCode"] === "number" ? report["exitCode"] : 0;
  if (exitCode !== 0) {
    parts.push(`Exit code: ${exitCode}`);
  }

  return parts.join("\n");
}

/**
 * Everything the script PRINTED, read back from the run's stored artifacts. A
 * script auto-workflow is one `script_run` node, so step 0 holds it; the loop
 * keeps working if that ever grows a second step, and stops at the first step
 * with no artifact (Rust's `let Ok(Some(raw)) = … else { break }`).
 */
export function scriptOutput(db: Database.Database, jobId: string): string {
  const parts: string[] = [];
  for (let step = 0; step < 4; step++) {
    const raw = getJobArtifact(db, jobId, step);
    if (raw === null) break;
    const text = printedOutput(raw).trim();
    if (text !== "") {
      parts.push(text);
    }
  }
  return parts.join("\n");
}

/**
 * The model reads this; a runaway `print` loop must not eat the turn.
 *
 * The cap is 4000 BYTES, not characters: Rust compares `String::len()`, and
 * cuts at the last char boundary at or before it. {@link clampBytes} is that
 * same cut (`floorBoundary` walks back off a UTF-8 continuation byte exactly
 * as `char_indices().take_while(…).last()` lands on the last char start), so
 * it is reused rather than re-implemented. The marker is appended AFTER the
 * cut, unbudgeted — matching Rust's `truncate(cut); push_str(marker)`, and
 * deliberately NOT `clampBytesMarked`, which reserves the marker's bytes
 * inside the cap and would cut the body a little earlier than Rust does.
 */
export function clampScriptOutput(name: string, out: string): string {
  const MAX = 4000;
  if (out.trim() === "") {
    return `Ran ${name}. It finished successfully and printed nothing.`;
  }
  let body = out;
  if (Buffer.byteLength(body, "utf8") > MAX) {
    body = `${clampBytes(body, MAX)}\n… (output truncated)`;
  }
  return (
    `Ran ${name}. It finished successfully. Its output — quote these values ` +
    `exactly, they are the answer:\n${body}`
  );
}

// ============================================================================
// NOT_IMPLEMENTED stubs — each names the real blocker. See this file's header.
// ============================================================================

/** One script row for the Scripts page — mirrors the Rust `ScriptInfo` struct
 * (`#[serde(rename_all = "camelCase")]`). scripts.rs, not script_run.rs, owns
 * this type, so it is ported here; only {@link listScripts}'s IMPLEMENTATION
 * is blocked.
 *
 * `changedSinceApproval` is true when the script has been run (so an
 * auto-workflow exists) but its CURRENT content is not remembered on this Mac.
 * An "Allow once" run and an edit after "Always allow" both land here and this
 * flag cannot tell them apart — it drives the "Needs review" ribbon, which is
 * honest for both, so that ribbon's tooltip must NOT claim the script changed. */
export interface ScriptInfo {
  fileId: string;
  name: string;
  /** "py" | "js" */
  lang: string;
  deps: string[];
  inputs: string[];
  outputs: string[];
  /** "global" | "file" | "none" */
  shortcut: string;
  /** True when this exact content is approved on this Mac. */
  approved: boolean;
  changedSinceApproval: boolean;
  workflowId: string | null;
  schedule: Schedule | null;
  lastRun: WorkflowRun | null;
  /** How many of the most-recent runs failed with the SAME error text,
   * newest-first (0 = the latest run did not fail). */
  consecutiveFailures: number;
  lastError: string | null;
}

function readableRoomFiles(db: Database.Database, declared: readonly string[], text: string): string[] {
  const names = listFiles(db).map((file) => file.name);
  const out = [...declared];
  for (const name of referencedRoomFiles(text, names, 20)) {
    if (!out.some((existing) => existing.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out;
}

export function listScripts(db: Database.Database, userDataDir: string): ScriptInfo[] {
  const approved = new Set(readScriptApprovals(userDataDir));
  const workflows = listWorkflows(db);
  const out: ScriptInfo[] = [];
  for (const file of listFiles(db)) {
    const lang = scriptLangOf(file.name);
    if (lang === null) continue;
    const bytes = getFileBytes(db, file.id) ?? Buffer.alloc(0);
    const text = bytes.toString("utf8");
    const manifest = parseScriptManifest(file.name, text);
    const isApproved = approved.has(scriptFingerprint(bytes));
    const workflow = workflows.find((candidate) => wfIsForScript(candidate, file.id));
    const runs = workflow ? listWorkflowRuns(db, workflow.id) : [];
    let consecutiveFailures = 0;
    let lastError: string | null = null;
    for (const run of runs) {
      if (run.status !== "error") break;
      const error = run.error ?? "";
      if (lastError === null) {
        lastError = error;
        consecutiveFailures = 1;
      } else if (lastError === error) {
        consecutiveFailures += 1;
      } else {
        break;
      }
    }
    out.push({
      fileId: file.id,
      name: file.name,
      lang,
      deps: manifest.deps,
      inputs: readableRoomFiles(db, manifest.inputs, text),
      outputs: manifest.outputs,
      shortcut: manifest.shortcut,
      approved: isApproved,
      changedSinceApproval: !isApproved && workflow !== undefined,
      workflowId: workflow?.id ?? null,
      schedule: workflow ? getSchedule(db, workflow.id) : null,
      lastRun: runs[0] ?? null,
      consecutiveFailures,
      lastError,
    });
  }
  return out;
}

export async function listScriptsInRoom(
  room: RoomHandle,
  userDataDir: string,
): Promise<ScriptInfo[]> {
  if (room.workspace === undefined) return listScripts(room.db, userDataDir);
  const approved = new Set(readScriptApprovals(userDataDir));
  const workflows = listWorkflows(room.db);
  const out: ScriptInfo[] = [];
  for (const file of listFiles(room.db)) {
    const lang = scriptLangOf(file.name);
    if (lang === null) continue;
    const resolved = await resolveScriptFileInRoom(room, file.id);
    const text = resolved.bytes.toString("utf8");
    const manifest = parseScriptManifest(file.name, text);
    const isApproved = approved.has(scriptFingerprint(resolved.bytes));
    const workflow = workflows.find((candidate) => wfIsForScript(candidate, file.id));
    const runs = workflow ? listWorkflowRuns(room.db, workflow.id) : [];
    let consecutiveFailures = 0;
    let lastError: string | null = null;
    for (const run of runs) {
      if (run.status !== "error") break;
      const error = run.error ?? "";
      if (lastError === null) {
        lastError = error;
        consecutiveFailures = 1;
      } else if (lastError === error) {
        consecutiveFailures += 1;
      } else break;
    }
    out.push({
      fileId: file.id,
      name: file.name,
      lang,
      deps: manifest.deps,
      inputs: readableRoomFiles(room.db, manifest.inputs, text),
      outputs: manifest.outputs,
      shortcut: manifest.shortcut,
      approved: isApproved,
      changedSinceApproval: !isApproved && workflow !== undefined,
      workflowId: workflow?.id ?? null,
      schedule: workflow ? getSchedule(room.db, workflow.id) : null,
      lastRun: runs[0] ?? null,
      consecutiveFailures,
      lastError,
    });
  }
  return out;
}

export function getScriptManifest(db: Database.Database, fileId: string) {
  const [name, bytes] = getFileBytesNamed(db, fileId);
  return parseScriptManifest(name, (bytes ?? Buffer.alloc(0)).toString("utf8"));
}

export async function getScriptManifestInRoom(room: RoomHandle, fileId: string) {
  if (room.workspace === undefined) return getScriptManifest(room.db, fileId);
  const resolved = await resolveScriptFileInRoom(room, fileId);
  return parseScriptManifest(resolved.name, resolved.bytes.toString("utf8"));
}

export function agentListScripts(db: Database.Database, userDataDir: string): string {
  const rows = listScripts(db, userDataDir);
  if (rows.length === 0) return "This room has no .py or .js scripts yet.";
  return rows.map((script) => {
    const deps = script.deps.length === 0 ? "" : `, needs ${script.deps.join(" ")}`;
    return `- ${script.name} (${script.lang}${deps}) — ${script.approved ? "approved to run" : "needs the user's approval on first run"}`;
  }).join("\n");
}

export async function agentListScriptsInRoom(room: RoomHandle, userDataDir: string): Promise<string> {
  const rows = await listScriptsInRoom(room, userDataDir);
  if (rows.length === 0) return "This room has no .py or .js scripts yet.";
  return rows.map((script) => {
    const deps = script.deps.length === 0 ? "" : `, needs ${script.deps.join(" ")}`;
    return `- ${script.name} (${script.lang}${deps}) — ${script.approved ? "approved to run" : "needs the user's approval on first run"}`;
  }).join("\n");
}

export const RUN_SCRIPT_NOT_IMPLEMENTED =
  "NOT_IMPLEMENTED: run_script needs resolve_interpreter/parse_script_manifest " +
  "(commands/jobs/script_run.rs) to resolve the runtime and build the consent card, " +
  "AND start_workflow_run (commands/jobs/workflow.rs) to enqueue the run — neither " +
  "has an Electron port yet. ensureScriptWorkflow/readScriptApprovals/" +
  "scriptFingerprint in scriptConsent.ts are the pieces already waiting for it.";

/** Ported from `run_script_inner` — the shared body of the Tauri command and
 * the agent seam, so the consent gate can never have a second code path. */
export function runScriptInner(
  _db: Database.Database,
  _userDataDir: string,
  _fileId: string
): Promise<string> {
  return Promise.reject(new Error(RUN_SCRIPT_NOT_IMPLEMENTED));
}

/** Ported from the `run_script` command, which is `run_script_inner` with the
 * command-layer shapes — one implementation, deliberately. */
export const runScript = runScriptInner;

export const AGENT_RUN_SCRIPT_NOT_IMPLEMENTED =
  "NOT_IMPLEMENTED: agent_run_script drives runScriptInner to START the run (see " +
  "RUN_SCRIPT_NOT_IMPLEMENTED for that blocker) and then waits up to 150 s for the " +
  "job to finish. printedOutput/scriptOutput/clampScriptOutput in scriptConsent.ts " +
  "are the finished-run half, already ported and tested.";

export function agentRunScript(
  _db: Database.Database,
  _userDataDir: string,
  _scriptName: string
): Promise<string> {
  return Promise.reject(new Error(AGENT_RUN_SCRIPT_NOT_IMPLEMENTED));
}

export const APPROVE_SCRIPT_BYTES_NOT_IMPLEMENTED =
  "NOT_IMPLEMENTED: approve_script_bytes (the Agent-Skill script consent gate) needs " +
  "script_lang_of/parse_script_manifest/resolve_interpreter from " +
  "commands/jobs/script_run.rs, plus the live script-approve-request round trip to a " +
  "renderer window, which this migration has not wired for any consent card yet (see " +
  "mcpConfig.ts's note on mcp_call_approved for the identical gap on the MCP side).";

export function approveScriptBytes(_displayName: string, _bytes: Uint8Array): Promise<never> {
  return Promise.reject(new Error(APPROVE_SCRIPT_BYTES_NOT_IMPLEMENTED));
}

export const APPROVE_WORKFLOW_SCRIPTS_NOT_IMPLEMENTED =
  "NOT_IMPLEMENTED: approve_workflow_scripts (walk a workflow's script_run nodes and " +
  "obtain consent for each unapproved one, so a manual workflow run stops parking on " +
  "a script nobody was ever asked about) needs WorkflowDef/NodeKind from " +
  "commands/jobs/workflow.rs AND parse_script_manifest/resolve_interpreter from " +
  "commands/jobs/script_run.rs, plus the live consent-card round trip. " +
  "stampScriptConsents in scriptConsent.ts is the read-only decision it feeds.";

export function approveWorkflowScripts(_definition: unknown): Promise<never> {
  return Promise.reject(new Error(APPROVE_WORKFLOW_SCRIPTS_NOT_IMPLEMENTED));
}
