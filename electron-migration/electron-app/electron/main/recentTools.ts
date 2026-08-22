/**
 * Recently-opened rooms: the start screen's "recent" list. Ported from
 * `src-tauri/src/commands/recent.rs` (226 lines, read in full including its
 * `#[cfg(test)] mod tests`).
 *
 * The list lives OUTSIDE any room, in the app's own per-Mac data folder —
 * rooms are encrypted; `recent.json` holds only the names the user gave them
 * and where they are on disk, in PLAINTEXT. Following this migration's
 * established convention (`mcpConfig.ts`, `scriptConsent.ts`, `privacy.ts`,
 * `windowGeometry.ts`), every function here takes the app's `userDataDir` as
 * a plain string rather than reading `app.path().app_data_dir()` /
 * `app.getPath('userData')` itself, so this stays a plain, testable Node
 * module with no `electron` runtime import.
 *
 * DEVIATION — directory creation: Rust's `recent_file` calls
 * `create_dir_all` on every access, read or write. `recentFilePath` here does
 * not — matching `scriptConsent.ts`'s stated reasoning for
 * `scriptApprovalsFile` over `mcp_approvals_file`: a read of a directory that
 * doesn't exist yet is already "nothing recorded", and a reader has no
 * business creating state. {@link writeRecent} creates the directory itself,
 * the one place in this module that actually needs it to exist.
 *
 * NOT ported here: `push_recent`/`rename_recent`'s CALL SITES
 * (`create_room`/`open_room_impl`/`rename_room` in `commands/rooms.rs`) — that
 * file is a separate porting task. This module only carries what
 * `recent.rs` itself owns, exactly the boundary the Rust source draws
 * (`rooms.rs` calls `push_recent`/`read_recent`/`write_recent`/
 * `rename_recent` as free functions, never duplicating their logic).
 *
 * NOT a model tool: `list_recent`/`remove_recent`/`clear_recent` are plain
 * `#[tauri::command]`s the start screen calls directly (`src/api.ts:318-320`);
 * none of them is an `exec_tool` match arm (checked against `toolSpecs.ts`/
 * `toolSchema.ts`/`execTool.ts` — no reference to any of the three), so there
 * is no `execTool.ts` arm to add.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { RecentRoom } from "../shared/apiTypes.js";

/** How many rooms the recents list remembers — recent.rs:61's inline `5`,
 * named here so {@link mergeRecent}'s cap and its test can both point at one
 * place. */
export const MAX_RECENT_ROOMS = 5;

/**
 * Where the recents list lives, beside the app's other per-Mac preference
 * files. Ported from `recent_file` (recent.rs:5-10), minus the
 * `create_dir_all` side effect — see this module's header for why.
 */
export function recentFilePath(userDataDir: string): string {
  return path.join(userDataDir, "recent.json");
}

/** The shape `readRecent` accepts off disk before defaults are applied — the
 * two REQUIRED fields (`name`/`path`), typed exactly as `serde_json` would
 * require them; `openedAt`/`missing` are optional because the Rust struct
 * marks both `#[serde(default)]` (recent.rs's `RecentRoom` lives in
 * `commands.rs:579-592`). */
interface RecentRoomJson {
  name: string;
  path: string;
  openedAt?: number | null;
  missing?: boolean;
}

/**
 * Mirrors what `serde_json::from_str::<Vec<RecentRoom>>` gets Rust for free:
 * `name`/`path` must be strings (required fields with no default), and
 * `openedAt`/`missing`, if PRESENT at all, must be the right type — a present
 * field of the wrong type is exactly as much a "this entry doesn't
 * deserialize" as a missing required one, matching serde's strict, no
 * coercion behavior. One entry failing this check fails the whole array (see
 * {@link readRecent}), exactly as one bad element fails all of serde's
 * `Vec<T>` deserialization.
 */
function isRecentRoomJson(x: unknown): x is RecentRoomJson {
  if (typeof x !== "object" || x === null) {
    return false;
  }
  const o = x as Record<string, unknown>;
  if (typeof o.name !== "string" || typeof o.path !== "string") {
    return false;
  }
  // `openedAt` is Rust's `Option<i64>`: an INTEGER or nothing. `typeof
  // === "number"` alone is not that check — `1.5` and `1e400` (which
  // `JSON.parse` yields as `Infinity`) both pass it while serde refuses them,
  // and an entry serde refuses fails the whole file. Infinity is the one with
  // teeth: it survives the read, then `JSON.stringify` writes it back as
  // `null` on the very next `writeRecent`, silently rewriting a timestamp
  // nobody asked it to touch. `Number.isInteger` is the same guard
  // `windowGeometry.ts` uses for its own integer-typed fields.
  if ("openedAt" in o && o.openedAt !== null && !Number.isInteger(o.openedAt)) {
    return false;
  }
  if ("missing" in o && typeof o.missing !== "boolean") {
    return false;
  }
  return true;
}

