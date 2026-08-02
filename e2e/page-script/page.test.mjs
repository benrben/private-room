/* Tests for the browser's injected page script
 * (`src-tauri/src/browser/page.js`), run against the hand-rolled DOM in
 * `dom-stub.mjs`:
 *
 *     node --test e2e/page-script/
 *
 * What is covered here is what would otherwise only fail in a real WKWebView,
 * where a mistake looks like "the page isn't ready" rather than a stack trace:
 * mark ordering and the cap, the password fence, ref staleness, label
 * resolution, markdown extraction, what Save page and Save selection hand
 * back, low-signal detection, and the totality contract with the Rust bridge
 * (never throw, always return a value).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { El, install, currentDocument, setSelection } from "./dom-stub.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, "../../src-tauri/src/browser/page.js"), "utf8");

function fresh() {
  const api = install(SOURCE);
  return { api, doc: currentDocument() };
}

/** Start an async page op and poll its ticket to completion.
 *
 * Async ops are NOT quick: `act` awaits the settle detector after every
 * action, and settle deliberately waits for a 500ms network-quiet and 350ms
 * DOM-quiet window before declaring the page still. That is the whole point of
 * it — it is what stops the model from spending turns on "let me wait for the
 * page to load" — so tests must drain the ticket properly rather than sleep a
 * fixed, optimistic interval.
 */
async function drain(api, op, args, budgetMs = 10000) {
  const started = api.call("begin", { op, args });
  assert.equal(started.ok, true, "begin should hand back a ticket");
  const deadline = Date.now() + budgetMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, 25));
    const taken = api.call("take", { ticket: started.ticket });
    if (taken.done) return taken.value;
    assert.ok(Date.now() < deadline, `ticket for ${op} never completed`);
  }
}

/** Lay elements out top-to-bottom so viewport-order assertions are meaningful. */
function stack(parent, elements) {
  let top = 0;
  for (const el of elements) {
    el.rect = { ...el.rect, top, left: 0 };
    top += 30;
    parent.appendChild(el);
  }
  return elements;
}

test("snapshot numbers visible interactive elements in document order", () => {
  const { api, doc } = fresh();
  stack(doc.body, [
    new El("a", { href: "/home", __text: "Home" }),
    new El("button", { __text: "Save" }),
    new El("input", { type: "text", placeholder: "Email" }),
  ]);

  const snap = api.call("snapshot", {});
  assert.equal(snap.ok, true);
  assert.equal(snap.count, 3);
  assert.deepEqual(
    snap.elements.map((e) => [e.ref, e.role, e.label]),
    [
      ["e1", "link", "Home"],
      ["e2", "button", "Save"],
      ["e3", "textbox", "Email"],
    ],
  );
});

test("password fields are fenced: never given a ref, but always reported", () => {
  const { api, doc } = fresh();
  stack(doc.body, [
    new El("input", { type: "text", name: "user" }),
    new El("input", { type: "password", name: "pass" }),
    new El("button", { __text: "Sign in" }),
  ]);

  const snap = api.call("snapshot", {});
  // Two actionable controls; the password is not one of them...
  assert.equal(snap.count, 2);
  assert.equal(snap.elements.some((e) => e.role === "password"), false);
  // ...but hiding it entirely would read as a broken page, so it is counted.
  assert.equal(snap.secrets, 1);
  assert.match(snap.summary, /password field/i);
});

test("autocomplete-hinted secret fields are fenced even without type=password", () => {
  const { api, doc } = fresh();
  stack(doc.body, [
    new El("input", { type: "text", autocomplete: "current-password" }),
    new El("input", { type: "text", name: "one-time-code" }),
    new El("input", { type: "text", name: "username" }),
  ]);
  const snap = api.call("snapshot", {});
  assert.equal(snap.count, 1, "only the username field is actionable");
  assert.equal(snap.secrets, 2);
});

