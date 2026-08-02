/* Tests for the visual-QA IPC mock (`qa/qa-mock.js`):
 *
 *     node --test e2e/page-script/
 *
 * The mock IS the backend for `npm run e2e:qa`, `npm run capture` and every
 * by-hand look at the UI before a release, so a hole in it is invisible in
 * exactly the way a hole in a test harness always is: the app renders, the run
 * stays green, and the screenshot is filed as a picture of the real thing.
 *
 * Two things are pinned here, both of which were once broken:
 *
 *  1. The BROWSER family. Every browser mutation used to fall through to the
 *     unhandled fallback and return `null`; `browser_navigate` handed that
 *     `null` back to the address bar, which assigned it into its input and
 *     threw on the next keystroke. So the Browser area — the one screen whose
 *     page can never be faked, because it is a native webview — was also the
 *     one screen the harness could not open at all.
 *  2. The unhandled fallback itself. A command with no fixture must stay
 *     non-crashing AND leave a record loud enough that a human eyeballing the
 *     harness cannot read the MOCK's emptiness as the app's.
 *
 * No DOM library is involved: the mock touches a handful of document methods
 * for its gap badge, and those are stubbed below.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, "../../qa/qa-mock.js"), "utf8");

/** Just enough page for the mock: the bits it reads on load, plus the element
 *  plumbing its "no fixture" badge needs. */
function install({ search = "", hash = "" } = {}) {
  const g = globalThis;
  const nodes = new Map();
  g.window = g;
  g.location = { search, hash, href: "http://localhost/qa.html" };
  g.document = {
    body: {
      appendChild(el) {
        nodes.set(el.id, el);
      },
    },
    createElement: () => ({ id: "", textContent: "", style: { cssText: "" } }),
    getElementById: (id) => nodes.get(id) ?? null,
    addEventListener: () => {},
  };
  delete g.__TAURI_INTERNALS__;
  delete g.__qaUnhandled;
  // eslint-disable-next-line no-new-func
  new Function(SOURCE)();
  return {
    invoke: (cmd, args) => g.__TAURI_INTERNALS__.invoke(cmd, args),
    gapBadge: () => nodes.get("qa-mock-gap") ?? null,
  };
}

test("the browser starts cold, exactly as a freshly opened room does", async () => {
  const qa = install();
  assert.deepEqual(await qa.invoke("browser_info"), { open: false });
  assert.deepEqual(await qa.invoke("browser_tabs"), []);
});

test("navigating opens the page, normalises the address and records it", async () => {
  const qa = install();
  const before = (await qa.invoke("browser_journal", {})).length;

  // A bare host gets https://, the way `browser_navigate` does in Rust — and
  // the SETTLED url is the return value, because the address bar assigns it.
  const settled = await qa.invoke("browser_navigate", { url: "en.wikipedia.org/wiki/Speaker_diarisation" });
  assert.equal(settled, "https://en.wikipedia.org/wiki/Speaker_diarisation");

  const info = await qa.invoke("browser_info");
  assert.equal(info.open, true);
  assert.equal(info.blank, false, "a navigated page is not a blank tab");
  assert.equal(info.url, settled);
  assert.ok(info.title, "the page has a title for the tab strip");

  const tabs = await qa.invoke("browser_tabs");
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].active, true);
  assert.equal(tabs[0].url, settled);

  const journal = await qa.invoke("browser_journal", {});
  assert.equal(journal.length, before + 1);
  assert.equal(journal[0].kind, "open");
  assert.equal(journal[0].url, settled);
});

test("an address pointing at this Mac is refused, not silently 'visited'", async () => {
  const qa = install();
  await assert.rejects(() => qa.invoke("browser_navigate", { url: "http://127.0.0.1:1420/" }));
  await assert.rejects(() => qa.invoke("browser_navigate", { url: "http://192.168.1.10/admin" }));
  assert.deepEqual(await qa.invoke("browser_info"), { open: false });
});

