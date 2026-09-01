/**
 * THE MAIN-PROCESS BOOTSTRAP — the first thing in this migration that creates
 * a real `BrowserWindow`, loads a real preload script through `contextBridge`,
 * registers the IPC surface on a real `ipcMain`, installs the real native menu
 * and answers the renderer's real `getDisplayMedia` request. Everything before
 * this step was ported logic reachable only from its own `.test.ts`.
 *
 * ============================================================================
 * STARTUP ORDER (plan Part B §11) — what's implemented, what's deferred
 * ============================================================================
 *   1. single-instance lock                                     — IMPLEMENTED
 *   2. stable `userData` path (before `whenReady`, per Electron's own
 *      requirement that `setPath("userData")` precede the ready event)
 *                                                                — IMPLEMENTED
 *   3. `obs.init` — the host event log                           — IMPLEMENTED
 *   4. geometry restored BEFORE the window is created, so the remembered
 *      rectangle can be passed to the constructor directly       — IMPLEMENTED
 *   5. the native menu and the quit door, built BEFORE the IPC registry
 *      because four of the registry's channels (`set_unsaved_edits`,
 *      `quit_guard_rearm`, `quit_guard_confirm`, `menu_sync`) act on exactly
 *      these two objects                                          — IMPLEMENTED
 *   6. register every IPC handler, BEFORE the window exists, so no early
 *      renderer `invoke()` can race an unregistered channel      — IMPLEMENTED
 *      — `registerAllIpc`'s `completeness.ok` is asserted here as a HARD boot
 *        invariant: `false` throws and crashes startup rather than shipping a
 *        half-wired registry silently. This is the runtime enforcement half of
 *        `ipc/registry.ts`'s completeness guarantee — the third place the same
 *        check runs, after "at compile time" and "in the test suite".
 *   7. create the (hidden) window                                — IMPLEMENTED
 *   8. `session.setDisplayMediaRequestHandler` on THAT window's own session
 *                                                                — IMPLEMENTED
 *   9. load the renderer — `bootStub.html`, see its own comment  — IMPLEMENTED
 *  10. `ready-to-show`                                           — IMPLEMENTED
 *  11. show                                                      — DEFERRED,
 *      DELIBERATELY: there is no real UI behind the stub page yet, and this
 *      step runs headless. The window is constructed with `show: false` and is
 *      never shown unless `ARCELLE_SHOW_WINDOW=1`; a later step (once a real
 *      renderer exists) flips the default.
 *  12. restore connector (MCP) state on unlock                   — DEFERRED:
 *      needs a real `McpManager` (`RoomManagerDeps.mcp`).
 *      `createDefaultRoomManagerDeps` leaves it unset, matching
 *      `roomManager.ts`'s own documented default — a logged no-op skip, never
 *      a fabricated reconnect.
 *  13. sidecar spawn — NOT SOMETHING THIS FILE DOES, BY DESIGN: `sidecar.ts`'s
 *      `ensureUp()` is already called lazily by the command handlers that need
 *      it. Calling it eagerly at boot would be the wrong behavior, not a
 *      deferred one.
 *
 * ============================================================================
 * THE NATIVE MENU AND THE QUIT DOOR
 * ============================================================================
 * `menu.ts` and `quitDoor.ts` were both built and unit-tested standalone; this
 * file is the caller that makes them real. Three decisions worth stating:
 *
 * WHY `buildTemplate`, NOT `menu.ts`'s OWN `build()`. `build()` reaches the
 * real `Menu` through its own lazy `import("electron")` — deliberately, for a
 * caller that has no `Menu` in hand. This bootstrap is not that caller: every
 * Electron primitive it uses arrives as an injected, never-imported-at-module-
 * scope PARAMETER ({@link BootstrapElectron}), which is precisely what lets
 * `index.test.ts` drive the whole startup sequence against fakes in
 * milliseconds. Calling `build()` here would resolve `"electron"` a second
 * way inside the one function those tests must drive — and under plain Node
 * that specifier resolves to a bare path STRING, so destructuring `Menu` off
 * it throws. So `Menu` is injected, and `menu.ts`'s already-pure, already-
 * tested `buildTemplate(onCommand)` supplies the template. `menu.ts` needed no
 * change for this.
 *
 * THE DOOR HAS THREE ENTRANCES, and it needs all three. The menu's own ⌘Q row
 * routes through `menu.dispatch` → `menu.quit` → `quitDoor.holdForUnsaved`,
 * which is the path `menu.ts` was written for. Dock → Quit, ⌘Q while another
 * app menu owns the key, logout and any internal `app.quit()` never touch a
 * menu row at all; `before-quit` is the only hook that sees those, so a second
 * listener asks the same door there. And the WINDOW's own `close` — the red
 * button, ⌘W with no room open — reaches neither of those, which is the
 * entrance the Tauri build did not need here and this one does:
 * `Workspace.tsx` guarded window close in the RENDERER
 * (`getCurrentWindow().onCloseRequested`, which Tauri hands every native close
 * to), and an isolated Electron renderer has no equivalent hook at all. A port
 * that wired only the two quit entrances would have left the red button as a
 * brand-new, silent way to throw an edited note away — the same class of bug as
 * the ⌘Q one this whole door exists to have fixed. All three are fail-open
 * through the SAME latch (`QuitDoor.quitHeld`), so "held once, then goes
 * through on the next press" holds ACROSS the entrances rather than per
 * entrance: a wedged renderer cannot trap the user in the app by any route.
 *
 * THE `before-quit` LISTENER CHECKS FOR A WINDOW FIRST, and the order is
 * load-bearing: `window-all-closed` below calls `app.quit()` after the window
 * is already destroyed, so a door that held there would `preventDefault()` a
 * quit, send `quit-requested` to nobody, and leave a windowless process
 * running that no further ⌘Q can reach. `menu.quit` already handles the same
 * case the same way ("No window left to ask — falls through to appExit"); this
 * listener mirrors it, and deliberately does not even ASK the door when there
 * is no window, so the one-shot latch is not burned by an exit nobody could
 * have answered. The `close` listener needs no such check — the window it is
 * about is the one being closed, and `event.preventDefault()` there keeps it
 * alive to receive the question.
 *
 * HOW A HELD EXIT NOW ENDS. All three answers are real channels
 * (`ipc/registry.ts`'s host-bridge block): `set_unsaved_edits` arms the door,
 * `quit_guard_rearm` cancels a held exit, and `quit_guard_confirm` FINISHES
 * one. That third channel is new in this port and closes a real hole rather
 * than adding surface for its own sake: the Tauri frontend answered "Quit and
 * discard" by calling `@tauri-apps/plugin-process`'s bare `exit(0)`, which an
 * isolated Electron renderer cannot do, so without it the user could confirm
 * the discard and simply watch the app stay open until they pressed ⌘Q again.
 * `confirmQuit` clears BOTH door flags and then runs the real `app.quit()` —
 * see the host bridge below for why the exit is deferred by one turn of the
 * event loop.
 *
 * ============================================================================
 * THE getDisplayMedia HANDLER
 * ============================================================================
 * `renderer/loopbackTap.ts` names this file's obligation outright:
 * "`getDisplayMedia()`'s promise cannot resolve until
 * `session.setDisplayMediaRequestHandler` is registered on the MAIN process".
 * Until it was, that module's seam defaulted to a labelled refusal rather than
 * a promise that hangs forever. This is that registration.
 *
 * THAT PREMISE IS HALF WRONG ON THIS BUILD, and the correction matters more
 * than the quote does. All four configurations were driven against this exact
 * bootstrap (Electron 43.4.1, macOS, headless, real renderer, real request),
 * varying only the registration below:
 *
 *   handler as shipped         audio-only  → resolves, one AUDIO track
 *                              audio+video → resolves, audio + video
 *   NO handler registered      both shapes → reject in <1ms,
 *                                            `NotSupportedError`
 *   handler that never answers both shapes → HANG, never settle at all
 *   handler answering `{}`     audio-only  → `NotAllowedError`
 *                              audio+video → `AbortError`
 *
 * So an UNREGISTERED handler refuses instantly rather than hanging; only a
 * REGISTERED one that never calls its callback hangs. Two things follow.
 * First, `loopbackTap.ts`'s refusing default is still right (it fails with a
 * reason a human can read, where the real call would say only "Not
 * supported") but its stated reason no longer matches this Electron — worth
 * knowing before anyone "fixes" that seam by just calling through. Second,
 * the `callback({})` arm on this handler's rejection path is the difference
 * between rows two and three of that table, i.e. load-bearing rather than
 * defensive — a `desktopCapturer.getSources` that rejects with no arm there
 * is precisely the registered-but-silent handler that hangs forever.
 *
 * A test asserting only "the promise settled" would therefore pass with this
 * whole registration deleted (`NotSupportedError` settles). The real-boot
 * tests assert the GRANT — `resolved:audio` for the primary shape — and one
 * of them reads the host log back to prove the video branch of
 * {@link grantDisplayMediaRequest} genuinely ran inside the live handler.
 *
 * WHICH SESSION: the main window's own (`win.webContents.session`), which is
 * `session.defaultSession` today because this window's `webPreferences` sets
 * no `partition` — asserted for real in `index.electron.test.ts` rather than
 * assumed, and written as `win.webContents.session` so it stays correct if a
 * later window ever does take a partition. Deliberately NOT a private-browser
 * page's session: `browser/webviewManager.ts` gives every browsed page a
 * fresh, never-reused `session.fromPartition(uuid)`, and an untrusted web page
 * is the last thing that should be handed a loopback capture. The recording
 * lane (`renderer/recSessionClient.ts`'s `wireLoopbackTap`) runs in the app's
 * OWN renderer, in this window.
 *
 * WHAT A BROWSED PAGE GETS INSTEAD, since "not this session" leaves the
 * question open: nothing is registered on those per-page sessions, and the
 * measurement below says an unregistered handler REFUSES instantly with
 * `NotSupportedError` — it does not hang and it does not capture. So the
 * absence is already the right answer for the browser lane, and no explicit
 * per-page denial is owed. Worth having checked rather than assumed: the
 * opposite result (a hang) would have been a web page able to wedge its own
 * tab on a promise nothing answers.
 *
 * WHAT IT ANSWERS, matched to `loopbackTap.ts`'s two documented request
 * shapes, in {@link grantDisplayMediaRequest}:
 *   - `videoRequested === false` — the PRIMARY, audio-only ask
 *     (`SYSTEM_AUDIO_CONSTRAINTS`) — is granted `{audio: "loopback"}` with no
 *     video source at all, so no picker of any kind is shown and no screen
 *     capture starts. This is the path the app actually takes.
 *   - `videoRequested === true` is reachable ONLY through
 *     `SYSTEM_AUDIO_FALLBACK_CONSTRAINTS`, the retry `acquireSystemAudio`
 *     makes when a Chromium build refuses `video: false` on principle. It is
 *     granted a screen source picked programmatically through
 *     `desktopCapturer.getSources` — Electron's own documented recipe for this
 *     handler, not a UI invented here. Refusing it instead was considered and
 *     rejected: `loopbackTap.ts` throws that video track away the instant the
 *     stream arrives (its `stopVideoTracks` runs on BOTH paths, precisely
 *     because "a handler that answers with video for an audio-only request
 *     must not leave a live capture running either"), so refusing would kill
 *     that module's only fallback and leave system audio impossible on exactly
 *     the builds it was written for. It is logged (`obs.warn`) because taking
 *     that path at all is a fact worth seeing, and it grants audio alone when
 *     no source is available rather than failing the whole request.
 *   A REAL, SEPARATE FOLLOW-UP, flagged rather than faked: if a future caller
 *   ever needs the USER to choose which screen or window is captured, that
 *   needs either a picker UI (none exists in this tree) or Electron's
 *   `useSystemPicker` (macOS 15+, documented experimental, and reported to
 *   hang `getDisplayMedia` outright — electron/electron#45306). This file
 *   leaves `useSystemPicker` at its default and builds no UI.
 *
 * DOES macOS LOOPBACK ACTUALLY WORK? Partly answered, and worth writing down
 * because the sources disagree. The bundled `electron.d.ts` still documents
 * `audio: "loopback"` as "currently only supported on Windows", while the
 * migration plan (D1/D7) and `loopbackTap.ts` both assume a macOS CoreAudio
 * tap. MEASURED, on this Mac, on Electron 43.4.1, through the real renderer of
 * the real spawned process (`index.electron.test.ts`): a genuine
 * `getDisplayMedia({audio: true, video: false})` RESOLVES with a stream
 * carrying exactly one track, and that track's `kind` is `"audio"` — checked,
 * because "one track" alone would also describe the video-only stream a
 * handler that ignored the audio half would hand back. So the audio-only shape
 * is granted on macOS, the `.d.ts`
 * comment is stale, and — worth stating since it is the shape
 * `loopbackTap.ts` actually calls with — `video: false` is NOT refused by this
 * build, so the fallback branch above is the rare path, not the usual one.
 *
 * NOT ANSWERED, and a real follow-up rather than a guess: whether that track
 * carries the system's audio or silence. A headless run with no TCC grant and
 * no playing audio cannot tell the two apart. Third-party research claims
 * macOS loopback needs two Chromium features
 * (`MacLoopbackAudioForScreenShare`, `MacSckSystemAudioLoopbackOverride`)
 * enabled via `app.commandLine.appendSwitch("enable-features", …)` before
 * `whenReady`. That was tried here, both ways, and made NO observable
 * difference — the call resolves with one track either way — so this file does
 * NOT set them: a global Chromium feature override that changes nothing
 * measurable is exactly the unverified config this port should not ship, and
 * `appendSwitch` on a repeated switch name replaces rather than appends, so it
 * is not even free. Whoever next has a real Mac, a real meeting and Screen &
 * System Audio Recording permission should check for silence FIRST, and only
 * then reach for those flags.
 *
 * ============================================================================
 * A LIVE CmdCtx — AND WHY IT IS WIRED IN THE REGISTRY, NOT HERE
 * ============================================================================
 * `liveContext.ts`'s `assembleLiveContext` is the real `RunCommandDeps`/
 * `CmdCtx`/`ExecToolDeps` object graph, built and tested but never called by
 * anything in production. The channel that needs it (`run_command`) is
 * registered in `ipc/registry.ts` alongside every other channel, NOT directly
 * on `ipcMain` here — because `registerAllIpc`'s recording shim is what makes
 * the completeness invariant true. A channel registered outside it is a
 * channel the registry still reports as an unwired gap while it is in fact
 * live, which is exactly the drift `KNOWN_UNREGISTERED_COMMANDS` exists to
 * make impossible. What this file owns is the {@link HostBridge} it hands in:
 * the quit door and the live menu, the two objects the registry cannot build
 * for itself. `ask`/`cancel_ask`/`handoff_chat` and the wider `exec_tool`
 * dispatch surface stay unwired — they need a live room MCP bridge that
 * `liveContext.ts`'s own doc says this migration has not stood up.
 *
 * ============================================================================
 * THE WEBREQUEST FUNNEL — CONFIRMED CORRECT AS IS, NOTHING WIRED HERE
 * ============================================================================
 * Re-read for this step and left untouched, deliberately.
 * `browser/webRequestFunnel.ts` is registered per page, on that page's own
 * fresh ephemeral session, by `browser/webviewManager.ts`'s `createLivePage`
 * — before the page's `WebContentsView` even exists, so no opening burst can
 * escape it. There is no default/root session for it to additionally bind to:
 * `onBeforeRequest` keeps at most ONE listener per session, and this window's
 * session never hosts a browsed page. `webviewManager.ts` has no manager
 * object to construct either — it is free functions called by `browser.ts`'s
 * tab-tracking class, which is reachable only through the `browser_*` IPC
 * surface. That surface is unwired on purpose: `browser/browseCommands.ts`'s
 * own doc says it "needs an explicit owner go-ahead", and all sixteen channels
 * remain in `KNOWN_UNREGISTERED_COMMANDS`. So the funnel is unreachable end to
 * end because the gated batch above it has not shipped, not because its own
 * wiring is wrong — and `browser/browserLive.test.ts` already proves for real
 * (spawned Electron, real local server) that it cancels a request when it IS
 * reached. Wiring the browser lane is that batch's work, not this one's.
 *
 * ============================================================================
 * SANDBOX: sandboxed renderer + one bundled CommonJS preload
 * ============================================================================
 * Electron does not support ESM imports in a sandboxed preload. The production
 * build therefore bundles the preload and its allowlists into ONE CommonJS
 * file (`index.cjs`). This keeps `sandbox`, `contextIsolation`, and the absence
 * of renderer Node integration enabled together. The preload receives only
 * Electron's restricted sandbox `require` and exposes the narrow Arcelle bridge.
 *
 * ============================================================================
 * WHY "PURE PIECES" + A GUARDED TAIL
 * ============================================================================
 * {@link bootstrap} takes its Electron primitives (`app`, `BrowserWindow`,
 * `screen`, `ipcMain`, `Menu`, `desktopCapturer`) as PARAMETERS, typed against
 * the real module but never imported at module-evaluation time — the same
 * "accept `ipcMain` as a parameter" convention every `registerXIpc` module in
 * this tree follows, extended one layer up to the whole bootstrap. That is
 * what lets `index.electron.test.ts` launch the REAL compiled output as a real
 * Electron process (proving the actual integration) while `index.test.ts`
 * still checks the startup SEQUENCE — the lock refusal, the completeness
 * invariant, the geometry math, the menu template's real click closures, the
 * quit door's hold/re-arm/fail-open, the display-media answer, and a real
 * `#command` against a real room — against fakes, in milliseconds, without
 * spawning a process per edge case.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  App,
  BrowserWindow as BrowserWindowType,
  CustomScheme,
  DisplayMediaRequestHandlerHandlerRequest,
  IpcMain,
  Menu as ElectronMenuType,
  Streams as DisplayMediaStreams,
  Video as DisplayMediaVideo,
} from "electron";

import * as obs from "./obs.js";
import {
  GeometryStore,
  MIN_H,
  MIN_W,
  type Geometry,
  type Screen as GeometryScreen,
} from "./windowGeometry.js";
import {
  createLiveRoomManagerDeps,
  createRoomManagerState,
  registerAllIpc,
  type CompletenessReport,
  type HostBridge,
} from "./ipc/registry.js";
import { invalidateFileContentCacheForEvent, type FileRuntimeStores } from "./fileRuntimeSurfaceIpc.js";
import { createLiveUpdater } from "./updater/liveUpdater.js";
import { mediaStreamingResponse } from "./mediaTools.js";
import { buildTemplate, dispatch, menuSync, type DispatchDeps, type MainWindowLike } from "./menu.js";
import { QuitDoor, QUIT_REQUESTED } from "./quitDoor.js";
import type { DialogDeps } from "./dialogTools.js";
import { execFileOpenWithApp, type ShellDeps } from "./shellTools.js";

/** The default window size before any remembered geometry is restored —
 * `windowGeometry.ts`'s own documented prior default, kept here rather than in
 * that file since it is a `BrowserWindow` construction detail, not geometry
 * math. */
