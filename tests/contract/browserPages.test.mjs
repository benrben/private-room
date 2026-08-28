/* THE PRIVATE BROWSER'S PAGE LIST, reconciled against what Rust has open.
 *
 * `reconcilePages` is pure, so it is sliced out of the shipped source and run
 * for real — the same trick as adaptiveText.test.mjs, because the module's
 * other half imports "react" and "../api", bare specifiers a data: URL module
 * cannot resolve.
 *
 * The fact under test: a poll that finds only a TITLE or URL change must reach
 * the screen. The hook decides "did anything change?" by identity
 * (`next !== pagesRef.current`), so a reconciliation that hands back the
 * previous array is a reconciliation the user never sees — every row keeps the
 * address and title it had when the page was opened.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE = readFileSync(join(root, "apps/desktop/src/renderer/workspace/browserPages.ts"), "utf8");

const start = SOURCE.indexOf("export function reconcilePages");
const end = SOURCE.indexOf("/** Which page the selection should land on");
assert.ok(
  start > 0 && end > start,
  "expected reconcilePages() before selectionAfterSync's doc comment — did the file get reshuffled?",
);
const js = ts.transpileModule(SOURCE.slice(start, end), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { reconcilePages } = await import(`data:text/javascript,${encodeURIComponent(js)}`);

/** A page as Rust reports it. `active` is Rust's own idea of what is on
 * screen; the reconciliation ignores it (see `pageToReassert`). */
const live = (id, title, url, active = false) => ({ id, title, url, active });

test("a navigation with no page opened or closed still updates title and url", () => {
  const prev = [{ id: "p1", title: "New page", url: "" }];
  const next = reconcilePages(prev, [
    live("p1", "Example Domain", "https://example.com/", true),
  ]);
  assert.deepEqual(next, [
    { id: "p1", title: "Example Domain", url: "https://example.com/" },
  ]);
  assert.notEqual(next, prev, "a changed list must be a NEW array or the hook bails out of the render");
});

test("a title change on one of several pages updates only that row", () => {
  const prev = [
    { id: "p1", title: "Search", url: "https://example.com/search" },
    { id: "p2", title: "Loading…", url: "https://news.test/a" },
  ];
  const next = reconcilePages(prev, [
    live("p1", "Search", "https://example.com/search"),
    live("p2", "The headline", "https://news.test/a"),
  ]);
  assert.equal(next[0], prev[0], "an untouched page keeps its identity");
  assert.deepEqual(next[1], { id: "p2", title: "The headline", url: "https://news.test/a" });
});

test("nothing changed at all returns the same array (no pointless re-render)", () => {
  const prev = [{ id: "p1", title: "Example Domain", url: "https://example.com/" }];
  assert.equal(
    reconcilePages(prev, [live("p1", "Example Domain", "https://example.com/")]),
    prev,
  );
});

test("an empty list on both sides returns the same array", () => {
  const prev = [];
  assert.equal(reconcilePages(prev, []), prev);
});

test("a page that went away loses its row, and a new one is appended in Rust's order", () => {
  const prev = [
    { id: "p1", title: "One", url: "https://one.test/" },
    { id: "p2", title: "Two", url: "https://two.test/" },
  ];
  const next = reconcilePages(prev, [
    live("p2", "Two", "https://two.test/"),
    live("p3", "Three", "https://three.test/"),
  ]);
  assert.deepEqual(next.map((p) => p.id), ["p2", "p3"]);
});

test("one page closed and one opened in the same poll keeps known order", () => {
  const prev = [
    { id: "p1", title: "One", url: "https://one.test/" },
    { id: "p2", title: "Two", url: "https://two.test/" },
  ];
  const next = reconcilePages(prev, [
    live("p3", "Three", "https://three.test/"),
    live("p1", "One renamed", "https://one.test/"),
  ]);
  assert.deepEqual(next, [
    { id: "p1", title: "One renamed", url: "https://one.test/" },
    { id: "p3", title: "Three", url: "https://three.test/" },
  ]);
});
