import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const processMocks = vi.hoisted(() => ({
  execFile: vi.fn((
    _command: string,
    _args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, stdout?: string, stderr?: string) => void,
  ) => callback(null, "", "")),
  spawn: vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
    child.stderr = new EventEmitter();
    queueMicrotask(() => child.emit("close", 0));
    return child;
  }),
}));

const sidecarPost = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: processMocks.execFile,
  spawn: processMocks.spawn,
}));

vi.mock("./sidecarJsonCancellable.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sidecarJsonCancellable.js")>()),
  sidecarJsonCancellable: sidecarPost,
}));

import {
  deleteModel,
  ollamaInstalledNotImplemented,
  openOllama,
  probeOllamaModelSelection,
  pullCancellableAt,
} from "./ollamaModels.js";
import { CancelFlag } from "./cancel.js";
import { transcodeWithMacOs, transcodeWithMacOsUsing } from "./peaksTools.js";

describe("round-one main shard process adapters", () => {
  it("uses the default converter adapter without starting a real process", async () => {
    await expect(transcodeWithMacOs("source.wav", "decoded.wav", "audio", "/tmp")).resolves.toBeUndefined();
    expect(processMocks.execFile).toHaveBeenCalledWith(
      "/usr/bin/afconvert",
      ["-f", "WAVE", "-d", "LEI16@16000", "source.wav", "decoded.wav"],
      { maxBuffer: 1024 * 1024 },
      expect.any(Function),
    );
  });

  it("reports a converter failure even when stderr has no readable text", async () => {
    await expect(transcodeWithMacOsUsing(
      "source.mov",
      "decoded.wav",
      "video",
      "/tmp",
      {
        findFfmpeg: () => "/fake/ffmpeg",
        exec: async (command) => {
          if (command === "/usr/bin/avconvert") throw new Error("unsupported");
          throw { stderr: 42 };
        },
      },
    )).rejects.toThrow("no readable audio track:");
  });

  it("uses a mocked default launcher and never opens a local Ollama process", async () => {
    await expect(openOllama()).resolves.toBeUndefined();
    expect(processMocks.spawn).toHaveBeenCalledWith(
      "open",
      ["-a", "Ollama"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  });

  it("preserves stopped outcomes that violate never-cancelled call invariants", async () => {
    sidecarPost.mockResolvedValue({ kind: "stopped" });
    await expect(probeOllamaModelSelection("fake-model")).resolves.toEqual({
      ok: false,
      detail: "The model check was cancelled.",
    });
    await expect(deleteModel("fake-model")).rejects.toThrow(/reported the delete as stopped/);
  });

  it("reports an ordinary pull startup failure without classifying it as connection refused", async () => {
    const outcome = await pullCancellableAt("not-a-valid-base-url", "fake-model", new CancelFlag(), () => {});
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.message).toContain("Local AI request failed:");
  });

  it("keeps the deliberately unimplemented local-install probe explicit", async () => {
    await expect(ollamaInstalledNotImplemented()).rejects.toThrow("NOT_IMPLEMENTED");
  });
});
