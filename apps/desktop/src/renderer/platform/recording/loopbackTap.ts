/**
 * ADD-27 renderer system-audio (loopback) lane — Electron ≥39's built-in
 * `getDisplayMedia` loopback capture replacing the deleted `sck.rs`
 * (ScreenCaptureKit): `electron-python-migration-plan-2026-08-22.md` D1
 * ("System-audio loopback is built in (CoreAudio tap; ScreenCaptureKit
 * Rust/ObjC deleted)") and D7 ("Renderer `getDisplayMedia` loopback
 * (Electron ≥ 39) … never PyObjC for SCK — pyobjc#647: stream callbacks never
 * fire, closed not-planned"). `src/workspace/recordingActions.ts` has ZERO
 * renderer-side system-audio capture today — SCK was 100% native — so this is
 * genuinely new code, not a port; it reuses `audioGraphTap.ts`'s tap-builder
 * (the same worklet-then-ScriptProcessor ladder `micTap.ts` uses) because once
 * a `MediaStream` is in hand, tapping it into batched PCM is identical work
 * regardless of which device produced the stream.
 *
 * ============================================================================
 * THE getDisplayMedia() CALL SHAPE — researched, not guessed
 * ============================================================================
 * A meeting recorder wants the system's audio mix and never a picture of the
 * screen, so the request this module MAKES is audio-only
 * ({@link SYSTEM_AUDIO_CONSTRAINTS}, `{audio: true, video: false}`): its
 * main-process counterpart answers `{audio: 'loopback'}` with no video source
 * at all, which is what keeps the screen picker and the screen-recording
 * indicator out of a recording the user never asked to be visual.
 *
 * THAT SHAPE IS NOT UNIVERSALLY ACCEPTED, and the difference is not
 * detectable from here. The W3C screen-capture algorithm rejects a
 * `video: false` request with a `TypeError` outright, and Chromium builds
 * without the audio-only loopback path enabled follow it (surfacing as either
 * `TypeError` or `NotSupportedError` depending on the build). So
 * {@link acquireSystemAudio} retries once with
 * {@link SYSTEM_AUDIO_FALLBACK_CONSTRAINTS} (`{audio: true, video: true}`) and
 * stops the video track it never wanted — the documented workaround for
 * exactly that limitation, and the reason both shapes are exported constants
 * rather than inline literals: a test asserts against the SAME objects this
 * module calls with.
 *
 * ============================================================================
 * THE GAP THIS BATCH DELIBERATELY DOES NOT CLOSE
 * ============================================================================
 * `getDisplayMedia()`'s promise cannot resolve until
 * `session.setDisplayMediaRequestHandler` is registered on the MAIN process —
 * and registering it is explicitly Phase 2 Step 1's bootstrap/registry work,
 * running concurrently and NOT depended on here. So unlike `micTap.ts`'s
 * `getUserMedia` (which has no such external prerequisite and defaults to the
 * real browser API), `requestDisplayMedia` defaults to
 * {@link requestDisplayMediaNotImplemented} — refusing loudly and immediately
 * rather than returning a promise that would hang against a handler nobody
 * registered. The seam shape ({@link RequestDisplayMedia}) is the real
 * `navigator.mediaDevices.getDisplayMedia` signature narrowed to this call's
 * own constraints, so Phase 2 wiring in the real function is a one-line change
 * at the call site, not a redesign here.
 */

import {
  adaptAudioContext,
  openPcmTap,
  type AudioContextLike,
  type MediaStreamLike,
} from "./audioGraphTap.js";

/** The primary, audio-only request shape — see this module's doc. */
export const SYSTEM_AUDIO_CONSTRAINTS: DisplayMediaStreamOptions = Object.freeze({
  audio: true,
  video: false,
});

/** What {@link acquireSystemAudio} retries with when the primary shape is
 * refused outright. Video is requested only because some builds refuse
 * `video: false`, and is stopped the moment a stream comes back. */
export const SYSTEM_AUDIO_FALLBACK_CONSTRAINTS: DisplayMediaStreamOptions = Object.freeze({
  audio: true,
  video: true,
});

export type RequestDisplayMedia = (constraints: DisplayMediaStreamOptions) => Promise<MediaStreamLike>;

/** A display-media request that the browser never settles must not leave the
 * recording lane stuck in its `starting` state forever. */
