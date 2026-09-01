/** Approval gate for model-requested file mutations.
 *
 * The room handle is re-read after awaiting consent, every approved plan is
 * checked for identity and byte staleness, and no answer declines by default.
 * Encrypted-workspace apply/rollback lives in `editGateWorkspace.ts`.
 * Viewer saves and read-only previews are intentionally outside this gate.
 */

import { randomUUID } from "node:crypto";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type Database from "better-sqlite3-multiple-ciphers";
import { getFileBytes, getFileName } from "./db-host/files.js";
import { getSetting } from "./db-host/settings.js";
import { EditError, commitPlans, hashBytes, type PlannedWrite } from "./editMatch.js";
import type { EditDecision } from "./roomManager.js";
import type { ToolEffects } from "./execTool.js";
import type { WorkspaceService } from "./workspace/workspaceService.js";
import { applyWorkspaceWithStaleness } from "./editGateWorkspace.js";

export { applyWorkspaceWithStaleness } from "./editGateWorkspace.js";

// ------------------------------------------------------------- room/emit plumbing

/** The open room right now, or `null`. Structurally identical to
 * `turnEngine.ts`'s `OpenRoom` / `jobs.ts`'s `RoomHandle`; redeclared locally
 * per this batch's convention (see this file's module doc) rather than
 * imported, since no ported `AppState` exists yet to anchor a single shared
 * shape. */
export interface OpenRoom {
  db: Database.Database;
  path: string;
  workspace?: WorkspaceService;
}

/** The slice of the (not-yet-ported) `AppState` {@link gatedWrite} needs:
 * whichever room is open RIGHT NOW, re-read independently in phase 1 and
 * phase 3 rather than cached across the approval await. Mirrors
 * `docxEdit.ts`'s own `RoomSource` field-for-field. */
export interface RoomSource {
  currentRoom(): OpenRoom | null;
}

/** `AppState::with_room`'s own refusal, spelled exactly as `recIpc.ts` /
 * `docxEdit.ts` / `execTool.ts` already spell it. */
const NO_ROOM_OPEN = "No room is open.";

/** `let _ = window.emit(...)` — a best-effort UI notification that must
 * never turn a successful write into a failed one. Each module in this
 * migration keeps its own copy of this exact one-liner (`docxEdit.ts`,
 * `organizeTools.ts`, `safetyTools.ts`, …) rather than sharing one; this file
 * follows that same convention. */
export type EmitFn = (event: string, payload: unknown) => void;

