/**
 * Shared Web-Audio tap-building primitive for BOTH lanes of ADD-27's live
 * recording — the mic lane (`micTap.ts`) and the system-loopback lane
 * (`loopbackTap.ts`). This is the worklet-then-ScriptProcessor ladder
 * `src/workspace/liveRec.ts`'s `createPcmTap`/`buildMicTap`/`rebuildOnFallback`
 * already proved correct in production, generalized so ONE implementation
 * serves both lanes (that file split the same logic across two near-duplicate
 * copies — the module-singleton recording tap and the dictation tap — because
 * dictation had to survive outside a recording's lifetime; here neither lane
 * is a module singleton, so there is no reason left to duplicate it).
 *
 * ============================================================================
 * WHY THESE ARE HAND-WRITTEN "Like" INTERFACES, NOT THE REAL LIB.DOM TYPES
 * ============================================================================
 * `src/renderer/platform/recording/tsconfig.json` (a sibling of this file) DOES carry the
 * "DOM" lib, unlike the rest of this project — so `MediaStream`/`AudioContext`/
 * `AudioWorkletNode` are all real, resolvable types here, and this module's
 * production bridge ({@link adaptAudioContext}) uses them directly.
 *
 * But the ladder itself — {@link openPcmTap} — is exercised by `vitest` under
 * `environment: "node"` (this project's `vitest.config.ts`, unchanged), where
 * there is no real `AudioContext`/`MediaStream` to construct even though the
 * TYPES resolve. A fake satisfying the FULL real `AudioContext` interface (~30
 * factory methods) is impractical to hand-write, and browser interfaces don't
 * have this codebase's `Pick<IpcMain, "handle">` escape hatch either:
 * `AudioContext` has no `createWorkletNode` factory at all — worklets are built
 * via `new AudioWorkletNode(ctx, name)` — so no `Pick<>` of the real type could
 * ever cover it. `openPcmTap` is typed against the small custom interfaces
 * below instead; {@link adaptAudioContext} bridges a real context onto them in
 * the one place a real production caller needs it.
 */

export interface AudioTrackLike {
  enabled: boolean;
  stop(): void;
  addEventListener(type: "ended", listener: () => void): void;
  removeEventListener(type: "ended", listener: () => void): void;
}

export interface MediaStreamLike {
  getAudioTracks(): AudioTrackLike[];
  getVideoTracks(): AudioTrackLike[];
  getTracks(): AudioTrackLike[];
}

export interface AudioNodeLike {
  connect(dest: AudioNodeLike): void;
  disconnect(): void;
}

export interface GainNodeLike extends AudioNodeLike {
  gain: { value: number };
}

export interface AudioWorkletNodeLike extends AudioNodeLike {
  readonly port: { onmessage: ((ev: { data: Float32Array }) => void) | null };
  onprocessorerror: (() => void) | null;
}

export interface ScriptProcessorNodeLike extends AudioNodeLike {
  onaudioprocess: ((ev: { inputBuffer: { getChannelData(channel: number): Float32Array } }) => void) | null;
}

export type MediaStreamAudioSourceNodeLike = AudioNodeLike;

export interface AudioContextLike {
  readonly state: "suspended" | "running" | "closed";
  readonly sampleRate: number;
  readonly destination: AudioNodeLike;
  resume(): Promise<void>;
  close(): Promise<void>;
  /** Same contract as the real `BaseAudioContext.audioWorklet.addModule` —
   * rejects if the module can't be fetched/registered (a CSP refusal, a 404).
   * {@link openPcmTap} falls back to `createScriptProcessor` on that rejection,
   * matching `liveRec.ts`'s own worklet-then-fallback doctrine. */
  addWorkletModule(url: string): Promise<void>;
  createMediaStreamSource(stream: MediaStreamLike): MediaStreamAudioSourceNodeLike;
  createGain(): GainNodeLike;
  createScriptProcessor(
    bufferSize: number,
    numberOfInputChannels: number,
    numberOfOutputChannels: number
  ): ScriptProcessorNodeLike;
  /** THE one member with no real `AudioContext` equivalent — see the module
   * doc. A real caller gets this from {@link adaptAudioContext}, which closes
   * over `new AudioWorkletNode(ctx, name)`. */
  createWorkletNode(name: string): AudioWorkletNodeLike;
}

