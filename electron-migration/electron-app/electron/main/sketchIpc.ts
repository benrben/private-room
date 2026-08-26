/**
 * Thin `ipcMain.handle` registration for the Sketch page's four commands
 * (`create_sketch`, `save_sketch`, `export_sketch_svg`, `export_sketch_png`)
 * — the `#[tauri::command]` wrappers in `src-tauri/src/commands/sketch.rs`,
 * over the real logic in `sketchCommands.ts`.
 *
 * NO IPC WIRING HAPPENS BY IMPORTING THIS FILE, matching `recIpc.ts`/
 * `dictStopTimeout.ts`/`browser/browseCommands_*.ts`: Phase 2 (renderer +
 * preload) needs an explicit owner go-ahead before touching the live
 * shipping app. {@link registerSketchIpc} exists, is tested directly, and is
 * called by nothing in this migration's bootstrap.
 *
 * Every handler is THIN: no logic of its own beyond resolving the open
 * room's `db`, forwarding arguments, and — for the three commands whose Rust
 * wrapper ends in `let _ = app.emit("room-files-changed", ())` — sending
 * that one broadcast. `save_sketch` deliberately sends none: its whole point
 * is to stay off the path that makes the Library, the gallery and the viewer
 * all re-read while the pointer is still down (see `writeSketch`'s doc).
 *
 * `RoomSource` reuses `recIpc.ts`'s own shape rather than inventing a second
 * "how do I reach the open room" convention — a future host-state batch
 * implements one thing and satisfies every IPC registration file.
 */

import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { OpenRoom } from "./turnEngine.js";
import {
  createSketchInRoom,
  type EmitFn,
  emitSafely,
  exportSketchPngInRoom,
  exportSketchSvgInRoom,
  writeSketchInRoom,
} from "./sketchCommands.js";

/** The slice of room state every sketch IPC handler needs — `recIpc.ts`'s
 * own `RoomSource`, verbatim. */
export interface RoomSource {
  currentRoom(): OpenRoom | null;
}

const NO_ROOM_OPEN = "No room is open.";

function openRoom(room: RoomSource): OpenRoom {
  const open = room.currentRoom();
  if (open === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  return open;
}

/**
 * Register the four Sketch page channels on `ipcMain`. Channel names are the
 * Rust `#[tauri::command]` names `src/api.ts`'s `invoke(...)` calls already
 * use, so the renderer side needs no rename. `emit` is the app-wide
 * broadcast (`app.emit` in Rust) — optional, best-effort, and swallowed on
 * failure, exactly like `let _ = app.emit(...)`.
 */
export function registerSketchIpc(ipcMain: Pick<IpcMain, "handle">, room: RoomSource, emit?: EmitFn): void {
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R): void => {
    ipcMain.handle(channel, (_event: IpcMainInvokeEvent, ...args: A) => fn(...args));
  };

  handle("create_sketch", async (args: { name: string }) => {
    const meta = await createSketchInRoom(openRoom(room), args.name);
    emitSafely(emit, "room-files-changed", undefined);
    return meta;
  });
  handle("save_sketch", async (args: { id: string; doc: string; snapshot: boolean }) => {
    await writeSketchInRoom(openRoom(room), args.id, args.doc, args.snapshot);
  });
  handle("export_sketch_svg", async (args: { id: string }) => {
    const meta = await exportSketchSvgInRoom(openRoom(room), args.id);
    emitSafely(emit, "room-files-changed", undefined);
    return meta;
  });
  handle("export_sketch_png", async (args: { id: string }) => {
    const meta = await exportSketchPngInRoom(openRoom(room), args.id);
    emitSafely(emit, "room-files-changed", undefined);
    return meta;
  });
}