function emitSafely(emit: EmitFn | undefined, event: string, payload: unknown): void {
  try {
    emit?.(event, payload);
  } catch {
    // Swallowed deliberately, matching Rust's `let _ = window.emit(...)`.
  }
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// --------------------------------------------------------------- preview shapes

/** One touched file, as the diff card renders it. Ported from `FilePreview`. */
export interface FilePreview {
  name: string;
  before: string;
  after: string;
  clipped: boolean;
}

/** What the frontend renders as a diff card — one {@link FilePreview} per
 * touched file. Ported from `EditPreview`. */
export interface EditPreview {
  tool: string;
  /** Whether "Apply for the rest of this answer" is offered — only when the
   * cadence is "turn" AND this is the run-scoped LocalEngine sink. */
  allowTurn: boolean;
  files: FilePreview[];
}

/** Ported from `edit_gate::build_preview`. */
export function buildPreview(tool: string, plans: readonly PlannedWrite[], allowTurn: boolean): EditPreview {
  return {
    tool,
    allowTurn,
    files: plans.map((p) => ({
      name: p.renameTo ?? p.realName,
      before: p.before,
      after: p.after,
      clipped: p.clipped,
    })),
  };
}

// ------------------------------------------------------------------- cadence

/**
 * Cadence: does THIS mutating call need approval? `off`/absent/unknown ⇒
 * never. `edit` ⇒ every call. `turn` ⇒ once per answer (skipped after the
 * user chose "rest of this answer", which only sticks on the run-scoped
 * sink). Ported from `edit_gate::approval_needed`.
 */
export function approvalNeeded(
  setting: string | null,
  effects: Pick<ToolEffects, "runScoped" | "editApprovedThisTurn">
): boolean {
  if (setting === "edit") {
    return true;
  }
  if (setting === "turn") {
    return !(effects.runScoped && effects.editApprovedThisTurn);
  }
  return false;
}

/** A2 (2026-08-04): above this many changed places, force the preview card
 * even with the gate OFF (the app's default) — replacing 2 occurrences and
 * replacing 400 were previously treated identically, both applying
 * instantly. Ported from `edit_gate::REPLACE_ALL_PREVIEW_THRESHOLD`. */
export const REPLACE_ALL_PREVIEW_THRESHOLD = 10;

/**
 * Does this batch of plans change enough places to force a preview
 * regardless of the cadence setting? `PlannedWrite.count` means OCCURRENCES
 * for `edit_file` (an `all: true`/HTML multi-replace can be large) and, for
 * `edit_files`, is 1 per touched file (it has no `all`, so no single
 * file-edit there can be a mass replace) — summing across files also catches
 * an unusually large atomic batch. `write_file`'s `count` is a CHARACTER
 * count, not occurrences, so it is deliberately never scale-checked here —
 * every ordinary rewrite would trip a 10-character floor. Ported from
 * `edit_gate::is_large_scale_edit`.
 */
export function isLargeScaleEdit(tool: string, plans: readonly PlannedWrite[]): boolean {
  if (tool !== "edit_file" && tool !== "edit_files") {
    return false;
  }
  const total = plans.reduce((sum, p) => sum + p.count, 0);
  return total > REPLACE_ALL_PREVIEW_THRESHOLD;
}

// ------------------------------------------------------------- decision + resolve

/** Map the frontend's decision string. Factored out so it is unit-testable.
 * Ported from `edit_gate::decision_from_str`. */
export function decisionFromStr(decision: string): EditDecision {
  switch (decision) {
    case "once":
      return { approved: true, restOfTurn: false };
    case "turn":
      return { approved: true, restOfTurn: true };
    default:
      return { approved: false, restOfTurn: false };
  }
}

/** What the caller is told when the request it is answering is no longer
 * waiting. A local, byte-identical copy of `commands::agent_ui::
 * NO_LONGER_WAITING` — see this file's module doc for why it cannot be
 * imported from a real `agentUi.ts` yet. */
export const NO_LONGER_WAITING =
  "That request had already been given up on, so answering it now did nothing. " +
  "Ask again if you still want it.";

/**
 * The command's body, without the IPC wrapper, so the expired case is
 * testable. Answering an id that is NOT pending is an ERROR, not a no-op —
 * the card outlives the tool call waiting on it (the call gives up on its own
 * 180s budget and the model is told nobody approved), so pressing "Apply
 * once" afterwards must say so rather than silently doing nothing while the
 * card vanishes. Ported from `edit_gate::deliver_edit_decision` (see this
 * file's module doc for the one collapsed failure mode).
 */
export function deliverEditDecision(
  pending: Map<string, (decision: EditDecision) => void>,
  id: string,
  decision: EditDecision
): { ok: true } | { ok: false; error: string } {
  const resolve = pending.get(id);
  if (resolve === undefined) {
    return { ok: false, error: NO_LONGER_WAITING };
  }
  pending.delete(id);
  resolve(decision);
  return { ok: true };
}

/**
 * `resolve_edit_approval` — the frontend's answer to an `edit-approve-request`
 * ("once", "turn", or anything else, which declines). Throws
 * {@link NO_LONGER_WAITING} for an id that is no longer pending, matching
 * this codebase's convention for a command body that used to return
 * `Result<(), String>` (`recBridge.ts`'s stubs, `docxEdit.ts`'s refusals).
 */
export function resolveEditApproval(
  pending: Map<string, (decision: EditDecision) => void>,
  id: string,
  decision: string
): void {
  const result = deliverEditDecision(pending, id, decisionFromStr(decision));
  if (!result.ok) {
    throw new Error(result.error);
  }
}

/** Register `resolve_edit_approval` on `ipcMain`. NOT wired into any
 * bootstrap in this batch (rule 4) — same posture as `recIpc.ts`'s
 * `registerRecIpc` and `docxEdit.ts`'s `registerDocxEditIpc`. */
export function registerEditGateIpc(
  ipcMain: Pick<IpcMain, "handle">,
  editPending: Map<string, (decision: EditDecision) => void>
): void {
  ipcMain.handle("resolve_edit_approval", (_event: IpcMainInvokeEvent, args: { id: string; decision: string }) => {
    resolveEditApproval(editPending, args.id, args.decision);
  });
}

// -------------------------------------------------------------- phase 3: staleness

/** `db::get_file_name(conn, id).ok()` — `null` on any DB error (not found,
 * trashed), never a throw. */
function tryGetFileName(db: Database.Database, id: string): string | null {
  try {
    return getFileName(db, id);
  } catch {
    return null;
  }
}

/** `db::get_file_bytes(conn, id).ok().flatten().unwrap_or_default()` —
 * `null`/missing row/trashed row and a row whose bytes column is itself
 * `null` all read as empty, matching Rust's `Option<Option<Vec<u8>>>`
 * collapse. */
function tryGetFileBytesOrEmpty(db: Database.Database, id: string): Buffer {
  try {
    return getFileBytes(db, id) ?? Buffer.alloc(0);
  } catch {
    return Buffer.alloc(0);
  }
}

/**
 * Phase 3 core: re-check each plan's staleness token against the file's
 * CURRENT bytes (strict-fail — the user approved specific bytes; a
 * concurrent change means the preview lied), then commit all plans in one
 * transaction. Ported from `edit_gate::apply_with_staleness`.
 */
export function applyWithStaleness(db: Database.Database, plans: readonly PlannedWrite[], cause: string): void {
  for (const p of plans) {
    // IDENTITY FIRST, for every plan — including the rename-only ones, which
    // carry no byte token (`staleness: null`) and were therefore applied with
    // NO check whatsoever. The card said "notes.md → archive.md"; if notes.md
    // has since been renamed by the user, or trashed, that sentence is no
    // longer true of the file this id points at, and renaming it anyway
    // performs a change nobody was shown.
    const currentName = tryGetFileName(db, p.fileId);
    if (currentName !== p.realName) {
      throw new EditError(
        `"${p.realName}" was renamed or removed while the approval was pending; ` +
          `nothing was applied. Look it up again and retry.`,
        "stale"
      );
    }
    if (p.staleness !== null) {
      const current = tryGetFileBytesOrEmpty(db, p.fileId);
      if (!hashBytes(current).equals(p.staleness)) {
        throw new EditError(
          `"${p.realName}" changed while the approval was pending; nothing was applied. ` +
            `Read it again and retry.`,
          "stale"
        );
      }
    }
  }
  try {
    commitPlans(db, plans, cause);
  } catch (e) {
    throw new EditError(errMessage(e), "error");
  }
}

// ----------------------------------------------------------------------- gate

/** How the diff card ended. Nobody answering is NOT the same fact as a
 * person reading the diff and saying no. Ported from `edit_gate::
 * EditVerdict`. */
export type EditVerdict = "approved" | "declined" | "no_answer";

/** Rust's fixed `Duration::from_secs(180)`. */
export const EDIT_APPROVAL_TIMEOUT_MS = 180_000;

/** Everything {@link gatedWrite} (and {@link editCallApproved}) needs from
 * the (not-yet-ported) `AppState` + live window. */
export interface GatedWriteDeps {
  rooms: RoomSource;
  /** `state.edit_pending` — the exact shape `roomManager.ts`'s
   * `RoomManagerState.editPending` already declares, so a real host can hand
   * that field straight in. */
  editPending: Map<string, (decision: EditDecision) => void>;
  emit?: EmitFn;
  /** ms budget before an unanswered card is treated as a no-answer decline.
   * Defaults to {@link EDIT_APPROVAL_TIMEOUT_MS}; overridable ONLY so a test
   * isn't three real minutes long — every real caller should leave this
   * unset. */
  timeoutMs?: number;
}

/**
 * SEC-1b-shaped: emit the diff, await a decision, decline on timeout/closed
 * window. On "rest of this answer" set the turn flag — but only on the
 * run-scoped sink, where it actually persists for the answer. Ported from
 * `edit_gate::edit_call_approved`; the `tokio::sync::oneshot` + `timeout`
 * pairing becomes a `Promise` raced against a `setTimeout` that both prunes
 * {@link GatedWriteDeps.editPending} and resolves "no answer" (see this
 * file's module doc for why there is no separate "receiver dropped" branch).
 */
export async function editCallApproved(
  deps: GatedWriteDeps,
  effects: Pick<ToolEffects, "runScoped" | "editApprovedThisTurn">,
  preview: EditPreview
): Promise<EditVerdict> {
  const id = randomUUID();
  const decision = await new Promise<EditDecision | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      deps.editPending.delete(id);
      resolve(null);
    }, deps.timeoutMs ?? EDIT_APPROVAL_TIMEOUT_MS);
    timer.unref?.();
    deps.editPending.set(id, (d) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(d);
    });
    emitSafely(deps.emit, "edit-approve-request", {
      id,
      tool: preview.tool,
      allowTurn: preview.allowTurn,
      files: preview.files,
    });
  });
  if (decision === null) {
    return "no_answer";
  }
  if (decision.approved && decision.restOfTurn && effects.runScoped) {
    effects.editApprovedThisTurn = true;
  }
  return decision.approved ? "approved" : "declined";
}

