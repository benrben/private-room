/* WHAT THE RECORDING ACTIONS ARE ALLOWED TO CLAIM.
 *
 * Three of these sentences were asserted rather than known:
 *
 *   • Stop said "Recording saved — transcript included." without reading the
 *     result. Live transcription can be switched off mid-session, and a
 *     session where nobody spoke has no segments either — the user opened the
 *     file and found no transcript.
 *   • Start said "(the Mac's audio keeps recording)" when the microphone was
 *     blocked, BEFORE `rec_start` had been called at all. With Screen
 *     Recording denied, nothing was recording and the toast promised a
 *     recording that never existed.
 *   • A failure AFTER `rec_start` succeeded (listFiles rejecting, an
 *     AudioContext that will not build) was reported as a plain error — read
 *     as "start failed" — while the engine went on recording, and the mic was
 *     torn down for it.
 *
 * And `stopLiveRecording`'s post-save refresh sat outside its try, so a
 * rejection there escaped as an unhandled rejection: every caller invokes it
 * as `void a.stopLiveRecording()`.
 *
 * The real owning module is imported after replacing only its platform seams
 * (API, microphone and recording transport) with recorders. The assertions
 * therefore drive the shipped lifecycle rather than a copied implementation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTypescriptModule } from "../support/source-modules.mjs";

globalThis.__recordingApi = {};
globalThis.__recordingAcquireMic = async () => null;
globalThis.__recordingAttachMicTap = async () => {};
globalThis.__recordingStopMicTap = () => {};
globalThis.__recordingNoteLiveStt = () => {};

const STUBS = new Map([
  [
    "apps/desktop/src/renderer/api.ts",
    {
      api: "new Proxy({}, { get: (_target, key) => (...args) => globalThis.__recordingApi[key](...args) })",
    },
  ],
  [
    "apps/desktop/src/renderer/workspace/liveRec.ts",
    {
      acquireMic: "(...args) => globalThis.__recordingAcquireMic(...args)",
      attachMicTap: "(...args) => globalThis.__recordingAttachMicTap(...args)",
      stopMicTap: "(...args) => globalThis.__recordingStopMicTap(...args)",
      noteLiveStt: "(...args) => globalThis.__recordingNoteLiveStt(...args)",
    },
  ],
  [
    "apps/desktop/src/renderer/workspace/recordingTransport.ts",
    {
      startRecordingTransport: "() => {}",
      closeRecordingTransport: "() => {}",
    },
  ],
]);
const { makeLiveRecordingActions } = await import(
  loadTypescriptModule(
    "apps/desktop/src/renderer/workspace/recordingLiveActions.ts",
    { stubs: STUBS },
  ),
);

function makeRec(s, api, viewFile, acquireMic, attachMicTap, stopMicTap, noteLiveStt) {
  globalThis.__recordingApi = api;
  globalThis.__recordingAcquireMic = acquireMic ?? (async () => null);
  globalThis.__recordingAttachMicTap = attachMicTap ?? (async () => {});
  globalThis.__recordingStopMicTap = stopMicTap ?? (() => {});
  globalThis.__recordingNoteLiveStt = noteLiveStt ?? (() => {});
  return makeLiveRecordingActions(s, {
    viewFile,
    isMissingSttModel: () => false,
    showMissingSttModelToast: () => {},
  });
}

function fakeState(recLive = null) {
  const s = {
    recLive,
    toasts: [],
    files: [],
    openFileRef: { current: null },
    pushToast: (kind, text) => s.toasts.push({ kind, text }),
    setRecLive: (v) => {
      s.recLive = typeof v === "function" ? v(s.recLive) : v;
    },
    setFiles: (v) => {
      s.files = v;
    },
    setShowSettings: () => {},
  };
  return s;
}

/** A microphone that opens, and a tap that attaches. */
const liveMic = () => {
  const stopped = [];
  return {
    stopped,
    stream: { getTracks: () => [{ stop: () => stopped.push("mic") }] },
  };
};

test("Stop names the transcript only when one was written", async () => {
  for (const [segments, needle] of [
    [[{ id: "s1" }], "transcript included"],
    [[], "No transcript was written"],
  ]) {
    const s = fakeState({ fileId: "f1", status: "recording" });
    const api = {
      recStop: async () => ({ segments }),
      listFiles: async () => [{ id: "f1" }],
    };
    const rec = makeRec(s, api, async () => {}, null, null, () => {}, () => {});
    await rec.stopLiveRecording();
    const said = s.toasts.map((t) => t.text).join(" | ");
    assert.match(said, new RegExp(needle), said);
    assert.equal(s.recLive, null);
  }
});

