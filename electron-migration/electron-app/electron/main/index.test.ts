/**
 * Unit tests for `index.ts`'s own decision logic — the startup sequencing, the
 * single-instance-lock refusal, the completeness boot invariant, the
 * ready-to-show ordering, and the geometry/marker helpers — driven against
 * FAKE `electron` primitives, the same "accept it as a parameter, type it
 * against the real module, never import it at runtime" seam every
 * `registerXIpc` module here already uses.
 *
 * This is the complement to `index.electron.test.ts`, which proves the REAL
 * Electron process boots; this file proves the SEQUENCE is right, fast, and
 * without spawning a process for every edge case.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";

import {
  bootstrap,
  displaysToGeometryScreens,
  formatReadyMarker,
  preloadPath,
  READY_MARKER_PREFIX,
  type BootstrapElectron,
  type ReadyMarker,
} from "./index.js";
import { saveGeometryPath } from "./windowGeometry.js";

const tmpDirs: string[] = [];

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
  webContents = { send: vi.fn(), on: vi.fn() };
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
  show(): void {
    this.shown = true;
  }
}

interface FakeElectron extends BootstrapElectron {
  appListeners: Map<string, ((...args: unknown[]) => void)[]>;
}

function fakeElectron(overrides?: {
  requestSingleInstanceLock?: boolean;
  userDataDir?: string;
}): FakeElectron {
  const appListeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const userDataDir = overrides?.userDataDir ?? freshUserDataDir();
  return {
    appListeners,
    app: {
      requestSingleInstanceLock: vi.fn(() => overrides?.requestSingleInstanceLock ?? true),
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        const list = appListeners.get(event) ?? [];
        list.push(cb);
        appListeners.set(event, list);
      }),
      whenReady: vi.fn(() => Promise.resolve()),
      getVersion: vi.fn(() => "0.0.1-test"),
      getPath: vi.fn((name: string) => (name === "userData" ? userDataDir : os.tmpdir())),
      setPath: vi.fn(),
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
  };
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
    expect(preloadPath("/x/dist/electron/main")).toBe("/x/dist/electron/preload/index.js");
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
    expect(opts.webPreferences.preload.endsWith(path.join("preload", "index.js"))).toBe(true);
    // D10's two real requirements, asserted rather than assumed.
    expect(opts.webPreferences.contextIsolation).toBe(true);
    expect(opts.webPreferences.nodeIntegration).toBe(false);
    expect(opts.webPreferences.sandbox).toBe(false);

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
    const result = await bootstrap({ electron, resourcesPath: null });
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
    const result = await bootstrap({ electron, resourcesPath: null });
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
    const result = await bootstrap({ electron, resourcesPath: null });
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

  it("never calls setPath when no override is given", async () => {
    const electron = fakeElectron();
    await bootstrap({ electron, resourcesPath: null });
    expect(electron.app.setPath).not.toHaveBeenCalled();
  });
});
