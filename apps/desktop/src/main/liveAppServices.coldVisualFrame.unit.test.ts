import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomManagerState } from "./roomManager.js";
import type { VideoVisualIndexClient } from "./videoVisualIndex.js";

const fakes = vi.hoisted(() => ({
  createWriteStream: vi.fn(),
  findFileLikeQualified: vi.fn(),
  getFileBytes: vi.fn(),
  getFileMeta: vi.fn(),
  guessDownloadMime: vi.fn(),
  mkdtemp: vi.fn(),
  pipeline: vi.fn(),
  playableMediaMime: vi.fn(),
  requestAgentUi: vi.fn(),
  rm: vi.fn(),
  stageMediaBytes: vi.fn(),
  stageMediaStream: vi.fn(),
  tmpdir: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const filesystem = {
    ...actual,
    createWriteStream: fakes.createWriteStream,
    promises: { ...actual.promises, mkdtemp: fakes.mkdtemp, rm: fakes.rm },
  };
  return { ...filesystem, default: filesystem };
});

vi.mock("node:os", () => ({ default: { tmpdir: fakes.tmpdir } }));
vi.mock("node:stream/promises", () => ({ pipeline: fakes.pipeline }));
vi.mock("./agentUiSurfaceIpc.js", () => ({ requestAgentUi: fakes.requestAgentUi }));
vi.mock("./db-host/files.js", () => ({
  findFileLikeQualified: fakes.findFileLikeQualified,
  getFileBytes: fakes.getFileBytes,
  getFileMeta: fakes.getFileMeta,
}));
vi.mock("./mediaTools.js", () => ({
  playableMediaMime: fakes.playableMediaMime,
  stageMediaBytes: fakes.stageMediaBytes,
  stageMediaStream: fakes.stageMediaStream,
}));
vi.mock("./videoVisualIndex.js", () => ({
  VIDEO_VISUAL_WARM_TIMEOUT_MS: 120_000,
  videoVisualIndex: { capture: vi.fn(), frame: vi.fn(), warm: vi.fn() },
}));
vi.mock("./webFetch.js", () => ({ guessDownloadMime: fakes.guessDownloadMime }));

import { requestLiveMediaFrame } from "./liveAppServices.js";

function workspaceState(): RoomManagerState {
  const conn = {
    prepare: vi.fn(() => ({ get: vi.fn(() => ({ size_bytes: 200, content_sha256: "source-sha" })) })),
  };
  return {
    room: {
      conn,
      workspace: { readStream: vi.fn(() => ({ kind: "fabricated-stream" })) },
    },
  } as unknown as RoomManagerState;
}

function visualIndex(overrides: Partial<VideoVisualIndexClient> = {}): VideoVisualIndexClient {
  return {
    frame: vi.fn(async () => null),
    capture: vi.fn(async () => ({
      imageB64: "fabricated-frame",
      width: 320,
      height: 180,
      atSeconds: 62,
      sha256: "frame-sha",
    })),
    warm: vi.fn(async () => null),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fakes.tmpdir.mockReturnValue("/fake/tmp");
  fakes.mkdtemp.mockResolvedValue("/fake/tmp/arcelle-visual-index-1");
  fakes.rm.mockResolvedValue(undefined);
  fakes.pipeline.mockResolvedValue(undefined);
  fakes.createWriteStream.mockReturnValue({ kind: "fabricated-write-stream" });
  fakes.findFileLikeQualified.mockReturnValue(["video-1", "meeting.mp4"]);
  fakes.getFileMeta.mockReturnValue({ name: "meeting.mp4", mimeType: "video/mp4" });
  fakes.guessDownloadMime.mockReturnValue("video/mp4");
  fakes.playableMediaMime.mockReturnValue("video/mp4");
  fakes.stageMediaStream.mockReturnValue("fallback-media-token");
});

describe("cold workspace visual frame", () => {
  it("stages fabricated bytes, returns the cold capture, and defers cleanup until warming settles", async () => {
    let settleWarm!: (value: null) => void;
    const warm = vi.fn(() => new Promise<null>((resolve) => { settleWarm = resolve; }));
    const index = visualIndex({ warm });

    await expect(
      requestLiveMediaFrame(
        workspaceState(),
        {} as never,
        {} as never,
        vi.fn(),
        { name: "meeting.mp4", at: "1:02" },
        index,
      ),
    ).resolves.toEqual({
      imageB64: "fabricated-frame",
      width: 320,
      height: 180,
      atSeconds: 62,
      sha256: "frame-sha",
    });

    expect(fakes.pipeline).toHaveBeenCalledTimes(1);
    expect(index.capture).toHaveBeenCalledWith(
      "/fake/tmp/arcelle-visual-index-1/source.mp4",
      62,
      expect.any(Number),
    );
    expect(warm).toHaveBeenCalledWith(
      "/fake/tmp/arcelle-visual-index-1/source.mp4",
      "source-sha",
      120_000,
    );
    expect(fakes.rm).not.toHaveBeenCalled();

    settleWarm(null);
    await Promise.resolve();
    await Promise.resolve();
    expect(fakes.rm).toHaveBeenCalledWith("/fake/tmp/arcelle-visual-index-1", {
      recursive: true,
      force: true,
    });
  });

  it("falls back to a fabricated renderer frame when staging fails", async () => {
    fakes.pipeline.mockRejectedValue(new Error("fabricated stage failure"));
    fakes.requestAgentUi.mockResolvedValue({ imageB64: "renderer-frame" });
    const index = visualIndex();

    await expect(
      requestLiveMediaFrame(
        workspaceState(),
        {} as never,
        {} as never,
        vi.fn(),
        { name: "meeting.mp4", at: 4 },
        index,
      ),
    ).resolves.toEqual({ imageB64: "renderer-frame" });

    expect(index.capture).not.toHaveBeenCalled();
    expect(fakes.stageMediaStream).toHaveBeenCalled();
    expect(fakes.requestAgentUi).toHaveBeenCalledWith(
      {},
      expect.any(Function),
      "media_frame",
      { token: "fallback-media-token", mime: "video/mp4", seconds: 4 },
    );
    expect(fakes.rm).toHaveBeenCalledWith("/fake/tmp/arcelle-visual-index-1", {
      recursive: true,
      force: true,
    });
  });

  it("falls back when the bounded cold capture rejects before its deadline", async () => {
    fakes.requestAgentUi.mockResolvedValue({ imageB64: "renderer-after-rejection" });
    const index = visualIndex({ capture: vi.fn(async () => { throw new Error("fabricated capture failure"); }) });

    await expect(
      requestLiveMediaFrame(
        workspaceState(),
        {} as never,
        {} as never,
        vi.fn(),
        { name: "meeting.mp4", at: 4 },
        index,
      ),
    ).resolves.toEqual({ imageB64: "renderer-after-rejection" });

    expect(fakes.requestAgentUi).toHaveBeenCalled();
  });
});
