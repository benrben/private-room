/**
 * Whole-room checkpoints — the COMMAND layer. Ported from
 * `src-tauri/src/commands/room_checkpoints.rs` (890 lines, read in full,
 * including its `#[cfg(test)] mod tests`): the five `#[tauri::command]`
 * wrappers `create_room_checkpoint`, `list_room_checkpoints`,
 * `delete_room_checkpoint`, `rollback_room_checkpoint` and
 * `list_stranded_checkpoints`, plus the three private helpers they share
 * (`create_checkpoint_core`, `checkpoint_name`, `stranded_checkpoint_names`)
 * and the `CheckpointList` payload struct Rust declares in this same file.
 *
 * ============================================================================
 * WHAT THIS SITS ON TOP OF — nothing below is re-declared here
 * ============================================================================
 * Everything in `room_checkpoints.rs` that is PURE over a connection + a
 * directory (timestamps, manifest I/O, `reconcile`, the `df`/statfs disk
 * check, `writeCheckpoint`, `performSwap`, `checkpointIdOk`,
 * `pruneAutoCheckpoints`, `checkpointCkPaths`) is ALREADY ported and committed
 * in `db-host/checkpoints.ts` — this module imports it and adds nothing of its
 * own to that layer, exactly as `room_checkpoints.rs` calls its own top half
 * from its bottom half.
 *
 * The "AppState" half is `roomManager.ts` (`rooms.rs`, already ported and
 * committed): {@link RoomManagerState} (the open `Room` with its in-memory
 * password, `rollingBack`, and `cancel.ts`'s cancel registries),
 * {@link RoomManagerDeps}, {@link drainInflight}, {@link teardownOpenRoom},
 * and {@link openRoomImpl} — the UNGUARDED reopen body whose own doc comment
 * says it exists so "a future `rollback_room_checkpoint` port can reopen the
 * swapped file while its own flag is still set". This is that port; nothing in
 * `roomManager.ts` was changed to make it work.
 *
 * ============================================================================
 * THE ROLLBACK SEQUENCE — read this before touching {@link rollbackRoomCheckpoint}
 * ============================================================================
 * Ported in the EXACT order `rollback_room_checkpoint` runs it, because the
 * order IS the safety property:
 *
 *   1. Validate the id shape (`checkpointIdOk`) — refuse before touching
 *      anything. The id is pasted into a path that is then SWAPPED IN over the
 *      user's room file, so it is rejected, never sanitized.
 *   2. Snapshot the open room's `(path, password)` — `NO_ROOM_OPEN` if none.
 *   3. Confirm the checkpoint's `.roomck` is still a real payload — present
 *      AND non-empty (see {@link checkpointPayloadPresent}; this is the one
 *      place the port is deliberately STRICTER than the Rust source, and
 *      DEVIATION 5 says why). Re-checked again after step 5.
 *   4. Claim the rollback: refuse with `ROLLBACK_BUSY` if one is already in
 *      flight, else set `state.rollingBack = true`. The check-then-set is
 *      SYNCHRONOUS — no `await` between them, and before the first `await` in
 *      the whole function — mirroring Rust's single
 *      `rollback_in_flight.swap(true, SeqCst)`. This matters even though Node
 *      is single-threaded: the event loop interleaves other IPC calls during
 *      `drainInflight`'s awaited sleeps, so the flag must be up before the
 *      first suspension point, not merely "set somewhere in this function".
 *   5. Drain in-flight asks/jobs (bounded wait); refuse if either did not
 *      finish, AND again if either cancel registry is still non-empty (Rust
 *      keeps both checks; so does this).
 *   6. Verify the checkpoint decrypts under the room's CURRENT password —
 *      BEFORE anything is torn down. This catches a copy a `changePassword`
 *      re-key failed to carry forward (see {@link listStrandedCheckpoints}).
 *   7. Take a "Before rollback to …" AUTO safety copy of the STILL-OPEN live
 *      room, then prune auto copies to 3. This is the one point a failed
 *      rollback is recoverable from.
 *   8. {@link teardownOpenRoom} — closes the live connection, so nothing holds
 *      the room file open when the swap renames over it.
 *   9. {@link performSwap} — copy-then-rename the checkpoint over the room
 *      path. On failure NOTHING was destructively moved (the copy failed
 *      before the rename, or the rename left the original in place), so the
 *      ORIGINAL file is reopened via {@link openRoomImpl} and the swap error
 *      surfaced; if THAT reopen also fails, the combined message says the room
 *      is now CLOSED rather than leaving the user locked out with no
 *      explanation (the exact bug the Rust source's own comment calls out).
 *  10. Reopen the swapped file via {@link openRoomImpl} — the UNGUARDED body,
 *      because `state.rollingBack` is still true and the guarded `openRoom`
 *      would refuse. A failure here reports distinctly ("Rolled back, but
 *      reopening the room failed"): the data move already succeeded.
 *  11. Best-effort `"room-rolled-back"` emit, then return the fresh
 *      {@link RoomInfo}.
 *
 * `state.rollingBack` is cleared in a `finally` wrapping steps 5-11 — every
 * exit path, success or throw — standing in for Rust's `RollbackGuard`, a
 * `Drop` impl that clears the flag on every return out of the command.
 *
 * ============================================================================
 * TWO DISTINCT "ROLLING BACK" REFUSAL STRINGS — kept distinct on purpose
 * ============================================================================
 *   - {@link createRoomCheckpoint} and {@link rollbackRoomCheckpoint} say
 *     `ROLLBACK_BUSY` (`turnContext.ts`'s shared constant, the same one
 *     `roomManager.ts`'s four lifecycle guards use).
 *   - {@link deleteRoomCheckpoint} says "Can't delete a checkpoint while the
 *     room is rolling back." — a DIFFERENT literal, because Rust's own
 *     `delete_room_checkpoint` inlines its own sentence rather than reusing
 *     `ROLLBACK_BUSY` (a rollback may be reading or pruning the very directory
 *     a delete would touch). Collapsing them would be a silent behavior
 *     change, not a cleanup.
 *   - {@link listRoomCheckpoints} and {@link listStrandedCheckpoints} have NO
 *     rollback guard at all — Rust has none either; reading while a rollback
 *     is in flight is harmless.
 *
 * ============================================================================
 * DELIBERATE DEVIATIONS FROM THE RUST SOURCE
 * ============================================================================
 *  1. No JS destructor: `RollbackGuard`'s `Drop` becomes an explicit
 *     `try/finally` (see the sequence above).
 *  2. {@link rollbackRoomCheckpoint} takes an optional trailing
 *     {@link DrainTiming}, threaded straight through to {@link drainInflight}
 *     and defaulting to Rust's own real timings — the exact testability
 *     affordance `roomManager.ts` already documents `DrainTiming` as existing
 *     for (and the same shape as its `reportRecRecoveryFailure(..., delayMs =
 *     2000)`), so the "a job never drains" refusal can be proven without a
 *     real ~2 s wait. No production caller passes it.
 *  3. `createRoomCheckpoint`/`rollbackRoomCheckpoint` stay `async` for
 *     contract parity with their Rust `pub async fn` signatures; the rest stay
 *     synchronous because their Rust counterparts are plain `pub fn`. Rust's
 *     `tokio::task::block_in_place` around the (possibly GB-scale) `VACUUM
 *     INTO` has no Electron equivalent — see `safetyTools.ts`'s own "ASYNC
 *     SHAPE, NOT A PERFORMANCE FIX" note for the identical reasoning applied
 *     to its three room-sized operations.
 *  4. The `"room-rolled-back"` emit is wrapped in a `try`/`catch` that
 *     swallows, matching Rust's `let _ = app.emit(...)`: a listener that
 *     throws must not turn a COMPLETED rollback into a reported failure.
 *  5. THE ONE BEHAVIOUR CHANGE, and it is a data-loss fix. Rust checks the
 *     checkpoint payload with a bare `Path::exists()`, once, before the
 *     drain. {@link checkpointPayloadPresent} checks `size > 0` instead, at
 *     that same point AND again after the drain. The reason is in that
 *     function's own doc: the verify step immediately after cannot refuse a
 *     missing file — it CREATES one (SQLite's default `SQLITE_OPEN_CREATE`,
 *     on both sides of the port) — and an empty database verifies clean, so
 *     Rust's sequence tears the room down and renames zero bytes over it
 *     while reporting a completed restore. Reproducing that faithfully would
 *     mean shipping a path that destroys the user's room, so this is the one
 *     place the port refuses to. Nothing legitimate is affected: a `.roomck`
 *     this app wrote is never empty, and every other input reaches exactly
 *     the refusal Rust gives it.
 *
 * ============================================================================
 * `with_room`'s ERROR REWRITE IS PART OF THE PORT
 * ============================================================================
 * Rust's `create_checkpoint_core` is `state.with_room(|room|
 * write_checkpoint(..))`, and `AppState::with_room` runs EVERY error its
 * closure returns through `humanize_storage_error` (`commands.rs:430`). That
 * is not incidental here: the documented failure mode of this feature is a
 * multi-GB `VACUUM INTO` on a volume that fills up, and the raw SQLite text
 * ("unable to open database: /…/<uuid>.tmp", "database or disk is full") is
 * exactly what that rewrite exists to replace with a sentence naming a remedy.
 * {@link createCheckpointCore} therefore applies `roomManager.ts`'s already-
 * ported {@link humanizeStorageError} — the same way its `writeRecoveryKey`
 * does — so both the plain create AND the pre-rollback safety copy report a
 * disk failure the way every other room write in the app does. The other four
 * commands pass INFALLIBLE closures to `with_room` in Rust (they only clone
 * `room.path`/`room.password`), so nothing is humanized there, and nothing is
 * here.
 *
 * ============================================================================
 * TWO PROPERTIES INHERITED FROM THE RUST SOURCE — documented, not "fixed"
 * ============================================================================
 *  1. `closeRoom`/`createRoom`/`openRoom`/`renameRoom` (all in
 *     `roomManager.ts`) only ever READ `state.rollingBack`; this module is its
 *     only writer. So a `closeRoom()` that read the flag as `false` and then
 *     suspended inside `drainInflight` can be overtaken by a rollback claiming
 *     the flag and running its own teardown/reopen during that same
 *     suspension, and the room can end up open again right after the user
 *     asked to lock it. `teardownOpenRoom` tolerates running twice (every step
 *     re-checks `state.room !== null`), so the room FILE is never corrupted.
 *     This is not a regression introduced by this port: `rolling_back()` is a
 *     plain `AtomicBool::load`, not a `compare_exchange`, at all four of
 *     `rooms.rs`'s call sites, so real Tokio tasks interleave the same way.
 *     Closing it means giving all five commands a shared claim, which is
 *     `roomManager.ts`'s file to change.
 *  2. Step 7 prunes auto copies to 3 BEFORE step 9 swaps. If the user rolls
 *     back TO an auto ("Before rollback to …") copy that the fresh safety copy
 *     pushes out of the newest three, its payload is deleted before the swap
 *     reads it. The failure is graceful and non-destructive — `performSwap`'s
 *     staging copy fails, the ORIGINAL room is reopened, and the user is told
 *     the copy could not be staged — and it is precisely what Rust does, so it
 *     is reproduced rather than "corrected" here.
 *
 * ============================================================================
 * MODEL-INVOCABLE SURFACE — checked, there is none
 * ============================================================================
 * All five commands are registered in `lib.rs`'s `invoke_handler`, and NONE of
 * them appears in `commands/agent.rs`'s `exec_tool` match arms, in
 * `exec_tool.rs`, or in this migration's `execTool.ts`/`toolSpecs.ts`/
 * `toolSchema.ts` — grepped for each command name and for the bare word
 * "checkpoint", zero hits in either tree. Checkpoints are app-lifecycle UI (a
 * Settings/rollback screen), never a tool the model can call, so `execTool.ts`
 * is untouched by this batch.
 *
 * ============================================================================
 * NOT WIRED INTO ANY BOOTSTRAP (rule 4)
 * ============================================================================
 * {@link registerRoomCheckpointsIpc} exists, ready to be wired, but nothing in
 * this migration's bootstrap calls it — same posture as `roomManagerIpc.ts`,
 * `recIpc.ts` and `recentTools.ts`'s `registerRecentIpc`. It is unit-tested by
 * invoking the captured handlers directly, never through a real IPC round
 * trip. Channel names and argument shapes come verbatim from
 * `src/shared/ipc-contract.ts`, which already declares all five.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { CheckpointMeta, RoomInfo } from "../shared/apiTypes.js";
import type { WorkspaceOperationProgressSink } from "../shared/workspaceProgress.js";
import {
  checkpointFilePath,
  checkpointIdOk,
  checkpointsDir,
  NOT_A_CHECKPOINT_ID,
  performSwap,
  pruneAutoCheckpoints,
  readManifest,
  reconcile,
  nowDate,
  nowTimestamp,
  writeCheckpoint,
  writeManifest,
} from "./db-host/checkpoints.js";
import { verifyPassword } from "./db-host/rekey.js";
import {
  drainInflight,
  humanizeStorageError,
  NO_ROOM_OPEN,
  openRoomImpl,
  teardownOpenRoom,
  type DrainTiming,
  type Room,
  type RoomManagerDeps,
  type RoomManagerState,
} from "./roomManager.js";
import { ROLLBACK_BUSY } from "./turnContext.js";
import {
  createSealedPackage,
  importSealedPackage,
  inspectSealedPackage,
} from "./workspace/sealedPackage.js";

/** Idea 9: the list command's payload — entries (newest first) plus the total
 * on-disk size, for the disk-growth warning. Ported from `CheckpointList`,
 * which Rust declares in `room_checkpoints.rs` itself rather than the db
 * layer; `db-host/checkpoints.ts` has none of its own to reuse. */
