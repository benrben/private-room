/* AUDIT 540: the consent cards and the keyboard.
 *
 * The four approval pop-ups — run a script, allow a connected tool, type room
 * text into a web page, apply an AI edit — rendered over a LIVE workspace and
 * moved keyboard focus nowhere at all. Tab walked straight out of the card onto
 * the chrome behind it, including Lock, and Escape reached the app-level
 * handler in effects.ts, which closed the FILE underneath instead of answering
 * the question in front of the user. Settings had done all of this correctly
 * the whole time (`useFocusTrap`).
 *
 * Pinned as a source scan rather than a render test: the cards live inside
 * Overlays, which needs the whole Tauri backend and the workspace state object
 * before it will render a single node. What can be checked without any of that
 * is that no card is drawn by hand any more, and that the shared frame is the
 * one thing that draws them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, "../../apps/desktop/src/renderer/workspace/Overlays.tsx"), "utf8");

test("every consent card is drawn by the trapped frame, not by hand", () => {
  // One definition, in ApproveCard itself. A hand-rolled backdrop anywhere else
  // is a card that took no focus.
  const backdrops = SOURCE.split('className="approve-backdrop"').length - 1;
  assert.equal(
    backdrops,
    1,
    "a second `approve-backdrop` means a consent card is being drawn outside " +
      "ApproveCard — it would take no focus and Tab would walk past it",
  );
});

test("the frame really traps: it uses the shared hook", () => {
  assert.match(SOURCE, /import \{ useFocusTrap \}/);
  assert.match(SOURCE, /useFocusTrap\(onDecline\)/);
});

test("Escape answers the card instead of closing the file behind it", () => {
  const frame = SOURCE.split("function ApproveCard")[1] ?? "";
  const head = frame.slice(0, 1600);
  assert.match(
    head,
    /if \(e\.key === "Escape"\) e\.stopPropagation\(\);/,
    "without this the app-level Escape handler closes the open file underneath",
  );
});

test("each card is keyed by its request, so the next one gets focus too", () => {
  // useFocusTrap moves focus in on MOUNT. Without a key React reuses the
  // component instance for the next request in the queue and the effect never
  // runs again — the second card would take no focus.
  for (const key of [
    "key={pendingScript.id}",
    "key={pendingApproval.id}",
    "key={pendingBrowse.id}",
    "key={pendingEdit.id}",
  ]) {
    assert.ok(SOURCE.includes(key), `missing ${key}`);
  }
});

test("Escape declines — never approves — on all four", () => {
  const declines = [
    'onDecline={() => a.resolveScriptApproval(pendingScript, "deny")}',
    'onDecline={() => a.resolveMcpApproval(pendingApproval, "deny")}',
    'onDecline={() => a.resolveBrowseConsent(pendingBrowse, false)}',
    'onDecline={() => a.resolveEditApproval(pendingEdit, "deny")}',
  ];
  for (const d of declines) assert.ok(SOURCE.includes(d), `missing ${d}`);
});
