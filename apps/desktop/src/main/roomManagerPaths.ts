/** Cohesive extraction from roomManager.ts; the facade preserves its public API. */
/**
 * Room lifecycle: create, open (password AND recovery-code), lock/close,
 * rename, `room_info`, and the rollback-in-flight guard that keeps a
 * checkpoint swap and a room-lifecycle command from racing each other.
 *
 * Ported from `src-tauri/src/commands/rooms.rs` (958 lines, read in full,
 * including its `#[cfg(test)] mod tests`), plus the four `commands.rs`
 * helpers it depends on and nothing else calls yet — `room_name_from_path`,
 * `info_of`, `is_synced_path` (+ `SYNCED_HOME_FOLDERS`/`in_home_sync_folder`),
 * `humanize_storage_error` (the rewrite `AppState::with_room` applies to every
 * failure that comes back through it) and `apply_ollama_override`.
 *
 * TOOL ROUTER CHECK: grepping `commands/agent.rs`'s `exec_tool` match arms and
 * `exec_tool.rs` for every command name in `rooms.rs` (`create_room`,
 * `open_room`, `close_room`, `room_info`, `rename_room`, `touchid_*`,
 * `write_recovery_key`, `has_recovery_key`, `open_room_with_recovery`,
 * `take_pending_open`, `take_rec_recovery_error`) finds NONE of them. This is
 * app-level UI lifecycle, dispatched only from the renderer's own room
 * screens, never from the model's tool router — so nothing here is wired into
 * `execTool.ts`.
 *
 * ============================================================================
 * WHAT THIS MODULE OWNS
 * ============================================================================
 * No ported `AppState` exists yet in this migration, so {@link
 * RoomManagerState} holds the slice that is genuinely room-lifecycle's own:
 * the open `Room` handle, the rollback flag, the room epoch, the parked
 * recording-recovery message, the persistent room-server slot, and the three
 * per-call consent registries (`mcp_session_ok`/`mcp_pending`/`edit_pending`)
 * nothing else in this migration has claimed. Two registries are REUSED
 * rather than re-declared, because another module already owns their shape:
 * `cancel.ts`'s `CancelState` (`state.cancel`) and `scriptConsent.ts`'s
 * `PendingScriptResolver` (`state.scriptPending`).
 *
 * {@link toRoomSource} / {@link toRoomPinSource} adapt this state to the two
 * seams `jobs.ts`/`jobQueue.ts`/`jobScheduler.ts`/`privacy.ts` and
 * `roomPin.ts` already take, so a future integration pins against the SAME
 * notion of "which room, which open" this file updates.
 *
 * ============================================================================
 * WHAT IS REAL HERE (checked line by line against the Rust source)
 * ============================================================================
 *   - create / open / open-with-recovery / rename / room_info / close, over
 *     REAL `.roomai` files via `db-host/open.ts`, including gluing `migrate()`
 *     into the open path where Rust's `db::open_room` calls it internally
 *     (`db-host/open.ts`'s own doc flags that as a follow-up integration step;
 *     this is that step).
 *   - The Wave 3 (Idea 9) rollback guard, refusing with `turnContext.ts`'s
 *     exact `ROLLBACK_BUSY` string at every entry point Rust guards: create,
 *     open (the guarded wrapper only — {@link openRoomImpl} is the unguarded
 *     body a future rollback path reopens through), rename, close.
 *   - The full drain-then-teardown, over `cancel.ts`'s real `CancelState` /
 *     `cancelAll` and `jobs.ts`'s real `markJobsParking` / `parkRunningJobs` /
 *     `quiesceStaleJobs` / `PARKED_BY_LOCK`.
 *   - The recording-recovery park-then-conditionally-emit ritual, over
 *     `db-host/recordings.ts`'s real `recoverRecChunks`.
 *   - `write_recovery_key` / `has_recovery_key` / `open_room_with_recovery`
 *     over `db-host/recovery.ts`.
 *   - `pending_mcp_for` (SEC-1), composed entirely from what `mcpConfig.ts`
 *     already ports for real (`mcpGate` / `readMcpApprovals` /
 *     `renderCommandLine`) — so `RoomInfo.pendingMcp` is a real answer, not a
 *     placeholder `null`.
 *   - The recents list: `recentTools.ts` ALREADY ports `commands/recent.rs` in
 *     full (`readRecent`/`writeRecent`/`mergeRecent`/`renameRecent`/
 *     `pushRecent`, 0600 + temp-then-rename). `rooms.rs` calls those as free
 *     functions, so this file imports them rather than keeping a second,
 *     divergent copy.
 *   - `take_pending_open` is already fully ported in `pendingOpen.ts`;
 *     {@link takePendingOpen} is a one-line delegate to that process-global
 *     slot, not a second one.
 *   - ADD-11 (Touch ID). `keychain.ts` already ports `src-tauri/src/
 *     biometrics.rs`'s `has`/`store`/`read`/`delete` in full over real
 *     Security.framework FFI; {@link touchIdHas}/{@link touchIdEnable}/
 *     {@link touchIdDisable}/{@link touchIdOpen} are the four `rooms.rs`
 *     command bodies wired onto it — `with_room`'s "No room is open." guard
 *     plus `humanize_storage_error` for `touchid_enable` (the only one of the
 *     four Rust routes through `state.with_room`), a direct pass-through for
 *     `touchid_has`/`touchid_disable` (never gated on a room being open, in
 *     Rust either), and `touchid_open` reusing the ALREADY-guarded
 *     {@link openRoom} exactly as `touchid_open`'s Rust body does. See
 *     {@link RoomManagerDeps.keychain} for how the Keychain calls themselves
 *     are injected.
 *
 * ============================================================================
 * STUBBED PER RULE 3 — an honest NOT_IMPLEMENTED refusal, never a fabricated
 * result
 * ============================================================================
 *   - {@link spawnRoomServerIfEnabledNotImplemented} — D9/Wave-1a "the Leash",
 *     restarting the room's persistent MCP server on unlock. Confirmed
 *     unported: `room_mcp.rs` (3096 lines) plus `commands/moonshot/server.rs`'s
 *     `leash_scope`/`leash_identity`/`store_bridge_if_current`/`web_lanes` and
 *     `discovery.rs`'s writers; `mcpBridge.ts`'s own module doc lists the
 *     `Bridge`/`start` lifecycle as explicitly out of scope. This one LOGS
 *     rather than throwing, because Rust's own call site is a fire-and-forget
 *     `tauri::async_runtime::spawn` — a failure there has never been allowed to
 *     fail an unlock, and making it fail one here would be a new behavior, not
 *     a faithful one. It is a REQUIRED dep field (the shape
 *     `jobScheduler.ts`'s `SchedulerDeps.startWorkflowRun` established) so no
 *     caller can acquire it by accident.
 *
 * ============================================================================
 * INJECTED DEPENDENCIES — and the difference between the two kinds
 * ============================================================================
 * {@link RoomManagerDeps} bundles every side-effecting call `rooms.rs` makes
 * into another subsystem. They fall into two buckets, logged DIFFERENTLY on
 * purpose so a reader of the console can tell a missing port from a missing
 * wire:
 *
 *  1. REAL ported subsystems this batch does not wire into a live bootstrap
 *     (rule 4) — `mcp` (`mcpClient.ts`'s real `McpManager`), `closeBrowser`
 *     (`browser/browser.ts`'s real `close()`), `jobQueue` (`pumpOnOpen`),
 *     `scheduler` (`spawnWorkflowScheduler`), `policy` / `privacyScan`
 *     (`refreshPolicy` / `schedulePrivacyScan`). Supplying one runs the REAL
 *     ported logic; omitting one logs `SKIPPED`, because the code exists and
 *     only needs a caller to hand it over.
 *  2. GENUINELY UNPORTED Rust subsystems — `refresh_mcp`'s live connection
 *     manager, `spawn_reextract_backfill`/`spawn_legacy_text_repair`/
 *     `spawn_embedding_backfill`, `ollama_lifecycle::note_room_closed` (see
 *     `ollamaLifecycle.ts`'s own doc: process management is not ported),
 *     `sidecar::forget_room_memory` (no process-lifecycle half of `sidecar.ts`
 *     exists), `remove_discovery`, and the six caches `teardown_open_room`
 *     clears that have no Electron home yet (`MediaStreams`/`PeakCache`/
 *     `SlideCache`/`HtmlPreviews`/the browser-preview sweep/`AgentUi`). These
 *     log `NOT_IMPLEMENTED` — never a fabricated success.
 *
 * `clearPolicy` is neither: `privacy.ts` exports the real module-global
 * `clearPolicy()`, exactly as Rust's is, so it is called directly.
 *
 * A THIRD, narrower kind lives only on {@link RoomManagerDeps.keychain}: a
 * REAL ported subsystem (`keychain.ts`, ADD-11) that IS wired by default —
 * unlike bucket 1, omitting it does not skip real logic, it runs the real
 * `keychain.ts` functions. The field exists purely as a test seam, the same
 * "real unless overridden" shape as `chatCommandsKnowledge.ts`'s
 * `CmdCtx.generate` (`ctx.generate ?? generateReal`): `keychain.ts`'s own
 * header comment explains why its `store`/`read`/`deleteEntry` cannot be
 * exercised for real against the data-protection keychain from this dev
 * sandbox (`errSecMissingEntitlement` / -34018 — no Team ID to derive a
 * keychain access group from), so the Touch ID wiring tests inject a fake
 * `keychain` to verify roomManager.ts's own logic (which call, with which
 * arguments, which errors propagate vs. get humanized) independent of that
 * sandbox limitation.
 *
 * ============================================================================
 * DELIBERATE DEVIATIONS FROM THE RUST SOURCE
 * ============================================================================
 *  1. THE ROOM'S CONNECTION IS CLOSED EXPLICITLY. Rust's
 *     `*state.room_guard() = None;` DROPS the `Room`, which drops its
 *     `rusqlite::Connection` and closes the encrypted file. JavaScript has no
 *     destructor: assigning `state.room = null` would leave the `.roomai`
 *     open, its SQLCipher key resident, and its `-wal`/`-shm` siblings on
 *     disk, for the rest of the process — the exact opposite of what locking a
 *     room promises. {@link teardownOpenRoom} therefore calls `conn.close()`
 *     at precisely the point Rust's drop happens (after the job park, after
 *     `note_room_closed`, before the epoch bump), and the create/open paths
 *     close a half-built handle on any failure between opening it and
 *     installing it, which is what Rust's `?` does for free.
 *  2. PENDING APPROVALS ARE DECLINED, NOT JUST DROPPED. Rust's
 *     `mcp_pending`/`edit_pending`/`script_pending` teardown is a plain
 *     `.clear()` because dropping a `oneshot::Sender` makes its awaiter
 *     resolve to an error, which every awaiter reads as a decline. A JS
 *     callback left in a `Map` never fires on its own, so each pending
 *     resolver is invoked with an explicit decline BEFORE the map is cleared,
 *     to reach the same observable outcome.
 *  3. `writeRecoveryKey`/`openRoomWithRecovery` are `async` where their Rust
 *     `#[tauri::command]` counterparts are synchronous, because
 *     `db-host/recovery.ts` is built on `fs/promises`. Those are the only two
 *     commands here that are async for a REAL reason — they genuinely await.
 *     The four `touchId*` arms are also `async` against synchronous Rust
 *     `pub fn`s, but only to keep the `Promise`-returning signatures the IPC
 *     shim and the renderer contract already had: every `keychain.ts` call
 *     they make is synchronous and none of them ever awaits, so each one still
 *     runs start-to-finish on the main thread in one turn — which is what Rust
 *     does too (a non-`async` `#[tauri::command]` runs on the main thread,
 *     unlike the `pub async fn` ones such as `close_room`). In particular the
 *     Touch ID prompt inside `touchIdOpen`'s `read` blocks the main process
 *     exactly as `touchid_open`'s does.
 *  4. {@link reportRecRecoveryFailure}'s delay is a parameter (defaulting to
 *     Rust's fixed 2 s) and {@link shouldEmitRecRecovery} is split out, so both
 *     guards on the delayed emit can be exercised without a test waiting two
 *     real seconds. The timer is `unref`'d: a pending 2 s timer must not hold
 *     the process (or a test runner) open.
 */
