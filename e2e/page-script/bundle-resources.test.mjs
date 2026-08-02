/* Does the packaged app still carry the model weights the host looks for?
 *
 * Three on-device models are resolved through `BaseDirectory::Resource`, i.e.
 * they only exist in a *packaged* build if `bundle.resources` in
 * tauri.conf.json maps them in:
 *   - Whisper   (src/commands/stt_cmds.rs → `models/{stt::MODEL_FILE}`)
 *   - TitaNet   (src/recording.rs         → `models/{diarize::MODEL_FILE}`)
 *   - Silero    (src/recording.rs         → `models/{VAD_MODEL_FILE}`)
 * Every one of those call sites ends in `.filter(|p| p.exists())`, so dropping
 * a line from bundle.resources does not fail any build and does not fail any
 * test — it silently degrades the shipped app. Whisper has already been
 * dropped once: a release built that way reports stt_status.installed = false,
 * answers every imported recording with "model-missing" and refuses to start
 * dictation until the user finds a 574 MB download in Settings. Nothing else
 * in the tree would have gone red.
 *
 * This pins the mapping itself, not the weights: the .bin/.onnx files are
 * gitignored and fetched before a release build (RELEASING.md), and CI stubs
 * the big one, so their presence on disk is deliberately NOT asserted here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

/** `pub const <name>: &str = "<value>";` out of a Rust source file. */
function rustConst(rel, name) {
  const m = read(rel).match(new RegExp(`const ${name}: &str = "([^"]+)"`));
  assert.ok(m, `${name} not found in ${rel} — this test is out of date`);
  return m[1];
}

const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
const resources = conf.bundle.resources;

test("every model the host resolves as a Resource is a bundle resource", () => {
  const models = {
    Whisper: rustConst("src-tauri/src/stt.rs", "MODEL_FILE"),
    TitaNet: rustConst("src-tauri/src/recording/diarize.rs", "MODEL_FILE"),
    Silero: rustConst("src-tauri/src/recording.rs", "VAD_MODEL_FILE"),
  };
  for (const [label, file] of Object.entries(models)) {
    // The host asks for exactly `models/<file>`, so that has to be the *target*
    // side of the map, whatever the path in the repo is called.
    assert.equal(
      resources[`resources/models/${file}`],
      `models/${file}`,
      `${label} (${file}) is not bundled — a release build cannot use it`,
    );
  }
});

test("the sidecar binary is still a bundle resource", () => {
  // Without it the packaged app has no AI engine at all.
  assert.ok(
    Object.keys(resources).some((k) => k.startsWith("resources/sidecar/")),
    "bundle.resources no longer ships the sidecar binary",
  );
});
