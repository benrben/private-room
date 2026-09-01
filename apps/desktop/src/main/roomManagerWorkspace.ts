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
import { migrate } from "./db-host/migrate.js";
import { createRoom as dbCreateRoom, openRoom as dbOpenRoom } from "./db-host/open.js";
import { getSetting, setSetting } from "./db-host/settings.js";
import { quiesceStaleJobs } from "./jobs.js";
import { pumpOnOpen } from "./jobQueue.js";
import { spawnWorkflowScheduler } from "./jobScheduler.js";
import { schedulePrivacyScan } from "./privacy.js";
import { pushRecent } from "./recentTools.js";
import { contentStoreFor } from "./workspace/contentStore.js";
import { acquireWorkspaceLease, createWorkspaceRoom, describeRoom, releaseWorkspaceLease, type WorkspaceLease } from "./workspace/roomLayout.js";
import type { RoomDescriptor, RoomKind } from "./workspace/types.js";
import { WorkspaceService } from "./workspace/workspaceService.js";
import { WorkspaceWatcher } from "./workspace/watcher.js";
import { WorkspaceIndexService } from "./workspace/indexing.js";
import { closeQuietly, logNotImplemented, logSkipped, type Room, type RoomManagerDeps, type RoomManagerState, type WorkspaceWatcherHealth } from "./roomManagerState.js";
import { applyOllamaOverride, infoOf } from "./roomManagerPaths.js";


// ============================================================================
// create_room / open_room / open_room_impl
// ============================================================================

/** Open a room file AND bring it up to the current schema — the two steps
 * Rust's `db::open_room` does as one (`db-host/open.ts`'s own module doc flags
 * gluing `openRoom` + `migrate` together as a follow-up integration step; this
 * is that step). A failed migration closes the handle, exactly as Rust's `?`
 * drops the `Connection` on the way out. */
export function openRoomFile(roomPath: string, password: string): Database.Database {
  const conn = dbOpenRoom(roomPath, password);
  try {
    const sealed = conn.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sealed_package_meta'",
    ).get();
    if (sealed !== undefined) {
      throw new Error("This is a sealed backup. Import it as a new workspace instead of editing it directly.");
    }
    migrate(conn);
  } catch (err) {
    closeQuietly(conn);
    throw err;
  }
  return conn;
}


export function roomDatabasePath(room: Room): string {
  return room.descriptor?.dbPath ?? room.path;
}


export function attachStorageRuntime(
  room: Room,
  descriptor: RoomDescriptor,
  lease?: WorkspaceLease,
): void {
  room.descriptor = descriptor;
  room.contentStore = contentStoreFor(room.conn, descriptor.rootPath);
  room.workspaceLease = lease;
  if (descriptor.kind === "workspace-folder" && descriptor.rootPath !== null) {
    room.workspace = new WorkspaceService(room.conn, descriptor.rootPath);
  }
}


function workspaceRuntimeIsCurrent(state: RoomManagerState, room: Room): boolean {
  return state.room === room && room.workspaceRuntimeClosed !== true;
}


function workspaceChangesPresent(changes: Awaited<ReturnType<WorkspaceService["reconcile"]>>): boolean {
  return changes.added > 0 || changes.changed > 0 || changes.missing > 0 || changes.renamed > 0;
}


async function reconcileWorkspaceRuntime(
  state: RoomManagerState,
  room: Room,
  workspace: WorkspaceService,
  indexer: WorkspaceIndexService,
  deps?: Pick<RoomManagerDeps, "emit" | "privacyScan">,
): Promise<void> {
  const changes = await workspace.reconcile();
  if (!workspaceRuntimeIsCurrent(state, room)) return;
  await indexer.indexPending();
  if (deps?.privacyScan !== undefined) schedulePrivacyScan(deps.privacyScan);
  if (workspaceChangesPresent(changes)) emitWorkspaceFilesChanged(deps);
}