const DEFAULT_WIDTH = 1180;
const DEFAULT_HEIGHT = 780;

/** The boot-proof stub page — see its own file comment for why this exists
 * instead of a real renderer. */
const BOOT_STUB_FILE = "bootStub.html";

/**
 * Electron normally derives `userData` from the package's npm `name`. That is
 * not a durable application identity: moving this project into an npm
 * workspace changed the package name from `arcelle-electron` to
 * `@arcelle/desktop`, silently moving the profile and making existing recent
 * rooms appear to vanish. Pin the historical directory explicitly so future
 * repository/package reorganizations cannot move user preferences again.
 */
export const STABLE_USER_DATA_DIR_NAME = "arcelle-electron";

export function stableUserDataPath(appDataDir: string): string {
  return path.join(appDataDir, STABLE_USER_DATA_DIR_NAME);
}

/** The compiled preload script this window loads. `tsc` mirrors the source
 * tree under `outDir`; `scripts/bundlePreload.mjs` then emits the one-file
 * sandboxed CommonJS entry beside that tree. */
export function preloadPath(distDir: string): string {
  return path.join(distDir, "..", "preload", "index.cjs");
}

/** Convert Electron's `screen.getAllDisplays()` into `windowGeometry.ts`'s
 * plain `[x, y, width, height]` tuples — DIP, matching that file's own
 * documented unit choice. Takes the already-resolved bounds rather than the
 * `Electron.Screen` module, so the geometry decision stays testable with a
 * plain array of rectangles. */
