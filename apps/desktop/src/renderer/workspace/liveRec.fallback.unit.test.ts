import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Timer = { id: number; callback: () => void; cleared: boolean };

const fake = {
  contexts: [] as FakeAudioContext[],
  sources: [] as FakeSource[],
  gains: [] as FakeGain[],
  scripts: [] as FakeScriptProcessor[],
  worklets: [] as FakeWorkletNode[],
  timers: [] as Timer[],
  addModule: vi.fn<() => Promise<void>>(),
  close: vi.fn<() => Promise<void>>(),
  resume: vi.fn<() => Promise<void>>(),
  contextState: "running",
};

class FakeSource {
  connect = vi.fn();
  disconnect = vi.fn();

  constructor() {
    fake.sources.push(this);
  }
}

class FakeGain {
  gain = { value: 1 };
  connect = vi.fn();
  disconnect = vi.fn();

  constructor() {
    fake.gains.push(this);
  }
}

class FakeScriptProcessor {
  onaudioprocess: ((event: { inputBuffer: { getChannelData: (channel: number) => Float32Array } }) => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();

  constructor() {
    fake.scripts.push(this);
  }
}

class FakeWorkletNode {
  port: { onmessage: ((event: { data: Float32Array }) => void) | null } = { onmessage: null };
  onprocessorerror: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();

  constructor(_audio: unknown, _name: string) {
    fake.worklets.push(this);
  }
}

class FakeAudioContext {
  state = fake.contextState;
  sampleRate = 16_000;
  destination = {};
  audioWorklet = { addModule: fake.addModule };

  constructor() {
    fake.contexts.push(this);
  }

  createMediaStreamSource(_stream: MediaStream) {
    return new FakeSource();
  }

  createGain() {
    return new FakeGain();
  }

  createScriptProcessor(_size: number, _in: number, _out: number) {
    return new FakeScriptProcessor();
  }

  close() {
    return fake.close();
  }

