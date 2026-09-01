/** Cohesive extraction from roomManager.ts; the facade preserves its public API. */
import { cancelAll } from "./cancel.js";
import { markJobsParking, parkRunningJobs, PARKED_BY_LOCK } from "./jobs.js";
import { takePendingOpen as takePendingOpenSlot } from "./pendingOpen.js";
import { clearPolicy } from "./privacy.js";
import { ROLLBACK_BUSY } from "./turnContext.js";
import { releaseWorkspaceLease } from "./workspace/roomLayout.js";
import { closeQuietly, type DrainReport, logNotImplemented, logSkipped, type RoomManagerDeps, type RoomManagerState } from "./roomManagerState.js";


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


async function stopRoomWorkForDrain(deps: RoomManagerDeps): Promise<void> {
  if (deps.stopRecordingAndWait) {
    await deps.stopRecordingAndWait(30_000);
  } else {
    logNotImplemented(
      "RecState.session (recording engine stop-and-await)",
      "recBridge.ts has no single global live-session slot to stop yet"
    );
  }
  if (deps.stopHarnessRuns) await deps.stopHarnessRuns(10_000);
}


async function cancelAndDrainAsks(
  state: RoomManagerState,
  timing: Required<DrainTiming>,
): Promise<boolean> {
  const askCount = state.cancel.cancels.size;
  for (const flag of state.cancel.cancels.values()) flag.store(true);
  cancelAll(state.cancel);
  return askCount === 0 || await waitUntilEmpty(state.cancel.cancels, timing.askMaxPolls, timing.askPollMs);
}


function markRunningJobsForTeardown(state: RoomManagerState): void {
  if (state.room === null) return;
  try {
    markJobsParking(state.room.conn, PARKED_BY_LOCK);
  } catch {
    // Best-effort, matching Rust's `let _ = state.with_room(...)`.
  }
}


