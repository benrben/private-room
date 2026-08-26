/* The launch update check — and specifically what it REMEMBERS.
 *
 * Runs under `npm run test:page` (node --test) against the REAL
 * `src/updater.ts`, type-stripped in memory. Unlike theme.ts this module does
 * import the platform bridge, so that specifier is rewritten to a tiny stub
 * module that forwards to `globalThis.__platform` without running Electron.
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

const platformBody = ["checkForUpdate", "confirm", "installUpdate", "message"]
  .map((n) => `export const ${n} = (...a) => globalThis.__platform.${n}(...a);`)
  .join("\n");
JS = JS.replace(
  '"./platform"',
  JSON.stringify(`data:text/javascript,${encodeURIComponent(platformBody)}`),
);
const updater = await import(`data:text/javascript,${encodeURIComponent(JS)}`);

const SKIP_KEY = "prSkippedUpdate";

/** A localStorage and a set of Tauri stubs. `document` is deliberately absent:
 * the download banner builds itself inside a try/catch, which is exactly the
 * "no DOM to draw on" path. */
function harness({ version = "9.9.9", confirm, check } = {}) {
  const store = new Map();
  const log = { confirms: 0, installs: 0, messages: 0 };
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.__platform = {
    checkForUpdate:
      check ??
      (async () => ({
        version,
      })),
    installUpdate: async () => {
      log.installs++;
    },
    confirm: async (...args) => {
      log.confirms++;
      return confirm(...args);
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
  globalThis.__platform.checkForUpdate = async () => ({ version: "9.9.10" });
  await updater.checkForUpdatesQuietly();
  assert.equal(h.log.confirms, 2);
});

test("yes hands installation and relaunch to the Electron host", async () => {
  const h = harness({ confirm: async () => true });
  await updater.checkForUpdatesQuietly();
  assert.equal(h.log.installs, 1);
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

/* The preference existed from the day the check did; nothing WROTE it, so the
 * only way to stop the app contacting GitHub on every launch was to edit
 * localStorage by hand. A setting a user cannot reach is not a setting. */
test("the launch check can be switched off, and back on, from the app", async () => {
  const h = harness({ confirm: async () => true });
  assert.equal(updater.autoUpdateCheckEnabled(), true);

  assert.equal(updater.setAutoUpdateCheck(false), false);
  assert.equal(h.store.get("prUpdateCheck"), "0");
  await updater.checkForUpdatesQuietly();
  assert.equal(h.log.confirms, 0, "switched off, launch must contact nothing");

  assert.equal(updater.setAutoUpdateCheck(true), true);
  // Back to the default by REMOVING the key, not by writing "1": the reader
  // treats anything but "0" as on, and a stray value would read as on anyway.
  assert.equal(h.store.has("prUpdateCheck"), false);
  await updater.checkForUpdatesQuietly();
  assert.equal(h.log.confirms, 1);
});

/* It answers with what actually reads back. A private-mode write is lost, and
 * a checkbox told "off" while the next launch still reaches out would be the
 * app claiming a promise it does not keep. */
test("a preference that could not be stored is reported as unchanged", async () => {
  harness();
  const store = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota");
    },
    removeItem: () => {},
  };
  assert.equal(updater.setAutoUpdateCheck(false), true);
  globalThis.localStorage = store;
});

/* The switch has to be ON A SCREEN, wired to this setter. The finding was not
 * "the module lacks a function" — it was that no control anywhere reached it. */
test("Settings → Updates & version renders the switch and wires it up", () => {
  const about = readFileSync(
    join(here, "../../src/settings/AboutSection.tsx"),
    "utf8",
  );
  assert.match(about, /setAutoUpdateCheck/, "no control calls the setter");
  assert.match(about, /autoUpdateCheckEnabled\(\)/, "the box must show what is in force");
  assert.match(about, /type="checkbox"/, "the switch is not rendered");
});
