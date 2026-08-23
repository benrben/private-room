/**
 * THE MAIN-PROCESS BOOTSTRAP — the first thing in this migration that creates
 * a real `BrowserWindow`, loads a real preload script through `contextBridge`,
 * and registers the IPC surface on a real `ipcMain`. Everything before this
 * step was ported logic reachable only from its own `.test.ts`.
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
 *   5. register every IPC handler, BEFORE the window exists, so no early
 *      renderer `invoke()` can race an unregistered channel      — IMPLEMENTED
 *      — `registerAllIpc`'s `completeness.ok` is asserted here as a HARD boot
 *        invariant: `false` throws and crashes startup rather than shipping a
 *        half-wired registry silently. This is the runtime enforcement half of
 *        `ipc/registry.ts`'s completeness guarantee — the third place the same
 *        check runs, after "at compile time" and "in the test suite".
 *   6. create the (hidden) window                                — IMPLEMENTED
 *   7. load the renderer — `bootStub.html`, see its own comment  — IMPLEMENTED
 *   8. `ready-to-show`                                           — IMPLEMENTED
 *   9. show                                                      — DEFERRED,
 *      DELIBERATELY: there is no real UI behind the stub page yet, and this
 *      step runs headless. The window is constructed with `show: false` and is
 *      never shown unless `ARCELLE_SHOW_WINDOW=1`; a later step (once a real
 *      renderer exists) flips the default.
 *  10. restore connector (MCP) state on unlock                   — DEFERRED:
 *      needs a real `McpManager` (`RoomManagerDeps.mcp`).
 *      `createDefaultRoomManagerDeps` leaves it unset, matching
 *      `roomManager.ts`'s own documented default — a logged no-op skip, never
 *      a fabricated reconnect.
 *  11. sidecar spawn — NOT SOMETHING THIS FILE DOES, BY DESIGN: `sidecar.ts`'s
 *      `ensureUp()` is already called lazily by the command handlers that need
 *      it. Calling it eagerly at boot would be the wrong behavior, not a
 *      deferred one.
 *
 * ALSO DELIBERATELY NOT BUILT HERE: renderer mic/display capture, and the full
 * macOS app-menu/Quit-door integration (`quitDoor.ts`'s
 * `applicationShouldTerminate` story). `window-all-closed` below calls
 * `app.quit()` with no unsaved-edits guard, which is correct for a window with
 * no real UI to lose edits in and explicitly wrong once a real renderer
 * exists; a later step owns that reconciliation.
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
 * `screen`, `ipcMain`) as PARAMETERS, typed against the real module but never
 * imported at module-evaluation time — the same "accept `ipcMain` as a
 * parameter" convention every `registerXIpc` module in this tree follows,
 * extended one layer up to the whole bootstrap. That is what lets
 * `index.electron.test.ts` launch the REAL compiled output as a real Electron
 * process (proving the actual integration) while `index.test.ts` still checks
 * the startup SEQUENCE — the lock refusal, the completeness invariant, the
 * geometry math — against fakes, in milliseconds, without spawning a process
 * per edge case.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { App, BrowserWindow as BrowserWindowType, IpcMain } from "electron";

import * as obs from "./obs.js";
import { GeometryStore, MIN_H, MIN_W, type Screen as GeometryScreen } from "./windowGeometry.js";
import {
  createDefaultRoomManagerDeps,
  createRoomManagerState,
  registerAllIpc,
  type CompletenessReport,
} from "./ipc/registry.js";

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
   * the module doc's step 9. */
  showWindow?: boolean;
  /** Directory the compiled `index.js` lives in, used to resolve the preload
   * script and the boot stub page. Defaults to this module's own directory;
   * a test overrides it only when it needs to. */
  distDir?: string;
}

export interface BootstrapResult {
  window: BrowserWindowType;
  completeness: CompletenessReport;
  marker: ReadyMarker;
}

/**
 * Run the real startup sequence (module doc steps 1-9) against a real (or
 * fake, structurally-typed) `electron` module. Resolves once the window has
 * fired `ready-to-show` AND the boot-proof stub page has finished loading —
 * i.e. once every implemented step has genuinely completed, not merely been
 * kicked off.
 */
export async function bootstrap(opts: BootstrapOptions): Promise<BootstrapResult> {
  const { app, BrowserWindowCtor, screen, ipcMain } = opts.electron;
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

  // ---- 5. register all IPC handlers (compile-checked complete) -------------
  const state = createRoomManagerState();
  let mainWindowRef: BrowserWindowType | null = null;
  const emit = (event: string, payload: unknown): void => {
    if (mainWindowRef !== null && !mainWindowRef.isDestroyed()) {
      mainWindowRef.webContents.send(event, payload);
    }
  };
  const deps = createDefaultRoomManagerDeps(userDataDir, emit);
  const { registeredChannels, completeness } = registerAllIpc({
    ipcMain,
    state,
    deps,
    emit,
    userDataDir,
    resourcesPath: opts.resourcesPath,
  });
  if (!completeness.ok) {
    // A hard boot invariant, not a warning: see the module doc's step 5.
    throw new Error(
      "IPC registry is not complete — refusing to boot. " +
        `missingUndocumented=${JSON.stringify(completeness.missingUndocumented)} ` +
        `goneStale=${JSON.stringify(completeness.goneStale)} ` +
        `unexpectedChannels=${JSON.stringify(completeness.unexpectedChannels)}`
    );
  }
  obs.info("ipc_registered", [["count", obs.count(registeredChannels.size)]]);

  // ---- 6. create window ---------------------------------------------------
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

  app.on("second-instance", () => {
    if (win.isMinimized()) {
      win.restore();
    }
    win.focus();
  });

  app.on("window-all-closed", () => {
    // Mac-only app; no unsaved-edits guard yet — see the module doc.
    app.quit();
  });

  // ---- 7 + 8. load the renderer, then wait for ready-to-show --------------
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

  // ---- 9. show — deliberately deferred by default; see module doc ---------
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
    },
    resourcesPath: electronModule.app.isPackaged ? process.resourcesPath : null,
    showWindow: process.env.ARCELLE_SHOW_WINDOW === "1",
    userDataDirOverride: process.env.ARCELLE_USER_DATA_DIR,
  }).catch((err: unknown) => {
    console.error("Arcelle failed to boot:", err);
    electronModule.app.exit(1);
  });
}