import type Database from "better-sqlite3-multiple-ciphers";
import { existsSync } from "node:fs";
import path from "node:path";
import type { McpApproval, RoomInfo } from "../shared/apiTypes.js";
import { roomCounts } from "./db-host/messages.js";
import { getSetting } from "./db-host/settings.js";
import { setBaseUrlOverride } from "./engineRouting.js";
import { deleteEntry as keychainDeleteEntry, has as keychainHas, read as keychainRead, store as keychainStore } from "./keychain.js";
import { MCP_CONFIG_KEY, mcpGate, readMcpApprovals, renderCommandLine } from "./mcpConfig.js";
import { readRecent } from "./recentTools.js";
import { describeRoom } from "./workspace/roomLayout.js";
import type { RoomDescriptor } from "./workspace/types.js";
import { requireRoom, type Room, type RoomManagerDeps, type RoomManagerState } from "./roomManagerState.js";
import { openRoom } from "./roomManagerOpen.js";


// ============================================================================
// Touch ID — the real Keychain backend (ADD-11, keychain.ts)
// ============================================================================
//
// `keychain.ts` already ports biometrics.rs's `has`/`store`/`read`/`delete`
// in full over real Security.framework FFI (see that file's own header
// comment for the FFI details and for exactly what is/isn't verifiable in
// this dev sandbox). The four functions below are the `rooms.rs` command
// BODIES — `state.with_room` guard, `humanize_storage_error`, which of the
// four route through the open room vs. take a bare path — wired onto it.
// {@link RoomManagerDeps.keychain} is the test seam: real `keychain.ts` calls
// unless a test overrides them, never a fabricated result.

