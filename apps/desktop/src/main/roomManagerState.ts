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
import { createCancelState, type CancelState } from "./cancel.js";
import { type RoomHandle, type RoomSource } from "./jobs.js";
import { type JobQueueDeps } from "./jobQueue.js";
import { type SchedulerDeps, type SchedulerState } from "./jobScheduler.js";
import { deleteEntry as keychainDeleteEntry, has as keychainHas, read as keychainRead, store as keychainStore } from "./keychain.js";
import type { McpManager } from "./mcpClient.js";
import { type PolicyDeps, type PrivacyScanDeps } from "./privacy.js";
import type { RoomPinSource } from "./roomPin.js";
import type { PendingScriptResolver } from "./scriptConsent.js";
import type { EventSender } from "./turn.js";
import type { AgentRunFn } from "./workflowEngine.js";
import { type WorkspaceLease } from "./workspace/roomLayout.js";
import type { ContentStore, RoomDescriptor } from "./workspace/types.js";
import { WorkspaceService } from "./workspace/workspaceService.js";
import { WorkspaceWatcher } from "./workspace/watcher.js";
import { WorkspaceIndexService } from "./workspace/indexing.js";


// ============================================================================
// Types
// ============================================================================

/** `commands.rs`'s `Room` struct: the open room's live connection plus the
 * three fields carried alongside it. `password` is held in memory (the key
 * already lives in SQLCipher's memory anyway) so a recovery-key write can
 * reuse it without prompting again. */
export interface Room {
  conn: Database.Database;
  path: string;
  name: string;
  password: string;
  /** Present on rooms opened by the hybrid-storage runtime. Optional so old
   * tests and extension seams that construct Room remain source-compatible. */
  descriptor?: RoomDescriptor;
  contentStore?: ContentStore;
  workspace?: WorkspaceService;
  workspaceIndexer?: WorkspaceIndexService;
  workspaceLease?: WorkspaceLease;
  /** True when another Arcelle process/device owns the writer lease. */
  readOnly?: boolean;
  /** True when a raw filesystem copy still has another room's stable id. */
  duplicateRoomIdentity?: boolean;
  workspaceWatcher?: WorkspaceWatcher;
  workspaceWatcherHealth?: WorkspaceWatcherHealth;
  workspaceRuntimeClosed?: boolean;
}


export interface WorkspaceWatcherHealth {
  state: "starting" | "healthy" | "error";
  lastReconciledAt: string | null;
  lastError: string | null;
  polling: boolean;
}


/** The user's answer to a per-call MCP approval prompt. Ported from
 * `McpDecision` (`commands.rs`). */
export interface McpDecision {
  approved: boolean;
  remember: boolean;
}


/** Ported from `EditDecision` (`commands.rs`) — the diff-preview approval
 * card's answer. `restOfTurn` maps "Apply for the rest of this answer". */
export interface EditDecision {
  approved: boolean;
  restOfTurn: boolean;
}


/** D9 (the Leash): the minimal shape {@link teardownOpenRoom} needs from a
 * running persistent room MCP server, standing in for `crate::room_mcp::Bridge`
 * until that module is ported. Nothing in this batch ever constructs one — see
 * {@link spawnRoomServerIfEnabledNotImplemented} — but the field and its
 * teardown are real so a future port slots in without re-touching this file's
 * sequencing. */
export interface RoomServerBridge {
  stop(): void;
}


/** Wave 3 (Idea 9): what {@link drainInflight} observed — whether each
 * cancellable writer class emptied within its bounded wait. {@link closeRoom}
 * ignores this; a future `rollback_room_checkpoint` port refuses on any
 * `false`, so a straggler that never observed the cancel flag can't slip past
 * the swap. Ported from `DrainReport`. */
export interface DrainReport {
  asksDrained: boolean;
  jobsDrained: boolean;
}


/** The slice of the (not-yet-ported) `AppState` this module owns — see the
 * module doc. Created fresh per app process (or per test). */
