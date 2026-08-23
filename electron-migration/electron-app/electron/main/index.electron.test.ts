/**
 * THE REAL BOOT PROOF — compiles the real `electron/**\/*.ts` sources, spawns
 * the actual Electron binary running the compiled `index.js` as its real main
 * process, drives it over Chrome DevTools Protocol via Playwright's `_electron`
 * launcher, and verifies:
 *
 *   1. the process starts without crashing and creates exactly one window;
 *   2. it logs an explicit ready marker once the window exists AND
 *      `registerAllIpc` has fully run, with a COMPLETE registry;
 *   3. the renderer has no direct Node access — `nodeIntegration: false`
 *      genuinely holds in the real isolated world;
 *   4. real IPC round trips work end to end through the REAL preload
 *      `contextBridge` (`window.arcelle.invoke`) — a real answer, a real
 *      `null`, and a real refusal reaching the renderer's catch block;
 *   5. the preload's D10 channel allowlist is actually WIRED (not merely
 *      unit-tested in isolation): an unknown channel is refused in the preload
 *      and never reaches `ipcMain`.
 *
 * Nothing here is a mock: a separate Electron process talking to itself over
 * its own real IPC transport.
 *
 * WHY `playwright` (already a devDependency): Electron's own story for "did a
 * real process boot and can the renderer really reach the main process" has no
 * lighter standard tool. `_electron.launch()` starts the exact binary this repo
 * already depends on as a genuine child process and exposes BOTH the main
 * process (`electronApp.evaluate`) and each window's page (`window.evaluate`,
 * running real JS inside that renderer through its real preload-exposed
 * `window.arcelle`) over CDP — exactly the two surfaces this test needs.
 *
 * ENVIRONMENT NOTES, both found empirically while building this:
 *   - This sandbox sets `ELECTRON_RUN_AS_NODE=1` globally, which makes the
 *     `electron` binary run as a plain Node script runner (`process.type`
 *     stays `undefined`, no `app`/`BrowserWindow` at all) rather than as a real
 *     Electron application — silently, with exit code 0 and no output, which
 *     looks exactly like "started and exited clean". It must be UNSET in the
 *     child's env for a real boot.
 *   - `--headless --disable-gpu --no-sandbox --disable-software-rasterizer` are
 *     additionally needed for the app to initialize without a GPU/display
 *     session here; without them the process HANGS indefinitely rather than
 *     crashing. Neither failure mode is specific to this app's code — a
 *     trivial `app.whenReady()` probe reproduced both first.
 *
 * ============================================================================
 * NATIVE-MODULE BOUNDARY — what this proof deliberately stops short of
 * ============================================================================
 * `better-sqlite3-multiple-ciphers` is a NATIVE module, and one installed copy
 * can serve exactly one ABI. This workspace's install is built for the Node
 * that runs vitest (`process.versions.modules` 137 on Node 24); the Electron
 * binary this test launches reports 148. So inside the spawned process every
 * `new Database(...)` throws `NODE_MODULE_VERSION` — i.e. `create_room` and
 * `open_room`, and therefore every room-scoped handler, cannot work here.
 *
 * That is a PACKAGING gap, not a defect in `index.ts`/`registry.ts`/the
 * preload: a verify pass ran `electron-rebuild -o
 * better-sqlite3-multiple-ciphers -v 43.4.1`, copied the assets above, and
 * drove the full DB-backed surface through this exact bootstrap — create_room,
 * rename_room, chat CRUD, add_memory/list_memories, search_all,
 * change_password + write_recovery_key + open_room_with_recovery, and a live
 * `room-files-changed` event from `create_sketch` — all green. Rebuilding
 * BACK is what keeps the other ~199 test files (which use the same native
 * module under plain Node) green, which is why this file does not ship those
 * round-trips.
 *
 * Resolving that split for good is a real, unsequenced migration step and NOT
 * mentioned anywhere in the plan. DECISION: `electron-builder install-app-deps`
 * at package time only, leaving this test permanently DB-free — the standard
 * pattern for Electron + native modules (this is exactly what
 * `install-app-deps`/a `postinstall` rebuild hook exists for), over
 * maintaining a second ABI-keyed copy selected via better-sqlite3's
 * `new Database(path, { nativeBinding })`: two on-disk copies of the same
 * native module drift out of sync across version bumps with nothing to catch
 * it, for a benefit (this one test file covering rooms too) that a dedicated
 * `electron-rebuild` + copy-back pass, like the one that produced the
 * round-trips above, already gets on demand. Wiring `install-app-deps` into
 * the real package/build step is Phase 5 scope, not yet started — do not let
 * the round-trips below be read as coverage of it in the meantime.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { READY_MARKER_PREFIX, type ReadyMarker } from "./index.js";

// Each `it()` here evaluates JS inside a REAL, separately spawned Electron
// process over CDP — slower than an in-process unit test even in isolation,
// and this file competes with ~190 others' worker threads for CPU when the
// full suite runs in parallel (vitest's default 5000ms per-test timeout flaked
// under that contention). Widened for this file only.
vi.setConfig({ testTimeout: 30_000 });

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..", ".."); // electron/main -> electron -> electron-app
const distDir = path.join(projectRoot, "dist_boot");
const mainScript = path.join(distDir, "electron", "main", "index.js");

/**
 * Every non-`.ts` file the compiled MAIN PROCESS reads at runtime, each
 * resolved beside its own module through `import.meta.url`. `tsc` emits only
 * `.ts`, so nothing copies these for us and a build without them is silently
 * broken rather than failing to compile.
 *
 * FOUND BY AN ADVERSARIAL VERIFY PASS, not by the round-trips below: this list
 * used to be just `bootStub.html`, so the compiled build had no `schema.sql` —
 * and `db-host/open.ts`'s `schemaSql()` reads it on EVERY room create/open.
 * `create_room` therefore failed in the real Electron process with a bare
 * `ENOENT … schema.sql`, taking every one of the ~150 room-scoped handlers
 * behind it with it. None of the original round-trips could see that, because
 * none of them ever opened a room — `list_roles` is a static catalog,
 * `room_info` answers `null` with no room, and `add_memory` was asserted to
 * REFUSE. All three pass identically with the entire database layer dead.
 * "Assets are present" is now its own test so the gap cannot reopen silently.
 * (Opening a real room from this test additionally needs the native-module
 * rebuild described in this file's NATIVE-MODULE BOUNDARY note below, which is
 * why the round-trips here still stop short of one.)
 *
 * `browserLive.worker.cjs` and `mcpFixtureStdioServer.mjs` are deliberately
 * NOT here: both are referenced only from `.test.ts` files, which this build
 * excludes. `page.js` IS here — `webviewManager.ts` hands `PAGE_SCRIPT_PATH`
 * to `session.registerPreloadScript`, so it is real runtime surface the
 * moment the browser lane is wired.
 */
