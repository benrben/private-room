/**
 * THE REAL BOOT PROOF — compiles the real desktop main/preload sources, spawns
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
 *      and never reaches `ipcMain`;
 *   6. the native menu really is installed, with `menu.ts`'s own rows — the
 *      one thing `menu.test.ts` structurally cannot check, since building a
 *      live `Electron.Menu` needs a real Electron process — and a real
 *      `menu_sync` invoke really moves that live menu, whose now-enabled row
 *      really reaches the renderer as a `menu-action` event;
 *   7. `run_command` really reaches `chatCommands.ts`'s `runCommand` through
 *      `liveContext.ts`'s real object graph;
 *   8. the `getDisplayMedia` handler is really registered, on a session really
 *      identical to `session.defaultSession`, and a real
 *      `navigator.mediaDevices.getDisplayMedia()` call from the real renderer
 *      really SETTLES (it hangs forever with no handler — `loopbackTap.ts`'s
 *      own doc). MEASURED while writing this, and recorded in `index.ts`'s own
 *      doc because it contradicts the bundled `electron.d.ts`: on macOS,
 *      Electron 43.4.1, the audio-only `{audio: true, video: false}` shape
 *      RESOLVES with a one-track stream;
 *   9. `arcelle.dialog`/`arcelle.shell` really exist on the real renderer's
 *      `window.arcelle`, and their channels really reach OUR handlers in the
 *      main process (proven by our own refusals coming back, not Electron's
 *      "no handler registered");
 *  10. the quit door, driven against a REAL `app.quit()` and a real window
 *      `close` on a real running app: held when the renderer has reported
 *      unsaved edits, answered through the real `quit-requested` event, and
 *      — in the second describe block below, each against its own freshly
 *      spawned process — really terminating the process on confirm, on a
 *      second press, and on a clean quit with nothing unsaved.
 *
 * Nothing here is a mock: a separate Electron process talking to itself over
 * its own real IPC transport.
 *
 * ============================================================================
 * ONE ARCELLE PROCESS AT A TIME, AND WHY — read before adding a launch
 * ============================================================================
 * `bootstrap` calls `app.requestSingleInstanceLock()` as step 1, BEFORE it
 * applies `userDataDirOverride` as step 2 (Electron's own ordering requirement
 * is about `setPath` vs `ready`, not about the lock). Chromium's process
 * singleton is keyed on the user-data directory, so that lock is taken against
 * the DEFAULT profile — the same one for every launch here, no matter how many
 * distinct `ARCELLE_USER_DATA_DIR` values are handed out. Two Arcelle processes
 * alive at once therefore collide, and the second dies with "Another instance
 * of Arcelle already holds the single-instance lock."
 *
 * Found empirically, running this suite for real. The consequence is
 * procedural, not a code change: the shared boot-proof instance is launched and
 * closed INSIDE its own `describe` (rather than at file level), so it is fully
 * gone before the quit-guard block below launches its own one-at-a-time
 * processes, which vitest runs next in file order.
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
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { EventEmitter } from "node:events";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { READY_MARKER_PREFIX, type ReadyMarker } from "./index.js";
import { CLOSE_ID, MENU_EVENT, QUIT_ID, VIEW_LIBRARY_ID } from "./menu.js";
import { QUIT_REQUESTED } from "./quitDoor.js";

// Each `it()` here evaluates JS inside a REAL, separately spawned Electron
// process over CDP — slower than an in-process unit test even in isolation,
// and this file competes with ~190 others' worker threads for CPU when the
// full suite runs in parallel (vitest's default 5000ms per-test timeout flaked
// under that contention). Widened for this file only.
vi.setConfig({ testTimeout: 30_000 });

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..", ".."); // src/main -> apps/desktop
const repoRoot = path.resolve(projectRoot, "..", "..");
const distDir = path.join(projectRoot, "dist_boot");
const mainScript = path.join(distDir, "src", "main", "index.js");
const skipPhysicalDisplayCapture = process.env.ARCELLE_SKIP_DISPLAY_MEDIA_CAPTURE === "1";

/** Build a genuine small minisign payload in Vitest's regular Node process.
 * Electron receives only the public verification inputs below: the disposable
 * private key never enters the application process. */
function signedUpdaterFixture() {
  const payload = Buffer.from("real Electron updater digest regression");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ type: "spki", format: "der" }).subarray(12);
  const keyId = Buffer.from("0123456789abcdef", "hex");
  const publicKeyFile =
    `untrusted comment: disposable updater test key\n` +
    `${Buffer.concat([Buffer.from("Ed", "latin1"), keyId, rawPub]).toString("base64")}\n`;
  const signature = cryptoSign(
    null,
    createHash("blake2b512").update(payload).digest(),
    privateKey,
  );
  const trustedComment = "timestamp:1\tfile:Arcelle.app.tar.gz";
  const globalSignature = cryptoSign(
    null,
    Buffer.concat([signature, Buffer.from(trustedComment, "utf8")]),
    privateKey,
  );
  const signatureFile =
    `untrusted comment: disposable updater test signature\n` +
    `${Buffer.concat([Buffer.from("ED", "latin1"), keyId, signature]).toString("base64")}\n` +
    `trusted comment: ${trustedComment}\n` +
    `${globalSignature.toString("base64")}\n`;
  return {
    payload: payload.toString("base64"),
    signature: Buffer.from(signatureFile, "utf8").toString("base64"),
    publicKey: Buffer.from(publicKeyFile, "utf8").toString("base64"),
  };
}

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
  ["src", "main", "bootStub.html"],
  ["src", "main", "db-host", "schema.sql"],
  ["src", "main", "browser", "page.js"],
];

let electronApp: ElectronApplication;
let window: Page;
let userDataDir: string;
let stdoutChunks: string[];

/** Launch the real compiled main script as a real Electron process, pointed at
 * an isolated user-data directory. ONE of these may be alive at a time — see
 * the module doc's single-instance-lock note. */
async function launchArcelle(dir: string): Promise<ElectronApplication> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "ELECTRON_RUN_AS_NODE") {
      env[k] = v;
    }
  }
  env.ARCELLE_USER_DATA_DIR = dir;
  // This suite exercises the host/preload boundary with the deliberately tiny
  // fixture page. The production build always supplies dist_package/renderer.
  env.ARCELLE_USE_BOOT_STUB = "1";
  return electron.launch({
    args: [
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-software-rasterizer",
      mainScript,
    ],
    env,
  });
}

beforeAll(() => {
  // Self-contained: build the real compiled output this test launches, rather
  // than assuming someone ran a separate build step first. The direct
  // `node_modules/.bin/tsc` binary, not `npx tsc` — `npx` adds its own
  // package-resolution overhead on every invocation, which measurably matters
  // when this hook already competes with the rest of the suite for CPU.
  const tscBin = path.join(repoRoot, "node_modules", ".bin", "tsc");
  execFileSync(tscBin, ["-p", "tsconfig.boot.json"], { cwd: projectRoot, stdio: "pipe" });
  execFileSync(process.execPath, [path.join(projectRoot, "scripts", "bundlePreload.mjs")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ARCELLE_PRELOAD_OUTFILE: path.join(distDir, "src", "preload", "index.cjs"),
    },
    stdio: "pipe",
  });
  // The non-`.ts` assets the compiled main process loads — see RUNTIME_ASSETS.
  for (const rel of RUNTIME_ASSETS) {
    cpSync(path.join(projectRoot, ...rel), path.join(distDir, ...rel));
  }
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

type ElectronChildProcess = ReturnType<ElectronApplication["process"]>;

function isExpectedTargetClosure(error: unknown): boolean {
  return /Target page, context or browser has been closed/.test(String(error));
}

/** Bound an external teardown promise and clear the losing timer. The original
 * promise remains observed by `then`, so a late rejection cannot become an
 * unhandled rejection after the deadline wins. */
function promiseWithin<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`${what} did not settle within ${ms}ms`)));
    }, ms);
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