test("invisible and disabled controls are never marked", () => {
  const { api, doc } = fresh();
  const hidden = new El("button", { __text: "Hidden" });
  hidden.__style = { display: "none", visibility: "visible", opacity: "1" };
  const zero = new El("button", { __text: "Zero" });
  zero.rect = { top: 0, left: 0, width: 0, height: 0 };
  stack(doc.body, [
    new El("button", { __text: "Real" }),
    hidden,
    zero,
    new El("button", { __text: "Off", disabled: "true" }),
    new El("button", { __text: "Aria off", "aria-disabled": "true" }),
  ]);

  const snap = api.call("snapshot", {});
  assert.equal(snap.count, 1);
  assert.equal(snap.elements[0].label, "Real");
});

test("the mark cap keeps viewport-top elements and reports the overflow honestly", () => {
  const { api, doc } = fresh();
  const many = [];
  for (let i = 0; i < 100; i++) many.push(new El("button", { __text: `B${i}` }));
  stack(doc.body, many);

  const snap = api.call("snapshot", {});
  assert.equal(snap.count, 80, "capped at MARK_CAP");
  assert.equal(snap.overflow, 20);
  assert.match(snap.summary, /and 20 more \(scroll to reveal\)/);
  // The kept 80 are the ones nearest the top, still in document order.
  assert.equal(snap.elements[0].label, "B0");
  assert.equal(snap.elements[79].label, "B79");
});

test("labels fall back through aria-label, text, <label for>, placeholder, title", () => {
  const { api, doc } = fresh();
  const labelled = new El("input", { type: "text", id: "email" });
  const form = new El("form", {}, [
    new El("label", { for: "email", __text: "Email address" }),
    labelled,
  ]);
  form.rect = { top: 0, left: 0, width: 300, height: 100 };
  doc.body.appendChild(form);
  stack(doc.body, [
    new El("button", { "aria-label": "Close dialog", __text: "x" }),
    new El("button", { title: "Only a title" }),
    new El("button", {}),
  ]);

  const snap = api.call("snapshot", {});
  const byLabel = Object.fromEntries(snap.elements.map((e) => [e.label, e.role]));
  assert.ok("Close dialog" in byLabel, "aria-label wins over text");
  assert.ok("Email address" in byLabel, "<label for> resolves");
  assert.ok("Only a title" in byLabel);
  assert.ok("(unlabeled)" in byLabel, "an unlabelable control says so");
});

test("regions distinguish nav/form/main from plain body", () => {
  const { api, doc } = fresh();
  const nav = new El("nav", {}, [new El("a", { href: "/", __text: "Home" })]);
  const main = new El("main", {}, [new El("button", { __text: "Go" })]);
  for (const parent of [nav, main]) {
    parent.rect = { top: 0, left: 0, width: 300, height: 50 };
    doc.body.appendChild(parent);
  }
  const snap = api.call("snapshot", {});
  const regions = Object.fromEntries(snap.elements.map((e) => [e.label, e.region]));
  assert.equal(regions.Home, "nav");
  assert.equal(regions.Go, "main");
});

test("a stale ref refuses to act instead of hitting a re-laid-out element", async () => {
  const { api, doc } = fresh();
  const [first] = stack(doc.body, [new El("button", { __text: "One" })]);
  api.call("snapshot", {});

  // The page re-renders: the old element is gone.
  doc.body.removeChild(first);
  first.isConnected = false;

  const value = await drain(api, "act", { actions: [{ click: "e1" }] });
  assert.equal(value.ok, false);
  assert.match(value.results[0].error, /is gone — act on the fresh snapshot/);
  assert.equal(first.clicked, 0, "the detached element must never be clicked");
});

