import path from "node:path";
import { fileURLToPath } from "node:url";
import type { App, BrowserWindow as BrowserWindowType, IpcMain, Menu as ElectronMenuType, Video as DisplayMediaVideo } from "electron";
import * as obs from "./obs.js";
import { GeometryStore, MIN_H, MIN_W, type Geometry } from "./windowGeometry.js";
import { createLiveRoomManagerDeps, createRoomManagerState, registerAllIpc, type CompletenessReport, type HostBridge } from "./ipc/registry.js";
import { invalidateFileContentCacheForEvent, type FileRuntimeStores } from "./fileRuntimeSurfaceIpc.js";
import { createLiveUpdater } from "./updater/liveUpdater.js";
import { mediaStreamingResponse } from "./mediaTools.js";
import { buildTemplate, dispatch, menuSync, type DispatchDeps, type MainWindowLike } from "./menu.js";
import { QuitDoor, QUIT_REQUESTED } from "./quitDoor.js";
import type { DialogDeps } from "./dialogTools.js";
import { execFileOpenWithApp, type ShellDeps } from "./shellTools.js";
import { BOOT_STUB_FILE, DEFAULT_HEIGHT, DEFAULT_WIDTH, ReadyMarker, displaysToGeometryScreens, formatReadyMarker, grantDisplayMediaRequest, preloadPath, stableUserDataPath } from "./index.js";



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
  protocol?: {
    handle(scheme: string, handler: (request: Request) => Response | Promise<Response>): void;
  };
}


export interface BootstrapOptions {
  electron: BootstrapElectron;
  /** Overrides Arcelle's pinned `userData` path — the seam
   * `index.electron.test.ts` uses to point a real launched process at an
   * isolated temp directory instead of this Mac's real Arcelle user-data
   * folder. Production passes nothing and uses
   * `<appData>/arcelle-electron`, independent of the npm package name. */
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
  /** Real renderer entry. Tests omit both and retain the tiny boot fixture. */
  rendererFile?: string;
  /** Development Vite server; takes precedence over `rendererFile`. */
  rendererUrl?: string;
  /** `shellTools.ts`'s `/usr/bin/open -a <app> <target>` bridge. Defaults to
   * the real {@link execFileOpenWithApp}; overridden ONLY by a test, which must
   * never spawn a real process — the one seam in this bootstrap that is not an
   * Electron primitive, because it is not one. */
  openWithApp?: ShellDeps["openWithApp"];
  /** Test seam for the registry completeness boot invariant. */
  registerAllIpcFn?: typeof registerAllIpc;
}


