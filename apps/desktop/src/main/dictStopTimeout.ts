/**
 * Dictation's stop wait — how long a caller should give the final decode
 * before concluding it is wedged.
 *
 * Ported from `src-tauri/src/commands/stt_cmds.rs:566-581`:
 *
 * ```rust
 * const DICT_STOP_BASE: std::time::Duration = std::time::Duration::from_secs(120);
 * const DICT_STOP_PER_AUDIO_SEC: u32 = 2;
 *
 * fn dict_stop_timeout(captured: std::time::Duration) -> std::time::Duration {
 *     DICT_STOP_BASE + captured * DICT_STOP_PER_AUDIO_SEC
 * }
 * ```
 *
 * The final decode is ONE whole-utterance pass over everything spoken, so its
 * cost grows with the dictation while a flat ceiling does not — at 120s flat,
 * stopping a several-minute dictation threw away a transcript that was still
 * being produced (and the composer's painted partials with it). The base
 * still covers a short dictation that is merely queued behind a busy STT
 * context. `Duration`'s multiply-by-`u32` and add are exact (nanosecond
 * integer arithmetic), so the Rust function never rounds; this port mirrors
 * that by doing the same multiply/add in plain `number` seconds, exactly as
 * `services/agent-sidecar/src/arcelle_sidecar/stt/dictation.py:314-332` already does for the
 * same reason (its own module docstring §4 explains why the sidecar computes
 * this but does not apply it to itself).
 *
 * ARCHITECTURE: the renderer connects DIRECTLY to `WS /dict/session` for dictation audio —
 * Electron main does not proxy that socket, so it cannot itself run
 * `recv_timeout(wait)` the way Rust's `dict_stop` (stt_cmds.rs:587-610) did.
 * "Electron main enforces the timeout" instead means: Electron main is the
 * trusted, single source of the formula/constants, reachable over IPC, so the
 * renderer's own stop flow (send `{"type":"stop"}` on its WS, await
 * `{"type":"final",...}` under an `AbortController`/`AbortSignal.timeout`)
 * computes its wait from here rather than duplicating the constants in
 * renderer code. Same non-ceiling contract as the Rust original: a timeout
 * here means "give up waiting and tell the user", never "kill the worker".
 *
 * NO IPC WIRING in this batch, same as `browser/browseCommands_a.ts` and
 * `browser/browseCommands_b.ts`: Phase 2 (renderer/preload) needs an
 * explicit owner go-ahead before touching the live shipping app. See
 * {@link registerDictIpc} — it exists, ready to be wired, but nothing here
 * calls it.
 */

import type { IpcMain, IpcMainInvokeEvent } from "electron";

/** stt_cmds.rs:574 — the flat floor: covers a short dictation merely queued
 * behind a busy STT context. Seconds, matching the Rust `Duration`'s unit at
 * its construction site (`from_secs(120)`). */
export const DICT_STOP_BASE_SECS = 120;

/** stt_cmds.rs:577 — seconds of grace per second of audio captured; a decode
 * slower than this is wedged, not working. */
export const DICT_STOP_PER_AUDIO_SEC = 2;

/** The IPC channel name a future preload/renderer batch wires this under. */
export const DICT_STOP_TIMEOUT_CHANNEL = "dict-stop-timeout";

/**
 * Port of `dict_stop_timeout` (stt_cmds.rs:579-581). Given how many seconds
 * of audio were captured, returns how many seconds a caller should wait for
 * the final decode before concluding it is wedged.
 *
 * `capturedSecs` is expected non-negative (Rust's `Duration` cannot represent
 * a negative wait; a plain TS `number` can) — a negative or non-finite input
 * is clamped to 0 rather than propagating a nonsensical wait, since nothing
 * upstream should ever produce one.
 */
export function dictStopTimeoutSecs(capturedSecs: number): number {
  const safeCaptured = Number.isFinite(capturedSecs) && capturedSecs > 0 ? capturedSecs : 0;
  return DICT_STOP_BASE_SECS + safeCaptured * DICT_STOP_PER_AUDIO_SEC;
}

/**
 * {@link dictStopTimeoutSecs} in milliseconds — the unit a renderer's
 * `AbortSignal.timeout`/`setTimeout` actually wants for the stop flow
 * described in this module's header.
 */
export function dictStopTimeoutMs(capturedSecs: number): number {
  return dictStopTimeoutSecs(capturedSecs) * 1000;
}

/**
 * Registers {@link dictStopTimeoutMs} on {@link DICT_STOP_TIMEOUT_CHANNEL} so
 * a future renderer can ask Electron main for its stop-wait instead of
 * duplicating `DICT_STOP_BASE_SECS`/`DICT_STOP_PER_AUDIO_SEC`.
 *
 * Exported and directly testable, but — exactly like every function in
 * `browser/browseCommands_a.ts`/`browser/browseCommands_b.ts` — NOT called
 * from any live main-process entrypoint by this batch. There is no
 * preload/ipcMain registry yet; wiring this in is Phase 2 work pending an
 * explicit owner go-ahead. `ipcMain` is accepted as a parameter (typed
 * against the real `electron` module, never imported at runtime) so this
 * file resolves and tests under plain Node/vitest exactly like `keychain.ts`'s
 * `SafeStorage`-typed functions do.
 */
export function registerDictIpc(ipcMain: Pick<IpcMain, "handle">): void {
  ipcMain.handle(DICT_STOP_TIMEOUT_CHANNEL, (_event: IpcMainInvokeEvent, capturedSecs: number) =>
    dictStopTimeoutMs(capturedSecs),
  );
}
