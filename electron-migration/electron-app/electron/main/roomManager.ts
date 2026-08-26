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
import { renameSync } from "node:fs";
import path from "node:path";
import type { McpApproval, RoomInfo } from "../shared/apiTypes.js";
import { cancelAll, createCancelState, type CancelState } from "./cancel.js";
import { getMeta, setMeta } from "./db-host/meta.js";
import { migrate } from "./db-host/migrate.js";
import { roomCounts } from "./db-host/messages.js";
import { createRoom as dbCreateRoom, openRoom as dbOpenRoom } from "./db-host/open.js";
import { recoverRecChunks } from "./db-host/recordings.js";
import { hasRecovery, recoverPassword, writeRecovery } from "./db-host/recovery.js";
import { getSetting } from "./db-host/settings.js";
import { setBaseUrlOverride } from "./engineRouting.js";
import {
  markJobsParking,
  parkRunningJobs,
  PARKED_BY_LOCK,
  quiesceStaleJobs,
  type RoomHandle,
  type RoomSource,
} from "./jobs.js";
import { pumpOnOpen, type JobQueueDeps } from "./jobQueue.js";
import {
  spawnWorkflowScheduler,
  type SchedulerDeps,
  type SchedulerState,
} from "./jobScheduler.js";
import {
  deleteEntry as keychainDeleteEntry,
  has as keychainHas,
  read as keychainRead,
  store as keychainStore,
} from "./keychain.js";
import type { McpManager } from "./mcpClient.js";
import {
  MCP_CONFIG_KEY,
  mcpGate,
  readMcpApprovals,
  renderCommandLine,
} from "./mcpConfig.js";
import { takePendingOpen as takePendingOpenSlot } from "./pendingOpen.js";
import {
  clearPolicy,
  refreshPolicy,
  schedulePrivacyScan,
  type PolicyDeps,
  type PrivacyScanDeps,
} from "./privacy.js";
import { pushRecent, readRecent, renameRecent, writeRecent } from "./recentTools.js";
import type { RoomPinSource } from "./roomPin.js";
import type { PendingScriptResolver } from "./scriptConsent.js";
import type { EventSender } from "./turn.js";
import type { AgentRunFn } from "./workflowEngine.js";
import { ROLLBACK_BUSY } from "./turnContext.js";
import { contentStoreFor } from "./workspace/contentStore.js";
import {
  acquireWorkspaceLease,
  createWorkspaceRoom,
  describeRoom,
  openWorkspaceRoom,
  releaseWorkspaceLease,
  type WorkspaceLease,
} from "./workspace/roomLayout.js";
import type { ContentStore, RoomDescriptor, RoomKind } from "./workspace/types.js";
import { WorkspaceService } from "./workspace/workspaceService.js";
import { WorkspaceWatcher } from "./workspace/watcher.js";

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
  workspaceLease?: WorkspaceLease;
  workspaceWatcher?: WorkspaceWatcher;
  workspaceRuntimeClosed?: boolean;
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
      state.room !== null ? { db: state.room.conn, path: state.room.path } : null,
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
function logNotImplemented(rustRef: string, why: string): void {
  console.error(`NOT_IMPLEMENTED: ${rustRef} — ${why}`);
}

/** Bucket 1: the real ported logic exists, this call simply was not handed the
 * dependency it needs. Distinct wording from {@link logNotImplemented} on
 * purpose — a wiring gap, not a missing port. */
function logSkipped(what: string, hint: string): void {
  console.error(`SKIPPED: ${what} — ${hint}`);
}

/** `AppState::with_room`'s refusal — every command that needs an open room and
 * does not have one says exactly this. */
export const NO_ROOM_OPEN = "No room is open.";

