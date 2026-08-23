/**
 * Tests for `audioGraphTap.ts`: the worklet-then-ScriptProcessor ladder both
 * `micTap.ts` and `loopbackTap.ts` share, and `adaptAudioContext`'s bridge onto
 * a real `AudioContext`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIRST_FRAME_TIMEOUT_MS, adaptAudioContext, openPcmTap } from "./audioGraphTap.js";
import { fakeAudioContext, fakeMediaStream } from "./testFixtures.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("openPcmTap — worklet path", () => {
  it("builds a worklet node and resumes a suspended context first", async () => {
    const ctx = fakeAudioContext({ state: "suspended", sampleRate: 16000 });
    const stream = fakeMediaStream();
    await openPcmTap({ audioContext: ctx }, stream, vi.fn());
    expect(ctx.resumeCalls).toBe(1);
    expect(ctx.addWorkletModuleCalls).toEqual(["/rec-worklet.js"]);
    expect(ctx.workletNodes).toHaveLength(1);
    expect(ctx.scriptProcessorNodes).toHaveLength(0);
    expect(ctx.mediaStreamSources).toEqual([stream]);
  });

  it("batches quanta into ~250ms frames and calls onFrame with the concatenated samples", async () => {
    // batch size = round(4/4) = 1 sample: frequent flushes make the assertion small and deterministic
    const ctx = fakeAudioContext({ sampleRate: 4 });
    const onFrame = vi.fn();
    await openPcmTap({ audioContext: ctx }, fakeMediaStream(), onFrame);
    ctx.workletNodes[0]!.emitMessage(new Float32Array([0.5]));
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame).toHaveBeenLastCalledWith(4, new Float32Array([0.5]));
  });

  it("does not call onFrame until the batch threshold is reached, then flushes the WHOLE pending accumulation", async () => {
    const ctx = fakeAudioContext({ sampleRate: 8000 }); // batch size = 2000 samples
    const onFrame = vi.fn();
    const teardown = await openPcmTap({ audioContext: ctx }, fakeMediaStream(), onFrame);
    const node = ctx.workletNodes[0]!;
    node.emitMessage(new Float32Array(1500));
    expect(onFrame).not.toHaveBeenCalled();
    node.emitMessage(new Float32Array(600)); // 2100 total — crosses the 2000 threshold
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame.mock.calls[0]![1]).toHaveLength(2100); // the whole accumulation, not truncated to the threshold
    node.emitMessage(new Float32Array(50)); // a fresh accumulation starts right after a flush
    expect(onFrame).toHaveBeenCalledTimes(1);
    teardown();
    expect(onFrame).toHaveBeenCalledTimes(2);
    expect(onFrame.mock.calls[1]![1]).toHaveLength(50);
  });

  it("teardown() detaches the worklet's handlers and disconnects the graph", async () => {
    const ctx = fakeAudioContext();
    const teardown = await openPcmTap({ audioContext: ctx }, fakeMediaStream(), vi.fn());
    const node = ctx.workletNodes[0]!;
    teardown();
    expect(node.port.onmessage).toBeNull();
    expect(node.onprocessorerror).toBeNull();
    expect(node.disconnectCalls).toBe(1);
  });

  it("a frame within the probe window cancels the first-frame timeout — no fallback rebuild", async () => {
    const ctx = fakeAudioContext({ sampleRate: 8000 });
    await openPcmTap({ audioContext: ctx }, fakeMediaStream(), vi.fn());
    ctx.workletNodes[0]!.emitMessage(new Float32Array(10));
    vi.advanceTimersByTime(FIRST_FRAME_TIMEOUT_MS + 1);
    expect(ctx.scriptProcessorNodes).toHaveLength(0);
  });
});

describe("openPcmTap — fallback ladder", () => {
  it("falls back to ScriptProcessor when addWorkletModule rejects", async () => {
    const ctx = fakeAudioContext({ sampleRate: 2, workletModuleFailure: "CSP refused the module" });
    const onFrame = vi.fn();
    await openPcmTap({ audioContext: ctx, firstFrameTimeoutMs: 5 }, fakeMediaStream(), onFrame);
    expect(ctx.workletNodes).toHaveLength(0);
    expect(ctx.scriptProcessorNodes).toHaveLength(1);
    ctx.scriptProcessorNodes[0]!.emitProcess(new Float32Array([0.9, 0.8]));
    expect(onFrame).toHaveBeenCalled();
  });

  it("rebuilds on the fallback when the worklet dies after loading, losing no pending batch", async () => {
    const ctx = fakeAudioContext({ sampleRate: 8000 }); // batch size = 2000
    const onFrame = vi.fn();
    await openPcmTap({ audioContext: ctx }, fakeMediaStream(), onFrame);
    const worklet = ctx.workletNodes[0]!;
    // 0.5 / 0.25, not 0.1 / 0.2: both are exactly representable in a float32,
    // so a strict `===` after the round-trip isn't fighting rounding noise.
    worklet.emitMessage(new Float32Array(1200).fill(0.5)); // under threshold, held in the shared batcher
    worklet.emitProcessorError();

    expect(worklet.port.onmessage).toBeNull(); // old tap fully torn down
    expect(ctx.scriptProcessorNodes).toHaveLength(1);

    ctx.scriptProcessorNodes[0]!.emitProcess(new Float32Array(800).fill(0.25)); // completes the same 2000-sample batch
    expect(onFrame).toHaveBeenCalledTimes(1);
    const [rate, frame] = onFrame.mock.calls[0]!;
    expect(rate).toBe(8000);
    expect(frame).toHaveLength(2000);
    expect(frame.subarray(0, 1200).every((v: number) => v === 0.5)).toBe(true); // audio from BEFORE the rebuild survived it
    expect(frame.subarray(1200).every((v: number) => v === 0.25)).toBe(true);
  });

  it("rebuilds on the fallback if the worklet loads but never delivers a first frame", async () => {
    const ctx = fakeAudioContext();
    await openPcmTap({ audioContext: ctx }, fakeMediaStream(), vi.fn());
    expect(ctx.scriptProcessorNodes).toHaveLength(0);
    vi.advanceTimersByTime(FIRST_FRAME_TIMEOUT_MS + 1);
    expect(ctx.scriptProcessorNodes).toHaveLength(1);
    expect(ctx.workletNodes[0]!.port.onmessage).toBeNull(); // dead worklet fully detached
  });

  it("teardown cancels the first-frame probe — a stale timer cannot rebuild a fallback afterward", async () => {
    const ctx = fakeAudioContext();
    const teardown = await openPcmTap({ audioContext: ctx }, fakeMediaStream(), vi.fn());
    teardown();
    vi.advanceTimersByTime(FIRST_FRAME_TIMEOUT_MS + 1);
    expect(ctx.scriptProcessorNodes).toHaveLength(0);
  });
});

// =============================================================================
// ---- adaptAudioContext: the real-node unwrapping the graph depends on ------
// =============================================================================

/**
 * A stand-in for a real Web Audio node. `connect` RECORDS its argument instead
 * of type-checking it, which is exactly what makes these tests meaningful: the
 * real `AudioNode.connect` throws `TypeError: parameter 1 is not of type
 * 'AudioNode'` for anything that isn't a real node, and that failure is
 * invisible to `vitest` (no real `AudioContext` in a node environment) and to
 * `tsc` (every Like wrapper typechecks). Asserting on the IDENTITY of what
 * `connect` received is the only way to catch a half-wrapped graph here.
 */