/** Same-origin asset, never a `blob:` URL — matches `liveRec.ts`'s own
 * comment: the app's CSP allows `script-src 'self'` only, and an
 * `AudioWorkletModule` is fetched as a script. */
export const REC_WORKLET_URL = "/rec-worklet.js";

/** `registerProcessor`'s own name inside `rec-worklet.js` — must match, or
 * `createWorkletNode` builds a node for a processor that was never
 * registered. */
const WORKLET_PROCESSOR_NAME = "pr-rec-tap";

/** ScriptProcessor fallback size: ~85 ms at 48 kHz — `liveRec.ts`'s own
 * constant, unchanged. */
const FALLBACK_BUFFER = 4096;

/** How long {@link openPcmTap} waits for a first quantum before concluding the
 * worklet loaded but is silently producing nothing (seen with throttled
 * WebViews) and rebuilding on the ScriptProcessor fallback. Overridable only
 * for tests — `liveRec.ts`'s own value in production. */
export const FIRST_FRAME_TIMEOUT_MS = 2000;

/** Batch raw quanta into ~250 ms frames before handing them to `onFrame` —
 * `liveRec.ts`'s own cadence (`Math.round(rate / 4)`), which is also the
 * cadence `session_ws.py` §2 documents the client as sending at. Unlike
 * `liveRec.ts`'s `makeSink`, this doesn't base64-encode or await an async
 * push: the wire encoding is `recSessionClient.ts`'s job now, and a
 * `WebSocket.send` queues synchronously, so there is nothing left to chain a
 * promise over. */
function makeBatcher(
  rate: number,
  onFrame: (rate: number, frame: Float32Array) => void
): { push: (frame: Float32Array) => void; flush: () => void } {
  let pending: Float32Array[] = [];
  let pendingLen = 0;
  const batchSize = Math.max(1, Math.round(rate / 4));
  const send = (): void => {
    if (pendingLen === 0) return;
    const all = new Float32Array(pendingLen);
    let at = 0;
    for (const chunk of pending) {
      all.set(chunk, at);
      at += chunk.length;
    }
    pending = [];
    pendingLen = 0;
    onFrame(rate, all);
  };
  return {
    push: (frame) => {
      pending.push(frame);
      pendingLen += frame.length;
      if (pendingLen >= batchSize) send();
    },
    flush: send,
  };
}

/** Preferred path: an AudioWorklet, which taps the stream off the audio
 * thread. `onDead` fires if the worklet dies AFTER loading (a processor
 * exception) — frames then stop silently, which is why {@link openPcmTap} also
 * runs the first-frame probe rather than trusting a successful `addModule`
 * alone. */
async function workletTap(
  audio: AudioContextLike,
  workletUrl: string,
  source: MediaStreamAudioSourceNodeLike,
  sink: (frame: Float32Array) => void,
  onDead: () => void
): Promise<() => void> {
  await audio.addWorkletModule(workletUrl);
  const node = audio.createWorkletNode(WORKLET_PROCESSOR_NAME);
  node.port.onmessage = (e) => sink(e.data);
  node.onprocessorerror = onDead;
  source.connect(node);
  // A worklet only runs while the graph reaches the destination; a muted gain
  // keeps it silent so the tap is never played back at the user.
  const mute = audio.createGain();
  mute.gain.value = 0;
  node.connect(mute);
  mute.connect(audio.destination);
  return () => {
    node.port.onmessage = null;
    node.onprocessorerror = null;
    node.disconnect();
    mute.disconnect();
  };
}

/** Fallback for any renderer that refuses the worklet module. Deprecated API,
 * but it needs no module fetch at all — the tap must never be lost to a
 * script-loading policy. */
function scriptProcessorTap(
  audio: AudioContextLike,
  source: MediaStreamAudioSourceNodeLike,
  sink: (frame: Float32Array) => void
): () => void {
  const node = audio.createScriptProcessor(FALLBACK_BUFFER, 1, 1);
  node.onaudioprocess = (e) => sink(new Float32Array(e.inputBuffer.getChannelData(0)));
  source.connect(node);
  const mute = audio.createGain();
  mute.gain.value = 0;
  node.connect(mute);
  mute.connect(audio.destination);
  return () => {
    node.onaudioprocess = null;
    node.disconnect();
    mute.disconnect();
  };
}

