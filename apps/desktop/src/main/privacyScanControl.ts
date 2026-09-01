/** Cohesive extraction from privacy.ts; the facade preserves its public API. */
import type { PrivacyScanProgress } from "../shared/apiTypes.js";
import { activePolicy, type PolicyDeps, refreshPolicy } from "./privacyPolicy.js";
import { scanPasses } from "./privacyScanRun.js";


/** The one sentence every refusal to scan uses. It is ONE situation — Home's
 * brief and the Settings panel both offer the button — so it must not read as
 * two different problems. Ported verbatim from `SCAN_DOOR_OFF`. */
export const SCAN_DOOR_OFF =
  "Scanning is off while this room's cloud-privacy door is off. Turn the door on and the " +
  "scan starts by itself.";


/** Is the cloud-privacy door effectively ON for the open room? Refreshes the
 * cached policy first, so the answer reflects a switch flipped a moment ago.
 * Ported from `door_is_active`. */
export function doorIsActive(deps: PolicyDeps): boolean {
  refreshPolicy(deps);
  return activePolicy() !== null;
}


/**
 * The USER pressing "Scan now". Unlike {@link schedulePrivacyScan}, which is an
 * internal trigger and is right to be silent, this one answers a person — so a
 * door-off room gets a reason instead of an `Ok(())` that starts nothing (both
 * callers showed a button that did nothing and then went quiet; Settings
 * additionally painted "Starting the scan…" that no event ever cleared).
 * Ported from `start_privacy_scan`.
 *
 * `scan` is REQUIRED here, unlike on the settings commands: this command exists
 * only to make the scanner run, so a caller with nothing wired belongs at the
 * `execTool.ts`-style NOT_IMPLEMENTED layer rather than silently accepting a
 * button press that does nothing — which is the exact failure this function was
 * written to end.
 */
export function startPrivacyScan(scan: PrivacyScanDeps): void {
  if (!doorIsActive(scan)) {
    throw new Error(SCAN_DOOR_OFF);
  }
  schedulePrivacyScan(scan);
}


// ---------------------------------------------------------------------------
// The background scanner
// ---------------------------------------------------------------------------

let scanFlag = false;

export let scanGeneration = 0;

/**
 * Why the LAST scan could not finish, until something reports it.
 *
 * The terminal `privacy-scan` event is emitted once and then gone, and a scan
 * scheduled at room-open can finish before the workspace has mounted its
 * listener — so the one failure this app most owes the user an explanation for
 * could vanish with nobody told. Parked here, it is still there for the
 * mount-time {@link privacyStatus} read. Cleared when the next scan starts, so
 * it only ever describes the most recent attempt.
 */
let lastScanErrorValue: string | null = null;


/** Ported from `scan_running`. Also read by {@link policyPayload}, which
 * withholds the guard model while a scan holds the local model. */
export function scanRunning(): boolean {
  return scanFlag;
}


/** Ported from `last_scan_error`. */
export function lastScanError(): string | null {
  return lastScanErrorValue;
}


export function bumpScanGeneration(): void {
  scanGeneration += 1;
}


/** Test-only: put the scanner's process-wide state back to a clean slate
 * between cases (same convention as {@link setPolicyForTests}). */
export function resetScannerStateForTests(): void {
  scanFlag = false;
  scanGeneration = 0;
  lastScanErrorValue = null;
}


/** The channel name the frontend listens on (`shared/events.ts`'s
 * `"privacy-scan"`). Exported so the window adapter that eventually implements
 * {@link ScanProgressSink} does not have to re-spell it. */
export const PRIVACY_SCAN_EVENT = "privacy-scan";


/** Where `privacy-scan` events go — Rust's `app.emit("privacy-scan", …)`. The
 * same shape `jobs.ts`'s `ProgressSink` uses for the one event IT emits: no
 * `BrowserWindow` wiring exists in this rewrite yet, so a future batch's
 * implementation is a thin `webContents.send(PRIVACY_SCAN_EVENT, payload)`
 * adapter and tests use a recording stub. */
export interface ScanProgressSink {
  emit(payload: PrivacyScanProgress): void;
}


/** Rust's `let _ = app.emit(...)`: a closed window must never fail a scan. */
export function emitSafely(sink: ScanProgressSink, payload: PrivacyScanProgress): void {
  try {
    sink.emit(payload);
  } catch {
    // Swallowed deliberately — see above.
  }
}


/** What the sidecar's `/privacy_scan` answered. */
export interface SidecarPrivacyScanResult {
  entities?: Array<{ text?: string; category?: string }>;
  /** A scan that stopped short (a chunk's model call failed, or the
   * 300-finding cap cut it off) never read the tail of the document. Absent —
   * an older sidecar — is assumed complete, which is the pre-existing
   * behaviour rather than a new silence. */
  complete?: boolean;
}


