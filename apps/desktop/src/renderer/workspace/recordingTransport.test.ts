import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Callbacks = {
  onEvent(event: { type: string; payload: unknown }): void;
  onClose(): void;
  onSysTapRequest(request: unknown): void;
};

const fakes = vi.hoisted(() => {
  const creations: Array<{ callbacks: Callbacks; client: { close: ReturnType<typeof vi.fn>; sendAudio: ReturnType<typeof vi.fn> } }> = [];
  const loopback = { stop: vi.fn() };
  return {
    create: vi.fn((_url: string, _fileId: string, callbacks: Callbacks) => {
      const client = { close: vi.fn(), sendAudio: vi.fn() };
      creations.push({ callbacks, client });
      return client;
    }),
    creations,
    emitLocal: vi.fn(),
    loopback,
    setSink: vi.fn(),
    stopMicTap: vi.fn(),
    wireLoopbackTap: vi.fn(() => vi.fn()),
  };
});

vi.mock("../platform", () => ({ emitLocal: fakes.emitLocal }));
vi.mock("../platform/recording/recSessionClient.js", () => ({
  createRecSessionClient: fakes.create,
  wireLoopbackTap: fakes.wireLoopbackTap,
}));
vi.mock("../platform/recording/loopbackTap.js", () => ({ createLoopbackTap: () => fakes.loopback }));
vi.mock("./liveRec", () => ({ setRecordingAudioSink: fakes.setSink, stopMicTap: fakes.stopMicTap }));

import { closeRecordingTransport, startRecordingTransport } from "./recordingTransport";

beforeEach(() => {
  closeRecordingTransport();
  vi.clearAllMocks();
  fakes.creations.splice(0);
});

afterEach(() => {
  closeRecordingTransport();
  vi.clearAllMocks();
});

describe("recording transport with fabricated session clients", () => {
  it("forwards fake audio and cleans up an unexpected active close with an error", () => {
    startRecordingTransport("ws://fake-session", "recording-a");
    const { callbacks, client } = fakes.creations[0]!;
    const sink = fakes.setSink.mock.calls.at(-1)![0] as (rate: number, frame: Float32Array) => void;
    const frame = new Float32Array([0.25]);

    sink(48_000, frame);
    callbacks.onClose();

    expect(client.sendAudio).toHaveBeenCalledWith("mic", 48_000, frame);
    expect(fakes.setSink.mock.calls).toEqual([[null], [expect.any(Function)], [null]]);
    expect(fakes.loopback.stop).toHaveBeenCalledTimes(2);
    expect(fakes.stopMicTap).toHaveBeenCalledOnce();
    expect(fakes.emitLocal).toHaveBeenCalledWith("rec-error", {
      fileId: "recording-a",
      message: "The live recording connection closed unexpectedly.",
    });
  });

  it("ignores a stale close and suppresses the error after a fabricated terminal event", () => {
    startRecordingTransport("ws://fake-first", "recording-first");
    const first = fakes.creations[0]!;
    startRecordingTransport("ws://fake-second", "recording-second");
    const second = fakes.creations[1]!;

    first.callbacks.onClose();
    expect(first.client.close).toHaveBeenCalledOnce();
    expect(fakes.emitLocal).not.toHaveBeenCalled();

    second.callbacks.onSysTapRequest({ source: "fabricated" });
    second.callbacks.onEvent({ type: "partial", payload: { text: "fabricated words" } });
    second.callbacks.onEvent({ type: "stopped", payload: { fileId: "recording-second" } });
    second.callbacks.onClose();

    expect(fakes.emitLocal).toHaveBeenCalledWith("rec-partial", { text: "fabricated words" });
    expect(fakes.emitLocal).toHaveBeenCalledWith("rec-state", { fileId: "recording-second" });
    expect(fakes.emitLocal).not.toHaveBeenCalledWith("rec-error", expect.anything());
    expect(fakes.wireLoopbackTap).toHaveBeenCalledWith(second.client, fakes.loopback);
    expect(fakes.stopMicTap).toHaveBeenCalledOnce();
  });
});