export interface PcmTapDeps {
  audioContext: AudioContextLike;
  workletUrl?: string;
  /** Test-only override of {@link FIRST_FRAME_TIMEOUT_MS}. */
  firstFrameTimeoutMs?: number;
}

/**
 * Build a self-contained PCM tap on an already-open stream: worklet-first,
 * ScriptProcessor-fallback, with a first-frame probe that rebuilds on the
 * fallback if the worklet loaded but never produced a quantum. Resolves once
 * the tap is attached (not once audio has flowed); returns a synchronous
 * teardown that flushes whatever batch is still pending.
 *
 * `onFrame` receives raw ~250 ms batches, not base64: encoding the wire frame
 * is `recSessionClient.ts`'s job.
 *
 * ONE BATCHER FOR THE WHOLE TAP'S LIFETIME, including across a worklet→
 * fallback rebuild — a deliberate simplification versus `liveRec.ts`'s
 * `rebuildOnFallback`, which had to flush the OLD sink and build a brand new
 * one because it lived in a different top-level function with no shared
 * closure to reuse. Here the whole ladder runs inside one `openPcmTap` call,
 * so the same batcher keeps accumulating across the rebuild — no risk of
 * losing whatever was pending in the old sink, and no redundant
 * flush-then-recreate.
 */
export async function openPcmTap(
  deps: PcmTapDeps,
  stream: MediaStreamLike,
  onFrame: (rate: number, frame: Float32Array) => void
): Promise<() => void> {
  const audio = deps.audioContext;
  const workletUrl = deps.workletUrl ?? REC_WORKLET_URL;
  const firstFrameTimeoutMs = deps.firstFrameTimeoutMs ?? FIRST_FRAME_TIMEOUT_MS;

  if (audio.state === "suspended") {
    await audio.resume().catch(() => {});
  }

  const batcher = makeBatcher(audio.sampleRate, onFrame);
  let gotFrame = false;
  let dead = false;
  let source = audio.createMediaStreamSource(stream);
  let stop: (() => void) | null = null;
  let firstFrameTimer: ReturnType<typeof setTimeout> | null = null;

  const frame = (f: Float32Array): void => {
    gotFrame = true;
    batcher.push(f);
  };

  const clearFirstFrameProbe = (): void => {
    if (firstFrameTimer !== null) {
      clearTimeout(firstFrameTimer);
      firstFrameTimer = null;
    }
  };

  // Worklet died after load, or never produced a first quantum: rebuild on the
  // deprecated-but-sturdy fallback, reusing the same stream/context/batcher
  // (see this function's doc on why sharing the batcher is safe).
  const useFallback = (): void => {
    if (dead) return;
    clearFirstFrameProbe();
    stop?.();
    source.disconnect();
    source = audio.createMediaStreamSource(stream);
    stop = scriptProcessorTap(audio, source, frame);
  };

  try {
    stop = await workletTap(audio, workletUrl, source, frame, useFallback);
  } catch {
    stop = scriptProcessorTap(audio, source, frame);
  }

  firstFrameTimer = setTimeout(() => {
    firstFrameTimer = null;
    if (!gotFrame) useFallback();
  }, firstFrameTimeoutMs);

  return (): void => {
    dead = true;
    clearFirstFrameProbe();
    stop?.();
    source.disconnect();
    batcher.flush();
  };
}

// =============================================================================
// ---- the bridge from a REAL AudioContext onto the Like interfaces ----------
// =============================================================================

/**
 * A {@link AudioNodeLike} produced by {@link adaptAudioContext}, carrying the
 * real Web Audio node it delegates to.
 *
 * THIS IS LOAD-BEARING, not bookkeeping. `AudioNode.connect()` refuses
 * anything that is not itself a real `AudioNode` (`TypeError: parameter 1 is
 * not of type 'AudioNode'`), so a wrapper handed straight to a real node's
 * `connect` throws at runtime — in a graph that typechecks perfectly, and only
 * on the production path, where no `vitest` fake ever reaches. Every wrapper
 * below therefore exposes its real node and unwraps its destination.
 */
interface RealBackedNode {
  readonly realNode: AudioNode;
}

