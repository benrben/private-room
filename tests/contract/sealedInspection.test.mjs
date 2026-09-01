import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readReachableSource } from "../support/source-modules.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const source = (relative) => readFileSync(join(root, relative), "utf8");

test("sealed package inspection exposes a safe manifest and selected extraction command", () => {
  const contract = readReachableSource("apps/desktop/src/shared/ipc-contract.ts");
  const allowlist = source("apps/desktop/src/shared/channelAllowlist.ts");
  const api = readReachableSource("apps/desktop/src/renderer/api.ts");
  assert.match(contract, /inspect_sealed_package:[\s\S]*files: Array</);
  assert.match(contract, /extract_sealed_files:[\s\S]*fileIds: string\[\]/);
  assert.match(allowlist, /extract_sealed_files: true/);
  assert.match(api, /extractSealedFiles:[\s\S]*"extract_sealed_files"/);
});

test("the unlock flow inspects before import and offers accessible file selection", () => {
  const unlock = readReachableSource("apps/desktop/src/renderer/screens/UnlockScreen.tsx");
  const inspection = readReachableSource("apps/desktop/src/renderer/screens/SealedInspectionScreen.tsx");
  const app = readReachableSource("apps/desktop/src/renderer/App.tsx");
  assert.match(unlock, /Inspect sealed backup…/);
  assert.match(app, /inspectSealedPackage\(packagePath, password\)/);
  assert.match(app, /setSealedInspection\(packageInfo\)/);
  assert.match(app, /extractSealedFiles\(packagePath, password, fileIds, destinationPath\)/);
  assert.match(inspection, /aria-labelledby="sealed-inspection-title"/);
  assert.match(inspection, /aria-label="Files in sealed backup"/);
  assert.match(inspection, /type="checkbox"/);
  assert.match(inspection, /Extract selected/);
  assert.match(inspection, /Import as workspace/);
  assert.match(inspection, /Inspection does not edit the backup/);
});
