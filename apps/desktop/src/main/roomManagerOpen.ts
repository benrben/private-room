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
import type { RoomInfo } from "../shared/apiTypes.js";
import { getMeta } from "./db-host/meta.js";
import { recoverRecChunks, recoverRecChunksHybrid } from "./db-host/recordings.js";
import { recoverPassword } from "./db-host/recovery.js";
import { quiesceStaleJobs } from "./jobs.js";
import { refreshPolicy, schedulePrivacyScan } from "./privacy.js";
import { pushRecent } from "./recentTools.js";
import { ROLLBACK_BUSY } from "./turnContext.js";
import { acquireWorkspaceLease, describeRoom, openWorkspaceRoom, registerWorkspaceCopyIdentity, releaseWorkspaceLease, WorkspaceLeaseConflictError, type WorkspaceLease } from "./workspace/roomLayout.js";
import type { RoomDescriptor, RoomKind } from "./workspace/types.js";
import { closeQuietly, logSkipped, requireRoom, type Room, type RoomManagerDeps, type RoomManagerState } from "./roomManagerState.js";
import { applyOllamaOverride, copiedWorkspaceIdentityPath, infoOf, roomNameFromPath } from "./roomManagerPaths.js";
import { attachStorageRuntime, createRoomConnection, installCreatedRoom, openRoomFile, runCreateOpenSpawns, startWorkspaceRuntime } from "./roomManagerWorkspace.js";
import { teardownOpenRoom } from "./roomManagerTeardown.js";
import { reportRecRecoveryFailure } from "./roomManagerRecovery.js";


/**
 * Ported from `create_room`. Creates the room file for real (`db-host/open.ts`
 * — 8-character password floor, schema.sql, `user_version` born current),
 * tears down whatever room was already open FIRST (its MCP bridge and bearer
 * token would otherwise survive and serve tools that now resolve against the
 * NEW room), then installs the new one.
 */
export function createRoom(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  roomPath: string,
  password: string,
  name?: string | null,
  format: RoomKind = "sealed-db",
): RoomInfo {
  // Wave 3 (Idea 9): don't create/switch rooms while a rollback is swapping.
  if (state.rollingBack) {
    throw new Error(ROLLBACK_BUSY);
  }
  // The name the user TYPED on the Create screen, when they typed one. It used
  // to be a filename suggestion and nothing else, so typing "Journal" and
  // saving as "stuff" left the room called "stuff" everywhere.
  const trimmed = name?.trim();
  const resolvedName =
    trimmed !== undefined && trimmed !== "" ? trimmed : roomNameFromPath(roomPath);

  const created = createRoomConnection(roomPath, password, resolvedName, format);

  if (state.room !== null) {
    teardownOpenRoom(state, deps);
  }

  return installCreatedRoom(state, deps, created, resolvedName, password);
}


/**
 * The body of `open_room`, without the rollback-in-flight guard, so a future
 * `rollback_room_checkpoint` port can reopen the swapped file while its own
 * flag is still set. Every other caller goes through the guarded
 * {@link openRoom}. Ported from `open_room_impl`.
 */
type WorkspaceRoomDescriptor = RoomDescriptor & {
  kind: "workspace-folder";
  rootPath: string;
};


interface WorkspaceOpenDecision {
  readOnly: boolean;
  lease?: WorkspaceLease;
}


interface OpenedRoomConnection {
  descriptor: RoomDescriptor;
  conn: Database.Database;
  lease?: WorkspaceLease;
  readOnly: boolean;
  duplicateRoomIdentity: boolean;
}


function isWorkspaceRoomDescriptor(descriptor: RoomDescriptor): descriptor is WorkspaceRoomDescriptor {
  return descriptor.kind === "workspace-folder" && descriptor.rootPath !== null;
}


function duplicateWorkspaceIdentity(
  descriptor: WorkspaceRoomDescriptor,
  userDataDir: string,
): boolean {
  return copiedWorkspaceIdentityPath(descriptor, userDataDir) !== null;
}


function decideWorkspaceOpen(
  descriptor: WorkspaceRoomDescriptor,
  userDataDir: string,
): WorkspaceOpenDecision {
  if (duplicateWorkspaceIdentity(descriptor, userDataDir)) {
    return { readOnly: true };
  }
  try {
    return { readOnly: false, lease: acquireWorkspaceLease(descriptor.rootPath) };
  } catch (error) {
    if (!(error instanceof WorkspaceLeaseConflictError)) throw error;
    return { readOnly: true };
  }
}


function releaseWorkspaceLeaseAfterFailedOpen(lease: WorkspaceLease | undefined): void {
  if (lease !== undefined) releaseWorkspaceLease(lease);
}