export function displaysToGeometryScreens(
  displays: readonly { bounds: { x: number; y: number; width: number; height: number } }[]
): GeometryScreen[] {
  return displays.map((d): GeometryScreen => [d.bounds.x, d.bounds.y, d.bounds.width, d.bounds.height]);
}

export interface ReadyMarker {
  event: "arcelle_main_ready";
  registeredChannelCount: number;
  totalCommandCount: number;
  completenessOk: boolean;
  windowId: number;
}

/** The fixed line prefix a launcher (and `index.electron.test.ts`) greps
 * stdout for — a plain, stable string rather than JSON-parsing arbitrary log
 * noise around it. */
export const READY_MARKER_PREFIX = "ARCELLE_MAIN_READY ";

/** Schemes that must be registered before Electron becomes ready.
 *
 * `supportFetchAPI` alone only teaches Chromium that a custom scheme can be
 * fetched. The renderer is loaded from `file://`, so reading a staged room
 * file is also a cross-origin request. `corsEnabled` makes Chromium evaluate
 * the `Access-Control-Allow-Origin` header emitted by `mediaTools.ts`; without
 * it `<img>`/`<audio>` resource loads happened to work while JavaScript
 * `fetch()` (used by the PDF, workbook, document and archive viewers) failed
 * before the protocol response reached the viewer.
 */