/** True if a biometric Keychain entry exists for this room path — never
 * prompts, matching `keychain.ts`'s `has()` (itself ported from
 * biometrics.rs's `has`, which never returns an `Err`). Ported from
 * `touchid_has`, which is NOT gated on a room being open. */
export async function touchIdHas(path: string, deps: RoomManagerDeps): Promise<boolean> {
  const has = deps.keychain?.has ?? keychainHas;
  return has(path);
}


/** Store the CURRENTLY-OPEN room's password in the Keychain, guarded by
 * biometrics. Ported from `touchid_enable` — the one Touch ID command that
 * DOES route through `state.with_room`, so "no room open" is exactly {@link
 * NO_ROOM_OPEN} and a storage-shaped failure gets {@link
 * humanizeStorageError}'s rewrite, same as every other `with_room` command. */
export async function touchIdEnable(
  state: RoomManagerState,
  deps: RoomManagerDeps
): Promise<void> {
  const room = requireRoom(state);
  const store = deps.keychain?.store ?? keychainStore;
  try {
    store(room.path, room.password);
  } catch (err) {
    throw humanizeStorageError(err, room.path);
  }
}


/** Turn Touch ID off for a room: delete its Keychain entry (idempotent, in
 * `keychain.ts` as in Rust). Ported from `touchid_disable`, which — unlike
 * `touchid_enable` — does NOT go through `state.with_room`: it takes a room
 * PATH rather than the open room, and works whether or not that room is open
 * (or exists). */