export function errorCode(e: unknown): string | null {
  if (typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string") {
    return (e as { code: string }).code;
  }
  return null;
}


/**
 * Everything the background scanner needs beyond {@link PolicyDeps} — see the
 * module doc's numbered list, item 3.
 */
export interface PrivacyScanDeps extends PolicyDeps {
  /** `AppState::room_epoch()` — bumped by every room open/teardown. Together
   * with `room.current().path` this is `roomPin.ts`'s pin, which any
   * `RoomPinSource` satisfies structurally. */
  roomEpoch(): number;
  emit: ScanProgressSink;
  /**
   * `crate::sidecar::sidecar_json("/privacy_scan", &body)`. Injected rather
   * than implemented here: the sidecar's `{code, error}` envelope (which is
   * where `"OLLAMA_DOWN"`/`"MODEL_MISSING"` come from, and which the loop below
   * matches on) belongs to the sidecar transport module, and a second spelling
   * of it inside the privacy door is exactly the kind of drift this file's own
   * `privacyTextSha` comment warns about. Rejecting with an object carrying a
   * `code` selects the two stopping branches; anything else is Rust's catch-all
   * `Err(_)` transient-failure branch.
   */
  privacyScanCall: (body: Record<string, unknown>) => Promise<SidecarPrivacyScanResult>;
  /** Resolve the preferred local guard to an installed tag. This matters for
   * builds such as `qwen3.5:4b-mlx`: asking Ollama for the unsuffixed default
   * makes every file look like a transient incomplete scan. */
  resolveGuardModel?: (preferred: string) => Promise<string>;
  /** `!state.cancels.lock().unwrap().is_empty()` — is an interactive ask
   * running right now? */
  isChatBusy: () => boolean;
  /**
   * `crate::ollama::wake_daemon()`. The scanner runs on the LOCAL model, so the
   * daemon must be up — and the Rust guard also keeps the idle watcher from
   * sleeping it again mid-scan. `undefined` skips the wake-and-hold rather than
   * faking it (the daemon-lifecycle port is a documented gap in
   * `engineRouting.ts`); the cost is that an asleep daemon is then discovered
   * one round-trip later, through the same `"OLLAMA_DOWN"` branch this loop
   * needs regardless. A rejection is Rust's `Err(e)` branch, verbatim.
   */
  wakeDaemon?: () => Promise<void>;
  /** `tokio::time::sleep` — the "paused while you chat" poll interval. */
  sleepMs?: (ms: number) => Promise<void>;
}


export function defaultSleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


/** How a scan run ended. Ported from `ScanEnd`. */
export interface ScanEnd {
  /** The user-facing error when the scan could not run. The caller emits
   * exactly ONE terminal event, so an error is never overwritten. */
  error: string | null;
  /** The run was ABANDONED because the room it was scanning was replaced. Not
   * an error the user should read: the room they were in is closed, and its
   * findings are simply not this room's business. */
  roomChanged: boolean;
}


export function scanFinished(error: string | null): ScanEnd {
  return { error, roomChanged: false };
}


export function scanAbandoned(): ScanEnd {
  return { error: null, roomChanged: true };
}


/**
 * Kick the background scanner if the door is on for this room. Idempotent: a
 * second call while one runs is a no-op (the runner re-checks for stale files
 * before exiting, so nothing is missed). Silent on purpose — this is the
 * automatic trigger (an import, a rules change) and nobody asked it a question;
 * {@link startPrivacyScan} is the one that answers. Ported from
 * `schedule_privacy_scan`.
 */
export function schedulePrivacyScan(scan: PrivacyScanDeps): void {
  // Scan only when the switch is effectively ON — scanning is the half that
  // costs compute; with the door off it can wait for the flip.
  if (!doorIsActive(scan)) {
    return;
  }
  if (scanFlag) {
    return; // already running
  }
  scanFlag = true;
  // A new attempt supersedes whatever the last one had to say.
  lastScanErrorValue = null;
  // Fire-and-forget, mirroring `tauri::async_runtime::spawn` — and a spawned
  // tokio task that fails takes nothing with it, whereas an unhandled promise
  // rejection ends the process under Node's default. `runScanAndSettle` already
  // releases the flag and reports the failure in a `finally`; this `.catch` is
  // the backstop for its own tail (the `roomChanged` restart, which re-reads a
  // room that may itself be gone), so a scheduled scan can never be the thing
  // that takes the app down.
  void runScanAndSettle(scan).catch(() => {
    // Reported already, or unreportable: either way the flag is clear.
  });
}


