/**
 * ADD-27 renderer mic lane — ported from `src/workspace/liveRec.ts`'s
 * `acquireMic`/`micConstraints`/`configureMic`/`attachMicTap`/`setMicMuted`/
 * `stopMicTap` (see that file's own doc for the WHY behind `autoGainControl`
 * always being `false`, `echoCancellation` staying on by default, and
 * `acquireMic` needing to be the first thing awaited in a click handler so
 * WebKit's capture gesture is still alive).
 *
 * THE ONE THING THIS PORT CHANGES is the sink shape: `liveRec.ts`'s sink
 * base64-encoded each ~250 ms batch and invoked `api.recPushAudio` over Tauri
 * IPC into the in-process Rust engine. {@link MicTap.attach} here hands the
 * SAME ~250 ms raw `Float32Array` batches to a plain `(rate, frame) => void`
 * callback — `recSessionClient.ts` is what turns a batch into the wire's
 * 12-byte-header + f32-PCM binary `/rec/session` frame and sends it
 * (`electron-python-migration-plan-2026-08-22.md:349`: "No base64, no double
 * hop through main"). This module never imports a WebSocket at all — the split
 * mirrors the one `audioGraphTap.ts` already draws between building the tap and
 * encoding what it produces.
 *
 * NOT A MODULE-LEVEL SINGLETON, unlike `liveRec.ts`. That file's singleton is
 * "on purpose" because the recording must keep running while the user looks at
 * other files, and nothing else held its lifetime. Here `createMicTap` is a
 * factory instead — the same "must survive the view unmounting" property is
 * achieved by WHERE the single instance a real renderer bootstrap constructs is
 * held (Phase 2's job), not by module state — so a test (or two tests running
 * in the same process) gets an independent instance with no cross-test bleed,
 * matching `recBridge.ts`'s `RecBridgeState`-per-call convention rather than
 * `liveRec.ts`'s module-global one.
 *
 * `getUserMedia`'s default dependency is the REAL
 * `navigator.mediaDevices.getUserMedia` — unlike `loopbackTap.ts`'s
 * `requestDisplayMedia`, there is no missing main-process prerequisite here
 * (Electron's loopback capture needs `session.setDisplayMediaRequestHandler`
 * registered first; plain mic capture needs nothing beyond OS permission), so
 * this module is genuinely ready to wire into a real renderer as soon as Phase
 * 2's bootstrap constructs one — see that file's doc for the contrast.
 */

import {
  adaptAudioContext,
  openPcmTap,
  type AudioContextLike,
  type MediaStreamLike,
} from "./audioGraphTap.js";

export interface MicTapDeps {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStreamLike>;
  createAudioContext: () => AudioContextLike;
  workletUrl?: string;
}

function defaultGetUserMedia(constraints: MediaStreamConstraints): Promise<MediaStreamLike> {
  return navigator.mediaDevices.getUserMedia(constraints);
}

function defaultCreateAudioContext(): AudioContextLike {
  return adaptAudioContext(new AudioContext());
}

export function defaultMicTapDeps(): MicTapDeps {
  return { getUserMedia: defaultGetUserMedia, createAudioContext: defaultCreateAudioContext };
}

/** GH #4 — what we ask macOS to do to the microphone signal. Verbatim from
 * `liveRec.ts`'s own `micConstraints` doc:
 *
 * `autoGainControl` is deliberately ALWAYS false. It is not a filter: on macOS
 * it rides the shared input device's actual gain, so any other app on the same
 * microphone (Teams, Zoom, Meet) hears our level changes as its own volume
 * dropping. Whisper does its own normalization, so we lose nothing by leaving
 * the hardware level exactly where the user set it.
 *
 * `echoCancellation` IS load-bearing and stays on by default: it stops meeting
 * audio played through the speakers from re-entering the mic lane and being
 * attributed to "You". Users on headphones have no acoustic echo to cancel, and
 * turning the whole voice-processing path off is what fully releases the
 * device — hence `configureVoiceProcessing`. */
function micConstraints(voiceProcessing: boolean): MediaTrackConstraints {
  return {
    echoCancellation: voiceProcessing,
    noiseSuppression: voiceProcessing,
    autoGainControl: false,
  };
}

