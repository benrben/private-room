/* WHAT A CHAT TURN IS ANSWERED FROM.
 *
 * Every promise here fails silently when it breaks. A strip that says "the
 * whole room" over a page it never read still renders; a turn that drops the
 * page and answers from the room instead still produces an answer; a block that
 * carries eight thousand of forty thousand characters without saying so still
 * looks like the page. The user's only evidence would be an answer that is
 * subtly about the wrong thing.
 *
 * The real module is transpiled and imported (same harness as
 * contextualNav.test.mjs), so these are the shipped functions. Its only import
 * is a type, which the transpile erases.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(root, p), "utf8");

const load = async (source) => {
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(js)}`);
};

const scope = await load(read("src/workspace/browserScope.ts"));

/* What `BrowserView` publishes about the page it is showing. `readable` is its
 * answer, not ours: the same page is readable or not depending on whether the
 * native view is parked at 1×1 behind the results list, the start screen or the
 * reading view — none of which anything outside that component can see. */
const READABLE = {
  url: "https://example.test/article",
  title: "An article",
  readable: true,
  hasSelection: false,
};
/** The same page with a passage highlighted on it. Reported by the chrome's own
 *  1.2s poll, so it costs no round trip — and it is the ONLY thing that may
 *  cause a "selected passage" scope to be offered. */
const SELECTED = { ...READABLE, hasSelection: true };
/** The same page, one keypress later: "Read as text" is up, so the page is on
 * screen and its text cannot be extracted. */
const PARKED = { ...READABLE, readable: false };

const PAGE = scope.readablePage(READABLE);
const at = (over = {}) => ({
  area: "browser",
  page: PAGE,
  hasSelection: false,
  attachments: 0,
  ...over,
});

/* ---------- 1. the browser stops claiming the whole room ---------- */

test("the browser with a page open answers from the page", () => {
  const view = scope.chatScope(at(), null);
  assert.equal(view.scope, "page");
  assert.equal(view.label, "this page");
  assert.equal(view.placeholder, "Ask about this page…");
  assert.equal(view.sendsPageText, true);
});

test("a page whose text cannot be read is not a page this strip may offer", () => {
  // The start screen, the results list and the reading view all sit over a
  // webview parked at 1×1, and Rust refuses to extract from one. A page scope
  // offered there promises text the send would have to come back and refuse —
  // after a 1500ms stall, with the page's own words on the screen.
  assert.equal(scope.readablePage(PARKED), null);
  // No page at all, and no browser on screen, are the same answer.
  assert.equal(scope.readablePage(null), null);
  assert.deepEqual(scope.readablePage(READABLE), {
    url: "https://example.test/article",
    title: "An article",
    hasSelection: false,
  });
});

test("a highlighted passage adds a scope without stealing the default", () => {
  // The audit was explicit: a selection must ADD a scope, never silently
  // replace the page one — the question you were about to ask about the page
  // does not become a question about a sentence because you highlighted it.
  const sel = scope.readablePage(SELECTED);
  const view = scope.chatScope(at({ page: sel, hasSelection: true }), null);
  assert.ok(view.available.includes("selection"));
  assert.equal(view.scope, "page");
});

test("the selected-passage scope is not offered when nothing is selected", () => {
  const view = scope.chatScope(at(), null);
  assert.ok(!view.available.includes("selection"));
});

test("a passage on a page that cannot be read is not offered either", () => {
  // A selection you cannot extract is the same as no selection: the publisher
  // clears the flag whenever the native view is parked, so this can only be
  // reached by reconstructing readability somewhere else — which is the whole
  // mistake this module stopped making.
  assert.equal(scope.readablePage({ ...SELECTED, readable: false }), null);
});

test("an unreadable page leaves the strip saying the room, not the page", () => {
  // Including with "this page" already picked: the pick is dropped the moment
  // the moment stops offering it, exactly as walking out of the browser does.
  const view = scope.chatScope(at({ page: scope.readablePage(PARKED) }), "page");
  assert.deepEqual(view.available, ["room"]);
  assert.equal(view.scope, "room");
  assert.equal(view.label, "the whole room", "the strip may not name a page it will not send");
  assert.equal(view.placeholder, "Ask anything about this room…");
  assert.equal(view.sendsPageText, false);
});