test("a refresh that fails after the save is reported, not thrown", async () => {
  const s = fakeState({ fileId: "f1", status: "recording" });
  const api = {
    recStop: async () => ({ segments: [{ id: "s1" }] }),
    listFiles: async () => {
      throw new Error("room busy");
    },
  };
  const rec = makeRec(s, api, async () => {}, null, null, () => {}, () => {});
  // The callers run this as `void stopLiveRecording()`, so a rejection here is
  // an unhandled one — with a success toast already on screen.
  await rec.stopLiveRecording();
  const said = s.toasts.map((t) => t.text).join(" | ");
  assert.match(said, /could not be refreshed/, said);
  assert.match(said, /room busy/, said);
});

test("a blocked microphone never promises a lane that is not up", async () => {
  const s = fakeState();
  const asked = [];
  const api = {
    recStart: async (opts) => {
      asked.push(opts);
      return { fileId: "f9" };
    },
    // Screen Recording denied: the Mac's audio lane is NOT running, whatever
    // the tick said.
    recLiveStatus: async () => ({ sys: ["error", "Screen Recording is off"] }),
    listFiles: async () => [],
  };
  const rec = makeRec(
    s,
    api,
    async () => {},
    async () => {
      throw new Error("Microphone blocked — allow Arcelle…");
    },
    async () => {},
    () => {},
    () => {},
  );
  await rec.startLiveRecording(undefined, { systemAudio: true });
  const said = s.toasts.map((t) => t.text).join(" | ");
  assert.doesNotMatch(said, /keeps recording/, said);
  assert.match(said, /nothing at all is being captured/, said);
  // The box IS ticked, so "start again with it ticked" would be an instruction
  // the user cannot carry out — the lane failed for another reason, and the
  // recording screen's own banner names that one.
  assert.doesNotMatch(said, /ticked/, said);
  // And it only spoke once the engine had been asked to start.
  assert.equal(asked.length, 1);
});

test("an unticked box is the one case that gets the remedy", async () => {
  const s = fakeState();
  const api = {
    recStart: async () => ({ fileId: "f9" }),
    // Never asked for: "off", not "error".
    recLiveStatus: async () => ({ sys: ["off", ""] }),
    listFiles: async () => [],
  };
  const rec = makeRec(
    s,
    api,
    async () => {},
    async () => {
      throw new Error("Microphone blocked — allow Arcelle…");
    },
    async () => {},
    () => {},
    () => {},
  );
  await rec.startLiveRecording(undefined, { systemAudio: false });
  const said = s.toasts.map((t) => t.text).join(" | ");
  assert.match(said, /start again with "Include the Mac's audio" ticked/, said);
});

test("a failure after the engine started is not a failure to start", async () => {
  const s = fakeState();
  const mic = liveMic();
  let attached = false;
  const api = {
    recStart: async () => ({ fileId: "f9" }),
    listFiles: async () => {
      throw new Error("room busy");
    },
  };
  const rec = makeRec(
    s,
    api,
    async () => {},
    async () => mic.stream,
    async () => {
      attached = true;
    },
    () => {},
    () => {},
  );
  await rec.startLiveRecording();
  const said = s.toasts.map((t) => t.text).join(" | ");
  assert.match(said, /recording started/, said);
  // The session is live and the microphone is still in it.
  assert.deepEqual(s.recLive, { fileId: "f9", status: "recording" });
  assert.equal(attached, true);
  assert.deepEqual(mic.stopped, []);
});

test("a start that really fails stops the microphone and says so", async () => {
  const s = fakeState();
  const mic = liveMic();
  const api = {
    recStart: async () => {
      throw new Error("the room is locked");
    },
  };
  const rec = makeRec(
    s,
    api,
    async () => {},
    async () => mic.stream,
    async () => assert.fail("the tap must not be attached without a session"),
    () => {},
    () => {},
  );
  await rec.startLiveRecording();
  assert.equal(s.recLive, null);
  assert.deepEqual(mic.stopped, ["mic"]);
  assert.match(s.toasts.map((t) => t.text).join(" | "), /the room is locked/);
});