class RealNodeStub {
  connectedWith: unknown[] = [];
  disconnectCalls = 0;
  connect(dest: unknown): void {
    this.connectedWith.push(dest);
  }
  disconnect(): void {
    this.disconnectCalls++;
  }
}

function realCtxStub(): {
  ctx: unknown;
  source: RealNodeStub;
  gain: RealNodeStub & { gain: { value: number } };
  destination: RealNodeStub;
  worklet: RealNodeStub & { port: { onmessage: unknown }; onprocessorerror: unknown };
  scriptProcessor: RealNodeStub & { onaudioprocess: unknown };
} {
  const source = new RealNodeStub();
  const gain = Object.assign(new RealNodeStub(), { gain: { value: 1 } });
  const destination = new RealNodeStub();
  const worklet = Object.assign(new RealNodeStub(), {
    port: { onmessage: null as unknown },
    onprocessorerror: null as unknown,
  });
  const scriptProcessor = Object.assign(new RealNodeStub(), { onaudioprocess: null as unknown });
  const ctx = {
    state: "running",
    sampleRate: 48000,
    destination,
    resume: async () => {},
    close: async () => {},
    audioWorklet: { addModule: async () => {} },
    createMediaStreamSource: () => source,
    createGain: () => gain,
    createScriptProcessor: () => scriptProcessor,
  };
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      constructor() {
        return worklet;
      }
    }
  );
  return { ctx, source, gain, destination, worklet, scriptProcessor };
}