function requireRoom(state: RoomManagerState): Room {
  if (state.room === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  return state.room;
}

/** Close a handle we are abandoning, swallowing a double-close. Stands in for
 * Rust's `Drop for Connection` — see this file's DEVIATIONS section. */
function closeQuietly(conn: Database.Database): void {
  try {
    conn.close();
  } catch {
    // already closed / nothing to do
  }
}

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
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  const isStorage =
    lower.includes("disk i/o error") ||
    lower.includes("database or disk is full") ||
    lower.includes("readonly database") ||
    lower.includes("unable to open database") ||
    lower.includes("no space left") ||
    // The closing paren is what makes the number a WHOLE number: matching a
    // bare "os error 2" also swallowed 20-29, so "Too many open files (os
    // error 24)" would have been reported as a disconnected drive.
    lower.includes("os error 28)") || // ENOSPC
    lower.includes("os error 2)"); // ENOENT — the volume went away
  if (!isStorage) {
    return err instanceof Error ? err : new Error(raw);
  }
  if (!existsSync(roomPath)) {
    return new Error(
      "This room's file can't be reached any more — the drive or folder holding it has " +
        `gone away. Reconnect it and try again; nothing else was changed. [${raw}]`
    );
  }
  if (lower.includes("full") || lower.includes("no space left") || lower.includes("os error 28")) {
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
  };
}

// ============================================================================
// create_room / open_room / open_room_impl
// ============================================================================

/** Open a room file AND bring it up to the current schema — the two steps
 * Rust's `db::open_room` does as one (`db-host/open.ts`'s own module doc flags
 * gluing `openRoom` + `migrate` together as a follow-up integration step; this
 * is that step). A failed migration closes the handle, exactly as Rust's `?`
 * drops the `Connection` on the way out. */
