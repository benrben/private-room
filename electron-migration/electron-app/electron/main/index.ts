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
 *   2. `userData` override (before `whenReady`, per Electron's own
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
 * SANDBOX: `sandbox: false`, tested rather than assumed
 * ============================================================================
 * D10 requires `contextIsolation: true` and no `nodeIntegration` in the page —
 * both set below. `sandbox` is a THIRD, separate knob: it additionally forces
 * the PRELOAD SCRIPT through Electron's sandboxed preload loader, which does
 * not understand ES module `import`/`export` syntax regardless of this
 * package's `"type": "module"`. Found empirically, on the real binary, by both
 * merge candidates independently: `Unable to load preload script …
 * SyntaxError: Cannot use import statement outside a module`, thrown from
 * `node:electron/js2c/sandbox_bundle`'s `runPreloadScript`; renaming the
 * compiled output to `.mjs` changed nothing.
 *
 * `false` here does NOT reopen the isolated-world boundary D10 cares about — a
 * sandboxed and a non-sandboxed preload are equally unable to hand the
 * renderer raw Node access once `contextIsolation: true` + `nodeIntegration:
 * false` are set; `sandbox` only restricts what the preload script ITSELF may
 * do, which this preload never needs. Restoring `sandbox: true` means compiling
 * this one preload entry to CommonJS specifically — a genuinely separate build
 * step for exactly one file, real scoped follow-up work for whoever next
 * touches preload packaging, not a config flag.
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
  DisplayMediaRequestHandlerHandlerRequest,
  IpcMain,
  Menu as ElectronMenuType,
  Streams as DisplayMediaStreams,
  Video as DisplayMediaVideo,
} from "electron";

import * as obs from "./obs.js";
import { GeometryStore, MIN_H, MIN_W, type Screen as GeometryScreen } from "./windowGeometry.js";
import {
  createDefaultRoomManagerDeps,
  createRoomManagerState,
  registerAllIpc,
  type CompletenessReport,
  type HostBridge,
} from "./ipc/registry.js";
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

/** The compiled preload script this window loads. `tsc` mirrors the source
 * tree under `outDir`, so `electron/preload/index.ts`'s compiled output sits at
 * `<outDir>/electron/preload/index.js` — a SIBLING of `<outDir>/electron/main`
 * (this file's own compiled directory), not nested under it. */
