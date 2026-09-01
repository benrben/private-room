import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadTypescriptModule,
  readReachableSource,
  readRepoFile,
  readSourceModules,
  repoRoot,
  resolveLocalSource,
  sourceGraph,
} from "../support/source-modules.mjs";

test("the resolver follows emitted .js specifiers back to TypeScript source", () => {
  const facade = path.join(repoRoot, "apps/desktop/src/shared/apiTypes.ts");
  assert.equal(
    resolveLocalSource(facade, "./apiTypesCore.js"),
    path.join(repoRoot, "apps/desktop/src/shared/apiTypesCore.ts"),
  );
});

test("the source graph follows imports and re-exports once in stable order", () => {
  const graph = sourceGraph("apps/desktop/src/renderer/api.ts");
  const paths = [...graph.keys()].map((file) => path.relative(repoRoot, file));

  assert.equal(paths[0], "apps/desktop/src/renderer/api.ts");
  assert.ok(paths.includes("apps/desktop/src/renderer/apiRecording.ts"));
  assert.ok(paths.includes("apps/desktop/src/renderer/apiTypes.ts"));
  assert.equal(paths.length, new Set(paths).size);
  assert.deepEqual(paths, [...sourceGraph("apps/desktop/src/renderer/api.ts").keys()].map((file) => path.relative(repoRoot, file)));
});

test("reachable source carries filenames and the implementation behind a facade", () => {
  const source = readReachableSource("apps/desktop/src/renderer/api.ts");
  assert.match(source, /source: apps\/desktop\/src\/renderer\/apiRecording\.ts/);
  assert.match(source, /onWorkspaceOperationProgress/);
});

test("explicit source sets combine module closures with Python and CSS leaves", () => {
  const source = readSourceModules([
    "apps/desktop/src/renderer/workspace/composer.ts",
    "apps/desktop/src/renderer/styles/viewer.part-01.css",
    "services/agent-sidecar/src/arcelle_sidecar/server_runtime.py",
  ]);
  assert.match(source, /source: apps\/desktop\/src\/renderer\/workspace\/composerPresentation\.ts/);
  assert.match(source, /source: apps\/desktop\/src\/renderer\/styles\/viewer\.part-01\.css/);
  assert.match(source, /source: services\/agent-sidecar\/src\/arcelle_sidecar\/server_runtime\.py/);
});

test("the graph ignores packages and non-code assets", () => {
  const graph = sourceGraph("apps/desktop/src/renderer/App.tsx");
  const paths = [...graph.keys()].map((file) => path.relative(repoRoot, file));
  assert.ok(!paths.some((file) => file.endsWith("App.css")));
  assert.ok(!paths.some((file) => file.includes("node_modules")));
});

test("repo reads refuse paths outside the repository", () => {
  assert.throws(() => readRepoFile("../outside.txt"), /outside the repository/);
});

test("repo reads refuse an in-repository symlink that resolves outside", () => {
  const fixture = mkdtempSync(path.join(repoRoot, ".source-modules-test-"));
  const outside = path.join(mkdtempSync(path.join(os.tmpdir(), "source-modules-outside-")), "outside.ts");
  writeFileSync(outside, "export const escaped = true;\n");
  symlinkSync(outside, path.join(fixture, "escape.ts"));
  try {
    assert.throws(() => readRepoFile(path.relative(repoRoot, path.join(fixture, "escape.ts"))), /resolves outside/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(path.dirname(outside), { recursive: true, force: true });
  }
});

test("the runtime loader rejects cycles promptly instead of recursing forever", () => {
  assert.throws(
    () => loadTypescriptModule("apps/desktop/src/renderer/viewers/sketch/model.ts"),
    /cyclic TypeScript module graph/,
  );
});

test("the runtime loader requires every bare dependency to be explicit", () => {
  assert.throws(
    () => loadTypescriptModule("apps/desktop/src/renderer/workspace/BrowserSearchSummary.tsx"),
    /bare import "react(?:\/jsx-runtime)?" needs an explicit mapping/,
  );
});

test("the TypeScript loader executes a facade re-export through the shared resolver", async () => {
  const composer = await import(
    loadTypescriptModule(
      path.join(repoRoot, "apps/desktop/src/renderer/workspace/composer.ts"),
    )
  );
  assert.equal(composer.fileLabel("Report.docx", [{ name: "Report.docx" }]), "Report");
});

test("the runtime loader rewrites declarations without mistaking comments or strings for imports", async () => {
  const operations = await import(
    loadTypescriptModule("apps/desktop/src/renderer/appOperations.ts")
  );
  assert.equal(
    operations.unlockMessage("WRONG_PASSWORD"),
    "That password didn't work. Try again.",
  );
});
