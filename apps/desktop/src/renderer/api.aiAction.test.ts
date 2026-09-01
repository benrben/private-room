import { describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));

vi.mock("./platform", () => ({ invoke: bridge.invoke, listen: bridge.listen }));

import { api } from "./api";

describe("api.aiAction", () => {
  it("sends the complete action request without changing supplied values", async () => {
    bridge.invoke.mockResolvedValueOnce({ id: "note-1" });

    await expect(api.aiAction("summarize", {
      scope: "room",
      refs: ["file-1"],
      instructions: "Keep the action items.",
      question: "What changed?",
      opId: "turn-1",
    })).resolves.toEqual({ id: "note-1" });

    expect(bridge.invoke).toHaveBeenCalledWith("ai_action", {
      action: "summarize",
      scope: "room",
      refs: ["file-1"],
      instructions: "Keep the action items.",
      question: "What changed?",
      opId: "turn-1",
    });
  });

  it("keeps omitted action inputs explicitly absent on the IPC boundary", async () => {
    bridge.invoke.mockResolvedValueOnce({ id: "note-2" });

    await api.aiAction("summarize", {});

    expect(bridge.invoke).toHaveBeenCalledWith("ai_action", {
      action: "summarize",
      scope: null,
      refs: null,
      instructions: null,
      question: null,
      opId: null,
    });
  });
});