/** `NotFoundError`/`OverconstrainedError`/`NotReadableError`/`AbortError`
 * mapping, verbatim from `liveRec.ts`'s `acquireMic`. */
function micErrorMessage(e: unknown): string {
  const name = (e as { name?: string } | null | undefined)?.name || "";
  return name === "NotFoundError" || name === "OverconstrainedError"
    ? "No microphone found — plug one in or check your input device."
    : name === "NotReadableError" || name === "AbortError"
      ? "The microphone is busy in another app — close it and try again."
      : "Microphone blocked — allow Arcelle in System Settings → Privacy & Security → Microphone, then reopen the app.";
}

export interface MicTap {
  /** Open the microphone. MUST be the first thing awaited in the click handler
   * that starts (or resumes) a recording — see `liveRec.ts`'s own `acquireMic`
   * doc on WebKit's capture-gesture window. Throws the same human messages the
   * dictation path uses. */
  acquireMic(): Promise<MediaStreamLike>;
  /** Stream an already-open microphone into `onFrame`. The singleton is claimed
   * SYNCHRONOUSLY (before the first `await`): two overlapping calls — Resume
   * pressed twice — must not both pass the guard and leave the loser's stream/
   * context dropped with nothing stopping its tracks (`liveRec.ts`'s own
   * documented bug class). A losing call stops the `MediaStream` it was handed
   * and returns. */
  attach(mic: MediaStreamLike, onFrame: (rate: number, frame: Float32Array) => void): Promise<void>;
  setMuted(muted: boolean): void;
  muted(): boolean;
  configureVoiceProcessing(on: boolean): void;
  voiceProcessing(): boolean;
  micConstraints(): MediaTrackConstraints;
  /** Tear down whatever tap is running, stop the stream's tracks, and close the
   * audio context. Idempotent. */
  stop(): void;
}

export function createMicTap(deps: Partial<MicTapDeps> = {}): MicTap {
  const d: MicTapDeps = { ...defaultMicTapDeps(), ...deps };
  let stream: MediaStreamLike | null = null;
  let ctx: AudioContextLike | null = null;
  let teardown: (() => void) | null = null;
  let attaching = false;
  let muted = false;
  let voiceProcessing = true;

  async function acquireMic(): Promise<MediaStreamLike> {
    try {
      return await d.getUserMedia({ audio: micConstraints(voiceProcessing) });
    } catch (e) {
      throw new Error(micErrorMessage(e));
    }
  }

  async function attach(
    mic: MediaStreamLike,
    onFrame: (rate: number, frame: Float32Array) => void
  ): Promise<void> {
    if (teardown || attaching) {
      mic.getTracks().forEach((t) => t.stop());
      return;
    }
    attaching = true;
    let audio: AudioContextLike | null = null;
    try {
      // A mic re-acquired mid-session (resume) respects the standing mute.
      mic.getAudioTracks().forEach((t) => {
        t.enabled = !muted;
      });
      audio = d.createAudioContext();
      const built = await openPcmTap({ audioContext: audio, workletUrl: d.workletUrl }, mic, onFrame);
      stream = mic;
      ctx = audio;
      teardown = built;
    } catch (err) {
      // A TAP THAT NEVER CAME UP MUST NOT LEAVE THE MICROPHONE OPEN. Publishing
      // `stream`/`ctx` before the ladder resolved left them set with `teardown`
      // still null, so the next attach sailed past the guard and overwrote the
      // only handles back to these tracks: macOS keeps the indicator lit for a
      // recording that failed to start, and the context leaks with it.
      mic.getTracks().forEach((t) => t.stop());
      void audio?.close().catch(() => {});
      throw err;
    } finally {
      attaching = false;
    }
  }

  function setMuted(m: boolean): void {
    muted = m;
    stream?.getAudioTracks().forEach((t) => {
      t.enabled = !m;
    });
  }

  function stop(): void {
    teardown?.();
    teardown = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    void ctx?.close().catch(() => {});
    ctx = null;
    muted = false;
  }

  return {
    acquireMic,
    attach,
    setMuted,
    muted: () => muted,
    configureVoiceProcessing: (on) => {
      voiceProcessing = on;
    },
    voiceProcessing: () => voiceProcessing,
    micConstraints: () => micConstraints(voiceProcessing),
    stop,
  };
}
