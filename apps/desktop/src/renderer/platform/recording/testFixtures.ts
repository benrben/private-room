/**
 * Shared fakes for `audioGraphTap.test.ts` / `micTap.test.ts` /
 * `loopbackTap.test.ts` — one hand-written double per "Like" interface in
 * `audioGraphTap.ts`, small enough to construct directly (the whole point of
 * that file's custom interfaces over the real, ~30-method `AudioContext` — see
 * its module doc). Not itself a `*.test.ts` file, so `vitest.config.ts`'s
 * `include` glob (`electron/**\/*.test.ts`) never picks it up as a suite of its
 * own; it exists purely to be imported by ones that do.
 */

import type {
  AudioContextLike,
  AudioNodeLike,
  AudioTrackLike,
  AudioWorkletNodeLike,
  GainNodeLike,
  MediaStreamLike,
  ScriptProcessorNodeLike,
} from "./audioGraphTap.js";

/**
 * NOTE ON COMPOSITION: every wrapper below forwards to `base.connect`/
 * `base.disconnect`/`base.connected`/`base.disconnectCalls` EXPLICITLY
 * (`connect: base.connect`, `get disconnectCalls() { return
 * base.disconnectCalls; }`) rather than `{...base, …}`. Object spread evaluates
 * each property ONCE at spread time and copies the resulting VALUE — a numeric
 * field like `disconnectCalls` would freeze at whatever it read as (0), while
 * `base`'s own closures kept mutating the ORIGINAL object a test can no longer
 * see. Forwarding via a getter reads `base`'s CURRENT value on every access.
 */
export function fakeNode(): AudioNodeLike & { connected: AudioNodeLike[]; disconnectCalls: number } {
  const node = {
    connected: [] as AudioNodeLike[],
    disconnectCalls: 0,
    connect(dest: AudioNodeLike) {
      node.connected.push(dest);
    },
    disconnect() {
      node.disconnectCalls++;
    },
  };
  return node;
}

export function fakeGainNode(): GainNodeLike & { connected: AudioNodeLike[]; disconnectCalls: number } {
  const base = fakeNode();
  return {
    connect: base.connect,
    disconnect: base.disconnect,
    get connected() {
      return base.connected;
    },
    get disconnectCalls() {
      return base.disconnectCalls;
    },
    gain: { value: 1 },
  };
}

/** A fake `ScriptProcessorNode` whose `onaudioprocess` setter is captured so a
 * test can feed it quanta directly via {@link emitProcess}. */
export function fakeScriptProcessorNode(): ScriptProcessorNodeLike & {
  connected: AudioNodeLike[];
  disconnectCalls: number;
  emitProcess(channelData: Float32Array): void;
} {
  const base = fakeNode();
  let handler: ScriptProcessorNodeLike["onaudioprocess"] = null;
  return {
    connect: base.connect,
    disconnect: base.disconnect,
    get connected() {
      return base.connected;
    },
    get disconnectCalls() {
      return base.disconnectCalls;
    },
    get onaudioprocess() {
      return handler;
    },
    set onaudioprocess(fn) {
      handler = fn;
    },
    emitProcess(channelData: Float32Array) {
      handler?.({ inputBuffer: { getChannelData: () => channelData } });
    },
  };
}

/** A fake `AudioWorkletNode` whose `port.onmessage`/`onprocessorerror` setters
 * are captured so a test can feed it frames ({@link emitMessage}) or simulate a
 * processor crash ({@link emitProcessorError}). */