export const SYSTEM_AUDIO_ACQUIRE_TIMEOUT_MS = 10_000;

export interface AcquireSystemAudioOptions {
  timeoutMs?: number;
}

/** The labeled reason the stub seam fails with — exported so a caller or test
 * can recognize it without hand-copying the string, matching `jobDownload.ts`'s
 * `FETCH_DOWNLOAD_NOT_IMPLEMENTED` convention. */
export const REQUEST_DISPLAY_MEDIA_NOT_IMPLEMENTED =
  "NOT_IMPLEMENTED: session.setDisplayMediaRequestHandler (the Electron main-process registration that " +
  "lets navigator.mediaDevices.getDisplayMedia() resolve to a real system-loopback audio source) is not " +
  "wired up yet — Phase 2 Step 1's bootstrap/registry work owns that, running concurrently with this " +
  "batch. Calling the real getDisplayMedia() with no handler registered hangs against a handler nobody " +
  "answers rather than failing cleanly, so this seam refuses immediately and honestly instead.";

/** {@link acquireSystemAudio}'s default `requestDisplayMedia` — a
 * clearly-labeled failure, never a silent no-op or a fabricated stream, for the
 * dependency Step 1 has not wired up yet. */
export function requestDisplayMediaNotImplemented(): Promise<MediaStreamLike> {
  return Promise.reject(new Error(REQUEST_DISPLAY_MEDIA_NOT_IMPLEMENTED));
}

function mapDisplayMediaError(e: unknown): Error {
  const name = (e as { name?: string } | null | undefined)?.name ?? "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return new Error(
      "System audio capture was not allowed — grant screen & system audio recording permission in " +
        "System Settings and try again."
    );
  }
  if (name === "NotFoundError") {
    return new Error("No system audio source is available to capture.");
  }
  const message = e instanceof Error ? e.message : String(e);
  return new Error(`System audio capture failed: ${message}`);
}

/** Refusals worth retrying the fallback shape for — a build that rejects
 * `{audio: true, video: false}` on principle, rather than one that considered
 * the request and denied it. See this module's doc for why both names. */
function isUnsupportedShape(e: unknown): boolean {
  const name = (e as { name?: string } | null | undefined)?.name ?? "";
  return name === "NotSupportedError" || name === "TypeError";
}

/** Stopping is what releases the capture and clears the screen-recording
 * indicator; the (now inert) track object staying listed on the stream is not
 * worth an extra `removeTrack` seam on {@link MediaStreamLike}. Run on BOTH
 * acquisition paths — a handler that answers with video for an audio-only
 * request must not leave a live capture running either. */
function stopVideoTracks(stream: MediaStreamLike): void {
  stream.getVideoTracks().forEach((t) => t.stop());
}

/** Bound a browser-owned request that has no AbortSignal API. If Chromium
 * hands back a stream after the timeout, stop every track immediately: the
 * caller has already reported failure and no longer owns a handle to it. */
