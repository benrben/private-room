import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type FakeSource = {
  buffer: AudioBuffer | null;
  connect: <T>(destination: T) => T;
  onended: (() => void) | null;
  playbackRate: { value: number };
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

type FakeWaveShaper = {
  connect: <T>(destination: T) => T;
  curve: Float32Array | null;
  oversample: OverSampleType;
};

const mocks = vi.hoisted(() => ({
  api: { speakTextNeural: vi.fn() },
  base64ToBytes: vi.fn(),
  buffers: [] as Array<{ data: Float32Array[]; getChannelData: ReturnType<typeof vi.fn> }>,
  contexts: [] as FakeAudioContext[],
  createBuffer: vi.fn(),
  decode: vi.fn(),
  sources: [] as FakeSource[],
  waveShapers: [] as FakeWaveShaper[],
}));

vi.mock("../api", () => ({ api: mocks.api }));
vi.mock("../viewers/util", () => ({ base64ToBytes: mocks.base64ToBytes }));

import {
  ARCHETYPE_DEFAULTS,
  beginTurn,
  cancelAll,
  configure,
  endOfTurn,
  ensureUnlocked,
  feedStreamDelta,
  isSpeaking,
  roundBoundary,
  setTurnAudioDoneListener,
  setVoiceProblemListener,
  speakText,
  turnBelongsTo,
} from "./voice";

function connect<T>(destination: T): T {
  return destination;
}

class FakeAudioContext {
  currentTime = 7;
  decodeAudioData = mocks.decode;
  destination = { connect };
  resume = vi.fn().mockResolvedValue(undefined);
  sampleRate = 10;
  state: AudioContextState = "running";

  constructor() {
    mocks.contexts.push(this);
  }

  createBufferSource(): AudioBufferSourceNode {
    const source: FakeSource = {
      buffer: null,
      connect,
      onended: null,
      playbackRate: { value: 1 },
      start: vi.fn(),
      stop: vi.fn(),
    };
    mocks.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }

  createGain(): GainNode {
    return { connect, gain: { value: 0 } } as unknown as GainNode;
  }

  createBiquadFilter(): BiquadFilterNode {
    return { connect, frequency: { value: 0 }, gain: { value: 0 }, type: "allpass" } as unknown as BiquadFilterNode;
  }

  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer {
    return mocks.createBuffer(channels, length, sampleRate) as AudioBuffer;
  }

  createConvolver(): ConvolverNode {
    return { buffer: null, connect } as unknown as ConvolverNode;
  }

  createWaveShaper(): WaveShaperNode {
    const node: FakeWaveShaper = { connect, curve: null, oversample: "none" };
    mocks.waveShapers.push(node);
    return node as unknown as WaveShaperNode;
  }

  createDelay(): DelayNode {
    return { connect, delayTime: { value: 0 } } as unknown as DelayNode;
  }

  createOscillator(): OscillatorNode {
    return {
      connect,
      frequency: { value: 0 },
      start: vi.fn(),
      stop: vi.fn(),
    } as unknown as OscillatorNode;
  }
}

const originalAudioContext = Reflect.get(globalThis, "AudioContext");
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

async function flush(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

function activeContext(): FakeAudioContext {
  const context = mocks.contexts[0];
  if (!context) throw new Error("fake audio context missing");
  return context;
}

function resetVoice(): void {
  cancelAll();
  configure({
    archetype: "off",
    autoSpeak: false,
    neuralVoiceId: null,
    params: { ...ARCHETYPE_DEFAULTS.off },
  });
  setVoiceProblemListener(null);
  setTurnAudioDoneListener(null);
}

beforeAll(() => {
  Reflect.set(globalThis, "AudioContext", FakeAudioContext);
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { onLine: true },
  });
});

beforeEach(() => {
  resetVoice();
  mocks.api.speakTextNeural.mockReset().mockResolvedValue("fake-audio");
  mocks.base64ToBytes.mockReset().mockReturnValue(new Uint8Array([1, 2]));
  mocks.buffers.length = 0;
  mocks.createBuffer.mockReset().mockImplementation((channels: number, length: number) => {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    const buffer = {
      data,
      getChannelData: vi.fn((channel: number) => data[channel]),
    };
    mocks.buffers.push(buffer);
    return buffer;
  });
  mocks.decode.mockReset().mockResolvedValue({ duration: 0.5 });
  mocks.sources.length = 0;
  mocks.waveShapers.length = 0;
  if (mocks.contexts[0]) activeContext().state = "running";
});