/** Emit the post-write events and set the anti-fabrication `wrote` flag.
 * Ported from `edit_gate::finish`. */
export function finish(
  deps: Pick<GatedWriteDeps, "emit">,
  effects: Pick<ToolEffects, "wrote">,
  plans: readonly PlannedWrite[]
): void {
  effects.wrote = true;
  emitSafely(deps.emit, "room-files-changed", undefined);
  for (const p of plans) {
    emitSafely(deps.emit, "file-updated", p.fileId);
  }
}

/** The result of running a mutation through the gate. Ported from
 * `edit_gate::GateOutcome`. */
export type GateOutcome =
  | { kind: "applied"; plans: PlannedWrite[] }
  /** The user declined (or timed out) — an Ok-not-Err message the model can
   * recover from, mirroring the MCP decline path. */
  | { kind: "declined"; message: string }
  | { kind: "error"; error: EditError };

function canApplyWithoutApproval(
  tool: string,
  setting: string | null,
  effects: ToolEffects,
  plans: readonly PlannedWrite[],
): boolean {
  return !approvalNeeded(setting, effects) && !isLargeScaleEdit(tool, plans);
}

function writeFailure(error: unknown): GateOutcome {
  return {
    kind: "error",
    error: error instanceof EditError ? error : new EditError(errMessage(error), "error"),
  };
}

