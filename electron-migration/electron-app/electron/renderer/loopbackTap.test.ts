/**
 * Tests for `loopbackTap.ts`. The tap-building ladder itself is
 * `audioGraphTap.test.ts`'s job — these cover the researched `getDisplayMedia`
 * call shape and its audio+video fallback, the deliberate `NOT_IMPLEMENTED`
 * default (this batch's explicit acceptance bar for the module), video-track
 * stripping, the ended-track signal, failed-start cleanup, and the start/stop
 * discipline `session_ws.py`'s re-sent tap request depends on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REQUEST_DISPLAY_MEDIA_NOT_IMPLEMENTED,
  SYSTEM_AUDIO_CONSTRAINTS,
  SYSTEM_AUDIO_FALLBACK_CONSTRAINTS,
  acquireSystemAudio,
  createLoopbackTap,
  defaultLoopbackTapDeps,
  requestDisplayMediaNotImplemented,
} from "./loopbackTap.js";
import { fakeAudioContext, fakeAudioTrack, fakeMediaStream } from "./testFixtures.js";

beforeEach(() => {
  vi.useFakeTimers(); // see micTap.test.ts's own note: openPcmTap's first-frame probe
});

afterEach(() => {
  vi.useRealTimers();
});

function domException(name: string): Error {
  return Object.assign(new Error(name), { name });
}

describe("the researched call shape", () => {
  it("asks for audio only — no screen picker, no capture indicator", () => {
    expect(SYSTEM_AUDIO_CONSTRAINTS).toEqual({ audio: true, video: false });
  });

  it("the retry shape asks for video only because some builds refuse video:false", () => {
    expect(SYSTEM_AUDIO_FALLBACK_CONSTRAINTS).toEqual({ audio: true, video: true });
  });
});

describe("the NOT_IMPLEMENTED seam", () => {
  it("refuses immediately with the labeled reason rather than hanging or fabricating a stream", async () => {
    await expect(requestDisplayMediaNotImplemented()).rejects.toThrow(REQUEST_DISPLAY_MEDIA_NOT_IMPLEMENTED);
    expect(REQUEST_DISPLAY_MEDIA_NOT_IMPLEMENTED).toMatch(/^NOT_IMPLEMENTED: /);
  });

  it("is acquireSystemAudio's default when no seam is injected", async () => {
    await expect(acquireSystemAudio()).rejects.toThrow(/NOT_IMPLEMENTED/);
  });

  it("defaultLoopbackTapDeps wires the refusal, not a real call", async () => {
    await expect(defaultLoopbackTapDeps().requestDisplayMedia(SYSTEM_AUDIO_CONSTRAINTS)).rejects.toThrow(
      /session\.setDisplayMediaRequestHandler/
    );
  });
});

describe("acquireSystemAudio", () => {
  it("returns the stream when the audio-only shape is granted directly", async () => {
    const stream = fakeMediaStream();
    const request = vi.fn().mockResolvedValue(stream);
    expect(await acquireSystemAudio(request)).toBe(stream);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(SYSTEM_AUDIO_CONSTRAINTS);
  });

  it.each(["NotSupportedError", "TypeError"])(
    "retries with audio+video and stops the video track when the audio-only shape is refused (%s)",
    async (errName) => {
      const video = fakeAudioTrack();
      const stream = fakeMediaStream({ videoTracks: [video] });
      const seen: unknown[] = [];
      const request = vi.fn(async (c: unknown) => {
        seen.push(c);
        if (seen.length === 1) throw domException(errName);
        return stream;
      });
      expect(await acquireSystemAudio(request)).toBe(stream);
      expect(seen).toEqual([SYSTEM_AUDIO_CONSTRAINTS, SYSTEM_AUDIO_FALLBACK_CONSTRAINTS]);
      expect(video.stopCalls).toBe(1);
    }
  );

  it("stops a video track the handler answered with even on the audio-only path", async () => {
    const video = fakeAudioTrack();
    const request = vi.fn().mockResolvedValue(fakeMediaStream({ videoTracks: [video] }));
    await acquireSystemAudio(request);
    expect(request).toHaveBeenCalledTimes(1);
    expect(video.stopCalls).toBe(1);
  });

  it("does not retry on a genuine permission refusal", async () => {
    const request = vi.fn().mockRejectedValue(domException("NotAllowedError"));
    await expect(acquireSystemAudio(request)).rejects.toThrow(/not allowed/i);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("maps NotFoundError to a clear message", async () => {
    const request = vi.fn().mockRejectedValue(domException("NotFoundError"));
    await expect(acquireSystemAudio(request)).rejects.toThrow(/no system audio source/i);
  });

  it("propagates the fallback request's own failure, mapped the same way", async () => {
    const request = vi.fn(async () => {
      if (request.mock.calls.length === 1) throw domException("NotSupportedError");
      throw domException("NotAllowedError");
    });
    await expect(acquireSystemAudio(request)).rejects.toThrow(/not allowed/i);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("refuses a stream with no audio track, stopping what it was handed", async () => {
    const video = fakeAudioTrack();
    const request = vi.fn().mockResolvedValue(fakeMediaStream({ audioTracks: [], videoTracks: [video] }));
    await expect(acquireSystemAudio(request)).rejects.toThrow(/no audio track/i);
    expect(video.stopCalls).toBeGreaterThanOrEqual(1);
  });
});

describe("start", () => {
  it("passes the exact researched constraints through and flows batched frames to onFrame", async () => {
    const ctx = fakeAudioContext({ sampleRate: 4 });
    const requestDisplayMedia = vi.fn().mockResolvedValue(fakeMediaStream());
    const tap = createLoopbackTap({ requestDisplayMedia, createAudioContext: () => ctx });
    const onFrame = vi.fn();
    await tap.start(onFrame);
    expect(requestDisplayMedia).toHaveBeenCalledWith(SYSTEM_AUDIO_CONSTRAINTS);
    ctx.workletNodes[0]!.emitMessage(new Float32Array([0.3]));
    expect(onFrame).toHaveBeenCalledWith(4, new Float32Array([0.3]));
  });

  it("marks the tap active only once start() has actually attached", async () => {
    const tap = createLoopbackTap({
      requestDisplayMedia: vi.fn().mockResolvedValue(fakeMediaStream()),
      createAudioContext: () => fakeAudioContext(),
    });
    expect(tap.active()).toBe(false);
    await tap.start(vi.fn());
    expect(tap.active()).toBe(true);
  });

  it("a second start() while already up RESOLVES as a no-op rather than refusing", async () => {
    // session_ws.py §2 re-sends an outstanding tap request to a socket the
    // instant it attaches: a renderer whose ok:true died with the old socket is
    // asked again while its tap still runs, and throwing there would report a
    // healthy meeting lane to the engine as failed — permanently, since
    // Engine.start_sys_tap is a one-shot.
    const requestDisplayMedia = vi.fn().mockResolvedValue(fakeMediaStream());
    const tap = createLoopbackTap({ requestDisplayMedia, createAudioContext: () => fakeAudioContext() });
    await tap.start(vi.fn());
    await expect(tap.start(vi.fn())).resolves.toBeUndefined();
    expect(requestDisplayMedia).toHaveBeenCalledTimes(1);
    expect(tap.active()).toBe(true);
  });

  it("overlapping start() calls in the same tick: only the first proceeds", async () => {
    const requestDisplayMedia = vi.fn().mockResolvedValue(fakeMediaStream());
    const tap = createLoopbackTap({ requestDisplayMedia, createAudioContext: () => fakeAudioContext() });
    await Promise.all([tap.start(vi.fn()), tap.start(vi.fn())]);
    expect(requestDisplayMedia).toHaveBeenCalledTimes(1);
  });

  it("propagates an acquisition failure and resets the starting guard", async () => {
    const tap = createLoopbackTap(); // real default: the NOT_IMPLEMENTED stub
    await expect(tap.start(vi.fn())).rejects.toThrow(/NOT_IMPLEMENTED/);
    expect(tap.active()).toBe(false);
    // A retry proves no "starting" flag was left stuck true.
    await expect(tap.start(vi.fn())).rejects.toThrow(/NOT_IMPLEMENTED/);
  });

  it("a tap that fails to attach stops the captured stream and closes the context", async () => {
    const ctx = fakeAudioContext();
    ctx.createMediaStreamSource = () => {
      throw new Error("the audio graph refused this stream");
    };
    const track = fakeAudioTrack();
    const tap = createLoopbackTap({
      requestDisplayMedia: vi.fn().mockResolvedValue(fakeMediaStream({ audioTracks: [track] })),
      createAudioContext: () => ctx,
    });
    await expect(tap.start(vi.fn())).rejects.toThrow("the audio graph refused this stream");
    // Otherwise the system capture (and its recording indicator) stays live
    // with nothing holding a handle to stop it.
    expect(track.stopCalls).toBe(1);
    expect(ctx.closeCalls).toBe(1);
    expect(tap.active()).toBe(false);
  });
});

describe("the ended-track signal", () => {
  it("an audio track ending on its own tears the tap down and calls onEnded", async () => {
    const track = fakeAudioTrack();
    const tap = createLoopbackTap({
      requestDisplayMedia: vi.fn().mockResolvedValue(fakeMediaStream({ audioTracks: [track] })),
      createAudioContext: () => fakeAudioContext(),
    });
    const onEnded = vi.fn();
    await tap.start(vi.fn(), onEnded);
    expect(tap.active()).toBe(true);

    track.endedListeners.forEach((fn) => fn());

    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(tap.active()).toBe(false);
  });

  it("stop() unsubscribes the ended listener, so a later stop cannot fire onEnded", async () => {
    const track = fakeAudioTrack();
    const tap = createLoopbackTap({
      requestDisplayMedia: vi.fn().mockResolvedValue(fakeMediaStream({ audioTracks: [track] })),
      createAudioContext: () => fakeAudioContext(),
    });
    const onEnded = vi.fn();
    await tap.start(vi.fn(), onEnded);
    tap.stop();
    expect(track.endedListeners).toHaveLength(0);
    expect(onEnded).not.toHaveBeenCalled();
  });
});

describe("stop", () => {
  it("tears the tap down, stops tracks, and closes the audio context", async () => {
    const track = fakeAudioTrack();
    const ctx = fakeAudioContext();
    const tap = createLoopbackTap({
      requestDisplayMedia: vi.fn().mockResolvedValue(fakeMediaStream({ audioTracks: [track] })),
      createAudioContext: () => ctx,
    });
    await tap.start(vi.fn());
    tap.stop();
    expect(track.stopCalls).toBe(1);
    expect(ctx.closeCalls).toBe(1);
    expect(tap.active()).toBe(false);
  });

  it("is a harmless no-op when never started, and idempotent after one", async () => {
    const ctx = fakeAudioContext();
    const tap = createLoopbackTap({
      requestDisplayMedia: vi.fn().mockResolvedValue(fakeMediaStream()),
      createAudioContext: () => ctx,
    });
    expect(() => tap.stop()).not.toThrow();
    await tap.start(vi.fn());
    tap.stop();
    tap.stop();
    expect(ctx.closeCalls).toBe(1);
  });

  it("a stopped tap can be started again", async () => {
    const requestDisplayMedia = vi.fn().mockResolvedValue(fakeMediaStream());
    const tap = createLoopbackTap({ requestDisplayMedia, createAudioContext: () => fakeAudioContext() });
    await tap.start(vi.fn());
    tap.stop();
    await tap.start(vi.fn());
    expect(requestDisplayMedia).toHaveBeenCalledTimes(2);
    expect(tap.active()).toBe(true);
  });
});
