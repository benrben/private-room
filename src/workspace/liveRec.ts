import { api } from "../api";

/** ADD-27: the microphone half of a live recording.
 *
 * Capture stays in the WebView (same permission path as dictation, and the
 * browser's echo cancellation keeps meeting audio played through the
 * speakers from re-entering the mic lane); raw PCM flows to the Rust engine
 * in ~250 ms base64 batches via rec_push_audio. Module-level singleton on
 * purpose — the recording must keep running while the user looks at other
 * files, so its lifetime can't belong to any component. */

let ctx: AudioContext | null = null;
let stream: MediaStream | null = null;
let teardown: (() => void) | null = null;
let muted = false;
let liveStt = true;

/** Same-origin asset, never a blob: URL — the app's CSP allows `script-src
 * 'self'` only, and an AudioWorklet module is fetched as a script. */
const WORKLET_URL = "/rec-worklet.js";

/** ScriptProcessor fallback size: ~85 ms at 48 kHz, small enough to stay
 * responsive, large enough not to flood the main thread. */
const FALLBACK_BUFFER = 4096;

function floatsToBase64(chunks: Float32Array[], length: number): string {
  const all = new Float32Array(length);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  const bytes = new Uint8Array(all.buffer);
  let bin = "";
  // 32KB slices keep String.fromCharCode off the argument-count cliff.
  for (let i = 0; i < bytes.length; i += 32768) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 32768));
  }
  return btoa(bin);
}

/** Mute/unmute the microphone lane while the Mac/meeting lane keeps
 * recording. Track-level (`enabled = false` — WebKit then delivers silence),
 * so the engine's VAD just sees a quiet lane; no backend involved. Module
 * state like the tap itself: the choice must survive the view unmounting,
 * and a mic re-acquired on resume inherits it (attachMicTap applies it). */
export function setMicMuted(m: boolean): void {
  muted = m;
  stream?.getAudioTracks().forEach((t) => {
    t.enabled = !m;
  });
}

export function micMuted(): boolean {
  return muted;
}

/** UI mirror of the engine's live-transcription gate (rec_set_live_stt).
 * Session-scoped and never persisted: every session starts ON — the actions
 * layer resets it at rec_start; the view reads it when (re)mounting. */
export function noteLiveStt(on: boolean): void {
  liveStt = on;
}

export function liveSttOn(): boolean {
  return liveStt;
}

/** Batch raw quanta into ~250 ms pushes. `flush` sends whatever is still
 * pending and resolves when the LAST push has landed — the dictation stop
 * path awaits it so its Stop command is ordered after the final samples
 * (recording teardown ignores the promise; that engine drains via Stop). */
function makeSink(
  rate: number,
  push: (rate: number, b64: string) => Promise<void>,
): {
  push: (frame: Float32Array) => void;
  flush: () => Promise<void>;
} {
  let pending: Float32Array[] = [];
  let pendingLen = 0;
  let inflight: Promise<void> = Promise.resolve();
  const batch = Math.round(rate / 4);
  const send = () => {
    if (pendingLen === 0) return inflight;
    const b64 = floatsToBase64(pending, pendingLen);
    pending = [];
    pendingLen = 0;
    // Failures swallowed: one dropped batch must never stall the tap.
    inflight = push(rate, b64).catch(() => {});
    return inflight;
  };
  return {
    push: (frame) => {
      pending.push(frame);
      pendingLen += frame.length;
      if (pendingLen >= batch) send();
    },
    flush: send,
  };
}

/** Preferred path: an AudioWorklet, which taps the mic off the audio thread. */
async function workletTap(
  audio: AudioContext,
  source: MediaStreamAudioSourceNode,
  sink: (frame: Float32Array) => void,
  onDead: () => void,
): Promise<() => void> {
  await audio.audioWorklet.addModule(WORKLET_URL);
  const node = new AudioWorkletNode(audio, "pr-rec-tap");
  node.port.onmessage = (e: MessageEvent<Float32Array>) => sink(e.data);
  // A worklet can die AFTER loading (processor exception). Frames then stop
  // silently — rebuild the tap on the deprecated-but-sturdy fallback.
  node.onprocessorerror = () => onDead();
  source.connect(node);
  // A worklet only runs while the graph reaches the destination; a muted
  // gain keeps it silent so the recording is never played back at you.
  const mute = audio.createGain();
  mute.gain.value = 0;
  node.connect(mute);
  mute.connect(audio.destination);
  return () => {
    node.port.onmessage = null;
    node.disconnect();
    mute.disconnect();
  };
}

/** Fallback for any WebView that refuses the worklet module. Deprecated API,
 * but it needs no module fetch at all — the microphone must never be lost to
 * a script-loading policy. */