function applyImmediateWrite(
  room: OpenRoom,
  deps: GatedWriteDeps,
  effects: ToolEffects,
  plans: PlannedWrite[],
  cause: string,
): GateOutcome | Promise<GateOutcome> {
  if (room.workspace !== undefined) {
    return applyWorkspaceWithStaleness(room.db, room.workspace, plans, cause)
      .then((): GateOutcome => {
        finish(deps, effects, plans);
        return { kind: "applied", plans };
      })
      .catch(writeFailure);
  }
  try {
    commitPlans(room.db, plans, cause);
  } catch (error) {
    return writeFailure(error);
  }
  finish(deps, effects, plans);
  return { kind: "applied", plans };
}

function immediateGateOutcome(
  tool: string,
  cause: string,
  deps: GatedWriteDeps,
  effects: ToolEffects,
  room: OpenRoom,
  setting: string | null,
  plans: PlannedWrite[],
): GateOutcome | Promise<GateOutcome> | null {
  if (plans.length === 0) {
    return { kind: "error", error: new EditError("Nothing to change.", "error") };
  }
  if (canApplyWithoutApproval(tool, setting, effects, plans)) {
    return applyImmediateWrite(room, deps, effects, plans, cause);
  }
  return null;
}

function declinedApprovalOutcome(verdict: EditVerdict): GateOutcome | null {
  if (verdict === "approved") return null;
  if (verdict === "declined") {
    return {
      kind: "declined",
      message:
        "The user declined the proposed change after seeing the preview, so nothing was " +
        "modified. Ask what they'd like instead.",
    };
  }
  return {
    kind: "declined",
    message:
      "Nobody answered the preview of this change in time, so nothing was modified. " +
      "That is not a decision the user made — say the change is still waiting and " +
      "offer to propose it again.",
  };
}

