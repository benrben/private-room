/* What the waveform lane says about a file's audio.
 *
 * The lane drew a flat strip and said NOTHING for three different situations —
 * peaks still being computed, a file with no audio in it, and a track that is
 * genuinely silent — so a video with no audio track read as a broken or
 * half-loaded component. These pin that the three stay apart, and in
 * particular that "nothing came back" is never worded as "this is silent".
 *
 * Runs under `npm run test:page` (node --test) next to the other page tests,
 * against the REAL `src/viewers/waveformSignal.ts`, type-stripped in memory —
 * Waveform.tsx itself imports React, which plain Node cannot resolve.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const SOURCE = readFileSync(join(root, "apps/desktop/src/renderer/viewers/waveformSignal.ts"), "utf8");
const JS = ts.transpileModule(SOURCE, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { readSignal, trackNote } = await import(`data:text/javascript,${encodeURIComponent(JS)}`);

test("a normal track says nothing extra", () => {
  const sig = readSignal({ peaks: [0.1, 1, 0.4], duration: 372, silent: false });
  assert.deepEqual(sig, { state: "signal" });
});

test("a silent track says so, and still draws", () => {
  // The host decoded it, it has a length, and nothing in it is audible: the
  // wave is drawn flat AND labelled, rather than left to look broken.
  const sig = readSignal({ peaks: [0.001, 0.002], duration: 61, silent: true });
  assert.equal(sig.state, "silent");
  assert.match(sig.note, /no audio signal/i);
  assert.match(sig.note, /silent/i);
});

test("an empty envelope is not called silent", () => {
  // Nothing came back — that is the absence of an answer, not the knowledge
  // that the file is quiet. Claiming silence here would be a fabrication.
  for (const data of [
    { peaks: [], duration: 12, silent: false },
    { peaks: [], duration: 0, silent: true },
    { peaks: [0.5, 1], duration: 0, silent: false },
  ]) {
    const sig = readSignal(data);
    assert.equal(sig.state, "empty", JSON.stringify(data));
    assert.doesNotMatch(sig.note, /silent/i, JSON.stringify(data));
    assert.match(sig.note, /no readable audio/i);
  }
});

test("only a probed absence is called a missing track", () => {
  // `MediaMeta.hasAudio === false` is AVFoundation having read the track list.
  assert.match(trackNote(false), /no audio track/i);
  // Everything else is an unknown, and an unknown worded as an absence is the
  // fabrication this whole module exists to prevent.
  assert.equal(trackNote(true), null);
  assert.equal(trackNote(null), null);
  assert.equal(trackNote(undefined), null);
});

test("a lengthless envelope wins over the silent flag", () => {
  // The host sets `silent` from the envelope alone; with no duration there is
  // nothing to draw either way, and "no readable audio" is the honest half.
  assert.equal(readSignal({ peaks: [0.001], duration: 0, silent: true }).state, "empty");
});
