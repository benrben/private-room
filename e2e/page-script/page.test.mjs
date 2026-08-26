/* Tests for the browser's injected page script
 * (`electron-migration/electron-app/electron/main/browser/page.js`), run against the hand-rolled DOM in
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

import { El, install, currentDocument, setSelection, fireWindow } from "./dom-stub.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(
  join(here, "../../electron-migration/electron-app/electron/main/browser/page.js"),
  "utf8",
);

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

test("a ref that went disabled after the snapshot refuses instead of reporting a click", async () => {
  // The other half of the disabled trap. `snapshot`/`currentElements` never
  // hand out a disabled control, so the ref was legitimate when issued — a
  // form that disables Submit while it validates is the ordinary case. The
  // browser swallows the click; `did: "clicked e1"` was a fabricated result.
  const { api, doc } = fresh();
  const [btn] = stack(doc.body, [new El("button", { __text: "Submit" })]);
  api.call("snapshot", {});
  btn.disabled = true;

  const value = await drain(api, "act", { actions: [{ click: "e1" }] });
  assert.equal(value.ok, false);
  assert.match(value.results[0].error, /is disabled right now/);
  assert.equal(btn.clicked, 0, "a disabled control must never be reported as clicked");

  // And typing into one, which is the same lie with a different verb.
  const [input] = stack(doc.body, [new El("input", { type: "text", value: "" })]);
  api.call("snapshot", {});
  const ref = "e" + input.getAttribute("data-arcelle-mark");
  input.disabled = true;
  const typed = await drain(api, "act", { actions: [{ type: { ref, text: "x" } }] });
  assert.equal(typed.ok, false);
  assert.match(typed.results[0].error, /is disabled right now/);
  assert.equal(input.value, "", "a disabled field must not be written to");
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

/* Item #18: the reading view is a blind user's ONLY copy of the page, so it
 * must not stop five screens down without saying so. `isVisible` rejects
 * anything more than 4000px below the fold, which is right for the snapshot
 * (nothing is clicked that far away) and was silently deleting the document
 * for `read`: the extractor never scrolls, and the reading view deliberately
 * narrows the page to 320px, which is exactly what makes an article run tens
 * of thousands of pixels down. Before the fix this returned 5 of 20
 * paragraphs with `truncated: false`. */
test("read keeps the whole document, not just the part near the fold", () => {
  const { api, doc } = fresh();
  const kids = [];
  for (let i = 0; i < 20; i++) {
    const p = new El("p", { __text: `Paragraph number ${i} with plenty of detail here.` });
    // A real reflow: each paragraph a screen further down, far past the
    // 4000px band, exactly as a long page at a narrow width lays out.
    p.rect = { top: i * 1000, left: 0, width: 320, height: 900 };
    kids.push(p);
  }
  const article = new El("article", {}, kids);
  article.rect = { top: 0, left: 0, width: 320, height: 20000 };
  doc.body.appendChild(article);

  const out = api.call("read", {});
  assert.match(out.text, /Paragraph number 19/, "the end of the page must survive");
  assert.equal(
    out.text.match(/Paragraph number/g).length,
    20,
    "every paragraph, not the first five screens",
  );
  // `total` is measured on what was extracted, so a fragment would also report
  // itself as complete — which is the part that makes this a lie rather than a
  // limit.
  assert.equal(out.truncated, false);
});

/* A clicking rule that is not a reading rule: the SNAPSHOT still spends its
 * marks near the user. Loosening `read` must not loosen `act`. */
test("snapshot still ignores controls miles below the fold", () => {
  const { api, doc } = fresh();
  const near = new El("button", { __text: "Near" });
  near.rect = { top: 100, left: 0, width: 80, height: 30 };
  const far = new El("button", { __text: "Far" });
  far.rect = { top: 40000, left: 0, width: 80, height: 30 };
  doc.body.appendChild(near);
  doc.body.appendChild(far);

  const labels = api.call("snapshot", {}).elements.map((e) => e.label);
  assert.deepEqual(labels, ["Near"]);
});

/* Item #18: the read text is what a screen-reader user is shown, so it has to
 * survive a Markdown renderer as the STRUCTURE it came from. Before this, list
 * items and table rows were pushed with no newline of their own and joined
 * with a space, so a three-item list rendered as one item and a table rendered
 * as a paragraph of pipe characters. The old assertion (`/- one/`) matched
 * happily throughout. */
test("read puts every list item on its own line", () => {
  const { api, doc } = fresh();
  const article = new El("article", {}, [
    new El("p", { __text: "First paragraph with detail." }),
    new El("p", { __text: "Second paragraph." }),
    new El("p", { __text: "Third paragraph so the root heuristic picks this block." }),
    new El("ul", {}, [
      new El("li", { __text: "one" }),
      new El("li", { __text: "two" }),
      new El("li", { __text: "three" }),
    ]),
  ]);
  article.rect = { top: 0, left: 0, width: 600, height: 400 };
  doc.body.appendChild(article);

  const out = api.call("read", {});
  const lines = out.text.split("\n");
  assert.ok(lines.includes("- one"), out.text);
  assert.ok(lines.includes("- two"), out.text);
  assert.ok(lines.includes("- three"), out.text);
});

