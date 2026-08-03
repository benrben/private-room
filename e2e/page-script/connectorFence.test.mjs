/* THE CONSENT-SURFACE FENCE, for the Connectors area.
 *
 * ADD-25 gave the UI-driving agent a hard exclusion: `driver.ts` skips any
 * element with a `[data-agent-blocked]` ancestor at the WALKER, so a fenced
 * control never even receives a mark the model could name. Settings, the
 * approval cards, the privacy valve, Time Machine restore and every
 * destructive confirm carry it.
 *
 * Connectors did not. Every control on that page is a permission decision —
 * send a remote connector this room's real values, run its tools without being
 * asked, turn one on or off, remove it and its saved sign-in, install a new
 * internet-reaching one — so an agent able to operate it could grant itself
 * exactly the powers the consent gates exist to withhold.
 *
 * Textual, like connectorpowers.test.mjs beside it: the fence is one attribute
 * on one element, it cannot be observed without mounting the whole React tree,
 * and reading the shipped source is what actually catches it going away.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const read = (p) => readFileSync(join(root, p), "utf8");

const VIEW = read("src/workspace/ConnectorsView.tsx");
const DRIVER = read("src/agent/driver.ts");

test("the Connectors page fences itself off from the UI-driving agent", () => {
  // The fence has to be on the page ROOT, not sprinkled on whichever control
  // someone remembered: the marketplace's Install button, the per-connector
  // power selects and the Remove confirm are all separate subtrees, and the
  // exclusion is inherited from an ancestor.
  const at = VIEW.indexOf('className="connectors-page"');
  assert.notEqual(at, -1, "the connectors-page root element is gone");
  const openTagEnd = VIEW.indexOf(">", at);
  assert.notEqual(openTagEnd, -1, "unterminated connectors-page element");
  assert.match(
    VIEW.slice(at, openTagEnd),
    /data-agent-blocked/,
    "the Connectors area must carry data-agent-blocked on its root — without it " +
      "the app-driving agent can flip the unmasking switch, remove connectors " +
      "and install internet-reaching ones, none of it asking the user first",
  );
});

test("the driver still excludes anything inside a fenced subtree", () => {
  // The fence above is worth exactly what this contract is worth. Both the
  // snapshot walker and the act-on-a-mark path must honour it.
  assert.match(
    DRIVER,
    /el\.closest\("\[data-agent-blocked\]"\)/,
    "the snapshot walker no longer skips fenced elements",
  );
  assert.ok(
    DRIVER.split('closest("[data-agent-blocked]")').length - 1 >= 2,
    "the fence must be checked when acting on a mark too, not only when " +
      "building the snapshot — a stale mark would otherwise walk straight past it",
  );
});
