import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquireMic,
  configureMic,
  liveSttOn,
  micMuted,
  micVoiceProcessing,
  micVoiceProcessingFromSetting,
  noteLiveStt,
  setMicMuted,
} from "./liveRec";

function installFakeMedia(getUserMedia: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
}

afterEach(() => {
  configureMic(false);
  noteLiveStt(true);
  setMicMuted(false);
  vi.unstubAllGlobals();
});

describe("acquireMic", () => {
  it("uses the current constraints and returns a fabricated media stream", async () => {
    const stream = { id: "fake-stream" } as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    installFakeMedia(getUserMedia);

    configureMic(true);
    expect(await acquireMic()).toBe(stream);
    configureMic(false);
    expect(await acquireMic()).toBe(stream);

    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  });

  it.each([
    ["NotFoundError", "No microphone found — plug one in or check your input device."],
    ["OverconstrainedError", "No microphone found — plug one in or check your input device."],
    ["NotReadableError", "The microphone is busy in another app — close it and try again."],
    ["AbortError", "The microphone is busy in another app — close it and try again."],
    ["NotAllowedError", "Microphone blocked — allow Arcelle in System Settings → Privacy & Security → Microphone, then reopen the app."],
    ["", "Microphone blocked — allow Arcelle in System Settings → Privacy & Security → Microphone, then reopen the app."],
  ])("maps a fabricated %s permission failure", async (name, message) => {
    installFakeMedia(
      vi.fn().mockRejectedValue(Object.assign(new Error("fabricated failure"), { name })),
    );

    await expect(acquireMic()).rejects.toThrow(message);
  });
});

describe("live recording session settings", () => {
  it("uses only the persisted opt-in literal for microphone processing", () => {
    expect(micVoiceProcessingFromSetting(null)).toBe(false);
    expect(micVoiceProcessingFromSetting("0")).toBe(false);
    expect(micVoiceProcessingFromSetting("1")).toBe(true);
    configureMic(true);
    expect(micVoiceProcessing()).toBe(true);
  });

  it("tracks mute and live-transcription choices even before a microphone is attached", () => {
    setMicMuted(true);
    expect(micMuted()).toBe(true);
    noteLiveStt(false);
    expect(liveSttOn()).toBe(false);
  });
});
