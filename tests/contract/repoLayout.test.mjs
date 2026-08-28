import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditLayout } from "../../scripts/check-layout.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("repository layout keeps one desktop app, one sidecar service, and one npm lock", () => {
  assert.deepEqual(auditLayout(root), []);
});