afterEach(() => {
  setTurnAudioDoneListener(null);
  (navigator as { onLine: boolean }).onLine = true;
  resetVoice();
});

afterAll(() => {
  if (originalAudioContext === undefined) Reflect.deleteProperty(globalThis, "AudioContext");
  else Reflect.set(globalThis, "AudioContext", originalAudioContext);
  if (originalNavigatorDescriptor) Object.defineProperty(globalThis, "navigator", originalNavigatorDescriptor);
  else Reflect.deleteProperty(globalThis, "navigator");
});

describe("voice scheduling with fabricated synthesis and Web Audio", () => {
  it("keeps stream ownership with the originating chat and ignores an end without a live turn", () => {
    expect(() => endOfTurn("No fabricated turn owns this answer.")).not.toThrow();
    beginTurn("chat-owner");
    expect(turnBelongsTo("chat-owner")).toBe(true);
    expect(turnBelongsTo("other-chat")).toBe(false);
    beginTurn(null);
    expect(turnBelongsTo("any-chat")).toBe(true);
  });

  it("notifies hands-free when an auto-silent fabricated turn closes", () => {
    const done = vi.fn();
    setTurnAudioDoneListener(done);
    beginTurn("chat-1");
    endOfTurn("A persisted fabricated answer remains on screen.");
    expect(done).toHaveBeenCalledOnce();
  });

  it("drops an obsolete streamed round and starts the replacement round fresh", async () => {
    ensureUnlocked();
    configure({ autoSpeak: true });
    beginTurn("chat-1");
    feedStreamDelta("The discarded fabricated round has enough text to enter speech output.");
    await flush();
    expect(mocks.api.speakTextNeural).toHaveBeenCalledOnce();
    expect(mocks.sources[0]?.stop).not.toHaveBeenCalled();

    roundBoundary();
    expect(mocks.sources[0]?.stop).toHaveBeenCalledOnce();
    feedStreamDelta("The replacement fabricated round begins its own speech output.");
    await flush();

    expect(mocks.api.speakTextNeural).toHaveBeenCalledTimes(2);
    expect(mocks.api.speakTextNeural).toHaveBeenLastCalledWith(
      "The replacement fabricated round begins its own speech output.",
      null,
    );
  });

  it("feeds only a live auto-speak turn and drops deltas before a turn or after cancellation", async () => {
    ensureUnlocked();

    feedStreamDelta("This ignored sentence arrives before a fabricated turn begins.");
    expect(mocks.api.speakTextNeural).not.toHaveBeenCalled();

    configure({ autoSpeak: true });
    feedStreamDelta("This ignored sentence arrives before the fabricated turn begins.");
    expect(mocks.api.speakTextNeural).not.toHaveBeenCalled();

    beginTurn("chat-1");
    feedStreamDelta("This fabricated streamed sentence is long enough to enter the speech queue.");
    await flush();
    expect(mocks.api.speakTextNeural).toHaveBeenCalledWith(
      "This fabricated streamed sentence is long enough to enter the speech queue.",
      null,
    );

    cancelAll();
    feedStreamDelta("This fabricated late sentence must stay silent after cancellation.");
    await flush();
    expect(mocks.api.speakTextNeural).toHaveBeenCalledOnce();
  });

  it("synthesizes, decodes, and schedules one manual sentence without an audio device", async () => {
    const state = vi.fn();
    ensureUnlocked();

    speakText("A fabricated sentence follows the same scheduling path as a real answer.", { onState: state });
    await flush();

    expect(mocks.api.speakTextNeural).toHaveBeenCalledWith(
      "A fabricated sentence follows the same scheduling path as a real answer.",
      null,
    );
    expect(mocks.base64ToBytes).toHaveBeenCalledWith("fake-audio");
    expect(mocks.decode).toHaveBeenCalledOnce();
    expect(mocks.sources).toHaveLength(1);
    expect(mocks.sources[0]?.start).toHaveBeenCalledWith(7.02);
    expect(isSpeaking()).toBe(true);

    mocks.sources[0]?.onended?.();
    expect(isSpeaking()).toBe(false);
    expect(state).toHaveBeenNthCalledWith(1, true);
    expect(state).toHaveBeenLastCalledWith(false);
  });

  it("clears a manual playback observer when cancellation stops the fabricated source", async () => {
    const state = vi.fn();
    ensureUnlocked();
    speakText("A fabricated manual sentence is cancelled while it is playing.", { onState: state });
    await flush();
    expect(state).toHaveBeenCalledWith(true);

    cancelAll();
    expect(state).toHaveBeenLastCalledWith(false);
    expect(mocks.sources[0]?.stop).toHaveBeenCalledOnce();
  });

  it("uses configured archetype parameters when a manual call overrides only its voice id", async () => {
    configure({ archetype: "off", neuralVoiceId: "configured", params: { ...ARCHETYPE_DEFAULTS.off } });
    ensureUnlocked();
    speakText("A fabricated manual preview chooses a one-off roster voice.", {
      neuralVoiceId: "one-off",
    });
    await flush();
    expect(mocks.api.speakTextNeural).toHaveBeenCalledWith(
      "A fabricated manual preview chooses a one-off roster voice.",
      "one-off",
    );
  });

  it("drops a synthesis result that arrives after cancellation", async () => {
    let resolve: (audio: string) => void = () => {};
    mocks.api.speakTextNeural.mockImplementationOnce(() => new Promise<string>((done) => {
      resolve = done;
    }));
    ensureUnlocked();

    speakText("This late fabricated result must never be decoded or scheduled.");
    await flush();
    cancelAll();
    resolve("late-audio");
    await flush();

    expect(mocks.decode).not.toHaveBeenCalled();
    expect(mocks.sources).toHaveLength(0);
    expect(isSpeaking()).toBe(false);
  });

  it("reports a single synthesis failure and skips its sentence", async () => {
    const problem = vi.fn();
    mocks.api.speakTextNeural.mockRejectedValueOnce(new Error("fake sidecar unavailable"));
    setVoiceProblemListener(problem);
    ensureUnlocked();

    speakText("A failed fabricated synthesis request still leaves the answer on screen.");
    await flush();

    expect(problem).toHaveBeenCalledWith(expect.stringContaining("voice service didn't answer"));
    expect(mocks.decode).not.toHaveBeenCalled();
    expect(mocks.sources).toHaveLength(0);
  });

  it("distinguishes an offline room policy and an offline Mac from a service failure", async () => {
    const policyProblem = vi.fn();
    mocks.api.speakTextNeural.mockRejectedValueOnce(new Error("Online features are disabled"));
    setVoiceProblemListener(policyProblem);
    ensureUnlocked();
    speakText("A fabricated room policy blocks this online voice request.");
    await flush();
    expect(policyProblem).toHaveBeenCalledWith(expect.stringContaining("internet switch is off"));

    const networkProblem = vi.fn();
    mocks.api.speakTextNeural.mockRejectedValueOnce(new Error("fabricated network failure"));
    setVoiceProblemListener(networkProblem);
    (navigator as { onLine: boolean }).onLine = false;
    speakText("A fabricated offline Mac cannot reach the voice service.");
    await flush();
    expect(networkProblem).toHaveBeenCalledWith(expect.stringContaining("internet connection"));
  });

  it("drops an unfinished fenced block instead of reading its contents aloud", async () => {
    configure({ autoSpeak: true });
    ensureUnlocked();
    beginTurn("chat-fence");
    feedStreamDelta("```json\n{\"secret\":\"fabricated\"}");
    endOfTurn();
    await flush();
    expect(mocks.api.speakTextNeural).not.toHaveBeenCalled();
  });

  it("reports a locked fabricated context without attempting decode", async () => {
    const problem = vi.fn();
    ensureUnlocked();
    activeContext().state = "suspended";
    setVoiceProblemListener(problem);

    speakText("A suspended fabricated context must not schedule audio.");
    await flush();

    expect(problem).toHaveBeenCalledWith(expect.stringContaining("only starts audio from a click"));
    expect(mocks.decode).not.toHaveBeenCalled();
    expect(mocks.sources).toHaveLength(0);
  });

  it("reports unreadable fabricated audio and leaves no scheduled source", async () => {
    const problem = vi.fn();
    mocks.decode.mockRejectedValueOnce(new Error("fake decoder rejected bytes"));
    setVoiceProblemListener(problem);
    ensureUnlocked();

    speakText("A decode failure must be visible instead of producing silent playback.");
    await flush();

    expect(problem).toHaveBeenCalledWith(expect.stringContaining("audio came back unreadable"));
    expect(mocks.sources).toHaveLength(0);
  });

  it("does not schedule when cancellation wins while fabricated decode is pending", async () => {
    let resolve: (buffer: AudioBuffer) => void = () => {};
    mocks.decode.mockImplementationOnce(() => new Promise<AudioBuffer>((done) => {
      resolve = done;
    }));
    ensureUnlocked();

    speakText("This fabricated decode is cancelled before it becomes an audio source.");
    await flush();
    expect(mocks.decode).toHaveBeenCalledOnce();
    cancelAll();
    resolve({ duration: 0.5 } as AudioBuffer);
    await flush();

    expect(mocks.sources).toHaveLength(0);
    expect(isSpeaking()).toBe(false);
  });

  it("builds and reuses one deterministic fabricated reverb impulse for matching ghost speech", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.75);
    configure({ archetype: "ghost", params: { ...ARCHETYPE_DEFAULTS.ghost } });
    ensureUnlocked();

    speakText("This first fabricated ghost sentence is long enough to enter the voice scheduling pipeline.");
    await flush();
    speakText("This second fabricated ghost sentence must reuse the already-built impulse response.");
    await flush();

    expect(mocks.createBuffer).toHaveBeenCalledWith(2, 40, 10);
    expect(mocks.createBuffer).toHaveBeenCalledOnce();
    expect(mocks.buffers[0]?.getChannelData).toHaveBeenNthCalledWith(1, 0);
    expect(mocks.buffers[0]?.getChannelData).toHaveBeenNthCalledWith(2, 1);
    expect(mocks.buffers[0]?.data[0]?.[0]).toBe(0.5);
    expect(mocks.buffers[0]?.data[1]?.[39]).toBeCloseTo(0.0003125);
    random.mockRestore();
  });

  it("builds the fabricated ancient three-voice tail through a shaped waveform", async () => {
    configure({ archetype: "ancient", params: { ...ARCHETYPE_DEFAULTS.ancient } });
    ensureUnlocked();

    speakText("This fabricated ancient sentence exercises the three-voice tail without an audio device.");
    await flush();

    expect(mocks.sources).toHaveLength(3);
    expect(mocks.sources.map((source) => source.playbackRate.value)).toEqual([1, 0.94, 1.06]);
    const starts = mocks.sources.map((source) => source.start.mock.calls[0]?.[0]);
    expect(starts[0]).toBeCloseTo(7.02);
    expect(starts[1]).toBeCloseTo(7.04);
    expect(starts[2]).toBeCloseTo(7.055);
    const waveShaper = mocks.waveShapers[0];
    if (!waveShaper?.curve) throw new Error("fabricated wave shaper missing curve");
    expect(waveShaper.oversample).toBe("4x");
    expect(waveShaper.curve).toHaveLength(1024);
    expect(waveShaper.curve[0]).toBeCloseTo(Math.tanh(-1.52));
    expect(waveShaper.curve[1023]).toBeCloseTo(Math.tanh(1.52));
  });

  it.each([
    ["demon", 2],
    ["wraith", 1],
  ] as const)("builds the fabricated %s archetype graph", async (archetype, sourceCount) => {
    configure({ archetype, params: { ...ARCHETYPE_DEFAULTS[archetype] } });
    ensureUnlocked();
    speakText(`This fabricated ${archetype} sentence exercises its complete audio graph.`);
    await flush();
    expect(mocks.sources).toHaveLength(sourceCount);
    expect(mocks.sources.every((source) => source.start.mock.calls.length === 1)).toBe(true);
  });

  it("tolerates an already-stopped fabricated source during cancellation", async () => {
    ensureUnlocked();
    speakText("This fabricated source reports that it was already stopped.");
    await flush();
    mocks.sources[0]?.stop.mockImplementationOnce(() => {
      throw new Error("already stopped");
    });
    expect(() => cancelAll()).not.toThrow();
    expect(isSpeaking()).toBe(false);
  });

  it("bypasses the fabricated wave shaper when custom distortion is disabled", async () => {
    configure({ archetype: "custom", params: { distortion: 0, reverb: 0 } });
    ensureUnlocked();

    speakText("This fabricated clean custom sentence keeps its graph free of distortion.");
    await flush();

    expect(mocks.sources).toHaveLength(1);
    expect(mocks.waveShapers).toEqual([]);
  });
});
