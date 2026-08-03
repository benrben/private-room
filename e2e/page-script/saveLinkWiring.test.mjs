/* Finding #373: the toolbar's Save link must save the page ON SCREEN.
 *
 * `address.test.mjs` pins the DECISION (`needsFreshFetch`). This pins the
 * WIRING, which is the half a helper-only test cannot see: a correct predicate
 * that nothing calls leaves the original bug — Save link re-fetching a
 * signed-in article as a stranger and saving its sign-in wall under the real
 * page's title, while saying "Saved".
 *
 * Source-level rather than rendered, because the control sits over a native
 * webview that no harness can mount. It asserts only the two facts the finding
 * is about: the predicate is consulted, and the live-page capture is what the
 * negative branch calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, "../../src/workspace/BrowserView.tsx"), "utf8");

/** The body of `const saveLink = …`, up to the next top-level `const`. */
function saveLinkBody() {
  const at = SRC.indexOf("const saveLink =");
  assert.notEqual(at, -1, "saveLink has been renamed — re-point this test");
  const rest = SRC.slice(at + 1);
  const end = rest.indexOf("\n  const ");
  return rest.slice(0, end === -1 ? rest.length : end);
}

test("Save link captures the page on screen instead of re-fetching it", () => {
  const body = saveLinkBody();
  assert.match(
    body,
    /needsFreshFetch\(/,
    "Save link no longer asks whether a fresh fetch is actually needed",
  );
  assert.match(
    body,
    /browserSavePage\(/,
    "Save link never captures the live page — it is back to fetching as a stranger",
  );
  // The fetch survives, but only as the branch the predicate selects.
  assert.match(body, /importLink\(/, "the captions/binary fetch path is gone");
  // Order matters: the predicate has to be READ before either branch is taken.
  assert.ok(
    body.indexOf("needsFreshFetch(") < body.indexOf("importLink("),
    "importLink is reached without consulting needsFreshFetch",
  );
});

test("BrowserView imports the predicate from the one module that defines it", () => {
  assert.match(
    SRC,
    /import\s*\{[^}]*needsFreshFetch[^}]*\}\s*from\s*"\.\/address"/,
    "needsFreshFetch is not imported from ./address — a second copy has appeared",
  );
});
