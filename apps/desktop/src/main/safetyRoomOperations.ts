import type Database from "better-sqlite3-multiple-ciphers";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { existsSync, unlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { checkpointCkPaths } from "./db-host/checkpoints.js";
import { MIN_ROOM_PASSWORD_CHARS } from "./db-host/open.js";
import { hasRecovery, removeRecovery, writeRecovery } from "./db-host/recovery.js";
import { reclaimableBytes, rekey, rekeyCopy, vacuum, vacuumInto, verifyPassword } from "./db-host/rekey.js";
import { deleteEntry as keychainDeleteEntry, has as keychainHas, store as keychainStore } from "./keychain.js";
import type { WorkspaceService } from "./workspace/workspaceService.js";
import { createSealedPackage, importSealedPackage } from "./workspace/sealedPackage.js";
import type { RoomDescriptor } from "./workspace/types.js";
import { deleteFileVersion, exportAll, exportAllWorkspace, exportFile, exportWorkspaceFile, fileVersionsKept, getFileProvenance, listFileVersions, pinFileVersion, restoreVersionInto, versionContent, workspaceVersionContent } from "./safetyTools.js";



// ============================================================================
// SEC-4: change password
// ============================================================================

/**
 * Rotate the room's password: verify `currentPassword` on a throwaway
 * connection, re-key the LIVE connection, keep Touch ID working if it was
 * enabled, re-wrap the recovery sidecar (if any) around the new password, and
 * re-key every whole-room checkpoint from the old password to the new.
 * Returns the fresh recovery code to show once, or `null` when the room has
 * no recovery. Ported from `change_password_core`.
 *
 * CALLER OWNS THE IN-MEMORY PASSWORD: Rust holds `room.password` inside the
 * same `AppState` lock this function's body ran under and updates it in
 * place. Nothing in this migration has that lock yet (see this file's module
 * doc), so — on a successful return — the CALLER is responsible for updating
 * whatever it holds as "the room's current password" to `newPassword` before
 * any subsequent operation (another `changePassword`, a `duplicateRoom`,
 * biometrics) needs it again. A future host-state batch that wires
 * {@link registerSafetyIpc} should pass an `onPasswordChanged` that does
 * exactly this.
 */
export interface ChangePasswordPaths {
  databasePath?: string;
  biometricPath?: string;
  recoveryPath?: string;
  checkpointsPath?: string;
}
export interface ResolvedChangePasswordPaths {
  databasePath: string;
  biometricPath: string;
  recoveryPath: string;
  checkpointsPath: string;
}
export function resolveChangePasswordPaths(
  roomPath: string,
  paths: ChangePasswordPaths,
): ResolvedChangePasswordPaths {
  return {
    databasePath: paths.databasePath ?? roomPath,
    biometricPath: paths.biometricPath ?? roomPath,
    recoveryPath: paths.recoveryPath ?? roomPath,
    checkpointsPath: paths.checkpointsPath ?? roomPath,
  };
}
export function refreshBiometricPassword(path: string, newPassword: string): void {
  // ADD-11: keep Touch ID working after a password change. Chosen behavior:
  // UPDATE the Keychain entry with the new password. If that somehow fails,
  // delete the stale entry so Touch ID can never hand back the old password.
  if (!keychainHas(path)) return;
  try {
    keychainStore(path, newPassword);
  } catch {
    deleteStaleBiometricPassword(path);
  }
}
export function deleteStaleBiometricPassword(path: string): void {
  try {
    keychainDeleteEntry(path);
  } catch {
    // best-effort, matching Rust's own swallowed `let _ = ...delete(...)`
  }
}
export async function refreshRecoveryCode(path: string, newPassword: string): Promise<string | null> {
  // Same policy for the recovery sidecar: re-wrap under the new password and
  // hand back the fresh code; if re-wrapping fails, delete the stale sidecar
  // so the unlock gate never offers a code that cannot work.
  if (!hasRecovery(path)) return null;
  try {
    return await writeRecovery(path, newPassword);
  } catch {
    await removeRecoverySafely(path);
    return null;
  }
}
export async function removeRecoverySafely(path: string): Promise<void> {
  try {
    await removeRecovery(path);
  } catch {
    // best-effort
  }
}
export function rekeyCheckpoints(
  checkpointsPath: string,
  currentPassword: string,
  newPassword: string,
): number {
  let stranded = 0;
  for (const checkpoint of checkpointCkPaths(checkpointsPath)) {
    try {
      rekeyCopy(checkpoint, currentPassword, newPassword);
    } catch {
      stranded += 1;
    }
  }
  return stranded;
}
export function reportStrandedCheckpoints(stranded: number): void {
  if (stranded > 0) {
    // The counter is deliberately content-free: a checkpoint path carries the
    // room's own file name, which is the user's, and it never goes to a log.
    console.error(`change_password: ${stranded} checkpoint(s) could not be re-keyed`);
  }
}


export async function changePasswordCore(
  db: Database.Database,
  roomPath: string,
  currentPassword: string,
  newPassword: string,
  paths: ChangePasswordPaths = {},
): Promise<string | null> {
  const resolved = resolveChangePasswordPaths(roomPath, paths);
  verifyPassword(resolved.databasePath, currentPassword);
  rekey(db, newPassword);
  refreshBiometricPassword(resolved.biometricPath, newPassword);
  const newCode = await refreshRecoveryCode(resolved.recoveryPath, newPassword);
  // `vacuum_into` copies keep the key of the moment they were made, so a
  // later rekey would strand every checkpoint. Re-key each one from the OLD
  // password to the new. A failure is NOT fatal — the room itself is already
  // re-keyed and refusing now would be worse — but it is reported, never
  // swallowed into a false "all clean".
  reportStrandedCheckpoints(rekeyCheckpoints(resolved.checkpointsPath, currentPassword, newPassword));
  return newCode;
}


/** Outer validation + dispatch matching the Rust `#[tauri::command] pub async
 * fn change_password` (the length floor and the rollback-busy refusal live
 * HERE, not in {@link changePasswordCore}, exactly as they do in Rust). The
 * rollback-busy check is a caller-supplied predicate rather than a direct
 * `RoomManagerState` import, matching `privacy.ts`'s own "each missing piece
 * of host state is a named dependency" convention — nothing in this
 * migration wires a rollback flag to this file yet. */
export async function changePassword(
  db: Database.Database,
  roomPath: string,
  currentPassword: string,
  newPassword: string,
  isRollingBack?: () => boolean,
  paths?: ChangePasswordPaths,
): Promise<string | null> {
  if ([...newPassword].length < MIN_ROOM_PASSWORD_CHARS) {
    throw new Error("Password must be at least 8 characters.");
  }
  if (isRollingBack?.()) {
    throw new Error(ROLLBACK_BUSY);
  }
  return changePasswordCore(db, roomPath, currentPassword, newPassword, paths);
}


// ============================================================================
// ADD-4: duplicate room
// ============================================================================

/** A full copy of the open room as it is now, optionally with its own new
 * password. The original is never touched. Ported from
 * `duplicate_room_core`. */
export function duplicateRoomCore(
  db: Database.Database,
  roomPassword: string,
  destPath: string,
  newPassword: string | null
): void {
  vacuumInto(db, destPath);
  if (newPassword !== null) {
    try {
      rekeyCopy(destPath, roomPassword, newPassword);
    } catch (err) {
      try {
        unlinkSync(destPath);
      } catch {
        // best-effort cleanup, matching Rust's `let _ = std::fs::remove_file(...)`
      }
      throw err;
    }
  }
}


/** Outer validation matching `#[tauri::command] pub async fn duplicate_room`:
 * the new password's length floor and the destination-must-not-exist guard
 * both live here, ahead of the (potentially minutes-long) copy. */
export async function duplicateRoom(
  db: Database.Database,
  roomPassword: string,
  destPath: string,
  newPassword: string | null
): Promise<void> {
  if (newPassword !== null && [...newPassword].length < MIN_ROOM_PASSWORD_CHARS) {
    throw new Error("Password must be at least 8 characters.");
  }
  if (existsSync(destPath)) {
    throw new Error("A file already exists at that location.");
  }
  duplicateRoomCore(db, roomPassword, destPath, newPassword);
}
export async function duplicateWorkspaceRoom(
  workspace: WorkspaceService,
  roomId: string,
  roomPassword: string,
  destPath: string,
  newPassword: string | null,
): Promise<void> {
  if (newPassword !== null && [...newPassword].length < MIN_ROOM_PASSWORD_CHARS) {
    throw new Error("Password must be at least 8 characters.");
  }
  if (existsSync(destPath)) throw new Error("A file or folder already exists at that location.");
  const packagePath = join(dirname(destPath), `.${basename(destPath)}.${randomUUID()}.duplicate.arcelle`);
  try {
    await createSealedPackage(
      workspace,
      roomId,
      roomPassword,
      packagePath,
      roomPassword,
      "duplicate",
    );
    await importSealedPackage(
      packagePath,
      roomPassword,
      destPath,
      newPassword ?? roomPassword,
    );
  } finally {
    await rm(packagePath, { force: true }).catch(() => undefined);
  }
}


// ============================================================================
// SEC-7: compact room
// ============================================================================

/** Compact the open room on demand, reporting how much was reclaimed. Ported
 * from `compact_room_core`. */
export async function compactRoom(db: Database.Database): Promise<string> {
  const reclaimable = reclaimableBytes(db);
  const mb = reclaimable / (1024 * 1024);
  if (mb < 0.05) {
    return "Nothing to recover.";
  }
  vacuum(db);
  return `Recovered ${mb.toFixed(1)} MB.`;
}


// ============================================================================
// IPC registration — NOT wired into any bootstrap file (rule 4)
// ============================================================================

/** `let _ = window.emit(...)` — a best-effort UI notification that must never
 * turn a successful call into a failed one. Same narrowest-possible contract
 * as `organizeTools.ts`'s own `EmitFn`. */
export type EmitFn = (event: string, payload: unknown) => void;
export function emitSafely(emit: EmitFn | undefined, event: string, payload: unknown): void {
  try {
    emit?.(event, payload);
  } catch {
    // Swallowed deliberately, matching Rust's `let _ = window.emit(...)`.
  }
}


/** The slice of room state every handler in this file needs: whichever room
 * is open RIGHT NOW. Deliberately its OWN shape (not `turnEngine.ts`'s
 * `OpenRoom`, which is `{db, path}` only) because `changePassword`/
 * `duplicateRoom` need the room's current password too — the same
 * `state.room.lock()` analogue `recIpc.ts`'s `RoomSource` documents, widened
 * by exactly the one field this file additionally needs. */
export interface SafetyOpenRoom {
  conn: Database.Database;
  path: string;
  password: string;
  workspace?: WorkspaceService;
  descriptor?: RoomDescriptor;
  readOnly?: boolean;
}


export interface SafetyRoomSource {
  currentRoom(): SafetyOpenRoom | null;
}
export

/** `AppState::with_room`'s own refusal, so an IPC call made between rooms
 * says what the shipped app says. */
const NO_ROOM_OPEN = "No room is open.";
export

/** The rollback-in-flight refusal text, ported from `commands.rs`'s
 * `ROLLBACK_BUSY` — restated as a literal (not imported from
 * `turnContext.ts`) so this file has no hard dependency on the room-manager
 * batch that owns the real rollback flag; a future wiring batch can swap this
 * for the shared constant without changing behavior, since the string is
 * identical either way. */
const ROLLBACK_BUSY = "The room is rolling back — try again in a moment.";
export function openRoomOrThrow(room: SafetyRoomSource): SafetyOpenRoom {
  const open = room.currentRoom();
  if (open === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  return open;
}


/** Optional collaborators {@link registerSafetyIpc} needs beyond the open
 * room itself — each a named dependency, following `privacy.ts`'s convention,
 * rather than a wider `RoomManagerState`/`AppState` import this migration
 * does not have yet. */
export interface SafetyIpcDeps {
  /** Wave 3 (Idea 9)'s rollback-in-flight guard. Absent means "never busy". */
  isRollingBack?: () => boolean;
  /** `window.emit`, for `restore_file_version`'s two best-effort broadcasts. */
  emit?: EmitFn;
  /** Called after a successful `change_password` with the new password — see
   * {@link changePasswordCore}'s own doc on why the caller, not this file,
   * owns the in-memory room password. */
  onPasswordChanged?: (newPassword: string) => void;
}


/** Register every `commands/safety.rs` channel on `ipcMain`. Channel names
 * are the Rust `#[tauri::command]` names `ipc-contract.ts` already declares,
 * so the renderer side needs no rename. */
export function registerSafetyIpc(
  ipcMain: Pick<IpcMain, "handle">,
  room: SafetyRoomSource,
  deps: SafetyIpcDeps = {}
): void {
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R): void => {
    ipcMain.handle(channel, (_event: IpcMainInvokeEvent, ...args: A) => fn(...args));
  };

  handle("list_file_versions", (args: { id: string }) =>
    listFileVersions(openRoomOrThrow(room).conn, args.id)
  );
  handle("file_versions_kept", () => fileVersionsKept());
  handle("pin_file_version", (args: { versionId: string; pinned: boolean }) =>
    pinFileVersion(openRoomOrThrow(room).conn, args.versionId, args.pinned)
  );
  handle("delete_file_version", async (args: { versionId: string }) => {
    const open = openRoomOrThrow(room);
    if (open.workspace !== undefined) return open.workspace.deleteVersion(args.versionId);
    deleteFileVersion(open.conn, args.versionId);
  });
  handle("get_file_provenance", (args: { id: string }) =>
    getFileProvenance(openRoomOrThrow(room).conn, args.id)
  );
  handle("get_file_version", async (args: { versionId: string }) => {
    const open = openRoomOrThrow(room);
    return open.workspace === undefined
      ? versionContent(open.conn, args.versionId)
      : workspaceVersionContent(open.conn, open.workspace, args.versionId);
  });
  handle("restore_file_version", async (args: { versionId: string }) => {
    const open = openRoomOrThrow(room);
    const fileId = open.workspace === undefined
      ? restoreVersionInto(open.conn, args.versionId)
      : await open.workspace.restoreVersion(args.versionId);
    emitSafely(deps.emit, "room-files-changed", undefined);
    emitSafely(deps.emit, "file-updated", fileId);
  });
  handle("export_file", (args: { id: string; destPath: string }) => {
    const open = openRoomOrThrow(room);
    return open.workspace === undefined
      ? exportFile(open.conn, args.id, args.destPath)
      : exportWorkspaceFile(open.conn, open.workspace, args.id, args.destPath);
  });
  handle("export_all", (args: { destDir: string }) => {
    const open = openRoomOrThrow(room);
    return open.workspace === undefined
      ? exportAll(open.conn, args.destDir)
      : exportAllWorkspace(open.conn, open.workspace, args.destDir);
  });
  handle("change_password", async (args: { current: string; newPassword: string }) => {
    const open = openRoomOrThrow(room);
    if (open.readOnly === true) throw new Error("This workspace is read-only because another Arcelle process owns the writer lease.");
    const databasePath = open.descriptor?.dbPath ?? open.path;
    const code = await changePassword(
      open.conn,
      databasePath,
      args.current,
      args.newPassword,
      deps.isRollingBack,
      open.workspace === undefined ? undefined : {
        databasePath,
        biometricPath: open.path,
        recoveryPath: databasePath,
        checkpointsPath: open.path,
      },
    );
    deps.onPasswordChanged?.(args.newPassword);
    return code;
  });
  handle("duplicate_room", (args: { destPath: string; newPassword: string | null }) => {
    const open = openRoomOrThrow(room);
    if (open.readOnly === true) throw new Error("This workspace is read-only because another Arcelle process owns the writer lease.");
    if (open.workspace === undefined || open.descriptor?.kind !== "workspace-folder") {
      return duplicateRoom(open.conn, open.password, args.destPath, args.newPassword);
    }
    return duplicateWorkspaceRoom(
      open.workspace,
      open.descriptor.roomId,
      open.password,
      args.destPath,
      args.newPassword,
    );
  });
  handle("compact_room", () => {
    const open = openRoomOrThrow(room);
    if (open.readOnly === true) throw new Error("This workspace is read-only because another Arcelle process owns the writer lease.");
    return compactRoom(open.conn);
  });
}
