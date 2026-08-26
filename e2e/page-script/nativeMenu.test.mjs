/* Renderer/native-menu seam checks for the Electron host. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(root, p), "utf8");
const menu = read("electron-migration/electron-app/electron/main/menu.ts");
const hook = read("src/shell/useNativeMenu.ts");
const layout = read("src/shell/useLayout.ts");

const hostIds = () => [...menu.matchAll(/export const VIEW_[A-Z_]+_ID = "(view\.[a-z.-]+)"/g)].map((m) => m[1]);
const rendererIds = () => {
  const body = /const ACTIONS: Record<string, \(layout: LayoutApi\) => void> = \{([\s\S]*?)\n\};/.exec(hook)?.[1];
  assert.ok(body, "ACTIONS map not found");
  return [...body.matchAll(/"(view\.[a-z.-]+)":/g)].map((m) => m[1]);
};

test("every native View row has one renderer handler", () => {
  assert.deepEqual(rendererIds().sort(), hostIds().sort());
});

test("⌘1 and ⌘2 belong to the menu alone", () => {
  assert.match(menu, /id: VIEW_LIBRARY_ID,[\s\S]{0,120}accelerator: "CmdOrCtrl\+1"/);
  assert.match(menu, /id: VIEW_ASSISTANT_ID,[\s\S]{0,120}accelerator: "CmdOrCtrl\+2"/);
  const map = /export const PANE_KEYS[^=]*=\s*\{([^}]*)\}/.exec(layout)?.[1] ?? "";
  assert.doesNotMatch(map, /"[12]":/);
});

test("only Close and Quit are enabled without a room", () => {
  assert.match(menu, /return id === CLOSE_ID \|\| id === QUIT_ID/);
  assert.match(menu, /enabled: alwaysEnabled\(row\.id\)/);
  assert.match(menu, /if \(id === CLOSE_ID && !deps\.isRoomOpen\(\)\)/);
  assert.match(hook, /syncViewMenu\(\{\s*enabled: false/);
});

test("every menu state field is a hook dependency", () => {
  const call = hook.slice(hook.indexOf("syncViewMenu({"));
  const deps = call.slice(call.indexOf("["), call.indexOf("]", call.indexOf("[")) + 1);
  for (const name of ["library", "assistant", "focus", "railLabels", "railLabelsSettable"]) {
    assert.match(call, new RegExp(`\\b${name}(?:,|:)`), `payload lost ${name}`);
    assert.ok(deps.includes(name), `dependency list lost ${name}`);
  }
  assert.match(call, /enabled: true/);
  assert.match(call, /sidebar: sidebarTitle/);
  assert.ok(deps.includes("sidebarTitle"), "dependency list lost sidebarTitle");
  assert.ok(deps.includes("pressed"), "a native press must force a truth resync");
});
