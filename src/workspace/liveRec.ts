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
let node: AudioWorkletNode | null = null;

/** Registered from a blob URL so no asset pipeline is involved: forward each
 * 128-frame quantum of the first input channel to the main thread. */
const WORKLET_SRC = `
class PrTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("pr-rec-tap", PrTap);
`;

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

export function micTapRunning(): boolean {
  return node != null;
}

/** Start streaming mic PCM into the live session. Throws with the same
 * human messages the dictation path uses when the mic is missing/blocked. */
export async function startMicTap(): Promise<void> {
  if (node) return;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
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
  // 16 kHz is a hint; if the device runs at 44.1/48 k the engine resamples.
  ctx = new AudioContext({ sampleRate: 16000 });
  const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "text/javascript" }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const source = ctx.createMediaStreamSource(stream);
  node = new AudioWorkletNode(ctx, "pr-rec-tap");
  const rate = ctx.sampleRate;

  let pending: Float32Array[] = [];
  let pendingLen = 0;
  const batch = Math.round(rate / 4); // ~250 ms per IPC call
  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    pending.push(e.data);
    pendingLen += e.data.length;
    if (pendingLen >= batch) {
      const b64 = floatsToBase64(pending, pendingLen);
      pending = [];
      pendingLen = 0;
      // Fire-and-forget: one dropped batch must never stall the tap.
      api.recPushAudio(rate, b64).catch(() => {});
    }
  };
  source.connect(node);
  // A worklet only runs while connected toward the destination; a muted gain
  // keeps the graph silent.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute);
  mute.connect(ctx.destination);
}

export function stopMicTap(): void {
  node?.port.close();
  node?.disconnect();
  node = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  void ctx?.close().catch(() => {});
  ctx = null;
}
