import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../../src/workspace/harnessUi.ts"), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { applyHarnessEvent, registerHarnessRun, resolveHarnessApproval } =
  await import(`data:text/javascript,${encodeURIComponent(js)}`);

test("normalized events build one durable provider-neutral run record", () => {
  let runs = {};
  runs = applyHarnessEvent(runs, {
    type: "run_started",
    runId: "run-1",
    harness: "codex-app-server",
  });
  // The start result may arrive after the first streamed event.
  runs = registerHarnessRun(runs, "run-1", "codex");
  runs = applyHarnessEvent(runs, {
    type: "text_delta",
    runId: "run-1",
    text: "First ",
  });
  runs = applyHarnessEvent(runs, {
    type: "text_delta",
    runId: "run-1",
    text: "answer",
  });
  assert.equal(runs["run-1"].provider, "codex");
  assert.equal(runs["run-1"].harness, "codex-app-server");
  assert.equal(runs["run-1"].text, "First answer");
});

test("approvals remain visible until the answer command succeeds", () => {
  let runs = applyHarnessEvent({}, {
    type: "approval_requested",
    runId: "run-2",
    requestId: "approval-1",
    tool: "shell",
    detail: "Run a formatter",
  });
  assert.equal(runs["run-2"].status, "waiting");
  assert.equal(runs["run-2"].approvals.length, 1);
  runs = resolveHarnessApproval(runs, "run-2", "approval-1");
  assert.equal(runs["run-2"].status, "running");
  assert.deepEqual(runs["run-2"].approvals, []);
});

test("file review keeps the latest classification for each path", () => {
  let runs = applyHarnessEvent({}, {
    type: "file_changed",
    runId: "run-3",
    relativePath: "notes.md",
    change: "created",
  });
  runs = applyHarnessEvent(runs, {
    type: "file_changed",
    runId: "run-3",
    relativePath: "notes.md",
    change: "modified",
  });
  runs = applyHarnessEvent(runs, {
    type: "run_completed",
    runId: "run-3",
    status: "completed",
  });
  assert.deepEqual(runs["run-3"].changes, [
    { relativePath: "notes.md", change: "modified" },
  ]);
  assert.equal(runs["run-3"].status, "completed");
});