export interface CheckpointList {
  entries: CheckpointMeta[];
  totalBytes: number;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `AppState::with_room`'s "no room" refusal, read the same way
 * `roomManager.ts`'s own private `requireRoom` does — restated locally rather
 * than widening that file's exported surface for a two-line null check (only
 * the `NO_ROOM_OPEN` string it throws is exported). */
function requireRoom(state: RoomManagerState): Room {
  if (state.room === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  return state.room;
}

// ============================================================================
// create_checkpoint_core / checkpoint_name — the private helpers shared below
// ============================================================================

/**
 * Create a checkpoint of the room `state` currently has open. Ported from
 * `create_checkpoint_core` — no rollback check of its own (each caller applies
 * its OWN guard, exactly as Rust keeps the guard out of the `_core` helper).
 *
 * The `humanizeStorageError` wrap is `AppState::with_room`'s, not an addition
 * — see this file's module doc. It rewrites only what it can evidence and
 * passes anything else through completely unchanged.
 */
export function createCheckpointCore(
  state: RoomManagerState,
  name: string,
  auto: boolean
): CheckpointMeta {
  const room = requireRoom(state);
  if (room.workspace !== undefined) {
    throw new Error("Workspace checkpoints must be created through the asynchronous checkpoint command.");
  }
  try {
    return writeCheckpoint(room.conn, checkpointsDir(room.path), name, auto);
  } catch (err) {
    throw humanizeStorageError(err, room.path);
  }
}

async function createWorkspaceCheckpoint(
  state: RoomManagerState,
  name: string,
  auto: boolean,
  progress?: WorkspaceOperationProgressSink,
): Promise<CheckpointMeta> {
  const room = requireRoom(state);
  if (room.workspace === undefined || room.descriptor?.kind !== "workspace-folder") {
    throw new Error("This room is not a workspace folder.");
  }
  const dir = checkpointsDir(room.path);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Error(`Could not create the checkpoints folder: ${errMsg(error)}`);
  }
  const manifest = reconcile(dir);
  const id = randomUUID();
  const payloadPath = checkpointFilePath(dir, id);
  try {
    await createSealedPackage(
      room.workspace,
      room.descriptor.roomId,
      room.password,
      payloadPath,
      room.password,
      "checkpoint",
      { operation: "workspace-checkpoint", operationId: id, progress },
    );
    const trimmed = name.trim();
    const meta: CheckpointMeta = {
      id,
      name: trimmed.length > 0 ? trimmed : `Checkpoint — ${nowDate()}`,
      createdAt: nowTimestamp(),
      sizeBytes: statSync(payloadPath).size,
      auto,
    };
    manifest.entries.push(meta);
    writeManifest(dir, manifest);
    return meta;
  } catch (error) {
    throw humanizeStorageError(error, room.path);
  }
}

