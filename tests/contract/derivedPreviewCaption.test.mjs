/* Durable preview provenance must survive the host -> viewer boundary.
 *
 * Import-time Quick Look snapshots reopen as ordinary image bytes. Without a
 * separate status field, ImageView presents that picture as though it were the
 * original and loses the only honest distinction between damage and an
 * unsupported format. Runs under `npm run test:page`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const captionSource = readFileSync(join(root, "apps/desktop/src/renderer/viewers/derivedPreviewStatus.ts"), "utf8");
const captionJs = ts.transpileModule(captionSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { derivedPreviewCaption } = await import(
  `data:text/javascript;base64,${Buffer.from(captionJs).toString("base64")}`
);

test("stored snapshots distinguish damage from unsupported input without guessing", () => {
  const text = derivedPreviewCaption({
    kind: "stored-snapshot",
    originalMime: "application/octet-stream",
  });
  assert.match(text, /Stored snapshot preview/);
  assert.match(text, /may be damaged or may simply use a format/);
  assert.match(text, /cannot distinguish those cases/);
  assert.match(text, /Export saves the original file unchanged/);
});

test("extracted or converted previews disclose incompleteness and preserve the original", () => {
  const text = derivedPreviewCaption({
    kind: "stored-preview",
    originalMime: "image\/x-canon-cr2",
  });
  assert.match(text, /extracted or converted/);
  assert.match(text, /may not contain every page or detail/);
  assert.match(text, /Export saves the original file unchanged/);
});

test("the image registry passes preview provenance to a persistent caption", () => {
  const registry = readFileSync(join(root, "apps/desktop/src/renderer/viewers/registry.tsx"), "utf8");
  const start = registry.indexOf("<ImageView");
  assert.ok(start >= 0, "registry.tsx no longer renders ImageView");
  const call = registry.slice(start, registry.indexOf("/>", start));
  assert.match(call, /derivedPreview=\{c\.derivedPreview\}/);

  const imageView = readFileSync(join(root, "apps/desktop/src/renderer/viewers/ImageView.tsx"), "utf8");
  assert.match(imageView, /derivedPreview\?:\s*DerivedPreviewStatus/);
  assert.match(imageView, /derived-preview-caption/);
  assert.match(imageView, /derivedPreviewCaption\(derivedPreview\)/);
});
