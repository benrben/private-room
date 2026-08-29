import { afterEach, describe, expect, it, vi } from "vitest";
import {
  frameOutputDimensions,
  mediaLoadFailure,
  presentedFrame,
} from "./frameGrab";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function installTimerWindow(): void {
  vi.stubGlobal("window", {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  });
}

describe("mediaLoadFailure", () => {
  it("reports a decoder error as an unsupported codec/container, not a timeout", () => {
    const message = mediaLoadFailure("error");
    expect(message).toContain("couldn't be decoded");
    expect(message).toContain("codec or container");
    expect(message).not.toContain("timed out");
  });

  it("reserves the timeout message for an actual timeout", () => {
    expect(mediaLoadFailure("timeout")).toBe(
      "That video couldn't be loaded for a frame grab (timed out).",
    );
  });
});

describe("frameOutputDimensions", () => {
  it("reports the exact resized PNG dimensions rather than source-video dimensions", () => {
    expect(frameOutputDimensions(1920, 1080, 1280)).toEqual({ width: 1280, height: 720 });
    expect(frameOutputDimensions(3840, 2160, 1280)).toEqual({ width: 1280, height: 720 });
  });

  it("preserves source dimensions when no resize is needed", () => {
    expect(frameOutputDimensions(640, 360, 1280)).toEqual({ width: 640, height: 360 });
    expect(frameOutputDimensions(1920, 1080, Infinity)).toEqual({ width: 1920, height: 1080 });
  });
});

describe("presentedFrame", () => {
  it("accepts only the decoder's presentation callback as success", async () => {
    vi.useFakeTimers();
    installTimerWindow();
    let presented: ((now: number, metadata: { mediaTime?: number }) => void) | null = null;
    const video = {
      // The playback clock can move after the nudge; it is deliberately wrong
      // here so only callback metadata can make the receipt test pass.
      currentTime: 0.002,
      pause: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
      requestVideoFrameCallback: vi.fn((callback: (now: number, metadata: { mediaTime?: number }) => void) => {
        presented = callback;
        return 1;
      }),
    } as unknown as HTMLVideoElement;

    const pending = presentedFrame(video, 2500);
    expect(presented).toBeTypeOf("function");
    (presented as unknown as (now: number, metadata: { mediaTime: number }) => void)(123, {
      mediaTime: 1.05,
    });

    await expect(pending).resolves.toEqual({ status: "presented", mediaTime: 1.05 });
    expect(video.pause).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2500);
    expect(video.play).not.toHaveBeenCalled();
  });

  it("returns an honest timeout when the nudge produces no presented frame", async () => {
    vi.useFakeTimers();
    installTimerWindow();
    const video = {
      pause: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
      requestVideoFrameCallback: vi.fn(() => 1),
    } as unknown as HTMLVideoElement;

    const pending = presentedFrame(video, 2500);
    await vi.advanceTimersByTimeAsync(300);
    expect(video.play).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2200);

    await expect(pending).resolves.toEqual({ status: "timeout" });
    expect(video.pause).toHaveBeenCalledOnce();
  });

  it("rejects a presented frame whose callback has no finite media timestamp", async () => {
    vi.useFakeTimers();
    installTimerWindow();
    let presented: ((now: number, metadata: { mediaTime?: number }) => void) | null = null;
    const video = {
      currentTime: 1.05,
      pause: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
      requestVideoFrameCallback: vi.fn((callback: (now: number, metadata: { mediaTime?: number }) => void) => {
        presented = callback;
        return 1;
      }),
    } as unknown as HTMLVideoElement;

    const pending = presentedFrame(video, 2500);
    (presented as unknown as (now: number, metadata: { mediaTime: number }) => void)(123, {
      mediaTime: Number.NaN,
    });

    await expect(pending).resolves.toEqual({ status: "invalid-timestamp" });
    expect(video.pause).toHaveBeenCalledOnce();
    expect(video.play).not.toHaveBeenCalled();
  });

  it("does not treat animation timing as proof on engines without a presentation callback", async () => {
    vi.useFakeTimers();
    installTimerWindow();
    const video = {
      pause: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
    } as unknown as HTMLVideoElement;

    const pending = presentedFrame(video, 2500);
    await vi.advanceTimersByTimeAsync(2500);

    await expect(pending).resolves.toEqual({ status: "timeout" });
    expect(video.play).toHaveBeenCalledOnce();
    expect(video.pause).toHaveBeenCalledOnce();
  });
});
