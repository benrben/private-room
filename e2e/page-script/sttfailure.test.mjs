/* A file the transcriber could not DECODE must not read as a silent one.
 *
 * `run_stt_job` reports `stt-progress` = "failed: <reason>" for a container
 * macOS cannot open, as opposed to "none" for a recording that really is
 * silent. That string was written into `sttStatus` and then only ever compared
 * to "processing", so every reader fell through to the same "No transcript yet
 * — a silent or speechless recording stays empty" hint. The reason — and the
 * one thing that would actually help, converting the file — reached nobody.
 *
 * Two halves are pinned here:
 *  - `sttFailure`, the pure "is this a failure, and why" rule (real source,
 *    type-stripped),
 *  - the wiring: the audio AND video rows of the format registry must pass the
 *    stage on, and AudioView must accept it and say so. Both were the gap.
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
const { sttFailure, STT_FAILED_PREFIX } = await import(
  `data:text/javascript;base64,${Buffer.from(JS).toString("base64")}`
);

test("a decode failure carries its reason; every other stage stays empty", () => {
  assert.equal(
    sttFailure(`${STT_FAILED_PREFIX}unsupported container (no audio track)`),
    "unsupported container (no audio track)",
  );
  // The stages that are NOT failures must never be dressed up as one.
  for (const stage of ["processing", "started", "done", "none", "model-missing"]) {
    assert.equal(sttFailure(stage), null, stage);
  }
  // Nothing known about this file at all.
  assert.equal(sttFailure(undefined), null);
  assert.equal(sttFailure(null), null);
  assert.equal(sttFailure(""), null);
  // Empty reads as empty: a prefix with nothing behind it is not a reason.
  assert.equal(sttFailure(STT_FAILED_PREFIX), null);
  assert.equal(sttFailure(`${STT_FAILED_PREFIX}   `), null);
});

test("the backend's prefix and the viewer's are the same string", () => {
  const host = readFileSync(
    join(root, "electron-migration/electron-app/electron/main/speechSttSurfaceIpc.ts"),
    "utf8",
  );
  // where the frontend finds out rather than in a silent fall-through.
  assert.match(host, /`failed: \$\{message\}`/);
  assert.equal(STT_FAILED_PREFIX, "failed: ");
});

test("the stage reaches the viewer, and the viewer says why", () => {
  const registry = readFileSync(join(root, "src/viewers/registry.tsx"), "utf8");
  // Both media rows render AudioView; both must hand it the stage.
  const passes = registry.match(/sttStage=\{sttStatus\?\.\[c\.name\]\}/g) ?? [];
  assert.equal(passes.length, 2, "audio AND video rows must pass the stage on");

  const view = readFileSync(join(root, "src/viewers/AudioView.tsx"), "utf8");
  assert.match(view, /sttStage\?: string;/, "AudioView must accept the stage");
  assert.match(view, /sttFailure\(sttStage\)/, "…and run it through the rule");
  // And the reason has to be on screen, not merely in a variable.
  assert.match(view, /\{sttWhy\}/, "the reason itself must be rendered");
  assert.match(view, /Transcription failed/);
});