/** Wait for a real child-process exit, or fail with a message that says which
 * quit did not take. */
function exitWithin(proc: ElectronChildProcess, ms: number, what: string): Promise<void> {
  if (proc.exitCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const onExit = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.removeListener("exit", onExit);
      reject(new Error(`the process did not exit within ${ms}ms of ${what}`));
    }, ms);
    proc.once("exit", onExit);
    // Close the race between the first exitCode read and listener install.
    if (proc.exitCode !== null) {
      onExit();
    }
  });
}

/** Bound Playwright's CDP close, then guarantee the exact captured child is
 * gone. A target-closed error after a successful terminal quit is expected;
 * any other close failure remains visible after exact-child cleanup. */
async function closeElectronApp(
  app: ElectronApplication,
  proc: ElectronChildProcess,
  closeTimeoutMs = 10_000,
): Promise<void> {
  let closeFailed = false;
  let closeError: unknown;
  let ignoreCloseError = false;
  try {
    await promiseWithin(app.close(), closeTimeoutMs, "Playwright app.close()");
  } catch (error) {
    closeFailed = true;
    closeError = error;
    ignoreCloseError = proc.exitCode !== null && isExpectedTargetClosure(error);
  }

  let termFailed = false;
  let termError: unknown;
  if (proc.exitCode === null) {
    proc.kill("SIGTERM");
    try {
      await exitWithin(proc, 5_000, "test cleanup SIGTERM");
    } catch (error) {
      termFailed = true;
      termError = error;
    }
  }
  if (proc.exitCode === null) {
    proc.kill("SIGKILL");
    await exitWithin(proc, 5_000, "test cleanup SIGKILL");
  }

  if (closeFailed && !ignoreCloseError && termFailed) {
    throw new AggregateError([closeError, termError], "Electron close and cleanup both failed");
  }
  if (closeFailed && !ignoreCloseError) {
    throw closeError;
  }
  if (termFailed) {
    throw termError;
  }
}

/** Preserve the test's primary failure even when teardown fails too. */
async function runWithCleanup(
  body: () => Promise<void>,
  cleanup: () => Promise<void>,
): Promise<void> {
  let bodyFailed = false;
  let bodyError: unknown;
  try {
    await body();
  } catch (error) {
    bodyFailed = true;
    bodyError = error;
  }

  let cleanupFailed = false;
  let cleanupError: unknown;
  try {
    await cleanup();
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }

  if (bodyFailed && cleanupFailed) {
    throw new AggregateError([bodyError, cleanupError], "Electron test body and cleanup both failed");
  }
  if (bodyFailed) {
    throw bodyError;
  }
  if (cleanupFailed) {
    throw cleanupError;
  }
}

/** The real preload-exposed bridge, as the renderer sees it. */
type RendererArcelle = {
  invoke(channel: string, args: unknown): Promise<unknown>;
  on(channel: string, cb: (payload: unknown) => void): () => void;
  // Only the members these tests actually call are typed; `Object.keys` on the
  // namespaces is what checks the rest is there.
  dialog: {
    ask?: unknown;
    open(options?: Record<string, unknown>): Promise<string | string[] | null>;
    save(options?: Record<string, unknown>): Promise<string | null>;
    message(message: string, options?: unknown): Promise<string>;
    confirm(message: string, options?: unknown): Promise<boolean>;
  };
  shell: {
    openUrl(url: string, openWith?: string): Promise<void>;
    openPath(path: string, openWith?: string): Promise<void>;
    revealItemInDir(path: string | string[]): Promise<void>;
  };
};

