/* THE MICROPHONE TAP OF A LIVE RECORDING, driven under node.
 *
 * Two things about `src/workspace/liveRec.ts` cannot be seen from the actions
 * layer above it, and both are silent when they go wrong:
 *
 *   • The tap is a module singleton, but `attachMicTap` only claims it AFTER
 *     awaiting the worklet module. Two overlapping calls — pressing Resume
 *     twice — both passed the guard, and the loser's MediaStream and
 *     AudioContext were dropped on the floor with nothing to stop them: the
 *     macOS mic indicator stays lit for the life of the process and the lane
 *     is pushed into the engine twice.
 *
 *   • Batches were fired at Rust without waiting for the previous one, and
 *     `rec_push_audio` is an async command appended at arrival order — so a
 *     starved task writes its 250 ms in the wrong place in the recording.
 *
 * The module holds singleton state, so each test imports its own copy; `api`
 * and the Web Audio surface are stubbed, and nothing here fakes the module's
 * own logic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { transformSync } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = readFileSync(join(root, "src/workspace/liveRec.ts"), "utf8");

let loaded = 0;
async function load(world) {
  globalThis.window = {
    setTimeout: (fn, ms) => world.timers.push({ fn, ms }),
    clearTimeout: (id) => world.cleared.push(id),
  };
  globalThis.AudioContext = world.AudioContext;
  globalThis.AudioWorkletNode = world.AudioWorkletNode;
  const js = transformSync(SRC, {
    loader: "ts",
    format: "esm",
    target: "es2022",
  }).code;
  // The uniquifier goes on AFTER the transform (which drops trailing comments)
  // — an identical data URL is the same cached module, and this module's whole
  // subject is its singleton state.
  const fresh = `${js}\nexport const __instance = ${++loaded};`;
  return import(`data:text/javascript;base64,${Buffer.from(fresh).toString("base64")}`);
}

function makeWorld() {
  const world = {
    contexts: [],
    nodes: [],
    pushes: [],
    timers: [],
    cleared: [],
    addModule: null,
  };
  let releaseAddModule;
  world.moduleLoaded = new Promise((r) => {
    releaseAddModule = r;
  });
  world.releaseAddModule = () => releaseAddModule();

  world.AudioWorkletNode = class {
    constructor(ctx) {
      this.ctx = ctx;
      this.port = { onmessage: null };
      world.nodes.push(this);
    }
    connect() {}
    disconnect() {}
  };

  const node = () => ({ connect() {}, disconnect() {}, gain: { value: 1 } });
  world.AudioContext = class {
    constructor() {
      this.state = "running";
      this.sampleRate = 48000;
      this.destination = node();
      this.closed = false;
      this.audioWorklet = { addModule: () => world.moduleLoaded };
      world.contexts.push(this);
    }
    resume() {
      return Promise.resolve();
    }
    createMediaStreamSource() {
      return node();
    }
    createGain() {
      return node();
    }
    close() {
      this.closed = true;
      return Promise.resolve();
    }
  };
  return world;
}

function makeStream(name) {
  const tracks = [{ kind: "audio", enabled: true, stopped: false, stop() { this.stopped = true; } }];
  return {
    name,
    tracks,
    getTracks: () => tracks,
    getAudioTracks: () => tracks,
    get stopped() {
      return tracks.every((t) => t.stopped);
    },
  };
}

/** Let every already-resolved promise settle. */
const settle = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

test("a new room defaults off while opt-in and device handoff never enable gain control", async () => {
  const M = await load(makeWorld());

  assert.equal(M.micVoiceProcessingFromSetting(null), false, "missing setting keeps a new room off");
  assert.deepEqual(M.micConstraints(), {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  });

  M.configureMic(M.micVoiceProcessingFromSetting("1"));
  assert.deepEqual(M.micConstraints(), {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false,
  });

  M.configureMic(M.micVoiceProcessingFromSetting("0"));
  assert.deepEqual(M.micConstraints(), {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  });
});

test("a second Resume cannot leave a microphone tap with nobody holding it", async () => {
  const world = makeWorld();
  const M = await load(world);
  M.setRecordingAudioSink((rate, frame) => world.pushes.push({ rate, frame }));
  const first = makeStream("first");
  const second = makeStream("second");

  // Both calls reach `attachMicTap` while the first is still awaiting the
  // worklet module — exactly what two fast clicks on Resume do.
  const a = M.attachMicTap(first);
  const b = M.attachMicTap(second);
  world.releaseAddModule();
  await Promise.all([a, b]);

  assert.equal(world.contexts.length, 1, "only one AudioContext may be built");
  assert.equal(world.nodes.length, 1, "only one worklet tap may be running");
  assert.ok(second.stopped, "the losing call must stop the microphone it was handed");
  assert.ok(!first.stopped, "…and must not touch the one that won");

  // And the winner is the tap `stopMicTap` actually shuts down.
  M.stopMicTap();
  assert.ok(first.stopped);
  assert.ok(world.contexts[0].closed);
});

test("audio batches reach the direct socket as raw ordered float frames", async () => {
  const world = makeWorld();
  const M = await load(world);
  M.setRecordingAudioSink((rate, frame) => world.pushes.push({ rate, frame }));
  const mic = makeStream("mic");
  const attached = M.attachMicTap(mic);
  world.releaseAddModule();
  await attached;

  const tap = world.nodes[0];
  const quarterSecond = () => new Float32Array(48000 / 4);
  tap.port.onmessage({ data: quarterSecond() });
  await settle();
  assert.equal(world.pushes.length, 1, "the first batch goes out at once");

  assert.ok(world.pushes[0].frame instanceof Float32Array);
  assert.equal(world.pushes[0].frame.length, 48000 / 4);

  // WebSocket.send queues synchronously, so consecutive capture batches are
  // handed over in capture order with no async IPC race.
  tap.port.onmessage({ data: quarterSecond() });
  await settle();
  assert.equal(world.pushes.length, 2);
  tap.port.onmessage({ data: quarterSecond() });
  await settle();
  assert.equal(world.pushes.length, 3);
});