/**
 * A run that ended by THROWING rather than by returning a {@link ScanEnd}.
 *
 * SECOND FIX ON TOP OF THE RUST SOURCE, and the more serious of the two (see
 * {@link runPrivacyScan}'s scan-row branch for the first). Rust cannot reach
 * this state: `run_privacy_scan` reports every failure as a value, and the two
 * DB reads it makes per pass (`get_setting`, `list_privacy_entities`) swallow
 * their errors into `Option`/`unwrap_or_default`. This port's do not —
 * `db-host/util.ts` THROWS by design, and `settings.ts`'s own doc calls that
 * out as a deliberate deviation ("an unset key is an answer, an unreadable
 * `settings` table is not") — and the loop also calls three INJECTED host
 * functions (`room.current`, `roomEpoch`, `isChatBusy`) that are free to throw.
 * A room torn down mid-run, closing its `better-sqlite3` handle between two
 * awaits, is enough: `getSetting(room.db, KEY_CONCEPTS)` throws
 * "The database connection is not open".
 *
 * With `scanFlag = false` sitting after an unguarded `await`, one such throw
 * left the flag TRUE for the rest of the process, which is not a stuck spinner
 * but a silent, permanent PRIVACY DEGRADATION:
 *
 *   - {@link policyPayload} withholds `guard_model` while a scan is running, so
 *     the sidecar's live guard — the half that enforces the user's TOPIC rules
 *     — would never run again on any cloud turn, in any room, for the life of
 *     the app;
 *   - every later {@link schedulePrivacyScan} is swallowed by the idempotence
 *     check, so no newly imported document is ever scanned again;
 *   - {@link privacyStatus} reports `scanning: true` forever, and no terminal
 *     `privacy-scan` event is ever emitted, so the panel agrees with none of it;
 *   - and the rejection escapes as an unhandled promise rejection, which Node
 *     terminates the process on by default.
 *
 * So the flag is released in a `finally`, and the throw is reported the way the
 * loop's own transient-failure path reports one: nothing is claimed to be
 * protected that is not, and the next import or "Scan now" retries.
 */
function scanCrashed(e: unknown): ScanEnd {
  const msg = e instanceof Error ? e.message : String(e);
  return scanFinished(
    `The privacy scan stopped unexpectedly: ${msg}. Anything found so far is protected, the rest ` +
      "is not yet — it will be retried on the next import, or when you press Scan now."
  );
}


async function runScanAndSettle(scan: PrivacyScanDeps): Promise<void> {
  let end: ScanEnd;
  try {
    end = await runPrivacyScan(scan);
  } finally {
    // Released before anything else can fail. {@link runPrivacyScan} is total
    // (see {@link scanCrashed}), so this `finally` has no known way to fire —
    // it is here because holding this flag is worse than every failure it could
    // possibly hide, and that must not depend on a promise kept elsewhere.
    scanFlag = false;
  }
  const { error, roomChanged } = end;
  lastScanErrorValue = error;
  try {
    refreshPolicy(scan);
  } catch {
    // The room whose findings this run just filed is unreadable. Keeping the
    // policy already in the cell is the fail-closed direction `installPolicy`'s
    // own `partial` branch argues for — rules only ever hide more — and it must
    // not cost the user the terminal event below, which is the only thing that
    // clears the panel's progress bar.
  }
  emitSafely(scan.emit, { running: false, done: 0, total: 0, error });
  // The room this run belonged to was replaced. Whatever room is open now asked
  // for its own scan while this one still held the flag and was turned away by
  // the idempotence check above, so it is started here — once, and only after
  // the flag is clear. A run that ends normally never lands here, so this
  // cannot loop.
  if (roomChanged) {
    schedulePrivacyScan(scan);
  }
}


/**
 * Drive one scan run to completion (or abandonment, or a stopping error).
 * Ported from `run_privacy_scan`. Exported for direct async testing —
 * {@link schedulePrivacyScan} is fire-and-forget by design and gives a test
 * nothing to await.
 *
 * TOTAL, exactly as `run_privacy_scan` is: every way a run can end arrives as a
 * {@link ScanEnd}, never as a rejection. The wrapper is what makes that true on
 * this side of the port — see {@link scanCrashed} for the throw surface Rust
 * does not have and for what one escaping throw used to cost.
 */
export async function runPrivacyScan(scan: PrivacyScanDeps): Promise<ScanEnd> {
  try {
    return await scanPasses(scan);
  } catch (e) {
    return scanCrashed(e);
  }
}