export async function touchIdDisable(path: string, deps: RoomManagerDeps): Promise<void> {
  const deleteEntry = deps.keychain?.deleteEntry ?? keychainDeleteEntry;
  deleteEntry(path);
}


/** Fingerprint-unlock: trigger the system biometric prompt to read the stored
 * password, then take the normal `open_room` path — reusing the
 * ALREADY-guarded {@link openRoom} (rollback refusal included), exactly as
 * `touchid_open`'s Rust body calls the `open_room` COMMAND, not the unguarded
 * `open_room_impl`. A read failure (cancel, no match, no entry, Keychain
 * unavailable) propagates as-is: `touchid_open` does not route through
 * `with_room` either, so there is no humanization to apply here. */
export async function touchIdOpen(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  path: string
): Promise<RoomInfo> {
  const read = deps.keychain?.read ?? keychainRead;
  const password = read(path);
  return openRoom(state, deps, path, password);
}


// ============================================================================
// D9 (the Leash) — room_mcp.rs is NOT ported (rule 3)
// ============================================================================

export const ROOM_SERVER_NOT_IMPLEMENTED =
  "NOT_IMPLEMENTED: spawn_room_server_if_enabled — the Leash's persistent MCP " +
  "server (src-tauri/src/room_mcp.rs, 3096 lines) and its start/stop wiring " +
  "(src-tauri/src/commands/moonshot/server.rs's leash_scope/leash_identity/" +
  "web_lanes/store_bridge_if_current, plus discovery.rs's writers) have no " +
  "Electron port yet — mcpBridge.ts's own module doc lists the Bridge/start/" +
  "prepare_advisor_runtime lifecycle as explicitly out of scope until a real " +
  "room/DB layer exists to wire it to. Restarting the room server on unlock " +
  "is a no-op for now.";


/** The ready-made default for {@link RoomManagerDeps.spawnRoomServerIfEnabled}.
 * Logs rather than throwing: Rust's own call site is a fire-and-forget spawn
 * whose failure has never been allowed to fail an unlock. */
