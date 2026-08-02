// WebdriverIO + tauri-driver config for Arcelle's HLT-8 smoke test.
//
// Lifecycle:
//   onPrepare      -> start the mock Ollama server and export
//                     ARCELLE_OLLAMA_URL so the app (spawned later by
//                     tauri-driver, inheriting this process's env) talks to it.
//   beforeSession  -> spawn `tauri-driver`, which in turn launches the built
//                     release binary and speaks WebDriver to it.
//   afterSession   -> kill tauri-driver.
//   onComplete     -> stop the mock server.
//
// NOTE ON PLATFORMS — READ BEFORE RELYING ON THIS SUITE. It does not currently
// run anywhere, and it is honest about that rather than green about it:
//
//   * macOS: `tauri-driver` has no macOS support (WKWebView exposes no
//     WebDriver), so the suite cannot drive the app on the platform Arcelle
//     ships for. `onPrepare` below refuses immediately instead of spending a
//     release build first and failing on a missing driver binary.
//   * Linux / Windows: `tauri-driver` works, but the release build this config
//     starts with does not — `whisper-rs` is pinned with Apple's `metal`
//     feature in src-tauri/Cargo.toml, outside any target gate, and the app is
//     macOS-only by design besides.
//
// It is kept, rather than deleted, because it is the ONLY thing that exercises
// the real Rust backend end to end, and because everything in it except the
// driver launch is portable: `mock-ollama.mjs` and `specs/smoke.e2e.mjs` are
// plain Node. Reviving it needs a WebDriver for WKWebView (not ours to write)
// or target-gated Cargo features plus a non-macOS build of the app.
//
// What DOES run on a Mac today: `npm run test:page`, `npm run e2e:qa`,
// `cargo test` and the sidecar's pytest — see e2e/README.md.

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import http from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// Shared Cargo target dir (matches the repo's warm build cache); fall back to
// the in-tree target if CARGO_TARGET_DIR is unset.
const targetDir =
  process.env.CARGO_TARGET_DIR || path.join(projectRoot, "src-tauri", "target");
const binName = process.platform === "win32" ? "arcelle.exe" : "arcelle";
const application = path.join(targetDir, "release", binName);

const MOCK_PORT = process.env.MOCK_OLLAMA_PORT || "11434";
let tauriDriver;
let mockServer;

export const config = {
  runner: "local",
  specs: [path.join(__dirname, "specs", "*.e2e.mjs")],
  maxInstances: 1,

  capabilities: [
    {
      // tauri-driver reads this and launches the app for us.
      "tauri:options": { application },
    },
  ],

  reporters: ["spec"],
  framework: "mocha",
  mochaOpts: { ui: "bdd", timeout: 120_000 },

  hostname: "127.0.0.1",
  port: 4444,
  logLevel: "warn",
  waitforTimeout: 20_000,

  // Build the release binary and start the mock before anything launches.
  onPrepare: () => {
    // Say so up front, and stop. Without this the run spends a full release
    // build and then dies inside a worker on `spawn tauri-driver ENOENT`,
    // which reads like a broken checkout rather than a driver that cannot
    // exist here. Exiting rather than throwing because wdio logs a failed
    // onPrepare and carries on into exactly that crash.
    if (process.platform === "darwin") {
      console.error(
        "\nnpm run e2e cannot run on macOS: tauri-driver has no WKWebView support,\n" +
          "so nothing can drive the packaged app here. Run `npm run e2e:qa` (the same\n" +
          "UI in Chrome) and `cargo test` (the Rust commands) instead — see\n" +
          "e2e/README.md for what covers what.\n",
      );
      process.exit(1);
    }
    const build = spawnSync("cargo", ["build", "--release"], {
      cwd: path.join(projectRoot, "src-tauri"),
      stdio: "inherit",
      env: process.env,
    });
    if (build.status !== 0) {
      throw new Error("cargo build --release failed; cannot run e2e");
    }

    // Point the app at the mock for every child process spawned after this.
    process.env.ARCELLE_OLLAMA_URL = `http://127.0.0.1:${MOCK_PORT}`;

    mockServer = spawn(
      process.execPath,
      [path.join(__dirname, "mock-ollama.mjs")],
      { stdio: "inherit", env: { ...process.env, MOCK_OLLAMA_PORT: MOCK_PORT } },
    );

    // Wait until the mock answers /api/tags before the app starts.
    return waitForMock(`http://127.0.0.1:${MOCK_PORT}/api/tags`);
  },

  beforeSession: () => {
    tauriDriver = spawn(
      path.resolve(os.homedir(), ".cargo", "bin", "tauri-driver"),
      [],
      { stdio: [null, process.stdout, process.stderr] },
    );
  },

  afterSession: () => {
    if (tauriDriver) tauriDriver.kill();
  },

  onComplete: () => {
    if (mockServer) mockServer.kill();
  },
};

function waitForMock(url, tries = 40) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (n <= 0) return reject(new Error("mock-ollama did not start"));
        setTimeout(() => attempt(n - 1), 250);
      });
    };
    attempt(tries);
  });
}