/** A checkpoint's display name, or `"checkpoint"` when the manifest no longer
 * has one — ported from `checkpoint_name`. Deliberately `readManifest`, NOT
 * `reconcile`, matching Rust: a self-heal is pointless for a lookup that
 * already tolerates "unknown". Used only to build the safety copy's name. */
function checkpointName(dir: string, id: string): string {
  const found = readManifest(dir).entries.find((e) => e.id === id);
  return found?.name ?? "checkpoint";
}

// ============================================================================
// create_room_checkpoint
// ============================================================================

/**
 * Idea 9: create a named checkpoint of the open room. Ported from
 * `create_room_checkpoint`. The room-lock hold across the copy is unavoidable
 * while the copy sources the live connection, same as in Rust. See DEVIATION 3
 * on the `async` shape.
 */
export async function createRoomCheckpoint(
  state: RoomManagerState,
  name: string,
  progress?: WorkspaceOperationProgressSink,
): Promise<CheckpointMeta> {
  if (state.rollingBack) {
    throw new Error(ROLLBACK_BUSY);
  }
  if (requireRoom(state).workspace !== undefined) {
    return createWorkspaceCheckpoint(state, name, false, progress);
  }
  return createCheckpointCore(state, name, false);
}

// ============================================================================
// list_room_checkpoints
// ============================================================================