test("tabs open, switch and close, and something is always active", async () => {
  const qa = install();
  const first = await qa.invoke("browser_new_tab", { url: "example.com" });
  const second = await qa.invoke("browser_new_tab", { url: "" });

  // A brand-new empty tab is BLANK — that is what puts the start screen, not
  // an empty rectangle, under the chrome.
  let info = await qa.invoke("browser_info");
  assert.equal(info.blank, true);
  assert.equal(info.url, null);

  await qa.invoke("browser_select_tab", { id: first });
  info = await qa.invoke("browser_info");
  assert.equal(info.url, "https://example.com");

  await qa.invoke("browser_close_tab", { id: first });
  const tabs = await qa.invoke("browser_tabs");
  assert.deepEqual(tabs.map((t) => t.id), [second]);
  assert.equal(tabs[0].active, true, "closing the active page must leave one active");

  await assert.rejects(() => qa.invoke("browser_select_tab", { id: first }));
});

test("the chrome's remaining controls answer like the real commands", async () => {
  const qa = install();
  await qa.invoke("browser_navigate", { url: "https://example.com/docs/intro" });

  assert.equal(await qa.invoke("browser_set_bounds", { x: 0, y: 0, width: 800, height: 600 }), null);
  assert.equal(await qa.invoke("browser_go", { action: "back" }), null);
  await assert.rejects(() => qa.invoke("browser_go", { action: "sideways" }));

  await qa.invoke("browser_set_takeover", { on: true });
  assert.equal((await qa.invoke("browser_info")).takeover, true);
  await qa.invoke("browser_set_takeover", { on: false });
  assert.equal((await qa.invoke("browser_info")).takeover, false);

  // Save reports the sentence the notice banner prints verbatim.
  const saved = await qa.invoke("browser_save_page", { what: "page" });
  assert.match(saved, /^Saved ".+" \(readable copy\) and ".+" \(exact HTML\) into the room\.$/);
  assert.match(await qa.invoke("browser_save_page", { what: "selection" }), /^Saved ".+" into the room\.$/);

  await qa.invoke("browser_clear_journal");
  assert.deepEqual(await qa.invoke("browser_journal", {}), []);
});

test("saving with no page open fails the way the real command does", async () => {
  const qa = install();
  await assert.rejects(() => qa.invoke("browser_save_page", { what: "page" }));
});

test("an unfaked command stays non-crashing and says so, on the page", async () => {
  const qa = install();
  assert.equal(await qa.invoke("wildly_unfaked_command"), null);
  // A read that returns a bare object would crash a pane; a list gets a list.
  assert.deepEqual(await qa.invoke("list_something_nobody_faked"), []);

  assert.deepEqual(globalThis.__qaUnhandled, {
    wildly_unfaked_command: 1,
    list_something_nobody_faked: 1,
  });
  const badge = qa.gapBadge();
  assert.ok(badge, "the gap has to be visible IN the harness, not only in the console");
  assert.match(badge.textContent, /wildly_unfaked_command/);
  assert.match(badge.textContent, /list_something_nobody_faked/);
});

test("the areas that render from fixtures are stocked, not empty", async () => {
  const qa = install();
  // Each of these was reported empty in the harness at some point, which reads
  // as "the app has nothing here" rather than "the mock has nothing here".
  assert.ok((await qa.invoke("list_skills")).length, "Skills");
  assert.ok((await qa.invoke("list_ai_providers")).length, "AI providers");
  assert.ok((await qa.invoke("mcp_registry_search", { query: "" })).length, "the connector marketplace");
  assert.ok((await qa.invoke("browser_search", { query: "x" })).hits.length, "web search results");
  // The internet switch has to be ON, or the app hides the browser half of the
  // workspace: no page tabs, no New page button.
  assert.equal(await qa.invoke("get_setting", { key: "web_provider" }), "on");
  assert.deepEqual(globalThis.__qaUnhandled, undefined, "none of that reached the fallback");
});

test("?qa_state=empty empties the collections without breaking their shape", async () => {
  const qa = install({ search: "?qa_state=empty" });
  assert.deepEqual(await qa.invoke("list_files"), []);
  assert.deepEqual(await qa.invoke("browser_journal", {}), []);
  const front = await qa.invoke("front_page");
  assert.deepEqual(front.recentFiles, []);
  assert.equal(front.fileCount, 0);
});