export function fakeWorkletNode(): AudioWorkletNodeLike & {
  connected: AudioNodeLike[];
  disconnectCalls: number;
  emitMessage(data: Float32Array): void;
  emitProcessorError(): void;
} {
  const base = fakeNode();
  let onMessage: AudioWorkletNodeLike["port"]["onmessage"] = null;
  let onError: (() => void) | null = null;
  return {
    connect: base.connect,
    disconnect: base.disconnect,
    get connected() {
      return base.connected;
    },
    get disconnectCalls() {
      return base.disconnectCalls;
    },
    port: {
      get onmessage() {
        return onMessage;
      },
      set onmessage(fn) {
        onMessage = fn;
      },
    },
    get onprocessorerror() {
      return onError;
    },
    set onprocessorerror(fn) {
      onError = fn;
    },
    emitMessage(data: Float32Array) {
      onMessage?.({ data });
    },
    emitProcessorError() {
      onError?.();
    },
  };
}

export interface FakeAudioContextOptions {
  sampleRate?: number;
  state?: "suspended" | "running" | "closed";
  /** `null` (default): `addWorkletModule` resolves. A string: it rejects with
   * `new Error(that string)`, simulating a CSP refusal / 404. */
  workletModuleFailure?: string | null;
}

export interface FakeAudioContext extends AudioContextLike {
  resumeCalls: number;
  closeCalls: number;
  addWorkletModuleCalls: string[];
  scriptProcessorNodes: ReturnType<typeof fakeScriptProcessorNode>[];
  workletNodes: ReturnType<typeof fakeWorkletNode>[];
  mediaStreamSources: MediaStreamLike[];
}

export function fakeAudioContext(opts: FakeAudioContextOptions = {}): FakeAudioContext {
  let state = opts.state ?? "running";
  const sampleRate = opts.sampleRate ?? 16000;
  const ctx: FakeAudioContext = {
    resumeCalls: 0,
    closeCalls: 0,
    addWorkletModuleCalls: [],
    scriptProcessorNodes: [],
    workletNodes: [],
    mediaStreamSources: [],
    get state() {
      return state;
    },
    get sampleRate() {
      return sampleRate;
    },
    destination: fakeNode(),
    resume: async () => {
      ctx.resumeCalls++;
      state = "running";
    },
    close: async () => {
      ctx.closeCalls++;
      state = "closed";
    },
    addWorkletModule: async (url: string) => {
      ctx.addWorkletModuleCalls.push(url);
      if (opts.workletModuleFailure != null) {
        throw new Error(opts.workletModuleFailure);
      }
    },
    createMediaStreamSource: (stream: MediaStreamLike) => {
      ctx.mediaStreamSources.push(stream);
      return fakeNode();
    },
    createGain: () => fakeGainNode(),
    createScriptProcessor: () => {
      const node = fakeScriptProcessorNode();
      ctx.scriptProcessorNodes.push(node);
      return node;
    },
    createWorkletNode: (_name: string) => {
      const node = fakeWorkletNode();
      ctx.workletNodes.push(node);
      return node;
    },
  };
  return ctx;
}

export function fakeAudioTrack(): AudioTrackLike & { stopCalls: number; endedListeners: (() => void)[] } {
  const listeners: (() => void)[] = [];
  const track = {
    enabled: true,
    stopCalls: 0,
    endedListeners: listeners,
    stop() {
      track.stopCalls++;
    },
    addEventListener(type: "ended", listener: () => void) {
      if (type === "ended") listeners.push(listener);
    },
    removeEventListener(type: "ended", listener: () => void) {
      if (type === "ended") {
        const at = listeners.indexOf(listener);
        if (at !== -1) listeners.splice(at, 1);
      }
    },
  };
  return track;
}

export function fakeMediaStream(
  opts: {
    audioTracks?: ReturnType<typeof fakeAudioTrack>[];
    videoTracks?: ReturnType<typeof fakeAudioTrack>[];
  } = {}
): MediaStreamLike {
  const audioTracks = opts.audioTracks ?? [fakeAudioTrack()];
  const videoTracks = opts.videoTracks ?? [];
  return {
    getAudioTracks: () => audioTracks,
    getVideoTracks: () => videoTracks,
    getTracks: () => [...audioTracks, ...videoTracks],
  };
}