/**
 * Idea 9: the room's checkpoints, newest first, plus the total on-disk size.
 * `reconcile` self-heals the registry (adopts orphan payloads, drops entries
 * whose file was hand-deleted in Finder, refreshes sizes) so the list and the
 * size are always honest. Ported from `list_room_checkpoints`.
 */
export function listRoomCheckpoints(state: RoomManagerState): CheckpointList {
  const room = requireRoom(state);
  const dir = checkpointsDir(room.path);
  if (!existsSync(dir)) {
    return { entries: [], totalBytes: 0 };
  }
  const manifest = reconcile(dir);
  const entries = [...manifest.entries].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0
  );
  const totalBytes = entries.reduce((sum, e) => sum + e.sizeBytes, 0);
  return { entries, totalBytes };
}

// ============================================================================
// delete_room_checkpoint
// ============================================================================

/**
 * Idea 9: delete a checkpoint and free its disk space. Refused while a
 * rollback is in flight (it may be reading or pruning the same directory) —
 * that check comes BEFORE the id-shape check, and the id-shape check before
 * the room-open check, matching the Rust source's own order. Ported from
 * `delete_room_checkpoint`.
 */
export function deleteRoomCheckpoint(state: RoomManagerState, id: string): void {
  if (state.rollingBack) {
    throw new Error("Can't delete a checkpoint while the room is rolling back.");
  }
  if (!checkpointIdOk(id)) {
    throw new Error(NOT_A_CHECKPOINT_ID);
  }
  const room = requireRoom(state);
  const dir = checkpointsDir(room.path);
  try {
    unlinkSync(checkpointFilePath(dir, id));
  } catch {
    // Best-effort, matching Rust's `let _ = std::fs::remove_file(...)`: a
    // payload already deleted in Finder must still leave the registry clean.
  }
  const manifest = reconcile(dir);
  manifest.entries = manifest.entries.filter((e) => e.id !== id);
  // NOT best-effort: Rust's `write_manifest(&dir, &manifest)` is this
  // command's own tail expression, so a write failure here IS the command's
  // error — unlike the internal writes `reconcile`/`pruneAutoCheckpoints` make.
  writeManifest(dir, manifest);
}