export interface RoomManagerState {
  room: Room | null;
  /** Wave 3 (Idea 9): true while a checkpoint rollback is between the drain
   * and the reopen. Command entry points refuse with {@link ROLLBACK_BUSY}
   * while this is set. No rollback command exists in this batch (that is
   * `room_checkpoints.rs`'s job); this module only reads and gates on it. */
  rollingBack: boolean;
  /** `AppState.room_epoch` — bumped the instant the room handle drops, so a
   * path-pinned background writer that was mid-await can tell it is stale. */
  roomEpoch: number;
  /** The last unlock's "audio from an interrupted recording could not be
   * restored" message, waiting for the workspace to collect it. `null` is the
   * ordinary answer and means exactly nothing went wrong. */
  recRecoveryError: string | null;
  /** SEC-1b: per-call MCP consent remembered for the session ("always
   * allow"), forgotten on lock. */
  mcpSessionOk: Set<string>;
  /** SEC-1b: in-flight per-call MCP approval requests, keyed by request id. */
  mcpPending: Map<string, (decision: McpDecision) => void>;
  /** Wave 2 (Idea 6): in-flight diff-preview approval requests. */
  editPending: Map<string, (decision: EditDecision) => void>;
  /** Wave 5 (Idea 13): in-flight script-run approval requests. The registry
   * INSTANCE belongs here (nothing else owns `AppState.script_pending`), but
   * the shape of an entry is `scriptConsent.ts`'s, not reinvented. */
  scriptPending: Map<string, PendingScriptResolver>;
  /** D9 (the Leash): the room's persistent MCP server, when running. Always
   * `null` in this batch — see {@link RoomServerBridge}. */
  roomServer: RoomServerBridge | null;
  /** `AppState.cancels` / `AppState.job_cancels` (+ the tree `cancel_all`
   * walks) — `cancel.ts`'s own registry, REUSED rather than re-declared. */
  cancel: CancelState;
}


export function createRoomManagerState(): RoomManagerState {
  return {
    room: null,
    rollingBack: false,
    roomEpoch: 0,
    recRecoveryError: null,
    mcpSessionOk: new Set(),
    mcpPending: new Map(),
    editPending: new Map(),
    scriptPending: new Map(),
    roomServer: null,
    cancel: createCancelState(),
  };
}


/** {@link RoomManagerState} as a {@link RoomPinSource} — the epoch/path pair
 * `RoomPin.take` needs. */
export function toRoomPinSource(state: RoomManagerState): RoomPinSource {
  return {
    roomEpoch: () => state.roomEpoch,
    currentRoomPath: () => state.room?.path ?? null,
  };
}


/** {@link RoomManagerState} as the `RoomSource` `jobs.ts`/`jobQueue.ts`/
 * `jobScheduler.ts`/`privacy.ts` all take as their room-access seam. */
export function toRoomSource(state: RoomManagerState): RoomSource {
  return {
    current: (): RoomHandle | null =>
      state.room !== null
        ? {
            db: state.room.conn,
            path: state.room.path,
            ...(state.room.workspace === undefined ? {} : { workspace: state.room.workspace }),
          }
        : null,
  };
}


/**
 * Every side-effecting call `rooms.rs` makes into another subsystem — see the
 * module doc's two-bucket split. `userDataDir` is this migration's established
 * convention for "the app's own per-Mac data folder" (`app.getPath('userData')`,
 * as in `mcpConfig.ts`, `keychain.ts`, `recentTools.ts`).
 */
export interface RoomManagerDeps {
  userDataDir: string;

  /** `app.emit(event, payload)`. `undefined` means there is no live window to
   * notify (a headless call, or the render process not wired up yet). */
  emit?: EventSender;

  // ---- bucket 1: real ported subsystems, not wired into a live bootstrap ----
  /** A real, live `McpManager` — its clients are closed and its list cleared
   * on teardown when supplied. */
  mcp?: McpManager;
  /** A real `Browser.close()` (or anything with the same shape). */
  closeBrowser?: () => void;
  jobQueue?: JobQueueDeps;
  scheduler?: { deps: SchedulerDeps; state: SchedulerState };
  policy?: PolicyDeps;
  privacyScan?: PrivacyScanDeps;
  /** One headless, cancellable agent turn for an `agent_run` workflow node. */
  workflowAgentRun?: AgentRunFn;
  /** Debounced background description/read scheduling after an ingest. */
  scheduleAutoIndex?: (roomPath: string) => void;

