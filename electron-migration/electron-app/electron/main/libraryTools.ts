/**
 * The room "library" IPC command layer — memories (with Wave-1b categories and
 * S9 soft-delete), ADD-16 folders, and the generic app-settings key/value
 * store. Ported from `src-tauri/src/commands/library.rs` (251 lines, read in
 * full, including its `#[cfg(test)] mod tests`).
 *
 * WHAT THIS FILE IS: the thin `#[tauri::command]` layer that resolves "which
 * room is open" and forwards to the already-committed `db-host` layer —
 * `db-host/memories.ts`, `db-host/folders.ts`, `db-host/settings.ts` — plus
 * the THREE pieces of real logic `library.rs` owns itself and that nothing
 * else in this rewrite has ported yet:
 *   - {@link duplicateMemory} (UX-5) — an exact-text duplicate check shared by
 *     the UI command and the agent tool, so neither path can create the same
 *     memory twice.
 *   - {@link normalizeCategory} (Wave 1b, idea 5) — fold a raw category string
 *     onto the fixed preference|fact|project|instruction vocabulary; anything
 *     else (misspelling, free text, empty) degrades to `null`, never an error.
 *   - {@link memoryWithinCap} (CHG-7) — the length cap on one memory's text,
 *     enforced as a REFUSAL, never a silent truncation: a note that came back
 *     cut in half had no version history to restore the rest from.
 *
 * A NOTE ON DUPLICATION WITH `execTool.ts`. The Rust source shares
 * `duplicate_memory`/`normalize_category`/`MAX_MEMORY_CONTENT_CHARS` between
 * THIS file's UI commands and `agent.rs`'s `add_memory`/`update_memory` tool
 * arms — one function, two callers. In this port, `execTool.ts` already
 * carries its OWN private copies of `duplicateMemory`/`normalizeCategory`
 * (its own doc marks them "Ported verbatim from `commands::library::…`"),
 * committed before this file existed. Per this batch's instructions, that
 * file is not touched here — a concurrent workflow may be editing it, and
 * collapsing the two copies into one shared export is a reconciliation a
 * later batch should do deliberately, not a side effect of this port. Until
 * then the Rust source's ONE set of rules is enforced by TWO independently
 * ported, currently-identical, copies (this file's and `execTool.ts`'s) —
 * exactly the kind of drift risk the Rust `duplicate_memory` doc comment
 * calls out as the reason to share it in the first place. `MAX_MEMORY_CONTENT_CHARS`
 * itself is NOT re-declared here — it is imported from `toolSpecs.ts`, which
 * already exports the one copy `execTool.ts` uses, so the cap number itself
 * cannot drift even though the two enforcement sites currently can.
 *
 * ROOM ACCESS reuses `jobs.ts`'s {@link RoomSource}/{@link RoomHandle} — the
 * `state.room.lock()` stand-in `privacy.ts` already adopted rather than
 * inventing a second "which room is open" notion — because {@link setSetting}
 * needs a {@link PolicyDeps} (which itself carries a `RoomSource` of this
 * exact shape) to call `refreshPolicy`. A future host-state batch should
 * implement one real `AppState` that satisfies this shape rather than any
 * file minting its own.
 *
 * NO IPC WIRING in this batch, same as `recIpc.ts` and `dictStopTimeout.ts`:
 * {@link registerLibraryIpc} exists, ready to be wired, but nothing in this
 * migration's bootstrap calls it yet — Phase 2 (renderer/preload) needs an
 * explicit owner go-ahead before touching the live shipping app.
 *
 * MODEL-INVOCABLE OVERLAP: `add_memory`/`list_memories`/`update_memory`/
 * `delete_memory` are also `exec_tool` arms (`BUILTIN_TOOL_NAMES` in
 * `toolSpecs.ts`), but that dispatch is ALREADY WIRED in `execTool.ts`
 * (`execAddMemory`/`execListMemories`/`execUpdateOrDeleteMemory`, against
 * `db-host/memories.ts` directly) by an earlier batch — see the module doc
 * above. There is nothing left to add to `execTool.ts` for this file's
 * commands: `list_folders`/`create_folder`/`rename_folder`/`delete_folder`/
 * `move_file_to_folder`/`get_setting`/`set_setting` are UI-only and do not
 * appear in `BUILTIN_TOOL_NAMES` at all.
 *
 * ROOM-DISCOVERY OVERLAP: despite the "room library" name, this file has
 * NOTHING to do with the set of `.room`/`.roomai` files known to this Mac
 * (room-open/room-list, `commands/rooms.rs`, 958 lines) — that is a wholly
 * different Rust module. `src-tauri/src/commands/library.rs` itself is
 * exactly what its own contents say: memories, folders and settings for the
 * room that is ALREADY open. Noted here in case a future reconciliation pass
 * goes looking for room-discovery logic under this file's name.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  addMemory as dbAddMemory,
  deleteMemory as dbDeleteMemory,
  listMemories as dbListMemories,
  restoreMemory as dbRestoreMemory,
  updateMemory as dbUpdateMemory,
  type Memory,
} from "./db-host/memories.js";
import {
  createFolder as dbCreateFolder,
  deleteFolder as dbDeleteFolder,
  listFolders as dbListFolders,
  moveFileToFolder as dbMoveFileToFolder,
  renameFolder as dbRenameFolder,
  type Folder,
} from "./db-host/folders.js";
import { getSetting as dbGetSetting, setSetting as dbSetSetting } from "./db-host/settings.js";
import { normalizeForMatch } from "./textClamp.js";
import { MAX_MEMORY_CONTENT_CHARS } from "./toolSpecs.js";
import { refreshPolicy, type PolicyDeps } from "./privacy.js";
import type { RoomHandle, RoomSource } from "./jobs.js";

export type { Memory, Folder };

// --------------------------------------------------------------- room access

/** `AppState::with_room`'s own refusal, spelled the way every other ported
 * command layer already spells it. */
