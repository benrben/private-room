/**
 * Port of `src-tauri/src/commands/edit_gate.rs` (524 lines, read in full,
 * including its `#[cfg(test)] mod tests`) — Wave 2 (Idea 6)'s opt-in
 * diff-preview APPROVAL GATE for the four file-mutating tool arms `edit_file`
 * / `edit_files` / `write_file` / `set_cells`: oneshot + 180s timeout,
 * decline-by-default, "Apply for the rest of this answer" only on the
 * run-scoped sink. Default OFF — the instant-apply + auto-snapshot +
 * one-click Undo model already covers regret post-hoc; A2's scale check
 * (`isLargeScaleEdit`) forces a preview even with the gate off, once a single
 * call changes enough places that "instant" stops feeling safe.
 *
 * ============================================================================
 * WHAT THIS FILE GATES, AND WHAT IT DOES NOT — read this before touching
 * `docx_edit.rs`/`office.rs`
 * ============================================================================
 * `edit_gate.rs` exists ONLY for the tool-invoked mutations `agent.rs`'s
 * `exec_tool` dispatches: `edit_file` / `edit_files` / `write_file` /
 * `set_cells`, each wrapped in `gated_write` around `edit_match.rs`'s
 * `plan_single_edit` / `plan_batch` / `plan_write_file` / `plan_set_cells`.
 *
 * `docx_edit.rs`'s `update_docx_text` (the Word-viewer Save button) is
 * CONFIRMED INDEPENDENT of this gate — it writes directly through
 * `store_file_bytes` under the room lock, with no `gated_write` wrapper
 * anywhere in its body. `docxEdit.ts`'s own module doc reaches the identical
 * conclusion independently ("NOT PORTED: edit_gate.rs ... is a SEPARATE Rust
 * module this command never calls"), which is the cross-check this batch's
 * instructions asked for.
 *
 * `office.rs`'s `slide_preview`/`office_html` are READ-ONLY renders (Quick
 * Look / `textutil`, cached, never touching `files.rows`) — there is no
 * mutation for a gate to sit in front of; they never call `gated_write` or
 * `store_file_bytes` either.
 *
 * NOT A MODEL TOOL EITHER: this file's own `#[tauri::command]`,
 * `resolve_edit_approval`, has no `exec_tool` arm and no entry in
 * `toolSpecs.ts`/`toolSchema.ts` (confirmed by grep, same check `docxEdit.ts`
 * ran for `update_docx_text`) — it exists purely so the renderer can answer
 * the `edit-approve-request` card, exactly like `resolve_mcp_call` /
 * `resolve_agent_ui` / `resolve_script_run` answer THEIR own cards. Nothing in
 * this file is wired into `execTool.ts`'s dispatch.
 *
 * WHAT STILL BLOCKS THE `execTool.ts` "Batch D" stub on `edit_file` /
 * `edit_files` / `write_file` / `set_cells` (out of scope for THIS file,
 * flagged for whichever batch wires those arms): `edit_match.ts` (the
 * plan/commit machinery) and this file's {@link gatedWrite} are now both
 * real, but the tool arms in `agent.rs` also call three helpers that live in
 * `agent.rs` itself, not in `edit_gate.rs` or `edit_match.rs`, and have no
 * port yet: `dry_run_summary` (the `dry_run: true` early-return path),
 * `write_file_summary` (the success sentence for `write_file`) and
 * `validate_cell_refs` (`set_cells`'s cell-reference validation). Nothing
 * else is missing — `edit_match.rs`'s `EditMethod::outcome()` in particular
 * does NOT need a separate port: it is an identity mapping onto the same five
 * strings `editMatch.ts`'s `EditMethod` type already IS, so `p.method` is
 * already the outcome string on this side of the port.
 *
 * ============================================================================
 * THE LOCK, AND WHY THIS PORT HAS NONE
 * ============================================================================
 * Rust's hard part is lock discipline: `state.room` is a `std::sync::Mutex`
 * whose guard is not `Send`, so it can never be held across the approval
 * `.await` — `gated_write` locks (phase 1: compute + decide), drops, awaits,
 * then re-locks (phase 3: re-check + apply).
 *
 * Node has no threads and therefore no `Mutex` to hold or drop — the
 * property that actually matters is narrower: never CACHE a room reference
 * across the await, because the awaited approval genuinely can take the
 * user long enough for the room to close (or a different one to open) in
 * the meantime. {@link GatedWriteDeps.rooms} is read fresh in phase 1 and
 * again, independently, in phase 3 — the exact "re-read rather than reusing
 * the handle" idiom `turnEngine.ts`'s `handoffChat` already established for
 * this identical shape of problem. `RoomSource`/`OpenRoom` are redeclared
 * locally rather than imported from `turnEngine.ts`, matching `docxEdit.ts`'s
 * own choice (same batch, same reasoning): no ported `AppState` exists yet,
 * so each call site keeps the minimal shape it needs rather than depending on
 * a "room access" module that might rename its own contract later.
 *
 * A cross-room switch between phase 1 and phase 3 needs NO special detection
 * beyond what phase 3 already checks: the plan's `fileId` simply will not
 * resolve to `p.realName` in a room that never had that id, which is already
 * the "renamed or removed" refusal below — identical to how Rust's own
 * re-locked guard would behave if a totally different `Room` sat behind it.
 *
 * ============================================================================
 * THE ONESHOT CHANNEL, COLLAPSED
 * ============================================================================
 * Rust's `tokio::sync::oneshot` gives `deliver_edit_decision` two distinct
 * failure shapes — the id is not in the map (already answered, or the 180s
 * timeout already reclaimed it), OR the id IS in the map but the `Receiver`
 * was independently dropped (the awaiting task died first) — and its own test
 * exercises both ("live" answered twice; an "orphan" whose `rx` is dropped
 * out from under a live `tx`).
 *
 * `editPending` here is `Map<string, (decision: EditDecision) => void>` (the
 * exact shape `roomManager.ts`'s `RoomManagerState.editPending` already
 * declares, matching `McpDecision`'s sibling registries) — a plain callback,
 * not a channel with two independently droppable halves. There is no JS
 * analogue of "the receiver task died while the sender still holds the slot":
 * the callback IS the only handle on the awaiting promise, so removing it
 * from the map is the one and only way "no longer waiting" can become true.
 * {@link deliverEditDecision} therefore has a single failure case (not
 * pending), which still proves the property the Rust test cares about —
 * answering a dead request is always an ERROR, never a silent no-op — just
 * without a separate branch for a failure mode this design cannot produce.
 *
 * `NO_LONGER_WAITING` is a local, byte-identical copy of
 * `commands::agent_ui::NO_LONGER_WAITING` — `agent_ui.rs` (the AgentUi
 * screen-driving bridge) has no Electron port yet (see `execTool.ts`'s
 * `ui_snapshot`/`ui_act` stub), so this file cannot import it the way the
 * Rust source's `crate::commands::agent_ui::NO_LONGER_WAITING` does. A future
 * `agentUi.ts` port should become the one true source and this copy should
 * then import from it instead.
 *
 * ============================================================================
 * WHAT IS REAL HERE (checked line by line against the Rust source)
 * ============================================================================
 *   - {@link approvalNeeded} / {@link REPLACE_ALL_PREVIEW_THRESHOLD} /
 *     {@link isLargeScaleEdit} — the cadence and scale-forcing rules, pure.
 *   - {@link decisionFromStr} / {@link deliverEditDecision} /
 *     {@link resolveEditApproval} — the frontend decision parse and the
 *     command body that delivers it to a pending card.
 *   - {@link buildPreview} — plans to the `EditPreview`/`FilePreview` shape
 *     the approve-request event carries.
 *   - {@link applyWithStaleness} — the phase-3 re-check (identity FIRST, for
 *     every plan including rename-only ones with no byte token, THEN the
 *     byte-hash staleness check) followed by {@link commitPlans}.
 *   - {@link editCallApproved} / {@link finish} / {@link gatedWrite} — the
 *     full three-phase orchestration, over injected {@link GatedWriteDeps}
 *     rather than a live `tauri::Window`/`State`.
 *   - {@link registerEditGateIpc} — thin `ipcMain.handle` registration for
 *     `resolve_edit_approval`, unwired from any bootstrap (rule 4), the same
 *     posture `recIpc.ts`/`docxEdit.ts` already take for their own commands.
 *
 * NEITHER RUST'S OWN TEST MODULE NOR THIS PORT'S exercises `gated_write` /
 * `edit_call_approved` directly in Rust — they need a live async runtime plus
 * a `tauri::Window`, so Rust's own coverage stops at the pure helpers above.
 * This port adds real coverage for the full three-phase flow too (own
 * section in `editGate.test.ts`), since the orchestration is exactly the
 * riskiest part and a fixture room + a fake `GatedWriteDeps` make it cheap to
 * exercise for real.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type Database from "better-sqlite3-multiple-ciphers";
import { getFileBytes, getFileName, setFileExtractedText } from "./db-host/files.js";
import { getSetting } from "./db-host/settings.js";
import { EditError, commitPlans, extractText, hashBytes, type PlannedWrite } from "./editMatch.js";
import type { EditDecision } from "./roomManager.js";
import type { ToolEffects } from "./execTool.js";
import type { WorkspaceService } from "./workspace/workspaceService.js";

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

function strictText(bytes: Buffer): string | null {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return null; }
}

/** Workspace phase-3 commit. Every file is preflighted before the first
 * mutation, every byte write has an expected-hash guard, and every outgoing
 * head is stored in the encrypted object-backed version history. */