function openRoomFile(roomPath: string, password: string): Database.Database {
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

function roomDatabasePath(room: Room): string {
  return room.descriptor?.dbPath ?? room.path;
}

function attachStorageRuntime(
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

function startWorkspaceRuntime(state: RoomManagerState, room: Room): void {
  const workspace = room.workspace;
  const rootPath = room.descriptor?.rootPath;
  if (workspace === undefined || rootPath === null || rootPath === undefined) return;
  workspace.recoverIncompleteOperations();
  const reconcileIfCurrent = async (): Promise<void> => {
    if (state.room !== room) return;
    await workspace.reconcile();
  };
  const watcher = new WorkspaceWatcher(rootPath, {
    onChange: () => { void reconcileIfCurrent().catch(() => undefined); },
    reconcile: reconcileIfCurrent,
  });
  room.workspaceWatcher = watcher;
  void reconcileIfCurrent()
    .then(() => room.workspaceRuntimeClosed === true ? undefined : watcher.start())
    .catch((error) => {
      console.error(`workspace watcher could not start: ${error instanceof Error ? error.message : String(error)}`);
    });
}

/** The background spawns `create_room` AND `open_room_impl` both start at
 * their tail, in Rust's own order — everything up to, but not including,
 * `open_room_impl`'s privacy refresh, which `create_room` does not do. */
function runCreateOpenSpawns(deps: RoomManagerDeps, room: Room): void {
  if (deps.refreshMcp) {
    deps.refreshMcp();
  } else {
    logNotImplemented(
      "refresh_mcp",
      'see mcpConfig.ts\'s own "NOT PORTED" list — no live connection manager exists yet'
    );
  }
  if (deps.spawnReextractBackfill) {
    deps.spawnReextractBackfill();
  } else {
    logNotImplemented(
      "spawn_reextract_backfill",
      "the background re-extraction orchestration has no Electron port yet"
    );
  }
  if (deps.spawnLegacyTextRepair) {
    deps.spawnLegacyTextRepair();
  } else {
    logNotImplemented(
      "spawn_legacy_text_repair",
      "the background text-repair orchestration has no Electron port yet"
    );
  }
  if (deps.spawnEmbeddingBackfill) {
    deps.spawnEmbeddingBackfill();
  } else {
    logNotImplemented(
      "spawn_embedding_backfill",
      "the background embedding orchestration has no Electron port yet"
    );
  }
  // D9 (the Leash): if the user left the room server on, start it again now.
  deps.spawnRoomServerIfEnabled(room);
  // Wave 4a: start the workflow scheduler and pump any jobs left queued from a
  // previous session (open decision 2: auto-start at unlock).
  if (deps.scheduler) {
    spawnWorkflowScheduler(deps.scheduler.deps, deps.scheduler.state);
  } else {
    logSkipped(
      "spawn_workflow_scheduler",
      "no SchedulerDeps/SchedulerState supplied (jobScheduler.ts's spawnWorkflowScheduler is real)"
    );
  }
  if (deps.jobQueue) {
    pumpOnOpen(deps.jobQueue);
  } else {
    logSkipped("pump_on_open", "no JobQueueDeps supplied (jobQueue.ts's pumpOnOpen is real)");
  }
}

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

  let conn: Database.Database;
  let descriptor: RoomDescriptor;
  let lease: WorkspaceLease | undefined;
  if (format === "workspace-folder") {
    const created = createWorkspaceRoom(roomPath, password, resolvedName);
    conn = created.db;
    descriptor = created.descriptor;
    try {
      lease = acquireWorkspaceLease(created.descriptor.rootPath);
    } catch (error) {
      closeQuietly(conn);
      throw error;
    }
  } else {
    conn = dbCreateRoom(roomPath, password, resolvedName);
    descriptor = describeRoom(roomPath);
  }

  if (state.room !== null) {
    teardownOpenRoom(state, deps);
  }

  // D10 (the Closet): a fresh room has no remote-Ollama URL, which clears any
  // override the previous room set.
  applyOllamaOverride(conn);
  const room: Room = { conn, path: descriptor.path, name: resolvedName, password };
  attachStorageRuntime(room, descriptor, lease);

  let info: RoomInfo;
  try {
    info = infoOf(room, deps.userDataDir);
  } catch (err) {
    // Rust's `let info = info_of(..)?;` drops `room` — and its connection —
    // on the way out, leaving `state.room` untouched.
    closeQuietly(conn);
    if (lease !== undefined) releaseWorkspaceLease(lease);
    throw err;
  }
  pushRecent(deps.userDataDir, room.name, room.path);
  state.room = room;
  startWorkspaceRuntime(state, room);
  // ADD-30: a job left 'running' belongs to a process that's gone — mark it
  // 'paused' so the UI offers Resume rather than a phantom active job.
  quiesceStaleJobs(room.conn);

  runCreateOpenSpawns(deps, room);

  return info;
}

/**
 * The body of `open_room`, without the rollback-in-flight guard, so a future
 * `rollback_room_checkpoint` port can reopen the swapped file while its own
 * flag is still set. Every other caller goes through the guarded
 * {@link openRoom}. Ported from `open_room_impl`.
 */
export function openRoomImpl(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  roomPath: string,
  password: string
): RoomInfo {
  const descriptor = describeRoom(roomPath);
  let lease: WorkspaceLease | undefined;
  let conn: Database.Database;
  if (descriptor.kind === "workspace-folder" && descriptor.rootPath !== null) {
    lease = acquireWorkspaceLease(descriptor.rootPath);
    try {
      conn = openWorkspaceRoom(descriptor.rootPath, password).db;
    } catch (error) {
      releaseWorkspaceLease(lease);
      throw error;
    }
  } else {
    conn = openRoomFile(descriptor.dbPath, password);
  }

  // Opening a room while another is open (a Finder double-click on a second
  // .roomai) must fully tear the old one down first. Runs only AFTER the
  // password proved right, so a failed unlock never locks the room the user
  // is in.
  if (state.room !== null) {
    teardownOpenRoom(state, deps);
  }

  const name = descriptor.kind === "workspace-folder"
    ? roomNameFromPath(descriptor.path)
    : getMeta(conn, "name") ?? roomNameFromPath(roomPath);
  // D10 (the Closet): re-apply this room's saved remote-Ollama URL on unlock.
  applyOllamaOverride(conn);
  const room: Room = { conn, path: descriptor.path, name, password };
  attachStorageRuntime(room, descriptor, lease);

  let info: RoomInfo;
  try {
    info = infoOf(room, deps.userDataDir);
  } catch (err) {
    closeQuietly(conn);
    if (lease !== undefined) releaseWorkspaceLease(lease);
    throw err;
  }
  pushRecent(deps.userDataDir, room.name, room.path);
  state.room = room;
  startWorkspaceRuntime(state, room);
  quiesceStaleJobs(room.conn);

  // A live recording that died with the app left audio checkpoints behind —
  // splice them onto the WAV so nothing recorded is lost.
  try {
    const recovered = recoverRecChunks(room.conn);
    if (recovered > 0) {
      console.error(`recovered ${recovered} interrupted recording(s)`);
    }
  } catch (err) {
    // Swallowing this meant the user simply found the end of a meeting
    // missing, with nothing said either way — on every unlock, forever.
    reportRecRecoveryFailure(
      state,
      deps,
      room.path,
      err instanceof Error ? err.message : String(err)
    );
  }

  runCreateOpenSpawns(deps, room);

  // PRIV-1: resolve this room's privacy policy into the cache, and catch up on
  // any files imported while the door was off/absent.
  if (deps.policy) {
    refreshPolicy(deps.policy);
  } else {
    logSkipped("refresh_policy", "no PolicyDeps supplied (privacy.ts's refreshPolicy is real)");
  }
  if (deps.privacyScan) {
    schedulePrivacyScan(deps.privacyScan);
  } else {
    logSkipped(
      "schedule_privacy_scan",
      "no PrivacyScanDeps supplied (privacy.ts's schedulePrivacyScan is real)"
    );
  }

  return info;
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

/**
 * Recovery (the printed sheet): create a recovery key for the CURRENTLY OPEN
 * room and return the human code to show once. Uses the open room's own path
 * and password, so the create/settings flows pass nothing sensitive across the
 * boundary. Ported from `write_recovery_key`, including the storage-error
 * rewrite `with_room` applies on the way out.
 */
export async function writeRecoveryKey(state: RoomManagerState): Promise<string> {
  const room = requireRoom(state);
  try {
    return await writeRecovery(roomDatabasePath(room), room.password);
  } catch (err) {
    throw humanizeStorageError(err, room.path);
  }
}

/** True when the room at `roomPath` has a recovery sidecar — the gate shows
 * "Unlock with recovery code" only then. Ported from `has_recovery_key`. */
export function hasRecoveryKey(roomPath: string): boolean {
  try {
    return hasRecovery(describeRoom(roomPath).dbPath);
  } catch {
    return false;
  }
}

// ============================================================================
// The parked "audio could not be restored" message
// ============================================================================

/** The parked message, if the last unlock left one. Cleared by the read: the
 * workspace calls this once on mount, so the failure reaches the screen
 * whether or not a listener existed when the rescue ran. `null` is the
 * ordinary answer and means exactly nothing went wrong. Ported from
 * `take_rec_recovery_error`/`take_recovery_error`. */
export function takeRecRecoveryError(state: RoomManagerState): string | null {
  const value = state.recRecoveryError;
  state.recRecoveryError = null;
  return value;
}

/** The two guards Rust's delayed emit re-checks inside its spawned closure:
 * the room this failure belongs to must still be the OPEN one (locking up
 * immediately must not produce a toast about a room that is gone), and nobody
 * must have collected the parked message already (a workspace that was already
 * listening must not get the same failure twice). Split out so both are
 * testable without a timer. */
export function shouldEmitRecRecovery(state: RoomManagerState, roomPath: string): boolean {
  const stillOpen = state.room !== null && state.room.path === roomPath;
  if (!stillOpen) {
    return false;
  }
  return state.recRecoveryError !== null;
}

/**
 * Tell the user that audio left behind by a crashed recording could NOT be
 * spliced back. Rides the recording area's existing `rec-error` channel,
 * because a rescue that silently does nothing looks exactly like a meeting
 * whose end was never recorded. Ported from `report_rec_recovery_failure`.
 *
 * The message is PARKED first and emitted second, and the PARKED copy is the
 * one that counts: the unlock returns before the workspace has mounted its
 * listeners, so a one-shot emit on a fixed timer is a guess that loses the
 * race on a cold start. The emit stays for the workspace that IS already up
 * (an open-over-open unlock); it emits a COPY and leaves the park alone, so
 * {@link takeRecRecoveryError} remains the message's only consumer.
 */
export function reportRecRecoveryFailure(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  roomPath: string,
  err: string,
  delayMs = 2000
): void {
  console.error(`recording recovery failed: ${err}`);
  const message =
    `Audio from an interrupted recording could not be restored: ${err} ` +
    "Nothing was lost — it is still stored in the room, and the rescue " +
    "runs again the next time you unlock it.";
  state.recRecoveryError = message;
  const timer = setTimeout(() => {
    if (!shouldEmitRecRecovery(state, roomPath)) {
      return;
    }
    if (deps.emit) {
      deps.emit("rec-error", { fileId: "", message });
    }
  }, delayMs);
  // A pending 2 s timer must not be the reason a process (or a test runner)
  // stays alive — this is a best-effort fallback, not work anyone waits for.
  if (typeof timer.unref === "function") {
    timer.unref();
  }
}

// ============================================================================
// room_info / rename_room / take_pending_open
// ============================================================================

/** Ported from `room_info`. No rollback guard — Rust has none here either. */
export function roomInfo(state: RoomManagerState, deps: RoomManagerDeps): RoomInfo | null {
  return state.room !== null ? infoOf(state.room, deps.userDataDir) : null;
}

/**
 * Rename the open room. Ported from `rename_room`.
 *
 * Both copies of the name are updated together: the room's `meta` (the
 * authority, which travels with the file) and the recents entry for this path
 * (which has to carry its own copy — it names rooms that are locked and cannot
 * be read). The length checks come BEFORE the no-room check, exactly as they
 * do in Rust.
 */
export function renameRoom(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  name: string
): RoomInfo {
  // Wave 3 (Idea 9): a rollback is about to replace this DB — a name written
  // now would be swapped away without a word.
  if (state.rollingBack) {
    throw new Error(ROLLBACK_BUSY);
  }
  const trimmed = name.trim();
  if (trimmed === "") {
    throw new Error("A room needs a name.");
  }
  if ([...trimmed].length > MAX_ROOM_NAME_CHARS) {
    throw new Error(`That name is too long — ${MAX_ROOM_NAME_CHARS} characters at most.`);
  }
  const room = requireRoom(state);
  const oldPath = room.path;
  if (room.descriptor?.kind === "workspace-folder" && room.descriptor.rootPath !== null) {
    if (trimmed === "." || trimmed === ".." || trimmed.includes("/") || trimmed.includes("\\")) {
      throw new Error("A workspace name cannot contain path separators.");
    }
    const newPath = path.join(path.dirname(room.path), trimmed);
    if (newPath !== room.path) {
      if (existsSync(newPath)) throw new Error("A file or folder already exists with that name.");
      room.workspaceRuntimeClosed = true;
      if (room.workspaceWatcher !== undefined) void room.workspaceWatcher.close().catch(() => undefined);
      room.conn.pragma("wal_checkpoint(FULL)");
      renameSync(room.path, newPath);
      room.path = newPath;
      room.descriptor = describeRoom(newPath);
      room.workspace = new WorkspaceService(room.conn, newPath);
      room.contentStore = contentStoreFor(room.conn, newPath);
      if (room.workspaceLease !== undefined) {
        room.workspaceLease.lockPath = path.join(newPath, ".arcelle", "room.lock");
      }
      room.workspaceRuntimeClosed = false;
      startWorkspaceRuntime(state, room);
    }
  }
  setMeta(room.conn, "name", trimmed);
  room.name = trimmed;
  const info = infoOf(room, deps.userDataDir);

  try {
    writeRecent(
      deps.userDataDir,
      renameRecent(readRecent(deps.userDataDir), oldPath, info.name, info.path)
    );
  } catch {
    // Best-effort, matching Rust's `let _ = write_recent(...)`: the recents
    // list must never be able to fail a rename.
  }
  return info;
}

/** Ported from `take_pending_open`. `pendingOpen.ts` already owns the real
 * (process-global — Rust's `AppState.pending_open` is one too) slot, so this
 * delegates entirely rather than keeping a second one. */
export function takePendingOpen(): string | null {
  return takePendingOpenSlot();
}

// ============================================================================
// close_room / drain_inflight / teardown_open_room
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  });
}

