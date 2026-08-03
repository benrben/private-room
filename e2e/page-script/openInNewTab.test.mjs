/* Finding #501: "Open in a new tab" from the search results looked like a
 * no-op for about a second, and then the page it opened stayed hidden.
 *
 * Two separate failures, both invisible to a type-check:
 *   1. nothing acknowledged the click — the tab appeared only when the strip's
 *      own reconcile tick got round to it;
 *   2. the results list is drawn OVER a webview parked at 1x1, so leaving it up
 *      hid the page that had just been selected until the user left the Browser
 *      area and came back.
 *
 * Source-level, because the control sits over a native webview no harness can
 * mount. Only the two facts the finding is about are pinned.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, "../../src/workspace/BrowserView.tsx"), "utf8");

function openInNewTabBody() {
  const at = SRC.indexOf("const openResultInNewTab");
  assert.notEqual(at, -1, "openResultInNewTab has been renamed — re-point this test");
  const rest = SRC.slice(at);
  const end = rest.indexOf("\n  async function ");
  return rest.slice(0, end === -1 ? rest.length : end);
}

test("opening a result in a new tab answers the click immediately", () => {
  const body = openInNewTabBody();
  // A NOTICE, not `setNotice(null)` — the clearing call in the error path
  // matches a bare `setNotice(` and would let the silent version through.
  assert.match(
    body,
    /setNotice\("[^"]+"\)/,
    "the click is still silent until the strip catches up",
  );
  assert.match(body, /setBusy\(true\)/, "nothing marks the browser busy while the tab opens");
});

test("...and gets the results list out of the way of the page it opened", () => {
  const body = openInNewTabBody();
  assert.match(
    body,
    /setSearchOpen\(false\)/,
    "the results overlay stays up, hiding the page that was just selected",
  );
  assert.ok(
    body.indexOf("browserNewTab") < body.indexOf("setSearchOpen(false)"),
    "the overlay is closed before the tab exists, so a failure leaves a blank stage",
  );
});

test("the results list is actually wired to it", () => {
  // A handler nothing calls is not a fix.
  assert.match(SRC, /onOpenNewTab=\{[^}]*openResultInNewTab/, "onOpenNewTab is not wired");
});
