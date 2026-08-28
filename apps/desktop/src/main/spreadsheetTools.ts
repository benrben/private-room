/**
 * Port of `src-tauri/src/commands/spreadsheet.rs` (618 lines, read in full) —
 * specifically the ONE surface of that file with no port yet: the `set_cell`
 * `#[tauri::command]` behind the spreadsheet viewer's grid, the click-a-cell/
 * type-a-value editing path a person drives directly (as opposed to the
 * agent's batch `set_cells` tool).
 *
 * REUSED RATHER THAN DUPLICATED, per this batch's instructions — everything
 * else `spreadsheet.rs` defines is already ported elsewhere and is NOT
 * re-spelled here:
 *   - `parse_a1`/`is_a1_range` — ported verbatim in `fileTools.ts` (see its
 *     own tests), reused from there by `editMatchCells.ts`'s doc comment.
 *   - `DelimField`, `parse_delim`/`parse_delim_quoted`, `serialize_delim*`,
 *     `guess_sep`, `read_as`/`DelimRead`, and the CSV/TSV half of
 *     `set_cell_in_bytes` — ported verbatim as `editMatchCells.ts`, which
 *     this file imports {@link setCellInBytes} from directly. That module's
 *     own doc explains the ONE functional gap in the whole port: `xlsx_set_cell`
 *     (real binary OOXML read-modify-write via the `umya-spreadsheet` crate)
 *     has no Node equivalent dependency, so `setCellInBytes` answers a
 *     clearly-worded "not supported in this port" refusal for `.xlsx` rather
 *     than fabricating a binary writer. That refusal is inherited here
 *     unchanged — this file does not touch `.xlsx` handling at all.
 *   - `store_file_bytes` — ported as `editMatch.ts`'s {@link storeFileBytes},
 *     the same single-write-path every other ported command in this codebase
 *     uses (`docxEdit.ts`, `organizeTools.ts`, `safetyTools.ts`, …).
 *
 * WHAT THIS FILE ACTUALLY ADDS: the `set_cell` command's own glue — read the
 * open room's file bytes by id, call `setCellInBytes`, write the result back
 * through `storeFileBytes`, and broadcast the two UI events the Rust source
 * fires on success. Modeled closely on `docxEdit.ts`'s `updateDocxText`/
 * `registerDocxEditIpc` pair (the nearest sibling: a `#[tauri::command]` that
 * edits one room file's bytes and re-indexes it), and on `previewTools.ts`/
 * `recIpc.ts` for the `RoomSource`/`openDb`/`EmitFn` plumbing shape.
 *
 * DEVIATION FROM `docxEdit.ts`'s EMIT PLACEMENT — preserved exactly as Rust
 * has it, not harmonized: `docx_edit.rs` emits `room-files-changed`
 * UNCONDITIONALLY, even down its no-op branch, because the emit sits AFTER
 * `state.with_room` returns. `spreadsheet.rs`'s `set_cell` is different — its
 * two `window.emit(...)` calls sit INSIDE `state.with_room`'s closure, after
 * `store_file_bytes` has already succeeded, with nothing after them but
 * `Ok(())`. So here both emits are conditional: any error (bad cell, missing
 * file, unsupported type, non-UTF-8 bytes, no room) throws before either
 * fires, matching the `?` short-circuit the closure body actually has.
 *
 * NOT A MODEL TOOL: `set_cell` (singular — one cell, from the viewer's grid)
 * has no `exec_tool` arm in `agent.rs` and no entry in `toolSpecs.ts`/
 * `toolSchema.ts` (confirmed by grep), exactly like the Rust
 * `#[tauri::command]` it ports. The model-invocable tool is the DIFFERENT,
 * already-plural `set_cells` (batch), which lives in `edit_match.rs`'s
 * `plan_set_cells` — already ported as `editMatch.ts`'s `planSetCells`, and
 * already declared in `toolSpecs.ts` — not in `spreadsheet.rs` at all, so
 * porting it is out of this file's scope. `execTool.ts`'s `"set_cells"` arm
 * currently answers `notImplemented(...)` pending a separate, much larger
 * Batch D (the shared `edit_file`/`edit_files`/`write_file`/`set_cells`
 * diff-preview gate); nothing in THIS batch changes that, since `set_cells`
 * itself is not part of `spreadsheet.rs`. Nothing in this file touches
 * `execTool.ts`.
 *
 * NO IPC WIRING in this batch, same as `dictStopTimeout.ts`/`recIpc.ts`/
 * `previewTools.ts`/`docxEdit.ts`: Phase 2 (renderer/preload) needs an
 * explicit owner go-ahead before touching the live shipping app.
 * {@link registerSpreadsheetIpc} exists, ready to be wired, but nothing calls
 * it yet. `set_cell` is already declared on `ipc-contract.ts`'s wire contract
 * (`set_cell: { args: { id, sheet, cell, value }; result: void }`, matching
 * `src/api.ts`'s `invoke<void>("set_cell", { id, sheet, cell, value })`), so
 * the channel name and argument shape need no invention here.
 */

import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type Database from "better-sqlite3-multiple-ciphers";
import { getFileBytesNamed } from "./db-host/files.js";
import { storeFileBytes } from "./editMatch.js";
import { setCellInBytes } from "./editMatchCells.js";
import type { OpenRoom } from "./turnEngine.js";
import { readRoomFile, writeRoomFile } from "./workspace/roomContent.js";

// ------------------------------------------------------------- room/emit plumbing

