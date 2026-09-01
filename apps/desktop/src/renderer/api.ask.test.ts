import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));

vi.mock("./platform", () => ({ invoke: bridge.invoke, listen: bridge.listen }));

import { api } from "./api";

beforeEach(() => {
  bridge.invoke.mockReset();
  bridge.listen.mockReset();
});

describe("api.ask", () => {
  it("forwards the complete fabricated ask request and returns its IPC result", async () => {
    const response = { id: "message-1", content: "fabricated response" };
    bridge.invoke.mockResolvedValueOnce(response);

    await expect(
      api.ask("chat-1", "Summarize the marked notes", ["file-1", "file-2"], "ask-1", "notes.md", true),
    ).resolves.toBe(response);

    expect(bridge.invoke).toHaveBeenCalledWith("ask", {
      chatId: "chat-1",
      question: "Summarize the marked notes",
      attachments: ["file-1", "file-2"],
      askId: "ask-1",
      viewing: "notes.md",
      privacyBypass: true,
    });
  });

  it("maps omitted optional inputs to null and preserves a fabricated IPC failure", async () => {
    const failure = new Error("fabricated ask transport failure");
    bridge.invoke.mockRejectedValueOnce(failure);

    await expect(api.ask("chat-2", "No attachment", [], "ask-2")).rejects.toBe(failure);

    expect(bridge.invoke).toHaveBeenCalledWith("ask", {
      chatId: "chat-2",
      question: "No attachment",
      attachments: [],
      askId: "ask-2",
      viewing: null,
      privacyBypass: null,
    });
  });
});

describe("api.saveSkillResource", () => {
  it("maps absent text or binary data to null while preserving the supplied field", async () => {
    bridge.invoke.mockResolvedValue(undefined);

    await api.saveSkillResource("skill-1", "references/policy.md", { text: "fabricated policy" });
    await api.saveSkillResource("skill-1", "assets/icon.bin", { dataB64: "ZmFrZQ==" });

    expect(bridge.invoke).toHaveBeenNthCalledWith(1, "save_skill_resource", {
      skillId: "skill-1",
      path: "references/policy.md",
      text: "fabricated policy",
      dataB64: null,
    });
    expect(bridge.invoke).toHaveBeenNthCalledWith(2, "save_skill_resource", {
      skillId: "skill-1",
      path: "assets/icon.bin",
      text: null,
      dataB64: "ZmFrZQ==",
    });
  });
});
