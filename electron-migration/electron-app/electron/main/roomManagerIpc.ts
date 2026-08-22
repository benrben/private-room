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
import {
  closeRoom,
  createRoom,
  hasRecoveryKey,
  openRoom,
  openRoomWithRecovery,
  renameRoom,
  roomInfo,
  takePendingOpen,
  takeRecRecoveryError,
  touchIdDisable,
  touchIdEnable,
  touchIdHas,
  touchIdOpen,
  writeRecoveryKey,
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

  handle(
    "create_room",
    (args: { path: string; password: string; name: string | null }): RoomInfo =>
      createRoom(state, deps, args.path, args.password, args.name)
  );
  handle(
    "open_room",
    (args: { path: string; password: string }): RoomInfo =>
      openRoom(state, deps, args.path, args.password)
  );
  handle(
    "open_room_with_recovery",
    (args: { path: string; code: string }): Promise<RoomInfo> =>
      openRoomWithRecovery(state, deps, args.path, args.code)
  );
  handle("close_room", (): Promise<void> => closeRoom(state, deps));
  handle("room_info", (): RoomInfo | null => roomInfo(state, deps));
  handle("rename_room", (args: { name: string }): RoomInfo => renameRoom(state, deps, args.name));
  handle("write_recovery_key", (): Promise<string> => writeRecoveryKey(state));
  handle("has_recovery_key", (args: { path: string }): boolean => hasRecoveryKey(args.path));
  handle("take_rec_recovery_error", (): string | null => takeRecRecoveryError(state));
  handle("take_pending_open", (): string | null => takePendingOpen());

  // Touch ID — biometrics.rs is not ported; every arm rejects with an honest
  // NOT_IMPLEMENTED reason (see roomManager.ts). Registered anyway so a
  // renderer that calls these channels gets a real, explained rejection rather
  // than "no handler registered for touchid_has".
  handle("touchid_has", (args: { path: string }): Promise<boolean> => touchIdHas(args.path));
  handle("touchid_enable", (): Promise<void> => touchIdEnable(state));
  handle("touchid_disable", (args: { path: string }): Promise<void> => touchIdDisable(args.path));
  handle(
    "touchid_open",
    (args: { path: string }): Promise<RoomInfo> => touchIdOpen(state, deps, args.path)
  );
}