function openWorkspaceConnection(
  descriptor: WorkspaceRoomDescriptor,
  password: string,
  userDataDir: string,
): OpenedRoomConnection {
  const decision = decideWorkspaceOpen(descriptor, userDataDir);
  try {
    return {
      descriptor,
      conn: openWorkspaceRoom(descriptor.rootPath, password, decision.readOnly).db,
      lease: decision.lease,
      readOnly: decision.readOnly,
      duplicateRoomIdentity: duplicateWorkspaceIdentity(descriptor, userDataDir),
    };
  } catch (error) {
    releaseWorkspaceLeaseAfterFailedOpen(decision.lease);
    throw error;
  }
}


function openRoomConnection(
  descriptor: RoomDescriptor,
  password: string,
  userDataDir: string,
): OpenedRoomConnection {
  if (isWorkspaceRoomDescriptor(descriptor)) {
    return openWorkspaceConnection(descriptor, password, userDataDir);
  }
  return {
    descriptor,
    conn: openRoomFile(descriptor.dbPath, password),
    readOnly: false,
    duplicateRoomIdentity: false,
  };
}


function closeOpeningRoom(conn: Database.Database, lease: WorkspaceLease | undefined): void {
  closeQuietly(conn);
  releaseWorkspaceLeaseAfterFailedOpen(lease);
}


function roomNameAfterOpen(
  descriptor: RoomDescriptor,
  conn: Database.Database,
  roomPath: string,
): string {
  if (descriptor.kind === "workspace-folder") return roomNameFromPath(descriptor.path);
  return getMeta(conn, "name") ?? roomNameFromPath(roomPath);
}


function buildOpenedRoom(opened: OpenedRoomConnection, password: string, name: string): Room {
  return {
    conn: opened.conn,
    path: opened.descriptor.path,
    name,
    password,
    readOnly: opened.readOnly,
    duplicateRoomIdentity: opened.duplicateRoomIdentity,
  };
}


function openedRoomInfo(room: Room, userDataDir: string, lease: WorkspaceLease | undefined): RoomInfo {
  try {
    return infoOf(room, userDataDir);
  } catch (error) {
    closeOpeningRoom(room.conn, lease);
    throw error;
  }
}


function installOpenedRoom(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  room: Room,
): void {
  pushRecent(deps.userDataDir, room.name, room.path);
  state.room = room;
  if (room.readOnly === true) return;
  startWorkspaceRuntime(state, room, deps);
  quiesceStaleJobs(room.conn);
}


function logRecoveredRecording(count: number): void {
  if (count > 0) console.error(`recovered ${count} interrupted recording(s)`);
}


function logRecoveredRecordingIfCurrent(state: RoomManagerState, room: Room, count: number): void {
  if (count > 0 && state.room === room) logRecoveredRecording(count);
}


function reportWorkspaceRecoveryFailureIfCurrent(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  room: Room,
  error: unknown,
): void {
  if (state.room !== room) return;
  reportRecRecoveryFailure(
    state,
    deps,
    room.path,
    error instanceof Error ? error.message : String(error),
  );
}


function startWorkspaceRecordingRecovery(state: RoomManagerState, deps: RoomManagerDeps, room: Room): void {
  const workspace = room.workspace;
  if (workspace === undefined) return;
  void recoverRecChunksHybrid(room.conn, workspace)
    .then((recovered) => logRecoveredRecordingIfCurrent(state, room, recovered))
    .catch((error: unknown) => reportWorkspaceRecoveryFailureIfCurrent(state, deps, room, error));
}


function recoverOpenedRecording(state: RoomManagerState, deps: RoomManagerDeps, room: Room): void {
  if (room.readOnly === true) return;
  if (room.workspace !== undefined) {
    startWorkspaceRecordingRecovery(state, deps, room);
    return;
  }
  logRecoveredRecording(recoverRecChunks(room.conn));
}


function recoverRecordingAfterOpen(state: RoomManagerState, deps: RoomManagerDeps, room: Room): void {
  try {
    recoverOpenedRecording(state, deps, room);
  } catch (error) {
    reportWorkspaceRecoveryFailureIfCurrent(state, deps, room, error);
  }
}


function refreshOpenedRoomPrivacy(deps: RoomManagerDeps, readOnly: boolean): void {
  if (!readOnly && deps.policy !== undefined) {
    refreshPolicy(deps.policy);
  } else {
    logSkipped("refresh_policy", "no PolicyDeps supplied (privacy.ts's refreshPolicy is real)");
  }
  if (!readOnly && deps.privacyScan !== undefined) {
    schedulePrivacyScan(deps.privacyScan);
  } else {
    logSkipped(
      "schedule_privacy_scan",
      "no PrivacyScanDeps supplied (privacy.ts's schedulePrivacyScan is real)",
    );
  }
}