describe("adaptAudioContext", () => {
  it("hands a real node's connect() the REAL destination node, never the Like wrapper", async () => {
    const stub = realCtxStub();
    const adapted = adaptAudioContext(stub.ctx as unknown as AudioContext);
    await openPcmTap({ audioContext: adapted }, fakeMediaStream(), vi.fn());

    expect(stub.source.connectedWith).toEqual([stub.worklet]);
    expect(stub.worklet.connectedWith).toEqual([stub.gain]);
    expect(stub.gain.connectedWith).toEqual([stub.destination]);
    expect(stub.gain.gain.value).toBe(0); // the muted gain that keeps the tap silent
  });

  it("unwraps on the ScriptProcessor path too", async () => {
    const stub = realCtxStub();
    const ctx = stub.ctx as { audioWorklet: { addModule: () => Promise<void> } };
    ctx.audioWorklet.addModule = () => Promise.reject(new Error("CSP refused the module"));
    const adapted = adaptAudioContext(stub.ctx as unknown as AudioContext);
    await openPcmTap({ audioContext: adapted }, fakeMediaStream(), vi.fn());

    expect(stub.source.connectedWith).toEqual([stub.scriptProcessor]);
    expect(stub.scriptProcessor.connectedWith).toEqual([stub.gain]);
    expect(stub.gain.connectedWith).toEqual([stub.destination]);
  });

  it("routes a real worklet's port message through the Like handler and detaches it on teardown", async () => {
    const stub = realCtxStub();
    const adapted = adaptAudioContext(stub.ctx as unknown as AudioContext);
    const onFrame = vi.fn();
    const teardown = await openPcmTap({ audioContext: adapted }, fakeMediaStream(), onFrame);

    const onmessage = stub.worklet.port.onmessage as (ev: { data: Float32Array }) => void;
    onmessage({ data: new Float32Array(12000) }); // batch size at 48000 Hz
    expect(onFrame).toHaveBeenCalledWith(48000, expect.any(Float32Array));

    teardown();
    onFrame.mockClear();
    onmessage({ data: new Float32Array(12000) });
    expect(onFrame).not.toHaveBeenCalled();
  });

  it("routes a real ScriptProcessor's audioprocess event through the Like handler", async () => {
    const stub = realCtxStub();
    const ctx = stub.ctx as { audioWorklet: { addModule: () => Promise<void> } };
    ctx.audioWorklet.addModule = () => Promise.reject(new Error("nope"));
    const adapted = adaptAudioContext(stub.ctx as unknown as AudioContext);
    const onFrame = vi.fn();
    await openPcmTap({ audioContext: adapted }, fakeMediaStream(), onFrame);

    const onaudioprocess = stub.scriptProcessor.onaudioprocess as (ev: {
      inputBuffer: { getChannelData(channel: number): Float32Array };
    }) => void;
    onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(12000) } });
    expect(onFrame).toHaveBeenCalledWith(48000, expect.any(Float32Array));
  });

  it("delegates state/sampleRate/resume/close/addWorkletModule to the real context", async () => {
    const stub = realCtxStub();
    const raw = stub.ctx as {
      state: string;
      resume: () => Promise<void>;
      close: () => Promise<void>;
      audioWorklet: { addModule: (url: string) => Promise<void> };
    };
    const resume = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const addModule = vi.fn(async () => {});
    raw.resume = resume;
    raw.close = close;
    raw.audioWorklet.addModule = addModule;

    const adapted = adaptAudioContext(stub.ctx as unknown as AudioContext);
    expect(adapted.state).toBe("running");
    expect(adapted.sampleRate).toBe(48000);
    await adapted.resume();
    await adapted.close();
    await adapted.addWorkletModule("/rec-worklet.js");
    expect(resume).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(addModule).toHaveBeenCalledWith("/rec-worklet.js");

    raw.state = "closed";
    expect(adapted.state).toBe("closed"); // read through, not snapshotted at adapt time
  });
});
