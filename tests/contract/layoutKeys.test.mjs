/* AUDIT: a hidden list of every room name you had opened, in plain storage.
 *
 * The pane layout was saved under `prLayout:<room name>` — outside the
 * encrypted room file, with nothing to clear it (not locking, not quitting, not
 * "Clear recent rooms"), and keyed by NAME, so two rooms called "Work" in
 * different folders shared one layout and overwrote each other's.
 *
 * The key is now a digest of the room's PATH, legacy name-keyed entries are
 * swept on load, and forgetting a shortcut forgets its layout.
 *
 * `layoutKey` is extracted and transpiled rather than imported: useLayout.ts
 * pulls in React, which does not resolve under a bare node test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(root, p), "utf8");

const SRC = read("apps/desktop/src/renderer/shell/layoutState.ts");
const JS = ts.transpileModule(SRC, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { layoutKey } = await import(`data:text/javascript,${encodeURIComponent(JS)}`);

test("the storage key names no room", () => {
  const key = layoutKey("/Users/someone/Documents/Divorce papers.arcelle");
  assert.ok(!key.includes("Divorce"), `the room name is in the key: ${key}`);
  assert.ok(!key.includes("someone"), `the user's folder is in the key: ${key}`);
  assert.match(key, /^prLayout:[0-9a-f]{16}$/);
});

test("same name, different folder, different layout", () => {
  // The reported symptom: two rooms named "Work" fighting over one layout.
  const a = layoutKey("/Users/x/a/Work.arcelle");
  const b = layoutKey("/Users/x/b/Work.arcelle");
  assert.notEqual(a, b);
  // …and the same room is stable across launches.
  assert.equal(a, layoutKey("/Users/x/a/Work.arcelle"));
});

test("legacy name-keyed entries are swept, and clearing recents clears layouts", () => {
  assert.match(SRC, /function sweepLegacyLayoutKeys/);
  assert.ok(
    /loadPersistedLayout\(key: string\): PersistedLayout \{\s*\n\s*sweepLegacyLayoutKeys\(\);/.test(SRC),
    "nothing sweeps the old name-keyed entries on load",
  );
  const app = read("apps/desktop/src/renderer/App.tsx");
  assert.match(app, /forgetSavedLayouts\(\)/, "Clear recent rooms leaves the layouts behind");
  assert.match(app, /forgetSavedLayout\(path\)/, "removing one shortcut leaves its layout behind");
});

test("the workspace keys the layout by path, not by name", () => {
  const ws = read("apps/desktop/src/renderer/Workspace.tsx");
  assert.match(ws, /useLayout\(info\.path\)/);
  assert.ok(!/useLayout\(info\.name\)/.test(ws), "the room name is being used as the key again");
});
