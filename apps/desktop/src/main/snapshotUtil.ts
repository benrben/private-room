/**
 * ADD-25: whole-window capture of the app's own webview for the agent's
 * `view_screenshot` tool. Ported from `src-tauri/src/snapshot.rs` (141
 * lines total — both `capture_png` cfg branches).
 *
 * THE MECHANISM DELIBERATELY DIFFERS FROM THE RUST SOURCE. Read this before
 * comparing the two line for line:
 *
 * Rust: `WKWebView.takeSnapshot(with:)` only runs on the OS main thread, so
 * `capture_png` has to (a) refuse outright if it is ITSELF called from the
 * main thread — blocking there to wait on a channel would starve the very
 * run loop that delivers the snapshot's completion handler, a real deadlock
 * — and (b) dispatch the actual call through Tauri's `with_webview`, then
 * ferry the PNG bytes back to the (necessarily non-main-thread) caller over
 * an `mpsc` channel with a 5-second `recv_timeout`.
 *
 * Electron: `WebContents.capturePage()` already IS the main-process API —
 * there is no separate "OS main thread" a caller could be running on
 * instead, the way a tokio worker thread is separate from Tauri's macOS main
 * thread — and it is Promise-based, so awaiting it yields the event loop
 * back rather than blocking it. Neither the main-thread refusal nor the
 * cross-thread channel has anything to port: there is no call site from
 * which awaiting this function could deadlock. What DOES carry over
 * unchanged is the bounded wait — a webview that never answers must fail
 * loudly rather than hang the calling agent turn forever — so the same
 * 5-second cap from the Rust source is kept, as {@link SNAPSHOT_TIMEOUT_MS}.
 *
 * The Rust source's null-`wk_ptr` guard ("platform webview pointer was
 * null") has no literal analogue here — there is no raw pointer to be null
 * in JS — but the INTENT (refuse clearly when the webview is already gone,
 * rather than let the underlying call surface some opaque internal error)
 * carries over as an `isDestroyed()` check.
 *
 * Hardware-composited layers (`<video>`, WebGL) can render blank in a
 * `capturePage` snapshot on some GPU paths — the same limitation the Rust
 * source's module doc calls out for `takeSnapshot`. Video frames go through
 * the driver's own frame-grab path instead (the sibling `view_media_frame`
 * tool; unported, see execTool.ts).
 *
 * NOT PORTED HERE — out of scope for snapshot.rs itself, tracked where the
 * missing piece actually lives:
 * - `commands/agent.rs`'s `view_screenshot` exec_tool arm, which wraps this
 *   primitive with the AgentUi screen-driving bridge (the driver-composite
 *   fallback for when the native capture fails), `downscale_png_b64`, and
 *   `perceive_image` — none of which exist in this migration yet. See
 *   execTool.ts's own `NOT_IMPLEMENTED` message on that arm.
 * - `commands/browse.rs`'s `look_png` / `capture_look_png` /
 *   `png_too_small_to_see` (the `browse_look` agent tool's use of this same
 *   primitive to screenshot the PRIVATE BROWSER's page, with mark-badge
 *   paint/un-paint around it) — the whole `browse_*` agent-tool surface is
 *   its own unported batch; see `browseCommands.ts`'s module doc.
 * - `db-host/checkpoints.ts` (ported from `room_checkpoints.rs`) is an
 *   UNRELATED "snapshot": whole-room encrypted DB backup copies, not
 *   pixels. The shared word is coincidence, not overlap — nothing here
 *   duplicates or is duplicated by that module.
 */

import type { NativeImage } from "electron";

/**
 * The slice of `WebContents` this module needs, so the capture logic is
 * testable without a live Electron process — `import "electron"` resolves
 * to the binary's own path (not the API object) under this workspace's
 * plain-Node vitest runner; see webviewManager.ts's header for the fuller
 * story. A real `WebContents` (the app's own window, or one of BROWSE-1's
 * per-tab `WebContentsView`s — both are the same Electron type, matching how
 * `capture_png` took either a `WebviewWindow` or a `Webview` through one
 * `tauri::Webview` reference) satisfies this with no adapter.
 */
export interface CapturableWebContents {
  isDestroyed(): boolean;
  capturePage(): Promise<Pick<NativeImage, "toPNG">>;
}

/** Matches `capture_png`'s `#[cfg(not(target_os = "macos"))]` stub verbatim. */
export const NON_MACOS_SNAPSHOT_ERROR = "Screenshots are only supported on macOS.";

/**
 * How long to wait for a snapshot before giving up. Mirrors the Rust
 * source's `Duration::from_secs(5)` — same number, same purpose (a bounded
 * wait against a webview that never answers), even though the mechanism that
 * needed a timeout on the Rust side (a cross-thread channel recv) doesn't
 * exist here; see the module doc.
 */
export const SNAPSHOT_TIMEOUT_MS = 5000;

const IS_MACOS = process.platform === "darwin";

/**
 * Our own "nothing came back at all" signal, so the two failure modes are
 * told apart by IDENTITY rather than by sniffing an error's message text.
 *
 * They are structurally separate in the Rust source and cannot be confused
 * there: a completion-handler failure is always wrapped as `webview snapshot
 * failed: {msg}` from inside the block, while the timeout is a caller-side
 * `rx.recv_timeout` branch that fires only when the handler never sent
 * anything. A message-prefix check collapsed that distinction — a webview
 * that DID answer, with an error that happened to mention a timeout, was
 * reported as our own silence, hiding the reason the caller needed.
 */
class SnapshotTimeout extends Error {}

/**
 * Capture a hosted webview as PNG bytes. Ported from `capture_png`.
 *
 * `isMacOS` and `timeoutMs` default to the real platform check and
 * {@link SNAPSHOT_TIMEOUT_MS}; both are overridable purely so tests can
 * exercise the non-macOS branch and the timeout branch without depending on
 * the test runner's platform or waiting out a real 5 seconds.
 */
export async function captureWebviewPng(
  webContents: CapturableWebContents,
  isMacOS: boolean = IS_MACOS,
  timeoutMs: number = SNAPSHOT_TIMEOUT_MS
): Promise<Buffer> {
  if (!isMacOS) {
    throw new Error(NON_MACOS_SNAPSHOT_ERROR);
  }
  if (webContents.isDestroyed()) {
    throw new Error("the webview has already been destroyed");
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new SnapshotTimeout(`timed out waiting for the webview snapshot (${timeoutMs / 1000}s)`)
      );
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    const image = await Promise.race([webContents.capturePage(), timeout]);
    return image.toPNG();
  } catch (err) {
    if (err instanceof SnapshotTimeout) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`webview snapshot failed: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}