test("an unreadable page does not hide the sources the turn will really use", () => {
  const view = scope.chatScope(
    at({ page: scope.readablePage(PARKED), attachments: 2 }),
    "page",
  );
  assert.equal(view.label, "2 attached sources");
});

/* ---------- 2. a selection adds, it never takes over ---------- */

test("a selection adds a scope without stealing the default", () => {
  const view = scope.chatScope(at({ hasSelection: true }), null);
  assert.deepEqual(view.available, ["page", "selection", "room"]);
  assert.equal(view.scope, "page", "highlighting a sentence is not a decision to ignore the page");
  // …and it is reachable, second in the list.
  const picked = scope.chatScope(at({ hasSelection: true }), "selection");
  assert.equal(picked.scope, "selection");
  assert.equal(picked.label, "the selected passage");
});

/* ---------- 3. everywhere else is exactly what it was ---------- */

test("leaving the browser restores the behaviour that predates the scope", () => {
  // Including with the page scope still picked: a choice the moment no longer
  // offers must be dropped, not carried somewhere it means nothing.
  for (const area of ["home", "files", "sketch", "recordings"]) {
    const view = scope.chatScope(at({ area }), "page");
    assert.deepEqual(view.available, ["room"]);
    assert.equal(view.scope, "room");
    assert.equal(view.label, "the whole room");
    assert.equal(view.placeholder, "Ask anything about this room…");
    assert.equal(view.sendsPageText, false);
  }
  // The browser with nothing open is the same case.
  const empty = scope.chatScope(at({ page: null }), "page");
  assert.equal(empty.scope, "room");
  assert.equal(empty.sendsPageText, false);
});

/* ---------- 4. the paperclip still outranks the room ---------- */

test("attached sources still win over the whole room", () => {
  assert.equal(scope.chatScope(at({ area: "home", attachments: 1 }), null).label, "1 attached source");
  assert.equal(scope.chatScope(at({ area: "home", attachments: 3 }), null).label, "3 attached sources");
  // The placeholder was never about attachments and must not start being so.
  assert.equal(
    scope.chatScope(at({ area: "home", attachments: 3 }), null).placeholder,
    "Ask anything about this room…",
  );
});

/* ---------- 5. a fragment is never presented as the page ---------- */

test("a page cut to fit says how much of it is missing", () => {
  const page = scope.pageContext({
    title: "An article",
    url: "https://example.test/article",
    text: "x".repeat(40_000),
    total: 40_000,
  });
  assert.equal(page.text.length, scope.MAX_PAGE_CHARS);
  assert.equal(page.omitted, 40_000 - scope.MAX_PAGE_CHARS);
  const block = scope.withPageContext("What does it argue?", page);
  assert.match(block, /Only the first .* characters are below/);
  assert.ok(
    block.includes((40_000 - scope.MAX_PAGE_CHARS).toLocaleString()),
    "the count of what was left out has to be in the block itself",
  );
});

test("a page that fits claims no shortfall", () => {
  const page = scope.pageContext({
    title: "Short",
    url: "https://example.test/s",
    text: "All of it.",
    total: 10,
  });
  assert.equal(page.omitted, 0);
  const block = scope.withPageContext("Why?", page);
  assert.doesNotMatch(block, /Only the first/);
  assert.ok(block.includes("All of it."));
  assert.ok(block.includes("Short — https://example.test/s"), "the text is attributed");
  assert.ok(block.endsWith("Why?"), "the question stays the last thing said");
});

test("a page with no words is refused rather than sent as an empty page", () => {
  // A PDF, a canvas, a video. Null makes the caller report it; an empty block
  // would ask the model to answer about a page it was handed nothing of.
  assert.equal(scope.pageContext({ text: "   ", total: 0 }), null);
  assert.equal(scope.pageContext({}), null);
});
