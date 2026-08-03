/* The words OCR read off a picture must REACH the picture.
 *
 * The backend has computed, stored and indexed a scan's recognised text for a
 * long time: it is searchable and the model answers from it. The viewer was
 * never handed it, so the one person who could tell the machine had misread a
 * ligature — the person looking at the scan — was the only one who could not
 * see what it read. `classify_file` was then changed to carry the text into the
 * viewer payload, and it still stopped at `ViewerRouter`/`registry.tsx`.
 *
 * Two halves are pinned here:
 *  - `ocrBody`, the pure "what do we show" rule (real source, type-stripped),
 *  - the wiring: the image row of the format registry must pass `text` on, and
 *    ImageView must accept it. Both were the actual gap.
 *
 * Runs under `npm run test:page` (node --test).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");

const SOURCE = readFileSync(join(root, "src/viewers/util.ts"), "utf8");
const JS = ts.transpileModule(SOURCE, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { ocrBody, OCR_PREFIX } = await import(
  `data:text/javascript;base64,${Buffer.from(JS).toString("base64")}`
);

test("the model's prefix never reaches the screen, and empty stays empty", () => {
  // The stored form: a prefix that tells the MODEL this is a machine reading.
  // Printing it under someone's photograph would be a different claim.
  assert.equal(ocrBody(`${OCR_PREFIX}\nInvoice 4471\nTotal 82.10`), "Invoice 4471\nTotal 82.10");
  // Text that arrived without the prefix (an older row) is shown as-is.
  assert.equal(ocrBody("plain words"), "plain words");
  // Empty must read as empty: no panel, rather than a panel saying nothing.
  assert.equal(ocrBody(null), null);
  assert.equal(ocrBody(undefined), null);
  assert.equal(ocrBody(""), null);
  assert.equal(ocrBody("   \n "), null);
  assert.equal(ocrBody(`${OCR_PREFIX}\n   `), null, "a blank recognition is not a reading");
});

test("the Rust side stamps exactly the prefix the viewer strips", () => {
  // If these two drift, the prefix shows up on screen under the picture.
  const rust = readFileSync(join(root, "src-tauri/src/commands/files.rs"), "utf8");
  assert.ok(
    rust.includes(`"${OCR_PREFIX}\\n{text}"`),
    `commands/files.rs no longer writes the ${OCR_PREFIX} prefix this strips`,
  );
});

test("the image row of the format registry hands the text to ImageView", () => {
  const registry = readFileSync(join(root, "src/viewers/registry.tsx"), "utf8");
  const start = registry.indexOf("<ImageView");
  assert.ok(start >= 0, "registry.tsx no longer renders ImageView");
  const call = registry.slice(start, registry.indexOf("/>", start));
  assert.match(call, /\btext=\{c\.text\}/, "ImageView is rendered without the file's text");

  const view = readFileSync(join(root, "src/viewers/ImageView.tsx"), "utf8");
  assert.match(view, /text\?:\s*string \| null;/, "ImageView has no prop for the text");
  assert.match(view, /ocrBody\(text\)/, "ImageView does not derive the shown text");
  assert.match(view, /className="img-ocr"/, "ImageView renders no panel for the text");
});
