/** Cohesive extraction from roomManager.ts; the facade preserves its public API. */
import { existsSync } from "node:fs";
import { renameSync } from "node:fs";
import path from "node:path";
import type { RoomInfo } from "../shared/apiTypes.js";
import { setMeta } from "./db-host/meta.js";
import { hasRecovery, writeRecovery } from "./db-host/recovery.js";
import { deleteEntry as keychainDeleteEntry, has as keychainHas, read as keychainRead, store as keychainStore } from "./keychain.js";
import { readRecent, renameRecent, writeRecent } from "./recentTools.js";
import { ROLLBACK_BUSY } from "./turnContext.js";
import { contentStoreFor } from "./workspace/contentStore.js";
import { describeRoom, openWorkspaceRoom } from "./workspace/roomLayout.js";
import { WorkspaceService } from "./workspace/workspaceService.js";
import { closeQuietly, requireRoom, type Room, type RoomManagerDeps, type RoomManagerState } from "./roomManagerState.js";
import { roomDatabasePath, startWorkspaceRuntime } from "./roomManagerWorkspace.js";
import { humanizeStorageError, infoOf, MAX_ROOM_NAME_CHARS } from "./roomManagerPaths.js";


/**
 * Recovery (the printed sheet): create a recovery key for the CURRENTLY OPEN
 * room and return the human code to show once. Uses the open room's own path
 * and password, so the create/settings flows pass nothing sensitive across the
 * boundary. Ported from `write_recovery_key`, including the storage-error
 * rewrite `with_room` applies on the way out.
 */
export async function writeRecoveryKey(state: RoomManagerState): Promise<string> {
  const room = requireRoom(state);
  if (room.readOnly === true) {
    throw new Error("This workspace is read-only because another Arcelle process owns the writer lease.");
  }
  try {
    return await writeRecovery(roomDatabasePath(room), room.password);
  } catch (err) {
    throw humanizeStorageError(err, room.path);
  }
}


/** True when the room at `roomPath` has a recovery sidecar — the gate shows
 * "Unlock with recovery code" only then. Ported from `has_recovery_key`. */
export function hasRecoveryKey(roomPath: string): boolean {
  try {
    return hasRecovery(describeRoom(roomPath).dbPath);
  } catch {
    return false;
  }
}


// ============================================================================
// The parked "audio could not be restored" message
// ============================================================================

/** The parked message, if the last unlock left one. Cleared by the read: the
 * workspace calls this once on mount, so the failure reaches the screen
 * whether or not a listener existed when the rescue ran. `null` is the
 * ordinary answer and means exactly nothing went wrong. Ported from
 * `take_rec_recovery_error`/`take_recovery_error`. */
export function takeRecRecoveryError(state: RoomManagerState): string | null {
  const value = state.recRecoveryError;
  state.recRecoveryError = null;
  return value;
}


/** The two guards Rust's delayed emit re-checks inside its spawned closure:
 * the room this failure belongs to must still be the OPEN one (locking up
 * immediately must not produce a toast about a room that is gone), and nobody
 * must have collected the parked message already (a workspace that was already
 * listening must not get the same failure twice). Split out so both are
 * testable without a timer. */
export function shouldEmitRecRecovery(state: RoomManagerState, roomPath: string): boolean {
  const stillOpen = state.room !== null && state.room.path === roomPath;
  if (!stillOpen) {
    return false;
  }
  return state.recRecoveryError !== null;
}


/**
 * Tell the user that audio left behind by a crashed recording could NOT be
 * spliced back. Rides the recording area's existing `rec-error` channel,
 * because a rescue that silently does nothing looks exactly like a meeting
 * whose end was never recorded. Ported from `report_rec_recovery_failure`.
 *
 * The message is PARKED first and emitted second, and the PARKED copy is the
 * one that counts: the unlock returns before the workspace has mounted its
 * listeners, so a one-shot emit on a fixed timer is a guess that loses the
 * race on a cold start. The emit stays for the workspace that IS already up
 * (an open-over-open unlock); it emits a COPY and leaves the park alone, so
 * {@link takeRecRecoveryError} remains the message's only consumer.
 */
export function reportRecRecoveryFailure(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  roomPath: string,
  err: string,
  delayMs = 2000
): void {
  console.error(`recording recovery failed: ${err}`);
  const message =
    `Audio from an interrupted recording could not be restored: ${err} ` +
    "Nothing was lost — it is still stored in the room, and the rescue " +
    "runs again the next time you unlock it.";
  state.recRecoveryError = message;
  const timer = setTimeout(() => {
    if (!shouldEmitRecRecovery(state, roomPath)) {
      return;
    }
    if (deps.emit) {
      deps.emit("rec-error", { fileId: "", message });
    }
  }, delayMs);
  // A pending 2 s timer must not be the reason a process (or a test runner)
  // stays alive — this is a best-effort fallback, not work anyone waits for.
  if (typeof timer.unref === "function") {
    timer.unref();
  }
}


// ============================================================================
// room_info / rename_room / take_pending_open
// ============================================================================

/** Ported from `room_info`. No rollback guard — Rust has none here either. */
export function roomInfo(state: RoomManagerState, deps: RoomManagerDeps): RoomInfo | null {
  return state.room !== null ? infoOf(state.room, deps.userDataDir) : null;
}


