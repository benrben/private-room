import { test } from "node:test";
import assert from "node:assert/strict";
import { readinessGate } from "../e2e/desktop/wdio-readiness.mjs";

test("a failed preparation prevents every worker launch", () => {
  const gate = readinessGate("QA e2e");
  gate.begin();
  gate.fail(new Error("vite build failed"));
  assert.throws(
    () => gate.assertWorkerMayStart(),
    /refusing to launch a browser worker: vite build failed/,
  );
});

test("workers are admitted only after server readiness passes", () => {
  const gate = readinessGate("capture");
  gate.begin();
  assert.throws(() => gate.assertWorkerMayStart(), /preparation did not complete/);
  gate.pass();
  assert.doesNotThrow(() => gate.assertWorkerMayStart());
  gate.reset();
  assert.throws(() => gate.assertWorkerMayStart(), /preparation did not complete/);
});
