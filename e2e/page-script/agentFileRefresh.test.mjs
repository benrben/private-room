import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");

async function loadPureTypeScript(relativePath) {
  const source = readFileSync(join(root, relativePath), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(javascript)}`);
}

const { refreshSharedFilesForHarnessEvent } = await loadPureTypeScript(
  "src/workspace/harnessFileRefresh.ts",
);

test("an agent-created Sketch refreshes the shared list that drives the workspace footer", async () => {
  const before = Array.from({ length: 11 }, (_, index) => ({ id: `file-${index}` }));
  const after = [...before, { id: "sketch-arcelle-flow" }];
  let sharedFiles = before;
  let reads = 0;

  const refreshed = await refreshSharedFilesForHarnessEvent(
    {
      type: "file_changed",
      runId: "run-sketch",
      relativePath: "Sketches/Arcelle flow.sketch",
      change: "created",
    },
    async () => {
      reads += 1;
      return after;
    },
    (files) => {
      sharedFiles = files;
    },
  );

  assert.equal(refreshed, true);
  assert.equal(reads, 1);
  assert.equal(sharedFiles.length, 12);
  assert.equal(sharedFiles.at(-1).id, "sketch-arcelle-flow");

  // This pins the real renderer seam: StatusBar receives the length of the
  // exact `s.files` store refreshed above, rather than a separate cached count.
  const workspace = readFileSync(join(root, "src/Workspace.tsx"), "utf8");
  assert.match(workspace, /<StatusBar[\s\S]*?fileCount=\{s\.files\.length\}/);
});

test("non-file harness events do not cause redundant room-file reads", async () => {
  let reads = 0;
  const refreshed = await refreshSharedFilesForHarnessEvent(
    { type: "text_delta" },
    async () => {
      reads += 1;
      return [];
    },
    () => {},
  );
  assert.equal(refreshed, false);
  assert.equal(reads, 0);
});
