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

/** The one import the module has, replaced by the stub the test installs. */
const withStubbedApi = SRC.replace(
  /^import \{ api \} from "\.\.\/api";$/m,
  "const api = globalThis.__recApi;",
);
if (withStubbedApi === SRC) throw new Error("the api import moved — this harness is stale");

let loaded = 0;
async function load(world) {
  globalThis.__recApi = world.api;
  globalThis.window = {
    setTimeout: (fn, ms) => world.timers.push({ fn, ms }),
    clearTimeout: (id) => world.cleared.push(id),
  };
  globalThis.AudioContext = world.AudioContext;
  globalThis.AudioWorkletNode = world.AudioWorkletNode;
  const js = transformSync(withStubbedApi, {
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
    /** Held so a batch can be left in flight while the next one is offered. */
    resolvers: [],
    /** …and so one can be made to FAIL, which is the case the lane swallows. */
    rejectors: [],
    addModule: null,
  };
  let releaseAddModule;
  world.moduleLoaded = new Promise((r) => {
    releaseAddModule = r;
  });
  world.releaseAddModule = () => releaseAddModule();

  world.api = {
    recPushAudio: (rate, b64) => {
      world.pushes.push({ rate, b64 });
      return new Promise((resolve, reject) => {
        world.resolvers.push(resolve);
        world.rejectors.push(reject);
      });
    },
  };

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

test("a second Resume cannot leave a microphone tap with nobody holding it", async () => {
  const world = makeWorld();
  const M = await load(world);
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

test("audio batches reach the engine in the order they were captured", async () => {
  const world = makeWorld();
  const M = await load(world);
  const mic = makeStream("mic");
  const attached = M.attachMicTap(mic);
  world.releaseAddModule();
  await attached;

  const tap = world.nodes[0];
  const quarterSecond = () => new Float32Array(48000 / 4);
  tap.port.onmessage({ data: quarterSecond() });
  await settle();
  assert.equal(world.pushes.length, 1, "the first batch goes out at once");

  // The engine appends each batch where it ARRIVES, so the second must not be
  // invoked until the first has landed.
  tap.port.onmessage({ data: quarterSecond() });
  await settle();
  assert.equal(world.pushes.length, 1, "the second batch waits for the first");

  world.resolvers[0]();
  await settle();
  assert.equal(world.pushes.length, 2, "…and follows it once it has landed");

  // A batch the engine REJECTS must not stall the lane behind it: the chain is
  // what orders the audio, so a link that never settles would end the
  // recording's capture in silence.
  world.rejectors[1](new Error("the engine refused this batch"));
  tap.port.onmessage({ data: quarterSecond() });
  await settle();
  assert.equal(world.pushes.length, 3, "the batch after a failed one still goes out");
  world.resolvers[2]();
  await settle();
});