// ============================================================================
// stranded_checkpoint_names / list_stranded_checkpoints (SEC-4 / Idea 9)
// ============================================================================

/**
 * Which of this room's checkpoints do NOT open with `password` — i.e. the ones
 * a `changePassword` re-key failed on and left locked under the OLD password.
 * Recomputed from the files themselves rather than remembered from a past
 * failure, so it can never claim a checkpoint is stranded after someone fixed
 * it (or miss one stranded by a crash mid-rekey). Names, because that is what
 * the user picked them out by; they never leave the app. Ported from
 * `stranded_checkpoint_names`.
 */
export function strandedCheckpointNames(roomPath: string, password: string): string[] {
  const dir = checkpointsDir(roomPath);
  if (!existsSync(dir)) {
    return [];
  }
  return reconcile(dir)
    .entries.filter((e) => {
      const path = checkpointFilePath(dir, e.id);
      if (!existsSync(path)) {
        return false;
      }
      try {
        verifyPassword(path, password);
        return false; // opens fine under the current password
      } catch {
        return true; // stranded
      }
    })
    .map((e) => e.name);
}

/**
 * SEC-4 / Idea 9: which of this room's checkpoints a rollback could NOT open
 * with the room's current password. Empty is the normal answer. Called right
 * after a password change: a `.roomck` whose re-key failed is still a perfectly
 * good copy, just locked under the password the user has only just replaced —
 * and saying nothing meant they found out weeks later, from a rollback error
 * that blamed the password they were typing. Ported from
 * `list_stranded_checkpoints`.
 */
export function listStrandedCheckpoints(state: RoomManagerState): string[] {
  const room = requireRoom(state);
  return strandedCheckpointNames(room.path, room.password);
}

// ============================================================================
// rollback_room_checkpoint — SAFETY-CRITICAL
// ============================================================================

/** The refusal when the drain did not finish clean. Rust uses this same
 * literal at both the report check and the direct-registry re-check. */
const DRAIN_NOT_CLEAN = "A background job is still finishing — try again in a moment.";

/** Rust's step-3 refusal, hoisted because {@link checkpointPayloadPresent} is
 * now checked at TWO points in the sequence (see its own doc). */
const CHECKPOINT_GONE = "That checkpoint is no longer available.";

