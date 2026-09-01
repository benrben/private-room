import { describe, expect, it } from "vitest";
import { applyRecState } from "./recSession";
import { applyEvent, finishRun, NO_LIVE_TURN, startRun } from "./runIdentity";

describe("applyRecState", () => {
  it("cleans up every terminal recording outcome and reloads only its open file", () => {
    expect(applyRecState({ fileId: "recording-1", status: "saved" }, "recording-1")).toEqual({
      live: null,
      stopTap: true,
      clearSave: true,
      reload: true,
    });
    expect(applyRecState({ fileId: "recording-1", status: "failed" }, "another-file")).toEqual({
      live: null,
      stopTap: true,
      clearSave: true,
      reload: false,
    });
  });

  it("keeps an active recording live while distinguishing saving and paused state", () => {
    expect(applyRecState({ fileId: "recording-1", status: "saving" }, "recording-1")).toEqual({
      live: { fileId: "recording-1", status: "saving" },
      stopTap: false,
      clearSave: false,
      reload: false,
    });
    expect(applyRecState({ fileId: "recording-1", status: "paused" }, "recording-1")).toEqual({
      live: { fileId: "recording-1", status: "paused" },
      stopTap: false,
      clearSave: true,
      reload: true,
    });
  });
});

describe("applyEvent", () => {
  it("keeps dropped events referentially stable and applies only the current run's patch", () => {
    const idle = {};
    const patch = (turn: typeof NO_LIVE_TURN) => ({ ...turn, text: "updated" });
    expect(applyEvent(idle, "chat-1", "run-1", patch)).toBe(idle);

    const active = startRun(idle, "chat-1", "run-1");
    expect(applyEvent(active, "chat-1", "old-run", patch)).toBe(active);
    const updated = applyEvent(active, "chat-1", null, patch);
    expect(updated).toEqual({
      "chat-1": { ...NO_LIVE_TURN, runId: "run-1", text: "updated" },
    });
    expect(finishRun(updated, "chat-1")).toEqual({});
  });
});
