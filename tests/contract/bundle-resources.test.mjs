/* The Electron package must copy production model weights and the Python
 * sidecar into Contents/Resources. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const config = readFileSync(
  join(root, "apps/desktop/electron-builder.config.mjs"),
  "utf8",
);
const release = readFileSync(join(root, "scripts/release.sh"), "utf8");

test("the package copies the production model directory", () => {
  assert.match(config, /\{ from: modelsDir, to: "models" \}/);
  for (const model of [
    "ggml-large-v3-turbo-q5_0.bin",
    "nemo_en_titanet_small.onnx",
    "ggml-silero-v5.1.2.bin",
  ]) {
    assert.ok(release.includes(model), `release validation lost ${model}`);
  }
});

test("the package copies the built sidecar", () => {
  assert.match(config, /\{ from: sidecarStageDir, to: "sidecar\/arcelle-sidecar" \}/);
});