/**
 * Whether `ckPath` is still a REAL payload — on disk, and holding bytes.
 *
 * Rust checks bare `Path::exists()`, once, before claiming the rollback flag.
 * That is not enough, and the gap is a data-loss one rather than a cosmetic
 * one, because of what the very next step does: `verifyPassword`
 * (`db-host/rekey.ts`) opens its throwaway connection with `new
 * Database(path)` — SQLite's default `SQLITE_OPEN_CREATE`, precisely like the
 * Rust source's own `Connection::open` — so a `.roomck` that is NOT there is
 * silently MINTED as a brand-new, empty database. An empty database then
 * verifies CLEAN: `SELECT count(*) FROM sqlite_master` on a zero-byte file
 * succeeds under any key whatsoever. The command reads that as "the checkpoint
 * opens with the room's current password", tears the room down, and
 * {@link performSwap} renames those zero bytes OVER THE USER'S ROOM FILE. The
 * user is then told "Rolled back, but reopening the room failed" — a completed
 * restore, reported over a room that no longer exists.
 *
 * So the payload is checked HERE, and the check is `size > 0` rather than
 * `exists`, because there are two distinct ways in:
 *
 *  - THE RACE. The drain is the one awaited window in the whole sequence, so
 *    anything that can remove a file — Finder, a backup or cleanup tool —
 *    can do it between Rust's single check and the verify.
 *  - NO RACE AT ALL. `reconcile` ADOPTS any `.roomck` in the directory, so a
 *    zero-byte one (a truncated copy, an interrupted external backup, or the
 *    husk a previous occurrence of this defect left behind) is listed to the
 *    user as "Recovered checkpoint" and can be chosen from the rollback
 *    screen like any other entry.
 *
 * A checkpoint this app actually wrote is never zero bytes — `VACUUM INTO`
 * always emits at least a full page-1 header — so nothing legitimate is
 * refused by the size test. One `statSync` rather than `existsSync` +
 * `statSync` so there is no window between the two.
 */
function checkpointPayloadPresent(ckPath: string): boolean {
  try {
    return statSync(ckPath).size > 0;
  } catch {
    return false;
  }
}

async function rollbackWorkspaceCheckpoint(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  id: string,
  timing?: DrainTiming,
): Promise<RoomInfo> {
  const room = requireRoom(state);
  if (room.workspace === undefined || room.descriptor?.kind !== "workspace-folder") {
    throw new Error("This room is not a workspace folder.");
  }
  const roomPath = room.path;
  const password = room.password;
  const dir = checkpointsDir(roomPath);
  const ckPath = checkpointFilePath(dir, id);
  if (!checkpointPayloadPresent(ckPath)) throw new Error(CHECKPOINT_GONE);
  const packageInfo = inspectSealedPackage(ckPath, password);
  if (packageInfo.purpose !== "checkpoint" || packageInfo.roomId !== room.descriptor.roomId) {
    throw new Error("That checkpoint does not belong to this workspace.");
  }
  if (state.rollingBack) throw new Error(ROLLBACK_BUSY);
  state.rollingBack = true;

  const parent = path.dirname(roomPath);
  const base = path.basename(roomPath);
  const restorePath = path.join(parent, `.${base}.${randomUUID()}.restore.tmp`);
  const backupPath = path.join(parent, `.${base}.before-checkpoint-${randomUUID()}.backup`);
  try {
    const report = await drainInflight(state, deps, timing);
    if (!report.asksDrained || !report.jobsDrained) throw new Error(DRAIN_NOT_CLEAN);
    if (state.cancel.cancels.size > 0 || state.cancel.jobCancels.size > 0) {
      throw new Error(DRAIN_NOT_CLEAN);
    }
    if (!checkpointPayloadPresent(ckPath)) throw new Error(CHECKPOINT_GONE);

    const targetName = checkpointName(dir, id);
    try {
      await createWorkspaceCheckpoint(state, `Before rollback to "${targetName}"`, true);
    } catch (error) {
      throw new Error(`Could not take a safety copy before rolling back: ${errMsg(error)}`);
    }
    pruneAutoCheckpoints(dir, 3);

    // Build and fully verify the replacement before moving the live folder.
    try {
      await importSealedPackage(ckPath, password, restorePath, password, {
        preserveRoomIdentity: true,
      });
    } catch (error) {
      rmSync(restorePath, { recursive: true, force: true });
      throw new Error(`Could not prepare the checkpoint restore: ${errMsg(error)}`);
    }

    teardownOpenRoom(state, deps);
    let originalMoved = false;
    try {
      renameSync(roomPath, backupPath);
      originalMoved = true;
      renameSync(restorePath, roomPath);
    } catch (error) {
      if (originalMoved && !existsSync(roomPath)) {
        try { renameSync(backupPath, roomPath); } catch { /* reported below by reopen */ }
      }
      rmSync(restorePath, { recursive: true, force: true });
      let reopenError: string | null = null;
      try { openRoomImpl(state, deps, roomPath, password); } catch (reopen) { reopenError = errMsg(reopen); }
      const detail = reopenError === null
        ? "The original workspace was reopened."
        : `The original workspace is at ${backupPath}, but reopening failed: ${reopenError}`;
      throw new Error(`Could not replace the workspace with its checkpoint: ${errMsg(error)}. ${detail}`);
    }

    let info: RoomInfo;
    try {
      info = openRoomImpl(state, deps, roomPath, password);
    } catch (error) {
      // A verified restore that cannot open must not strand the user. Put the
      // original folder back, then reopen it. The checkpoint payload remains.
      const failedPath = path.join(parent, `.${base}.${randomUUID()}.failed-restore`);
      let recoveryError: string | null = null;
      try {
        renameSync(roomPath, failedPath);
        renameSync(backupPath, roomPath);
        openRoomImpl(state, deps, roomPath, password);
        rmSync(failedPath, { recursive: true, force: true });
      } catch (recovery) {
        recoveryError = errMsg(recovery);
      }
      if (recoveryError === null) {
        throw new Error(`The checkpoint was prepared but could not be opened: ${errMsg(error)}. The original workspace was restored.`);
      }
      throw new Error(
        `The checkpoint could not be opened (${errMsg(error)}), and automatic recovery also failed ` +
          `(${recoveryError}). The original workspace backup is at ${backupPath}.`,
      );
    }

    try {
      deps.emit?.("room-rolled-back", info);
      deps.emit?.("room-rollback-backup-created", { path: backupPath });
    } catch {
      // The restore is complete; notification failure cannot reverse it.
    }
    return info;
  } finally {
    state.rollingBack = false;
    rmSync(restorePath, { recursive: true, force: true });
  }
}

