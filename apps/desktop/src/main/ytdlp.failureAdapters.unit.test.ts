import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  chmod: vi.fn(),
  existsSync: vi.fn(),
  mkdir: vi.fn(),
  open: vi.fn(),
  readdir: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  spawn: vi.fn(),
  stat: vi.fn(),
  unlink: vi.fn(),
  utimes: vi.fn(),
}));

vi.mock("node:fs", () => ({ existsSync: mocks.existsSync }));
vi.mock("node:fs/promises", () => ({
  chmod: mocks.chmod,
  mkdir: mocks.mkdir,
  open: mocks.open,
  readdir: mocks.readdir,
  rename: mocks.rename,
  rm: mocks.rm,
  stat: mocks.stat,
  unlink: mocks.unlink,
  utimes: mocks.utimes,
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

import {
  ensureYtdlp,
  refreshYtdlpIfStale,
  runCapturing,
  runYtdlpDownload,
  type SpawnedProcess,
} from "./ytdlp.js";

class FakeProcess extends EventEmitter implements SpawnedProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  kill = vi.fn(() => true);
}

function closingProcess(code = 0): FakeProcess {
  const child = new FakeProcess();
  queueMicrotask(() => {
    child.stdout.end();
    child.stderr.end();
    child.emit("close", code, null);
  });
  return child;
}

function entry(name: string) {
  return { name, isFile: () => true };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.existsSync.mockReturnValue(true);
  mocks.mkdir.mockResolvedValue(undefined);
  mocks.rm.mockResolvedValue(undefined);
  mocks.unlink.mockResolvedValue(undefined);
  mocks.utimes.mockResolvedValue(undefined);
  mocks.stat.mockResolvedValue({ mtimeMs: Date.now(), size: 1 });
  mocks.spawn.mockImplementation(() => closingProcess());
});

describe("yt-dlp default and best-effort adapters", () => {
  it("uses the production spawn adapter while all subprocess behavior remains fabricated", async () => {
    mocks.readdir.mockResolvedValue([entry("result.mp4")]);

    await expect(runYtdlpDownload("/fake/data", "https://public.test/video", {
      progress: vi.fn(),
      findFfmpegFn: () => null,
      tempDir: "/fake/tmp",
    })).resolves.toEqual({
      workDir: expect.stringMatching(/^\/fake\/tmp\/arcelle-yt-/),
      path: expect.stringMatching(/\/result\.mp4$/),
    });

    expect(mocks.spawn).toHaveBeenCalledWith(
      "/fake/data/bin/yt-dlp",
      expect.arrayContaining(["https://public.test/video"]),
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("uses the production fetch adapter without touching the network", async () => {
    mocks.existsSync.mockReturnValue(false);
    const writes: Uint8Array[] = [];
    mocks.open.mockResolvedValue({
      write: vi.fn(async (bytes: Uint8Array) => { writes.push(bytes); }),
      close: vi.fn(async () => undefined),
    });
    const binary = Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe, 1]);
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(binary.byteLength) },
      body: { getReader: () => {
        let sent = false;
        return { read: async () => sent ? { done: true } : (sent = true, { done: false, value: binary }) };
      } },
    }));
    vi.stubGlobal("fetch", fetch);

    await expect(ensureYtdlp("/fake/data", vi.fn(), {
      minBytes: binary.byteLength,
      maxBytes: 100,
      fetchTimeoutMs: 100,
    })).resolves.toBe("/fake/data/bin/yt-dlp");

    expect(fetch).toHaveBeenCalledOnce();
    expect(writes).toEqual([binary]);
    expect(mocks.chmod).toHaveBeenCalledWith("/fake/data/bin/yt-dlp.part", 0o755);
    expect(mocks.rename).toHaveBeenCalledWith("/fake/data/bin/yt-dlp.part", "/fake/data/bin/yt-dlp");
    vi.unstubAllGlobals();
  });

  it("keeps a timeout outcome when killing an already-gone process throws", async () => {
    const child = new FakeProcess();
    child.kill.mockImplementation(() => { throw new Error("fabricated ESRCH"); });

    await expect(runCapturing(() => child, "fake", [], 1)).resolves.toEqual({
      kind: "timeout",
      stdout: "",
      stderr: "",
    });
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("preserves an invalid-download refusal when part-file cleanup also fails", async () => {
    mocks.existsSync.mockReturnValue(false);
    mocks.unlink.mockRejectedValue(new Error("fabricated unlink denial"));
    mocks.open.mockResolvedValue({
      write: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    });
    const bad = Uint8Array.from([1, 2, 3, 4]);
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(bad.byteLength) },
      body: { getReader: () => {
        let sent = false;
        return { read: async () => sent ? { done: true } : (sent = true, { done: false, value: bad }) };
      } },
    }));

    await expect(ensureYtdlp("/fake/data", vi.fn(), {
      fetchFn,
      minBytes: bad.byteLength,
      maxBytes: 100,
      fetchTimeoutMs: 100,
    })).rejects.toThrow("What arrived is not the video downloader");
    expect(mocks.unlink).toHaveBeenCalledWith("/fake/data/bin/yt-dlp.part");
  });

  it("preserves a spawn failure when recursive work-directory cleanup also fails", async () => {
    mocks.rm.mockRejectedValue(new Error("fabricated rm denial"));
    mocks.spawn.mockImplementation(() => {
      const child = new FakeProcess();
      queueMicrotask(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit("error", new Error("fabricated spawn failure"));
        child.emit("close", null, null);
      });
      return child;
    });

    await expect(runYtdlpDownload("/fake/data", "https://public.test/video", {
      progress: vi.fn(),
      findFfmpegFn: () => null,
      tempDir: "/fake/tmp",
    })).rejects.toThrow("couldn't start the video downloader: fabricated spawn failure");
    expect(mocks.rm).toHaveBeenCalledWith(expect.stringMatching(/^\/fake\/tmp\/arcelle-yt-/), {
      recursive: true,
      force: true,
    });
  });

  it("keeps a successful refresh when its best-effort timestamp write fails", async () => {
    mocks.stat.mockResolvedValue({ mtimeMs: 0, size: 1 });
    mocks.utimes.mockRejectedValue(new Error("fabricated timestamp denial"));

    await expect(refreshYtdlpIfStale("/fake/data/bin/yt-dlp", vi.fn(), {
      now: () => 2_000_000_000_000,
      spawnFn: () => closingProcess(),
    })).resolves.toBeUndefined();
    expect(mocks.utimes).toHaveBeenCalledOnce();
  });

  it("reports no output when the completed work directory disappears before inspection", async () => {
    mocks.readdir.mockRejectedValue(new Error("fabricated directory race"));

    await expect(runYtdlpDownload("/fake/data", "https://public.test/video", {
      progress: vi.fn(),
      findFfmpegFn: () => null,
      tempDir: "/fake/tmp",
    })).rejects.toThrow("The downloader finished but produced no file.");
  });

  it("keeps the earlier larger candidate when a later file disappears before stat", async () => {
    mocks.readdir.mockResolvedValue([entry("a-large.mp4"), entry("b-raced.mp4")]);
    mocks.stat.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("yt-dlp")) return { mtimeMs: Date.now(), size: 1 };
      if (filePath.endsWith("a-large.mp4")) return { mtimeMs: Date.now(), size: 100 };
      if (filePath.endsWith("b-raced.mp4")) throw new Error("fabricated stat race");
      return { mtimeMs: Date.now(), size: 100 };
    });

    await expect(runYtdlpDownload("/fake/data", "https://public.test/video", {
      progress: vi.fn(),
      findFfmpegFn: () => null,
      tempDir: "/fake/tmp",
    })).resolves.toMatchObject({ path: expect.stringMatching(/a-large\.mp4$/) });
  });
});
