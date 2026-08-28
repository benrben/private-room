/**
 * Unit tests for `index.ts`'s own decision logic — the startup sequencing, the
 * single-instance-lock refusal, the completeness boot invariant, the
 * ready-to-show ordering, the geometry/marker helpers, the native menu's real
 * click closures, the quit door's hold / re-arm / fail-open behavior, the
 * `getDisplayMedia` answer and a real `#command` run — driven against FAKE
 * `electron` primitives, the same "accept it as a parameter, type it against
 * the real module, never import it at runtime" seam every `registerXIpc`
 * module here already uses.
 *
 * This is the complement to `index.electron.test.ts`, which proves the REAL
 * Electron process boots; this file proves the SEQUENCE is right, fast, and
 * without spawning a process for every edge case. The `run_command` round trip
 * at the bottom is the one thing here that needs a real SQLCipher room, and it
 * gets one: this file runs under plain vitest/Node, the same native-module ABI
 * `liveContext.test.ts` already opens real rooms against — unlike the spawned
 * Electron binary, whose ABI cannot (see `index.electron.test.ts`'s own
 * NATIVE-MODULE BOUNDARY note).
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from "electron";

import {
  bootstrap,
  displaysToGeometryScreens,
  formatReadyMarker,
  grantDisplayMediaRequest,
  PRIVILEGED_SCHEMES,
  preloadPath,
  READY_MARKER_PREFIX,
  STABLE_USER_DATA_DIR_NAME,
  stableUserDataPath,
  type BootstrapElectron,
  type ReadyMarker,
} from "./index.js";
import { saveGeometryPath } from "./windowGeometry.js";
import { CLOSE_ID, QUIT_ID, VIEW_ASSISTANT_ID, VIEW_LIBRARY_ID } from "./menu.js";
import { QUIT_REQUESTED } from "./quitDoor.js";
import type { RunCommandRequest } from "./chatCommands.js";
import type { CheckpointList } from "./roomCheckpoints.js";
import type { Message } from "./db-host/messages.js";

const tmpDirs: string[] = [];

describe("room viewer protocols", () => {
  it("lets file-origin viewers fetch streamed room bytes through CORS", () => {
    const roomMedia = PRIVILEGED_SCHEMES.find((entry) => entry.scheme === "roommedia");
    expect(roomMedia?.privileges).toMatchObject({
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    });
  });
});

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function freshUserDataDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "index-boot-"));
  tmpDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------- fakes ----

type ReadyToShowTiming = "sync" | "async";

interface FakeSession {
  setDisplayMediaRequestHandler: ReturnType<typeof vi.fn>;
}

/**
 * The window's own session, wrapped so every property name READ off it is
 * recorded.
 *
 * That list is the evidence for `index.ts`'s "THE WEBREQUEST FUNNEL —
 * CONFIRMED CORRECT AS IS, NOTHING WIRED HERE" claim: a bootstrap that
 * registered a root-session `onBeforeRequest` funnel could not do it without
 * reading `webRequest` off this object, so its ABSENCE from the recorded reads
 * is a positive check rather than a claim taken on faith. `Reflect.get` rather
 * than an index read, per this workspace's no-unguarded-`obj[key]` rule.
 */