test("read emits a real GFM table, delimiter row and all", () => {
  const { api, doc } = fresh();
  const table = new El("table", {}, [
    new El("tr", {}, [new El("th", { __text: "a" }), new El("th", { __text: "b" })]),
    new El("tr", {}, [new El("td", { __text: "c" }), new El("td", { __text: "d" })]),
    new El("tr", {}, [new El("td", { __text: "e" }), new El("td", { __text: "f" })]),
  ]);
  const article = new El("article", {}, [
    new El("p", { __text: "First paragraph with detail." }),
    new El("p", { __text: "Second paragraph." }),
    new El("p", { __text: "Third paragraph so the root heuristic picks this block." }),
    table,
  ]);
  article.rect = { top: 0, left: 0, width: 600, height: 400 };
  doc.body.appendChild(article);

  const lines = api.call("read", {}).text.split("\n");
  const head = lines.indexOf("| a | b |");
  assert.ok(head >= 0, lines.join("\n"));
  // The delimiter row must be the NEXT line, exactly once, or nothing below it
  // is a cell.
  assert.equal(lines[head + 1], "| --- | --- |");
  assert.equal(lines[head + 2], "| c | d |");
  assert.equal(lines[head + 3], "| e | f |");
  assert.equal(
    lines.filter((l) => l.startsWith("| ---")).length,
    1,
    "one delimiter row per table, under the first row only",
  );
});

/* Item #18: the keyboard's way back out of the native layer. The page is a
 * sibling native view with its own first responder, so this latch plus the
 * chrome's existing `info` poll is the whole route home. */
test("a double Escape latches a leave request that info reports exactly once", () => {
  const { api } = fresh();
  assert.equal(api.call("info", {}).leaveRequested, false);

  fireWindow("keydown", { key: "Escape" });
  fireWindow("keydown", { key: "Escape" });
  assert.equal(api.call("info", {}).leaveRequested, true);
  // Read and cleared: a second poll must not hand the keyboard back again.
  assert.equal(api.call("info", {}).leaveRequested, false);
});

test("a single Escape is the page's own key, not a request to leave", () => {
  const { api } = fresh();
  fireWindow("keydown", { key: "Escape" });
  assert.equal(api.call("info", {}).leaveRequested, false);
});