export async function applyWorkspaceWithStaleness(
  db: Database.Database,
  workspace: WorkspaceService,
  plans: readonly PlannedWrite[],
  cause: string,
): Promise<void> {
  const current = new Map<string, { relativePath: string; hash: string }>();
  for (const plan of plans) {
    const row = db.prepare(
      `SELECT name, relative_path FROM files
       WHERE id = ? AND storage_kind = 'workspace' AND trashed_at IS NULL`,
    ).get(plan.fileId) as { name: string; relative_path: string } | undefined;
    if (row === undefined || row.name !== plan.realName) {
      throw new EditError(
        `"${plan.realName}" was renamed or removed while the approval was pending; ` +
          "nothing was applied. Look it up again and retry.",
        "stale",
      );
    }
    const bytes = await workspace.readBuffer(plan.fileId);
    const hash = hashBytes(bytes).toString("hex");
    if (plan.staleness !== null && hash !== plan.staleness.toString("hex")) {
      throw new EditError(
        `"${plan.realName}" changed while the approval was pending; nothing was applied. ` +
          "Read it again and retry.",
        "stale",
      );
    }
    current.set(plan.fileId, { relativePath: row.relative_path, hash });
  }

  const versions = new Map<string, string>();
  for (const plan of plans) {
    if (plan.newBytes !== null) versions.set(plan.fileId, await workspace.snapshotVersion(plan.fileId, cause));
  }
  const applied: Array<{ plan: PlannedWrite; finalHash: string; renamed: boolean }> = [];
  try {
    for (const plan of plans) {
      const before = current.get(plan.fileId)!;
      let expectedHash = before.hash;
      let recorded = false;
      if (plan.newBytes !== null) {
        await workspace.writeAtomic(plan.fileId, Readable.from([plan.newBytes]), expectedHash);
        expectedHash = hashBytes(plan.newBytes).toString("hex");
        setFileExtractedText(
          db,
          plan.fileId,
          extractText(plan.realName, plan.newBytes) ?? strictText(plan.newBytes) ?? "",
        );
        applied.push({ plan, finalHash: expectedHash, renamed: false });
        recorded = true;
      }
      if (plan.renameTo !== null) {
        const parent = path.posix.dirname(before.relativePath);
        const destination = parent === "." ? plan.renameTo : path.posix.join(parent, plan.renameTo);
        await workspace.move(plan.fileId, destination, expectedHash);
        if (recorded) applied[applied.length - 1]!.renamed = true;
      }
      if (!recorded) applied.push({ plan, finalHash: expectedHash, renamed: plan.renameTo !== null });
    }
  } catch (error) {
    let rollbackFailed = false;
    for (const { plan, finalHash, renamed } of [...applied].reverse()) {
      try {
        const before = current.get(plan.fileId)!;
        if (renamed) await workspace.move(plan.fileId, before.relativePath, finalHash);
        const versionId = versions.get(plan.fileId);
        if (versionId !== undefined) {
          const snapshot = await workspace.versionSnapshot(versionId);
          await workspace.writeAtomic(plan.fileId, Readable.from([snapshot.bytes]), finalHash);
          if (snapshot.text !== null) setFileExtractedText(db, plan.fileId, snapshot.text);
        }
      } catch {
        rollbackFailed = true;
      }
    }
    // Snapshots are useful evidence if rollback could not be completed. When
    // rollback succeeded, remove the transient versions produced by a batch
    // that ultimately changed nothing.
    if (!rollbackFailed) {
      for (const versionId of versions.values()) await workspace.deleteVersion(versionId).catch(() => undefined);
    }
    if (rollbackFailed) {
      throw new EditError(
        "The batch hit a conflict and Arcelle could not safely restore every earlier file. " +
          "Review the changed files and use History to restore them.",
        "error",
      );
    }
    throw error;
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
  if (room1 === null) {
    return { kind: "error", error: new EditError(NO_ROOM_OPEN, "error") };
  }
  let plans: PlannedWrite[];
  try {
    const computed = compute(room1.db, room1.workspace);
    plans = computed instanceof Promise ? await computed : computed;
  } catch (e) {
    const err = e instanceof EditError ? e : new EditError(errMessage(e), "error");
    return { kind: "error", error: err };
  }
  if (plans.length === 0) {
    return { kind: "error", error: new EditError("Nothing to change.", "error") };
  }
  const setting = getSetting(room1.db, "edit_approval");
  const allowTurn = setting === "turn" && effects.runScoped;
  if (!approvalNeeded(setting, effects) && !isLargeScaleEdit(tool, plans)) {
    // Gate off (or "turn" already granted), and not a mass replace: apply now.
    try {
      if (room1.workspace === undefined) commitPlans(room1.db, plans, cause);
      else await applyWorkspaceWithStaleness(room1.db, room1.workspace, plans, cause);
    } catch (e) {
      return { kind: "error", error: new EditError(errMessage(e), "error") };
    }
    finish(deps, effects, plans);
    return { kind: "applied", plans };
  }

  // Phase 2 (await): show the diff and await consent.
  const preview = buildPreview(tool, plans, allowTurn);
  const verdict = await editCallApproved(deps, effects, preview);
  if (verdict === "declined") {
    return {
      kind: "declined",
      message:
        "The user declined the proposed change after seeing the preview, so nothing was " +
        "modified. Ask what they'd like instead.",
    };
  }
  if (verdict === "no_answer") {
    return {
      kind: "declined",
      message:
        "Nobody answered the preview of this change in time, so nothing was modified. " +
        "That is not a decision the user made — say the change is still waiting and " +
        "offer to propose it again.",
    };
  }

  // Phase 3 (sync): staleness re-check, then apply the computed bytes. The
  // room is re-read rather than reusing `room1` — the await above is exactly
  // the gap in which it can close, or a different one open.
  const room2 = deps.rooms.currentRoom();
  if (room2 === null) {
    return { kind: "error", error: new EditError(NO_ROOM_OPEN, "error") };
  }
  try {
    if (room2.workspace === undefined) applyWithStaleness(room2.db, plans, cause);
    else await applyWorkspaceWithStaleness(room2.db, room2.workspace, plans, cause);
  } catch (e) {
    const err = e instanceof EditError ? e : new EditError(errMessage(e), "error");
    return { kind: "error", error: err };
  }
  finish(deps, effects, plans);
  return { kind: "applied", plans };
}
