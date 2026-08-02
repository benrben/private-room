// WebdriverIO config for the SCREENSHOT CAPTURE run (e2e/capture-specs/*.mjs).
//
// Same vehicle as wdio.qa.conf.mjs — the real React app in Chrome against
// dist/qa.html, with qa/qa-mock.js standing in for Rust — but the job is
// different: instead of asserting, it walks every screen, state, theme and
// viewport and writes PNGs for the vision dataset.
//
// It is a separate config rather than another spec in the QA suite because a
// capture run takes minutes, resizes the window constantly and must not fail
// the regression suite when a screen is mid-redesign.
//
//   npm run capture              # build, generate qa.html, serve, capture
//   SKIP_BUILD=1 npm run capture # reuse dist/ while iterating
//   HEADED=1 npm run capture     # watch it drive

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import http from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const PORT = process.env.QA_PREVIEW_PORT || "4174";
export const BASE_URL = `http://127.0.0.1:${PORT}/qa.html`;

let preview;

export const config = {
  runner: "local",
  specs: [path.join(__dirname, "capture-specs", "*.mjs")],
  maxInstances: 1,

  capabilities: [
    {
      browserName: "chrome",
      "goog:chromeOptions": {
        args: [
          ...(process.env.HEADED ? [] : ["--headless=new"]),
          "--window-size=1440,900",
          "--disable-gpu",
          "--use-fake-ui-for-media-stream",
          // Deterministic pixels: the default scrollbar differs between a
          // headless run and a headed one, which would put a stripe of noise
          // down the right edge of half the dataset.
          "--hide-scrollbars",
          "--force-device-scale-factor=1",
        ],
      },
    },
  ],

  reporters: ["spec"],
  framework: "mocha",
  // A full matrix is hundreds of navigations; the QA suite's 60s would trip.
  mochaOpts: { ui: "bdd", timeout: 45 * 60_000 },
  logLevel: "warn",
  waitforTimeout: 10_000,
  baseUrl: BASE_URL,

  onPrepare: async () => {
    if (!process.env.SKIP_BUILD) {
      run("npm", ["run", "build"], "vite build");
      run(process.execPath, [path.join(projectRoot, "qa", "make-qa.mjs")], "make-qa");
    }
    // See wdio.qa.conf.mjs: without an explicit `--host 127.0.0.1`, vite binds
    // ::1 only on macOS and everything below is refused.
    preview = spawn(
      path.join(projectRoot, "node_modules", ".bin", "vite"),
      ["preview", "--host", "127.0.0.1", "--port", PORT, "--strictPort"],
      { cwd: projectRoot, stdio: "inherit" },
    );
    try {
      await waitFor(BASE_URL);
    } catch (err) {
      preview.kill();
      throw err;
    }
  },

  onComplete: () => {
    if (preview) preview.kill();
  },
};

function run(cmd, args, label) {
  const r = spawnSync(cmd, args, { cwd: projectRoot, stdio: "inherit", env: process.env });
  if (r.status !== 0) throw new Error(`${label} failed; cannot run the capture`);
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