/** Timing knobs, purely for test speed — the DEFAULTS are Rust's own exact
 * values (20 polls × 50 ms for asks, "up to ~1s"; 20 polls × 100 ms for jobs). */
export interface DrainTiming {
  askPollMs?: number;
  askMaxPolls?: number;
  jobPollMs?: number;
  jobMaxPolls?: number;
}

/** Poll `map.size === 0` up to `maxPolls` times, `pollMs` apart — mirroring
 * Rust's `for _ in 0..N { if empty { break } sleep(d).await }` exactly: the
 * check happens BEFORE each sleep, and running out of iterations without ever
 * observing empty reports `false`. */
async function waitUntilEmpty(
  map: ReadonlyMap<string, unknown>,
  maxPolls: number,
  pollMs: number
): Promise<boolean> {
  for (let i = 0; i < maxPolls; i++) {
    if (map.size === 0) {
      return true;
    }
    await sleep(pollMs);
  }
  return false;
}

/**
 * Stop the live recording (waiting for its final flush) and signal every
 * in-flight ask + background job to cancel, waiting briefly for each registry
 * to empty. Ported from `drain_inflight` — shared with a future rollback path,
 * which is why it REPORTS rather than deciding: `close_room` ignores the
 * report (the teardown below is the correctness backstop), while
 * `rollback_room_checkpoint` refuses on any `false`.
 */
