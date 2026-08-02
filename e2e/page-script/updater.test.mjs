/* The launch update check — and specifically what it REMEMBERS.
 *
 * Runs under `npm run test:page` (node --test) against the REAL
 * `src/updater.ts`, type-stripped in memory. Unlike theme.ts this module does
 * import the Tauri plugins, so each specifier is rewritten to a tiny stub
 * module that forwards to `globalThis.__tauri` — the test controls `check`,
 * `confirm`, `relaunch` and `message` without the app being built or running.
 *
 * What these pin: a skip is remembered ONLY for a real "no". `prSkippedUpdate`
 * is per exact version and nothing in the app clears it, so a dialog that
 * failed to open (this runs at launch, before any UI has settled) used to bury
 * that release permanently.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, "../../src/updater.ts"), "utf8");
let JS = ts.transpileModule(SOURCE, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;

// Each Tauri package becomes a data-URL module of forwarders, so the test can
// swap the backend per case without touching the source under test.
for (const [spec, names] of Object.entries({
  "@tauri-apps/plugin-updater": ["check"],
  "@tauri-apps/plugin-process": ["relaunch"],
  "@tauri-apps/plugin-dialog": ["confirm", "message"],
})) {
  const body = names
    .map((n) => `export const ${n} = (...a) => globalThis.__tauri.${n}(...a);`)
    .join("\n");
  JS = JS.replace(
    `"${spec}"`,
    JSON.stringify(`data:text/javascript,${encodeURIComponent(body)}`),
  );
}
const updater = await import(`data:text/javascript,${encodeURIComponent(JS)}`);

const SKIP_KEY = "prSkippedUpdate";

/** A localStorage and a set of Tauri stubs. `document` is deliberately absent:
 * the download banner builds itself inside a try/catch, which is exactly the
 * "no DOM to draw on" path. */
function harness({ version = "9.9.9", confirm, check } = {}) {
  const store = new Map();
  const log = { confirms: 0, installs: 0, relaunches: 0, messages: 0 };
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.__tauri = {
    check:
      check ??
      (async () => ({
        version,
        downloadAndInstall: async (on) => {
          log.installs++;
          on({ event: "Started", data: { contentLength: 10 } });
          on({ event: "Progress", data: { chunkLength: 10 } });
          on({ event: "Finished" });
        },
      })),
    confirm: async (...args) => {
      log.confirms++;
      return confirm(...args);
    },
    relaunch: async () => {
      log.relaunches++;
    },
    message: async () => {
      log.messages++;
    },
  };
  return { store, log };
}

// The module logs on every path; the assertions are the record here.
const quiet = { info: console.info, warn: console.warn, error: console.error };
test.before(() => {
  console.info = console.warn = console.error = () => {};
});
test.after(() => {
  Object.assign(console, quiet);
});

test("a dialog that fails to open is not a skip", async () => {
  const h = harness({
    confirm: () => {
      throw new Error("no dialog available");
    },
  });
  await updater.checkForUpdatesQuietly();
  // The regression: `.catch(() => false)` made a thrown dialog indistinguishable
  // from "Skip this version", and nothing in the app can clear that key.
  assert.equal(h.store.has(SKIP_KEY), false);

  // ...so the very next launch still offers the same version.
  const again = harness({ confirm: async () => false });
  await updater.checkForUpdatesQuietly();
  assert.equal(again.log.confirms, 1);
  assert.equal(again.store.get(SKIP_KEY), "9.9.9");
});

test("a real no is remembered, and only for that exact version", async () => {
  const h = harness({ confirm: async () => false });
  await updater.checkForUpdatesQuietly();
  assert.equal(h.store.get(SKIP_KEY), "9.9.9");

  // Same version again: asked once, never again.
  await updater.checkForUpdatesQuietly();
  assert.equal(h.log.confirms, 1);

  // The NEXT release still asks.
  globalThis.__tauri.check = async () => ({ version: "9.9.10" });
  await updater.checkForUpdatesQuietly();
  assert.equal(h.log.confirms, 2);
});

test("yes installs and relaunches", async () => {
  const h = harness({ confirm: async () => true });
  await updater.checkForUpdatesQuietly();
  assert.equal(h.log.installs, 1);
  assert.equal(h.log.relaunches, 1);
  assert.equal(h.store.has(SKIP_KEY), false);
});

test("no release, or an unreachable GitHub, remembers nothing and asks nothing", async () => {
  const none = harness({ check: async () => null, confirm: async () => false });
  await updater.checkForUpdatesQuietly();
  assert.equal(none.log.confirms, 0);
  assert.equal(none.store.has(SKIP_KEY), false);

  const offline = harness({
    check: async () => {
      throw new Error("offline");
    },
    confirm: async () => false,
  });
  await updater.checkForUpdatesQuietly();
  assert.equal(offline.log.confirms, 0);
  assert.equal(offline.store.has(SKIP_KEY), false);
});

test("the launch check honours prUpdateCheck=0", async () => {
  const h = harness({ confirm: async () => true });
  h.store.set("prUpdateCheck", "0");
  await updater.checkForUpdatesQuietly();
  assert.equal(h.log.confirms, 0);
  assert.equal(h.log.installs, 0);
});