export const spawnRoomServerIfEnabledNotImplemented = (_room: Room): void => {
  console.error(ROOM_SERVER_NOT_IMPLEMENTED);
};


// ============================================================================
// Small pure helpers — commands.rs
// ============================================================================

/**
 * Ported from `commands.rs::room_name_from_path` (`Path::file_stem()`, with
 * `"Room"` for anything that has none).
 *
 * The three cases worth spelling out, because they are the ones a naive
 * "strip after the last dot" gets wrong: `Path::file_name()` returns `None`
 * for `""`, `"/"`, `"."` and `".."`, so every one of those is `"Room"`, NOT
 * `"."`; a leading dot with no other dot (`.gitignore`) is a whole stem, not
 * an extension; and only the FINAL dot splits (`foo.tar.gz` → `foo.tar`).
 * `node:path`'s `basename`/`parse().name` agree with `file_stem` on the rest.
 */
export function roomNameFromPath(filePath: string): string {
  const base = path.basename(filePath);
  if (base === "" || base === "." || base === "..") {
    return "Room";
  }
  const stem = path.parse(filePath).name;
  return stem === "" ? "Room" : stem;
}


/** Longest room name we will store — `rooms.rs::MAX_ROOM_NAME_CHARS`. Long
 * enough for any sentence someone would call a room, short enough that the top
 * bar and the recents list stay readable. */
export const MAX_ROOM_NAME_CHARS = 120;


/** Folders directly under the home directory that a sync client creates by
 * default. Ported verbatim from `commands.rs::SYNCED_HOME_FOLDERS`. */
export const SYNCED_HOME_FOLDERS: readonly string[] = [
  "Dropbox",
  "Google Drive",
  "OneDrive",
  "Box",
  "Box Sync",
  "Sync", // Syncthing's default folder, and Sync.com
  "Resilio Sync",
  "BTSync",
  "pCloud Drive",
  "pCloudDrive",
  "Nextcloud",
  "ownCloud",
  "Seafile",
  "MEGA",
  "MEGAsync",
  "Tresorit",
  "Yandex.Disk",
  "Creative Cloud Files",
];


/** Ported from `commands.rs::in_home_sync_folder`. The trailing separator
 * matters: `Dropboxes/room` is not in Dropbox. The ` (…)` branch is Dropbox
 * Business and second linked accounts (`Dropbox (Work)`), whose exact-name
 * test would otherwise leave every one of those rooms unwarned. */
function inHomeSyncFolder(rest: string, folder: string): boolean {
  if (!rest.startsWith(folder)) {
    return false;
  }
  const tail = rest.slice(folder.length);
  return tail.startsWith("/") || (tail.startsWith(" (") && tail.includes(")/"));
}


/** Ported from `commands.rs::is_synced_path` (HLT-6): databases and file sync
 * are a dangerous mix, so the UI warns once. */
export function isSyncedPath(filePath: string): boolean {
  if (
    filePath.includes("Library/Mobile Documents") ||
    filePath.includes("Library/CloudStorage/")
  ) {
    return true;
  }
  const home = process.env.HOME;
  if (home !== undefined) {
    const trimmedHome = home.replace(/\/+$/, "");
    if (trimmedHome !== "" && filePath.startsWith(`${trimmedHome}/`)) {
      const rest = filePath.slice(trimmedHome.length + 1);
      return SYNCED_HOME_FOLDERS.some((folder) => inHomeSyncFolder(rest, folder));
    }
  }
  return false;
}


const STORAGE_ERROR_MARKERS = [
  "disk i/o error",
  "database or disk is full",
  "readonly database",
  "unable to open database",
  "no space left",
  // The closing paren is what makes the number a WHOLE number: matching a
  // bare "os error 2" also swallowed 20-29, so "Too many open files (os
  // error 24)" would have been reported as a disconnected drive.
  "os error 28)", // ENOSPC
  "os error 2)", // ENOENT — the volume went away
];


function storageErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}


function storageFailure(lowerMessage: string): boolean {
  return STORAGE_ERROR_MARKERS.some((marker) => lowerMessage.includes(marker));
}


function diskFullFailure(lowerMessage: string): boolean {
  return ["full", "no space left", "os error 28"].some((marker) => lowerMessage.includes(marker));
}


function unchangedError(err: unknown, message: string): Error {
  return err instanceof Error ? err : new Error(message);
}


