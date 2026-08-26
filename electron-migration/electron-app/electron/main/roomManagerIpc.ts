/**
 * Thin `ipcMain.handle` registration for every `#[tauri::command]` in
 * `src-tauri/src/commands/rooms.rs`, over the real business logic in
 * `roomManager.ts`.
 *
 * NO IPC WIRING in this batch — same as `recIpc.ts`, `dictStopTimeout.ts` and
 * `recentTools.ts`'s `registerRecentIpc`: Phase 2 (renderer/preload) needs an
 * explicit owner go-ahead before touching the live shipping app.
 * {@link registerRoomManagerIpc} exists, ready to be wired, but nothing in
 * this migration's bootstrap calls it yet. It is unit-tested by invoking the
 * captured handlers directly, never through a real IPC round trip.
 *
 * Every handler is THIN: no logic of its own beyond forwarding arguments.
 * Anything a handler could decide (refusals, the rollback guard, teardown
 * sequencing) already lives in `roomManager.ts`, tested there against real
 * fixture rooms. `ipcMain` is accepted as a parameter and typed against the
 * real `electron` module without importing it at runtime, so this file
 * resolves and tests under plain Node/vitest exactly like `recIpc.ts` does.
 *
 * Channel names and argument shapes are taken verbatim from
 * `electron/shared/ipc-contract.ts`, which already declares all fourteen —
 * including `create_room`'s `name: string | null` (Rust's `Option<String>`),
 * so the renderer side needs no rename and no shape change when it lands.
 *
 * `take_pending_open` is registered here even though its logic lives in
 * `pendingOpen.ts` (already fully ported): it is one of `rooms.rs`'s own
 * commands, so the module's whole IPC surface belongs in one shim.
 */

import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { RoomInfo } from "../shared/apiTypes.js";
import type { WorkspaceOperationProgressSink } from "../shared/workspaceProgress.js";
import { convertLegacyRoomToWorkspace } from "./workspace/conversion.js";
import {
  createSealedPackage,
  importSealedPackage,
  inspectSealedPackage,
} from "./workspace/sealedPackage.js";
import { roomStorageUsage } from "./workspace/storageUsage.js";
import {
  closeRoom,
  createRoom,
  hasRecoveryKey,
  openRoom,
  openRoomWithRecovery,
  renameRoom,
  registerWorkspaceCopy,
  rescanWorkspaceRoom,
  setWorkspaceWatcherPolling,
  roomInfo,
  takePendingOpen,
  takeRecRecoveryError,
  touchIdDisable,
  touchIdEnable,
  touchIdHas,
  touchIdOpen,
  writeRecoveryKey,
  workspaceWatcherStatus,
  type RoomManagerDeps,
  type RoomManagerState,
} from "./roomManager.js";

/** Register every `rooms.rs` command channel on `ipcMain`, closing over one
 * shared {@link RoomManagerState} and {@link RoomManagerDeps} — the same "one
 * open room for the whole process" the Rust `AppState` models. */
export function registerRoomManagerIpc(
  ipcMain: Pick<IpcMain, "handle">,
  state: RoomManagerState,
  deps: RoomManagerDeps
): void {
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R): void => {
    ipcMain.handle(channel, (_event: IpcMainInvokeEvent, ...args: A) => fn(...args));
  };
  const progressFor = (event: IpcMainInvokeEvent): WorkspaceOperationProgressSink =>
    (progress) => event?.sender?.send?.("workspace-operation-progress", progress);

  handle(
    "create_room",
    (args: {
      path: string;
      password: string;
      name: string | null;
      format?: "sealed-db" | "workspace-folder";
    }): RoomInfo =>
      createRoom(state, deps, args.path, args.password, args.name, args.format)
  );
  handle(
    "open_room",
    (args: { path: string; password: string }): RoomInfo =>
      openRoom(state, deps, args.path, args.password)
  );
  ipcMain.handle(
    "convert_legacy_room",
    (event: IpcMainInvokeEvent, args: { sourcePath: string; password: string; destinationPath: string }) => {
      if (state.room !== null) {
        throw new Error("Lock the open room before converting a legacy room.");
      }
      return convertLegacyRoomToWorkspace(args.sourcePath, args.password, args.destinationPath, {
        progress: progressFor(event),
      });
    },
  );
  ipcMain.handle(
    "create_sealed_package",
    (event: IpcMainInvokeEvent, args: { destinationPath: string; exportPassword: string | null; purpose?: string }) => {
      const room = state.room;
      if (room?.workspace === undefined || room.descriptor?.kind !== "workspace-folder") {
        throw new Error("Sealed package creation is available for workspace rooms.");
      }
      return createSealedPackage(
        room.workspace,
        room.descriptor.roomId,
        room.password,
        args.destinationPath,
        args.exportPassword ?? room.password,
        args.purpose ?? "backup",
        { progress: progressFor(event) },
      );
    },
  );
  handle(
    "inspect_sealed_package",
    (args: { packagePath: string; password: string }) =>
      inspectSealedPackage(args.packagePath, args.password),
  );
  ipcMain.handle(
    "import_sealed_package",
    (event: IpcMainInvokeEvent, args: {
      packagePath: string;
      packagePassword: string;
      destinationPath: string;
      workspacePassword: string | null;
    }) => {
      if (state.room !== null) throw new Error("Lock the open room before importing a sealed package.");
      return importSealedPackage(
        args.packagePath,
        args.packagePassword,
        args.destinationPath,
        args.workspacePassword ?? args.packagePassword,
        { progress: progressFor(event) },
      );
    },
  );
  handle(
    "open_room_with_recovery",
    (args: { path: string; code: string }): Promise<RoomInfo> =>
      openRoomWithRecovery(state, deps, args.path, args.code)
  );
  handle("close_room", (): Promise<void> => closeRoom(state, deps));
  handle("room_info", (): RoomInfo | null => roomInfo(state, deps));
  handle("room_storage_usage", () => {
    if (state.room === null) throw new Error("No room is open.");
    return roomStorageUsage(state.room);
  });
  handle("workspace_watcher_status", () => workspaceWatcherStatus(state));
  handle("rescan_workspace_room", () => rescanWorkspaceRoom(state));
  handle(
    "set_workspace_watcher_polling",
    (args: { enabled: boolean }) => setWorkspaceWatcherPolling(state, args.enabled),
  );
  handle("rename_room", (args: { name: string }): RoomInfo => renameRoom(state, deps, args.name));
  handle("register_workspace_copy", (): RoomInfo => registerWorkspaceCopy(state, deps));
  handle("write_recovery_key", (): Promise<string> => writeRecoveryKey(state));
  handle("has_recovery_key", (args: { path: string }): boolean => hasRecoveryKey(args.path));
  handle("take_rec_recovery_error", (): string | null => takeRecRecoveryError(state));
  handle("take_pending_open", (): string | null => takePendingOpen());

  // Touch ID — ADD-11, wired onto the real keychain.ts (see roomManager.ts).
  handle(
    "touchid_has",
    (args: { path: string }): Promise<boolean> => touchIdHas(args.path, deps)
  );
  handle("touchid_enable", (): Promise<void> => touchIdEnable(state, deps));
  handle(
    "touchid_disable",
    (args: { path: string }): Promise<void> => touchIdDisable(args.path, deps)
  );
  handle(
    "touchid_open",
    (args: { path: string }): Promise<RoomInfo> => touchIdOpen(state, deps, args.path)
  );
}
