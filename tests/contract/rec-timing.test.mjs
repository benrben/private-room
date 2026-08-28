/* Recording-timeline arithmetic: what the subtitle export re-times with.
 *
 * "Export edited copy" splices the deleted spans out of the audio and re-times
 * its transcript with `cut_shift_before` (src-tauri/src/recording.rs). The .srt
 * button next to it has to agree, or every cue after the first cut runs late
 * against the copy it is meant to caption. This exercises the REAL
 * `src/viewers/recTiming.ts` against the same numbers the Rust unit test uses,
 * so the two implementations can't drift apart silently.
 *
 * Same type-stripping trick as address.test.mjs: the module is TypeScript and
 * these tests are plain Node, so it is transpiled in memory with the
 * `typescript` dev dependency. No compiled output, nothing to keep in sync.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, "../../apps/desktop/src/renderer/viewers/recTiming.ts"), "utf8");
const JS = ts.transpileModule(SOURCE, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { cutShiftBefore } = await import(
  `data:text/javascript,${encodeURIComponent(JS)}`
);

// The fixture from the Rust test (recording.rs): cuts at 100-150 and 200-250.
const CUTS = [
  { t0: 100, t1: 150 },
  { t0: 200, t1: 250 },
];

test("no cuts shifts nothing", () => {
  assert.equal(cutShiftBefore([], 0), 0);
  assert.equal(cutShiftBefore([], 5000), 0);
});

test("matches cut_shift_before at the Rust test's points", () => {
  assert.equal(cutShiftBefore(CUTS, 50), 0);
  assert.equal(cutShiftBefore(CUTS, 150), 50);
  assert.equal(cutShiftBefore(CUTS, 250), 100);
});

test("a point inside a cut counts only the part before it", () => {
  assert.equal(cutShiftBefore(CUTS, 120), 20);
  assert.equal(cutShiftBefore(CUTS, 100), 0);
  assert.equal(cutShiftBefore(CUTS, 225), 75);
});

test("never runs backwards past the end of the cuts", () => {
  // A cue after every cut moves earlier by the whole cut length, and no more.
  assert.equal(cutShiftBefore(CUTS, 10_000), 100);
  // The shifted timestamp itself must stay monotonic and non-negative.
  let prev = -1;
  for (let t = 0; t <= 400; t += 7) {
    const shifted = t - cutShiftBefore(CUTS, t);
    assert.ok(shifted >= 0, `t=${t} shifted below zero`);
    assert.ok(shifted >= prev, `t=${t} went backwards`);
    prev = shifted;
  }
});

test("cuts given out of order still total correctly", () => {
  const jumbled = [...CUTS].reverse();
  assert.equal(cutShiftBefore(jumbled, 250), 100);
  assert.equal(cutShiftBefore(jumbled, 150), 50);
});