/**
 * Rename the open room. Ported from `rename_room`.
 *
 * Both copies of the name are updated together: the room's `meta` (the
 * authority, which travels with the file) and the recents entry for this path
 * (which has to carry its own copy — it names rooms that are locked and cannot
 * be read). The length checks come BEFORE the no-room check, exactly as they
 * do in Rust.
 */
function validatedRoomName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new Error("A room needs a name.");
  if ([...trimmed].length > MAX_ROOM_NAME_CHARS) {
    throw new Error(`That name is too long — ${MAX_ROOM_NAME_CHARS} characters at most.`);
  }
  return trimmed;
}


function requireWritableRoom(state: RoomManagerState): Room {
  const room = requireRoom(state);
  if (room.readOnly === true) {
    throw new Error("This workspace is read-only because another Arcelle process owns the writer lease.");
  }
  return room;
}


function validateWorkspaceName(name: string): void {
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error("A workspace name cannot contain path separators.");
  }
}


function workspaceRenameTarget(room: Room, name: string): string | null {
  const descriptor = room.descriptor;
  if (descriptor?.kind !== "workspace-folder" || descriptor.rootPath === null) return null;
  validateWorkspaceName(name);
  return path.join(path.dirname(room.path), name);
}


function stopWorkspaceRuntimeForRename(room: Room): void {
  room.workspaceRuntimeClosed = true;
  if (room.workspaceWatcher !== undefined) void room.workspaceWatcher.close().catch(() => undefined);
  room.workspaceIndexer?.close();
  room.conn.pragma("wal_checkpoint(FULL)");
  closeQuietly(room.conn);
}


function reopenRenamedWorkspace(room: Room, newPath: string): void {
  const reopened = openWorkspaceRoom(newPath, room.password);
  room.conn = reopened.db;
  room.path = newPath;
  room.descriptor = reopened.descriptor;
}


function restoreWorkspaceAfterRenameFailure(room: Room, oldPath: string, newPath: string): void {
  if (existsSync(newPath) && !existsSync(oldPath)) {
    try {
      renameSync(newPath, oldPath);
    } catch {
      // The original error wins if a reverse move cannot repair the path.
    }
  }
  room.conn = openWorkspaceRoom(oldPath, room.password).db;
  room.workspaceRuntimeClosed = false;
}


function renameWorkspaceDirectory(room: Room, newPath: string): void {
  const oldPath = room.path;
  if (existsSync(newPath)) throw new Error("A file or folder already exists with that name.");
  stopWorkspaceRuntimeForRename(room);
  try {
    renameSync(oldPath, newPath);
    reopenRenamedWorkspace(room, newPath);
  } catch (error) {
    restoreWorkspaceAfterRenameFailure(room, oldPath, newPath);
    throw error;
  }
}


function restartRenamedWorkspace(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  room: Room,
  newPath: string,
): void {
  room.workspace = new WorkspaceService(room.conn, newPath);
  room.contentStore = contentStoreFor(room.conn, newPath);
  if (room.workspaceLease !== undefined) {
    room.workspaceLease.lockPath = path.join(newPath, ".arcelle", "room.lock");
  }
  room.workspaceRuntimeClosed = false;
  startWorkspaceRuntime(state, room, deps);
}


function moveWorkspaceKeychain(
  deps: RoomManagerDeps,
  oldPath: string,
  newPath: string,
  password: string,
): void {
  const keychain = deps.keychain ?? {
    has: keychainHas,
    store: keychainStore,
    read: keychainRead,
    deleteEntry: keychainDeleteEntry,
  };
  try {
    if (keychain.has(oldPath)) {
      keychain.store(newPath, password);
      keychain.deleteEntry(oldPath);
    }
  } catch (error) {
    console.error(`Touch ID credential could not follow the renamed workspace: ${error instanceof Error ? error.message : String(error)}`);
  }
}


function renameWorkspaceIfNeeded(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  room: Room,
  name: string,
): void {
  const newPath = workspaceRenameTarget(room, name);
  if (newPath === null || newPath === room.path) return;
  const oldPath = room.path;
  renameWorkspaceDirectory(room, newPath);
  restartRenamedWorkspace(state, deps, room, newPath);
  moveWorkspaceKeychain(deps, oldPath, newPath, room.password);
}


function writeRenamedRecent(deps: RoomManagerDeps, oldPath: string, info: RoomInfo): void {
  try {
    writeRecent(
      deps.userDataDir,
      renameRecent(readRecent(deps.userDataDir), oldPath, info.name, info.path),
    );
  } catch {
    // Best-effort, matching Rust's `let _ = write_recent(...)`.
  }
}


function saveRenamedRoom(deps: RoomManagerDeps, room: Room, oldPath: string, name: string): RoomInfo {
  setMeta(room.conn, "name", name);
  room.name = name;
  const info = infoOf(room, deps.userDataDir);
  writeRenamedRecent(deps, oldPath, info);
  return info;
}


export function renameRoom(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  name: string
): RoomInfo {
  // Wave 3 (Idea 9): a rollback is about to replace this DB — a name written
  // now would be swapped away without a word.
  if (state.rollingBack) {
    throw new Error(ROLLBACK_BUSY);
  }
  const trimmed = validatedRoomName(name);
  const room = requireWritableRoom(state);
  const oldPath = room.path;
  renameWorkspaceIfNeeded(state, deps, room, trimmed);
  return saveRenamedRoom(deps, room, oldPath, trimmed);
}
