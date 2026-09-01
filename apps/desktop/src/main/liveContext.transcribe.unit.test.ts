import { describe, expect, it, vi } from "vitest";

const speech = vi.hoisted(() => ({ transcribeMediaBytes: vi.fn() }));

vi.mock("./speechSttSurfaceIpc.js", () => ({
  transcribeMediaBytes: speech.transcribeMediaBytes,
}));

describe("liveCmdCtxDeps transcription wiring", () => {
  it("forwards host paths and media bytes to the fabricated speech boundary", async () => {
    speech.transcribeMediaBytes.mockResolvedValue("fabricated transcript");
    const { liveCmdCtxDeps } = await import("./liveContext.js");
    const bytes = Buffer.from("not real audio");
    const transcribe = liveCmdCtxDeps({
      userDataDir: "/fake/user-data",
      resourcesPath: "/fake/resources",
    }).transcribeAudio;

    await expect(transcribe?.(bytes, "wav", "audio")).resolves.toBe("fabricated transcript");
    expect(speech.transcribeMediaBytes).toHaveBeenCalledWith(
      "/fake/user-data",
      "/fake/resources",
      bytes,
      "wav",
      "audio",
    );
  });
});