function recordingSession(reads: string[]): FakeSession {
  const real: FakeSession = { setDisplayMediaRequestHandler: vi.fn() };
  return new Proxy(real, {
    get(target, prop, receiver): unknown {
      reads.push(String(prop));
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

class FakeBrowserWindow {
  static idCounter = 1;
  /** How `loadFile` fires `ready-to-show` — see the ordering test below. */
  static readyToShowTiming: ReadyToShowTiming = "async";

  id = FakeBrowserWindow.idCounter++;
  opts: unknown;
  shown = false;
  destroyed = false;
  fullScreen = false;
  minimized = false;
  bounds = { x: 10, y: 20, width: 1180, height: 780 };
  /** Every property name read off `webContents.session` — see
   * {@link recordingSession}. */
  readonly sessionReads: string[] = [];
  webContents = {
    send: vi.fn(),
    on: vi.fn(),
    // The window's own session — where the real bootstrap registers the
    // display-media handler. See `index.electron.test.ts` for the real-process
    // proof that this session IS `session.defaultSession`.
    session: recordingSession(this.sessionReads),
  };
  private listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  constructor(opts: unknown) {
    this.opts = opts;
  }

  on(event: string, cb: (...args: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
  }

  once(event: string, cb: (...args: unknown[]) => void): void {
    this.on(event, cb);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) {
      cb(...args);
    }
  }

  async loadFile(_p: string): Promise<void> {
    if (FakeBrowserWindow.readyToShowTiming === "sync") {
      // The hostile ordering: `ready-to-show` fires DURING the load, before
      // `loadFile`'s promise settles. Real Electron emits it on first paint,
      // which is not ordered after `did-finish-load` — a bootstrap that
      // subscribes only after awaiting `loadFile` would hang here forever.
      this.emit("ready-to-show");
      return;
    }
    // The friendly ordering: a macrotask after the load resolves.
    setTimeout(() => this.emit("ready-to-show"), 0);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
  getBounds(): { x: number; y: number; width: number; height: number } {
    return this.bounds;
  }
  isFullScreen(): boolean {
    return this.fullScreen;
  }
  isMinimized(): boolean {
    return this.minimized;
  }
  restore(): void {}
  focus(): void {}
  /** What `menu.dispatch`'s ⌘W arm calls when no room is open. */
  close(): void {}
  show(): void {
    this.shown = true;
  }
}

/** One row of a built menu, as much of `Electron.MenuItem` as `menuSync`
 * touches. */
interface FakeMenuItem {
  id: string;
  type: string;
  label?: string;
  enabled: boolean;
  checked: boolean;
  click?: () => void;
}

/**
 * A fake `Electron.Menu` built from the REAL template `buildTemplate` produced.
 *
 * `getMenuItemById` searches the whole tree, nested submenus included — real
 * Electron's own documented behavior, and the property `menu.ts`'s `menuSync`
 * depends on to reach the Layout submenu's rows. Building it from the real
 * template (rather than hand-listing rows) is what makes a click here run the
 * REAL `onCommand` closure `bootstrap` built, over the real `dispatch`, the
 * real `QuitDoor` and the real window lookup.
 */
class FakeMenu {
  readonly items = new Map<string, FakeMenuItem>();

  constructor(template: MenuItemConstructorOptions[]) {
    this.walk(template);
  }

  private walk(rows: MenuItemConstructorOptions[] | undefined): void {
    for (const row of rows ?? []) {
      if (typeof row.id === "string") {
        this.items.set(row.id, {
          id: row.id,
          type: typeof row.type === "string" ? row.type : "normal",
          label: row.label,
          enabled: row.enabled === true,
          checked: row.checked === true,
          click: row.click as (() => void) | undefined,
        });
      }
      this.walk(row.submenu as MenuItemConstructorOptions[] | undefined);
    }
  }

  getMenuItemById(id: string): FakeMenuItem | null {
    return this.items.get(id) ?? null;
  }
}

interface FakeElectron extends BootstrapElectron {
  appListeners: Map<string, ((...args: unknown[]) => void)[]>;
  /** Whatever `desktopCapturer.getSources` should answer — reassignable per
   * test, including to a rejection. */
  screenSources: () => Promise<{ id: string; name: string }[]>;
}

function fakeElectron(overrides?: {
  requestSingleInstanceLock?: boolean;
  userDataDir?: string;
  appDataDir?: string;
}): FakeElectron {
  const appListeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const appDataDir = overrides?.appDataDir ?? freshUserDataDir();
  let userDataDir = overrides?.userDataDir ?? path.join(appDataDir, STABLE_USER_DATA_DIR_NAME);
  const fake: FakeElectron = {
    appListeners,
    screenSources: () => Promise.resolve([{ id: "screen:0:0", name: "Entire Screen" }]),
    app: {
      requestSingleInstanceLock: vi.fn(() => overrides?.requestSingleInstanceLock ?? true),
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        const list = appListeners.get(event) ?? [];
        list.push(cb);
        appListeners.set(event, list);
      }),
      whenReady: vi.fn(() => Promise.resolve()),
      getVersion: vi.fn(() => "0.0.1-test"),
      getPath: vi.fn((name: string) => {
        if (name === "userData") return userDataDir;
        if (name === "appData") return appDataDir;
        return os.tmpdir();
      }),
      setPath: vi.fn((name: string, value: string) => {
        if (name === "userData") userDataDir = value;
      }),
      quit: vi.fn(),
      isPackaged: false,
    } as unknown as BootstrapElectron["app"],
    BrowserWindowCtor: FakeBrowserWindow as unknown as BootstrapElectron["BrowserWindowCtor"],
    screen: {
      getAllDisplays: vi.fn(() => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]),
    },
    ipcMain: {
      handle: vi.fn(
        (_channel: string, _listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {}
      ),
    },
    Menu: {
      buildFromTemplate: vi.fn(
        (template: MenuItemConstructorOptions[]) => new FakeMenu(template)
      ),
      setApplicationMenu: vi.fn(),
    } as unknown as BootstrapElectron["Menu"],
    desktopCapturer: {
      getSources: vi.fn(() => fake.screenSources()),
    } as unknown as BootstrapElectron["desktopCapturer"],
    // `arcelle.dialog`/`arcelle.shell`'s two Electron primitives. Every
    // behavioral decision about them lives in `dialogTools.ts`/`shellTools.ts`
    // and is tested there against these same shapes; what the tests below check
    // is that the BOOTSTRAP really reaches these objects — i.e. that the
    // channels are registered over the real injected modules rather than over
    // nothing.
    dialog: {
      showOpenDialog: vi.fn(() =>
        Promise.resolve({ canceled: false, filePaths: ["/tmp/picked.txt"] })
      ),
      showSaveDialog: vi.fn(() => Promise.resolve({ canceled: false, filePath: "/tmp/saved.txt" })),
      showMessageBox: vi.fn(() => Promise.resolve({ response: 0, checkboxChecked: false })),
    } as unknown as BootstrapElectron["dialog"],
    shell: {
      openExternal: vi.fn(() => Promise.resolve()),
      openPath: vi.fn(() => Promise.resolve("")),
      showItemInFolder: vi.fn(),
      trashItem: vi.fn(() => Promise.resolve()),
    } as unknown as BootstrapElectron["shell"],
  };
  return fake;
}

// ------------------------------------------------------- reading the fakes --

/** The listener the bootstrap registered for `channel`, straight off the fake
 * `ipcMain` — the same handler a real renderer's `invoke` would reach. */
function findHandler(
  electron: FakeElectron,
  channel: string
): (event: unknown, args?: unknown) => unknown {
  const handle = electron.ipcMain.handle as unknown as { mock: { calls: unknown[][] } };
  const call = handle.mock.calls.find((c) => c[0] === channel);
  if (call === undefined) {
    throw new Error(`no handler was registered for channel "${channel}"`);
  }
  return call[1] as (event: unknown, args?: unknown) => unknown;
}

/** The one `FakeMenu` the bootstrap actually installed. */
function installedMenu(electron: FakeElectron): FakeMenu {
  const setApplicationMenu = electron.Menu.setApplicationMenu as unknown as {
    mock: { calls: unknown[][] };
  };
  const menu = setApplicationMenu.mock.calls[0]?.[0];
  if (!(menu instanceof FakeMenu)) {
    throw new Error("Menu.setApplicationMenu was never called with a built menu");
  }
  return menu;
}

/** Click a row of the installed menu, running the REAL `dispatch` closure. */
function clickRow(electron: FakeElectron, id: string): void {
  const item = installedMenu(electron).getMenuItemById(id);
  if (item?.click === undefined) {
    throw new Error(`menu row "${id}" has no click handler`);
  }
  item.click();
}

/** Drive the real display-media handler the bootstrap registered, resolving
 * with whatever it hands its callback. */
function driveDisplayMedia(
  win: FakeBrowserWindow,
  request: { videoRequested: boolean }
): Promise<unknown> {
  const calls = win.webContents.session.setDisplayMediaRequestHandler.mock.calls as unknown[][];
  const handler = calls[0]?.[0] as
    | ((request: unknown, callback: (streams: unknown) => void) => void)
    | undefined;
  if (handler === undefined) {
    throw new Error("no display-media handler was registered");
  }
  return new Promise((resolve) => handler(request, resolve));
}

afterEach(() => {
  FakeBrowserWindow.readyToShowTiming = "async";
});

// ---------------------------------------------------------------- tests ----

describe("displaysToGeometryScreens", () => {
  it("converts Electron display bounds into windowGeometry.ts's tuple shape", () => {
    expect(
      displaysToGeometryScreens([
        { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
        { bounds: { x: 1920, y: 0, width: 1440, height: 900 } },
      ])
    ).toEqual([
      [0, 0, 1920, 1080],
      [1920, 0, 1440, 900],
    ]);
  });

  it("handles zero displays", () => {
    expect(displaysToGeometryScreens([])).toEqual([]);
  });
});

describe("preloadPath", () => {
  it("resolves the preload as a SIBLING of the compiled main directory", () => {
    expect(preloadPath("/x/dist/src/main")).toBe("/x/dist/src/preload/index.cjs");
  });
});

describe("formatReadyMarker", () => {
  it("prefixes with READY_MARKER_PREFIX and is valid JSON after it", () => {
    const marker: ReadyMarker = {
      event: "arcelle_main_ready",
      registeredChannelCount: 169,
      totalCommandCount: 296,
      completenessOk: true,
      windowId: 1,
    };
    const line = formatReadyMarker(marker);
    expect(line.startsWith(READY_MARKER_PREFIX)).toBe(true);
    expect(JSON.parse(line.slice(READY_MARKER_PREFIX.length))).toEqual(marker);
  });
});

describe("bootstrap", () => {
  it("refuses to boot a second instance when the single-instance lock is already held", async () => {
    const electron = fakeElectron({ requestSingleInstanceLock: false });
    await expect(bootstrap({ electron, resourcesPath: null })).rejects.toThrow(
      "Another instance of Arcelle already holds the single-instance lock."
    );
    expect(electron.app.quit).toHaveBeenCalledOnce();
  });

  it("runs the full sequence: registers IPC, creates a hidden window, waits for ready-to-show", async () => {
    const electron = fakeElectron();
    const result = await bootstrap({ electron, resourcesPath: null });

    expect(result.completeness.ok).toBe(true);
    expect(result.marker.event).toBe("arcelle_main_ready");
    expect(result.marker.completenessOk).toBe(true);
    expect(result.marker.registeredChannelCount).toBeGreaterThan(150);
    expect(electron.ipcMain.handle).toHaveBeenCalled();

    const win = result.window as unknown as FakeBrowserWindow;
    const opts = win.opts as {
      show: boolean;
      webPreferences: {
        preload: string;
        sandbox: boolean;
        contextIsolation: boolean;
        nodeIntegration: boolean;
      };
    };
    expect(opts.show).toBe(false);
    expect(opts.webPreferences.preload.endsWith(path.join("preload", "index.cjs"))).toBe(true);
    // All three renderer boundaries are asserted rather than assumed.
    expect(opts.webPreferences.contextIsolation).toBe(true);
    expect(opts.webPreferences.nodeIntegration).toBe(false);
    expect(opts.webPreferences.sandbox).toBe(true);

    // never shown by default (module doc step 9)
    expect(win.shown).toBe(false);
  });

  it("resolves even when ready-to-show fires DURING loadFile, before its promise settles", async () => {
    // The regression this guards: subscribing to `ready-to-show` only AFTER
    // awaiting `loadFile` loses the race against a window that painted first,
    // and the boot then awaits a promise nothing will ever settle — a silent
    // hang with no error, the worst possible startup failure.
    FakeBrowserWindow.readyToShowTiming = "sync";
    const electron = fakeElectron();
    const result = await bootstrap({ electron, resourcesPath: null });
    expect(result.marker.event).toBe("arcelle_main_ready");
  });

  it("shows the window when showWindow: true is passed", async () => {
    const electron = fakeElectron();
    const result = await bootstrap({ electron, resourcesPath: null, showWindow: true });
    expect((result.window as unknown as FakeBrowserWindow).shown).toBe(true);
  });

  it("restores geometry from a previously-saved window.json before creating the window", async () => {
    const userDataDir = freshUserDataDir();
    mkdirSync(userDataDir, { recursive: true });
    // `windowGeometry.ts`'s `GEOMETRY_SCHEMA_VERSION` (currently 1) is
    // module-private; `parseGeometry`'s own tests pin that constant's real
    // value against that file's parsing behavior.
    writeFileSync(
      saveGeometryPath(userDataDir),
      JSON.stringify({ v: 1, x: 42, y: 43, width: 1000, height: 700 })
    );

    const electron = fakeElectron({ userDataDir });
    const result = await bootstrap({ electron, resourcesPath: null, userDataDirOverride: userDataDir });
    const opts = (result.window as unknown as FakeBrowserWindow).opts as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    expect(opts).toMatchObject({ x: 42, y: 43, width: 1000, height: 700 });
  });

  it("notes geometry on move/resize and saves it on before-quit", async () => {
    const userDataDir = freshUserDataDir();
    const electron = fakeElectron({ userDataDir });
    const result = await bootstrap({ electron, resourcesPath: null, userDataDirOverride: userDataDir });
    const win = result.window as unknown as FakeBrowserWindow;

    win.bounds = { x: 100, y: 120, width: 1024, height: 768 };
    win.emit("resize");
    electron.appListeners.get("before-quit")?.forEach((cb) => cb());

    const saved = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      (await import("node:fs")).readFileSync(saveGeometryPath(userDataDir), "utf8")
    ) as { x: number; y: number; width: number; height: number };
    expect(saved).toMatchObject({ x: 100, y: 120, width: 1024, height: 768 });
  });

  it("a window quit from FULLSCREEN keeps the last windowed rectangle, not nothing", async () => {
    // `GeometryStore.note()` deliberately ignores a fullscreen rectangle. A
    // bootstrap that noted geometry ONLY at close/quit time would therefore
    // record nothing at all for a user who quits while fullscreen, silently
    // losing the remembered window position.
    const userDataDir = freshUserDataDir();
    const electron = fakeElectron({ userDataDir });
    const result = await bootstrap({ electron, resourcesPath: null, userDataDirOverride: userDataDir });
    const win = result.window as unknown as FakeBrowserWindow;

    win.bounds = { x: 5, y: 6, width: 1200, height: 800 };
    win.emit("move");
    win.fullScreen = true;
    win.bounds = { x: 0, y: 0, width: 1920, height: 1080 };
    win.emit("resize");
    electron.appListeners.get("before-quit")?.forEach((cb) => cb());

    const saved = JSON.parse(
      (await import("node:fs")).readFileSync(saveGeometryPath(userDataDir), "utf8")
    ) as { x: number; y: number; width: number; height: number };
    expect(saved).toMatchObject({ x: 5, y: 6, width: 1200, height: 800 });
  });

  it("second-instance always focuses, and restores only when minimized", async () => {
    const electron = fakeElectron();
    const result = await bootstrap({ electron, resourcesPath: null });
    const win = result.window as unknown as FakeBrowserWindow;
    const focusSpy = vi.spyOn(win, "focus");
    const restoreSpy = vi.spyOn(win, "restore");
    win.minimized = true;

    const handlers = electron.appListeners.get("second-instance") ?? [];
    expect(handlers.length).toBeGreaterThan(0);
    handlers[0]!();

    expect(focusSpy).toHaveBeenCalledOnce();
    expect(restoreSpy).toHaveBeenCalledOnce();
  });

  it("second-instance does NOT call restore() on an already-unminimized window", async () => {
    const electron = fakeElectron();
    const result = await bootstrap({ electron, resourcesPath: null });
    const win = result.window as unknown as FakeBrowserWindow;
    const focusSpy = vi.spyOn(win, "focus");
    const restoreSpy = vi.spyOn(win, "restore");

    (electron.appListeners.get("second-instance") ?? [])[0]!();

    expect(focusSpy).toHaveBeenCalledOnce();
    expect(restoreSpy).not.toHaveBeenCalled();
  });

  it("window-all-closed quits the app", async () => {
    const electron = fakeElectron();
    await bootstrap({ electron, resourcesPath: null });
    const handlers = electron.appListeners.get("window-all-closed") ?? [];
    expect(handlers.length).toBeGreaterThan(0);
    handlers[0]!();
    expect(electron.app.quit).toHaveBeenCalled();
  });

  it("userDataDirOverride is applied via app.setPath BEFORE app.whenReady()", async () => {
    // Electron requires `setPath("userData")` to precede the ready event —
    // afterwards Chromium has already created and started writing the default
    // profile directory, so the override only half-applies.
    const electron = fakeElectron();
    const override = freshUserDataDir();
    await bootstrap({ electron, resourcesPath: null, userDataDirOverride: override });

    const setPath = electron.app.setPath as unknown as ReturnType<typeof vi.fn>;
    const whenReady = electron.app.whenReady as unknown as ReturnType<typeof vi.fn>;
    expect(setPath).toHaveBeenCalledWith("userData", override);
    expect(setPath.mock.invocationCallOrder[0]!).toBeLessThan(
      whenReady.mock.invocationCallOrder[0]!
    );
  });

  it("pins production userData to the historical Arcelle profile before app.whenReady()", async () => {
    const appDataDir = freshUserDataDir();
    const electron = fakeElectron({ appDataDir });
    await bootstrap({ electron, resourcesPath: null });
    const setPath = electron.app.setPath as unknown as ReturnType<typeof vi.fn>;
    const whenReady = electron.app.whenReady as unknown as ReturnType<typeof vi.fn>;
    expect(stableUserDataPath(appDataDir)).toBe(path.join(appDataDir, "arcelle-electron"));
    expect(setPath).toHaveBeenCalledWith("userData", path.join(appDataDir, "arcelle-electron"));
    expect(setPath.mock.invocationCallOrder[0]!).toBeLessThan(
      whenReady.mock.invocationCallOrder[0]!
    );
  });
});

// ============================================================================
// The native application menu
// ============================================================================

describe("the native application menu", () => {
  it("builds menu.ts's own template and installs it with Menu.setApplicationMenu", async () => {
    const electron = fakeElectron();
    await bootstrap({ electron, resourcesPath: null });

    expect(electron.Menu.buildFromTemplate).toHaveBeenCalledOnce();
    const built = (
      electron.Menu.buildFromTemplate as unknown as { mock: { results: { value: unknown }[] } }
    ).mock.results[0]!.value;
    expect(electron.Menu.setApplicationMenu).toHaveBeenCalledWith(built);

    // The rows are menu.ts's real ones, not a stand-in — including the two
    // that are born enabled with no room open (`alwaysEnabled`).
    const menu = installedMenu(electron);
    expect(menu.getMenuItemById(QUIT_ID)).toMatchObject({
      label: "Quit Arcelle",
      enabled: true,
    });
    expect(menu.getMenuItemById(CLOSE_ID)?.enabled).toBe(true);
    expect(menu.getMenuItemById(VIEW_LIBRARY_ID)).toMatchObject({
      type: "checkbox",
      // Gated until a room mounts and `menu_sync` says otherwise.
      enabled: false,
      checked: false,
    });
  });

  it("a menu row's click reaches the window as a menu-action event", async () => {
    const electron = fakeElectron();
    const result = await bootstrap({ electron, resourcesPath: null });
    const win = result.window as unknown as FakeBrowserWindow;

    clickRow(electron, VIEW_ASSISTANT_ID);

    expect(win.webContents.send).toHaveBeenCalledWith("menu-action", VIEW_ASSISTANT_ID);
  });

  it("⌘W with no room open closes the window itself rather than sending an event nobody handles", async () => {
    // `dispatch`'s own last case: the frontend's menu handler mounts WITH the
    // room, so at the start screen the event would go nowhere and the key
    // would do nothing at all.
    const electron = fakeElectron();
    const result = await bootstrap({ electron, resourcesPath: null });
    const win = result.window as unknown as FakeBrowserWindow;
    const closeSpy = vi.spyOn(win, "close");

    clickRow(electron, CLOSE_ID);

    expect(closeSpy).toHaveBeenCalledOnce();
    expect(win.webContents.send).not.toHaveBeenCalledWith("menu-action", CLOSE_ID);
  });

  it("menu_sync pushes the window's layout state onto the SAME menu instance that was installed", async () => {
    const electron = fakeElectron();
    await bootstrap({ electron, resourcesPath: null });
    const menu = installedMenu(electron);

    await findHandler(electron, "menu_sync")(undefined, {
      view: {
        enabled: true,
        library: true,
        assistant: false,
        focus: false,
        railLabels: true,
        railLabelsSettable: false,
        sidebar: "Sketches",
      },
    });

    expect(menu.getMenuItemById(VIEW_LIBRARY_ID)).toMatchObject({
      checked: true,
      enabled: true,
      // The ⌘1 row is retitled to whatever second column the reader is
      // actually standing over — menu.ts's `sidebarLabel`.
      label: "Sketches",
    });
    expect(menu.getMenuItemById(VIEW_ASSISTANT_ID)).toMatchObject({ checked: false, enabled: true });
    // railLabelsSettable: false — the window says the preference cannot be set
    // right now, so the row greys out even though the room is open.
    expect(menu.getMenuItemById("view.rail-labels")?.enabled).toBe(false);
  });
});

// ============================================================================
// The quit door — all three entrances
// ============================================================================

describe("the quit door", () => {
  it("holds ⌘Q once, asks the window, re-arms on Cancel, then fails open on the next press", async () => {
    const electron = fakeElectron();
    const result = await bootstrap({ electron, resourcesPath: null });
    const win = result.window as unknown as FakeBrowserWindow;
    const setUnsavedEdits = findHandler(electron, "set_unsaved_edits");
    const rearm = findHandler(electron, "quit_guard_rearm");

    await setUnsavedEdits(undefined, { on: true });

    // First ⌘Q: held. The window is asked; nothing exits.
    clickRow(electron, QUIT_ID);
    expect(win.webContents.send).toHaveBeenCalledWith(QUIT_REQUESTED);
    expect(electron.app.quit).not.toHaveBeenCalled();

    // The window answered "Cancel". Edits are still unsaved, so the NEXT ⌘Q
    // must ask again rather than quitting silently.
    await rearm(undefined, {});
    win.webContents.send.mockClear();
    clickRow(electron, QUIT_ID);
    expect(win.webContents.send).toHaveBeenCalledWith(QUIT_REQUESTED);
    expect(electron.app.quit).not.toHaveBeenCalled();

    // No re-arm this time: the door fails OPEN, so a wedged window never
    // traps the user.
    win.webContents.send.mockClear();
    clickRow(electron, QUIT_ID);
    expect(electron.app.quit).toHaveBeenCalledOnce();
    expect(win.webContents.send).not.toHaveBeenCalledWith(QUIT_REQUESTED);
  });

  it("does not hold at all once set_unsaved_edits(false) clears the flag", async () => {
    const electron = fakeElectron();
    const result = await bootstrap({ electron, resourcesPath: null });
    const win = result.window as unknown as FakeBrowserWindow;
    const setUnsavedEdits = findHandler(electron, "set_unsaved_edits");

    await setUnsavedEdits(undefined, { on: true });
    await setUnsavedEdits(undefined, { on: false });

    clickRow(electron, QUIT_ID);
    expect(electron.app.quit).toHaveBeenCalledOnce();
    expect(win.webContents.send).not.toHaveBeenCalledWith(QUIT_REQUESTED);
  });

  it("the before-quit entrance holds Dock-Quit / logout, which no menu row ever sees", async () => {
    const electron = fakeElectron();
    const result = await bootstrap({ electron, resourcesPath: null });
    const win = result.window as unknown as FakeBrowserWindow;
    await findHandler(electron, "set_unsaved_edits")(undefined, { on: true });

    const listeners = electron.appListeners.get("before-quit") ?? [];
    // Two listeners share the event — the geometry save and the door. Real
    // Electron runs every one, so this does too.
    expect(listeners.length).toBe(2);
    const event = { preventDefault: vi.fn() };
    listeners.forEach((cb) => cb(event));

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(win.webContents.send).toHaveBeenCalledWith(QUIT_REQUESTED);
  });

  it("before-quit lets the exit through when there is nothing unsaved", async () => {
    const electron = fakeElectron();
    await bootstrap({ electron, resourcesPath: null });

    const event = { preventDefault: vi.fn() };
    (electron.appListeners.get("before-quit") ?? []).forEach((cb) => cb(event));

    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("before-quit with the window already GONE quits anyway, and does not spend the latch", async () => {
    // The wedge this guards, and it is not hypothetical: `window-all-closed`
    // calls `app.quit()` after the window is destroyed. A door that held there
    // would preventDefault the exit, send `quit-requested` to nobody, and
    // leave a windowless process alive that no further ⌘Q could ever reach.
    // `menu.quit` already falls through for the same reason.
    const electron = fakeElectron();
    const result = await bootstrap({ electron, resourcesPath: null });
    const win = result.window as unknown as FakeBrowserWindow;
    await findHandler(electron, "set_unsaved_edits")(undefined, { on: true });

    win.destroyed = true;
    const gone = { preventDefault: vi.fn() };
    (electron.appListeners.get("before-quit") ?? []).forEach((cb) => cb(gone));
    expect(gone.preventDefault).not.toHaveBeenCalled();

    // And the door's one-shot latch was not burned by that unanswerable exit:
    // a window that comes back is still asked.
    win.destroyed = false;
    const back = { preventDefault: vi.fn() };
    (electron.appListeners.get("before-quit") ?? []).forEach((cb) => cb(back));
    expect(back.preventDefault).toHaveBeenCalledOnce();
    expect(win.webContents.send).toHaveBeenCalledWith(QUIT_REQUESTED);
  });

  // ---- the window's own close: the entrance Tauri's renderer used to own ----

  it("the WINDOW CLOSE entrance holds the red button, which no quit hook ever sees", async () => {
    // Red on a bootstrap that wires only the two quit entrances — which is
    // what the Tauri port had, because there `Workspace.tsx` guarded close in
    // the renderer via `onCloseRequested`. An isolated Electron renderer has no
    // such hook, so without this listener the red button became a brand-new
    // silent way to discard an unsaved note.
    const electron = fakeElectron();
    const result = await bootstrap({ electron, resourcesPath: null });
    const win = result.window as unknown as FakeBrowserWindow;
    await findHandler(electron, "set_unsaved_edits")(undefined, { on: true });

    const event = { preventDefault: vi.fn() };
    win.emit("close", event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(win.webContents.send).toHaveBeenCalledWith(QUIT_REQUESTED);
  });

  it("window close goes straight through when nothing is unsaved", async () => {
    const electron = fakeElectron();
    const result = await bootstrap({ electron, resourcesPath: null });
    const win = result.window as unknown as FakeBrowserWindow;

    const event = { preventDefault: vi.fn() };
    win.emit("close", event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(win.webContents.send).not.toHaveBeenCalledWith(QUIT_REQUESTED);
  });

  it("the three entrances share ONE latch: a ⌘Q held first lets the NEXT close through", async () => {
    // The property that makes fail-open real rather than per-entrance. A
    // separate latch per entrance would ask again here — which reads as
    // "friendlier" and is in fact the trap: a renderer too wedged to answer the
    // first question is exactly as unable to answer the second, and the user
    // would be left unable to leave by any route.
    const electron = fakeElectron();
    const result = await bootstrap({ electron, resourcesPath: null });
    const win = result.window as unknown as FakeBrowserWindow;
    await findHandler(electron, "set_unsaved_edits")(undefined, { on: true });

    clickRow(electron, QUIT_ID); // entrance 1: held, latch spent
    expect(win.webContents.send).toHaveBeenCalledWith(QUIT_REQUESTED);

    win.webContents.send.mockClear();
    const event = { preventDefault: vi.fn() };
    win.emit("close", event); // entrance 3: through
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(win.webContents.send).not.toHaveBeenCalledWith(QUIT_REQUESTED);
  });

  // ---- quit_guard_confirm: the answer that finishes a held exit ----

  it("quit_guard_confirm really quits — the step the Tauri build used exit(0) for", async () => {
    // The hole this closes: before this channel existed, the user could press
    // ⌘Q, be asked, choose "Quit and discard" — and watch the app keep running,
    // because the renderer had no way to say "yes" that anything acted on.
    const electron = fakeElectron();
    const result = await bootstrap({ electron, resourcesPath: null });
    const win = result.window as unknown as FakeBrowserWindow;
    await findHandler(electron, "set_unsaved_edits")(undefined, { on: true });

    clickRow(electron, QUIT_ID);
    expect(win.webContents.send).toHaveBeenCalledWith(QUIT_REQUESTED);
    expect(electron.app.quit).not.toHaveBeenCalled();

    await findHandler(electron, "quit_guard_confirm")(undefined, {});
    // Deferred by one turn of the event loop so the `invoke` that asked can be
    // answered before its own window is torn down — see the host bridge.
    expect(electron.app.quit).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    expect(electron.app.quit).toHaveBeenCalledOnce();
  });

  it("the quit confirm DISARMS the door, so the exit it started is not held again on the way out", async () => {
    // `app.quit()` fires `before-quit` AND the window's `close`. A confirm that
    // cleared only the one-shot latch would leave `unsavedEdits` armed, and the
    // very exit the user just authorized would be held by the next entrance it
    // passed through — one more "Unsaved edits" dialog, for a decision already
    // made.
    const electron = fakeElectron();
    const result = await bootstrap({ electron, resourcesPath: null });
    const win = result.window as unknown as FakeBrowserWindow;
    await findHandler(electron, "set_unsaved_edits")(undefined, { on: true });
    clickRow(electron, QUIT_ID);

    await findHandler(electron, "quit_guard_confirm")(undefined, {});
    await new Promise((resolve) => setImmediate(resolve));

    win.webContents.send.mockClear();
    const beforeQuit = { preventDefault: vi.fn() };
    (electron.appListeners.get("before-quit") ?? []).forEach((cb) => cb(beforeQuit));
    const close = { preventDefault: vi.fn() };
    win.emit("close", close);

    expect(beforeQuit.preventDefault).not.toHaveBeenCalled();
    expect(close.preventDefault).not.toHaveBeenCalled();
    expect(win.webContents.send).not.toHaveBeenCalledWith(QUIT_REQUESTED);
  });
});

// ============================================================================
// arcelle.dialog / arcelle.shell — the bootstrap's own wiring of them
// ============================================================================
//
// `dialogTools.test.ts`/`shellTools.test.ts` own the behavior of these
// handlers. What is checked here is the WIRING: that `bootstrap` registered
// them over the real injected `dialog`/`shell` objects and over the live
// window, which no unit test of those modules could see.

describe("the dialog/shell plugin surfaces, as this bootstrap wires them", () => {
  it("dialog_open reaches the injected dialog module, sheeted onto the live window", async () => {
    const electron = fakeElectron();
    const result = await bootstrap({ electron, resourcesPath: null, openWithApp: vi.fn() });
    const win = result.window as unknown as FakeBrowserWindow;

    const picked = await findHandler(electron, "dialog_open")(undefined, { title: "Pick one" });

    expect(picked).toBe("/tmp/picked.txt");
    const showOpenDialog = electron.dialog.showOpenDialog as unknown as {
      mock: { calls: unknown[][] };
    };
    // The PARENT-window overload, with the very window this bootstrap created —
    // the difference between a macOS sheet and a detached app-modal panel.
    expect(showOpenDialog.mock.calls[0]?.[0]).toBe(win);
  });

  it("a dialog raised after the window is gone falls back to the unattached overload", async () => {
    const electron = fakeElectron();
    const result = await bootstrap({ electron, resourcesPath: null, openWithApp: vi.fn() });
    const win = result.window as unknown as FakeBrowserWindow;
    win.destroyed = true;

    await findHandler(electron, "dialog_message")(undefined, { message: "still fine" });

    const showMessageBox = electron.dialog.showMessageBox as unknown as {
      mock: { calls: unknown[][] };
    };
    // One argument, not two: options only. Refusing instead would mean an app
    // that cannot say anything during its own shutdown.
    expect(showMessageBox.mock.calls[0]?.length).toBe(1);
  });

  it("open_url reaches shell.openExternal for an in-scope URL", async () => {
    const electron = fakeElectron();
    await bootstrap({ electron, resourcesPath: null, openWithApp: vi.fn() });

    await findHandler(electron, "open_url")(undefined, { url: "https://ollama.com/download" });

    expect(electron.shell.openExternal).toHaveBeenCalledWith("https://ollama.com/download");
  });

  it("open_url REFUSES an out-of-scope URL without touching the shell at all", async () => {
    const electron = fakeElectron();
    await bootstrap({ electron, resourcesPath: null, openWithApp: vi.fn() });

    await expect(
      findHandler(electron, "open_url")(undefined, { url: "file:///etc/passwd" })
    ).rejects.toThrow("outside the app's URL scope");
    expect(electron.shell.openExternal).not.toHaveBeenCalled();
  });

  it("reveal_item_in_dir reaches shell.showItemInFolder once per path", async () => {
    const electron = fakeElectron();
    await bootstrap({ electron, resourcesPath: null, openWithApp: vi.fn() });

    await findHandler(electron, "reveal_item_in_dir")(undefined, { paths: ["/a/one", "/b/two"] });

    expect(electron.shell.showItemInFolder).toHaveBeenNthCalledWith(1, "/a/one");
    expect(electron.shell.showItemInFolder).toHaveBeenNthCalledWith(2, "/b/two");
  });

  it("`with` goes to the injected /usr/bin/open bridge, never to shell.openExternal", async () => {
    const openWithApp = vi.fn(() => Promise.resolve());
    const electron = fakeElectron();
    await bootstrap({ electron, resourcesPath: null, openWithApp });

    await findHandler(electron, "open_url")(undefined, {
      url: "https://example.com/page",
      with: "Firefox",
    });

    expect(openWithApp).toHaveBeenCalledWith("Firefox", "https://example.com/page");
    expect(electron.shell.openExternal).not.toHaveBeenCalled();
  });
});

// ============================================================================
// getDisplayMedia
// ============================================================================

describe("the getDisplayMedia handler", () => {
  it("is registered exactly once, on the window's own session", async () => {
    const electron = fakeElectron();
    const result = await bootstrap({ electron, resourcesPath: null });
    const win = result.window as unknown as FakeBrowserWindow;
    expect(win.webContents.session.setDisplayMediaRequestHandler).toHaveBeenCalledOnce();
  });

  it("grants audio-only loopback with NO video and no source lookup for the primary request", async () => {
    // loopbackTap.ts's SYSTEM_AUDIO_CONSTRAINTS. Not consulting
    // `desktopCapturer` at all is the point: no picker, no capture indicator.
    const electron = fakeElectron();
    const result = await bootstrap({ electron, resourcesPath: null });
    const win = result.window as unknown as FakeBrowserWindow;

    expect(await driveDisplayMedia(win, { videoRequested: false })).toEqual({ audio: "loopback" });
    expect(electron.desktopCapturer.getSources).not.toHaveBeenCalled();
  });

  it("grants a real screen source for the video-requested FALLBACK shape", async () => {
    // Only reachable through SYSTEM_AUDIO_FALLBACK_CONSTRAINTS, and
    // loopbackTap.ts stops that video track the instant the stream arrives.
    const electron = fakeElectron();
    const result = await bootstrap({ electron, resourcesPath: null });
    const win = result.window as unknown as FakeBrowserWindow;

    expect(await driveDisplayMedia(win, { videoRequested: true })).toEqual({
      video: { id: "screen:0:0", name: "Entire Screen" },
      audio: "loopback",
    });
  });

  it("still grants the audio when there is no capturable screen at all", async () => {
    const electron = fakeElectron();
    electron.screenSources = () => Promise.resolve([]);
    const result = await bootstrap({ electron, resourcesPath: null });
    const win = result.window as unknown as FakeBrowserWindow;

    expect(await driveDisplayMedia(win, { videoRequested: true })).toEqual({ audio: "loopback" });
  });

  it("answers the callback even when the source lookup THROWS — never leaves the request hanging", async () => {
    // The failure mode `loopbackTap.ts`'s own doc calls out: a request whose
    // callback is never called does not reject, it hangs forever. A rejected
    // promise with no handler would be exactly that.
    const electron = fakeElectron();
    electron.screenSources = () => Promise.reject(new Error("no screen recording permission"));
    const result = await bootstrap({ electron, resourcesPath: null });
    const win = result.window as unknown as FakeBrowserWindow;

    expect(await driveDisplayMedia(win, { videoRequested: true })).toEqual({});
  });

  it("answers the callback when the source lookup throws SYNCHRONOUSLY too", async () => {
    // The sibling of the rejection case above, and a different code path: a
    // `deps.getScreenSource` that throws before returning a promise would
    // escape a `.then(ok, fail)` chain entirely if the call were not already
    // inside an async function. Same contract either way — the callback is
    // called exactly once, so the request can never hang.
    const electron = fakeElectron();
    electron.screenSources = () => {
      throw new Error("desktopCapturer exploded");
    };
    const result = await bootstrap({ electron, resourcesPath: null });
    const win = result.window as unknown as FakeBrowserWindow;

    expect(await driveDisplayMedia(win, { videoRequested: true })).toEqual({});
  });

  it("grantDisplayMediaRequest answers both shapes directly too", async () => {
    const getScreenSource = vi.fn(() => Promise.resolve({ id: "s", name: "Screen" }));
    expect(await grantDisplayMediaRequest({ videoRequested: false }, { getScreenSource })).toEqual({
      audio: "loopback",
    });
    expect(getScreenSource).not.toHaveBeenCalled();
    expect(await grantDisplayMediaRequest({ videoRequested: true }, { getScreenSource })).toEqual({
      video: { id: "s", name: "Screen" },
      audio: "loopback",
    });
  });
});

// ============================================================================
// The webRequest funnel — the claim is that NOTHING is wired here
// ============================================================================

describe("the webRequest funnel's root session", () => {
  it("the bootstrap reads NOTHING off the window's session but the display-media handler", async () => {
    // `index.ts`'s "THE WEBREQUEST FUNNEL" section claims it registers no
    // root-session `onBeforeRequest` funnel, on the grounds that
    // `webviewManager.ts` attaches one per page to that page's own fresh
    // ephemeral session and this window's session never hosts a browsed page.
    // A funnel registered here could not exist without touching
    // `session.webRequest`, so the recorded property reads are that claim
    // checked rather than restated. Exact, not a `not.toContain`: a future
    // root-session registration under any OTHER name (`setProxy`,
    // `setPermissionRequestHandler`, `protocol`) is a change worth failing on
    // and re-reading this comment for.
    const electron = fakeElectron();
    const result = await bootstrap({ electron, resourcesPath: null });
    const win = result.window as unknown as FakeBrowserWindow;

    expect(win.sessionReads).toEqual(["setDisplayMediaRequestHandler"]);
  });
});

// ============================================================================
// run_command — a real #command through the real assembleLiveContext wiring
// ============================================================================

describe("run_command, over a real assembleLiveContext", () => {
  it("refuses with the real 'No room is open.' before any room exists", async () => {
    const electron = fakeElectron();
    await bootstrap({ electron, resourcesPath: null });

    const req: RunCommandRequest = {
      askId: randomUUID(),
      chatId: randomUUID(),
      command: "checkpoint",
      args: "",
      refs: [],
      raw: "#checkpoint",
    };
    await expect(findHandler(electron, "run_command")(undefined, req)).rejects.toThrow(
      "No room is open."
    );
  });

  it("runs #checkpoint for real against a real on-disk room, visible through a DIFFERENT reader", async () => {
    // The end-to-end claim: `assembleLiveContext` is built over the SAME
    // `RoomManagerState` `create_room` opened, so a #command run through this
    // bootstrap writes to the room the user actually has open. Read back
    // through `roomCheckpoints.ts`'s own list handler — a different function
    // than the one `runCommand` wrote with, so a pass cannot be explained by
    // writer and checker sharing a bug.
    const electron = fakeElectron();
    await bootstrap({ electron, resourcesPath: null });

    const roomPath = path.join(freshUserDataDir(), `boot-${randomUUID()}.roomai`);
    await findHandler(electron, "create_room")(undefined, {
      path: roomPath,
      password: "correct horse battery staple",
      name: "index.test wiring fixture",
    });

    const message = (await findHandler(electron, "run_command")(undefined, {
      askId: randomUUID(),
      chatId: randomUUID(),
      command: "checkpoint",
      args: "wiring proof",
      refs: [],
      raw: "#checkpoint wiring proof",
    } satisfies RunCommandRequest)) as Message;
    expect(message.content).toContain("wiring proof");

    const list = (await findHandler(electron, "list_room_checkpoints")(undefined, {})) as CheckpointList;
    expect(list.entries.map((e) => e.name)).toEqual(["wiring proof"]);

    await findHandler(electron, "close_room")(undefined, {});
  });

  it("writes the user's line AND the reply into the room, read back through get_messages", async () => {
    // The checkpoint above proves `checkpointState` reached the open room.
    // This proves the OTHER half of the same assembled graph — `deps.room`,
    // which `runCommand` uses for `recentMessages`/`insertMessage`/
    // `persistAssistantReply` — landed in that same room, read back through
    // `chatCmds.ts`'s own `get_messages` handler rather than the writer.
    const electron = fakeElectron();
    await bootstrap({ electron, resourcesPath: null });

    const roomPath = path.join(freshUserDataDir(), `boot-${randomUUID()}.roomai`);
    await findHandler(electron, "create_room")(undefined, {
      path: roomPath,
      password: "correct horse battery staple",
      name: "index.test message fixture",
    });

    const chatId = randomUUID();
    await findHandler(electron, "run_command")(undefined, {
      askId: randomUUID(),
      chatId,
      command: "checkpoint",
      args: "message proof",
      refs: [],
      raw: "#checkpoint message proof",
    } satisfies RunCommandRequest);

    const messages = (await findHandler(electron, "get_messages")(undefined, { chatId })) as Message[];
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    // The raw line the user typed, saved by `runCommand`'s phase 1…
    expect(messages[0]?.content).toBe("#checkpoint message proof");
    // …and the reply its phase 3 persisted.
    expect(messages[1]?.content).toContain("message proof");

    await findHandler(electron, "close_room")(undefined, {});
  });

  it("refuses again once the room CLOSES — the assembled room view is live, not a snapshot", async () => {
    // `assembleLiveContext` is called ONCE, inside `registerAllIpc`, BEFORE
    // any room exists. The "it worked after create_room" test above proves the
    // null→room direction; this proves room→null, which is what makes
    // `liveTurnRoomSource`'s per-call re-read (rather than an assembly-time
    // snapshot of `state.room`) observable in both directions.
    const electron = fakeElectron();
    await bootstrap({ electron, resourcesPath: null });

    const roomPath = path.join(freshUserDataDir(), `boot-${randomUUID()}.roomai`);
    await findHandler(electron, "create_room")(undefined, {
      path: roomPath,
      password: "correct horse battery staple",
      name: "index.test liveness fixture",
    });
    await findHandler(electron, "run_command")(undefined, {
      askId: randomUUID(),
      chatId: randomUUID(),
      command: "checkpoint",
      args: "before close",
      refs: [],
      raw: "#checkpoint before close",
    } satisfies RunCommandRequest);

    await findHandler(electron, "close_room")(undefined, {});

    await expect(
      findHandler(electron, "run_command")(undefined, {
        askId: randomUUID(),
        chatId: randomUUID(),
        command: "checkpoint",
        args: "after close",
        refs: [],
        raw: "#checkpoint after close",
      } satisfies RunCommandRequest)
    ).rejects.toThrow("No room is open.");
  });

  it("two rooms in one process: each #checkpoint lands in whichever room was open at the time", async () => {
    // The sharpest version of the same claim. A snapshot taken at assembly
    // time would send BOTH checkpoints to whichever room it captured (or to
    // none); a live view sends each to the room that was actually open. Both
    // rooms are then re-opened and read back, so the check is "alpha is in A
    // and only in A", not merely "the last write worked".
    const electron = fakeElectron();
    await bootstrap({ electron, resourcesPath: null });

    const dir = freshUserDataDir();
    const password = "correct horse battery staple";
    const roomA = path.join(dir, `boot-a-${randomUUID()}.roomai`);
    const roomB = path.join(dir, `boot-b-${randomUUID()}.roomai`);
    const checkpoint = (name: string): Promise<unknown> =>
      Promise.resolve(
        findHandler(electron, "run_command")(undefined, {
          askId: randomUUID(),
          chatId: randomUUID(),
          command: "checkpoint",
          args: name,
          refs: [],
          raw: `#checkpoint ${name}`,
        } satisfies RunCommandRequest)
      );
    const names = async (): Promise<string[]> =>
      ((await findHandler(electron, "list_room_checkpoints")(undefined, {})) as CheckpointList).entries.map(
        (e) => e.name
      );

    await findHandler(electron, "create_room")(undefined, { path: roomA, password, name: "A" });
    await checkpoint("alpha");
    await findHandler(electron, "close_room")(undefined, {});

    await findHandler(electron, "create_room")(undefined, { path: roomB, password, name: "B" });
    await checkpoint("beta");
    expect(await names()).toEqual(["beta"]);
    await findHandler(electron, "close_room")(undefined, {});

    await findHandler(electron, "open_room")(undefined, { path: roomA, password });
    expect(await names()).toEqual(["alpha"]);
    await findHandler(electron, "close_room")(undefined, {});
  });
});