async function cancelAndDrainJobs(
  state: RoomManagerState,
  timing: Required<DrainTiming>,
): Promise<boolean> {
  const jobCount = state.cancel.jobCancels.size;
  for (const flag of state.cancel.jobCancels.values()) flag.store(true);
  return jobCount === 0 || await waitUntilEmpty(state.cancel.jobCancels, timing.jobMaxPolls, timing.jobPollMs);
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
  const resolvedTiming: Required<DrainTiming> = {
    askPollMs: timing.askPollMs ?? 50,
    askMaxPolls: timing.askMaxPolls ?? 20,
    jobPollMs: timing.jobPollMs ?? 100,
    jobMaxPolls: timing.jobMaxPolls ?? 20,
  };

  // ADD-27: a live recording must land in the DB before the room changes.
  // Bounded (Rust's own 30 s) so a stuck decode can never wedge lock/close.
  await stopRoomWorkForDrain(deps);

  // HLT-7: if an answer is streaming, cancel it and wait briefly for its
  // save-partial phase, so the swap never races the DB shut.
  const asksDrained = await cancelAndDrainAsks(state, resolvedTiming);

  // Stamp WHY first, while the room is still open and every runner is still
  // alive. The two landings a moment from now write different statuses, and
  // neither of them knows it was the LOCK that stopped it.
  markRunningJobsForTeardown(state);

  const jobsDrained = await cancelAndDrainJobs(state, resolvedTiming);

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


function signalTeardownCancellation(state: RoomManagerState): void {
  for (const flag of state.cancel.cancels.values()) flag.store(true);
  for (const flag of state.cancel.jobCancels.values()) flag.store(true);
  cancelAll(state.cancel);
}


function stopRecordingForTeardown(deps: RoomManagerDeps): void {
  if (deps.stopRecordingNoWait) {
    deps.stopRecordingNoWait();
    return;
  }
  logNotImplemented(
    "RecState.session (recording engine stop, no wait)",
    "recBridge.ts has no single global live-session slot to stop yet"
  );
}


function closeBrowserForTeardown(deps: RoomManagerDeps): void {
  if (!deps.closeBrowser) {
    logSkipped(
      "browser::close",
      "no closeBrowser supplied (browser/browser.ts's Browser.close() is real)"
    );
    return;
  }
  try {
    deps.closeBrowser();
  } catch {
    // A browser that will not close must not abandon the remaining teardown.
  }
}


function noteRoomClosure(deps: RoomManagerDeps): void {
  if (deps.noteRoomClosed) {
    deps.noteRoomClosed();
    return;
  }
  logNotImplemented(
    "ollama_lifecycle::note_room_closed",
    "see ollamaLifecycle.ts's own module doc — the process lifecycle half is not ported"
  );
}


function releaseOpenRoom(state: RoomManagerState): void {
  const closing = state.room;
  state.room = null;
  if (closing === null) return;
  closing.workspaceRuntimeClosed = true;
  closing.workspaceIndexer?.close();
  if (closing.workspaceWatcher !== undefined) {
    void closing.workspaceWatcher.close().catch(() => undefined);
  }
  closeQuietly(closing.conn);
  if (closing.workspaceLease !== undefined) releaseWorkspaceLease(closing.workspaceLease);
}


function stopRoomServerForTeardown(state: RoomManagerState, deps: RoomManagerDeps): void {
  if (state.roomServer === null) return;
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


function clearMcpForTeardown(deps: RoomManagerDeps): void {
  if (!deps.mcp) {
    logSkipped(
      "mcp manager teardown",
      "no McpManager supplied (mcpClient.ts's McpManager is real)"
    );
    return;
  }
  for (const entry of deps.mcp.servers) entry.client?.close();
  deps.mcp.servers = [];
  deps.mcp.generation += 1;
}


function declinePendingApprovals(state: RoomManagerState): void {
  state.mcpSessionOk.clear();
  for (const resolve of state.mcpPending.values()) resolve({ approved: false, remember: false });
  state.mcpPending.clear();
  for (const resolve of state.editPending.values()) resolve({ approved: false, restOfTurn: false });
  state.editPending.clear();
  for (const resolve of state.scriptPending.values()) resolve({ approved: false, remember: false });
  state.scriptPending.clear();
}


function clearEphemeralRoomState(state: RoomManagerState, deps: RoomManagerDeps): void {
  state.recRecoveryError = null;
  if (deps.clearEphemeralCaches) {
    deps.clearEphemeralCaches();
  } else {
    logNotImplemented(
      "MediaStreams/PeakCache/SlideCache/HtmlPreviews/cleanup_browser_previews_older_than/AgentUi",
      "no Electron equivalents exist yet for these six pieces of decrypted/staged room state"
    );
  }
  if (deps.forgetRoomMemory) {
    deps.forgetRoomMemory();
  } else {
    logNotImplemented(
      "sidecar::forget_room_memory",
      "sidecar.ts has no process-lifecycle half yet"
    );
  }
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
  signalTeardownCancellation(state);

  // Best-effort: tell a live recording engine to stop and flush. No wait.
  stopRecordingForTeardown(deps);

  deps.stopHarnessRunsNoWait?.();

  // BROWSE-1: the private browser must not outlive the room. A LIVE page left
  // floating over a locked room would still be showing whatever the room was
  // looking at, and its agent journal has to flush into the DB while the DB is
  // still open — closed BEFORE the room handle drops, for exactly that reason.
  closeBrowserForTeardown(deps);

  parkInflightJobsForTeardown(state);

  // The warm window is for someone who stepped away from an open room, not for
  // a locked one.
  noteRoomClosure(deps);

  // Rust's `*state.room_guard() = None;` DROPS the Room, closing its
  // connection. JS has no destructor, so the close is explicit — see this
  // file's DEVIATIONS section. Cleared first, so nothing re-entrant can find a
  // room whose handle is on its way out.
  releaseOpenRoom(state);

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
  stopRoomServerForTeardown(state, deps);

  // Dropping the clients kills the server processes (`kill_on_drop` in Rust;
  // here, an explicit close() per client, since JS has no destructor).
  clearMcpForTeardown(deps);

  // SEC-1b: per-call MCP consent is per session — forget it on lock, and drop
  // any in-flight approval requests. See DEVIATION 2: each pending resolver is
  // DECLINED explicitly, because a JS callback never fires on being dropped.
  declinePendingApprovals(state);

  // A parked recording-recovery failure belongs to the room being closed.
  // Nothing else empties it — it is consumed by a workspace MOUNT, and the
  // fallback timer returns without touching it once the room is gone — so a
  // room locked within those two seconds left its message sitting there for
  // the NEXT room's workspace to collect.
  clearEphemeralRoomState(state, deps);

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