function realNodeOf(node: AudioNodeLike): AudioNode {
  const real = (node as Partial<RealBackedNode>).realNode;
  // `adaptAudioContext` is the only producer of real-backed nodes and its graph
  // never mixes them with fakes, so the fallback is only ever taken in a test.
  return real ?? (node as unknown as AudioNode);
}

function wrapNode(node: AudioNode): AudioNodeLike & RealBackedNode {
  return {
    realNode: node,
    connect: (dest) => void node.connect(realNodeOf(dest)),
    disconnect: () => node.disconnect(),
  };
}

/**
 * `ScriptProcessorNode.onaudioprocess`/`AudioWorkletNode.port.onmessage`/
 * `AudioWorkletNode.onprocessorerror` are FIELD-typed callbacks (not methods),
 * so TS checks their assignability contravariantly on the parameter — a real
 * `(ev: AudioProcessingEvent) => any` is NOT directly assignable to our
 * `(ev: {inputBuffer: {getChannelData}}) => void` field type even though every
 * real event trivially satisfies the narrower shape when actually CALLED with
 * one. These two wrappers own that one real handler each, forwarding through a
 * closure-held reference our narrower setter can update — the real node only
 * ever receives ONE handler, wired once, that calls whatever the Like
 * interface's current handler is.
 */
function wrapScriptProcessor(node: ScriptProcessorNode): ScriptProcessorNodeLike & RealBackedNode {
  let handler: ScriptProcessorNodeLike["onaudioprocess"] = null;
  node.onaudioprocess = (ev) => handler?.(ev);
  const base = wrapNode(node);
  return {
    realNode: base.realNode,
    connect: base.connect,
    disconnect: base.disconnect,
    get onaudioprocess() {
      return handler;
    },
    set onaudioprocess(fn) {
      handler = fn;
    },
  };
}

function wrapWorkletNode(node: AudioWorkletNode): AudioWorkletNodeLike & RealBackedNode {
  let onMessage: AudioWorkletNodeLike["port"]["onmessage"] = null;
  let onError: (() => void) | null = null;
  node.port.onmessage = (ev) => onMessage?.(ev as unknown as { data: Float32Array });
  node.onprocessorerror = () => onError?.();
  const base = wrapNode(node);
  return {
    realNode: base.realNode,
    connect: base.connect,
    disconnect: base.disconnect,
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
  };
}

function wrapGain(node: GainNode): GainNodeLike & RealBackedNode {
  const base = wrapNode(node);
  return { realNode: base.realNode, connect: base.connect, disconnect: base.disconnect, gain: node.gain };
}

/**
 * Bridge a REAL `AudioContext` into {@link AudioContextLike} — the one place
 * this migration's renderer code touches the actual Web Audio globals for the
 * audio-graph side (mic/loopback acquisition have their own seams in
 * `micTap.ts`/`loopbackTap.ts`). `createWorkletNode` is the one member with no
 * real `AudioContext` equivalent at all: `new AudioWorkletNode(ctx, name)` is
 * the real construction path, there being no factory method to delegate to.
 *
 * Every node this returns is wrapped rather than passed through raw, INCLUDING
 * the ones (`destination`, a gain, a media-stream source) whose real type would
 * satisfy {@link AudioNodeLike} structurally on its own — see
 * {@link RealBackedNode} for why a half-wrapped graph throws on `connect`.
 */
export function adaptAudioContext(ctx: AudioContext): AudioContextLike {
  return {
    get state() {
      return ctx.state;
    },
    get sampleRate() {
      return ctx.sampleRate;
    },
    get destination() {
      return wrapNode(ctx.destination);
    },
    resume: () => ctx.resume(),
    close: () => ctx.close(),
    addWorkletModule: (url) => ctx.audioWorklet.addModule(url),
    createMediaStreamSource: (stream) => wrapNode(ctx.createMediaStreamSource(stream as unknown as MediaStream)),
    createGain: () => wrapGain(ctx.createGain()),
    createScriptProcessor: (bufferSize, numIn, numOut) =>
      wrapScriptProcessor(ctx.createScriptProcessor(bufferSize, numIn, numOut)),
    createWorkletNode: (name) => wrapWorkletNode(new AudioWorkletNode(ctx, name)),
  };
}