async function applyApprovedWrite(
  room: OpenRoom,
  deps: GatedWriteDeps,
  effects: ToolEffects,
  plans: PlannedWrite[],
  cause: string,
): Promise<GateOutcome> {
  try {
    if (room.workspace === undefined) applyWithStaleness(room.db, plans, cause);
    else await applyWorkspaceWithStaleness(room.db, room.workspace, plans, cause);
  } catch (error) {
    return writeFailure(error);
  }
  finish(deps, effects, plans);
  return { kind: "applied", plans };
}

async function completeApprovedWrite(
  tool: string,
  cause: string,
  deps: GatedWriteDeps,
  effects: ToolEffects,
  plans: PlannedWrite[],
  allowTurn: boolean,
): Promise<GateOutcome> {
  const verdict = await editCallApproved(deps, effects, buildPreview(tool, plans, allowTurn));
  const declined = declinedApprovalOutcome(verdict);
  if (declined !== null) return declined;
  const room = deps.rooms.currentRoom();
  if (room === null) return { kind: "error", error: new EditError(NO_ROOM_OPEN, "error") };
  return applyApprovedWrite(room, deps, effects, plans, cause);
}

/**
 * Run a file mutation through the diff-preview gate. `compute` produces the
 * proposed writes with no writes of its own — it MUST throw an
 * {@link EditError} (never a plain `Error`) on failure, exactly as each real
 * call site in `agent.rs` arranges at the point it builds this closure (e.g.
 * `edit_files`' `plan_batch(conn, &ops).map_err(|m| EditError::batch_failure(m))`
 * — `planBatch` itself throws a plain `Error`, so the CALLER is responsible
 * for that conversion before it ever reaches this function; `gatedWrite` only
 * wraps a non-`EditError` throw as a generic `"error"` outcome as a safety
 * net, which is not the same tag a well-formed caller would have chosen).
 *
 * With the gate off (default), the writes commit inline — byte-identical to
 * the pre-Wave-2 path. With it on, the diff is shown, and on consent the
 * ALREADY-COMPUTED bytes are re-checked for staleness and applied. The room
 * is read fresh in phase 1 and again, independently, in phase 3 — see this
 * file's module doc for why that stands in for Rust's "never hold the lock
 * across the await". Ported from `edit_gate::gated_write`.
 */
export async function gatedWrite(
  tool: string,
  cause: string,
  deps: GatedWriteDeps,
  effects: ToolEffects,
  compute: (db: Database.Database, workspace?: WorkspaceService) => PlannedWrite[] | Promise<PlannedWrite[]>
): Promise<GateOutcome> {
  // Phase 1 (sync): compute proposed writes, decide whether to gate.
  const room1 = deps.rooms.currentRoom();
  if (room1 === null) return { kind: "error", error: new EditError(NO_ROOM_OPEN, "error") };
  let plans: PlannedWrite[];
  try {
    const computed = compute(room1.db, room1.workspace);
    plans = computed instanceof Promise ? await computed : computed;
  } catch (error) {
    return writeFailure(error);
  }
  const setting = getSetting(room1.db, "edit_approval");
  const allowTurn = setting === "turn" && effects.runScoped;
  const immediate = immediateGateOutcome(tool, cause, deps, effects, room1, setting, plans);
  if (immediate !== null) return immediate;
  return completeApprovedWrite(tool, cause, deps, effects, plans, allowTurn);
}