const RUNTIME_ASSETS: readonly (readonly string[])[] = [
  ["electron", "main", "bootStub.html"],
  ["electron", "main", "db-host", "schema.sql"],
  ["electron", "main", "browser", "page.js"],
];

let electronApp: ElectronApplication;
let window: Page;
let userDataDir: string;
let stdoutChunks: string[];

beforeAll(async () => {
  // Self-contained: build the real compiled output this test launches, rather
  // than assuming someone ran a separate build step first. The direct
  // `node_modules/.bin/tsc` binary, not `npx tsc` — `npx` adds its own
  // package-resolution overhead on every invocation, which measurably matters
  // when this hook already competes with the rest of the suite for CPU.
  const tscBin = path.join(projectRoot, "node_modules", ".bin", "tsc");
  execFileSync(tscBin, ["-p", "tsconfig.build.json"], { cwd: projectRoot, stdio: "pipe" });
  // The non-`.ts` assets the compiled main process loads — see RUNTIME_ASSETS.
  for (const rel of RUNTIME_ASSETS) {
    cpSync(path.join(projectRoot, ...rel), path.join(distDir, ...rel));
  }

  userDataDir = mkdtempSync(path.join(os.tmpdir(), "arcelle-electron-boot-test-"));

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "ELECTRON_RUN_AS_NODE") {
      env[k] = v;
    }
  }
  env.ARCELLE_USER_DATA_DIR = userDataDir;

  stdoutChunks = [];
  electronApp = await electron.launch({
    args: ["--headless", "--disable-gpu", "--no-sandbox", "--disable-software-rasterizer", mainScript],
    env,
  });
  electronApp.process().stdout?.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk.toString("utf8"));
  });

  window = await electronApp.firstWindow();

  // `firstWindow()` resolves as soon as Playwright can attach to the window's
  // webContents — BEFORE `bootstrap()`'s own `ready-to-show` await resolves and
  // the marker is set (verified empirically: without this wait the marker
  // assertions flake on exactly how many milliseconds have elapsed). Poll for
  // the marker explicitly rather than assuming any fixed delay is enough.
  await waitForReadyMarker(electronApp, 30_000);
}, 180_000);