  resume() {
    return fake.resume();
  }
}

function mic() {
  const track = { enabled: true, stop: vi.fn() };
  return {
    track,
    stream: {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream,
  };
}

function fireFrame(node: FakeScriptProcessor, frame: Float32Array) {
  node.onaudioprocess?.({ inputBuffer: { getChannelData: () => frame } });
}

async function liveRec() {
  return import("./liveRec");
}

beforeEach(() => {
  vi.resetModules();
  fake.contexts.splice(0);
  fake.sources.splice(0);
  fake.gains.splice(0);
  fake.scripts.splice(0);
  fake.worklets.splice(0);
  fake.timers.splice(0);
  fake.addModule.mockReset().mockResolvedValue(undefined);
  fake.close.mockReset().mockResolvedValue(undefined);
  fake.resume.mockReset().mockResolvedValue(undefined);
  fake.contextState = "running";
  let nextTimer = 1;
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
  vi.stubGlobal("window", {
    setTimeout: (callback: () => void) => {
      const timer = { id: nextTimer++, callback, cleared: false };
      fake.timers.push(timer);
      return timer.id;
    },
    clearTimeout: (id: number) => {
      const timer = fake.timers.find((candidate) => candidate.id === id);
      if (timer) timer.cleared = true;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("live recording fallback with fabricated media and audio graph APIs", () => {
  it("uses the ScriptProcessor fallback when a fabricated recording worklet cannot load", async () => {
    fake.addModule.mockRejectedValueOnce(new Error("fabricated worklet refusal"));
    const rec = await liveRec();
    const input = mic();
    const sink = vi.fn();
    rec.setRecordingAudioSink(sink);

    await rec.attachMicTap(input.stream);
    expect(fake.worklets).toHaveLength(0);
    expect(fake.scripts).toHaveLength(1);
    fireFrame(fake.scripts[0]!, new Float32Array(4_096).fill(0.25));
    expect(sink).toHaveBeenCalledWith(16_000, expect.any(Float32Array));
    rec.stopMicTap();
  });

  it("rebuilds a processor-error worklet on the ScriptProcessor path using the same fake mic and context", async () => {
    fake.contextState = "suspended";
    const rec = await liveRec();
    const firstMic = mic();
    const sink = vi.fn();
    rec.setRecordingAudioSink(sink);
    await rec.attachMicTap(firstMic.stream);

    expect(fake.resume).toHaveBeenCalledOnce();
    rec.setMicMuted(true);
    expect(firstMic.track.enabled).toBe(false);
    expect(rec.micMuted()).toBe(true);
    rec.setMicMuted(false);
    expect(firstMic.track.enabled).toBe(true);

    expect(fake.contexts).toHaveLength(1);
    expect(fake.worklets).toHaveLength(1);
    expect(fake.sources).toHaveLength(1);
    expect(fake.timers).toHaveLength(1);
    expect(fake.addModule).toHaveBeenCalledWith("/rec-worklet.js");

    const duplicateMic = mic();
    await rec.attachMicTap(duplicateMic.stream);
    expect(duplicateMic.track.stop).toHaveBeenCalledOnce();

    fake.worklets[0]!.onprocessorerror?.();
    expect(fake.timers[0]!.cleared).toBe(true);
    expect(fake.worklets[0]!.disconnect).toHaveBeenCalledOnce();
    expect(fake.sources).toHaveLength(2);
    expect(fake.scripts).toHaveLength(1);
    expect(fake.contexts).toHaveLength(1);

    const frame = new Float32Array(4_096).fill(0.25);
    fireFrame(fake.scripts[0]!, frame);
    expect(sink).toHaveBeenCalledWith(16_000, frame);

    rec.stopMicTap();
    expect(fake.scripts[0]!.onaudioprocess).toBeNull();
    expect(firstMic.track.stop).toHaveBeenCalledOnce();
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("uses the first-frame probe only for a silent worklet and leaves a working fabricated worklet alone", async () => {
    const rec = await liveRec();
    const activeMic = mic();
    rec.setRecordingAudioSink(vi.fn());
    await rec.attachMicTap(activeMic.stream);
    const activeProbe = fake.timers[0]!;
    fake.worklets[0]!.port.onmessage?.({ data: new Float32Array([1]) });
    activeProbe.callback();
    expect(fake.scripts).toHaveLength(0);
    rec.stopMicTap();

    const silentMic = mic();
    rec.setRecordingAudioSink(vi.fn());
    await rec.attachMicTap(silentMic.stream);
    const silentProbe = fake.timers[1]!;
    silentProbe.callback();
    expect(fake.scripts).toHaveLength(1);
    expect(silentProbe.cleared).toBe(false);
    rec.stopMicTap();
    expect(silentMic.track.stop).toHaveBeenCalledOnce();
  });

  it("does not resurrect a tap when its sink was removed or after the singleton was stopped", async () => {
    const rec = await liveRec();
    const openMic = mic();
    rec.setRecordingAudioSink(vi.fn());
    await rec.attachMicTap(openMic.stream);
    const worklet = fake.worklets[0]!;

    rec.setRecordingAudioSink(null);
    worklet.onprocessorerror?.();
    expect(fake.sources).toHaveLength(2);
    expect(fake.scripts).toHaveLength(0);

    rec.stopMicTap();
    const sourcesAfterStop = fake.sources.length;
    worklet.onprocessorerror?.();
    expect(fake.sources).toHaveLength(sourcesAfterStop);
    expect(openMic.track.stop).toHaveBeenCalledOnce();
  });

  it("streams dictation PCM through a fabricated worklet and flushes it before teardown", async () => {
    const rec = await liveRec();
    const input = mic();
    const push = vi.fn(async () => undefined);
    const stop = await rec.createPcmTap(input.stream, push);

    expect(fake.worklets).toHaveLength(1);
    fake.worklets[0]!.port.onmessage?.({ data: new Float32Array(4_000).fill(0.5) });
    await Promise.resolve();
    await Promise.resolve();
    expect(push).toHaveBeenCalledWith(16_000, expect.any(String));

    await stop();
    expect(fake.worklets[0]!.disconnect).toHaveBeenCalledOnce();
    expect(fake.sources[0]!.disconnect).toHaveBeenCalledOnce();
  });

  it("resumes a suspended fabricated context and falls back when its worklet loader rejects", async () => {
    fake.contextState = "suspended";
    fake.addModule.mockRejectedValueOnce(new Error("worklet unavailable"));
    const rec = await liveRec();
    const input = mic();
    const stop = await rec.createPcmTap(input.stream, vi.fn(async () => undefined));

    expect(fake.resume).toHaveBeenCalledOnce();
    expect(fake.scripts).toHaveLength(1);
    await stop();
  });

  it("rebuilds a silent dictation worklet once and ignores its late processor error after teardown", async () => {
    const rec = await liveRec();
    const input = mic();
    const stop = await rec.createPcmTap(input.stream, vi.fn(async () => undefined));
    const worklet = fake.worklets[0]!;

    fake.timers[0]!.callback();
    expect(fake.scripts).toHaveLength(1);
    expect(worklet.disconnect).toHaveBeenCalledOnce();
    await stop();

    const sourcesAfterStop = fake.sources.length;
    worklet.onprocessorerror?.();
    expect(fake.sources).toHaveLength(sourcesAfterStop);
  });
});