export async function drainInflight(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  timing: DrainTiming = {}
): Promise<DrainReport> {
  const { askPollMs = 50, askMaxPolls = 20, jobPollMs = 100, jobMaxPolls = 20 } = timing;

  // ADD-27: a live recording must land in the DB before the room changes.
  // Bounded (Rust's own 30 s) so a stuck decode can never wedge lock/close.
  if (deps.stopRecordingAndWait) {
    await deps.stopRecordingAndWait(30_000);
  } else {
    logNotImplemented(
      "RecState.session (recording engine stop-and-await)",
      "recBridge.ts has no single global live-session slot to stop yet"
    );
  }

  // HLT-7: if an answer is streaming, cancel it and wait briefly for its
  // save-partial phase, so the swap never races the DB shut.
  const askCount = state.cancel.cancels.size;
  for (const flag of state.cancel.cancels.values()) {
    flag.store(true);
  }
  // Owner replacement #3: the flat map above holds ROOTS. Work a run started —
  // a Studio build dispatched by an agent tool — carries its own flag, which
  // lives only in the cancel TREE, so flipping roots alone would leave it
  // generating against a room being sealed.
  cancelAll(state.cancel);
  const asksDrained =
    askCount === 0 || (await waitUntilEmpty(state.cancel.cancels, askMaxPolls, askPollMs));

  // Stamp WHY first, while the room is still open and every runner is still
  // alive. The two landings a moment from now write different statuses, and
  // neither of them knows it was the LOCK that stopped it.
  if (state.room !== null) {
    try {
      markJobsParking(state.room.conn, PARKED_BY_LOCK);
    } catch {
      // Best-effort, matching Rust's `let _ = state.with_room(...)`.
    }
  }

  const jobCount = state.cancel.jobCancels.size;
  for (const flag of state.cancel.jobCancels.values()) {
    flag.store(true);
  }
  const jobsDrained =
    jobCount === 0 || (await waitUntilEmpty(state.cancel.jobCancels, jobMaxPolls, jobPollMs));

  return { asksDrained, jobsDrained };
}