function scriptProcessorTap(
  audio: AudioContext,
  source: MediaStreamAudioSourceNode,
  sink: (frame: Float32Array) => void,
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

/** Open the microphone. MUST be the first thing awaited in the click handler
 * that starts (or resumes) a recording: WebKit only grants capture while the
 * gesture's activation is still alive, so asking after an IPC round-trip
 * fails with NotAllowedError even when permission was long since given.
 * Throws the same human messages the dictation path uses. */
export async function acquireMic(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    const name = (e as { name?: string })?.name || "";
    throw new Error(
      name === "NotFoundError" || name === "OverconstrainedError"
        ? "No microphone found — plug one in or check your input device."
        : name === "NotReadableError" || name === "AbortError"
          ? "The microphone is busy in another app — close it and try again."
          : "Microphone blocked — allow Private Room in System Settings → Privacy & Security → Microphone, then reopen the app.",
    );
  }
}

/** Stream an already-open microphone into the live session. */
export async function attachMicTap(mic: MediaStream): Promise<void> {
  if (teardown) {
    mic.getTracks().forEach((t) => t.stop());
    return;
  }
  stream = mic;
  // A mic re-acquired mid-session (resume) respects the standing mute.
  mic.getAudioTracks().forEach((t) => {
    t.enabled = !muted;
  });
  // Run at the hardware's own rate: WebKit rejects a forced sampleRate, and
  // the engine resamples to 16 kHz anyway.
  ctx = new AudioContext();
  if (ctx.state === "suspended") await ctx.resume().catch(() => {});
  const source = ctx.createMediaStreamSource(mic);
  const rawSink = makeSink(ctx.sampleRate, (r, b64) => api.recPushAudio(r, b64));
  let gotFrame = false;
  const sink = (frame: Float32Array) => {
    gotFrame = true;
    rawSink.push(frame);
  };

  try {
    teardown = await workletTap(ctx, source, sink, rebuildOnFallback);
  } catch {
    teardown = scriptProcessorTap(ctx, source, sink);
  }
  const stop = teardown;
  teardown = () => {
    // stop() first: it detaches the frame handlers, so nothing lands in the
    // sink after the flush sends the final partial batch.
    stop();
    source.disconnect();
    void rawSink.flush();
  };
  // First-frame acknowledgement: a worklet that loaded but never produces a
  // quantum (seen with throttled WebViews) would otherwise record silence
  // forever. No frame within 2 s → rebuild on the ScriptProcessor fallback.
  window.setTimeout(() => {
    if (!gotFrame && teardown) rebuildOnFallback();
  }, 2000);
}

/** Tear down whatever tap is running and rebuild it on the ScriptProcessor
 * fallback, reusing the SAME stream and context. Used when the worklet path
 * dies after load (processorerror) or never delivers a first frame. */
function rebuildOnFallback(): void {
  if (!ctx || !stream || !teardown) return;
  teardown();
  const source = ctx.createMediaStreamSource(stream);
  const sink = makeSink(ctx.sampleRate, (r, b64) => api.recPushAudio(r, b64));
  const stop = scriptProcessorTap(ctx, source, (f) => sink.push(f));
  teardown = () => {
    stop();
    source.disconnect();
    void sink.flush();
  };
}

/** The dictation tap's AudioContext, kept for the app's lifetime (voice.ts
 * doctrine): hands-free re-arms the microphone OUTSIDE a user gesture, where
 * a freshly created context starts suspended in WKWebView and never produces
 * a frame — a context first resumed under a real gesture keeps running. */
let dictCtx: AudioContext | null = null;

/** Self-contained PCM tap for streaming dictation: the same worklet →
 * ScriptProcessor ladder as the recording tap, but with its own closure
 * state, so a dictation can run without touching the recording singleton
 * above. Returns an async teardown that detaches and AWAITS the final flush
 * (the caller sends its Stop only after the last samples landed). The caller
 * owns the MediaStream's tracks; the shared context persists. */
export async function createPcmTap(
  mic: MediaStream,
  push: (rate: number, b64: string) => Promise<void>,
): Promise<() => Promise<void>> {
  if (!dictCtx) dictCtx = new AudioContext();
  const audio = dictCtx;
  if (audio.state === "suspended") await audio.resume().catch(() => {});
  const sink = makeSink(audio.sampleRate, push);
  let gotFrame = false;
  let dead = false;
  let source = audio.createMediaStreamSource(mic);
  let stop: (() => void) | null = null;
  const frame = (f: Float32Array) => {
    gotFrame = true;
    sink.push(f);
  };
  // Worklet died after load, or never produced a first quantum: rebuild on
  // the deprecated-but-sturdy fallback (same doctrine as rebuildOnFallback).
  const useFallback = () => {
    if (dead) return;
    stop?.();
    source.disconnect();
    source = audio.createMediaStreamSource(mic);
    stop = scriptProcessorTap(audio, source, frame);
  };
  try {
    stop = await workletTap(audio, source, frame, useFallback);
  } catch {
    stop = scriptProcessorTap(audio, source, frame);
  }
  window.setTimeout(() => {
    if (!gotFrame) useFallback();
  }, 2000);
  return async () => {
    dead = true;
    stop?.();
    source.disconnect();
    await sink.flush();
    // No audio.close(): the shared context must survive for the next
    // (possibly gesture-less, hands-free) dictation.
  };
}

export function stopMicTap(): void {
  teardown?.();
  teardown = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  void ctx?.close().catch(() => {});
  ctx = null;
  muted = false;
}