export function startWorkspaceRuntime(
  state: RoomManagerState,
  room: Room,
  deps?: Pick<RoomManagerDeps, "emit" | "privacyScan">,
): void {
  const workspace = room.workspace;
  const rootPath = room.descriptor?.rootPath;
  if (workspace === undefined || rootPath === null || rootPath === undefined) return;
  room.workspaceIndexer?.close();
  room.workspaceIndexer = new WorkspaceIndexService(workspace);
  const indexer = room.workspaceIndexer;
  const polling = getSetting(room.conn, "workspace_watcher_polling") === "true";
  room.workspaceWatcherHealth = {
    state: "starting",
    lastReconciledAt: null,
    lastError: null,
    polling,
  };
  workspace.recoverIncompleteOperations();
  const reconcileIfCurrent = async (): Promise<void> => {
    if (state.room !== room) return;
    try {
      await reconcileWorkspaceRuntime(state, room, workspace, indexer, deps);
      setWorkspaceWatcherHealth(room, "healthy");
    } catch (error) {
      setWorkspaceWatcherHealth(room, "error", error);
      throw error;
    }
  };
  const watcher = new WorkspaceWatcher(rootPath, {
    onChange: (change) => {
      if (change.kind === "error") {
        room.workspaceWatcherHealth = {
          state: "error",
          lastReconciledAt: room.workspaceWatcherHealth?.lastReconciledAt ?? null,
          lastError: change.error ?? "The workspace watcher reported an error.",
          polling,
        };
      }
      void reconcileIfCurrent().catch(() => undefined);
    },
    reconcile: reconcileIfCurrent,
    polling,
  });
  room.workspaceWatcher = watcher;
  const repairLegacyLiveFiles = workspace.materializeLiveBlobFiles().then((repaired) => {
    if (repaired > 0) {
      try { deps?.emit?.("room-files-changed", undefined); } catch { /* closed renderer */ }
    }
  });
  void repairLegacyLiveFiles.then(reconcileIfCurrent)
    .then(() => room.workspaceRuntimeClosed === true ? undefined : watcher.start())
    .catch((error) => {
      console.error(`workspace watcher could not start: ${error instanceof Error ? error.message : String(error)}`);
    });
}


export function workspaceWatcherStatus(state: RoomManagerState): WorkspaceWatcherHealth | null {
  const room = state.room;
  if (room?.workspace === undefined || room.readOnly === true) return null;
  return room.workspaceWatcherHealth ?? {
    state: "starting",
    lastReconciledAt: null,
    lastError: null,
    polling: false,
  };
}


type WritableWorkspaceRoom = Room & { workspace: WorkspaceService };


function requireWritableWorkspaceRoom(state: RoomManagerState): WritableWorkspaceRoom {
  const room = state.room;
  if (room === null || room.workspace === undefined) throw new Error("A workspace room is not open.");
  if (room.readOnly === true) {
    throw new Error("This workspace is read-only because another Arcelle process owns the writer lease.");
  }
  return room as WritableWorkspaceRoom;
}


function emitWorkspaceFilesChanged(deps?: Pick<RoomManagerDeps, "emit">): void {
  try {
    deps?.emit?.("room-files-changed", undefined);
  } catch {
    // A renderer closing during a rescan must not make the filesystem result fail.
  }
}


function setWorkspaceWatcherHealth(
  room: Room,
  state: WorkspaceWatcherHealth["state"],
  error: unknown = null,
): void {
  room.workspaceWatcherHealth = {
    state,
    lastReconciledAt: state === "healthy"
      ? new Date().toISOString()
      : room.workspaceWatcherHealth?.lastReconciledAt ?? null,
    lastError: error === null ? null : error instanceof Error ? error.message : String(error),
    polling: room.workspaceWatcherHealth?.polling ?? false,
  };
}


export async function rescanWorkspaceRoom(
  state: RoomManagerState,
  deps?: Pick<RoomManagerDeps, "emit" | "privacyScan">,
): Promise<WorkspaceWatcherHealth> {
  const room = requireWritableWorkspaceRoom(state);
  try {
    await room.workspace.reconcile();
    await room.workspaceIndexer?.indexPending();
    if (deps?.privacyScan !== undefined) schedulePrivacyScan(deps.privacyScan);
    emitWorkspaceFilesChanged(deps);
    setWorkspaceWatcherHealth(room, "healthy");
  } catch (error) {
    setWorkspaceWatcherHealth(room, "error", error);
    throw error;
  }
  return room.workspaceWatcherHealth!;
}