/**
 * Park whatever this room still has in flight, at the LAST moment its DB is
 * reachable. Returns how many jobs were parked. Ported from
 * `park_inflight_jobs_for_teardown`.
 *
 * A runner inside a model call will not observe the lock's cancel flag for
 * minutes; when it finally does, its epilogue finds the room gone and writes
 * nothing at all — so the row simply stayed 'running' in the encrypted file,
 * work the app had definitively abandoned recorded as work in progress. The
 * checkpoint (`cursor`/`state`) is deliberately untouched: parked is not
 * cancelled, and Resume continues from where the job actually got to.
 */
export function parkInflightJobsForTeardown(state: RoomManagerState): number {
  // Nothing open — a second teardown, or a failed unlock. There is no room
  // whose jobs could be in flight, so there is nothing to record.
  return state.room !== null ? parkRunningJobs(state.room.conn, PARKED_BY_LOCK) : 0;
}

/**
 * Synchronously tear down every piece of per-room state: the room handle, the
 * persistent MCP bridge (and its bearer token), connected MCP servers,
 * per-session consents, staged media, and pending agent↔UI round-trips. Shared
 * by {@link closeRoom} and the open-over-open path, so the old room's bridge
 * can never keep serving tools that resolve against the new room. Ported from
 * `teardown_open_room`.
 *
 * The ORDER is load-bearing and must not be rearranged: the browser's journal
 * and the job park both need the room's DB still open; the room handle must
 * drop (and its connection close) before the epoch bumps; the epoch must bump
 * before anything can trust "the room is gone". Cancel flags are signalled but
 * NOT awaited — callers that can await ({@link closeRoom}) drain them first.
 */
