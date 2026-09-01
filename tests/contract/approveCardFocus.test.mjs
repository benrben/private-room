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
 * Pinned as a source scan rather than a render test: the shared frame lives in
 * Overlays and the individual cards live in OverlayMenus; rendering the whole
 * stack needs the backend and workspace state. What can be checked without any
 * of that is that no card is drawn by hand and every card uses the shared frame.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const FRAME_SOURCE = readFileSync(
  join(here, "../../apps/desktop/src/renderer/workspace/Overlays.tsx"),
  "utf8",
);
const CARDS_SOURCE = readFileSync(
  join(here, "../../apps/desktop/src/renderer/workspace/OverlayMenus.tsx"),
  "utf8",
);

function componentSource(name) {
  const start = CARDS_SOURCE.indexOf(`export function ${name}`);
  assert.notEqual(start, -1, `${name} is gone from OverlayMenus.tsx`);
  const next = CARDS_SOURCE.indexOf("\nexport function ", start + 1);
  return CARDS_SOURCE.slice(start, next < 0 ? undefined : next);
}

test("every consent card is drawn by the trapped frame, not by hand", () => {
  // One definition, in ApproveCard itself. A hand-rolled backdrop anywhere else
  // is a card that took no focus.
  const backdrops = `${FRAME_SOURCE}\n${CARDS_SOURCE}`.split('className="approve-backdrop"').length - 1;
  assert.equal(
    backdrops,
    1,
    "a second `approve-backdrop` means a consent card is being drawn outside " +
      "ApproveCard — it would take no focus and Tab would walk past it",
  );
});

test("the frame really traps: it uses the shared hook", () => {
  assert.match(FRAME_SOURCE, /import \{ useFocusTrap \}/);
  assert.match(FRAME_SOURCE, /useFocusTrap\(onDecline\)/);
});

test("Escape answers the card instead of closing the file behind it", () => {
  const frame = FRAME_SOURCE.split("function ApproveCard")[1] ?? "";
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
  for (const component of [
    "ScriptApprovalCard",
    "McpDeleteApprovalCard",
    "McpToolApprovalCard",
    "BrowseApprovalCard",
    "EditApprovalCard",
  ]) {
    assert.ok(
      componentSource(component).includes("key={request.id}"),
      `${component} is not keyed by its request`,
    );
  }
});

test("Escape declines — never approves — on all four", () => {
  const declines = [
    ["ScriptApprovalCard", 'onDecline={() => a.resolveScriptApproval(request, "deny")}'],
    ["McpDeleteApprovalCard", 'onDecline={() => a.resolveMcpApproval(request, "deny")}'],
    ["McpToolApprovalCard", 'onDecline={() => a.resolveMcpApproval(request, "deny")}'],
    ["BrowseApprovalCard", "onDecline={() => a.resolveBrowseConsent(request, false)}"],
    ["EditApprovalCard", 'onDecline={() => a.resolveEditApproval(request, "deny")}'],
  ];
  for (const [component, decline] of declines) {
    assert.ok(componentSource(component).includes(decline), `${component} is missing ${decline}`);
  }
});