describe("real Electron boot (index.ts, compiled + launched for real)", () => {
  // Scoped to THIS block, not the file, so the process is closed before the
  // quit-guard block below launches its own — see the module doc's
  // single-instance-lock note.
  beforeAll(async () => {
    userDataDir = mkdtempSync(path.join(os.tmpdir(), "arcelle-electron-boot-test-"));
    stdoutChunks = [];
    electronApp = await launchArcelle(userDataDir);
    electronApp.process().stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk.toString("utf8"));
    });

    window = await electronApp.firstWindow();

    // `firstWindow()` resolves as soon as Playwright can attach to the window's
    // webContents — BEFORE `bootstrap()`'s own `ready-to-show` await resolves
    // and the marker is set (verified empirically: without this wait the marker
    // assertions flake on exactly how many milliseconds have elapsed). Poll for
    // the marker explicitly rather than assuming any fixed delay is enough.
    await waitForReadyMarker(electronApp, 30_000);
  }, 180_000);

  afterAll(async () => {
    if (electronApp) {
      const proc = electronApp.process();
      try {
        await closeElectronApp(electronApp, proc);
      } finally {
        if (userDataDir && proc.exitCode !== null) {
          rmSync(userDataDir, { recursive: true, force: true });
        }
      }
    } else if (userDataDir) {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  }, 60_000);

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

  it("GH #40: verifies a prehashed update signature in the real Electron main process", async () => {
    const fixture = signedUpdaterFixture();
    const verifierPath = path.join(distDir, "src", "main", "updater", "minisignVerify.js");
    const result = await electronApp.evaluate(
      async (_electron, input: typeof fixture & { verifierPath: string }) => {
        try {
          // Keep module loading inside the spawned Electron process. A dynamic
          // import in Playwright's evaluation VM has no import callback, while
          // Node 24's createRequire can synchronously load this no-TLA ESM
          // module and its normal production dependencies.
          const nodeModule = process.getBuiltinModule("node:module") as typeof import("node:module");
          const requireInElectron = nodeModule.createRequire(input.verifierPath);
          const verifier = requireInElectron(input.verifierPath) as {
            verifyManifestSignature(
              payload: Buffer,
              manifestSignatureB64: string,
              pubkeyB64: string,
            ): void;
          };
          verifier.verifyManifestSignature(
            Buffer.from(input.payload, "base64"),
            input.signature,
            input.publicKey,
          );
          return { ok: true, error: "" };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
      { ...fixture, verifierPath },
    );
    expect(result, result.error).toEqual({ ok: true, error: "" });
  });

  it("the main process reports a fully-registered, complete IPC registry via the ready marker", async () => {
    const marker = await electronApp.evaluate(
      () => (globalThis as unknown as { __arcelleReady?: ReadyMarker }).__arcelleReady
    );
    expect(marker).toBeDefined();
    expect(marker?.event).toBe("arcelle_main_ready");
    expect(marker?.completenessOk).toBe(true);
    // This count is pinned independently in `channelAllowlist.test.ts`, where
    // the typed object literal proves it is exactly every `Commands` key.
    expect(marker?.totalCommandCount).toBe(326);
    // Every Commands key plus the two documented non-Commands compatibility
    // channels (`restore_memory` and `dict-stop-timeout`).
    expect(marker?.registeredChannelCount).toBe(328);
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

  it("a file-origin viewer can fetch roommedia through the real custom protocol", async () => {
    const result = await window.evaluate(async () => {
      try {
        // A missing token is intentional: it exercises scheme registration,
        // CORS, Fetch support and the real protocol handler without opening a
        // SQLCipher room (which this test process cannot do across the native
        // ABI boundary documented above). Before `corsEnabled`, Chromium
        // rejected this at Fetch with the same `TypeError: Failed to fetch`
        // shown by the XLSX and PDF viewers. A working transport reaches our
        // handler and receives its precise 404 response instead.
        const response = await fetch("roommedia://localhost/not-staged");
        return { status: response.status, body: await response.text() };
      } catch (error) {
        return { status: -1, body: String(error) };
      }
    });
    expect(result).toEqual({ status: 404, body: "media not staged" });
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

  // ==========================================================================
  // arcelle.dialog / arcelle.shell — really bridged, really registered
  // ==========================================================================
  //
  // WHAT IS DELIBERATELY NOT DRIVEN HERE: a real `dialog_open`/`dialog_save`.
  // Those open an actual macOS panel, which nothing automated can answer — a
  // verify pass confirmed it by hanging for a full 30s timeout. Their
  // reachability is covered by the registered-channel count above (an exact
  // number, so a missing registration fails it) plus `dialogTools.test.ts`'s
  // behavioral coverage. Every probe below is one whose refusal comes from OUR
  // validation before any panel or OS handoff.

  it("the real renderer's window.arcelle carries the dialog and shell namespaces", async () => {
    const shape = await window.evaluate(() => {
      const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
      return {
        dialog: Object.keys(api.dialog ?? {}).sort(),
        shell: Object.keys(api.shell ?? {}).sort(),
        askIsFunction: typeof api.dialog?.ask,
      };
    });
    expect(shape).toEqual({
      dialog: ["ask", "confirm", "message", "open", "save"],
      shell: ["openPath", "openUrl", "revealItemInDir"],
      askIsFunction: "function",
    });
  });

  it("dialog_message reaches OUR handler — refused by our own validation, not Electron's", async () => {
    // The two possible failures look nothing alike, which is what makes this a
    // real registration proof: a missing handler is Electron's own "No handler
    // registered for …", and a preload refusal names the allowlist. This is
    // neither — it is `dialogTools.ts`'s own message.
    const message = await window.evaluate(async () => {
      const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
      try {
        await api.invoke("dialog_message", {});
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    });
    expect(message).toContain("dialog_message needs a string `message`.");
  });

  it("open_url really enforces the URL scope inside the real main process", async () => {
    const message = await window.evaluate(async () => {
      const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
      try {
        await api.shell.openUrl("file:///etc/passwd");
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    });
    // Reached `shellTools.ts` and was refused there — nothing was handed to
    // the OS, and the whole trip went through the real `arcelle.shell` sugar.
    expect(message).toContain("outside the app's URL scope");
  });

  it("open_path and reveal_item_in_dir reach OUR handlers too", async () => {
    const messages = await window.evaluate(async () => {
      const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
      const capture = async (fn: () => Promise<unknown>): Promise<string> => {
        try {
          await fn();
          return "resolved — expected a refusal";
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      };
      return {
        openPath: await capture(() => api.shell.openPath("")),
        reveal: await capture(() => api.shell.revealItemInDir([])),
      };
    });
    expect(messages.openPath).toContain("non-empty `path`");
    expect(messages.reveal).toContain("non-empty `paths`");
  });

  // ==========================================================================
  // THE PLUGIN SURFACES' SUCCESS PATHS
  // ==========================================================================
  //
  // Every dialog/shell check above asserts a REFUSAL, so a pair of handlers
  // that did nothing but validate their arguments and throw would satisfy all
  // of them — the accepted argument, the native call it turns into and the
  // answer it maps back are all still unwitnessed. These two drive that half.
  //
  // A native panel cannot be driven from here: `showMessageBox` is modal and
  // this process is headless, and `shell.openExternal`/`showItemInFolder` would
  // launch real applications on the machine running the suite. So each test
  // replaces the primitive IN THE RUNNING MAIN PROCESS with a recorder. That is
  // not a weaker seam than the handler's own `deps` — it is the SAME object:
  // `bootstrap` injects `electronModule.dialog`/`.shell` by reference, so
  // patching a method on it proves the handler resolves that method off the
  // injected object at CALL time, and a handler wired to anything else records
  // nothing and fails here.

  it("a real dialog round trip reaches Electron's own dialog object, sheeted on the window, and answers with a plugin RESULT TOKEN", async () => {
    await electronApp.evaluate(({ dialog, BrowserWindow }) => {
      const box = globalThis as unknown as {
        __dlgCalls?: {
          method: string;
          sheeted: boolean;
          buttons: unknown;
          defaultId: unknown;
          cancelId: unknown;
          type: unknown;
          properties: unknown;
          filters: unknown;
          message: unknown;
          buttonLabel: unknown;
        }[];
        __msgResponse?: number;
        __dlgRestore?: () => void;
      };
      const calls: NonNullable<typeof box.__dlgCalls> = [];
      box.__dlgCalls = calls;
      box.__msgResponse = 0;
      const d = dialog as unknown as Record<string, unknown>;
      const originals = {
        showMessageBox: d.showMessageBox,
        showOpenDialog: d.showOpenDialog,
        showSaveDialog: d.showSaveDialog,
      };
      const record = (method: string, args: unknown[]): void => {
        // Two-argument form == the parent-window overload, i.e. a real macOS
        // SHEET rather than a free-floating panel. That choice lives in
        // `dialogTools.ts` and is invisible to every unit test that hands it a
        // fake with one call signature.
        const sheeted = args.length > 1 && args[0] instanceof BrowserWindow;
        const options = (args.length > 1 ? args[1] : args[0]) as Record<string, unknown>;
        calls.push({
          method,
          sheeted,
          buttons: options.buttons ?? null,
          defaultId: options.defaultId ?? null,
          cancelId: options.cancelId ?? null,
          type: options.type ?? null,
          properties: options.properties ?? null,
          filters: options.filters ?? null,
          message: options.message ?? null,
          buttonLabel: options.buttonLabel ?? null,
        });
      };
      d.showMessageBox = (...args: unknown[]) => {
        record("showMessageBox", args);
        return Promise.resolve({ response: box.__msgResponse ?? 0 });
      };
      d.showOpenDialog = (...args: unknown[]) => {
        record("showOpenDialog", args);
        return Promise.resolve({ canceled: false, filePaths: ["/tmp/one.md", "/tmp/two.md"] });
      };
      d.showSaveDialog = (...args: unknown[]) => {
        record("showSaveDialog", args);
        return Promise.resolve({ canceled: true, filePath: "" });
      };
      box.__dlgRestore = () => {
        Object.assign(d, originals);
      };
    });

    try {
      // ---- the OK button, actually clicked -------------------------------
      const okClicked = await window.evaluate(async () => {
        const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
        return api.dialog.confirm("Delete this note?");
      });
      const afterConfirm = await electronApp.evaluate(
        () => (globalThis as unknown as { __dlgCalls: unknown[] }).__dlgCalls
      );
      expect(afterConfirm).toHaveLength(1);
      expect(afterConfirm[0]).toMatchObject({
        method: "showMessageBox",
        sheeted: true,
        // What the user SEES is macOS's own capitalization…
        buttons: ["OK", "Cancel"],
        defaultId: 0,
        cancelId: 1,
        type: "info",
      });
      // …and what the caller is TOLD is the plugin's `'Ok'` token, which is the
      // only reason this is `true`. These two assertions must be read together:
      // a handler answering with the clicked LABEL shows an identical panel,
      // records an identical call, and makes this `false` — every
      // un-customized `confirm()` in the frontend silently refusing to act.
      expect(okClicked, "confirm() answered false for the OK button").toBe(true);

      // ---- the Cancel button, actually clicked ---------------------------
      await electronApp.evaluate(() => {
        (globalThis as unknown as { __msgResponse: number }).__msgResponse = 1;
      });
      const cancelClicked = await window.evaluate(async () => {
        const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
        return api.dialog.confirm("Delete this note?");
      });
      expect(cancelClicked, "confirm() answered true for the Cancel button").toBe(false);

      // ---- open/save: the real panels' real answers, mapped --------------
      const picked = await window.evaluate(async () => {
        const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
        return {
          many: await api.dialog.open({
            multiple: true,
            filters: [{ name: "Notes", extensions: ["md"] }],
          }),
          one: await api.dialog.open({}),
          room: await api.dialog.open({
            room: true,
            message: "Select the Arcelle workspace folder, then click Open Room.",
            buttonLabel: "Open Room",
          }),
          saved: await api.dialog.save({ defaultPath: "/tmp/x.md" }),
        };
      });
      // `multiple` discriminates the SHAPE of the answer, not just the panel:
      // an array for a multi-pick, the single path for a single one.
      expect(picked.many).toEqual(["/tmp/one.md", "/tmp/two.md"]);
      expect(picked.one).toBe("/tmp/one.md");
      expect(picked.room).toBe("/tmp/one.md");
      // A canceled save is `null`, never `""` — a call site that wrote to the
      // empty string would be writing to the process's cwd.
      expect(picked.saved).toBeNull();

      const allCalls = await electronApp.evaluate(
        () =>
          (globalThis as unknown as {
            __dlgCalls: {
              method: string;
              properties: unknown;
              filters: unknown;
              message: unknown;
              buttonLabel: unknown;
            }[];
          })
            .__dlgCalls
      );
      const opens = allCalls.filter((c) => c.method === "showOpenDialog");
      expect(opens).toHaveLength(3);
      expect(opens[0]?.properties).toEqual(["openFile", "multiSelections", "createDirectory"]);
      expect(opens[0]?.filters).toEqual([{ name: "Notes", extensions: ["md"] }]);
      // No `multiple` on the second — so no `multiSelections`, which is what
      // makes its answer a bare string above.
      expect(opens[1]?.properties).toEqual(["openFile", "createDirectory"]);
      // The renderer's room picker must survive the preload and main-process
      // runtime validator with BOTH selectable shapes. Dropping `room: true`
      // makes macOS treat folders only as locations to browse into—the exact
      // installed-app regression this end-to-end assertion prevents.
      expect(opens[2]).toMatchObject({
        properties: ["openFile", "openDirectory", "createDirectory"],
        message: "Select the Arcelle workspace folder, then click Open Room.",
        buttonLabel: "Open Room",
      });
      expect(allCalls.filter((c) => c.method === "showSaveDialog")).toHaveLength(1);
    } finally {
      await electronApp.evaluate(() => {
        (globalThis as unknown as { __dlgRestore?: () => void }).__dlgRestore?.();
      });
    }
  });

  it("an ALLOWED open_url really reaches Electron's shell — the settings-pane scheme this app's own help link uses included", async () => {
    await electronApp.evaluate(({ shell }) => {
      const box = globalThis as unknown as {
        __shellCalls?: { method: string; arg: string }[];
        __shellRestore?: () => void;
      };
      const calls: NonNullable<typeof box.__shellCalls> = [];
      box.__shellCalls = calls;
      const s = shell as unknown as Record<string, unknown>;
      const originals = {
        openExternal: s.openExternal,
        openPath: s.openPath,
        showItemInFolder: s.showItemInFolder,
      };
      s.openExternal = (url: string) => {
        calls.push({ method: "openExternal", arg: url });
        return Promise.resolve();
      };
      // `shell.openPath`'s real contract: it RESOLVES with an error string,
      // `""` for success. The empty string here is what proves `openPath`
      // reads that sentinel rather than only ever rejecting.
      s.openPath = (p: string) => {
        calls.push({ method: "openPath", arg: p });
        return Promise.resolve("");
      };
      s.showItemInFolder = (p: string) => {
        calls.push({ method: "showItemInFolder", arg: p });
      };
      box.__shellRestore = () => {
        Object.assign(s, originals);
      };
    });

    try {
      const outcome = await window.evaluate(async () => {
        const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
        const settled = async (fn: () => Promise<unknown>): Promise<string> => {
          try {
            await fn();
            return "resolved";
          } catch (e) {
            return e instanceof Error ? e.message : String(e);
          }
        };
        return {
          https: await settled(() => api.shell.openUrl("https://arcelle.app/help")),
          // The exact string `viewers/RecordingView.tsx` opens. `opener:default`'s
          // regex alone refuses it; `capabilities/default.json` is what grants
          // it, and `EXTRA_URL_SCHEMES` is the port of that grant.
          pane: await settled(() =>
            api.shell.openUrl(
              "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
            )
          ),
          path: await settled(() => api.shell.openPath("/tmp/arcelle-verify-openpath")),
          reveal: await settled(() =>
            api.shell.revealItemInDir(["/tmp/arcelle-a", "/tmp/arcelle-b"])
          ),
          refused: await settled(() => api.shell.openUrl("file:///etc/passwd")),
        };
      });

      expect(outcome.https).toBe("resolved");
      expect(
        outcome.pane,
        "the app's own Screen-Recording help link was refused by its own URL scope"
      ).toBe("resolved");
      expect(outcome.path).toBe("resolved");
      expect(outcome.reveal).toBe("resolved");
      expect(outcome.refused).toContain("outside the app's URL scope");

      const calls = await electronApp.evaluate(
        () => (globalThis as unknown as { __shellCalls: { method: string; arg: string }[] }).__shellCalls
      );
      // In order, and NOTHING else — the refusal above must not appear here at
      // all: a scope check that ran after the OS had already been handed the
      // string would be no check.
      expect(calls).toEqual([
        { method: "openExternal", arg: "https://arcelle.app/help" },
        {
          method: "openExternal",
          arg: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        },
        { method: "openPath", arg: "/tmp/arcelle-verify-openpath" },
        // One `showItemInFolder` per path — the plugin takes a list, Electron
        // takes one at a time.
        { method: "showItemInFolder", arg: "/tmp/arcelle-a" },
        { method: "showItemInFolder", arg: "/tmp/arcelle-b" },
      ]);
    } finally {
      await electronApp.evaluate(() => {
        (globalThis as unknown as { __shellRestore?: () => void }).__shellRestore?.();
      });
    }
  });

  // ==========================================================================
  // The native application menu — really built, really installed, really live
  // ==========================================================================

  it("a real Electron.Menu carrying menu.ts's own rows is installed as THE application menu", async () => {
    // `menu.test.ts` cannot check any of this: it tests `MENU_SPEC` and
    // `buildTemplate` as data, because constructing a live `Electron.Menu`
    // needs a real Electron process. This is that process.
    const shape = await electronApp.evaluate(
      ({ Menu }, ids: { quit: string; close: string; library: string }) => {
        const menu = Menu.getApplicationMenu();
        if (menu === null) return null;
        const quit = menu.getMenuItemById(ids.quit);
        const close = menu.getMenuItemById(ids.close);
        // Reached only by `getMenuItemById`'s whole-tree search — the property
        // `menuSync` depends on and Tauri's `Submenu::get` did not have.
        const library = menu.getMenuItemById(ids.library);
        return {
          quitLabel: quit?.label,
          quitAccelerator: quit?.accelerator,
          quitEnabled: quit?.enabled,
          closeAccelerator: close?.accelerator,
          libraryType: library?.type,
          libraryEnabled: library?.enabled,
        };
      },
      { quit: QUIT_ID, close: CLOSE_ID, library: VIEW_LIBRARY_ID }
    );
    expect(shape).toEqual({
      quitLabel: "Quit Arcelle",
      quitAccelerator: "CmdOrCtrl+Q",
      // `alwaysEnabled` — both mean something with no room open.
      quitEnabled: true,
      closeAccelerator: "CmdOrCtrl+W",
      libraryType: "checkbox",
      // Gated until a room mounts and menu_sync says otherwise.
      libraryEnabled: false,
    });
  });

  it("the LIVE menu still carries the Edit section's clipboard key equivalents", async () => {
    // `menu.ts`'s own "THE ONE THING THAT MAKES THIS MODULE DANGEROUS":
    // `Menu.setApplicationMenu` REPLACES the platform default wholesale, so a
    // template missing the Edit section silently kills ⌘C/⌘V/⌘X/⌘A in every
    // text field in the app — including the password gate, where pasting a
    // passphrase out of a password manager is the expected way in.
    // `menu.test.ts` can only check that `MENU_SPEC` declares them; this
    // checks the menu that was actually INSTALLED in a real process, which is
    // the only place the failure would ever show up.
    const live = await electronApp.evaluate(({ Menu }, quitId: string) => {
      const roles: string[] = [];
      const walk = (items: Electron.MenuItem[]): void => {
        for (const item of items) {
          if (typeof item.role === "string") {
            roles.push(item.role.toLowerCase());
          }
          if (item.submenu) {
            walk(item.submenu.items);
          }
        }
      };
      const menu = Menu.getApplicationMenu();
      if (menu !== null) {
        walk(menu.items);
      }
      const quit = menu?.getMenuItemById(quitId);
      return { roles, quitRole: quit?.role ?? null, quitId: quit?.id ?? null };
    }, QUIT_ID);

    for (const role of ["undo", "redo", "cut", "copy", "paste", "selectall"]) {
      expect(live.roles, `the live menu lost the "${role}" row`).toContain(role);
    }
    // And the Quit row really is OURS, not the platform's. The predefined
    // `role: "quit"` row cannot be held long enough to ask about an unsaved
    // buffer — the exact defect that made the Rust app's ⌘Q discard an edited
    // note without asking (see menu.ts's QUIT_ID doc).
    expect(live.quitRole).toBeNull();
    expect(live.quitId).toBe(QUIT_ID);
  });

  it("a real menu_sync invoke moves the REAL menu, and the row it enabled then reaches the real renderer", async () => {
    // One chain, end to end: the renderer invokes `menu_sync` over the real
    // preload → the registry's host bridge → `menuSync` → the very
    // `Electron.Menu` instance `setApplicationMenu` installed. Then that
    // now-enabled row is clicked for real and the event comes back out
    // through `dispatch` → `webContents.send` → the preload's `on`.
    const received = window.evaluate(
      (eventName) =>
        new Promise<unknown>((resolve) => {
          const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
          api.on(eventName, (payload) => resolve(payload));
        }),
      MENU_EVENT
    );

    await window.evaluate(async () => {
      const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
      await api.invoke("menu_sync", {
        view: {
          enabled: true,
          library: true,
          assistant: false,
          focus: false,
          railLabels: false,
          railLabelsSettable: true,
          sidebar: "Sketches",
        },
      });
    });

    const afterSync = await electronApp.evaluate(({ Menu }, id: string) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(id);
      return { checked: item?.checked, enabled: item?.enabled, label: item?.label };
    }, VIEW_LIBRARY_ID);
    // The ⌘1 row is retitled to the destination's own word for its second
    // column — `sidebarLabel`, on the live menu.
    expect(afterSync).toEqual({ checked: true, enabled: true, label: "Sketches" });

    await electronApp.evaluate(({ Menu }, id: string) => {
      Menu.getApplicationMenu()?.getMenuItemById(id)?.click();
    }, VIEW_LIBRARY_ID);
    expect(await received).toBe(VIEW_LIBRARY_ID);
  });

  // ==========================================================================
  // run_command — the real #command dispatch, over a real assembleLiveContext
  // ==========================================================================

  it("a real run_command invoke reaches the real catalog validation", async () => {
    // Before this wiring, `run_command` was not registered at all and this
    // call would reject with Electron's own generic "No handler registered
    // for 'run_command'". This message can only come from `runCommand`.
    const message = await window.evaluate(async () => {
      const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
      try {
        await api.invoke("run_command", {
          askId: "boot-test-ask-1",
          chatId: "boot-test-chat-1",
          command: "not-a-real-command",
          args: "",
          refs: [],
          raw: "#not-a-real-command",
        });
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    });
    expect(message).toContain("Unknown command #not-a-real-command.");
  });

  it("a real run_command invoke refuses with the real 'No room is open.' when none is", async () => {
    // The full happy path (a real room, a real #checkpoint, read back through
    // a different reader) is in `index.test.ts`, which runs under an ABI that
    // can open one — see this file's NATIVE-MODULE BOUNDARY note.
    const message = await window.evaluate(async () => {
      const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
      try {
        await api.invoke("run_command", {
          askId: "boot-test-ask-2",
          chatId: "boot-test-chat-2",
          command: "checkpoint",
          args: "",
          refs: [],
          raw: "#checkpoint",
        });
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    });
    expect(message).toContain("No room is open.");
  });

  // ==========================================================================
  // The webRequest funnel — reachable, and deliberately not reached YET
  // ==========================================================================

  it("the private-browser IPC surface is live in the real main process", async () => {
    const info = await window.evaluate(async () => {
      const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
      return api.invoke("browser_info", {});
    });
    expect(info).toEqual({ open: false });
  });

  it("registerWebRequestFunnel really attaches to a fresh ephemeral session inside the real process", async () => {
    // The other half of the same claim: the funnel is not wired at boot, but
    // it IS reachable and it DOES work against the real `session` API — so
    // what is missing is the gated batch that would call it, not a broken
    // module. Registered here exactly as `webviewManager.createLivePage` does
    // it: a fresh, never-reused, non-`persist:` partition, whose ephemerality
    // is asserted alongside (`verifyPageEphemeral`'s own two questions).
    const funnelPath = path.join(distDir, "src", "main", "browser", "webRequestFunnel.js");
    const result = await electronApp.evaluate(({ session }, modulePath: string) => {
      // WHY `process.mainModule.require` AND NOT `import()`. This callback's
      // source is serialized and eval'd inside the real main process, and
      // BOTH obvious spellings fail there, each for its own reason:
      //   - a literal `import(...)` is rewritten by vitest's Vite SSR
      //     transform into `__vite_ssr_dynamic_import__`, a helper that lives
      //     only in this test file's module scope (`ReferenceError` over
      //     there);
      //   - hiding it in a `new Function("u", "return import(u)")` gets past
      //     the transform and then dies in V8 with "A dynamic import callback
      //     was not specified" — an eval'd CDP context has no host import
      //     hook at all.
      // The main process's own `require` DOES resolve from there (Node's
      // `require(esm)` handles this ESM build, verified rather than assumed),
      // and `require` is not a global in an Electron main process, so it is
      // reached through `process.mainModule`.
      const mainModule = (process as unknown as {
        mainModule?: { require?: (id: string) => unknown };
      }).mainModule;
      if (typeof mainModule?.require !== "function") {
        throw new Error("no require available in the main process eval context");
      }
      const mod = mainModule.require(modulePath) as {
        registerWebRequestFunnel: (
          s: unknown,
          d: {
            recordedTopUrl: () => string | undefined;
            journal: (kind: string, url: string, detail: string) => void;
            emitBlocked: (url: string) => void;
            countBlocked: () => void;
          }
        ) => { ok: boolean };
      };
      const fresh = session.fromPartition(`arcelle-verify-funnel-${Date.now()}`);
      const attached = mod.registerWebRequestFunnel(fresh, {
        recordedTopUrl: () => undefined,
        journal: () => undefined,
        emitBlocked: () => undefined,
        countBlocked: () => undefined,
      });
      return {
        ok: attached.ok,
        persistent: fresh.isPersistent(),
        storagePath: fresh.getStoragePath(),
        // The root session is a DIFFERENT session — the funnel never lands on
        // the one this window's renderer uses.
        isDefaultSession: fresh === session.defaultSession,
      };
    }, funnelPath);

    expect(result).toEqual({
      ok: true,
      persistent: false,
      storagePath: null,
      isDefaultSession: false,
    });
  });

  // ==========================================================================
  // getDisplayMedia
  // ==========================================================================

  it("the window's own session IS session.defaultSession — the 'which session' decision, confirmed", async () => {
    const isDefault = await electronApp.evaluate(({ BrowserWindow, session }) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      return win.webContents.session === session.defaultSession;
    });
    expect(isDefault).toBe(true);
  });

  /** How many times `event` appears across both generations of `obs.ts`'s
   * host log — see the caller for why both, and why a count rather than a
   * containment check. `writeRaw` is `fs.writeSync`, so a line is on disk the
   * moment the logging call returns; no settling delay is needed. */
  function countInHostLog(event: string): number {
    let total = 0;
    for (const file of ["arcelle-host.log", "arcelle-host.prev.log"]) {
      const p = path.join(os.tmpdir(), file);
      if (!existsSync(p)) {
        continue;
      }
      total += readFileSync(p, "utf8").split(event).length - 1;
    }
    return total;
  }

  /**
   * Drive one real `navigator.mediaDevices.getDisplayMedia()` in the real
   * renderer and report what it did, as a single string: `resolved:<kinds>`,
   * `rejected:<ErrorName>`, or `HUNG` if it never settled at all. Tracks are
   * stopped on the way out — a granted capture left running would keep a live
   * screen/loopback capture (and its recording indicator) alive for the rest
   * of the file, which is the same hygiene `loopbackTap.ts` observes.
   */
  async function driveGetDisplayMedia(constraints: unknown): Promise<string> {
    return window.evaluate((c) => {
      // Cast through `globalThis`: this callback really runs in the real
      // renderer's DOM over CDP, but this FILE compiles under the main
      // process's Node-only lib, where `navigator` has no type.
      const nav = (
        globalThis as unknown as {
          navigator: {
            mediaDevices: {
              getDisplayMedia(
                constraints: unknown
              ): Promise<{ getTracks(): { kind: string; stop(): void }[] }>;
            };
          };
        }
      ).navigator;
      return Promise.race([
        nav.mediaDevices
          .getDisplayMedia(c)
          .then((s) => {
            const kinds = s
              .getTracks()
              .map((t) => t.kind)
              .sort()
              .join(",");
            s.getTracks().forEach((t) => t.stop());
            return `resolved:${kinds}`;
          })
          .catch((e: unknown) => `rejected:${e instanceof Error ? e.name : String(e)}`),
        new Promise<string>((resolve) => setTimeout(() => resolve("HUNG"), 10_000)),
      ]);
    }, constraints);
  }

  // ==========================================================================
  // WHAT A REAL getDisplayMedia DOES ON THIS BUILD — measured, four ways
  // ==========================================================================
  // The two assertions below are `resolved:…`, NOT the weaker "it settled",
  // and that is a correction rather than a preference. `loopbackTap.ts` (and
  // `index.ts` quoting it) says the pre-wiring failure mode is a promise that
  // "hangs against a handler nobody answers". A verify pass measured all four
  // configurations against this exact bootstrap, Electron 43.4.1 on macOS,
  // by temporarily varying only the registration in `index.ts`:
  //
  //   handler as shipped        audio-only → resolved:audio       (~220ms)
  //                             audio+video → resolved:audio,video (~290ms)
  //   NO handler registered     BOTH → rejected:NotSupportedError  (<1ms)
  //   handler, never calls back BOTH → HUNG (>8s, never settles)
  //   handler answers `{}`      audio-only → rejected:NotAllowedError
  //                             audio+video → rejected:AbortError
  //
  // So an UNREGISTERED handler does not hang at all — it refuses instantly —
  // and a test asserting only `not.toBe("HUNG")` passes just as happily with
  // the registration deleted. It proves nothing about this wiring. Only the
  // hang row belongs to a registered-but-silent handler, which is exactly why
  // the `callback({})` arm on the rejection path of `index.ts`'s handler is
  // load-bearing rather than defensive: that arm IS the difference between
  // this row and the one above it.

  it.skipIf(skipPhysicalDisplayCapture)(
    "a real audio-only getDisplayMedia() is GRANTED by the handler this bootstrap registered",
    async () => {
      // `loopbackTap.ts`'s `SYSTEM_AUDIO_CONSTRAINTS`, answered by
      // `grantDisplayMediaRequest`'s primary branch: `{audio: "loopback"}` with
      // no video source, so the stream carries an audio track and nothing else
      // — no picker, no screen capture. Red-checked: with the registration
      // removed this is `rejected:NotSupportedError`.
      expect(await driveGetDisplayMedia({ audio: true, video: false })).toBe("resolved:audio");
    }
  );

  it.skipIf(skipPhysicalDisplayCapture)(
    "the FALLBACK {audio, video} shape is granted a real screen source too",
    async () => {
      // `SYSTEM_AUDIO_FALLBACK_CONSTRAINTS`, the retry `acquireSystemAudio`
      // makes on a build that refuses `video: false`. This is the branch that
      // really calls `desktopCapturer.getSources` in the real main process, and
      // `loopbackTap.ts` throws the video track away the moment it arrives.
      // Both tracks coming back is what proves the video branch is live code.
      expect(await driveGetDisplayMedia({ audio: true, video: true })).toBe("resolved:audio,video");
    }
  );

  it.skipIf(skipPhysicalDisplayCapture)(
    "the handler's own answer really governs the outcome — the video branch RAN",
    async () => {
      // The sharpest form of "this registration is genuinely consulted", and
      // the one that no amount of Chromium default behavior could fake: the
      // video-requested branch of `grantDisplayMediaRequest` writes
      // `display_media_video_fallback` to the host log through `obs.warn`
      // before it ever looks for a source. If that line appears in the real
      // log file after a real renderer's real request, OUR function ran inside
      // the real handler — not some fallback path of Electron's own.
      //
      // A DELTA, never "the file contains it": `obs.ts`'s log lives at a fixed
      // machine-wide path (`os.tmpdir()/arcelle-host.log`), so a line left by an
      // earlier run of this very file would otherwise pass this test with the
      // handler deleted. Counted across BOTH generations because `Sink`'s
      // constructor ROTATES on open (`arcelle-host.log` → `arcelle-host.prev.log`)
      // — nothing else in this suite calls `obs.init`, but a stray rotation must
      // not be able to turn a real pass into a spurious failure either.
      const before = countInHostLog("display_media_video_fallback");

      expect(await driveGetDisplayMedia({ audio: true, video: true })).toBe("resolved:audio,video");

      expect(countInHostLog("display_media_video_fallback")).toBeGreaterThan(before);
    }
  );

  // ==========================================================================
  // The quit door — LAST, because it drives a real app.quit() at a live app
  // ==========================================================================

  it("a malformed set_unsaved_edits is REFUSED over the real IPC boundary, and the process survives", async () => {
    // `registry.ts` refuses a non-boolean rather than coercing, because
    // reading a malformed payload as `false` would silently disarm the guard.
    // That refusal is a SYNCHRONOUS throw inside a real `ipcMain.handle`
    // callback — a shape no fake `ipcMain` can vouch for. Two things are
    // checked: the renderer sees a rejection, and the main process is still
    // serving the very same channel afterwards.
    const message = await window.evaluate(async () => {
      const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
      try {
        await api.invoke("set_unsaved_edits", { on: "yes" });
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    });
    expect(message).toContain("needs a boolean");

    const stillServing = await window.evaluate(async () => {
      const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
      await api.invoke("set_unsaved_edits", { on: false });
      return "ok";
    });
    expect(stillServing).toBe("ok");
    expect(
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    ).toBe(1);
  });

  it("the ⌘Q MENU ROW is held at the menu layer — the door's FIRST entrance, never reaching app.quit()", async () => {
    // The companion to the `app.quit()` test below, and a genuinely different
    // path: that one enters through `before-quit`, this one through
    // `menu.dispatch` → `menu.quit` → `quitDoor.holdForUnsaved`, which answers
    // the question WITHOUT calling `appExit` at all.
    //
    // Both entrances end with the same latch set and the same `quit-requested`
    // sent, so "the renderer was asked" alone cannot tell them apart. The
    // witness below can: `menu.quit` must not reach `app.quit()` when the door
    // holds, so `before-quit` must never fire. If the ⌘Q row were the
    // platform's predefined Quit — or if `dispatch` stopped routing it through
    // the door — this would still be asked, by the OTHER entrance, and the
    // witness is the only thing that would notice.
    await electronApp.evaluate(({ app }) => {
      const box = globalThis as unknown as { __sawBeforeQuit?: boolean };
      box.__sawBeforeQuit = false;
      app.on("before-quit", () => {
        box.__sawBeforeQuit = true;
      });
    });

    const received = window.evaluate(
      (eventName) =>
        new Promise<unknown>((resolve) => {
          const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
          api.on(eventName, (payload) => resolve(payload));
        }),
      QUIT_REQUESTED
    );

    await window.evaluate(async () => {
      const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
      await api.invoke("set_unsaved_edits", { on: true });
    });

    await electronApp.evaluate(({ Menu }, id: string) => {
      Menu.getApplicationMenu()?.getMenuItemById(id)?.click();
    }, QUIT_ID);

    expect(await received).toBeUndefined();
    expect(
      await electronApp.evaluate(
        () => (globalThis as unknown as { __sawBeforeQuit?: boolean }).__sawBeforeQuit
      ),
      "the ⌘Q row reached app.quit() — the menu-layer entrance did not hold it"
    ).toBe(false);
    expect(
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    ).toBe(1);

    // Put the door back: re-arm the latch and clear the flag, so the
    // `app.quit()` test below starts from the same state this one found.
    await window.evaluate(async () => {
      const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
      await api.invoke("quit_guard_rearm", {});
      await api.invoke("set_unsaved_edits", { on: false });
    });
  });

  it("a real app.quit() is genuinely HELD when the renderer reported unsaved edits, and asks the window", async () => {
    const received = window.evaluate(
      (eventName) =>
        new Promise<unknown>((resolve) => {
          const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
          api.on(eventName, (payload) => resolve(payload));
        }),
      QUIT_REQUESTED
    );

    await window.evaluate(async () => {
      const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
      await api.invoke("set_unsaved_edits", { on: true });
    });

    // A REAL quit of the REAL app — the Dock-Quit/logout path, which no menu
    // row is involved in. If the door failed to hold, this process dies here
    // and every assertion below fails loudly rather than quietly passing.
    await electronApp.evaluate(({ app }) => {
      app.quit();
    });

    // `quit-requested` really reached the renderer through the real preload.
    expect(await received).toBeUndefined();
    const stillAlive = await electronApp.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length
    );
    expect(stillAlive, "the real app.quit() was NOT held — the app quit for real").toBe(1);

    // Put the door back the way we found it, so `afterAll`'s own close is a
    // normal shutdown rather than a second held quit.
    await window.evaluate(async () => {
      const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
      await api.invoke("quit_guard_rearm", {});
      await api.invoke("set_unsaved_edits", { on: false });
    });
  });

  it("a real window.close() is HELD too — the entrance the renderer used to guard itself", async () => {
    // The third entrance, driven for real. Under Tauri this was the renderer's
    // own `onCloseRequested`; an isolated Electron renderer has no such hook,
    // so if this listener were missing the window would simply close here —
    // and `window-all-closed` would quit the process, failing every assertion
    // below loudly rather than quietly.
    const received = window.evaluate(
      (eventName) =>
        new Promise<unknown>((resolve) => {
          const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
          api.on(eventName, (payload) => resolve(payload));
        }),
      QUIT_REQUESTED
    );

    await window.evaluate(async () => {
      const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
      await api.invoke("set_unsaved_edits", { on: true });
    });

    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });

    expect(await received).toBeUndefined();
    expect(
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      "the real window.close() was NOT held — the window closed with edits unsaved"
    ).toBe(1);

    await window.evaluate(async () => {
      const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
      await api.invoke("quit_guard_rearm", {});
      await api.invoke("set_unsaved_edits", { on: false });
    });
  });

  it("quit_guard_rearm really RE-ARMS the door in a real process: Cancel means 'not this time', not 'never again'", async () => {
    // The answer a user actually gives most often, and the one entrance-level
    // test nothing above covers. Every other quit test in this file ends its
    // cleanup with `set_unsaved_edits({on: false})`, which clears BOTH flags on
    // its own — so `quit_guard_rearm` could be a no-op in the main process and
    // the whole file would still be green.
    //
    // Here it is the only thing that happens between two holds: the buffer
    // stays dirty throughout, so the second `app.quit()` can only be held if
    // the door was genuinely re-armed. If it were not, this process would EXIT
    // at that line and take the rest of the block with it — the failure is
    // impossible to mistake for a pass.
    const nextQuitRequest = (): Promise<unknown> =>
      window.evaluate(
        (eventName) =>
          new Promise<unknown>((resolve) => {
            const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
            api.on(eventName, (payload) => resolve(payload));
          }),
        QUIT_REQUESTED
      );

    const firstAsk = nextQuitRequest();
    await window.evaluate(async () => {
      const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
      await api.invoke("set_unsaved_edits", { on: true });
    });
    await electronApp.evaluate(({ app }) => {
      app.quit();
    });
    expect(await firstAsk).toBeUndefined();
    expect(
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      "the first quit was not held at all"
    ).toBe(1);

    // The user pressed Cancel. The ONLY thing that happens — the buffer is
    // still dirty and must stay armed.
    const secondAsk = nextQuitRequest();
    await window.evaluate(async () => {
      const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
      await api.invoke("quit_guard_rearm", {});
    });

    await electronApp.evaluate(({ app }) => {
      app.quit();
    });
    expect(
      await secondAsk,
      "the door did not ask a second time — quit_guard_rearm did not re-arm it"
    ).toBeUndefined();
    expect(
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      "the second quit went through — a cancelled quit disabled the guard for the rest of the session"
    ).toBe(1);

    await window.evaluate(async () => {
      const api = (window as unknown as { arcelle: RendererArcelle }).arcelle;
      await api.invoke("quit_guard_rearm", {});
      await api.invoke("set_unsaved_edits", { on: false });
    });
  });
});

// ============================================================================
// THE QUIT DOOR'S TERMINATING PATHS — each against its own real process
// ============================================================================
//
// These three cannot share the block above's instance: every one of them ENDS
// with a real process exit, which would take the rest of the file with it. Each
// launches its own, one at a time (see the module doc's single-instance-lock
// note — that is also why this block runs after the one above has closed its
// own).

describe("real Electron boot — the quit door, driven to a real exit", () => {
  /** Run `body` against a freshly launched app, always cleaning up. */
  async function withFreshApp(
    name: string,
    body: (app: ElectronApplication, proc: ReturnType<ElectronApplication["process"]>) => Promise<void>
  ): Promise<void> {
    const dir = mkdtempSync(path.join(os.tmpdir(), `arcelle-electron-${name}-`));
    const app = await launchArcelle(dir);
    // Captured ONCE, before anything can quit: after a real exit Playwright
    // tears down its own CDP connection, and a later `app.process()` was
    // observed to throw ("Cannot read properties of undefined") racing that
    // teardown. Node's `ChildProcess` has no such lifecycle — its `exitCode` is
    // safe to read at any point.
    const proc = app.process();
    await runWithCleanup(
      async () => {
        await waitForReadyMarker(app, 30_000);
        await body(app, proc);
      },
      async () => {
        try {
          await closeElectronApp(app, proc);
        } finally {
          // Never race profile deletion against a child that is still using it.
          if (proc.exitCode !== null) {
            rmSync(dir, { recursive: true, force: true });
          }
        }
      },
    );
  }

  it("the exit waiter clears its losing deadline when the child exits", async () => {
    let exitListener: (() => void) | undefined;
    const proc = {
      exitCode: null,
      once: (_event: string, listener: () => void) => {
        exitListener = listener;
      },
      removeListener: vi.fn(),
    } as unknown as ElectronChildProcess;
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      const exited = exitWithin(proc, 10_000, "fake child");
      exitListener?.();
      await exited;
      expect(clearTimeoutSpy).toHaveBeenCalled();
      expect(proc.removeListener).not.toHaveBeenCalled();
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  });

  it("a Playwright close failure still terminates the exact captured child and stays visible", async () => {
    const closeFailure = new Error("CDP close failed");
    const proc = {
      exitCode: null as number | null,
      kill: vi.fn(function (this: { exitCode: number | null }) {
        this.exitCode = 0;
        return true;
      }),
    } as unknown as ElectronChildProcess;
    const app = { close: vi.fn().mockRejectedValue(closeFailure) } as unknown as ElectronApplication;

    await expect(closeElectronApp(app, proc)).rejects.toBe(closeFailure);
    expect(proc.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(proc.exitCode).toBe(0);
  });

  it("a never-settling Playwright close is bounded before exact-child cleanup", async () => {
    vi.useFakeTimers();
    try {
      const proc = {
        exitCode: null as number | null,
        kill: vi.fn(function (this: { exitCode: number | null }) {
          this.exitCode = 0;
          return true;
        }),
      } as unknown as ElectronChildProcess;
      const app = {
        close: vi.fn(() => new Promise<void>(() => undefined)),
      } as unknown as ElectronApplication;

      const cleanup = closeElectronApp(app, proc, 100);
      const rejection = expect(cleanup).rejects.toThrow("Playwright app.close() did not settle within 100ms");
      await vi.advanceTimersByTimeAsync(100);
      await rejection;
      expect(proc.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
      expect(proc.exitCode).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts the expected CDP target closure after the child already exited", async () => {
    const proc = {
      exitCode: 0,
      kill: vi.fn(),
    } as unknown as ElectronChildProcess;
    const app = {
      close: vi.fn().mockRejectedValue(new Error("Target page, context or browser has been closed")),
    } as unknown as ElectronApplication;

    await expect(closeElectronApp(app, proc)).resolves.toBeUndefined();
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("preserves both the test-body failure and a cleanup failure", async () => {
    const bodyFailure = new Error("body failed");
    const cleanupFailure = new Error("cleanup failed");

    const failure = await runWithCleanup(
      async () => {
        throw bodyFailure;
      },
      async () => {
        throw cleanupFailure;
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([bodyFailure, cleanupFailure]);
  });

  it("escalates a timed-out SIGTERM to SIGKILL and preserves both teardown errors", async () => {
    vi.useFakeTimers();
    try {
      const closeFailure = new Error("CDP close failed");
      const child = new EventEmitter() as EventEmitter & {
        exitCode: number | null;
        kill: ReturnType<typeof vi.fn>;
      };
      child.exitCode = null;
      child.kill = vi.fn((signal: NodeJS.Signals) => {
        if (signal === "SIGKILL") {
          child.exitCode = 0;
          child.emit("exit", 0, signal);
        }
        return true;
      });
      const proc = child as unknown as ElectronChildProcess;
      const app = { close: vi.fn().mockRejectedValue(closeFailure) } as unknown as ElectronApplication;

      const cleanup = closeElectronApp(app, proc);
      const rejection = cleanup.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5_000);
      const failure = await rejection;

      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors[0]).toBe(closeFailure);
      expect(String((failure as AggregateError).errors[1])).toContain("test cleanup SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("nothing unsaved: a real app.quit() really TERMINATES the real process", async () => {
    // The other half of every "it was held" assertion in this file. Without
    // this, a door that held EVERYTHING — an app nobody could quit at all —
    // would pass the whole quit-guard suite.
    await withFreshApp("quit-clean", async (app, proc) => {
      const exited = exitWithin(proc, 10_000, "a clean quit");
      await app.evaluate(({ app: realApp }) => realApp.quit());
      await exited;
      expect(proc.exitCode).not.toBeNull();
    });
  }, 60_000);

  it("quit_guard_confirm finishes a HELD quit — the app really exits once the user says go", async () => {
    // The hole this channel closes, end to end in a real process: the Tauri
    // frontend answered "Quit and discard" with `plugin-process`'s `exit(0)`,
    // which an isolated Electron renderer cannot do. Before `quit_guard_confirm`
    // the user could confirm the discard and watch the app keep running.
    await withFreshApp("quit-confirm", async (app, proc) => {
      const win = await app.firstWindow();
      await win.evaluate(async () => {
        const api = (globalThis as unknown as { arcelle: RendererArcelle }).arcelle;
        await api.invoke("set_unsaved_edits", { on: true });
      });

      await app.evaluate(({ app: realApp }) => realApp.quit());
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(proc.exitCode, "the quit was not held").toBeNull();

      const exited = exitWithin(proc, 10_000, "quit_guard_confirm");
      // The renderer's own answer, over real IPC — and it must RESOLVE, not
      // reject: the handler defers the exit by a turn precisely so the reply
      // reaches the renderer before its window is torn down.
      try {
        const answered = await win.evaluate(async () => {
          const api = (globalThis as unknown as { arcelle: RendererArcelle }).arcelle;
          try {
            await api.invoke("quit_guard_confirm", {});
            return "resolved";
          } catch (e) {
            return e instanceof Error ? e.message : String(e);
          }
        });
        expect(answered).toBe("resolved");
      } catch (error) {
        // On a loaded hosted runner Chromium can close the CDP target before
        // Playwright receives the handler's reply. That is acceptable only
        // for this terminal command; `exited` below must still prove the real
        // process honored it.
        if (!isExpectedTargetClosure(error)) {
          throw error;
        }
      }
      await exited;
      expect(proc.exitCode).not.toBeNull();
    });
  }, 60_000);

  it("the RED BUTTON, held and then confirmed, really terminates the process too", async () => {
    // The `quit_guard_confirm` test above enters through `app.quit()`. This one
    // enters through the window's own `close` — the entrance the Tauri renderer
    // used to guard for itself and an isolated Electron renderer cannot — and
    // drives it all the way to a real exit, which is the half a "the window is
    // still open" assertion can never reach.
    //
    // It is also where `confirmQuit()` clearing BOTH flags is load-bearing: the
    // `app.quit()` it triggers passes `before-quit` AND this same `close`
    // listener on its way out, so a door that cleared only its latch would hold
    // the very exit the user just authorized and this process would never die.
    await withFreshApp("quit-redbutton", async (app, proc) => {
      const win = await app.firstWindow();
      const asked = win.evaluate(
        (eventName) =>
          new Promise<unknown>((resolve) => {
            const api = (globalThis as unknown as { arcelle: RendererArcelle }).arcelle;
            api.on(eventName, () => resolve("asked"));
          }),
        QUIT_REQUESTED
      );
      await win.evaluate(async () => {
        const api = (globalThis as unknown as { arcelle: RendererArcelle }).arcelle;
        await api.invoke("set_unsaved_edits", { on: true });
      });

      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.close();
      });
      expect(await asked).toBe("asked");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(proc.exitCode, "the red button was not held — the window closed on a dirty buffer").toBeNull();

      const exited = exitWithin(proc, 10_000, "quit_guard_confirm after a red-button hold");
      try {
        await win.evaluate(async () => {
          const api = (globalThis as unknown as { arcelle: RendererArcelle }).arcelle;
          await api.invoke("quit_guard_confirm", {});
        });
      } catch (error) {
        if (!isExpectedTargetClosure(error)) {
          throw error;
        }
      }
      await exited;
      expect(proc.exitCode).not.toBeNull();
    });
  }, 60_000);

  it("a second app.quit() after a hold goes through — the door fails OPEN in a real process", async () => {
    // The property that keeps a wedged renderer from trapping the user in the
    // app: the door holds at most once per armed buffer, whichever entrance
    // asked.
    await withFreshApp("quit-failopen", async (app, proc) => {
      const win = await app.firstWindow();
      await win.evaluate(async () => {
        const api = (globalThis as unknown as { arcelle: RendererArcelle }).arcelle;
        await api.invoke("set_unsaved_edits", { on: true });
      });

      await app.evaluate(({ app: realApp }) => realApp.quit());
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(proc.exitCode, "the first quit was not held").toBeNull();

      const exited = exitWithin(proc, 10_000, "the second quit");
      await app.evaluate(({ app: realApp }) => realApp.quit());
      await exited;
      expect(proc.exitCode).not.toBeNull();
    });
  }, 60_000);
});
