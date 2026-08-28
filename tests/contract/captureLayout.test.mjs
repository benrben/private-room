import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relative) => readFileSync(join(root, relative), "utf8");
const menu = read("apps/desktop/src/renderer/workspace/LayoutMenu.tsx");
const capture = read("tests/visual/screens.mjs");

const actions = [
  ["layout-toggle-library", "library pane hidden"],
  ["layout-toggle-assistant", "AI pane hidden"],
  ["layout-toggle-focus", "focus mode"],
];

test("every required layout shot uses a stable live Layout-menu action", () => {
  assert.ok(menu.includes('data-testid="layout-menu"'), "Layout menu has no stable trigger");
  for (const [testId, detail] of actions) {
    assert.ok(menu.includes(`testId="${testId}"`), `${detail} action is absent from the product menu`);
    assert.ok(capture.includes(`"${testId}", "${detail}"`), `${detail} is absent from capture coverage`);
  }
});

test("missing layout controls fail at their cause instead of silently skipping coverage", () => {
  const layoutBlock = capture.slice(
    capture.indexOf('it("the pane layouts'),
    capture.indexOf('it("each viewer kind'),
  );
  assert.ok(layoutBlock.includes('waitForExist({'), "layout controls are not awaited");
  assert.ok(layoutBlock.includes("cannot capture ${detail}"), "failure does not name the missing shot");
  assert.ok(!layoutBlock.includes("continue;"), "missing layout control still silently skips its shot");
});