test("a ref whose number was reassigned by a newer snapshot is rejected", () => {
  const { api, doc } = fresh();
  const buttons = stack(doc.body, [
    new El("button", { __text: "First" }),
    new El("button", { __text: "Second" }),
  ]);
  api.call("snapshot", {});
  assert.equal(buttons[0].getAttribute("data-arcelle-mark"), "1");

  // The first button disappears; a fresh snapshot renumbers the second to e1.
  doc.body.removeChild(buttons[0]);
  buttons[0].isConnected = false;
  const snap2 = api.call("snapshot", {});
  assert.equal(snap2.elements[0].label, "Second");
  assert.equal(buttons[1].getAttribute("data-arcelle-mark"), "1");
  // The detached element keeps its old attribute (a real DOM does too — it is
  // no longer reachable from the document to be cleared). What must hold is
  // that it can never be ACTED on again: e1 now resolves to the survivor, and
  // the removed node is in no registry at all.
  const resolved = api._internals.resolve("e1");
  assert.equal(resolved.error, undefined);
  assert.equal(resolved.el, buttons[1]);
  assert.equal(api._internals.registry.size, 1);
});

test("clicking a live ref reaches the element", async () => {
  const { api, doc } = fresh();
  const [btn] = stack(doc.body, [new El("button", { __text: "Go" })]);
  api.call("snapshot", {});

  const value = await drain(api, "act", { actions: [{ click: "e1" }] });
  assert.equal(btn.clicked, 1);
  assert.match(value.results[0].did, /clicked e1/);
});

test("typing goes through the prototype value setter and fires input/change", async () => {
  const { api, doc } = fresh();
  const [input] = stack(doc.body, [new El("input", { type: "text", value: "old" })]);
  api.call("snapshot", {});

  const value = await drain(api, "act", {
    actions: [{ type: { ref: "e1", text: "new text", clear: true } }],
  });
  assert.equal(value.ok, true);
  assert.equal(input.value, "new text");
  assert.ok(input.events.includes("input"), "React-style listeners must see input");
  assert.ok(input.events.includes("change"));
});

test("select matches an option by value or by visible text", async () => {
  const { api, doc } = fresh();
  const sel = new El("select", {}, [
    new El("option", { value: "us", __text: "United States" }),
    new El("option", { value: "il", __text: "Israel" }),
  ]);
  stack(doc.body, [sel]);
  api.call("snapshot", {});

  const value = await drain(api, "act", { actions: [{ select: { ref: "e1", value: "Israel" } }] });
  assert.equal(value.results[0].ok, true);
  assert.equal(sel.selectedIndex, 1);
});

test("a failed select lists the options that do exist", async () => {
  const { api, doc } = fresh();
  const sel = new El("select", {}, [new El("option", { value: "us", __text: "United States" })]);
  stack(doc.body, [sel]);
  api.call("snapshot", {});
  const value = await drain(api, "act", { actions: [{ select: { ref: "e1", value: "Narnia" } }] });
  assert.equal(value.results[0].ok, false);
  assert.match(value.results[0].error, /Available: United States/);
});

test("a batch stops at the first failure rather than applying later actions", async () => {
  const { api, doc } = fresh();
  const [btn] = stack(doc.body, [new El("button", { __text: "Go" })]);
  api.call("snapshot", {});

  const value = await drain(api, "act", { actions: [{ click: "e99" }, { click: "e1" }] });
  assert.equal(value.ok, false);
  assert.equal(value.stoppedAt, 0);
  assert.equal(btn.clicked, 0, "the second action must not run after the first failed");
});

test("typing into a fenced password field is refused even by an invented ref", async () => {
  const { api, doc } = fresh();
  stack(doc.body, [
    new El("input", { type: "text", name: "user" }),
    new El("input", { type: "password", name: "pass" }),
  ]);
  api.call("snapshot", {});
  // e1 is the username. The password never got a ref at all, so the only way
  // to reach it would be a ref collision — which resolve() must also refuse.
  const value = await drain(api, "act", { actions: [{ type: { ref: "e2", text: "hunter2" } }] });
  assert.equal(value.ok, false);
});