async function requestDisplayMediaWithTimeout(
  requestDisplayMedia: RequestDisplayMedia,
  constraints: DisplayMediaStreamOptions,
  timeoutMs: number
): Promise<MediaStreamLike> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const request = requestDisplayMedia(constraints).then((stream) => {
    if (timedOut) {
      stream.getTracks().forEach((track) => track.stop());
    }
    return stream;
  });
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`System audio capture did not respond within ${timeoutMs}ms.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Acquire a system-loopback audio `MediaStream`, trying the audio-only shape
 * first and falling back to audio+video (stopping the video track) only when
 * the primary shape is refused outright — see this module's doc.
 *
 * `requestDisplayMedia` defaults to {@link requestDisplayMediaNotImplemented}:
 * UNLIKE `micTap.ts`'s `acquireMic`, this dependency genuinely is not wired up
 * yet, so calling this with no argument fails loudly and immediately rather
 * than reaching into a `navigator.mediaDevices` whose `getDisplayMedia()` has
 * no main-process handler behind it.
 */
export async function acquireSystemAudio(
  requestDisplayMedia: RequestDisplayMedia = requestDisplayMediaNotImplemented,
  options: AcquireSystemAudioOptions = {}
): Promise<MediaStreamLike> {
  const timeoutMs = options.timeoutMs ?? SYSTEM_AUDIO_ACQUIRE_TIMEOUT_MS;
  let stream: MediaStreamLike;
  try {
    stream = await requestDisplayMediaWithTimeout(requestDisplayMedia, SYSTEM_AUDIO_CONSTRAINTS, timeoutMs);
  } catch (primaryErr) {
    if (!isUnsupportedShape(primaryErr)) {
      throw mapDisplayMediaError(primaryErr);
    }
    try {
      stream = await requestDisplayMediaWithTimeout(
        requestDisplayMedia,
        SYSTEM_AUDIO_FALLBACK_CONSTRAINTS,
        timeoutMs
      );
    } catch (fallbackErr) {
      throw mapDisplayMediaError(fallbackErr);
    }
  }
  stopVideoTracks(stream);
  if (stream.getAudioTracks().length === 0) {
    // A stream with nothing to tap is worse than a refusal: the lane would look
    // live and record silence for the whole meeting.
    stream.getTracks().forEach((t) => t.stop());
    throw new Error("System audio capture returned no audio track.");
  }
  return stream;
}

export interface LoopbackTapDeps {
  requestDisplayMedia: RequestDisplayMedia;
  createAudioContext: () => AudioContextLike;
  workletUrl?: string;
}

function defaultCreateAudioContext(): AudioContextLike {
  return adaptAudioContext(new AudioContext());
}

export function defaultLoopbackTapDeps(): LoopbackTapDeps {
  return {
    requestDisplayMedia: requestDisplayMediaNotImplemented,
    createAudioContext: defaultCreateAudioContext,
  };
}

export interface LoopbackTap {
  /**
   * Bring the tap up and start pushing batched frames to `onFrame`. `onEnded`
   * fires if the audio track ends on its own (the user stopped sharing from the
   * OS/browser chrome, not from this app) — the caller reports that upstream
   * (`recSessionClient.ts`'s `wireLoopbackTap` does).
   *
   * A second `start()` while one is already up is a NO-OP that resolves, not a
   * refusal. `session_ws.py` §2 re-sends an outstanding `sys-tap-request` to a
   * socket the instant it attaches, so a renderer that answered a start whose
   * reply died with the old socket is asked again while its tap is still
   * running — throwing there would report a healthy meeting lane to the engine
   * as failed, and `Engine.start_sys_tap` is a one-shot that never asks twice.
   */
  start(onFrame: (rate: number, frame: Float32Array) => void, onEnded?: () => void): Promise<void>;
  /** Tear the tap down and stop the stream's tracks. Idempotent. */
  stop(): void;
  active(): boolean;
}

export function createLoopbackTap(deps: Partial<LoopbackTapDeps> = {}): LoopbackTap {
  const d: LoopbackTapDeps = { ...defaultLoopbackTapDeps(), ...deps };
  let stream: MediaStreamLike | null = null;
  let ctx: AudioContextLike | null = null;
  let teardown: (() => void) | null = null;
  let starting = false;

  async function start(
    onFrame: (rate: number, frame: Float32Array) => void,
    onEnded?: () => void
  ): Promise<void> {
    if (teardown || starting) return;
    starting = true;
    let audio: AudioContextLike | null = null;
    let media: MediaStreamLike | null = null;
    try {
      media = await acquireSystemAudio(d.requestDisplayMedia);
      audio = d.createAudioContext();
      const stopTap = await openPcmTap({ audioContext: audio, workletUrl: d.workletUrl }, media, onFrame);
      const tracks = media.getAudioTracks();
      const endedListener = (): void => {
        stop();
        onEnded?.();
      };
      tracks.forEach((t) => t.addEventListener("ended", endedListener));
      stream = media;
      ctx = audio;
      teardown = () => {
        tracks.forEach((t) => t.removeEventListener("ended", endedListener));
        stopTap();
      };
    } catch (err) {
      // Same reason as `micTap.ts`'s attach: a tap that never came up must not
      // leave a live system capture (and its recording indicator) behind with
      // nothing holding a handle to stop it.
      media?.getTracks().forEach((t) => t.stop());
      void audio?.close().catch(() => {});
      throw err;
    } finally {
      starting = false;
    }
  }

  function stop(): void {
    teardown?.();
    teardown = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    void ctx?.close().catch(() => {});
    ctx = null;
  }

  return { start, stop, active: () => teardown !== null };
}