  // ---- bucket 2: genuinely unported Rust subsystems ----
  /** `refresh_mcp` — reconnect the room's saved connector config. */
  refreshMcp?: () => void;
  /** `spawn_reextract_backfill` / `spawn_legacy_text_repair` /
   * `spawn_embedding_backfill` — background indexing orchestration. */
  spawnReextractBackfill?: () => void;
  spawnLegacyTextRepair?: () => void;
  spawnEmbeddingBackfill?: () => void;
  /** `ollama_lifecycle::note_room_closed` — the idle-sleep warm window. */
  noteRoomClosed?: () => void;
  /** `sidecar::forget_room_memory` — release the AI service's compacted
   * digests of this room's conversations. */
  forgetRoomMemory?: () => void;
  /** `commands/moonshot/discovery.rs::remove_discovery` — only ever reached if
   * a future `room_mcp` port sets {@link RoomManagerState.roomServer}. */
  removeDiscovery?: () => void;
  /** Bundles the SIX Rust pieces with no Electron home yet:
   * `MediaStreams`/`PeakCache`/`SlideCache`/`HtmlPreviews`, the
   * `cleanup_browser_previews_older_than(60s)` sweep, and `AgentUi.pending`. */
  clearEphemeralCaches?: () => void;
  /** The live recording `drainInflight` stops and WAITS for (bounded, Rust's
   * own 30 s); `recBridge.ts`'s session broker has no single global slot to
   * call this against yet. */
  stopRecordingAndWait?: (timeoutMs: number) => Promise<void>;
  /** The same engine, told to stop with NO wait — the teardown path. */
  stopRecordingNoWait?: () => void;
  /** Unified native/deep harnesses must stop before the encrypted room DB closes. */
  stopHarnessRuns?: (timeoutMs: number) => Promise<void>;
  /** Best-effort cancellation for forced synchronous teardown paths. */
  stopHarnessRunsNoWait?: () => void;

  /** D9 (the Leash): restart the room's persistent MCP server if its toggle
   * was left on. REQUIRED — see {@link spawnRoomServerIfEnabledNotImplemented}. */
  spawnRoomServerIfEnabled: (room: Room) => void;

  // ---- ADD-11: Touch ID's real Keychain backend (keychain.ts) — a third,
  // "real by default" kind of dependency; see the module doc's "INJECTED
  // DEPENDENCIES" section for how this differs from buckets 1 and 2. ----
  /** The exact four `keychain.ts` calls {@link touchIdHas}/{@link
   * touchIdEnable}/{@link touchIdDisable}/{@link touchIdOpen} make, real
   * (`keychain.ts`'s own top-level exports) unless overridden — overridden
   * only in tests, the same `ctx.generate ?? generateReal` shape as
   * `chatCommandsKnowledge.ts`'s `CmdCtx.generate`. Never call
   * `serviceOverride` here: that parameter exists solely for keychain.test.ts
   * to avoid touching the real "PrivateRoom" service. */
  keychain?: {
    has: typeof keychainHas;
    store: typeof keychainStore;
    read: typeof keychainRead;
    deleteEntry: typeof keychainDeleteEntry;
  };
}


// ============================================================================
// Honest-refusal / honest-log helpers
// ============================================================================

/** Bucket 2: a genuinely unported Rust subsystem. Logs (never throws) because
 * every call site here is Rust's own `tauri::async_runtime::spawn`
 * fire-and-forget — a room lock/unlock must not fail because an auxiliary
 * background spawn has no Electron port yet. */
export function logNotImplemented(rustRef: string, why: string): void {
  console.error(`NOT_IMPLEMENTED: ${rustRef} — ${why}`);
}


/** Bucket 1: the real ported logic exists, this call simply was not handed the
 * dependency it needs. Distinct wording from {@link logNotImplemented} on
 * purpose — a wiring gap, not a missing port. */
export function logSkipped(what: string, hint: string): void {
  console.error(`SKIPPED: ${what} — ${hint}`);
}


/** `AppState::with_room`'s refusal — every command that needs an open room and
 * does not have one says exactly this. */
export const NO_ROOM_OPEN = "No room is open.";


export function requireRoom(state: RoomManagerState): Room {
  if (state.room === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  return state.room;
}


/** Close a handle we are abandoning, swallowing a double-close. Stands in for
 * Rust's `Drop for Connection` — see this file's DEVIATIONS section. */
export function closeQuietly(conn: Database.Database): void {
  try {
    conn.close();
  } catch {
    // already closed / nothing to do
  }
}
