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
 * The two functions are SLICED out of the shipped source (they close over the
 * actions closure and cannot be imported) and driven against fakes — the same
 * technique unsavedGuard/recSession use.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = readFileSync(join(root, "src/workspace/recordingActions.ts"), "utf8");

/** A whole function declaration, by brace matching from its signature. The
 * opening brace is taken at paren depth zero so a parameter's own type
 * annotation cannot be mistaken for the body. */
function fnSource(src, signature) {
  const at = src.indexOf(signature);
  assert.notEqual(at, -1, `${signature} is gone from the source`);
  let parens = 0;
  let open = -1;
  for (let i = at; i < src.length; i++) {
    if (src[i] === "(") parens++;
    else if (src[i] === ")") parens--;
    else if (src[i] === "{" && parens === 0) {
      open = i;
      break;
    }
  }
  assert.notEqual(open, -1, `no body found for ${signature}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`unterminated body for ${signature}`);
}

const MODULE = [
  "export function makeRec(s, api, viewFile, acquireMic, attachMicTap, stopMicTap, noteLiveStt) {",
  "const startRecordingTransport = () => {};",
  "const closeRecordingTransport = () => {};",
  fnSource(SRC, "async function startLiveRecording("),
  fnSource(SRC, "async function stopLiveRecording("),
  "  return { startLiveRecording, stopLiveRecording };",
  "}",
].join("\n");

const JS = ts.transpileModule(MODULE, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { makeRec } = await import(`data:text/javascript,${encodeURIComponent(JS)}`);

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
