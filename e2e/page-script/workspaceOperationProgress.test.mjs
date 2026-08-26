import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const source = readFileSync(join(root, "src/workspaceOperationProgress.ts"), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  workspaceOperationLabel,
  workspaceOperationDetail,
  updateWorkspaceOperations,
  removeWorkspaceOperation,
} = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const event = (overrides = {}) => ({
  operationId: "operation-1",
  operation: "legacy-conversion",
  phase: "copying-files",
  status: "running",
  completed: 2,
  total: 5,
  unit: "files",
  ...overrides,
});

test("long workspace operations use clear user-facing labels", () => {
  assert.equal(workspaceOperationLabel("legacy-conversion"), "Converting legacy room");
  assert.equal(workspaceOperationLabel("sealed-package-create"), "Creating sealed backup");
  assert.equal(workspaceOperationLabel("sealed-package-import"), "Importing sealed backup");
  assert.equal(workspaceOperationLabel("workspace-checkpoint"), "Saving checkpoint");
  assert.equal(workspaceOperationLabel("write-baseline"), "Protecting files before the agent starts");
});

test("progress detail handles determinate, indeterminate, and terminal phases", () => {
  assert.equal(workspaceOperationDetail(event()), "Copying files — 2 of 5 files");
  assert.equal(
    workspaceOperationDetail(event({ phase: "scanning", total: null })),
    "Scanning files…",
  );
  assert.equal(
    workspaceOperationDetail(event({ phase: "completed", status: "completed" })),
    "Complete",
  );
  assert.equal(
    workspaceOperationDetail(event({ phase: "failed", status: "failed" })),
    "Failed",
  );
});

test("overlapping operations stay visible and updates replace only their own row", () => {
  let operations = updateWorkspaceOperations([], event());
  operations = updateWorkspaceOperations(
    operations,
    event({ operationId: "operation-2", operation: "write-baseline" }),
  );
  operations = updateWorkspaceOperations(operations, event({ completed: 4 }));
  assert.equal(operations.length, 2);
  assert.equal(operations[0].completed, 4);
  assert.equal(operations[1].operation, "write-baseline");
  assert.deepEqual(removeWorkspaceOperation(operations, "operation-1"), [operations[1]]);
});

test("the renderer API subscribes to the Electron progress event", () => {
  const api = readFileSync(join(root, "src/api.ts"), "utf8");
  const app = readFileSync(join(root, "src/App.tsx"), "utf8");
  const surface = readFileSync(
    join(root, "src/screens/WorkspaceOperationProgress.tsx"),
    "utf8",
  );
  assert.match(api, /onWorkspaceOperationProgress/);
  assert.match(api, /"workspace-operation-progress"/);
  assert.match(app, /api\.onWorkspaceOperationProgress/);
  assert.match(app, /<WorkspaceOperationProgress operations=\{workspaceOperations\}/);
  assert.match(surface, /aria-live="polite"/);
  assert.match(surface, /role="status"/);
  assert.match(surface, /<progress/);
});
