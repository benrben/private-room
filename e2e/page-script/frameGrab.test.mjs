import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const source = readFileSync(join(root, "src/viewers/frameGrab.ts"), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { frameSha256 } = await import(`data:text/javascript,${encodeURIComponent(js)}`);

test("frame receipt hashes the decoded PNG bytes rather than base64 text", async () => {
  const bytes = Buffer.from("the exact extracted frame");
  const base64 = bytes.toString("base64");
  const expected = createHash("sha256").update(bytes).digest("hex");
  assert.equal(await frameSha256(base64), expected);
  assert.notEqual(expected, createHash("sha256").update(base64).digest("hex"));
});
