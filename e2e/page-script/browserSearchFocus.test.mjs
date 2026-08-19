/* THE RESULTS PAGE MAY ONLY TAKE THE KEYBOARD FROM ITS OWN BROWSER.
 *
 * `BrowserSearch` focuses its list as soon as results arrive, because every
 * single-key action on that page is dead until it holds focus. But the search
 * is not always the user's — the assistant searches too, and that page mounts
 * while someone may be mid-sentence in the composer — so the effect yields when
 * the focused element is an editable OUTSIDE this browser.
 *
 * "Outside" is decided with `closest(<class>)`, and that class is the root
 * `BrowserView` draws. If either side is renamed the guard silently stops
 * matching, and it fails in the WORSE direction: with no container found,
 * nothing is ever focused, and the user's own search answers no keys at all.
 *
 * The class is read out of BrowserSearch.tsx and checked against BrowserView.tsx
 * — neither name is written down here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");

const SEARCH = readFileSync(join(root, "src/workspace/BrowserSearch.tsx"), "utf8");
const VIEW = readFileSync(join(root, "src/workspace/BrowserView.tsx"), "utf8");

test("the focus guard's container is one BrowserView actually renders", () => {
  const m = SEARCH.match(/closest\("\.([a-z-]+)"\)/);
  assert.ok(m, "BrowserSearch no longer scopes its focus guard to a container");
  const cls = m[1];
  assert.ok(
    VIEW.includes(`className="${cls}"`),
    `BrowserSearch scopes its focus guard to ".${cls}", but BrowserView draws no such ` +
      `element — the guard would find no container and the page would never take the keyboard`,
  );
});

test("the address bar the user just submitted is inside that container", () => {
  // The form does not blur its input on submit, so after a user-initiated
  // search the caret is still in the address box. That box has to count as
  // INSIDE this browser or the results page hands the keyboard back to it and
  // answers nothing.
  const cls = SEARCH.match(/closest\("\.([a-z-]+)"\)/)[1];
  const open = VIEW.indexOf(`className="${cls}"`);
  assert.ok(open >= 0);
  const address = VIEW.indexOf("ref={addressRef}");
  assert.ok(address >= 0, "BrowserView no longer has an address input to be focused in");
  assert.ok(
    address > open,
    "the address input is drawn outside the container the focus guard trusts",
  );
});
