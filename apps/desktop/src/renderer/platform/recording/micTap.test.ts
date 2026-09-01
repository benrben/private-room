/**
 * Tests for `micTap.ts`. `attach`'s underlying tap ladder (worklet/fallback/
 * first-frame probe) is `audioGraphTap.test.ts`'s job — these cover what THIS
 * module adds on top of it: constraints, error mapping, the synchronous
 * singleton guard, mute, failed-attach cleanup, and the real-default wiring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMicTap, defaultMicTapDeps } from "./micTap.js";
import { fakeAudioContext, fakeAudioTrack, fakeMediaStream } from "./testFixtures.js";

// `attach()` schedules audioGraphTap.ts's real first-frame probe
// (FIRST_FRAME_TIMEOUT_MS ~ 2s); fake timers keep every test here from leaving
// a dangling real setTimeout behind (that file's own rebuild-on-timeout
// behavior is already covered there, not re-tested here).
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("micConstraints", () => {
  it("autoGainControl is always false, echo/noise cancellation follow voiceProcessing", () => {
    const tap = createMicTap();
    expect(tap.micConstraints()).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
    });
    expect(tap.voiceProcessing()).toBe(true);
    tap.configureVoiceProcessing(false);
    expect(tap.voiceProcessing()).toBe(false);
    expect(tap.micConstraints()).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
  });
});

describe("acquireMic", () => {
  it("passes micConstraints() through to getUserMedia and returns its stream", async () => {
    const stream = fakeMediaStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const tap = createMicTap({ getUserMedia });
    expect(await tap.acquireMic()).toBe(stream);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
    });
  });

  it("re-reads the voice-processing setting on every acquisition", async () => {
    const getUserMedia = vi.fn().mockResolvedValue(fakeMediaStream());
    const tap = createMicTap({ getUserMedia });
    tap.configureVoiceProcessing(false);
    await tap.acquireMic();
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  });

  it.each([
    ["NotFoundError", "No microphone found — plug one in or check your input device."],
    ["OverconstrainedError", "No microphone found — plug one in or check your input device."],
    ["NotReadableError", "The microphone is busy in another app — close it and try again."],
    ["AbortError", "The microphone is busy in another app — close it and try again."],
    [
      "NotAllowedError",
      "Microphone blocked — allow Arcelle in System Settings → Privacy & Security → Microphone, then reopen the app.",
    ],
    [
      "",
      "Microphone blocked — allow Arcelle in System Settings → Privacy & Security → Microphone, then reopen the app.",
    ],
  ])("maps getUserMedia's %s to a human message", async (name, message) => {
    const err = Object.assign(new Error("raw"), { name });
    const tap = createMicTap({ getUserMedia: vi.fn().mockRejectedValue(err) });
    await expect(tap.acquireMic()).rejects.toThrow(message);
  });
});

describe("attach — the singleton guard", () => {
  it("a second attach while one is already active stops the loser's tracks and builds no second tap", async () => {
    const createAudioContext = vi.fn(() => fakeAudioContext());
    const tap = createMicTap({ createAudioContext });
    const track1 = fakeAudioTrack();
    const track2 = fakeAudioTrack();

    // Two overlapping calls in the SAME synchronous tick — Resume pressed
    // twice — must not both pass the guard (liveRec.ts's documented bug).
    const p1 = tap.attach(fakeMediaStream({ audioTracks: [track1] }), vi.fn());
    const p2 = tap.attach(fakeMediaStream({ audioTracks: [track2] }), vi.fn());
    await Promise.all([p1, p2]);

    expect(createAudioContext).toHaveBeenCalledTimes(1);
    expect(track2.stopCalls).toBe(1);
    expect(track1.stopCalls).toBe(0);
  });

  it("a third attach after stop() is allowed to build a fresh tap", async () => {
    const tap = createMicTap({ createAudioContext: () => fakeAudioContext() });
    await tap.attach(fakeMediaStream(), vi.fn());
    tap.stop();
    const track = fakeAudioTrack();
    await tap.attach(fakeMediaStream({ audioTracks: [track] }), vi.fn());
    expect(track.stopCalls).toBe(0); // this one was NOT rejected by the guard
  });

  it("frames reach the caller's onFrame once attached", async () => {
    const ctx = fakeAudioContext({ sampleRate: 4 });
    const tap = createMicTap({ createAudioContext: () => ctx });
    const onFrame = vi.fn();
    await tap.attach(fakeMediaStream(), onFrame);
    ctx.workletNodes[0]!.emitMessage(new Float32Array([0.75]));
    expect(onFrame).toHaveBeenCalledWith(4, new Float32Array([0.75]));
  });
});

describe("attach — a tap that never comes up", () => {
  it("stops the microphone and closes the context rather than leaving them held with no handle back", async () => {
    const ctx = fakeAudioContext();
    ctx.createMediaStreamSource = () => {
      throw new Error("the audio graph refused this stream");
    };
    const track = fakeAudioTrack();
    const tap = createMicTap({ createAudioContext: () => ctx });

    await expect(tap.attach(fakeMediaStream({ audioTracks: [track] }), vi.fn())).rejects.toThrow(
      "the audio graph refused this stream"
    );
    expect(track.stopCalls).toBe(1); // macOS's mic indicator goes out
    expect(ctx.closeCalls).toBe(1);
  });

  it("leaves the guard open, and a later successful attach owns the only live stream", async () => {
    let failNext = true;
    const contexts: ReturnType<typeof fakeAudioContext>[] = [];
    const tap = createMicTap({
      createAudioContext: () => {
        const ctx = fakeAudioContext();
        if (failNext) {
          ctx.createMediaStreamSource = () => {
            throw new Error("first attempt failed");
          };
        }
        contexts.push(ctx);
        return ctx;
      },
    });

    const doomedTrack = fakeAudioTrack();
    await expect(tap.attach(fakeMediaStream({ audioTracks: [doomedTrack] }), vi.fn())).rejects.toThrow(
      "first attempt failed"
    );

    failNext = false;
    const liveTrack = fakeAudioTrack();
    await tap.attach(fakeMediaStream({ audioTracks: [liveTrack] }), vi.fn());
    expect(liveTrack.stopCalls).toBe(0);

    tap.stop();
    // Exactly one stop each: the failed attempt's, at failure time, and the
    // live one's, at stop() — never a stream orphaned by the overwrite.
    expect(doomedTrack.stopCalls).toBe(1);
    expect(liveTrack.stopCalls).toBe(1);
    expect(contexts.map((c) => c.closeCalls)).toEqual([1, 1]);
  });
});

describe("mute", () => {
  it("setMuted disables the current stream's audio tracks", async () => {
    const track = fakeAudioTrack();
    const tap = createMicTap({ createAudioContext: () => fakeAudioContext() });
    await tap.attach(fakeMediaStream({ audioTracks: [track] }), vi.fn());
    expect(tap.muted()).toBe(false);

    tap.setMuted(true);
    expect(track.enabled).toBe(false);
    expect(tap.muted()).toBe(true);

    tap.setMuted(false);
    expect(track.enabled).toBe(true);
  });

  it("a mic re-attached mid-session inherits the standing mute", async () => {
    const tap = createMicTap({ createAudioContext: () => fakeAudioContext() });
    tap.setMuted(true);
    const track = fakeAudioTrack();
    await tap.attach(fakeMediaStream({ audioTracks: [track] }), vi.fn());
    expect(track.enabled).toBe(false);
  });

  it("stop() resets the mute — a fresh session starts unmuted", async () => {
    const tap = createMicTap({ createAudioContext: () => fakeAudioContext() });
    await tap.attach(fakeMediaStream(), vi.fn());
    tap.setMuted(true);
    tap.stop();
    expect(tap.muted()).toBe(false);
    const track = fakeAudioTrack();
    await tap.attach(fakeMediaStream({ audioTracks: [track] }), vi.fn());
    expect(track.enabled).toBe(true);
  });
});

describe("stop", () => {
  it("tears down the tap, stops every track, and closes the audio context", async () => {
    const ctx = fakeAudioContext();
    const audio = fakeAudioTrack();
    const video = fakeAudioTrack();
    const tap = createMicTap({ createAudioContext: () => ctx });
    await tap.attach(fakeMediaStream({ audioTracks: [audio], videoTracks: [video] }), vi.fn());
    tap.stop();
    expect(audio.stopCalls).toBe(1);
    expect(video.stopCalls).toBe(1);
    expect(ctx.closeCalls).toBe(1);
  });

  it("is a harmless, idempotent no-op when nothing is attached", async () => {
    const ctx = fakeAudioContext();
    const tap = createMicTap({ createAudioContext: () => ctx });
    expect(() => tap.stop()).not.toThrow();
    await tap.attach(fakeMediaStream(), vi.fn());
    tap.stop();
    tap.stop();
    expect(ctx.closeCalls).toBe(1);
  });
});

describe("defaultMicTapDeps — the real production wiring", () => {
  it("getUserMedia delegates to the real navigator.mediaDevices.getUserMedia", async () => {
    const stream = fakeMediaStream();
    const real = vi.fn().mockResolvedValue(stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: real } });
    expect(await defaultMicTapDeps().getUserMedia({ audio: true })).toBe(stream);
    expect(real).toHaveBeenCalledWith({ audio: true });
  });

  it("constructs and adapts the browser AudioContext lazily", () => {
    const context = fakeAudioContext();
    const AudioContext = vi.fn(() => context);
    vi.stubGlobal("AudioContext", AudioContext);

    const adapted = defaultMicTapDeps().createAudioContext();

    expect(AudioContext).toHaveBeenCalledOnce();
    expect(adapted.sampleRate).toBe(context.sampleRate);
  });
});