/**
 * Idea 9: roll the room back to a checkpoint. See this file's module doc for
 * the full eleven-step sequence and why each step is ordered where it is —
 * that order is the safety property and must not be rearranged. Ported from
 * `rollback_room_checkpoint`.
 *
 * `timing` is an optional {@link DrainTiming} override threaded through to
 * {@link drainInflight} (DEVIATION 2); omitting it preserves Rust's timings
 * exactly.
 */
export async function rollbackRoomCheckpoint(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  id: string,
  timing?: DrainTiming
): Promise<RoomInfo> {
  if (!checkpointIdOk(id)) {
    throw new Error(NOT_A_CHECKPOINT_ID);
  }

  if (requireRoom(state).workspace !== undefined) {
    return rollbackWorkspaceCheckpoint(state, deps, id, timing);
  }

  // Snapshot (path, password) from the OPEN room — the room holds the password
  // in memory for exactly this kind of re-key/duplicate/rollback flow (see
  // `Room.password`'s own doc in `roomManager.ts`).
  const room = requireRoom(state);
  const roomPath = room.path;
  const password = room.password;
  const dir = checkpointsDir(roomPath);
  const ckPath = checkpointFilePath(dir, id);
  if (!checkpointPayloadPresent(ckPath)) {
    throw new Error(CHECKPOINT_GONE);
  }

  // Claim the rollback: check-then-set with no `await` between them, and
  // before the first `await` in this function, so new async work refuses for
  // the whole swap and nothing can observe the flag half-claimed. Cleared on
  // every exit by the `finally` below.
  if (state.rollingBack) {
    throw new Error(ROLLBACK_BUSY);
  }
  state.rollingBack = true;

  try {
    // Refuse-if-busy: drain every cancellable writer and require the drain
    // clean. A writer that never observed its cancel flag within the bounded
    // wait means we cannot prove it won't write post-swap → refuse. (The room
    // epoch bumped by teardown is the backstop for the non-cancellable
    // path-pinned writers the drain can't see.)
    const report = await drainInflight(state, deps, timing);
    if (!report.asksDrained || !report.jobsDrained) {
      throw new Error(DRAIN_NOT_CLEAN);
    }
    // Belt-and-braces re-read of the same registries — near-redundant given
    // how `report` is computed, but the Rust source keeps this second check,
    // so this does too.
    if (state.cancel.cancels.size > 0 || state.cancel.jobCancels.size > 0) {
      throw new Error(DRAIN_NOT_CLEAN);
    }

    // Re-confirm the payload is still there, now that the drain — the ONE
    // awaited window in this command — has finished. The check above ran
    // before it; `verifyPassword` below would MINT a missing file rather than
    // refuse it, and the swap would then rename it over the room. See
    // {@link checkpointPayloadPresent}.
    if (!checkpointPayloadPresent(ckPath)) {
      throw new Error(CHECKPOINT_GONE);
    }

    // Verify the checkpoint opens with the CURRENT password before tearing
    // anything down (catches a checkpoint that missed a change-password
    // rekey). `verifyPassword`'s own message — "The current password is not
    // correct." — is simply WRONG here: the user typed nothing, and the
    // password they have is the only one this room accepts. Say what actually
    // happened.
    try {
      verifyPassword(ckPath, password);
    } catch {
      throw new Error(
        "This checkpoint could not be unlocked with the room's current password. " +
          "It was made before a password change that failed to re-key it, so only " +
          "the PREVIOUS password opens it."
      );
    }

    // Before-rollback safety copy of the live room, then cap auto copies at 3.
    const targetName = checkpointName(dir, id);
    const safetyName = `Before rollback to "${targetName}"`;
    try {
      createCheckpointCore(state, safetyName, true);
    } catch (err) {
      throw new Error(`Could not take a safety copy before rolling back: ${errMsg(err)}`);
    }
    pruneAutoCheckpoints(dir, 3);

    // Tear down every piece of per-room state (connection, MCP servers,
    // consents, staged media, agent↔UI round-trips). Reuses the
    // security-hardened teardown; also bumps the room epoch so any straggler
    // path-pinned writer that reads the room after reopen is dropped.
    teardownOpenRoom(state, deps);

    // Swap the checkpoint in. On failure nothing was destructively moved (the
    // copy failed before the rename, or the rename left the original in
    // place), so reopen the ORIGINAL file and surface the error.
    let swapError: string | null = null;
    try {
      performSwap(roomPath, ckPath);
    } catch (err) {
      swapError = errMsg(err);
    }
    if (swapError !== null) {
      let reopenError: string | null = null;
      try {
        openRoomImpl(state, deps, roomPath, password);
      } catch (err) {
        // The recovery reopen's own failure used to be discarded, so a user
        // whose room was left CLOSED was told only that the swap failed, and
        // every later action answered "No room is open." with no explanation.
        reopenError = errMsg(err);
      }
      if (reopenError === null) {
        throw new Error(swapError);
      }
      // The swap error is an io message that ends in no punctuation of its
      // own, so the two sentences need a separator or they run together.
      throw new Error(
        `${swapError} — nothing was rolled back, but this room could not be reopened ` +
          `either (${reopenError}), so it is now CLOSED. Unlock it again from the start screen.`
      );
    }

    // Reopen the swapped file via the unguarded impl (our flag is still up).
    // Integration note (Second-Pass Audit — DECIDED, matching the Rust
    // source's own comment): the checkpoint restored the settings table
    // BYTE-FOR-BYTE, so the reopen's dependency spawns re-read the RESTORED
    // room-server/leash settings — the checkpoint's own config is
    // authoritative, and combined with teardown's stop that IS the
    // restart-or-stop reconciliation the audit requires.
    let info: RoomInfo;
    try {
      info = openRoomImpl(state, deps, roomPath, password);
    } catch (err) {
      throw new Error(
        `Rolled back, but reopening the room failed: ${errMsg(err)}. Unlock it again from the start screen.`
      );
    }

    try {
      deps.emit?.("room-rolled-back", info);
    } catch {
      // Swallowed deliberately (DEVIATION 4), matching Rust's `let _ =
      // app.emit(...)`: the rollback is DONE, and a listener that throws must
      // not make a completed restore look like a failed one.
    }
    return info;
  } finally {
    state.rollingBack = false;
  }
}