export interface BootstrapResult {
  window: BrowserWindowType;
  completeness: CompletenessReport;
  marker: ReadyMarker;
}
export interface BootstrapRuntime {
  mainWindow: BrowserWindowType | null;
  fileRuntimeStores: FileRuntimeStores | null;
}
export function bootstrapDistDir(opts: BootstrapOptions): string {
  return opts.distDir ?? path.dirname(fileURLToPath(import.meta.url));
}
export function claimSingleInstance(app: BootstrapElectron["app"]): void {
  if (app.requestSingleInstanceLock()) return;
  app.quit();
  throw new Error("Another instance of Arcelle already holds the single-instance lock.");
}
export function configureUserData(
  app: BootstrapElectron["app"],
  userDataDirOverride: string | undefined,
): string {
  const userDataDir = userDataDirOverride ?? stableUserDataPath(app.getPath("appData"));
  app.setPath("userData", userDataDir);
  return userDataDir;
}
export function createBootstrapRuntime(): BootstrapRuntime {
  return { mainWindow: null, fileRuntimeStores: null };
}
export function emitToMainWindow(runtime: BootstrapRuntime, event: string, payload: unknown): void {
  if (runtime.fileRuntimeStores) {
    invalidateFileContentCacheForEvent(runtime.fileRuntimeStores, event);
  }
  const window = runtime.mainWindow;
  if (window !== null && !window.isDestroyed()) {
    window.webContents.send(event, payload);
  }
}
export function liveMainWindow(runtime: BootstrapRuntime): BrowserWindowType | null {
  const window = runtime.mainWindow;
  return window !== null && !window.isDestroyed() ? window : null;
}
export function createHiddenWindow(
  BrowserWindowCtor: BootstrapElectron["BrowserWindowCtor"],
  restored: Geometry | null,
  distDir: string,
): BrowserWindowType {
  return new BrowserWindowCtor({
    show: false,
    width: restored?.width ?? DEFAULT_WIDTH,
    height: restored?.height ?? DEFAULT_HEIGHT,
    x: restored?.x,
    y: restored?.y,
    minWidth: MIN_W,
    minHeight: MIN_H,
    webPreferences: {
      preload: preloadPath(distDir),
      // Sandboxed isolated world, contextBridge only, no direct Node access.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
}
export function attachWindowDiagnostics(win: BrowserWindowType): void {
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
}
export function registerDisplayMediaHandler(
  win: BrowserWindowType,
  desktopCapturer: BootstrapElectron["desktopCapturer"],
): void {
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
}
export function attachGeometryAndLifecycleHandlers(
  app: BootstrapElectron["app"],
  win: BrowserWindowType,
  geometryStore: GeometryStore,
  quitDoor: QuitDoor,
  getMainWindow: () => MainWindowLike | null,
): void {
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
    if (window === null) return;
    if (!quitDoor.holdForUnsaved(null)) return;
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
    if (!quitDoor.holdForUnsaved(null)) return;
    event.preventDefault();
    win.webContents.send(QUIT_REQUESTED);
  });

  app.on("second-instance", () => {
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.on("window-all-closed", () => {
    // Mac-only app. No unsaved-edits guard of its own: the window is already
    // destroyed by the time this fires, so there is nothing left to ask —
    // exactly the case the `before-quit` listener above lets through.
    app.quit();
  });
}
export async function loadRendererBeforeReady(
  win: BrowserWindowType,
  opts: BootstrapOptions,
  distDir: string,
): Promise<void> {
  // The listener is registered BEFORE `loadFile` is awaited, deliberately:
  // `ready-to-show` is emitted on first paint and is NOT ordered after
  // `loadFile`'s `did-finish-load` resolution. Subscribing afterwards races a
  // marker that may already have fired — and losing that race means awaiting a
  // promise nothing will ever settle, i.e. a boot that hangs forever with no
  // error.
  const readyToShow = new Promise<void>((resolve) => {
    win.once("ready-to-show", () => resolve());
  });
  if (opts.rendererUrl) {
    await win.loadURL(opts.rendererUrl);
  } else {
    await win.loadFile(opts.rendererFile ?? path.join(distDir, BOOT_STUB_FILE));
  }
  await readyToShow;
}
export function showWindowWhenRequested(win: BrowserWindowType, showWindow: boolean | undefined): void {
  if (showWindow === true) win.show();
}


/** Respond to one `roomdoc://` request using the boot-owned preview store. */
export function roomDocResponse(runtimeStores: FileRuntimeStores, request: Request): Response {
  const token = new URL(request.url).pathname.replace(/^\/+/, "");
  const html = runtimeStores.htmlPreviews.map.get(token);
  if (html === undefined) return new Response("preview not staged", { status: 404 });
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    },
  });
}