test("read extracts headings, paragraphs, lists and absolute links as markdown", () => {
  const { api, doc } = fresh();
  const article = new El("article", {}, [
    new El("h1", { __text: "The Title" }),
    new El("p", { __text: "First paragraph with detail." }),
    new El("p", { __text: "Second paragraph." }),
    new El("p", { __text: "Third paragraph so the root heuristic picks this block." }),
    new El("ul", {}, [new El("li", { __text: "one" }), new El("li", { __text: "two" })]),
    new El("a", { href: "/next", __text: "Next page" }),
  ]);
  article.rect = { top: 0, left: 0, width: 600, height: 400 };
  doc.body.appendChild(article);

  const out = api.call("read", {});
  assert.equal(out.ok, true);
  assert.match(out.text, /# The Title/);
  assert.match(out.text, /First paragraph with detail\./);
  assert.match(out.text, /- one/);
  assert.match(out.text, /\[Next page\]\(https:\/\/example\.com\/next\)/, "relative hrefs resolve");
});

test("read paginates with offset and says so", () => {
  const { api, doc } = fresh();
  const article = new El("article", {}, [
    new El("p", { __text: "x".repeat(60000) }),
    new El("p", { __text: "second" }),
    new El("p", { __text: "third" }),
  ]);
  article.rect = { top: 0, left: 0, width: 600, height: 400 };
  doc.body.appendChild(article);

  const first = api.call("read", {});
  assert.equal(first.truncated, true);
  assert.equal(first.offset, 0);
  const second = api.call("read", { offset: first.text.length });
  assert.equal(second.offset, first.text.length);
  assert.notEqual(second.text, first.text);
});

/** The page script's own slice size, read from the source so the fixtures below
 *  can put an emoji exactly on the boundary without going stale. */
const READ_MAX = Number(/var READ_MAX = (\d+)/.exec(SOURCE)[1]);

test("successive reads tile the document exactly and never cut an emoji in half", () => {
  // The boundary is placed ON the high half of a surrogate pair: half an emoji
  // decodes to a replacement character, and the Rust side used to work the
  // continuation out by counting CHARACTERS in the returned text — a different
  // count from JavaScript's UTF-16 code units the moment an emoji is involved,
  // so the next chunk repeated text already read.
  const { api, doc } = fresh();
  const body = "a".repeat(READ_MAX - 1) + "😀" + "b".repeat(5000);
  const article = new El("article", {}, [new El("p", { __text: body })]);
  article.rect = { top: 0, left: 0, width: 600, height: 400 };
  doc.body.appendChild(article);

  let offset = 0;
  let joined = "";
  let total = null;
  for (let guard = 0; guard < 20; guard++) {
    const chunk = api.call("read", { offset });
    assert.equal(chunk.ok, true);
    assert.equal(chunk.offset, offset, "read must resume exactly where it was told to");
    assert.equal(
      chunk.nextOffset,
      chunk.offset + chunk.text.length,
      "nextOffset must be in the units read() sliced with",
    );
    const last = chunk.text.charCodeAt(chunk.text.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), "a chunk ended on half an emoji");
    total = chunk.total;
    joined += chunk.text;
    if (!chunk.truncated) break;
    assert.ok(chunk.nextOffset > offset, "read must make progress");
    offset = chunk.nextOffset;
  }
  assert.equal(joined.length, total, "the chunks must tile the document — no gap, no repeat");
  assert.equal(joined, body, "…and tile it into the document that was there");
});

test("read resuming inside an emoji backs up onto the whole character", () => {
  const { api, doc } = fresh();
  const article = new El("article", {}, [
    new El("p", { __text: "Hello 😀 world." }),
    new El("p", { __text: "Second paragraph." }),
    new El("p", { __text: "Third paragraph so the root heuristic picks this block." }),
  ]);
  article.rect = { top: 0, left: 0, width: 600, height: 400 };
  doc.body.appendChild(article);

  const whole = api.call("read", {});
  const emojiAt = whole.text.indexOf("😀");
  assert.ok(emojiAt > 0, "the fixture must actually contain the emoji");

  // An offset one short — what a character count hands back — lands on the LOW
  // half of the pair.
  const resumed = api.call("read", { offset: emojiAt + 1 });
  assert.equal(resumed.offset, emojiAt, "the offset must back up onto the pair");
  assert.ok(
    resumed.text.startsWith("😀"),
    `resumed on ${JSON.stringify(resumed.text.slice(0, 4))}`,
  );
});

