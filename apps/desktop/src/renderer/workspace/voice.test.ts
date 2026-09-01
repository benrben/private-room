import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ speakTextNeural: vi.fn() }));

vi.mock("../api", () => ({ api: bridge }));
vi.mock("../viewers/util", () => ({ base64ToBytes: vi.fn() }));

import {
  beginTurn,
  cancelAll,
  configure,
  endOfTurn,
  feedStreamDelta,
  setVoiceProblemListener,
} from "./voice";

async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
}

beforeEach(() => {
  cancelAll();
  bridge.speakTextNeural.mockReset().mockResolvedValue("fabricated-audio");
  configure({ autoSpeak: true });
  setVoiceProblemListener(null);
});

afterEach(() => {
  cancelAll();
  configure({ autoSpeak: false });
  setVoiceProblemListener(null);
  vi.clearAllMocks();
});

describe("voice speech segmentation with fabricated synthesis", () => {
  it("cuts an overlong chunk just after its latest fabricated soft break", async () => {
    const problem = vi.fn();
    const prefix = `${"A".repeat(280)},`;
    const tail = "B".repeat(80);
    setVoiceProblemListener(problem);
    beginTurn("chat-a");
    feedStreamDelta(`${prefix}${tail}`);
    endOfTurn();
    await settle();

    expect(bridge.speakTextNeural.mock.calls.map(([text]) => text)).toEqual([prefix, tail]);
    expect(problem).toHaveBeenCalledOnce();
  });

  it("cuts a long fabricated no-break clause at the segmentation window", async () => {
    const clause = "C".repeat(320);
    beginTurn("chat-b");
    feedStreamDelta(clause);
    endOfTurn();
    await settle();

    expect(bridge.speakTextNeural.mock.calls.map(([text]) => text)).toEqual([
      "C".repeat(300),
      "C".repeat(20),
    ]);
  });

  it("also splits one complete overlong fabricated sentence before synthesis", async () => {
    beginTurn("chat-c");
    feedStreamDelta(`${"D".repeat(320)}.`);
    endOfTurn();
    await settle();

    expect(bridge.speakTextNeural.mock.calls.map(([text]) => text)).toEqual([
      "D".repeat(300),
      `${"D".repeat(20)}.`,
    ]);
  });
});
