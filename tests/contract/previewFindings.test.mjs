import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadTypescriptModule } from "../support/source-modules.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");

async function load(relPath) {
  return import(loadTypescriptModule(relPath));
}

test("generated MOBI markup declares the UTF-8 bytes that actually carry it", async () => {
  const { declareGeneratedMarkupUtf8 } = await load("apps/desktop/src/renderer/viewers/bookEncoding.ts");
  assert.equal(
    declareGeneratedMarkupUtf8('<?xml version="1.0" encoding="windows-1252"?><p>It’s fine</p>'),
    '<?xml version="1.0" encoding="utf-8"?><p>It’s fine</p>',
  );
  assert.equal(
    declareGeneratedMarkupUtf8('<meta charset=windows-1252><p>It’s fine</p>'),
    '<meta charset=utf-8><p>It’s fine</p>',
  );
  assert.equal(
    declareGeneratedMarkupUtf8('<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"><p>It’s fine</p>'),
    '<meta http-equiv="Content-Type" content="text/html; charset=utf-8"><p>It’s fine</p>',
  );
});

test("the PSD worker installs ag-psd's worker canvas before reading pixels", () => {
  const worker = readFileSync(join(root, "apps/desktop/src/renderer/viewers/rasterDecode.worker.ts"), "utf8");
  assert.match(worker, /initializeCanvas\(/);
  assert.match(worker, /new OffscreenCanvas\(/);
  assert.ok(
    worker.indexOf("initializeCanvas(") < worker.indexOf("const psd = readPsd("),
    "canvas initialization must happen before PSD parsing",
  );
});

test("an empty archive listing does not claim a damaged archive is empty", () => {
  const view = readFileSync(join(root, "apps/desktop/src/renderer/viewers/ArchiveView.tsx"), "utf8");
  assert.doesNotMatch(view, />This archive is empty\.</);
  assert.match(view, /No files could be listed from this archive/);
  assert.match(view, /empty, damaged,/);
});

test("MSG bypasses the raw-byte encoding warning used by EML", () => {
  const encoding = readFileSync(join(root, "apps/desktop/src/renderer/viewers/TextEncoding.tsx"), "utf8");
  assert.match(
    encoding,
    /return\s+content\.kind !== "email"\s*\|\|\s*!content\.name\.toLocaleLowerCase\(\)\.endsWith\("\.msg"\)/,
  );
});

test("compressed tar siblings keep distinguishable labels", async () => {
  const { displayName, fileLabel } = await load("apps/desktop/src/renderer/workspace/composer.ts");
  const files = [{ name: "sample.tar" }, { name: "sample.tar.gz" }];
  assert.equal(displayName("sample.tar.gz"), "sample");
  assert.equal(fileLabel("sample.tar", files), "sample.tar");
  assert.equal(fileLabel("sample.tar.gz", files), "sample.tar.gz");
});

test("Home and the footer label their public counts consistently as room files", () => {
  const status = readFileSync(join(root, "apps/desktop/src/renderer/shell/StatusBar.tsx"), "utf8");
  const home = readFileSync(join(root, "apps/desktop/src/renderer/workspace/FrontPage.tsx"), "utf8");
  assert.match(status, /\{fileCount\} room file/);
  assert.match(home, /\{page\.fileCount\} room file/);
  assert.match(status, /including files shown only in sections/);
  assert.match(status, /internal preview artifacts are not counted/);
});