export function teardownOpenRoom(state: RoomManagerState, deps: RoomManagerDeps): void {
  // Signal every in-flight ask and background job to stop (no wait here) —
  // and, through the tree, whatever they had started.
  for (const flag of state.cancel.cancels.values()) {
    flag.store(true);
  }
  for (const flag of state.cancel.jobCancels.values()) {
    flag.store(true);
  }
  cancelAll(state.cancel);

  // Best-effort: tell a live recording engine to stop and flush. No wait.
  if (deps.stopRecordingNoWait) {
    deps.stopRecordingNoWait();
  } else {
    logNotImplemented(
      "RecState.session (recording engine stop, no wait)",
      "recBridge.ts has no single global live-session slot to stop yet"
    );
  }

  // BROWSE-1: the private browser must not outlive the room. A LIVE page left
  // floating over a locked room would still be showing whatever the room was
  // looking at, and its agent journal has to flush into the DB while the DB is
  // still open — closed BEFORE the room handle drops, for exactly that reason.
  if (deps.closeBrowser) {
    try {
      deps.closeBrowser();
    } catch {
      // Rust's call site is `let _ = crate::browser::close(app);` — a browser
      // that will not close must not abandon the rest of this teardown.
    }
  } else {
    logSkipped(
      "browser::close",
      "no closeBrowser supplied (browser/browser.ts's Browser.close() is real)"
    );
  }

  parkInflightJobsForTeardown(state);

  // The warm window is for someone who stepped away from an open room, not for
  // a locked one.
  if (deps.noteRoomClosed) {
    deps.noteRoomClosed();
  } else {
    logNotImplemented(
      "ollama_lifecycle::note_room_closed",
      "see ollamaLifecycle.ts's own module doc — the process lifecycle half is not ported"
    );
  }

  // Rust's `*state.room_guard() = None;` DROPS the Room, closing its
  // connection. JS has no destructor, so the close is explicit — see this
  // file's DEVIATIONS section. Cleared first, so nothing re-entrant can find a
  // room whose handle is on its way out.
  const closing = state.room;
  state.room = null;
  if (closing !== null) {
    closing.workspaceRuntimeClosed = true;
    if (closing.workspaceWatcher !== undefined) {
      void closing.workspaceWatcher.close().catch(() => undefined);
    }
    closeQuietly(closing.conn);
    if (closing.workspaceLease !== undefined) {
      releaseWorkspaceLease(closing.workspaceLease);
    }
  }

  // PRIV-1: the cached privacy policy holds the room's protected strings — it
  // must not outlive the room handle (same invariant as the MCP token).
  clearPolicy();

  // Wave 3 (Idea 9): bump the room epoch the instant the room handle drops.
  // Every path-pinned background writer captured the old epoch at spawn and
  // re-checks it before writing, so a straggler that was mid-await when a
  // rollback swapped the DB can't land its write against the reopened room
  // (the room PATH is unchanged after a rollback, so the path pin can't tell).
  state.roomEpoch += 1;

  // D9 (the Leash): a locked room must not leave its MCP endpoint reachable —
  // stop and clear it here, and never let the discovery file advertise a dead
  // or foreign endpoint.
  if (state.roomServer !== null) {
    state.roomServer.stop();
    if (deps.removeDiscovery) {
      deps.removeDiscovery();
    } else {
      logNotImplemented(
        "commands/moonshot/discovery.rs::remove_discovery",
        "the Leash's discovery-file writer has no Electron port yet"
      );
    }
    state.roomServer = null;
  }

  // Dropping the clients kills the server processes (`kill_on_drop` in Rust;
  // here, an explicit close() per client, since JS has no destructor).
  if (deps.mcp) {
    for (const entry of deps.mcp.servers) {
      entry.client?.close();
    }
    deps.mcp.servers = [];
    deps.mcp.generation += 1;
  } else {
    logSkipped(
      "mcp manager teardown",
      "no McpManager supplied (mcpClient.ts's McpManager is real)"
    );
  }

  // SEC-1b: per-call MCP consent is per session — forget it on lock, and drop
  // any in-flight approval requests. See DEVIATION 2: each pending resolver is
  // DECLINED explicitly, because a JS callback never fires on being dropped.
  state.mcpSessionOk.clear();
  for (const resolve of state.mcpPending.values()) {
    resolve({ approved: false, remember: false });
  }
  state.mcpPending.clear();

  // Wave 2 (Idea 6): drop any in-flight diff-preview approval requests too, so
  // nothing lands after a room closes.
  for (const resolve of state.editPending.values()) {
    resolve({ approved: false, restOfTurn: false });
  }
  state.editPending.clear();

  // Wave 5 (Idea 13): drop any in-flight script-run approval requests too.
  for (const resolve of state.scriptPending.values()) {
    resolve({ approved: false, remember: false });
  }
  state.scriptPending.clear();

  // A parked recording-recovery failure belongs to the room being closed.
  // Nothing else empties it — it is consumed by a workspace MOUNT, and the
  // fallback timer returns without touching it once the room is gone — so a
  // room locked within those two seconds left its message sitting there for
  // the NEXT room's workspace to collect.
  state.recRecoveryError = null;

  // ADD-24/ADD-25: a locked room leaves no decrypted media staged for the
  // streaming protocol, no waveform envelopes, no staged preview pages still
  // readable at `roomdoc://localhost/<token>`, no unencrypted "open in
  // browser" temp files past their hand-off grace period, and no agent↔UI
  // round-trip left hanging.
  if (deps.clearEphemeralCaches) {
    deps.clearEphemeralCaches();
  } else {
    logNotImplemented(
      "MediaStreams/PeakCache/SlideCache/HtmlPreviews/cleanup_browser_previews_older_than/AgentUi",
      "no Electron equivalents exist yet for these six pieces of decrypted/staged room state"
    );
  }

  // The AI service keeps its compacted digests of this conversation in memory,
  // keyed by content hash, and outlives every room — nothing had ever asked it
  // to let go. Fire-and-forget on purpose: a lock must never block on it.
  if (deps.forgetRoomMemory) {
    deps.forgetRoomMemory();
  } else {
    logNotImplemented(
      "sidecar::forget_room_memory",
      "sidecar.ts has no process-lifecycle half yet"
    );
  }

  if (deps.emit) {
    deps.emit("mcp-status", []);
  }
}

/**
 * Ported from `close_room`. Refuses mid-rollback (Wave 3, Idea 9): the
 * rollback path tears the room down itself, and a user LOCKING mid-rollback
 * would otherwise get the room reopened under them. Drains in-flight work
 * first — best-effort, its report deliberately unchecked, matching Rust's own
 * comment that the teardown below is the correctness backstop.
 *
 * Note what this does NOT do: SEC-7 used to VACUUM here whenever more than
 * 10 MB was reclaimable, which made "Lock" rewrite the entire (possibly
 * multi-GB) room file with no message, no progress and no way to skip.
 * Compacting is now only ever the explicit Settings action; locking just locks.
 */
export async function closeRoom(state: RoomManagerState, deps: RoomManagerDeps): Promise<void> {
  if (state.rollingBack) {
    throw new Error(ROLLBACK_BUSY);
  }
  await drainInflight(state, deps);
  teardownOpenRoom(state, deps);
}