export function preloadPath(distDir: string): string {
  return path.join(distDir, "..", "preload", "index.js");
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

// ============================================================================
// bootstrap
// ============================================================================

/** Everything {@link bootstrap} needs from the real `electron` module, narrowed
 * to exactly the members it calls. `BrowserWindowCtor` is `typeof
 * BrowserWindow` itself (a class, called with `new`), not an instance. */
export interface BootstrapElectron {
  app: Pick<
    App,
    | "requestSingleInstanceLock"
    | "on"
    | "whenReady"
    | "getVersion"
    | "getPath"
    | "setPath"
    | "quit"
    | "isPackaged"
  >;
  BrowserWindowCtor: new (opts: ConstructorParameters<typeof BrowserWindowType>[0]) => BrowserWindowType;
  /** Narrowed to exactly the shape {@link displaysToGeometryScreens} reads
   * rather than the real `Electron.Display[]` — the real
   * `screen.getAllDisplays()` satisfies this structurally, and a test double
   * only needs to provide `bounds`. */
  screen: {
    getAllDisplays(): readonly { bounds: { x: number; y: number; width: number; height: number } }[];
  };
  ipcMain: Pick<IpcMain, "handle">;
  /** The two static members this file calls — see the module doc's "WHY
   * `buildTemplate`, NOT `menu.ts`'s OWN `build()`". */
  Menu: Pick<typeof ElectronMenuType, "buildFromTemplate" | "setApplicationMenu">;
  /** `arcelle.dialog`'s three native panels — handed straight to
   * `dialogTools.ts`, which owns every decision about them. */
  dialog: DialogDeps["dialog"];
  /** `arcelle.shell` — same, for `shellTools.ts`. The `/usr/bin/open -a`
   * bridge is NOT part of this injected surface: it is a fixed system binary
   * with no Electron involvement, so `bootstrap` supplies the real
   * `execFileOpenWithApp` itself and a test overrides it through
   * {@link BootstrapOptions.openWithApp}. */
  shell: ShellDeps["shell"];
  /** Only reached by {@link grantDisplayMediaRequest}'s video-requested
   * branch — `loopbackTap.ts`'s fallback shape. */
  desktopCapturer: {
    getSources(options: { types: Array<"screen" | "window"> }): Promise<DisplayMediaVideo[]>;
  };
}

export interface BootstrapOptions {
  electron: BootstrapElectron;
  /** Overrides `app.getPath("userData")` — the seam
   * `index.electron.test.ts` uses to point a real launched process at an
   * isolated temp directory instead of this Mac's real Arcelle user-data
   * folder. Production passes nothing and gets the real Electron default. */
  userDataDirOverride?: string;
  /** `process.resourcesPath`, or `null` for a build with no bundled STT
   * weights (every dev/test run and every unpackaged launch). */
  resourcesPath: string | null;
  /** Show the window once it is ready to be shown. Defaults to `false` — see
   * the module doc's step 11. */
  showWindow?: boolean;
  /** Directory the compiled `index.js` lives in, used to resolve the preload
   * script and the boot stub page. Defaults to this module's own directory;
   * a test overrides it only when it needs to. */
  distDir?: string;
  /** `shellTools.ts`'s `/usr/bin/open -a <app> <target>` bridge. Defaults to
   * the real {@link execFileOpenWithApp}; overridden ONLY by a test, which must
   * never spawn a real process — the one seam in this bootstrap that is not an
   * Electron primitive, because it is not one. */
  openWithApp?: ShellDeps["openWithApp"];
}

export interface BootstrapResult {
  window: BrowserWindowType;
  completeness: CompletenessReport;
  marker: ReadyMarker;
}

/**
 * Run the real startup sequence (module doc steps 1-11) against a real (or
 * fake, structurally-typed) `electron` module. Resolves once the window has
 * fired `ready-to-show` AND the boot-proof stub page has finished loading —
 * i.e. once every implemented step has genuinely completed, not merely been
 * kicked off.
 */
export async function bootstrap(opts: BootstrapOptions): Promise<BootstrapResult> {
  const { app, BrowserWindowCtor, screen, ipcMain, Menu, desktopCapturer, dialog, shell } =
    opts.electron;
  const distDir = opts.distDir ?? path.dirname(fileURLToPath(import.meta.url));

  // ---- 1. single-instance lock -------------------------------------------
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    throw new Error("Another instance of Arcelle already holds the single-instance lock.");
  }

  // ---- 2. userData override, BEFORE ready ---------------------------------
  // Electron's own requirement: `setPath("userData")` must precede the `ready`
  // event, or Chromium has already created (and started writing to) the
  // default profile directory and the override only half-applies.
  if (opts.userDataDirOverride !== undefined) {
    app.setPath("userData", opts.userDataDirOverride);
  }

  await app.whenReady();
  const userDataDir = app.getPath("userData");

  // ---- 3. obs.init ---------------------------------------------------------
  obs.init(app.getVersion());
  obs.info("app_start", [["version", obs.model(app.getVersion())]]);

  // ---- 4. geometry (restored before the window is created) -----------------
  const geometryStore = new GeometryStore(userDataDir);
  const restored = geometryStore.restore(displaysToGeometryScreens(screen.getAllDisplays()));

  const state = createRoomManagerState();
  let mainWindowRef: BrowserWindowType | null = null;
  const emit = (event: string, payload: unknown): void => {
    if (mainWindowRef !== null && !mainWindowRef.isDestroyed()) {
      mainWindowRef.webContents.send(event, payload);
    }
  };
  /** The app's one window while it is really there — never a label- or
   * webview-scoped lookup (see `menu.ts`'s own warning), and `null` once the
   * window is gone so every caller falls through its own "nothing to ask"
   * branch. ONE liveness predicate, viewed through two narrower types below:
   * `menu.ts` wants something it can `send`/`close`, `dialogTools.ts` wants
   * something Electron will sheet a panel onto, and a real `BrowserWindow`
   * satisfies both. */
  const liveWindow = (): BrowserWindowType | null =>
    mainWindowRef !== null && !mainWindowRef.isDestroyed() ? mainWindowRef : null;
  const getMainWindow = (): MainWindowLike | null => liveWindow();

  // ---- 5. the native menu + the quit door ---------------------------------
  // Before the registry, because three of its channels act on these two.
  const quitDoor = new QuitDoor();
  const dispatchDeps: DispatchDeps = {
    quitDoor,
    getMainWindow,
    isRoomOpen: () => state.room !== null,
    // The same `app.quit()` every other exit path uses, so a quit that was not
    // held still runs `before-quit` (and therefore still saves geometry).
    appExit: () => app.quit(),
  };
  const appMenu = Menu.buildFromTemplate(buildTemplate((id) => dispatch(id, dispatchDeps)));
  Menu.setApplicationMenu(appMenu);

  // ---- 6. register all IPC handlers (compile-checked complete) -------------
  const host: HostBridge = {
    setUnsavedEdits: (on) => quitDoor.setUnsavedEdits(on),
    rearmQuitGuard: () => quitDoor.rearm(),
    confirmQuit: () => {
      quitDoor.confirmQuit();
      // DEFERRED BY ONE TURN, deliberately. This runs inside an
      // `ipcMain.handle` callback: quitting synchronously tears the window (and
      // with it the renderer's IPC channel) down before Electron has replied to
      // the very `invoke` that asked, so the caller's promise rejects with a
      // destroyed-frame error for an operation that in fact succeeded
      // perfectly. `setImmediate` lets the handler return first — the renderer
      // sees a clean resolve, and the exit follows immediately after.
      setImmediate(() => app.quit());
    },
    syncMenu: (view) => menuSync(appMenu, view),
  };
  const dialogDeps: DialogDeps = { dialog, getMainWindow: liveWindow };
  const shellDeps: ShellDeps = { shell, openWithApp: opts.openWithApp ?? execFileOpenWithApp };
  const deps = createDefaultRoomManagerDeps(userDataDir, emit);
  const { registeredChannels, completeness } = registerAllIpc({
    ipcMain,
    state,
    deps,
    emit,
    host,
    dialog: dialogDeps,
    shell: shellDeps,
    userDataDir,
    resourcesPath: opts.resourcesPath,
  });
  if (!completeness.ok) {
    // A hard boot invariant, not a warning: see the module doc's step 6.
    throw new Error(
      "IPC registry is not complete — refusing to boot. " +
        `missingUndocumented=${JSON.stringify(completeness.missingUndocumented)} ` +
        `goneStale=${JSON.stringify(completeness.goneStale)} ` +
        `unexpectedChannels=${JSON.stringify(completeness.unexpectedChannels)}`
    );
  }
  obs.info("ipc_registered", [["count", obs.count(registeredChannels.size)]]);

  // ---- 7. create window ---------------------------------------------------
  const win = new BrowserWindowCtor({
    show: false,
    width: restored?.width ?? DEFAULT_WIDTH,
    height: restored?.height ?? DEFAULT_HEIGHT,
    x: restored?.x,
    y: restored?.y,
    minWidth: MIN_W,
    minHeight: MIN_H,
    webPreferences: {
      preload: preloadPath(distDir),
      // D10: isolated world, contextBridge only, no direct nodeIntegration.
      // `sandbox: false` is deliberate — see the module doc's SANDBOX section.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindowRef = win;

  // A preload that fails to load is otherwise invisible from the main process:
  // the page simply has no `window.arcelle` and every `invoke` call site fails
  // for a reason nothing ever printed. Both of these are diagnostics only.
  win.webContents.on("preload-error", (_event, preloadScriptPath, error) => {
    console.error(
      `ARCELLE_PRELOAD_ERROR ${preloadScriptPath}: ${error.message}\n${error.stack ?? ""}`
    );
  });
  win.webContents.on("console-message", (event) => {
    console.log(`ARCELLE_RENDERER_CONSOLE [${event.level}] ${event.message}`);
  });

  // ---- 8. the real getDisplayMedia handler, on THIS window's session ------
  // See the module doc's "THE getDisplayMedia HANDLER" for which session and
  // why, and for what each branch answers.
  win.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    void grantDisplayMediaRequest(request, {
      getScreenSource: async () => {
        const sources = await desktopCapturer.getSources({ types: ["screen"] });
        return sources[0] ?? null;
      },
    }).then(callback, (err: unknown) => {
      // The callback MUST be called exactly once, on every path: an
      // unanswered request is the hang `loopbackTap.ts` documents, and a
      // rejected promise with no handler here would be exactly that.
      // `callback({})` is Electron's own "denied", which surfaces in the
      // renderer as a `NotAllowedError` that `mapDisplayMediaError` already
      // reports in words.
      obs.warn("display_media_failed", [["err", obs.errKind(String(err))]]);
      callback({});
    });
  });

  // `note()` on every move/resize, `save()` once on quit — the shape
  // `windowGeometry.ts` documents ("this runs on every move and resize") and
  // the only one that survives quitting from FULLSCREEN: `note()` deliberately
  // ignores a fullscreen rectangle, so a note taken solely at close time would
  // record nothing at all and the remembered geometry would be lost.
  const noteGeometry = (): void => {
    const b = win.getBounds();
    geometryStore.note(win.isFullScreen(), { x: b.x, y: b.y }, { width: b.width, height: b.height });
  };
  win.on("resize", noteGeometry);
  win.on("move", noteGeometry);
  app.on("before-quit", () => {
    geometryStore.save();
  });

  // THE QUIT DOOR's second entrance — Dock → Quit, logout, and every internal
  // `app.quit()`, none of which pass through the menu row. See the module
  // doc's "THE DOOR HAS TWO ENTRANCES" and, for the window check, the
  // paragraph after it: with no window there is nobody to ask, so the exit
  // must proceed and the door's one-shot latch must not be spent.
  app.on("before-quit", (event) => {
    const window = getMainWindow();
    if (window === null) {
      return;
    }
    if (!quitDoor.holdForUnsaved(null)) {
      return;
    }
    event.preventDefault();
    window.webContents.send(QUIT_REQUESTED);
  });

  // THE QUIT DOOR's third entrance — the window's own close: the red button,
  // and `menu.dispatch`'s `window.close()` for ⌘W with no room open. Neither
  // reaches a quit hook at all, and the renderer cannot guard this itself the
  // way `Workspace.tsx` did under Tauri. See the module doc's "THE DOOR HAS
  // THREE ENTRANCES".
  //
  // No window check here (unlike `before-quit`): the window this is about is
  // the one being closed, and `preventDefault()` is what keeps it alive long
  // enough to answer.
  win.on("close", (event) => {
    if (!quitDoor.holdForUnsaved(null)) {
      return;
    }
    event.preventDefault();
    win.webContents.send(QUIT_REQUESTED);
  });

  app.on("second-instance", () => {
    if (win.isMinimized()) {
      win.restore();
    }
    win.focus();
  });

  app.on("window-all-closed", () => {
    // Mac-only app. No unsaved-edits guard of its own: the window is already
    // destroyed by the time this fires, so there is nothing left to ask —
    // exactly the case the `before-quit` listener above lets through.
    app.quit();
  });

  // ---- 9 + 10. load the renderer, then wait for ready-to-show -------------
  // The listener is registered BEFORE `loadFile` is awaited, deliberately:
  // `ready-to-show` is emitted on first paint and is NOT ordered after
  // `loadFile`'s `did-finish-load` resolution. Subscribing afterwards races a
  // marker that may already have fired — and losing that race means awaiting a
  // promise nothing will ever settle, i.e. a boot that hangs forever with no
  // error.
  const readyToShow = new Promise<void>((resolve) => {
    win.once("ready-to-show", () => resolve());
  });
  await win.loadFile(path.join(distDir, BOOT_STUB_FILE));
  await readyToShow;

  // ---- 11. show — deliberately deferred by default; see module doc --------
  if (opts.showWindow === true) {
    win.show();
  }

  const marker: ReadyMarker = {
    event: "arcelle_main_ready",
    registeredChannelCount: registeredChannels.size,
    totalCommandCount: completeness.totalCommandCount,
    completenessOk: completeness.ok,
    windowId: win.id,
  };
  // eslint-disable-next-line no-console -- the deliberate, documented boot marker a launcher greps for
  console.log(formatReadyMarker(marker));
  // Also stashed on `globalThis`, for a test driving this process over CDP
  // (`electronApp.evaluate(() => globalThis.__arcelleReady)`) to read directly
  // rather than racing the child's stdout stream, which a launcher may already
  // be consuming before a test can attach its own listener. The stdout line
  // above remains the real, load-bearing ready marker; this is a second, more
  // robust way to observe the SAME fact.
  (globalThis as { __arcelleReady?: ReadyMarker }).__arcelleReady = marker;

  return { window: win, completeness, marker };
}

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
    },
    resourcesPath: electronModule.app.isPackaged ? process.resourcesPath : null,
    showWindow: process.env.ARCELLE_SHOW_WINDOW === "1",
    userDataDirOverride: process.env.ARCELLE_USER_DATA_DIR,
  }).catch((err: unknown) => {
    console.error("Arcelle failed to boot:", err);
    electronModule.app.exit(1);
  });
}