/* --------------------------------------------------- capture (Save page…) */

test("capture hands back the page as markdown AND as html", () => {
  // What `browse_save` writes into the room. It is the only page op with no
  // visible failure mode: a broken capture saves a file that LOOKS fine and is
  // missing the page, so the shape is pinned here rather than discovered by a
  // user opening what they saved a week later.
  const { api, doc } = fresh();
  const article = new El("article", {}, [
    new El("h1", { __text: "The Title" }),
    new El("p", { __text: "First paragraph with detail." }),
    new El("p", { __text: "Second paragraph." }),
    new El("p", { __text: "Third paragraph so the root heuristic picks this block." }),
  ]);
  article.rect = { top: 0, left: 0, width: 600, height: 400 };
  doc.body.appendChild(article);

  const out = api.call("capture", {});
  assert.equal(out.ok, true);
  assert.equal(out.what, "page");
  assert.equal(out.url, "https://example.com/page");
  assert.equal(out.title, "Test Page");
  assert.match(out.text, /# The Title/);
  assert.match(out.text, /First paragraph with detail\./);
  assert.match(out.html, /^<!doctype html>\n<html>/);
  assert.match(out.html, /<h1>The Title<\/h1>/, "the saved html is the real document");
  assert.equal(out.truncated, false);
});

test("capture of a selection returns just that text, trimmed, and no html", () => {
  const { api, doc } = fresh();
  doc.body.appendChild(new El("p", { __text: "the whole page" }));
  setSelection("   the part I highlighted  ");

  const out = api.call("capture", { what: "selection" });
  assert.equal(out.ok, true);
  assert.equal(out.what, "selection");
  assert.equal(out.text, "the part I highlighted");
  assert.equal(out.html, "", "a selection is text — saving the whole document would be a lie");
});

test("capture of an empty selection refuses instead of saving the page", () => {
  const { api, doc } = fresh();
  doc.body.appendChild(new El("p", { __text: "the whole page" }));
  setSelection("   ");

  const out = api.call("capture", { what: "selection" });
  assert.equal(out.ok, false);
  assert.match(out.error, /Nothing is selected/);
  // Silently falling back to the whole page is the failure worth naming: the
  // user asked for a quote and would have been handed the article.
  assert.equal(out.text, undefined);
});

test("find returns matching refs and counts page-text occurrences separately", () => {
  const { api, doc } = fresh();
  stack(doc.body, [
    new El("button", { __text: "Sign in" }),
    new El("button", { __text: "Sign out" }),
    new El("p", { __text: "please sign in to continue" }),
  ]);

  const hits = api.call("find", { text: "sign in" });
  assert.equal(hits.ok, true);
  assert.equal(hits.matches.length, 1);
  assert.equal(hits.matches[0].label, "Sign in");
  assert.ok(hits.textOccurrences >= 1, "body text mentions are reported too");

  const none = api.call("find", { text: "zzzz" });
  assert.equal(none.matches.length, 0);
  assert.equal(none.textOccurrences, 0);
});

test("find answers from the numbering already in the model's hands", () => {
  // `find` used to re-snapshot, and a snapshot clears every mark and bumps the
  // generation — so the cheap "which control is called X" tool silently
  // cancelled every ref the model had just been handed, and the next click came
  // back "e1 is gone" on a page nothing had changed on. The earlier find test
  // runs with an EMPTY registry, so it only ever exercised the fallback.
  const { api, doc } = fresh();
  const [signIn] = stack(doc.body, [
    new El("button", { __text: "Sign in" }),
    new El("button", { __text: "Sign out" }),
  ]);

  const snap = api.call("snapshot", {});
  const ref = snap.elements.find((e) => e.label === "Sign in").ref;

  const hits = api.call("find", { text: "sign in" });
  assert.equal(hits.generation, snap.generation, "find must not bump the generation");
  assert.equal(hits.matches.length, 1);
  assert.equal(hits.matches[0].ref, ref, "the ref the model holds must still be the answer");
  assert.equal(signIn.getAttribute("data-arcelle-mark"), "1", "the marks must survive a find");
});

test("find does not offer a control that has since been hidden or disabled", () => {
  // The rebuild drops elements that left the DOM or were re-marked, but it must
  // apply the visibility door a snapshot applies too: a menu that closed, or a
  // button client-side validation switched off, is still marked and still
  // connected — and `act` resolves and clicks it, reporting "clicked e1".
  const { api, doc } = fresh();
  const [menu, save] = stack(doc.body, [
    new El("button", { __text: "Menu item" }),
    new El("button", { __text: "Menu save" }),
    // Stays live, so the registry is non-empty and this really is the
    // currentElements() path rather than the snapshot fallback.
    new El("button", { __text: "Home" }),
  ]);
  api.call("snapshot", {});

  menu.__style = { display: "none", visibility: "visible", opacity: "1" };
  save.setAttribute("disabled", "true");

  const hits = api.call("find", { text: "menu" });
  assert.equal(hits.ok, true);
  assert.deepEqual(
    hits.matches.map((m) => m.label),
    [],
    "a hidden or disabled control is not a live ref",
  );
  // …and the ones still on the page are unaffected.
  assert.equal(api.call("find", { text: "home" }).matches.length, 1);
});

test("lowSignal fires on canvas-dominant and unlabelled pages, not on normal ones", () => {
  const { api, doc } = fresh();
  const canvas = new El("canvas", {});
  canvas.rect = { top: 0, left: 0, width: 1200, height: 800 };
  doc.body.appendChild(canvas);
  stack(doc.body, [new El("button", { __text: "Ok" })]);
  assert.match(api.call("snapshot", {}).lowSignal, /canvas/);

  const clean = fresh();
  stack(clean.doc.body, [
    new El("button", { __text: "Save" }),
    new El("a", { href: "/x", __text: "Docs" }),
  ]);
  assert.equal(clean.api.call("snapshot", {}).lowSignal, null);
});

test("an empty page reports no elements rather than failing", () => {
  const { api } = fresh();
  const snap = api.call("snapshot", {});
  assert.equal(snap.ok, true);
  assert.equal(snap.count, 0);
  assert.match(snap.lowSignal, /no interactive elements/);
});

test("the entry point is total: unknown ops and bad input return errors, never throw", () => {
  const { api } = fresh();
  assert.equal(api.call("nonsense", {}).ok, false);
  assert.equal(api.call("find", {}).ok, false, "find with no text is an error, not a crash");
  assert.equal(api.call("take", { ticket: "nope" }).ok, false);
  // A malformed action is reported, not thrown.
  const started = api.call("begin", { op: "act", args: { actions: ["not an object"] } });
  assert.equal(started.ok, true);
});

test("ping and info answer before any snapshot has been taken", () => {
  const { api } = fresh();
  const ping = api.call("ping", {});
  assert.equal(ping.ok, true);
  assert.equal(ping.url, "https://example.com/page");
  const info = api.call("info", {});
  assert.equal(info.ok, true);
  assert.equal(info.title, "Test Page");
  assert.equal(info.canGoBack, true);
});

test("click_at rejects a point with nothing under it and reports what it hit", async () => {
  const { api, doc } = fresh();
  const [btn] = stack(doc.body, [new El("button", { __text: "Target" })]);
  btn.rect = { top: 100, left: 100, width: 200, height: 50 };

  const miss = await drain(api, "act", { actions: [{ click_at: { x: 5000, y: 5000 } }] });
  assert.equal(miss.ok, false);

  const hit = await drain(api, "act", { actions: [{ click_at: { x: 150, y: 120 } }] });
  assert.equal(hit.results[0].ok, true);
  assert.match(hit.results[0].did, /clicked \(150, 120\)/);
});

test("annotate paints the badge layer and clears it again", async () => {
  const { api, doc } = fresh();
  stack(doc.body, [new El("button", { __text: "One" })]);
  api.call("snapshot", {});

  await drain(api, "annotate", { on: true });
  assert.ok(doc.getElementById("__arcelle_som_layer"), "badges are painted for the screenshot");

  await drain(api, "annotate", { on: false });
  assert.equal(doc.getElementById("__arcelle_som_layer"), null, "and removed afterwards");
});

test("the badge layer is never itself reported as page content", () => {
  const { api, doc } = fresh();
  stack(doc.body, [new El("button", { __text: "One" })]);
  api.call("snapshot", { badges: true });
  const out = api.call("read", { mode: "full" });
  assert.ok(!out.text.includes("__arcelle"), "the agent's own overlay must not leak into read()");
});

test("double injection is a no-op (the script guards its own namespace)", () => {
  const { api } = fresh();
  const before = api.call("ping", {});
  // Re-running the source must not replace or re-initialise the API.
  // eslint-disable-next-line no-new-func
  new Function(SOURCE)();
  assert.equal(globalThis.__arcelleBrowse, api);
  assert.equal(before.ok, true);
});

/* ---------------------------------------------------------------- shadow DOM */

test("inputs inside an open shadow root are found and fillable", async () => {
  // THE BUG (owner report 2026-07-30): a popup built as a web component is a
  // clickable wrapper with nothing inside it, because
  // `document.querySelectorAll` stops at the shadow boundary. The agent could
  // click the dialog and then had no field to type into — which reads to the
  // user as "the browser can't fill this form".
  const { api, doc } = fresh();
  const host = new El("div", { id: "cookie-widget" });
  doc.body.appendChild(host);
  const root = host.attachShadow();
  const input = new El("input", { type: "text", placeholder: "Your email" });
  const button = new El("button", { __text: "Accept all" });
  root.appendChild(input);
  root.appendChild(button);

  const snap = api.call("snapshot", {});
  const labels = snap.elements.map((e) => e.label);
  assert.ok(
    labels.includes("Your email"),
    `the shadow input was not marked; got ${JSON.stringify(labels)}`,
  );
  assert.ok(labels.includes("Accept all"), "the shadow button was not marked");

  // …and it must be actually writable through its ref, not merely listed.
  const ref = snap.elements.find((e) => e.label === "Your email").ref;
  const out = await drain(api, "act", {
    actions: [{ type: { ref, text: "me@example.com" } }],
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(input.value, "me@example.com");
});

test("an open modal outranks the rest of the page when the mark cap bites", () => {
  // A page carrying more than MARK_CAP controls must not spend the whole cap on
  // the nav bar behind a dialog — while a dialog is up, it IS the work.
  const { api, doc } = fresh();
  // 90 background links, laid out ABOVE the modal so viewport order alone
  // would keep them and drop the dialog's field.
  for (let i = 0; i < 90; i++) {
    const a = new El("a", { href: "#", __text: `nav ${i}` });
    a.rect = { top: i, left: 0, width: 80, height: 16, bottom: i + 16, right: 80 };
    doc.body.appendChild(a);
  }
  const dialog = new El("div", { role: "dialog", "aria-modal": "true" });
  dialog.rect = { top: 400, left: 0, width: 400, height: 200, bottom: 600, right: 400 };
  const field = new El("input", { type: "text", placeholder: "Search ticker" });
  field.rect = { top: 450, left: 0, width: 200, height: 24, bottom: 474, right: 200 };
  dialog.appendChild(field);
  doc.body.appendChild(dialog);

  const snap = api.call("snapshot", {});
  const labels = snap.elements.map((e) => e.label);
  assert.ok(snap.overflow > 0, "this page should overflow the cap");
  assert.ok(
    labels.includes("Search ticker"),
    "the modal's field lost the cap to background nav links",
  );
});
