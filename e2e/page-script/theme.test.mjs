/* The theme preference: dark, light, or "follow the Mac".
 *
 * Runs under `npm run test:page` (node --test) against the REAL `src/theme.ts`,
 * type-stripped in memory the way address.test.mjs does it. theme.ts imports
 * nothing, so there is nothing to fake but the three browser globals it
 * touches.
 *
 * What these pin: the app follows macOS until the user says otherwise, ONE
 * press of the two-way switch must not pin it off macOS for good, and the live
 * system-follow listener has to stay reachable. The switch used to always
 * write an explicit dark/light and `setTheme("system")` had no caller
 * anywhere, so the first press was a one-way door.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, "../../src/theme.ts"), "utf8");
const JS = ts.transpileModule(SOURCE, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const theme = await import(`data:text/javascript,${encodeURIComponent(JS)}`);

/** A localStorage, a matchMedia and a document, just big enough for theme.ts.
 * Every call re-arms them, so each test starts with nothing stored. */
function browser(systemDark) {
  const store = new Map();
  const state = { dark: systemDark };
  const listeners = [];
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.window = {
    matchMedia: () => ({
      get matches() {
        return state.dark;
      },
      addEventListener: (_event, fn) => listeners.push(fn),
    }),
  };
  globalThis.document = {
    documentElement: { dataset: {}, style: {} },
    body: { style: {} },
  };
  return {
    store,
    /** The Mac's own setting changes, and macOS tells the page about it. */
    setSystem(dark) {
      state.dark = dark;
      for (const fn of listeners) fn();
    },
    applied: () => globalThis.document.documentElement.dataset.theme,
  };
}

test("with nothing stored the app follows the Mac", () => {
  const b = browser(false);
  assert.equal(theme.getThemeChoice(), "system");
  assert.equal(theme.getTheme(), "light");
  theme.initTheme();
  assert.equal(b.applied(), "light");
});

test("one press pins the opposite theme", () => {
  browser(true);
  assert.equal(theme.toggleTheme(), "light");
  assert.equal(theme.getThemeChoice(), "light");
});

test("pressing back lands on the Mac's own setting, so it follows again", () => {
  const b = browser(true); // macOS is dark
  assert.equal(theme.toggleTheme(), "light");
  assert.equal(theme.toggleTheme(), "dark");
  // The regression: this used to store an explicit "dark", which read the same
  // on screen but locked the app out of the system setting for good.
  assert.equal(theme.getThemeChoice(), "system");
  assert.equal(b.store.has("prTheme"), false);
});

test("...and the live system listener works again after that round trip", () => {
  const b = browser(true);
  theme.initTheme();
  theme.toggleTheme(); // explicit light
  theme.toggleTheme(); // back to following the Mac
  b.setSystem(false); // the Mac goes light at dusk
  assert.equal(b.applied(), "light");
});

test("an explicit choice still beats the Mac", () => {
  const b = browser(true); // macOS is dark
  theme.initTheme();
  assert.equal(b.applied(), "dark");
  theme.toggleTheme(); // explicit light, against a dark Mac
  assert.equal(b.applied(), "light");
  b.setSystem(true); // macOS says dark again
  assert.equal(b.applied(), "light");
  assert.equal(theme.getThemeChoice(), "light");
});