test("two Escapes with another key between them do not ask to leave", () => {
  const { api } = fresh();
  fireWindow("keydown", { key: "Escape" });
  fireWindow("keydown", { key: "a" });
  fireWindow("keydown", { key: "Escape" });
  assert.equal(api.call("info", {}).leaveRequested, false);
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
  // `canGoBack` used to ride along here and was read by nobody: Rust's
  // `BrowserInfo` never carried it, so Back and Forward were enabled
  // unconditionally either way. The poll is on a 1.2s beat — it must not pay
  // to measure answers nothing consumes.
  assert.equal(info.canGoBack, undefined);
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

test("a revealed password field stays fenced, and its value never reaches the snapshot", () => {
  // The site's own "show password" toggle sets type="text". From that moment
  // the only signal left is the field's name — and the tool spec promises
  // password fields are never listed.
  const { api, doc } = fresh();
  stack(doc.body, [
    new El("input", { type: "text", name: "user", value: "ada" }),
    new El("input", { type: "text", name: "password", id: "password", value: "hunter2" }),
  ]);
  const snap = api.call("snapshot", {});
  assert.equal(snap.count, 1, "only the username is actionable");
  assert.equal(snap.secrets, 1, "a revealed password field is still a password field");
  assert.ok(
    !JSON.stringify(snap).includes("hunter2"),
    "the password must not appear anywhere in what the model reads",
  );
});

test("a card number is reported as filled rather than quoted back", () => {
  // Not fenced — the agent can legitimately be asked to fill one — but copying
  // the digits into the transcript is a copy of them nobody asked for.
  const { api, doc } = fresh();
  stack(doc.body, [
    new El("input", {
      type: "text",
      autocomplete: "cc-number",
      name: "cardNumber",
      value: "4111111111111111",
    }),
  ]);
  const snap = api.call("snapshot", {});
  assert.equal(snap.count, 1);
  assert.equal(snap.elements[0].state, "filled");
  assert.ok(!JSON.stringify(snap).includes("4111"), "the number must not be echoed");
});

test("find never renumbers a page whose marks have merely scrolled out of view", () => {
  const { api, doc } = fresh();
  const [save] = stack(doc.body, [
    new El("button", { __text: "Save" }),
    new El("button", { __text: "Sign in" }),
  ]);
  const first = api.call("snapshot", {});
  assert.equal(first.count, 2);
  // The user scrolls with the trackpad: the marks are all still out there,
  // they are simply far above the viewport now.
  for (const el of doc.body.children) el.rect = { ...el.rect, top: 90000 };

  const found = api.call("find", { text: "sign in" });
  assert.equal(found.ok, true);
  assert.deepEqual(found.matches, [], "nothing is offered from a numbering it cannot see");
  assert.equal(
    found.generation,
    first.generation,
    "a silent re-snapshot would renumber the page and point every ref the model holds at a different control",
  );
  assert.equal(save.getAttribute("data-arcelle-mark"), "1", "the marks are left in place");
});

test("find re-numbers a page whose marks left with the document they were written on", () => {
  // The other side of the same gate. An SPA route swap detaches every marked
  // element, so every ref the model holds is already dead and renumbering
  // invalidates nothing — refusing to re-scan would leave `browse_find` unable
  // to answer anything at all until a snapshot was asked for by name.
  const { api, doc } = fresh();
  const [, signIn] = stack(doc.body, [
    new El("button", { __text: "Save" }),
    new El("button", { __text: "Sign in" }),
  ]);
  const first = api.call("snapshot", {});
  for (const el of [...doc.body.children]) {
    el.isConnected = false;
    doc.body.removeChild(el);
  }
  assert.equal(signIn.isConnected, false);
  stack(doc.body, [new El("button", { __text: "Sign in" })]);

  const found = api.call("find", { text: "sign in" });
  assert.equal(found.ok, true);
  assert.equal(found.matches.length, 1, "the control that IS on the page is offered");
  assert.notEqual(found.generation, first.generation, "and the model is told it is a new numbering");
});

test("wait_for gone refuses a ref that was not there to begin with", async () => {
  const { api, doc } = fresh();
  stack(doc.body, [new El("button", { __text: "Save" })]);
  api.call("snapshot", {});
  const out = await drain(api, "act", { actions: [{ wait_for: { gone: "e99" } }] });
  assert.equal(out.results[0].ok, false);
  assert.match(out.results[0].error, /not one of this page's refs/);
  assert.equal(out.ok, false, "the batch stops rather than pretending it waited");
});

test("waiting for something an earlier action in the same batch removed is a wait, not a refusal", async () => {
  // The commonest gone-batch there is: close the banner, then wait for the
  // banner to go. The ref IS one this numbering issued, and by the time the
  // wait starts it is already detached — refusing it would call a batch that
  // did exactly what it was asked a failure, word it "was not on the page to
  // begin with" about something that plainly was, and bill for a screenshot.
  const { api, doc } = fresh();
  const [close, save] = stack(doc.body, [
    new El("button", { __text: "Dismiss" }),
    new El("button", { __text: "Save" }),
  ]);
  api.call("snapshot", {});
  close.click = function () {
    this.clicked++;
    this.isConnected = false;
  };
  const out = await drain(api, "act", {
    actions: [{ click: "e1" }, { wait_for: { gone: "e1" } }, { click: "e2" }],
  });
  assert.equal(out.results[1].ok, true, "the banner went away, which is what was waited for");
  assert.equal(out.results[1].did, "waited until it disappeared");
  assert.equal(out.ok, true, "nothing failed, so nothing pays for a picture of the page");
  assert.equal(save.clicked, 1, "the batch was allowed to finish");
});

test("a show-password toggle is not counted as a password field the user must fill", () => {
  // The name test is a substring one, so the very control that motivated it —
  // the site's reveal checkbox — carries the word as plainly as the field it
  // reveals. Fencing it made the snapshot's "N password field(s) present"
  // line a count of fields to fill that included one nobody fills.
  const { api, doc } = fresh();
  stack(doc.body, [
    new El("input", { type: "text", name: "password", id: "password", value: "hunter2" }),
    new El("input", { type: "checkbox", id: "showPassword" }),
  ]);
  const snap = api.call("snapshot", {});
  assert.equal(snap.secrets, 1, "one field to type into, not two");
  assert.equal(snap.count, 1, "and the toggle is still something the agent can press");
  assert.equal(snap.elements[0].role, "checkbox");
  assert.ok(!JSON.stringify(snap).includes("hunter2"), "the password is still fenced");
});

test("a wait for something to disappear is reported as that, not as its opposite", async () => {
  const { api, doc } = fresh();
  const [spinner] = stack(doc.body, [new El("button", { __text: "Loading" })]);
  api.call("snapshot", {});
  setTimeout(() => {
    spinner.isConnected = false;
  }, 150);
  const out = await drain(api, "act", { actions: [{ wait_for: { gone: "e1" } }] });
  assert.equal(out.results[0].ok, true);
  assert.equal(out.results[0].did, "waited until it disappeared");
});

test("a batch cut short by a same-document navigation is reported as navigated, not as failed", async () => {
  const { api, doc } = fresh();
  const [link, other] = stack(doc.body, [
    new El("a", { href: "#section", __text: "Jump" }),
    new El("button", { __text: "Save" }),
  ]);
  api.call("snapshot", {});
  link.click = function () {
    this.clicked++;
    globalThis.location.href = "https://example.com/page#section";
  };
  const out = await drain(api, "act", { actions: [{ click: "e1" }, { click: "e2" }] });
  assert.equal(out.results[0].ok, true, "the click itself succeeded");
  assert.equal(out.navigated, true, "the batch was cut short on purpose, not by a failure");
  assert.equal(out.urlChanged, true);
  assert.equal(other.clicked, 0, "the later action never ran");
});