const NO_ROOM_OPEN = "No room is open.";

/** The open room, or a thrown "No room is open." — `state.with_room`'s guard,
 * in one place. */
function requireRoom(room: RoomSource): RoomHandle {
  const open = room.current();
  if (open === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  return open;
}

// ------------------------------------------------------------------ memories

/**
 * UX-5: an existing memory whose normalized text equals `content`'s, if any.
 * Shared (in the Rust source) by the UI command and the AI tool so neither
 * path can create an exact duplicate (ignoring case and whitespace). Ported
 * verbatim from `commands::library::duplicate_memory`.
 */
export function duplicateMemory(db: Database.Database, content: string): Memory | null {
  const norm = normalizeForMatch(content);
  return dbListMemories(db).find((m) => normalizeForMatch(m.content) === norm) ?? null;
}

/** The fixed Wave-1b (idea 5) category vocabulary. Anything else (misspelling,
 * free-form tag, empty) folds to `null`, never an error — a 4B model cannot be
 * trusted to reproduce an enum exactly. Ported verbatim from
 * `commands::library::normalize_category`. */
export function normalizeCategory(raw: string): string | null {
  switch (raw.trim().toLowerCase()) {
    case "preference":
      return "preference";
    case "fact":
      return "fact";
    case "project":
      return "project";
    case "instruction":
      return "instruction";
    default:
      return null;
  }
}

/**
 * CHG-7: memories are injected into the prompt, so their length is capped —
 * but the cap REFUSES rather than truncates, the way the agent's own
 * `add_memory` tool already does. Cutting the text at the cap was silent and
 * unrecoverable: a 1,200-character note came back 500 characters long with no
 * warning, no marker and no toast, and memories have no version history to
 * restore the rest from.
 *
 * Counted in Unicode CODE POINTS (`[...content].length`), like the Rust cap
 * itself (`chars().count()`): counting UTF-16 units, let alone UTF-8 bytes,
 * would ration a note typed in Hebrew at a different length than the same
 * note in English. Ported verbatim from `commands::library::memory_within_cap`.
 */
export function memoryWithinCap(content: string): string {
  const len = [...content].length;
  if (len > MAX_MEMORY_CONTENT_CHARS) {
    throw new Error(
      `That memory is ${len} characters — ${MAX_MEMORY_CONTENT_CHARS} at most, so it stays ` +
        "short enough to travel with every question."
    );
  }
  return content;
}

/** Ported from `commands::library::add_memory`. `category` folds through
 * {@link normalizeCategory} exactly as the Rust command's
 * `category.as_deref().and_then(normalize_category)` does — an unrecognized or
 * absent category is `null`, never a refusal. */
export function addMemory(db: Database.Database, content: string, category: string | null = null): Memory {
  const capped = memoryWithinCap(content);
  // UX-5: never store an exact duplicate; hand back the existing entry
  // instead (callers can tell by its old createdAt).
  const existing = duplicateMemory(db, capped);
  if (existing !== null) {
    return existing;
  }
  const cat = category !== null ? normalizeCategory(category) : null;
  return dbAddMemory(db, capped, cat);
}

/** Ported from `commands::library::list_memories`. */
export function listMemories(db: Database.Database): Memory[] {
  return dbListMemories(db);
}

/** UX-5: edit a memory's text (and, Wave 1b, its category) in place. Ported
 * from `commands::library::update_memory`. */
export function updateMemory(
  db: Database.Database,
  id: string,
  content: string,
  category: string | null = null
): void {
  const capped = memoryWithinCap(content);
  const cat = category !== null ? normalizeCategory(category) : null;
  dbUpdateMemory(db, id, capped, cat);
}

/** Ported from `commands::library::delete_memory` — a UI delete is always
 * attributed to the user, never the agent, so "what did the AI delete" stays
 * answerable. */
export function deleteMemory(db: Database.Database, id: string): void {
  dbDeleteMemory(db, id, { kind: "user" });
}

/** S9 (2026-08-04): put a soft-deleted memory back. Not reachable from the
 * agent — recovery is a human action, same posture as file restore. Ported
 * from `commands::library::restore_memory`. */
export function restoreMemory(db: Database.Database, id: string): void {
  dbRestoreMemory(db, id);
}

// ------------------------------------------------------------- folders (ADD-16)

/** Ported from `commands::library::list_folders`. */
export function listFolders(db: Database.Database): Folder[] {
  return dbListFolders(db);
}

/** Ported from `commands::library::create_folder`. */
export function createFolder(db: Database.Database, name: string): Folder {
  return dbCreateFolder(db, name);
}

/** Ported from `commands::library::rename_folder`. */
export function renameFolder(db: Database.Database, id: string, name: string): void {
  dbRenameFolder(db, id, name);
}

/** Ported from `commands::library::delete_folder`. */
export function deleteFolder(db: Database.Database, id: string): void {
  dbDeleteFolder(db, id);
}

/** Ported from `commands::library::move_file_to_folder`. */
export function moveFileToFolder(db: Database.Database, fileId: string, folderId: string | null): void {
  dbMoveFileToFolder(db, fileId, folderId);
}

// --------------------------------------------------------------- settings

/** Ported from `commands::library::get_setting`. */
export function getSetting(db: Database.Database, key: string): string | null {
  return dbGetSetting(db, key);
}

/**
 * Ported from `commands::library::set_setting`. PRIV-1: privacy keys written
 * through this generic path (or a model change, which alters the guard model)
 * keep the cached policy current — the DB write happens first, then
 * {@link refreshPolicy} re-reads the room to recompute, exactly mirroring the
 * Rust command's `state.with_room(...)?; if key.starts_with("cloud_privacy")
 * || key == "model" { refresh_policy(&app, &state); }` ordering (a failed
 * write must never reach the refresh).
 */
export function setSetting(deps: PolicyDeps, key: string, value: string): void {
  const room = requireRoom(deps.room);
  dbSetSetting(room.db, key, value);
  if (key.startsWith("cloud_privacy") || key === "model") {
    refreshPolicy(deps);
  }
}

// ------------------------------------------------------------------- IPC

/**
 * Register every `library.rs` channel on `ipcMain`. Channel names are the
 * Rust `#[tauri::command]` names the renderer's `invoke(...)` calls already
 * use, so the renderer side needs no rename. NOT called from any bootstrap
 * file in this batch — see the module doc.
 *
 * Every handler is THIN: it resolves the currently open room and forwards.
 * Anything a handler could decide (the cap, dedup, category folding, the
 * privacy-policy refresh) already lives in this module's own exported
 * functions above, tested there directly against a real fixture room.
 */
export function registerLibraryIpc(ipcMain: Pick<IpcMain, "handle">, deps: PolicyDeps): void {
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R): void => {
    ipcMain.handle(channel, (_event: IpcMainInvokeEvent, ...args: A) => fn(...args));
  };

  handle("add_memory", (args: { content: string; category?: string | null }) =>
    addMemory(requireRoom(deps.room).db, args.content, args.category ?? null)
  );
  handle("list_memories", () => listMemories(requireRoom(deps.room).db));
  handle(
    "update_memory",
    (args: { id: string; content: string; category?: string | null }) =>
      updateMemory(requireRoom(deps.room).db, args.id, args.content, args.category ?? null)
  );
  handle("delete_memory", (args: { id: string }) => deleteMemory(requireRoom(deps.room).db, args.id));
  handle("restore_memory", (args: { id: string }) => restoreMemory(requireRoom(deps.room).db, args.id));

  handle("list_folders", () => listFolders(requireRoom(deps.room).db));
  handle("create_folder", (args: { name: string }) => createFolder(requireRoom(deps.room).db, args.name));
  handle("rename_folder", (args: { id: string; name: string }) =>
    renameFolder(requireRoom(deps.room).db, args.id, args.name)
  );
  handle("delete_folder", (args: { id: string }) => deleteFolder(requireRoom(deps.room).db, args.id));
  handle(
    "move_file_to_folder",
    (args: { fileId: string; folderId?: string | null }) =>
      moveFileToFolder(requireRoom(deps.room).db, args.fileId, args.folderId ?? null)
  );

  handle("get_setting", (args: { key: string }) => getSetting(requireRoom(deps.room).db, args.key));
  handle("set_setting", (args: { key: string; value: string }) => setSetting(deps, args.key, args.value));
}
