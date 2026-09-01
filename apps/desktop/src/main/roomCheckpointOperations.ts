/** Checkpoint creation and safety-critical rollback execution. */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
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

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `AppState::with_room`'s "no room" refusal, read the same way
 * `roomManager.ts`'s own private `requireRoom` does — restated locally rather
 * than widening that file's exported surface for a two-line null check (only
 * the `NO_ROOM_OPEN` string it throws is exported). */
export function requireRoom(state: RoomManagerState): Room {
  if (state.room === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  return state.room;
}


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

export async function createWorkspaceCheckpoint(
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

interface WorkspaceRollbackSnapshot {
  roomPath: string;
  password: string;
  dir: string;
  ckPath: string;
  restorePath: string;
  backupPath: string;
}

interface WorkspaceInstallFailure {
  error: unknown;
  originalMoved: boolean;
}

function workspaceRollbackSnapshot(state: RoomManagerState, id: string): WorkspaceRollbackSnapshot {
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
  const parent = path.dirname(roomPath);
  const base = path.basename(roomPath);
  return {
    roomPath,
    password,
    dir,
    ckPath,
    restorePath: path.join(parent, `.${base}.${randomUUID()}.restore.tmp`),
    backupPath: path.join(parent, `.${base}.before-checkpoint-${randomUUID()}.backup`),
  };
}

function claimRollback(state: RoomManagerState): void {
  if (state.rollingBack) {
    throw new Error(ROLLBACK_BUSY);
  }
  state.rollingBack = true;
}

async function requireCleanRollbackDrain(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  timing?: DrainTiming
): Promise<void> {
  const report = await drainInflight(state, deps, timing);
  if (!report.asksDrained || !report.jobsDrained) {
    throw new Error(DRAIN_NOT_CLEAN);
  }
  if (state.cancel.cancels.size > 0 || state.cancel.jobCancels.size > 0) {
    throw new Error(DRAIN_NOT_CLEAN);
  }
}

function requireCheckpointPayload(ckPath: string): void {
  if (!checkpointPayloadPresent(ckPath)) {
    throw new Error(CHECKPOINT_GONE);
  }
}

async function takeWorkspaceRollbackSafetyCopy(
  state: RoomManagerState,
  snapshot: WorkspaceRollbackSnapshot,
  id: string
): Promise<void> {
  const targetName = checkpointName(snapshot.dir, id);
  try {
    await createWorkspaceCheckpoint(state, `Before rollback to "${targetName}"`, true);
  } catch (error) {
    throw new Error(`Could not take a safety copy before rolling back: ${errMsg(error)}`);
  }
  pruneAutoCheckpoints(snapshot.dir, 3);
}

async function prepareWorkspaceRestore(snapshot: WorkspaceRollbackSnapshot): Promise<void> {
  try {
    await importSealedPackage(snapshot.ckPath, snapshot.password, snapshot.restorePath, snapshot.password, {
      preserveRoomIdentity: true,
    });
  } catch (error) {
    rmSync(snapshot.restorePath, { recursive: true, force: true });
    throw new Error(`Could not prepare the checkpoint restore: ${errMsg(error)}`);
  }
}

function installWorkspaceRestore(snapshot: WorkspaceRollbackSnapshot): WorkspaceInstallFailure | null {
  try {
    renameSync(snapshot.roomPath, snapshot.backupPath);
  } catch (error) {
    return { error, originalMoved: false };
  }
  try {
    renameSync(snapshot.restorePath, snapshot.roomPath);
  } catch (error) {
    return { error, originalMoved: true };
  }
  return null;
}

function recoverWorkspaceInstallFailure(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  snapshot: WorkspaceRollbackSnapshot,
  failure: WorkspaceInstallFailure
): never {
  if (failure.originalMoved && !existsSync(snapshot.roomPath)) {
    try {
      renameSync(snapshot.backupPath, snapshot.roomPath);
    } catch {
      // The reopen below reports this recovery failure precisely.
    }
  }
  rmSync(snapshot.restorePath, { recursive: true, force: true });
  const reopenError = reopenWorkspaceOriginal(state, deps, snapshot);
  const detail = reopenError === null
    ? "The original workspace was reopened."
    : `The original workspace is at ${snapshot.backupPath}, but reopening failed: ${reopenError}`;
  throw new Error(`Could not replace the workspace with its checkpoint: ${errMsg(failure.error)}. ${detail}`);
}

function reopenWorkspaceOriginal(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  snapshot: WorkspaceRollbackSnapshot
): string | null {
  try {
    openRoomImpl(state, deps, snapshot.roomPath, snapshot.password);
    return null;
  } catch (error) {
    return errMsg(error);
  }
}

function reopenWorkspaceRestore(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  snapshot: WorkspaceRollbackSnapshot
): RoomInfo {
  try {
    return openRoomImpl(state, deps, snapshot.roomPath, snapshot.password);
  } catch (error) {
    return recoverWorkspaceOpenFailure(state, deps, snapshot, error);
  }
}

function recoverWorkspaceOpenFailure(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  snapshot: WorkspaceRollbackSnapshot,
  openError: unknown
): never {
  const parent = path.dirname(snapshot.roomPath);
  const base = path.basename(snapshot.roomPath);
  const failedPath = path.join(parent, `.${base}.${randomUUID()}.failed-restore`);
  let recoveryError: string | null = null;
  try {
    renameSync(snapshot.roomPath, failedPath);
    renameSync(snapshot.backupPath, snapshot.roomPath);
    openRoomImpl(state, deps, snapshot.roomPath, snapshot.password);
    rmSync(failedPath, { recursive: true, force: true });
  } catch (recovery) {
    recoveryError = errMsg(recovery);
  }
  if (recoveryError === null) {
    throw new Error(
      `The checkpoint was prepared but could not be opened: ${errMsg(openError)}. The original workspace was restored.`
    );
  }
  throw new Error(
    `The checkpoint could not be opened (${errMsg(openError)}), and automatic recovery also failed ` +
      `(${recoveryError}). The original workspace backup is at ${snapshot.backupPath}.`
  );
}

function emitWorkspaceRollback(deps: RoomManagerDeps, info: RoomInfo, backupPath: string): void {
  try {
    deps.emit?.("room-rolled-back", info);
    deps.emit?.("room-rollback-backup-created", { path: backupPath });
  } catch {
    // The restore is complete; notification failure cannot reverse it.
  }
}

async function executeWorkspaceRollback(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  id: string,
  snapshot: WorkspaceRollbackSnapshot,
  timing?: DrainTiming
): Promise<RoomInfo> {
  await requireCleanRollbackDrain(state, deps, timing);
  requireCheckpointPayload(snapshot.ckPath);
  await takeWorkspaceRollbackSafetyCopy(state, snapshot, id);
  await prepareWorkspaceRestore(snapshot);
  teardownOpenRoom(state, deps);
  const installFailure = installWorkspaceRestore(snapshot);
  if (installFailure !== null) {
    return recoverWorkspaceInstallFailure(state, deps, snapshot, installFailure);
  }
  const info = reopenWorkspaceRestore(state, deps, snapshot);
  emitWorkspaceRollback(deps, info, snapshot.backupPath);
  return info;
}

async function rollbackWorkspaceCheckpoint(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  id: string,
  timing?: DrainTiming,
): Promise<RoomInfo> {
  const snapshot = workspaceRollbackSnapshot(state, id);
  claimRollback(state);

  try {
    return await executeWorkspaceRollback(state, deps, id, snapshot, timing);
  } finally {
    state.rollingBack = false;
    rmSync(snapshot.restorePath, { recursive: true, force: true });
  }
}

interface SealedRollbackSnapshot {
  roomPath: string;
  password: string;
  dir: string;
  ckPath: string;
}

function sealedRollbackSnapshot(room: Room, id: string): SealedRollbackSnapshot {
  const roomPath = room.path;
  const password = room.password;
  const dir = checkpointsDir(roomPath);
  const ckPath = checkpointFilePath(dir, id);
  requireCheckpointPayload(ckPath);
  return { roomPath, password, dir, ckPath };
}

function verifySealedCheckpointPassword(snapshot: SealedRollbackSnapshot): void {
  try {
    verifyPassword(snapshot.ckPath, snapshot.password);
  } catch {
    throw new Error(
      "This checkpoint could not be unlocked with the room's current password. " +
        "It was made before a password change that failed to re-key it, so only " +
        "the PREVIOUS password opens it."
    );
  }
}

function takeSealedRollbackSafetyCopy(
  state: RoomManagerState,
  snapshot: SealedRollbackSnapshot,
  id: string
): void {
  const targetName = checkpointName(snapshot.dir, id);
  try {
    createCheckpointCore(state, `Before rollback to "${targetName}"`, true);
  } catch (error) {
    throw new Error(`Could not take a safety copy before rolling back: ${errMsg(error)}`);
  }
  pruneAutoCheckpoints(snapshot.dir, 3);
}

function swapSealedCheckpoint(snapshot: SealedRollbackSnapshot): string | null {
  try {
    performSwap(snapshot.roomPath, snapshot.ckPath);
    return null;
  } catch (error) {
    return errMsg(error);
  }
}

function recoverSealedSwapFailure(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  snapshot: SealedRollbackSnapshot,
  swapError: string
): never {
  const reopenError = reopenFailedSealedSwap(state, deps, snapshot);
  if (reopenError === null) {
    throw new Error(swapError);
  }
  throw new Error(
    `${swapError} — nothing was rolled back, but this room could not be reopened ` +
      `either (${reopenError}), so it is now CLOSED. Unlock it again from the start screen.`
  );
}

function reopenFailedSealedSwap(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  snapshot: SealedRollbackSnapshot
): string | null {
  try {
    openRoomImpl(state, deps, snapshot.roomPath, snapshot.password);
    return null;
  } catch (error) {
    return errMsg(error);
  }
}

function reopenSealedCheckpoint(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  snapshot: SealedRollbackSnapshot
): RoomInfo {
  try {
    return openRoomImpl(state, deps, snapshot.roomPath, snapshot.password);
  } catch (error) {
    throw new Error(
      `Rolled back, but reopening the room failed: ${errMsg(error)}. Unlock it again from the start screen.`
    );
  }
}

function emitSealedRollback(deps: RoomManagerDeps, info: RoomInfo): void {
  try {
    deps.emit?.("room-rolled-back", info);
  } catch {
    // The completed restore must not be reported as a failure.
  }
}

async function executeSealedRollback(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  id: string,
  snapshot: SealedRollbackSnapshot,
  timing?: DrainTiming
): Promise<RoomInfo> {
  await requireCleanRollbackDrain(state, deps, timing);
  requireCheckpointPayload(snapshot.ckPath);
  verifySealedCheckpointPassword(snapshot);
  takeSealedRollbackSafetyCopy(state, snapshot, id);
  teardownOpenRoom(state, deps);
  const swapError = swapSealedCheckpoint(snapshot);
  if (swapError !== null) {
    return recoverSealedSwapFailure(state, deps, snapshot, swapError);
  }
  const info = reopenSealedCheckpoint(state, deps, snapshot);
  emitSealedRollback(deps, info);
  return info;
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

  const room = requireRoom(state);
  if (room.workspace !== undefined) {
    return rollbackWorkspaceCheckpoint(state, deps, id, timing);
  }
  const snapshot = sealedRollbackSnapshot(room, id);
  claimRollback(state);

  try {
    return await executeSealedRollback(state, deps, id, snapshot, timing);
  } finally {
    state.rollingBack = false;
  }
}