// ============================================================================
// IPC registration — NOT wired into any bootstrap file (rule 4)
// ============================================================================

/** Register every `room_checkpoints.rs` command channel on `ipcMain`, closing
 * over the SAME {@link RoomManagerState}/{@link RoomManagerDeps} pair
 * `roomManagerIpc.ts` registers `rooms.rs`'s commands against — one open room
 * for the whole process, exactly as the Rust `AppState` models. Every handler
 * is THIN: nothing but argument forwarding, because every decision (the
 * refusals, the rollback guard, the teardown sequencing) lives above and is
 * tested there against real fixture rooms. `ipcMain` is a parameter typed
 * against the real `electron` module without importing it at runtime, so this
 * file resolves under plain Node/vitest exactly like `recIpc.ts` does. */
export function registerRoomCheckpointsIpc(
  ipcMain: Pick<IpcMain, "handle">,
  state: RoomManagerState,
  deps: RoomManagerDeps
): void {
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R): void => {
    ipcMain.handle(channel, (_event: IpcMainInvokeEvent, ...args: A) => fn(...args));
  };

  ipcMain.handle(
    "create_room_checkpoint",
    (event: IpcMainInvokeEvent, args: { name: string }): Promise<CheckpointMeta> =>
      createRoomCheckpoint(
        state,
        args.name,
        (progress) => event?.sender?.send?.("workspace-operation-progress", progress),
      ),
  );
  handle("list_room_checkpoints", (): CheckpointList => listRoomCheckpoints(state));
  handle("delete_room_checkpoint", (args: { id: string }): void =>
    deleteRoomCheckpoint(state, args.id)
  );
  handle(
    "rollback_room_checkpoint",
    (args: { id: string }): Promise<RoomInfo> => rollbackRoomCheckpoint(state, deps, args.id)
  );
  handle("list_stranded_checkpoints", (): string[] => listStrandedCheckpoints(state));
}
