/* What the audio viewer says while, and after, it asks for a transcript.
 *
 * Two silences were found here:
 *  - with no speech model installed, `run_stt_job` emits "model-missing" and
 *    returns before it starts. The viewer held that stage and said nothing
 *    with it: the button spun for six seconds and the hint still promised a
 *    transcript that no installed model could write.
 *  - the same six-second timer flipped the button back to "Transcribe" while
 *    the job was still sitting in the one-at-a-time STT lane, so each further
 *    press enqueued another full decode of the same file.
 *
 * AudioView is a React component with no unit runner (it pulls in the Tauri
 * api module and CSS), so this is a WIRING scan of its source, in the same
 * shape as sttfailure.test.mjs: it proves the branches and the stage names
 * exist and agree with the backend's, not that they render.
 *
 * Runs under `npm run test:page` (node --test).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const view = readFileSync(join(root, "apps/desktop/src/renderer/viewers/AudioView.tsx"), "utf8");

test("the stages the backend ends on are the stages the viewer branches on", () => {
  const host = readFileSync(
    join(root, "apps/desktop/src/main/speechSttSurfaceIpc.ts"),
    "utf8",
  );
  assert.match(host, /\[preflight\.name, "model-missing"\]/);
  assert.match(host, /text\.trim\(\) === "" \? "none" : "done"/);
  for (const stage of ["model-missing", "none"]) {
    assert.match(view, new RegExp(`stage === "${stage}"`), `${stage} is not branched on`);
  }
});

test("a missing speech model is named on screen, with where to fix it", () => {
  const hint = view.slice(view.indexOf('end === "model-missing"'));
  assert.ok(hint.length > 0, "no model-missing branch to check");
  assert.match(hint, /No speech model is installed/);
  // The one thing that helps: where the model comes from.
  assert.match(hint, /Settings/);
  assert.match(hint, /Dictation/);
});

test("a file read all the way through with no speech says so", () => {
  assert.match(view, /The audio was read all the way through and held no speech/);
});

test("asking again is held as queued, not reverted on a timer", () => {
  // The revert that let three decodes of one file be queued.
  assert.doesNotMatch(view, /setTimeout\(\(\) => setKicked\(false\), \d+\)/);
  // Queued is its own word, distinct from "Transcribing on this Mac…".
  assert.match(view, /queued: kicked && !transcribing/);
  assert.match(view, /Queued for transcription/);
  // And the flag is released by what the lane says about the file.
  assert.match(view, /stageWhenKicked/);
});