export async function setWorkspaceWatcherPolling(
  state: RoomManagerState,
  enabled: boolean,
  deps?: Pick<RoomManagerDeps, "emit" | "privacyScan">,
): Promise<WorkspaceWatcherHealth> {
  const room = state.room;
  if (room?.workspace === undefined) throw new Error("A workspace room is not open.");
  if (room.readOnly === true) throw new Error("This workspace is read-only because another Arcelle process owns the writer lease.");
  setSetting(room.conn, "workspace_watcher_polling", enabled ? "true" : "false");
  const oldWatcher = room.workspaceWatcher;
  room.workspaceWatcher = undefined;
  if (oldWatcher !== undefined) await oldWatcher.close();
  if (state.room !== room) throw new Error("The room was closed while its watcher restarted.");
  startWorkspaceRuntime(state, room, deps);
  return workspaceWatcherStatus(state)!;
}


/** The background spawns `create_room` AND `open_room_impl` both start at
 * their tail, in Rust's own order — everything up to, but not including,
 * `open_room_impl`'s privacy refresh, which `create_room` does not do. */
function runOptionalOpenSpawn(
  spawn: (() => void) | undefined,
  operation: string,
  detail: string,
): void {
  if (spawn !== undefined) {
    spawn();
    return;
  }
  logNotImplemented(operation, detail);
}


function runOpenRepairSpawns(deps: RoomManagerDeps): void {
  runOptionalOpenSpawn(
    deps.refreshMcp,
    "refresh_mcp",
    'see mcpConfig.ts\'s own "NOT PORTED" list — no live connection manager exists yet',
  );
  runOptionalOpenSpawn(
    deps.spawnReextractBackfill,
    "spawn_reextract_backfill",
    "the background re-extraction orchestration has no Electron port yet",
  );
  runOptionalOpenSpawn(
    deps.spawnLegacyTextRepair,
    "spawn_legacy_text_repair",
    "the background text-repair orchestration has no Electron port yet",
  );
  runOptionalOpenSpawn(
    deps.spawnEmbeddingBackfill,
    "spawn_embedding_backfill",
    "the background embedding orchestration has no Electron port yet",
  );
}


function startOpenSchedulers(deps: RoomManagerDeps): void {
  if (deps.scheduler !== undefined) {
    spawnWorkflowScheduler(deps.scheduler.deps, deps.scheduler.state);
  } else {
    logSkipped(
      "spawn_workflow_scheduler",
      "no SchedulerDeps/SchedulerState supplied (jobScheduler.ts's spawnWorkflowScheduler is real)",
    );
  }
  if (deps.jobQueue !== undefined) {
    pumpOnOpen(deps.jobQueue);
  } else {
    logSkipped("pump_on_open", "no JobQueueDeps supplied (jobQueue.ts's pumpOnOpen is real)");
  }
}


export function runCreateOpenSpawns(deps: RoomManagerDeps, room: Room): void {
  runOpenRepairSpawns(deps);
  // D9 (the Leash): if the user left the room server on, start it again now.
  deps.spawnRoomServerIfEnabled(room);
  // Wave 4a: start the workflow scheduler and pump any jobs left queued from a
  // previous session (open decision 2: auto-start at unlock).
  startOpenSchedulers(deps);
}


interface CreatedRoomConnection {
  conn: Database.Database;
  descriptor: RoomDescriptor;
  lease?: WorkspaceLease;
}


export function createRoomConnection(
  roomPath: string,
  password: string,
  name: string,
  format: RoomKind,
): CreatedRoomConnection {
  if (format !== "workspace-folder") {
    return { conn: dbCreateRoom(roomPath, password, name), descriptor: describeRoom(roomPath) };
  }
  const created = createWorkspaceRoom(roomPath, password, name);
  try {
    return {
      conn: created.db,
      descriptor: created.descriptor,
      lease: acquireWorkspaceLease(created.descriptor.rootPath),
    };
  } catch (error) {
    closeQuietly(created.db);
    throw error;
  }
}


export function installCreatedRoom(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  created: CreatedRoomConnection,
  name: string,
  password: string,
): RoomInfo {
  applyOllamaOverride(created.conn);
  const room: Room = { conn: created.conn, path: created.descriptor.path, name, password };
  attachStorageRuntime(room, created.descriptor, created.lease);
  let info: RoomInfo;
  try {
    info = infoOf(room, deps.userDataDir);
  } catch (error) {
    closeQuietly(created.conn);
    if (created.lease !== undefined) releaseWorkspaceLease(created.lease);
    throw error;
  }
  pushRecent(deps.userDataDir, room.name, room.path);
  state.room = room;
  startWorkspaceRuntime(state, room, deps);
  quiesceStaleJobs(room.conn);
  runCreateOpenSpawns(deps, room);
  return info;
}