/**
 * Say what a storage failure MEANS, in words that name a remedy. Ported from
 * `commands.rs::humanize_storage_error`, which `AppState::with_room` applies
 * to everything that comes back through it — in this file, that is exactly
 * {@link writeRecoveryKey} (`rename_room`/`room_info` take the room guard
 * directly in Rust and are NOT humanized, so they are not humanized here).
 *
 * EVIDENCE, NOT GUESSWORK: the "your drive is gone" wording is used only after
 * checking that the room file really has stopped existing, and anything this
 * cannot recognize is passed through completely unchanged — a confident wrong
 * diagnosis is worse than jargon. The original message is kept in brackets
 * either way; it is what a bug report needs. The room's PATH is deliberately
 * not quoted: an error string can end up as a tool result, and a room's file
 * name is room content.
 */
export function humanizeStorageError(err: unknown, roomPath: string): Error {
  const raw = storageErrorMessage(err);
  const lower = raw.toLowerCase();
  if (!storageFailure(lower)) {
    return unchangedError(err, raw);
  }
  if (!existsSync(roomPath)) {
    return new Error(
      "This room's file can't be reached any more — the drive or folder holding it has " +
        `gone away. Reconnect it and try again; nothing else was changed. [${raw}]`
    );
  }
  if (diskFullFailure(lower)) {
    return new Error(
      "The disk holding this room is full, so nothing could be saved. Free some space " +
        `and try again. [${raw}]`
    );
  }
  return new Error(
    "This room's file couldn't be read or written just now — the drive holding it may be " +
      `disconnected, full, or read-only. [${raw}]`
  );
}


/** D10 (the Closet): point Ollama at this room's saved remote base URL, or
 * clear any override when the room has none — so switching rooms never carries
 * the previous room's endpoint over. Ported from
 * `commands.rs::apply_ollama_override`, wired to `engineRouting.ts`'s real
 * `setBaseUrlOverride`. */
export function applyOllamaOverride(db: Database.Database): void {
  const url = (getSetting(db, "remote_ollama_url") ?? "").trim();
  setBaseUrlOverride(url === "" ? null : url);
}


/**
 * SEC-1: if the open room's config has ENABLED servers whose fingerprint isn't
 * approved on this Mac, describe them for the approval dialog. `null`
 * otherwise. Ported from `mcp_cmds.rs::pending_mcp_for`, composed entirely
 * from what `mcpConfig.ts` already ports for real.
 *
 * Reads the setting DIRECTLY (`getSetting`, `null` when unset) rather than
 * through `mcpConfig.ts`'s `getMcpConfig` (which falls back to
 * `DEFAULT_MCP_CONFIG`): Rust's `db::get_setting(..)?` returns early on an
 * unset config, and the fallback would otherwise mask the never-saved case.
 */
export function pendingMcpFor(db: Database.Database, userDataDir: string): McpApproval | null {
  const config = getSetting(db, MCP_CONFIG_KEY);
  if (config === null) {
    return null;
  }
  const approved = new Set(readMcpApprovals(userDataDir));
  const gate = mcpGate(config, approved);
  if (gate.kind !== "needsApproval") {
    return null;
  }
  return {
    fingerprint: gate.fingerprint,
    servers: gate.servers.map(([name, cfg]) => ({ name, command: renderCommandLine(cfg) })),
  };
}


/** Ported from `commands.rs::info_of`. */
export function infoOf(room: Room, userDataDir: string): RoomInfo {
  const [fileCount, messageCount] = roomCounts(room.conn);
  return {
    name: room.name,
    path: room.path,
    fileCount,
    messageCount,
    synced: isSyncedPath(room.path),
    pendingMcp: pendingMcpFor(room.conn, userDataDir),
    ...(room.readOnly === true ? { readOnly: true } : {}),
    ...(room.duplicateRoomIdentity === true ? { duplicateRoomIdentity: true } : {}),
  };
}


export function copiedWorkspaceIdentityPath(
  descriptor: RoomDescriptor & { kind: "workspace-folder"; rootPath: string },
  userDataDir: string,
): string | null {
  for (const recent of readRecent(userDataDir)) {
    if (path.resolve(recent.path) === path.resolve(descriptor.rootPath)) continue;
    try {
      const other = describeRoom(recent.path);
      if (other.kind === "workspace-folder" && other.roomId === descriptor.roomId) return recent.path;
    } catch {
      // Missing and stale recent entries are not identity evidence.
    }
  }
  return null;
}