export const PRIVILEGED_SCHEMES: CustomScheme[] = [
  {
    scheme: "roomdoc",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: "roommedia",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
];

/** Render {@link ReadyMarker} as the exact line printed to stdout. Exported so
 * a test constructs the same string it expects to find, rather than
 * hand-duplicating the format. */
export function formatReadyMarker(marker: ReadyMarker): string {
  return `${READY_MARKER_PREFIX}${JSON.stringify(marker)}`;
}

// ============================================================================
// getDisplayMedia
// ============================================================================

/**
 * What {@link grantDisplayMediaRequest} needs beyond the request itself — one
 * seam, for the one branch that needs it. `null` means "no capturable source
 * exists" (a headless run with no display), not "the call failed".
 */
export interface DisplayMediaSourceDeps {
  getScreenSource(): Promise<DisplayMediaVideo | null>;
}

/**
 * Answer one real `setDisplayMediaRequestHandler` request — see the module
 * doc's "THE getDisplayMedia HANDLER" for both branches and why the
 * video-requested one grants rather than refuses.
 *
 * Pure but for `deps`, and exported, so both answers are driven directly by
 * `index.test.ts` instead of being reachable only through a real capture.
 */
export async function grantDisplayMediaRequest(
  request: Pick<DisplayMediaRequestHandlerHandlerRequest, "videoRequested">,
  deps: DisplayMediaSourceDeps
): Promise<DisplayMediaStreams> {
  if (!request.videoRequested) {
    return { audio: "loopback" };
  }
  // Only `loopbackTap.ts`'s fallback shape reaches here, and only on a build
  // that refused the audio-only ask outright — worth a line in the host log,
  // because "system audio needed the video fallback" is not something anyone
  // would otherwise ever learn.
  obs.warn("display_media_video_fallback", []);
  const source = await deps.getScreenSource();
  return source === null ? { audio: "loopback" } : { video: source, audio: "loopback" };
}
import { bootstrap, handleBootstrapFailure } from "./bootstrapElectron.js";
export { roomDocResponse, roomMediaResponse, bootstrap, handleBootstrapFailure } from "./bootstrapElectron.js";
export type { BootstrapElectron, BootstrapOptions, BootstrapResult } from "./bootstrapElectron.js";


// ============================================================================
// Real entrypoint — only runs when this file is executed AS Electron's main
// process script, never when imported by a test for its exported pieces.
// ============================================================================
if (
  typeof process !== "undefined" &&
  process.versions?.electron !== undefined &&
  process.type === "browser"
) {
  const electronModule = await import("electron");
  electronModule.protocol.registerSchemesAsPrivileged(PRIVILEGED_SCHEMES);
  void bootstrap({
    electron: {
      app: electronModule.app,
      BrowserWindowCtor: electronModule.BrowserWindow,
      screen: electronModule.screen,
      ipcMain: electronModule.ipcMain,
      Menu: electronModule.Menu,
      desktopCapturer: electronModule.desktopCapturer,
      dialog: electronModule.dialog,
      shell: electronModule.shell,
      protocol: electronModule.protocol,
    },
    resourcesPath: electronModule.app.isPackaged ? process.resourcesPath : null,
    rendererUrl: process.env.ARCELLE_RENDERER_URL,
    rendererFile: process.env.ARCELLE_RENDERER_URL || process.env.ARCELLE_USE_BOOT_STUB === "1"
      ? undefined
      : path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "renderer", "index.html"),
    showWindow: process.env.ARCELLE_SHOW_WINDOW !== "0",
    userDataDirOverride: process.env.ARCELLE_USER_DATA_DIR,
  }).catch(handleBootstrapFailure.bind(null, electronModule.app));
}

export { BOOT_STUB_FILE, DEFAULT_HEIGHT, DEFAULT_WIDTH };
