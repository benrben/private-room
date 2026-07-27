// WebdriverIO config for the REGRESSION suite (e2e/qa-specs/*.e2e.mjs).
//
// Why this exists next to wdio.conf.mjs: that suite drives the packaged Tauri
// binary through `tauri-driver`, which has no macOS support (WKWebView has no
// WebDriver) — so on the machine this app is developed on, it cannot run at
// all. This config drives the SAME React app in Chrome instead, against
// dist/qa.html, where qa/qa-mock.js stands in for the Rust backend.
//
//   npm run build  ──▶ dist/index.html
//   qa/make-qa.mjs ──▶ dist/qa.html  (= index.html + the IPC mock, injected first)
//   vite preview   ──▶ http://127.0.0.1:4173/qa.html
//
// What that buys and what it doesn't: the real components, real state, real
// event wiring, real CSS and real layout maths are all under test, so UI
// regressions are caught on every platform. The Rust commands are not — those
// are covered by `cargo test` (and, on Linux/Windows CI, by wdio.conf.mjs).
// Where a fix spans both, the Rust half has its own unit test; see
// recording::tests::speaker_names_* for GH #5.

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import http from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const PORT = process.env.QA_PREVIEW_PORT || "4173";
export const BASE_URL = `http://127.0.0.1:${PORT}/qa.html`;

let preview;

export const config = {
  runner: "local",
  specs: [path.join(__dirname, "qa-specs", "*.e2e.mjs")],
  maxInstances: 1,

  capabilities: [
    {
      browserName: "chrome",
      "goog:chromeOptions": {
        args: [
          // Headless by default; HEADED=1 to watch it drive.
          ...(process.env.HEADED ? [] : ["--headless=new"]),
          "--window-size=1440,900",
          "--disable-gpu",
          // The mock synthesizes its own microphone, but Chrome still gates
          // getUserMedia behind a permission prompt that nothing can click.
          "--use-fake-ui-for-media-stream",
        ],
      },
    },
  ],

  reporters: ["spec"],
  framework: "mocha",
  mochaOpts: { ui: "bdd", timeout: 60_000 },
  logLevel: "warn",
  waitforTimeout: 10_000,
  baseUrl: BASE_URL,

  // Build the app, generate qa.html, serve it. SKIP_BUILD=1 reuses dist/ when
  // iterating on the specs themselves.
  onPrepare: async () => {
    if (!process.env.SKIP_BUILD) {
      run("npm", ["run", "build"], "vite build");
      run(process.execPath, [path.join(projectRoot, "qa", "make-qa.mjs")], "make-qa");
    }
    preview = spawn(
      path.join(projectRoot, "node_modules", ".bin", "vite"),
      ["preview", "--port", PORT, "--strictPort"],
      { cwd: projectRoot, stdio: "inherit" },
    );
    await waitFor(BASE_URL);
  },

  onComplete: () => {
    if (preview) preview.kill();
  },
};

function run(cmd, args, label) {
  const r = spawnSync(cmd, args, { cwd: projectRoot, stdio: "inherit", env: process.env });
  if (r.status !== 0) throw new Error(`${label} failed; cannot run the QA e2e suite`);
}

function waitFor(url, tries = 60) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        if (n <= 0) return reject(new Error(`${url} answered ${res.statusCode}`));
        setTimeout(() => attempt(n - 1), 250);
      });
      req.on("error", () => {
        if (n <= 0) return reject(new Error(`vite preview never came up on ${url}`));
        setTimeout(() => attempt(n - 1), 250);
      });
    };
    attempt(tries);
  });
}