async function waitForReadyMarker(app: ElectronApplication, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const marker = await app.evaluate(
      () => (globalThis as unknown as { __arcelleReady?: unknown }).__arcelleReady
    );
    if (marker !== undefined) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`globalThis.__arcelleReady was not set within ${timeoutMs}ms of boot`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The real preload-exposed bridge, as the renderer sees it. */
type RendererArcelle = {
  invoke(channel: string, args: unknown): Promise<unknown>;
  on(channel: string, cb: (payload: unknown) => void): () => void;
};

afterAll(async () => {
  await electronApp?.close();
  if (userDataDir) {
    rmSync(userDataDir, { recursive: true, force: true });
  }
}, 60_000);

describe("real Electron boot (index.ts, compiled + launched for real)", () => {
  it("every non-.ts runtime asset the main process reads is present in the compiled build", () => {
    // Red on the version of this file that copied only `bootStub.html`.
    for (const rel of RUNTIME_ASSETS) {
      const assetPath = path.join(distDir, ...rel);
      expect(existsSync(assetPath), `${assetPath} missing from the compiled build`).toBe(true);
      expect(statSync(assetPath).size).toBeGreaterThan(0);
    }
  });

  it("starts without crashing and creates exactly one BrowserWindow", async () => {
    expect(window).toBeDefined();
    const windowCount = await electronApp.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length
    );
    expect(windowCount).toBe(1);
  });

  it("the main process reports a fully-registered, complete IPC registry via the ready marker", async () => {
    const marker = await electronApp.evaluate(
      () => (globalThis as unknown as { __arcelleReady?: ReadyMarker }).__arcelleReady
    );
    expect(marker).toBeDefined();
    expect(marker?.event).toBe("arcelle_main_ready");
    expect(marker?.completenessOk).toBe(true);
    expect(marker?.totalCommandCount).toBe(296);
    // 167 real Commands keys wired by the registry's 31 modules + the 2
    // documented non-Commands extras (restore_memory, dict-stop-timeout) — see
    // registry.ts's own KNOWN_* lists for the exact accounting.
    expect(marker?.registeredChannelCount).toBe(169);
  });

  it("the documented stdout ready-marker line was actually printed by the real process", () => {
    const combined = stdoutChunks.join("");
    expect(combined).toContain(READY_MARKER_PREFIX);
    const line = combined.split("\n").find((l) => l.startsWith(READY_MARKER_PREFIX));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line!.slice(READY_MARKER_PREFIX.length)) as ReadyMarker;
    expect(parsed.completenessOk).toBe(true);
  });

  it("the real renderer has no direct Node access (nodeIntegration: false holds)", async () => {
    const shapes = await window.evaluate(() => ({
      require: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (window as unknown as { process?: unknown }).process,
    }));
    expect(shapes).toEqual({ require: "undefined", process: "undefined" });
  });

  it("a real renderer page reaches window.arcelle through the real preload contextBridge", async () => {
    const shape = await window.evaluate(() => {
      const api = (window as unknown as { arcelle?: RendererArcelle }).arcelle;
      return { kind: typeof api, invoke: typeof api?.invoke, on: typeof api?.on };
    });
    expect(shape).toEqual({ kind: "object", invoke: "function", on: "function" });
  });

  it("a real IPC round trip: window.arcelle.invoke('list_roles') answers the real catalog", async () => {
    const roles = await window.evaluate(async () => {
      const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
      return api.invoke("list_roles", {});
    });
    expect(Array.isArray(roles)).toBe(true);
    expect((roles as unknown[]).length).toBeGreaterThan(0);
  });

  it("a real IPC round trip: room_info answers null with no room open", async () => {
    const info = await window.evaluate(async () => {
      const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
      return api.invoke("room_info", {});
    });
    expect(info).toBeNull();
  });

  it("a real IPC round trip: a room-scoped command's real refusal reaches the renderer's catch block", async () => {
    const message = await window.evaluate(async () => {
      const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
      try {
        await api.invoke("add_memory", { content: "hello from the real renderer", category: null });
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    });
    // `toContain`, not `toBe`: the REAL Electron IPC boundary (unlike the fake
    // `ipcMain`/`ipcRenderer` pairs the unit tests use) wraps a rejected
    // `ipcMain.handle` as `Error invoking remote method '<channel>': Error:
    // <original message>` — Electron's own behavior, not something this preload
    // adds or could strip without a further unwrapping layer. A renderer port
    // of `api.ts` wanting clean `err.message` parity with the Tauri convention
    // will need to peel that prefix off; noted here rather than silently masked
    // by a looser assertion that would stop proving the real message survives.
    expect(message).toContain("No room is open.");
  });

  it("the preload refuses an unknown channel from the real renderer, never reaching ipcMain", async () => {
    const message = await window.evaluate(async () => {
      const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
      try {
        await api.invoke("not_a_real_channel", {});
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    });
    expect(message).toContain("not_a_real_channel");
    expect(message).toContain("not a known IPC command channel");
  });

  it("the preload refuses a prototype-pollution-shaped channel too", async () => {
    const message = await window.evaluate(async () => {
      const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
      try {
        await api.invoke("__proto__", {});
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    });
    expect(message).toContain("not a known IPC command channel");
  });

  it("the preload's invoke REJECTS rather than throwing, so a bare .catch() call site works", async () => {
    // Proves the async contract holds across the real contextBridge, not just
    // against a fake ipcRenderer: no `await` inside the promise chain here, so
    // a synchronously-throwing `invoke` would escape this `.catch` entirely.
    const caught = await window.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
          api
            .invoke("not_a_real_channel", {})
            .then(() => resolve("RESOLVED — expected a rejection"))
            .catch((e: unknown) => resolve(e instanceof Error ? e.message : String(e)));
        })
    );
    expect(caught).toContain("not a known IPC command channel");
  });

  it("the preload exposes a working event subscription (on/unsubscribe) to the real renderer", async () => {
    const result = await window.evaluate(() => {
      const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
      const off = api.on("room-files-changed", () => undefined);
      const offType = typeof off;
      off();
      let refusedUnknown = false;
      try {
        api.on("not-a-real-event", () => undefined);
      } catch {
        refusedUnknown = true;
      }
      return { offType, refusedUnknown };
    });
    expect(result).toEqual({ offType: "function", refusedUnknown: true });
  });
});