/** The slice of the (not-yet-ported) `AppState` this command needs: whichever
 * room is open RIGHT NOW. Reuses `turnEngine.ts`'s {@link OpenRoom} rather
 * than inventing a second "how do I reach the open room" convention — same
 * reasoning `recIpc.ts`'s/`previewTools.ts`'s/`docxEdit.ts`'s own
 * `RoomSource` gives. */
export interface RoomSource {
  currentRoom(): OpenRoom | null;
}

/** `AppState::with_room`'s own refusal, spelled the way every sibling module
 * already spells it. */
const NO_ROOM_OPEN = "No room is open.";

function openDb(room: RoomSource): Database.Database {
  const open = room.currentRoom();
  if (open === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  return open.db;
}

function openRoom(room: RoomSource): OpenRoom {
  const open = room.currentRoom();
  if (open === null) throw new Error(NO_ROOM_OPEN);
  return open;
}

/** `let _ = window.emit(...)` — a best-effort UI notification that must never
 * turn a successful cell edit into a failed one. Same narrowest-possible
 * contract as `docxEdit.ts`'s/`organizeTools.ts`'s own `EmitFn`. */
export type EmitFn = (event: string, payload: unknown) => void;

function emitSafely(emit: EmitFn | undefined, event: string, payload: unknown): void {
  try {
    emit?.(event, payload);
  } catch {
    // Swallowed deliberately, matching Rust's `let _ = window.emit(...)`.
  }
}

// ---------------------------------------------------------------------- command

/**
 * Set one spreadsheet cell (A1 notation) from the viewer's grid, and re-index
 * the file. Ported from `spreadsheet::set_cell`, minus the Tauri wrapper —
 * takes the room's already-resolved `Database.Database`, matching
 * `docxEdit.ts`'s/`previewTools.ts`'s/`recIpc.ts`'s convention.
 *
 * Throws (matching the Rust `?` chain inside `state.with_room`) when:
 *   - `id` names no file in this room (`get_file_bytes_named`'s own
 *     `query_one` failure, mirrored by `getFileBytesNamed`'s `queryOne`);
 *   - the file has no stored bytes at all ("File has no stored content.");
 *   - `setCellInBytes` refuses — a malformed cell reference, an unsupported
 *     file type, non-UTF-8 CSV/TSV bytes, or (the one known gap) `.xlsx`.
 *
 * On success, writes the new bytes through {@link storeFileBytes} (the same
 * snapshot-then-overwrite path `commit_plans`/every other ported write uses,
 * cause text `"You edited"` — Rust's own literal, not `docxEdit.ts`'s
 * `"You edited the document"`) and fires both UI events the Rust source
 * fires, in the same order: `room-files-changed` (the list/search index is
 * stale) then `file-updated` with the file's id (the per-file viewer should
 * reload). Both are best-effort and both are UNREACHABLE on any error path,
 * because in the Rust source they sit inside the closure AFTER
 * `store_file_bytes` has already succeeded, with nothing after them but
 * `Ok(())` — unlike `docxEdit.ts`'s `update_docx_text`, whose single emit
 * sits outside `state.with_room` and therefore fires unconditionally.
 */
export function setCell(
  db: Database.Database,
  id: string,
  sheet: string | null,
  cell: string,
  value: string,
  emit?: EmitFn
): void {
  const [name, bytesRaw] = getFileBytesNamed(db, id);
  if (bytesRaw === null) {
    throw new Error("File has no stored content.");
  }
  const result = setCellInBytes(name, bytesRaw, sheet, cell, value);
  if (!result.ok) {
    throw new Error(result.error);
  }
  storeFileBytes(db, id, result.bytes, result.text, "You edited");
  emitSafely(emit, "room-files-changed", undefined);
  emitSafely(emit, "file-updated", id);
}

export async function setCellInRoom(
  open: OpenRoom,
  id: string,
  sheet: string | null,
  cell: string,
  value: string,
  emit?: EmitFn,
): Promise<void> {
  const file = await readRoomFile(open, id);
  if (file.bytes === null) throw new Error("File has no stored content.");
  const result = setCellInBytes(file.name, file.bytes, sheet, cell, value);
  if (!result.ok) throw new Error(result.error);
  await writeRoomFile(open, id, result.bytes, result.text, "You edited");
  emitSafely(emit, "room-files-changed", undefined);
  emitSafely(emit, "file-updated", id);
}

/**
 * Registers {@link setCell} on the `set_cell` channel — the Rust
 * `#[tauri::command]` name `src/api.ts`'s `invoke("set_cell", …)` already
 * uses, so the renderer side needs no rename. `ipcMain` is accepted as a
 * parameter, typed against the real `electron` module without importing it
 * at runtime, so this file resolves and tests under plain Node/vitest exactly
 * like `registerDocxEditIpc`/`registerPreviewIpc`/`registerRecIpc` do.
 *
 * Exported and directly testable, but — same as `docxEdit.ts`/
 * `previewTools.ts`/`recIpc.ts` — NOT called from any live main-process
 * entrypoint by this batch. Wiring it in is Phase 2 work pending an explicit
 * owner go-ahead.
 */
export function registerSpreadsheetIpc(
  ipcMain: Pick<IpcMain, "handle">,
  room: RoomSource,
  emit?: EmitFn
): void {
  ipcMain.handle(
    "set_cell",
    (_event: IpcMainInvokeEvent, args: { id: string; sheet: string | null; cell: string; value: string }) =>
      setCellInRoom(openRoom(room), args.id, args.sheet, args.cell, args.value, emit)
  );
}
