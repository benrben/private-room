import { afterEach, describe, expect, it, vi } from "vitest";
import {
  drawToPng,
  drawToPngB64,
  frameOutputDimensions,
  frameSha256,
  grabFrame,
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

type FakeFrameOptions = {
  canvasContext?: boolean;
  duration?: number;
  loadEvent?: "error" | "loadedmetadata";
  presentedMediaTime?: number;
  readyState?: number;
  seekEvent?: boolean;
  videoHeight?: number;
  videoWidth?: number;
};

function installFrameDocument(options: FakeFrameOptions = {}) {
  const listeners = new Map<string, EventListener[]>();
  const source = {} as HTMLSourceElement;
  const drawImage = vi.fn();
  const canvas = {
    getContext: vi.fn(() => (options.canvasContext === false ? null : { drawImage })),
    toDataURL: vi.fn(() => "data:image/png;base64,YQ=="),
  } as unknown as HTMLCanvasElement;
  const emit = (event: string) => {
    for (const listener of listeners.get(event) ?? []) {
      listener({ type: event } as Event);
    }
  };
  let currentTime = 0;
  const video = {
    appendChild: vi.fn(),
    crossOrigin: "",
    duration: options.duration ?? 10,
    load: vi.fn(() => {
      queueMicrotask(() => emit(options.loadEvent ?? "loadedmetadata"));
    }),
    muted: false,
    pause: vi.fn(),
    play: vi.fn().mockResolvedValue(undefined),
    preload: "",
    readyState: options.readyState ?? 2,
    remove: vi.fn(),
    requestVideoFrameCallback: vi.fn((callback: (now: number, metadata: { mediaTime?: number }) => void) => {
      if (options.presentedMediaTime !== undefined) {
        queueMicrotask(() => callback(0, { mediaTime: options.presentedMediaTime }));
      }
      return 1;
    }),
    setAttribute: vi.fn(),
    style: {},
    videoHeight: options.videoHeight ?? 1080,
    videoWidth: options.videoWidth ?? 1920,
  } as unknown as HTMLVideoElement;
  Object.defineProperty(video, "addEventListener", {
    value: (event: string, listener: EventListener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
  });
  Object.defineProperty(video, "removeEventListener", {
    value: (event: string, listener: EventListener) => {
      listeners.set(event, (listeners.get(event) ?? []).filter((item) => item !== listener));
    },
  });
  Object.defineProperty(video, "currentTime", {
    get: () => currentTime,
    set: (value: number) => {
      currentTime = value;
      if (options.seekEvent !== false) queueMicrotask(() => emit("seeked"));
    },
  });
  const appendToBody = vi.fn();
  vi.stubGlobal("document", {
    body: { appendChild: appendToBody },
    createElement: vi.fn((tag: string) => {
      if (tag === "video") return video;
      if (tag === "source") return source;
      if (tag === "canvas") return canvas;
      throw new Error(`Unexpected element ${tag}`);
    }),
  });
  return { appendToBody, canvas, currentTime: () => currentTime, drawImage, source, video };
}

async function advanceToTimer(milliseconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(milliseconds);
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

describe("frame encoding", () => {
  it("draws a resized image to a PNG canvas and removes the data URL prefix", () => {
    const document = installFrameDocument();
    const result = drawToPng({} as CanvasImageSource, 1920, 1080, 1280);

    expect(result).toEqual({ imageB64: "YQ==", width: 1280, height: 720 });
    expect(document.canvas.width).toBe(1280);
    expect(document.canvas.height).toBe(720);
    expect(document.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1280, 720);
  });

  it("keeps the pixels-only compatibility wrapper aligned with the PNG receipt", () => {
    installFrameDocument();
    expect(drawToPngB64({} as CanvasImageSource, 1, 1, 1280)).toBe("YQ==");
  });

  it("hashes decoded bytes rather than base64 text", async () => {
    await expect(frameSha256("YQ==")).resolves.toBe(
      "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
    );
  });
});

describe("grabFrame", () => {
  it("does not create media DOM when there is no staged stream token", async () => {
    await expect(grabFrame("", "video/mp4", 1, 1280)).resolves.toEqual({
      error: "There is no media stream to grab a frame from.",
    });
  });

  it("uses a CORS hidden video and reports the exact presented frame", async () => {
    installTimerWindow();
    const document = installFrameDocument({ duration: 5, presentedMediaTime: 4.75 });

    await expect(grabFrame("stream-token", "video/mp4", 9, 1280)).resolves.toEqual({
      imageB64: "YQ==",
      width: 1280,
      height: 720,
      atSeconds: 4.75,
      sha256: "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
    });

    expect(document.video.crossOrigin).toBe("anonymous");
    expect(document.video.muted).toBe(true);
    expect(document.video.preload).toBe("auto");
    expect(document.video.style).toMatchObject({
      position: "fixed",
      left: "-10000px",
      width: "1px",
      height: "1px",
    });
    expect(document.source.src).toBe("roommedia://localhost/stream-token");
    expect(document.source.type).toBe("video/mp4");
    expect(document.currentTime()).toBe(5);
    expect(document.appendToBody).toHaveBeenCalledWith(document.video);
    expect(document.video.remove).toHaveBeenCalledOnce();
  });

  it("keeps a finite requested time when stream duration is unknown", async () => {
    installTimerWindow();
    const document = installFrameDocument({ duration: Infinity, presentedMediaTime: 12 });

    await expect(grabFrame("stream-token", "", 12, 1280)).resolves.toMatchObject({
      atSeconds: 12,
      imageB64: "YQ==",
    });
    expect(document.currentTime()).toBe(12);
  });

  it("returns the decoder failure when metadata loading fires error", async () => {
    installTimerWindow();
    const document = installFrameDocument({ loadEvent: "error" });

    await expect(grabFrame("stream-token", "", 1, 1280)).resolves.toEqual({
      error: "That video couldn't be decoded for a frame grab. Its codec or container may not be supported.",
    });
    expect(document.video.remove).toHaveBeenCalledOnce();
  });

  it("returns a clear error when metadata has no video track", async () => {
    installTimerWindow();
    const document = installFrameDocument({ videoHeight: 0 });

    await expect(grabFrame("stream-token", "", 1, 1280)).resolves.toEqual({
      error: "That file has no video track.",
    });
    expect(document.video.remove).toHaveBeenCalledOnce();
  });

  it("keeps the decoder fallback only when a missing seek event lacks current data", async () => {
    vi.useFakeTimers();
    installTimerWindow();
    const document = installFrameDocument({ readyState: 1, seekEvent: false });
    const pending = grabFrame("stream-token", "", -3, 1280);

    await advanceToTimer(8000);
    await expect(pending).resolves.toEqual({ error: "Couldn't seek that video to 0.0s." });
    expect(document.currentTime()).toBe(0);
    expect(document.video.remove).toHaveBeenCalledOnce();
  });

  it("rejects a presented frame without a verifiable timestamp", async () => {
    installTimerWindow();
    const document = installFrameDocument({ presentedMediaTime: Number.NaN });

    await expect(grabFrame("stream-token", "", 1, 1280)).resolves.toEqual({
      error: "That video presented a frame without a verifiable media timestamp, so no pixels were attached.",
    });
    expect(document.video.remove).toHaveBeenCalledOnce();
  });

  it("returns the frame timeout instead of exporting unpresented pixels", async () => {
    vi.useFakeTimers();
    installTimerWindow();
    const document = installFrameDocument();
    const pending = grabFrame("stream-token", "", 1, 1280);

    await advanceToTimer(2500);
    await expect(pending).resolves.toEqual({
      error: "That video did not present the requested frame before the frame-grab timeout.",
    });
    expect(document.video.play).toHaveBeenCalledOnce();
    expect(document.video.remove).toHaveBeenCalledOnce();
  });

  it("degrades a canvas export failure into a displayable error", async () => {
    installTimerWindow();
    const document = installFrameDocument({ canvasContext: false, presentedMediaTime: 1 });

    await expect(grabFrame("stream-token", "", 1, 1280)).resolves.toEqual({
      error: "That video's frames couldn't be exported to an image.",
    });
    expect(document.video.remove).toHaveBeenCalledOnce();
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
