/* Who keeps focus when the tab strip discovers a browser page.
 *
 * Runs under `npm run test:page` (node --test) against the REAL
 * `src/shell/tabsync.ts`, type-stripped in memory. The rule lives in its own
 * module precisely so it can be tested: the component around it needs the
 * whole Tauri backend before it will render a single tab.
 *
 * The race being pinned: ⌘T (and the ＋ button) creates the page in Rust and
 * only then turns the returned id into a tab. A poll whose response lands in
 * between sees a page with no tab — and the reconciliation used to treat any
 * such page as one the ASSISTANT opened and put focus back on the previous
 * tab, leaving the user's brand-new page sitting unfocused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, "../../src/shell/tabsync.ts"), "utf8");
const JS = ts.transpileModule(SOURCE, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { shouldRestoreFocus } = await import(
  `data:text/javascript,${encodeURIComponent(JS)}`
);

test("a page the assistant opened must not steal the reader's tab", () => {
  assert.equal(shouldRestoreFocus(["p1"], new Set(), true), true);
});

test("a page the USER opened keeps the focus it was given", () => {
  assert.equal(shouldRestoreFocus(["p1"], new Set(["p1"]), true), false);
});

test("one background page among the user's own still restores focus", () => {
  // The assistant opening a page while ⌘T is in flight is the case that must
  // not be lost: the strip may adopt both in the same pass.
  assert.equal(shouldRestoreFocus(["p1", "p2"], new Set(["p1"]), true), true);
});

test("nothing adopted, nothing to restore", () => {
  assert.equal(shouldRestoreFocus([], new Set(), true), false);
});

test("a tab that did not survive the pass is not restored", () => {
  // Pruned with the page it pointed at — reactivating it would show an empty
  // pane, so whatever `open` focused stays.
  assert.equal(shouldRestoreFocus(["p1"], new Set(), false), false);
});

/* AUDIT 238: Rust tells the strip which page is on screen, and the strip used
 * to throw that away. A page that closes on its own hands the screen to Rust's
 * heir rule while the strip carries on highlighting the tab the user chose —
 * and clicking that tab does nothing, because `browser_select_tab` only fires
 * on a real tab change and Rust already believes the other page is active. */
const { pageToReassert } = await import(
  `data:text/javascript,${encodeURIComponent(JS)}`
);

test("agreement needs no correction", () => {
  const live = [
    { id: "a", active: true },
    { id: "b", active: false },
  ];
  assert.equal(pageToReassert(live, "a"), "");
});

test("Rust showing another page is corrected back to the highlighted tab", () => {
  const live = [
    { id: "a", active: false },
    { id: "b", active: true },
  ];
  assert.equal(pageToReassert(live, "a"), "a");
});

test("a file or area tab is not a page, so nothing is asserted", () => {
  assert.equal(pageToReassert([{ id: "b", active: true }], null), "");
});

test("a page Rust no longer has is the pruner's business, not this one's", () => {
  // Asking Rust to show a page it has closed would just fail; the pruning pass
  // removes the tab in the same tick.
  assert.equal(pageToReassert([{ id: "b", active: true }], "gone"), "");
});

test("nothing open at all is not a disagreement", () => {
  assert.equal(pageToReassert([], "a"), "");
});