/** Respond to one `roommedia://` request using the boot-owned media store. */
export async function roomMediaResponse(
  runtimeStores: FileRuntimeStores,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const result = await mediaStreamingResponse(
    runtimeStores.mediaStreams,
    url.pathname,
    request.headers.get("range"),
  );
  return new Response(result.body, { status: result.status, headers: result.headers });
}
export function registerRoomProtocols(
  protocol: BootstrapElectron["protocol"],
  runtimeStores: FileRuntimeStores,
): void {
  if (!protocol) return;
  protocol.handle("roomdoc", (request) => roomDocResponse(runtimeStores, request));
  protocol.handle("roommedia", (request) => roomMediaResponse(runtimeStores, request));
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
  const distDir = bootstrapDistDir(opts);

  // ---- 1. single-instance lock -------------------------------------------
  claimSingleInstance(app);

  // ---- 2. stable userData path, BEFORE ready ------------------------------
  // Electron's own requirement: `setPath("userData")` must precede the `ready`
  // event, or Chromium has already created (and started writing to) the
  // default profile directory and the override only half-applies. Always set
  // it: Electron's package-name-derived default is not a stable app identity.
  const userDataDir = configureUserData(app, opts.userDataDirOverride);

  await app.whenReady();

  // ---- 3. obs.init ---------------------------------------------------------
  obs.init(app.getVersion());
  obs.info("app_start", [["version", obs.model(app.getVersion())]]);

  // ---- 4. geometry (restored before the window is created) -----------------
  const geometryStore = new GeometryStore(userDataDir);
  const restored = geometryStore.restore(displaysToGeometryScreens(screen.getAllDisplays()));

  const state = createRoomManagerState();
  const runtime = createBootstrapRuntime();
  const emit = (event: string, payload: unknown): void => emitToMainWindow(runtime, event, payload);
  /** The app's one window while it is really there — never a label- or
   * webview-scoped lookup (see `menu.ts`'s own warning), and `null` once the
   * window is gone so every caller falls through its own "nothing to ask"
   * branch. ONE liveness predicate, viewed through two narrower types below:
   * `menu.ts` wants something it can `send`/`close`, `dialogTools.ts` wants
   * something Electron will sheet a panel onto, and a real `BrowserWindow`
   * satisfies both. */
  const liveWindow = (): BrowserWindowType | null => liveMainWindow(runtime);
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
  const updater = createLiveUpdater({
    currentVersion: app.getVersion(),
    execPath: process.execPath,
    quit: () => app.quit(),
  });
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
    appVersion: () => app.getVersion(),
    osVersion: () => process.getSystemVersion?.() ?? "macOS",
    checkForUpdate: () => updater.check(),
    installUpdate: () => updater.install(),
    windowContentView: () => liveWindow()?.contentView ?? null,
    focusMainWindow: () => {
      const win = liveWindow();
      if (!win) throw new Error("The app window is gone.");
      win.focus();
    },
    openPath: async (target) => {
      const error = await shell.openPath(target);
      if (error) throw new Error(error);
    },
  };
  const dialogDeps: DialogDeps = { dialog, getMainWindow: liveWindow };
  const shellDeps: ShellDeps = { shell, openWithApp: opts.openWithApp ?? execFileOpenWithApp };
  const deps = createLiveRoomManagerDeps(state, userDataDir, emit);
  const { registeredChannels, completeness, runtimeStores } = (opts.registerAllIpcFn ?? registerAllIpc)({
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
  runtime.fileRuntimeStores = runtimeStores;
  if (!completeness.ok) {
    // A hard boot invariant, not a warning: see the module doc's step 6.
    throw new Error(
      "IPC registry is not complete — refusing to boot. " +
        `missingUndocumented=${JSON.stringify(completeness.missingUndocumented)} ` +
        `goneStale=${JSON.stringify(completeness.goneStale)} ` +
        `unexpectedChannels=${JSON.stringify(completeness.unexpectedChannels)}`
    );
  }

  // The old Tauri custom protocols, now backed by Electron's protocol API.
  // Register before the renderer loads so an iframe/media element can never
  // race its handler during first paint.
  registerRoomProtocols(opts.electron.protocol, runtimeStores);
  obs.info("ipc_registered", [["count", obs.count(registeredChannels.size)]]);

  // ---- 7. create window ---------------------------------------------------
  const win = createHiddenWindow(BrowserWindowCtor, restored, distDir);
  runtime.mainWindow = win;
  attachWindowDiagnostics(win);

  // ---- 8. the real getDisplayMedia handler, on THIS window's session ------
  // See the module doc's "THE getDisplayMedia HANDLER" for which session and
  // why, and for what each branch answers.
  registerDisplayMediaHandler(win, desktopCapturer);
  attachGeometryAndLifecycleHandlers(app, win, geometryStore, quitDoor, getMainWindow);

  // ---- 9 + 10. load the renderer, then wait for ready-to-show -------------
  await loadRendererBeforeReady(win, opts, distDir);

  // ---- 11. show — deliberately deferred by default; see module doc --------
  showWindowWhenRequested(win, opts.showWindow);

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


/** Process-level boot failure boundary, exported so unit tests can inject the app exit primitive. */
export function handleBootstrapFailure(
  app: { exit(code: number): void },
  err: unknown,
): void {
  console.error("Arcelle failed to boot:", err);
  app.exit(1);
}