function finishRoomOpen(deps: RoomManagerDeps, room: Room): void {
  if (room.readOnly !== true) runCreateOpenSpawns(deps, room);
  refreshOpenedRoomPrivacy(deps, room.readOnly === true);
}


export function openRoomImpl(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  roomPath: string,
  password: string
): RoomInfo {
  const opened = openRoomConnection(describeRoom(roomPath), password, deps.userDataDir);
  // Opening a room while another is open (a Finder double-click on a second
  // .roomai) must fully tear the old one down first. Runs only AFTER the
  // password proved right, so a failed unlock never locks the room the user
  // is in.
  if (state.room !== null) {
    teardownOpenRoom(state, deps);
  }
  const name = roomNameAfterOpen(opened.descriptor, opened.conn, roomPath);
  // D10 (the Closet): re-apply this room's saved remote-Ollama URL on unlock.
  applyOllamaOverride(opened.conn);
  const room = buildOpenedRoom(opened, password, name);
  attachStorageRuntime(room, opened.descriptor, opened.lease);
  const info = openedRoomInfo(room, deps.userDataDir, opened.lease);
  installOpenedRoom(state, deps, room);
  recoverRecordingAfterOpen(state, deps, room);
  finishRoomOpen(deps, room);
  return info;
}


function unregisteredWorkspaceCopy(state: RoomManagerState): { room: Room; rootPath: string } {
  const room = requireRoom(state);
  const descriptor = room.descriptor;
  if (room.duplicateRoomIdentity !== true || descriptor?.kind !== "workspace-folder" || descriptor.rootPath === null) {
    throw new Error("The open room is not an unregistered workspace copy.");
  }
  return { room, rootPath: descriptor.rootPath };
}


function restoreUnregisteredWorkspaceCopy(
  state: RoomManagerState,
  room: Room,
  rootPath: string,
): void {
  try {
    const reopened = openWorkspaceRoom(rootPath, room.password, true);
    room.conn = reopened.db;
    room.readOnly = true;
    room.duplicateRoomIdentity = true;
    attachStorageRuntime(room, reopened.descriptor);
  } catch {
    state.room = null;
  }
}


function registerWorkspaceCopyRoom(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  room: Room,
  rootPath: string,
): RoomInfo {
  const lease = acquireWorkspaceLease(rootPath);
  const oldConn = room.conn;
  try {
    closeQuietly(oldConn);
    const registered = registerWorkspaceCopyIdentity(rootPath, room.password);
    room.conn = registered.db;
    room.readOnly = false;
    room.duplicateRoomIdentity = false;
    attachStorageRuntime(room, registered.descriptor, lease);
    startWorkspaceRuntime(state, room, deps);
    quiesceStaleJobs(room.conn);
    runCreateOpenSpawns(deps, room);
    pushRecent(deps.userDataDir, room.name, room.path);
    return infoOf(room, deps.userDataDir);
  } catch (error) {
    releaseWorkspaceLease(lease);
    restoreUnregisteredWorkspaceCopy(state, room, rootPath);
    throw error;
  }
}


/** Register a raw Finder copy as an independent writable workspace. */
export function registerWorkspaceCopy(
  state: RoomManagerState,
  deps: RoomManagerDeps,
): RoomInfo {
  if (state.rollingBack) throw new Error(ROLLBACK_BUSY);
  const { room, rootPath } = unregisteredWorkspaceCopy(state);
  return registerWorkspaceCopyRoom(state, deps, room, rootPath);
}


/** Ported from `open_room`: the rollback guard, then {@link openRoomImpl}. */
export function openRoom(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  roomPath: string,
  password: string
): RoomInfo {
  // Wave 3 (Idea 9): a rollback is mid-swap — opening a (different) room now
  // would tear down the room it is about to reopen.
  if (state.rollingBack) {
    throw new Error(ROLLBACK_BUSY);
  }
  return openRoomImpl(state, deps, roomPath, password);
}


/** Unlock a room with its recovery code instead of the password: recover the
 * password from the sidecar, then open exactly as `open_room` does — the
 * GUARDED path, so a recovery unlock still refuses mid-rollback. Ported from
 * `open_room_with_recovery`. */
export async function openRoomWithRecovery(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  roomPath: string,
  code: string
): Promise<RoomInfo> {
  const password = await recoverPassword(describeRoom(roomPath).dbPath, code);
  return openRoom(state, deps, roomPath, password);
}