/** Applies the two fields' Rust-side `#[serde(default)]` — `openedAt` absent
 * reads as `null` (Rust's `None`), `missing` absent reads as `false`. Built
 * from named fields rather than spreading the parsed JSON: only the fields
 * this shape actually has ever reach the result, so a stray extra key in a
 * hand-edited or future-versioned file is dropped exactly as an unrecognized
 * field is for a serde struct with no `deny_unknown_fields`. */
function normalizeRecentRoom(o: RecentRoomJson): RecentRoom {
  return {
    name: o.name,
    path: o.path,
    openedAt: o.openedAt ?? null,
    missing: o.missing ?? false,
  };
}

/**
 * Ported from `read_recent` (recent.rs:12-18). A missing file, unreadable
 * file, invalid JSON, JSON that isn't an array, or an array with even one
 * malformed entry all read back as "no recent rooms" — never throws.
 */
export function readRecent(userDataDir: string): RecentRoom[] {
  let raw: string;
  try {
    raw = readFileSync(recentFilePath(userDataDir), "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed) || !parsed.every(isRecentRoomJson)) {
    return [];
  }
  return parsed.map(normalizeRecentRoom);
}

/**
 * Write `contents` to `filePath` readable by THIS user only (0600). Ported
 * from `write_private` (recent.rs:29-41) — the rooms themselves are
 * encrypted, but this list is not: at the default mode, every other account
 * on the Mac (and every backup) could read "Divorce papers" without touching
 * a single encrypted byte.
 *
 * The mode is set twice on purpose, exactly like the Rust source: the
 * `mode` option on `writeFileSync` only applies when Node CREATES the file,
 * so an unconditional `chmodSync` afterward is what forces a leftover file
 * from an older, more permissive build back down to 0600 too.
 *
 * DEVIATION: the Rust helper is `pub(crate)`, reused as-is by
 * `room_checkpoints.rs`. This migration's already-ported `db-host/
 * checkpoints.ts` independently re-implements the same open-then-chmod
 * pattern inline (its own `writeManifest`) rather than importing this
 * function — following that same established convention (duplicate the
 * small helper per module rather than share it across ports), this one is
 * exported for recentTools' own use and any future port that wants it, not
 * because anything imports it yet.
 */
export function writePrivate(filePath: string, contents: string): void {
  writeFileSync(filePath, contents, { mode: 0o600 });
  chmodSync(filePath, 0o600);
}

/**
 * Ported from `write_recent` (recent.rs:43-54). Temp-then-rename, like the
 * checkpoint manifest: overwriting `recent.json` in place would leave a
 * truncated, unparseable file behind if the app died or the disk filled
 * mid-write — and `readRecent` reads an unparseable file back as "no recent
 * rooms at all", silently. The temp file is written 0600 too, via
 * {@link writePrivate}, since a rename carries the mode with it.
 *
 * Creates `userDataDir` if it does not exist yet — see this module's header
 * for why that responsibility sits here rather than in
 * {@link recentFilePath}.
 */
export function writeRecent(userDataDir: string, list: readonly RecentRoom[]): void {
  try {
    mkdirSync(userDataDir, { recursive: true });
  } catch (err) {
    throw new Error(`Could not create the app data folder: ${errMsg(err)}`);
  }
  const json = JSON.stringify(list, null, 2);
  const target = recentFilePath(userDataDir);
  const tmp = `${target}.tmp`;
  try {
    writePrivate(tmp, json);
  } catch (err) {
    throw new Error(`Could not write the recent-rooms list: ${errMsg(err)}`);
  }
  try {
    renameSync(tmp, target);
  } catch (err) {
    throw new Error(`Could not save the recent-rooms list: ${errMsg(err)}`);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Push a room to the front of the recents: most-recent-first, deduped by
 * path, capped at {@link MAX_RECENT_ROOMS}. Ported from `merge_recent`
 * (recent.rs:58-63). Pure — returns a new array, leaves `list` untouched.
 */
export function mergeRecent(list: readonly RecentRoom[], entry: RecentRoom): RecentRoom[] {
  const deduped = list.filter((r) => r.path !== entry.path);
  deduped.unshift(entry);
  return deduped.slice(0, MAX_RECENT_ROOMS);
}

/**
 * Point every recents entry for `roomPath` at a new name. Ported from
 * `rename_recent` (recent.rs:70-75) — the recents list carries its own copy
 * of each room's name (it has to: it names rooms that are locked and cannot
 * be read), so a rename that only wrote the room's `meta` would leave the
 * start screen showing the old name until that room was next opened. A path
 * that isn't in the list is a no-op, not an insert — every other entry, and
 * every other field of a matching entry, is left alone.
 */
export function renameRecent(
  list: readonly RecentRoom[],
  roomPath: string,
  name: string
): RecentRoom[] {
  return list.map((r) => (r.path === roomPath ? { ...r, name } : r));
}

/**
 * Ported from `push_recent` (recent.rs:77-92) — record that `roomPath` was
 * just created or opened. `openedAt` is `Date.now()` (already Unix epoch
 * milliseconds, the same unit Rust computes by hand via
 * `SystemTime::now().duration_since(UNIX_EPOCH)...as_millis()`).
 *
 * Best-effort, exactly like Rust's `let _ = write_recent(&app, &list);`: a
 * recents-list write must never be able to fail creating or opening a room.
 */
export function pushRecent(userDataDir: string, name: string, roomPath: string): void {
  const entry: RecentRoom = { name, path: roomPath, openedAt: Date.now(), missing: false };
  const list = mergeRecent(readRecent(userDataDir), entry);
  try {
    writeRecent(userDataDir, list);
  } catch {
    // Best-effort — see doc comment above.
  }
}

/**
 * Whether something exists at `p`, treating ANY stat failure (missing,
 * permission denied, an unresponsive network mount that eventually errors)
 * as "not there" — the same as Rust's `Path::exists()`, which collapses every
 * `metadata()` error to `false` rather than surfacing it.
 *
 * Uses the promise-based `fs/promises` API rather than `existsSync`
 * deliberately: this is the one part of `recent.rs` Rust runs off its main
 * thread on purpose (`list_recent`'s own comment: a stat on a recents entry
 * that lives on an unresponsive network mount blocks for the mount's
 * timeout, freezing the start screen). Node's synchronous `fs` calls run on
 * the SAME single JS thread `ipcMain.handle` callbacks run on and would
 * reproduce exactly that freeze; the async `fs/promises` calls are serviced
 * off libuv's thread pool, which is this runtime's actual equivalent of
 * Rust's `spawn_blocking` — unlike the child-process `spawn_blocking` calls
 * elsewhere in this migration (e.g. `mcpClient.ts`'s `loginShellPath`), where
 * the port's own comment notes "Node has no blocking-pool distinction to
 * preserve": for file stats, it does.
 */
async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stat every entry so a moved/deleted/unplugged room says so. Ported from
 * `mark_missing` (recent.rs:96-100) — mutates each entry's `missing` field in
 * place, same as the Rust `&mut [RecentRoom]` signature. Entries are stat'd
 * concurrently (`Promise.all`): each entry's `missing` write is independent
 * of every other's, so there is nothing to serialize and no reason to make a
 * slow network mount in entry 1 hold up a fast, present entry 5.
 */
export async function markMissing(list: RecentRoom[]): Promise<void> {
  await Promise.all(
    list.map(async (entry) => {
      entry.missing = !(await pathExists(entry.path));
    })
  );
}

/**
 * Ported from the `list_recent` command (recent.rs:102-120). A room that was
 * moved, deleted, or lives on a drive that isn't plugged in used to look
 * exactly like a working one — you found out only after typing the
 * password. Stat each path as the list is handed over; see {@link
 * pathExists} for why this is `async` rather than a synchronous scan.
 */
export async function listRecent(userDataDir: string): Promise<RecentRoom[]> {
  const list = readRecent(userDataDir);
  await markMissing(list);
  return list;
}

/** Ported from the `remove_recent` command (recent.rs:122-127). */
export function removeRecent(userDataDir: string, roomPath: string): void {
  const list = readRecent(userDataDir).filter((r) => r.path !== roomPath);
  writeRecent(userDataDir, list);
}

/** Ported from the `clear_recent` command (recent.rs:129-132). */
export function clearRecent(userDataDir: string): void {
  writeRecent(userDataDir, []);
}

/**
 * Registers `list_recent`/`remove_recent`/`clear_recent` on `ipcMain`, under
 * the exact channel names `src/api.ts:318-320`'s `invoke(...)` calls already
 * use — same precedent as `recIpc.ts`'s `registerRecIpc` (channel names the
 * Rust `#[tauri::command]`s already had, so the renderer needs no rename)
 * and `dictStopTimeout.ts`'s `registerDictIpc` (a small, single-file module
 * registering its own handful of channels rather than splitting a
 * business-logic file from an IPC file, warranted for a subsystem this
 * small).
 *
 * `userDataDir` is a plain string, not a live accessor, unlike `recIpc.ts`'s
 * `RoomSource`: the app's userData directory is fixed for the process's
 * whole life, where "which room is open" genuinely changes as rooms are
 * opened, closed and switched. `ipcMain` is typed against the real
 * `electron` module without being imported at runtime, so this file resolves
 * and tests under plain Node/vitest exactly like its two precedents do.
 *
 * NOT wired into any bootstrap file — nothing here or elsewhere calls this
 * yet. Exists ready for Phase 2's preload/ipcMain registry, per this
 * migration's standing rule that `ipcMain.handle` never lands in a live
 * bootstrap file from a batch like this one.
 */
export function registerRecentIpc(ipcMain: Pick<IpcMain, "handle">, userDataDir: string): void {
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R): void => {
    ipcMain.handle(channel, (_event: IpcMainInvokeEvent, ...args: A) => fn(...args));
  };

  handle("list_recent", () => listRecent(userDataDir));
  handle("remove_recent", (args: { path: string }) => removeRecent(userDataDir, args.path));
  handle("clear_recent", () => clearRecent(userDataDir));
}
