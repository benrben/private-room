/** Script approvals, scheduling, and workflow bookkeeping.
 *
 * Room authors are untrusted: approvals are per-Mac and keyed by the current
 * script bytes, so a room cannot ship a grant and every edit requires review.
 * Output rendering is separated into `scriptOutput.ts`; the remaining explicit
 * NOT_IMPLEMENTED adapters fail loudly where workflow execution is not ported.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import {
  findFileLike,
  getFileBytes,
  getFileBytesNamed,
  listFiles,
} from "./db-host/files.js";
import type { RoomHandle } from "./jobs.js";
import {
  createWorkflow,
  getSchedule,
  listWorkflowRuns,
  listWorkflows,
  setWorkflowStatus,
  upsertSchedule,
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
import { readRoomFile } from "./workspace/roomContent.js";
import type {
  FailureHistory,
  ScriptCandidate,
  ScriptInfo,
} from "./scriptConsentTypes.js";

export { resolveScriptFile, scriptFingerprint, type ResolvedScriptFile };
export { clampScriptOutput, printedOutput, scriptOutput } from "./scriptOutput.js";
export type { ScriptInfo } from "./scriptConsentTypes.js";

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
  for (const file of scriptNodeFiles(definition)) {
    try {
      stampResolvedConsent(out, resolveScriptFile(db, file), approved);
    } catch {
      // An unresolvable script is left to the executor to surface honestly —
      // no consent for a file we cannot even read. (Rust: `if let Ok(…)`.)
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
  for (const file of scriptNodeFiles(definition)) {
    try {
      stampResolvedConsent(out, await resolveScriptFileInRoom(room, file), approved);
    } catch {
      // The executor reports missing or unreadable scripts.
    }
  }
  return out;
}

function scriptNodeFiles(definition: unknown): string[] {
  if (!isPlainObject(definition) || !Array.isArray(definition["nodes"])) return [];
  return definition["nodes"].flatMap(scriptNodeFile);
}

function scriptNodeFile(node: unknown): string[] {
  if (!isPlainObject(node) || node["kind"] !== "script_run") return [];
  const file = node["file"];
  return typeof file === "string" ? [file] : [];
}

function stampResolvedConsent(
  consents: Map<string, string>,
  resolved: ResolvedScriptFile,
  approved: ReadonlySet<string>,
): void {
  const fingerprint = scriptFingerprint(resolved.bytes);
  if (approved.has(fingerprint)) consents.set(resolved.id, fingerprint);
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
  scheduleCurrentScript(db, userDataDir, fileId, name, bytes, kind, param, enabled);
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
  scheduleCurrentScript(room.db, userDataDir, fileId, resolved.name, resolved.bytes, kind, param, enabled);
}

function scheduleCurrentScript(
  db: Database.Database,
  userDataDir: string,
  fileId: string,
  name: string,
  bytes: Uint8Array | null,
  kind: string,
  param: string,
  enabled: boolean,
): void {
  requireScheduleApproval(userDataDir, kind, bytes ?? Buffer.alloc(0));
  const workflowId = ensureScriptWorkflow(db, fileId, name);
  updateScriptSchedule(db, workflowId, kind, param, enabled);
}

function requireScheduleApproval(userDataDir: string, kind: string, bytes: Uint8Array): void {
  if (kind === "") return;
  const approved = readScriptApprovals(userDataDir).includes(scriptFingerprint(bytes));
  if (approved) return;
  throw new Error("Approve this script (run it once and choose “Always allow”) before scheduling it.");
}

function updateScriptSchedule(
  db: Database.Database,
  workflowId: string,
  kind: string,
  param: string,
  enabled: boolean,
): void {
  if (kind === "") {
    upsertSchedule(db, workflowId, "", "", true, true, null);
    return;
  }
  upsertSchedule(db, workflowId, kind, param, enabled, scheduleCatchesUp(kind), scheduleNextRun(kind, param, enabled));
}

function scheduleCatchesUp(kind: string): boolean {
  return kind === "daily" || kind === "weekly";
}

function scheduleNextRun(kind: string, param: string, enabled: boolean): string | null {
  if (!enabled) return null;
  const next = nextRunFromNow(kind, param);
  if (next !== null) return next;
  throw new Error("That schedule is invalid — check the time or interval.");
}

function readableRoomFiles(db: Database.Database, declared: readonly string[], text: string): string[] {
  const names = listFiles(db).map((file) => file.name);
  const out = [...declared];
  for (const name of referencedRoomFiles(text, names, 20)) {
    if (!out.some((existing) => existing.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out;
}

function scriptCandidates(db: Database.Database): ScriptCandidate[] {
  const candidates: ScriptCandidate[] = [];
  for (const file of listFiles(db)) {
    const lang = scriptLangOf(file.name);
    if (lang !== null) candidates.push({ file, lang });
  }
  return candidates;
}

function failureHistory(runs: readonly WorkflowRun[]): FailureHistory {
  const first = runs[0];
  if (first?.status !== "error") return { consecutiveFailures: 0, lastError: null };
  const lastError = first.error ?? "";
  return { consecutiveFailures: matchingFailures(runs, lastError), lastError };
}

function matchingFailures(runs: readonly WorkflowRun[], error: string): number {
  let count = 0;
  for (const run of runs) {
    if (run.status !== "error") break;
    if ((run.error ?? "") !== error) break;
    count += 1;
  }
  return count;
}

function scriptInfo(
  db: Database.Database,
  approved: ReadonlySet<string>,
  workflows: readonly Workflow[],
  candidate: ScriptCandidate,
  bytes: Buffer,
): ScriptInfo {
  const text = bytes.toString("utf8");
  const manifest = parseScriptManifest(candidate.file.name, text);
  const workflow = workflows.find((item) => wfIsForScript(item, candidate.file.id));
  const runs = workflow === undefined ? [] : listWorkflowRuns(db, workflow.id);
  const failures = failureHistory(runs);
  const isApproved = approved.has(scriptFingerprint(bytes));
  return {
    fileId: candidate.file.id,
    name: candidate.file.name,
    lang: candidate.lang,
    deps: manifest.deps,
    inputs: readableRoomFiles(db, manifest.inputs, text),
    outputs: manifest.outputs,
    shortcut: manifest.shortcut,
    approved: isApproved,
    changedSinceApproval: !isApproved && workflow !== undefined,
    workflowId: workflow?.id ?? null,
    schedule: workflow === undefined ? null : getSchedule(db, workflow.id),
    lastRun: runs[0] ?? null,
    consecutiveFailures: failures.consecutiveFailures,
    lastError: failures.lastError,
  };
}

export function listScripts(db: Database.Database, userDataDir: string): ScriptInfo[] {
  const approved = new Set(readScriptApprovals(userDataDir));
  const workflows = listWorkflows(db);
  return scriptCandidates(db).map((candidate) => {
    const bytes = getFileBytes(db, candidate.file.id) ?? Buffer.alloc(0);
    return scriptInfo(db, approved, workflows, candidate, bytes);
  });
}

export async function listScriptsInRoom(
  room: RoomHandle,
  userDataDir: string,
): Promise<ScriptInfo[]> {
  if (room.workspace === undefined) return listScripts(room.db, userDataDir);
  const approved = new Set(readScriptApprovals(userDataDir));
  const workflows = listWorkflows(room.db);
  const out: ScriptInfo[] = [];
  for (const candidate of scriptCandidates(room.db)) {
    const resolved = await resolveScriptFileInRoom(room, candidate.file.id);
    out.push(scriptInfo(room.db, approved, workflows, candidate, resolved.bytes));
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
