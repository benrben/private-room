/* The workspace's reading of a `rec-state` event, and the recording view's
 * promises about where translation runs.
 *
 * Two things the audit wave got wrong and this pins:
 *
 * 1. `Engine::finish` (src-tauri/src/recording.rs) has TWO terminal statuses,
 *    "saved" and "failed". The listener recognised only "saved", so a failed
 *    final write left `recLive` set and the microphone tap open forever — and
 *    only when the engine stopped ITSELF (3-hour ceiling, room closed under
 *    it), which is exactly the case nobody clicks through by hand.
 *
 * 2. The Live-translate control said translation happens "(on this Mac)" while
 *    it actually runs on the room's chosen model — a cloud one in a cloud room.
 *
 * Same type-stripping trick as rec-timing.test.mjs: the module is TypeScript
 * and these tests are plain Node, so it is transpiled in memory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, "../../src/workspace/recSession.ts"), "utf8");
const JS = ts.transpileModule(SOURCE, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { applyRecState } = await import(`data:text/javascript,${encodeURIComponent(JS)}`);

const OPEN = "file-1";

test("a live status keeps the session and the mic tap", () => {
  for (const status of ["recording", "paused", "saving"]) {
    const out = applyRecState({ fileId: OPEN, status }, OPEN);
    assert.deepEqual(out.live, { fileId: OPEN, status }, status);
    assert.equal(out.stopTap, false, status);
  }
});

test("a saved session clears the state and stops the tap", () => {
  const out = applyRecState({ fileId: OPEN, status: "saved" }, OPEN);
  assert.equal(out.live, null);
  assert.equal(out.stopTap, true);
  assert.equal(out.reload, true);
});

test("a FAILED final write is terminal too — mic closed, session cleared", () => {
  // The regression: "failed" used to fall through to the still-live branch, so
  // the tap stayed open and every new-recording affordance stayed disabled.
  const out = applyRecState({ fileId: OPEN, status: "failed" }, OPEN);
  assert.equal(out.live, null, "a failed session must not read as still live");
  assert.equal(out.stopTap, true, "the microphone must not outlive the session");
  assert.equal(out.clearSave, true);
  assert.equal(out.reload, true, "the view must drop its live controls");
});

test("only the saving phase keeps the save readout", () => {
  assert.equal(applyRecState({ fileId: OPEN, status: "saving" }, OPEN).clearSave, false);
  assert.equal(applyRecState({ fileId: OPEN, status: "failed" }, OPEN).clearSave, true);
});

test("another file's event never reloads the open view", () => {
  const out = applyRecState({ fileId: "other", status: "saved" }, OPEN);
  assert.equal(out.reload, false);
  // …but the session really is over, wherever it belonged.
  assert.equal(out.stopTap, true);
});

test("the recording view never claims translation stays on this Mac", () => {
  const view = readFileSync(join(here, "../../src/viewers/RecordingView.tsx"), "utf8");
  // Sentence-level: "on this Mac" is still true of transcription, so the check
  // is that no sentence pairs it with a translation claim.
  const sentences = view.split(/(?<=[.\n])/);
  for (const s of sentences) {
    if (!/on this Mac/.test(s)) continue;
    assert.ok(
      !/translat/i.test(s),
      `translation does not run on this Mac in a cloud room: ${s.trim()}`,
    );
  }
  // And the blanket "everything stays on this Mac" promise must be gone.
  assert.ok(
    !/everything stays on this Mac/.test(view),
    "the empty-state blurb still promises everything stays on this Mac",
  );
});
