import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../api";
import type { WSState } from "./state";

const mocks = vi.hoisted(() => ({
  api: { setSetting: vi.fn() },
  splitMarkupBlocks: vi.fn(),
  voice: {
    cancelAll: vi.fn(),
    configure: vi.fn(),
    ensureUnlocked: vi.fn(),
    speakText: vi.fn(),
  },
}));

vi.mock("../api", () => ({ api: mocks.api }));
vi.mock("./markup", () => ({ splitMarkupBlocks: mocks.splitMarkupBlocks }));
vi.mock("./voice", () => mocks.voice);

import { makeVoiceActions } from "./voiceActions";

function state(overrides: Record<string, unknown> = {}) {
  return {
    autoSpeak: false,
    handsFree: false,
    speakingMsgId: null,
    setAutoSpeak: vi.fn(),
    setHandsFree: vi.fn(),
    setSpeakingMsgId: vi.fn(),
    ...overrides,
  } as unknown as WSState;
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: "message-1",
    content: "**structured** answer",
    effects: null,
    ...overrides,
  } as unknown as Message;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.api.setSetting.mockResolvedValue(undefined);
  mocks.splitMarkupBlocks.mockReturnValue({ text: "plain spoken answer" });
});

describe("makeVoiceActions with fabricated voice and settings seams", () => {
  it("stops the currently speaking message without unlocking or scheduling more audio", () => {
    const s = state({ speakingMsgId: "message-1" });

    makeVoiceActions(s).speakMessage(message());

    expect(mocks.voice.cancelAll).toHaveBeenCalledTimes(1);
    expect(s.setSpeakingMsgId).toHaveBeenCalledWith(null);
    expect(mocks.voice.ensureUnlocked).not.toHaveBeenCalled();
    expect(mocks.voice.speakText).not.toHaveBeenCalled();
  });

  it("normalizes ordinary message markup and lets the fake voice pipeline own speaking state", () => {
    const s = state();
    const m = message();

    makeVoiceActions(s).speakMessage(m);

    expect(mocks.voice.ensureUnlocked).toHaveBeenCalledTimes(1);
    expect(mocks.splitMarkupBlocks).toHaveBeenCalledWith("**structured** answer");
    expect(mocks.voice.speakText).toHaveBeenCalledWith("plain spoken answer", expect.objectContaining({ onState: expect.any(Function) }));
    const options = mocks.voice.speakText.mock.calls[0]?.[1] as { onState: (playing: boolean) => void } | undefined;
    if (!options) throw new Error("Fake voice options missing.");
    options.onState(true);
    options.onState(false);
    expect(s.setSpeakingMsgId).toHaveBeenNthCalledWith(1, "message-1");
    expect(s.setSpeakingMsgId).toHaveBeenNthCalledWith(2, null);
  });

  it("keeps effectful content intact and persists both fabricated preference toggles", async () => {
    const s = state({ autoSpeak: false, handsFree: true });
    mocks.api.setSetting
      .mockRejectedValueOnce(new Error("fake autospeak write failed"))
      .mockResolvedValueOnce(undefined);
    const actions = makeVoiceActions(s);

    actions.speakMessage(message({ id: "message-effects", content: "<effect />", effects: [{ kind: "tool" }] }));
    actions.toggleAutoSpeak();
    actions.toggleHandsFree();
    await Promise.resolve();

    expect(mocks.voice.speakText).toHaveBeenCalledWith("<effect />", expect.any(Object));
    expect(mocks.splitMarkupBlocks).not.toHaveBeenCalled();
    expect(s.setAutoSpeak).toHaveBeenCalledWith(true);
    expect(mocks.voice.configure).toHaveBeenCalledWith({ autoSpeak: true });
    expect(s.setHandsFree).toHaveBeenCalledWith(false);
    expect(mocks.api.setSetting).toHaveBeenNthCalledWith(1, "voice_autospeak", "1");
    expect(mocks.api.setSetting).toHaveBeenNthCalledWith(2, "voice_handsfree", "0");
  });
});
